import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { rpcUrl, type ProviderRegistry, type ProviderStatus } from "@kido/registry";

/** How far a decision can be trusted. SIMULATED is never presented as confidential or verified. */
export type DecisionTrust = "SIMULATED" | "DON_SIMULATED_FORWARDER" | "CONFIDENTIAL_VERIFIED_COMPUTE";

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
  status: ProviderStatus;
  live: boolean;
  blockers: string[];
}

/** Readiness comes from the registry's verified status for the capability, never from configuration alone. */
export function readiness(reg: ProviderRegistry, providerId: string, capability = "DECISION_ONLY_OUTPUT"): Readiness {
  const m = reg.get(providerId);
  if (!m) return { providerId, status: "UNVERIFIED", live: false, blockers: [`unknown provider ${providerId}`] };
  const cap = m.capabilityStatus?.[capability];
  const status = cap?.status ?? m.status;
  return { providerId, status, live: status === "VERIFIED_LIVE" && reg.isLive(providerId, capability), blockers: status === "VERIFIED_LIVE" ? [] : [cap?.note ?? m.statusNote] };
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
    return { providerId: this.providerId, status: "MOCK_ONLY", live: false, blockers: ["simulated adapter"] };
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

/** Nautilus needs an attested enclave host; until one exists every decision request is BLOCKED_ENV. */
export class NautilusDecisionAdapter implements ConfidentialDecisionAdapter {
  readonly providerId = "nautilus";
  constructor(private readonly reg: ProviderRegistry) {}
  readiness(): Readiness {
    return readiness(this.reg, this.providerId);
  }
  async decide(): Promise<DecisionResult> {
    const r = this.readiness();
    throw new BlockedEnvError(this.providerId, r.blockers.length ? r.blockers : ["no attested enclave host configured"]);
  }
}
