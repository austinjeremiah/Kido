import { blueprintHash, type ChainId, type KidoAgentBlueprint } from "@kido/blueprint";
import type { MonitorHealth } from "./monitor.js";

/** Live facts the runtime knows; everything optional because an agent may not be deployed yet. */
export interface RuntimeSnapshot {
  lease?: { leaseId: string; expiresAt: number; revoked: boolean; remaining: { chain: ChainId; asset: string; perWindow: string; total: string }[] } | null;
  monitors?: MonitorHealth[];
  identity?: { provider: string; chain: ChainId; name: string; status: "PLANNED" | "ACTIVE" | "REVOKED" }[];
  plan?: { planHash: string; status: string } | null;
  observedAt?: number;
}

/** What has been proven for a provider the agent uses (from the registry's implementation record). */
export interface ProviderState {
  providerId: string;
  role: string;
  status: string;
  live: boolean;
  proven: string[];
  notProven: string[];
  doesNotProvide: string[];
  blocker: string | null;
}

/** How one allowed action is executed and enforced. */
export interface ExecutionFact {
  action: string;
  chain: string;
  providerId: string;
  providerVersion: string;
  adapter: { name: string; version: number } | null;
  /** Pinned upstream objects (pool, router, fee tier) the adapter may touch; nothing else. */
  upstream: Record<string, unknown>;
  enforcement: string[];
}

export interface AgentSelfModel {
  kidoAgentId: string;
  objective: string;
  blueprint: { revision: number; hash: string };
  identity: { provider: string; chain: ChainId; name: string | null; status: string }[];
  chains: ChainId[];
  protocols: { providerId: string; chain: ChainId; version: string }[];
  dataSources: { id: string; providerId: string; chain: ChainId | null; minTrust: string; maxAgeMs: number; onUnavailable: string }[];
  monitors: { id: string; metric: string; op: string; threshold: string; response: string; action: string | null; health: string }[];
  allowedActions: string[];
  forbiddenActions: string[];
  privacy: { required: boolean | null; protectedInputs: { id: string; kind: string; hiddenFrom: string[]; plaintextMayExistIn: string; mayLeave: string; protectedBy: string[] }[] };
  providers: ProviderState[];
  execution: ExecutionFact[];
  /** What happens if an upstream protocol changes underneath a pinned adapter. */
  upstreamChangePolicy: string;
  capabilitiesNotAvailable: string[];
  authority: {
    mode: string | null;
    amaneActive: boolean;
    limits: { chain: ChainId; asset: string; perAction: string; perWindow: string; windowSeconds: number; total: string }[];
    payees: { label: string; chain: ChainId; address: string }[];
    beneficiaries: { label: string; chain: ChainId; address: string }[];
    lease: { leaseId: string; expiresAt: number; revoked: boolean; remaining: { chain: ChainId; asset: string; perWindow: string; total: string }[] } | "unknown";
  };
  failureBehaviour: { oracleFailure: string; bridgeTimeout: string; leaseRevocation: string; partialExecution: string };
}

/**
 * Deterministic self-model (bible §13.2), computed from the active blueprint and live runtime state.
 * It holds no secrets: private thresholds appear only as "private" with the providers protecting them.
 */
