import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { rpcUrl, type ImplementationStatus, type ProviderRegistry } from "@kido/registry";
import type { LocalEnclaveSigner, SignedDecision } from "../nautilus.js";

/** How far a decision can be trusted. SIMULATED is never presented as confidential or verified. */
/**
 * How far a decision can be trusted. SIMULATED is never presented as confidential or verified;
 * LOCAL_UNATTESTED_ENCLAVE is the enclave's signing code run locally: the on-chain check verifies
 * it, but no TEE protected the inputs.
 */
export type DecisionTrust = "SIMULATED" | "LOCAL_UNATTESTED_ENCLAVE" | "DON_SIMULATED_FORWARDER" | "CONFIDENTIAL_VERIFIED_COMPUTE";

export interface DecisionRequest {
  key: Hex;
  blueprintHash: Hex;
}

export interface DecisionResult {
  providerId: string;
  act: boolean;
  evaluatedAt: number;
  trust: DecisionTrust;
  evidence: string;
  /** Signed envelope a Sui verifier (kido_nautilus::decision::accept) can check. */
  signed?: SignedDecision;
}

export class BlockedEnvError extends Error {
  readonly code = "BLOCKED_ENV";
  constructor(readonly providerId: string, readonly reasons: string[]) {
    super(`BLOCKED_ENV ${providerId}: ${reasons.join("; ")}`);
    this.name = "BlockedEnvError";
  }
}

export interface Readiness {
  providerId: string;
  status: ImplementationStatus;
  live: boolean;
  blockers: string[];
  proven: string[];
  notProven: string[];
}

/** Readiness is what has been proven (the registry's implementation record), never configuration alone. */
export function readiness(reg: ProviderRegistry, providerId: string, capability?: string): Readiness {
  const m = reg.get(providerId);
  if (!m) return { providerId, status: "NOT_IMPLEMENTED", live: false, blockers: [`unknown provider ${providerId}`], proven: [], notProven: [] };
  const status = reg.implementationStatus(providerId, capability);
  const b = m.implementation.blocker;
  return { providerId, status, live: reg.implementationLive(providerId, capability), blockers: b && !reg.implementationLive(providerId, capability) ? [`${b.type}: ${b.actionRequired} (${b.evidence})`] : [], proven: m.implementation.proven, notProven: m.implementation.notProven };
}

export interface ConfidentialDecisionAdapter {
  readonly providerId: string;
  readiness(): Readiness;
  /** Produces a decision over private inputs. Throws BlockedEnvError when the provider cannot run. */
  decide(req: DecisionRequest): Promise<DecisionResult>;
}

/** For MOCK_INTEGRATION tests: every result is labelled SIMULATED. */
export class SimulatedDecisionAdapter implements ConfidentialDecisionAdapter {
  constructor(readonly providerId: string, private readonly fn: (req: DecisionRequest) => boolean, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}
  readiness(): Readiness {
    return { providerId: this.providerId, status: "SIMULATED", live: false, blockers: ["simulated adapter"], proven: [], notProven: ["everything: simulated"] };
  }
  async decide(req: DecisionRequest): Promise<DecisionResult> {
    return { providerId: this.providerId, act: this.fn(req), evaluatedAt: this.now(), trust: "SIMULATED", evidence: "simulated adapter; no confidential compute" };
  }
}

const RECEIVER_ABI = parseAbi(["function decisions(bytes32) view returns (bool act, bytes32 blueprintHash, uint64 evaluatedAt, bytes32 workflowCid)", "function forwarder() view returns (address)"]);

/**
 * Chainlink CRE: decisions are produced by the deployed workflow and read from KidoCreReceiver.
 * `decide` cannot trigger the workflow from here; it reads the latest delivered decision and
 * refuses one bound to another blueprint. Trust depends on which forwarder the receiver accepts.
 */
export class ChainlinkCreDecisionAdapter implements ConfidentialDecisionAdapter {
  readonly providerId = "chainlink-cre";
  constructor(private readonly reg: ProviderRegistry, private readonly receiver: Hex, private readonly env: NodeJS.ProcessEnv = process.env) {}

  readiness(): Readiness {
    return readiness(this.reg, this.providerId);
  }

  async decide(req: DecisionRequest): Promise<DecisionResult> {
    const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl("ethereum-sepolia", this.env)) });
    const [fwd, [act, bp, at]] = await Promise.all([
      client.readContract({ address: this.receiver, abi: RECEIVER_ABI, functionName: "forwarder" }),
      client.readContract({ address: this.receiver, abi: RECEIVER_ABI, functionName: "decisions", args: [req.key] }),
    ]);
    if (at === 0n) throw new Error(`no decision delivered for ${req.key}`);
    if (bp.toLowerCase() !== req.blueprintHash.toLowerCase()) throw new Error("delivered decision is bound to another blueprint revision");
    const dep = this.reg.get(this.providerId)?.deployments["ethereum-sepolia"] as Record<string, string> | undefined;
    const trust: DecisionTrust = fwd.toLowerCase() === dep?.keystoneForwarder?.toLowerCase() && this.readiness().live ? "CONFIDENTIAL_VERIFIED_COMPUTE" : "DON_SIMULATED_FORWARDER";
    return { providerId: this.providerId, act, evaluatedAt: Number(at), trust, evidence: `KidoCreReceiver ${this.receiver} via forwarder ${fwd}` };
  }
}

/**
 * Nautilus. Without an attested enclave host every decision request is BLOCKED_ENV. With a local
 * signer (LOCAL tier) the enclave's decision code and signing run in-process and the result is
 * labelled LOCAL_UNATTESTED_ENCLAVE: verifiable on-chain, never presented as confidential.
 */
export class NautilusDecisionAdapter implements ConfidentialDecisionAdapter {
  readonly providerId = "nautilus";
  constructor(
    private readonly reg: ProviderRegistry,
    private readonly local?: { signer: LocalEnclaveSigner; evaluate: (req: DecisionRequest) => boolean | Promise<boolean>; now?: () => bigint },
  ) {}
  readiness(): Readiness {
    return readiness(this.reg, this.providerId);
  }
  async decide(req: DecisionRequest): Promise<DecisionResult> {
    if (!this.local) {
      const r = this.readiness();
      throw new BlockedEnvError(this.providerId, r.blockers.length ? r.blockers : ["no attested enclave host configured"]);
    }
    const timestampMs = this.local.now ? this.local.now() : BigInt(Date.now());
    const act = await this.local.evaluate(req);
    const signed = await this.local.signer.sign({ decisionKey: req.key, act, blueprintHash: req.blueprintHash, timestampMs });
    return { providerId: this.providerId, act, evaluatedAt: Number(timestampMs / 1000n), trust: "LOCAL_UNATTESTED_ENCLAVE", evidence: `local enclave signer ${signed.publicKey} (no attestation)`, signed };
  }
}
