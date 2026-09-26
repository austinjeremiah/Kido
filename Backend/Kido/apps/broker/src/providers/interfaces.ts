import type { Address, Hex } from "viem";
import type { Verdict } from "@contextlock/protocol";

/**
 * The four replaceable dependency boundaries.
 *
 * Phase 2 supplies deterministic test implementations. Later phases swap in the real thing:
 *   EnsIdentityProvider   -> live ENSv2 Sepolia resolution        (Phase 3)
 *   PolicyEvaluator       -> Chainlink CRE Confidential Workflow  (Phase 4)
 *   SecretProvider        -> Ledger Key Ring                      (Phase 6)
 *   HumanApprovalProvider -> Ledger DMK device approval           (Phase 7)
 *
 * The Phase 2 stubs are named and documented as stubs. They are NOT fake sponsor APIs and must
 * never be presented as ENS, Chainlink or Ledger integrations.
 */

export type AgentIdentity = {
  ensName: string;
  /** namehash / node of the agent name. */
  node: Hex;
  /** The address the name currently resolves to. */
  agent: Address;
  /** ContextLock binding version at resolution time. */
  bindingVersion: bigint;
  /** keccak256(abi.encode(node, agent, bindingVersion, registryIdentity)). */
  agentIdentityHash: Hex;
  /** Where this came from, so evidence and audit can distinguish stub from live. */
  source: "stub" | "ensv2-sepolia";
};

export interface EnsIdentityProvider {
  /**
   * Resolve and validate an agent identity against CURRENT state.
   *
   * MUST fail closed: throw an OperationalError rather than returning a stale or cached identity.
   * A resolution failure must never be reported as a successful identity.
   */
  resolve(ensName: string): Promise<AgentIdentity>;
}

export type EvaluationInput = {
  requestId: string;
  /** Canonical evaluation request hash, recomputed on-chain by the executor. */
  requestHash: Hex;
  /** The exact bytes that will execute. The evaluator decodes these rather than trusting
   *  any declared amount — see CRE-014. */
  calldata: Hex;
  identity: AgentIdentity;
  policyHash: Hex;
  target: Address;
  value: bigint;
  calldataHash: Hex;
  intentHash: Hex;
  actionKind: string;
  /** Integer base units, for threshold comparison. */
  amount: bigint;
};

export type EvaluationResult = {
  authorizationId: Hex;
  requestHash: Hex;
  verdict: Verdict;
  /** Non-secret reason code. MUST NOT leak private threshold values. */
  reasonCode: string;
  contextCommitment: Hex;
  evaluatedAt: bigint;
  approvedUntil: bigint;
  /**
   * Provenance of the verdict. These labels are load-bearing and must never be blurred:
   *   "stub"               - Phase 2 deterministic double, no policy meaning
   *   "cre-workflow-local" - the real workflow policy module, run in the broker process.
   *                          NOT confidential, NOT TEE-attested, NOT simulator output.
   *   "cre-simulator"      - output of the official `cre workflow simulate` CLI
   *   "cre-live"           - a DON-signed report produced inside an attested enclave
   */
  source: "stub" | "cre-workflow-local" | "cre-simulator" | "cre-live";
};

export interface PolicyEvaluator {
  evaluate(input: EvaluationInput): Promise<EvaluationResult>;
}

export interface SecretProvider {
  /**
   * Use a protected credential WITHOUT returning it.
   *
   * The signature deliberately offers no "getSecret" — the caller receives the result of using
   * the credential, never the credential. In Phase 6 this is backed by Ledger Key Ring.
   *
   * Note (FND-002): Key Ring encrypt/decrypt requires network access, so implementations have a
   * second failure mode beyond a missing WALLET_PASS. Both must surface as an OperationalError
   * (CTX_LEDGER_UNAVAILABLE) and fail closed — never as a policy denial, and never by falling
   * back to an unprotected credential path.
   */
  withSecret<T>(secretId: string, use: (secret: string) => Promise<T>): Promise<T>;
}

export type ApprovalRequest = {
  requestId: string;
  capabilityDigest: Hex;
  summary: Record<string, string>;
};

export type ApprovalResult =
  | { status: "APPROVED"; signature: Hex; approver: Address }
  | { status: "REJECTED"; reason: string }
  | { status: "UNAVAILABLE"; reason: string };

export interface HumanApprovalProvider {
  requestApproval(req: ApprovalRequest): Promise<ApprovalResult>;
}
