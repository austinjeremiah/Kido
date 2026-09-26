import { encodeAbiParameters, keccak256, namehash, toHex, type Address, type Hex } from "viem";
import { OperationalError, ReasonCode, type Verdict } from "@contextlock/protocol";
import type {
  AgentIdentity,
  ApprovalRequest,
  ApprovalResult,
  EnsIdentityProvider,
  EvaluationInput,
  EvaluationResult,
  HumanApprovalProvider,
  PolicyEvaluator,
  SecretProvider,
} from "./interfaces.js";

/**
 * PHASE 2 DETERMINISTIC STUBS.
 *
 * These are test doubles, not sponsor integrations. Every result they return is tagged
 * `source: "stub"` so audit records and phase evidence can never confuse a stubbed run with a
 * live ENS resolution or a real confidential evaluation.
 */

/** Shared identity-hash derivation, so the stub and the Phase 3 live provider agree. */
export function deriveAgentIdentityHash(
  node: Hex,
  agent: Address,
  bindingVersion: bigint,
  registryIdentity: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint64" }, { type: "bytes32" }],
      [node, agent, bindingVersion, registryIdentity],
    ),
  );
}

export const STUB_REGISTRY_IDENTITY = keccak256(toHex("contextlock-stub-registry"));

export class StubEnsIdentityProvider implements EnsIdentityProvider {
  private readonly bindings = new Map<string, { agent: Address; bindingVersion: bigint }>();
  /** Simulates an RPC/resolver outage so fail-closed behaviour is testable. */
  public resolutionBroken = false;

  bind(ensName: string, agent: Address, bindingVersion = 1n): void {
    this.bindings.set(ensName.toLowerCase(), { agent, bindingVersion });
  }

  revoke(ensName: string): void {
    this.bindings.delete(ensName.toLowerCase());
  }

  async resolve(ensName: string): Promise<AgentIdentity> {
    if (this.resolutionBroken) {
      // Fail closed. Never return a cached or optimistic identity on an outage.
      throw new OperationalError(
        ReasonCode.IDENTITY_UNAVAILABLE,
        `Identity resolution unavailable for ${ensName}`,
      );
    }
    const b = this.bindings.get(ensName.toLowerCase());
    if (!b) {
      throw new OperationalError(ReasonCode.IDENTITY_NOT_FOUND, `No binding for ${ensName}`);
    }
    const node = namehash(ensName);
    return {
      ensName,
      node,
      agent: b.agent,
      bindingVersion: b.bindingVersion,
      agentIdentityHash: deriveAgentIdentityHash(node, b.agent, b.bindingVersion, STUB_REGISTRY_IDENTITY),
      source: "stub",
    };
  }
}

/**
 * Deterministic policy evaluator standing in for the Chainlink CRE Confidential Workflow.
 *
 * The thresholds below are ORDINARY TEST CONSTANTS in plain view. They are deliberately not
 * described as confidential: in Phase 4 the real private parameters live in CRE secret storage
 * and are read inside `handlerInTee`. Pretending this stub is confidential would be exactly the
 * kind of false sponsor claim the build rules forbid.
 */
export class StubPolicyEvaluator implements PolicyEvaluator {
  constructor(
    public autonomousLimit = 1_000n,
    public escalateLimit = 10_000n,
    public ttlSeconds = 60n,
  ) {}

  async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
    const now = BigInt(Math.floor(Date.now() / 1000));

    let verdict: Verdict;
    let reasonCode: string;
    if (input.amount <= this.autonomousLimit) {
      verdict = "ALLOW";
      reasonCode = "WITHIN_AUTONOMOUS_LIMIT";
    } else if (input.amount <= this.escalateLimit) {
      verdict = "ESCALATE";
      reasonCode = ReasonCode.CRE_ESCALATE;
    } else {
      verdict = "DENY";
      reasonCode = ReasonCode.CRE_DENIED;
    }

    const requestHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" },
        ],
        [input.identity.agentIdentityHash, input.target, input.value, input.calldataHash],
      ),
    );

    return {
      authorizationId: keccak256(toHex(`auth:${input.requestId}`)),
      requestHash,
      verdict,
      reasonCode,
      // Commits to the evaluated context without revealing it.
      contextCommitment: keccak256(toHex(`ctx:${input.requestId}:${verdict}`)),
      evaluatedAt: now,
      approvedUntil: now + this.ttlSeconds,
      source: "stub",
    };
  }
}

/** Phase 2 stub. Phase 6 replaces this with Ledger Key Ring. */
export class StubSecretProvider implements SecretProvider {
  private readonly secrets = new Map<string, string>();
  public unavailable = false;

  set(id: string, value: string): void {
    this.secrets.set(id, value);
  }

  async withSecret<T>(secretId: string, use: (secret: string) => Promise<T>): Promise<T> {
    if (this.unavailable) {
      throw new OperationalError(ReasonCode.LEDGER_UNAVAILABLE, "Secret store unavailable");
    }
    const s = this.secrets.get(secretId);
    if (s === undefined) {
      throw new OperationalError(ReasonCode.LEDGER_UNAVAILABLE, `No such secret: ${secretId}`);
    }
    // The secret is passed to the callback and never returned to the caller.
    return use(s);
  }
}

/** Phase 2 stub. Phase 7 replaces this with a real Ledger device interaction. */
export class StubHumanApprovalProvider implements HumanApprovalProvider {
  public mode: "APPROVE" | "REJECT" | "UNAVAILABLE" = "REJECT";

  async requestApproval(_req: ApprovalRequest): Promise<ApprovalResult> {
    if (this.mode === "UNAVAILABLE") {
      return { status: "UNAVAILABLE", reason: "No approval device configured in Phase 2" };
    }
    if (this.mode === "REJECT") {
      return { status: "REJECTED", reason: "Phase 2 stub does not auto-approve" };
    }
    throw new OperationalError(
      ReasonCode.LEDGER_UNAVAILABLE,
      "Phase 2 has no signing device. An APPROVE path must not be faked; it arrives in Phase 7.",
    );
  }
}