export function buildSelfModel(bp: KidoAgentBlueprint, rt: RuntimeSnapshot = {}, providers: ProviderState[] = [], execution: ExecutionFact[] = []): AgentSelfModel {
  const a = bp.authority;
  const protectedBy = (id: string) => bp.privacy.providers.filter((p) => p.satisfies.includes(id)).map((p) => (p.chain ? `${p.providerId} (${p.chain})` : p.providerId));
  const liveIdentity = new Map((rt.identity ?? []).map((i) => [`${i.provider}:${i.chain}`, i]));
  return {
    kidoAgentId: bp.kidoAgentId,
    objective: bp.objective.statement,
    blueprint: { revision: bp.revision, hash: blueprintHash(bp) },
    identity: bp.identity.bindings.map((b) => {
      const live = liveIdentity.get(`${b.provider}:${b.chain}`);
      return { provider: b.provider, chain: b.chain, name: live?.name ?? b.name, status: live?.status ?? b.status };
    }),
    chains: bp.chains,
    protocols: bp.protocols.map((p) => ({ providerId: p.providerId, chain: p.chain, version: p.version })),
    dataSources: bp.dataSources.map((d) => ({ id: d.id, providerId: d.providerId, chain: d.chain, minTrust: d.minTrust, maxAgeMs: d.maxAgeMs, onUnavailable: d.onUnavailable })),
    monitors: bp.monitors.map((m) => ({
      id: m.id,
      metric: m.metric,
      op: m.op,
      threshold: m.thresholdPrivateRef ? `private (protected by ${protectedBy(m.thresholdPrivateRef).join(", ") || "no provider yet"})` : (m.threshold ?? "unknown"),
      response: m.response,
      action: m.action,
      health: rt.monitors?.find((h) => h.monitorId === m.id)?.status ?? "unknown",
    })),
    allowedActions: a.allowedActions,
    forbiddenActions: a.forbiddenActions,
    privacy: { required: bp.privacy.required, protectedInputs: bp.privacy.values.map((v) => ({ id: v.id, kind: v.kind, hiddenFrom: v.hiddenFrom, plaintextMayExistIn: v.plaintextBoundary, mayLeave: v.allowedDisclosure, protectedBy: protectedBy(v.id) })) },
    providers,
    execution,
    upstreamChangePolicy: "Each adapter is pinned by id to its exact code; an upstream protocol upgrade is outside that guarantee. Kido's knowledge drift check compares pinned protocol versions and deployments and fails closed on a security-relevant change, and Amane still measures every result on-chain, so a changed protocol can make actions fail but cannot make them exceed the policy.",
    capabilitiesNotAvailable: ["BORROW", "WITHDRAW", ...["SWAP", "SUPPLY", "REPAY", "PAY", "BRIDGE"].filter((x) => !bp.authority.allowedActions.includes(x as never))],
    authority: {
      mode: a.mode,
      amaneActive: a.provider === "AMANE" && Boolean(rt.lease && !rt.lease.revoked && rt.lease.expiresAt * 1000 > (rt.observedAt ?? Date.now())),
      limits: a.limits,
      // Pinned recipients are policy, not secrets: the owner signed them into the Root Policy.
      payees: a.payees.map((p) => ({ label: p.label, chain: p.chain, address: p.address })),
      beneficiaries: a.beneficiaries.map((b) => ({ label: b.label, chain: b.chain, address: b.address })),
      lease: rt.lease ?? "unknown",
    },
    failureBehaviour: {
      oracleFailure: bp.recovery.onOracleUnavailable === "FAIL_CLOSED" ? "take no action and alert the owner" : "notify the owner",
      bridgeTimeout: bp.crossChain?.allowed ? `funds in flight enter RECOVERY_REQUIRED after ${bp.crossChain.recoveryDeadlineSeconds} s` : "bridging is not allowed",
      leaseRevocation: a.provider === "AMANE" ? "every further action is rejected on-chain by Amane; the runtime keeps observing but cannot act" : "no on-chain lease",
      partialExecution: bp.recovery.onPartialExecution ?? "undecided",
    },
  };
}

type Topic = { id: string; re: RegExp; answer: (m: AgentSelfModel) => unknown };

const TOPICS: Topic[] = [
  { id: "identity", re: /\b(who are you|identity|ens|suins|name|agent id)\b/i, answer: (m) => ({ kidoAgentId: m.kidoAgentId, identity: m.identity }) },
  { id: "objective", re: /\b(objective|goal|purpose|what (do|are) you (do|for))\b/i, answer: (m) => m.objective },
  { id: "chains", re: /\b(chains?|network|ethereum|sui)\b/i, answer: (m) => m.chains },
  { id: "protocols", re: /\b(protocols?|aave|uniswap|cetus)\b/i, answer: (m) => m.protocols },
  { id: "data", re: /\b(data|oracle|source|monitor|watch|trust)\b/i, answer: (m) => ({ dataSources: m.dataSources, monitors: m.monitors }) },
  { id: "actions", re: /\b(actions?|allowed|forbidden|can you|may you|permitted|borrow|withdraw|swap|repay|pay)\b/i, answer: (m) => ({ allowed: m.allowedActions, forbidden: m.forbiddenActions }) },
  { id: "privacy", re: /\b(privacy|private|secret|sensitive|confidential|protect|plaintext|enclave|tee|attest\w*|seal|nautilus)\b/i, answer: (m) => ({ ...m.privacy, providers: m.providers.filter((p) => p.role === "privacy") }) },
  { id: "execution", re: /\b(adapter|version|pool|router|minimum|min(imum)? output|slippage|floor|enforc\w*|checked|verif\w*|success|beneficiar\w*|dex|protocol|supply|withdraw|upgrade|changes?|underneath)\b/i, answer: (m) => ({ execution: m.execution, notAvailable: m.capabilitiesNotAvailable, upstreamChangePolicy: m.upstreamChangePolicy, beneficiaries: m.authority.beneficiaries }) },
  { id: "providers", re: /\b(live|simulated|provider|infrastructure|proven|status)\b/i, answer: (m) => m.providers },
  { id: "authority", re: /\b(amane|lease|limit|budget|remaining|expir|spend|authority)\b/i, answer: (m) => m.authority },
  { id: "failure", re: /\b(fail|failure|timeout|revok|stale|unavailable|what happens)\b/i, answer: (m) => m.failureBehaviour },
];

export interface Introspection {
  question: string;
  topics: string[];
  facts: Record<string, unknown>;
  known: boolean;
}

/**
 * Answers questions about the agent from its self-model only. Questions matching no topic are
 * answered as unknown rather than guessed; a model may phrase `facts`, never add to them.
 */
export function introspect(m: AgentSelfModel, question: string): Introspection {
  const hits = TOPICS.filter((t) => t.re.test(question));
  return { question, topics: hits.map((t) => t.id), facts: Object.fromEntries(hits.map((t) => [t.id, t.answer(m)])), known: hits.length > 0 };
}
