import { z } from "zod";
import { observed, unavailable, DEFAULT_TTLS, type Observation } from "./freshness.js";
import type { AdapterHealth } from "./adapters.js";

/**
 * Runtime monitoring, and the fence.
 *
 * §25.21 restates P24's rule and makes it the control plane's problem: **the agent is not HEALTHY
 * because Docker says the container is running.** A process can be up and unable to reach the
 * ContextLock Broker, in which case it will keep deciding and be unable to act — or worse, keep
 * deciding on a stale view.
 *
 * The other half of this file is revision fencing (§25.37), which is the part with teeth. When the
 * active runtime revision changes, the OLD revision's credential must stop working immediately.
 * A container that is still physically running after a rollback is expected; a container that is
 * still physically running AND can still call the gateways is a second agent nobody is watching.
 */

export const RUNTIME_STATES = ["PROVISIONING", "STARTING", "HEALTHY", "DEGRADED", "PAUSED", "STOPPING", "STOPPED", "CRASH_LOOP", "FAILED", "UNKNOWN"] as const;
export const RuntimeStateSchema = z.enum(RUNTIME_STATES);
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export interface RuntimeObservationInputs {
  /** What the provider says. Necessary, and nowhere near sufficient. */
  containerRunning: boolean;
  containerHealth: string | null;
  restartsInWindow: number;
  observedImageDigest: string | null;
  /** What the runtime itself reports. */
  lastHeartbeatMs: number | null;
  /** Gateway reachability, from the runtime's own perspective. */
  controlPlaneReachable: boolean;
  modelGatewayReachable: boolean;
  adapterBrokerReachable: boolean;
  contextlockBrokerReachable: boolean;
  eventCursorAgeMs: number | null;
  /** The scoped credential's validity. An expired credential is a runtime that cannot work. */
  credentialValid: boolean;
  credentialExpiresAtMs: number | null;
  strategyCheckpointAgeMs: number | null;
  paused: boolean;
  stopping: boolean;
  processStartedAtMs: number | null;
  nowMs: number;
}

export interface RuntimeHealthPolicy {
  heartbeatStaleAfterMs: number;
  startupGraceMs: number;
  eventCursorStaleAfterMs: number;
  checkpointStaleAfterMs: number;
  crashLoopRestarts: number;
}

export const DEFAULT_RUNTIME_POLICY: RuntimeHealthPolicy = {
  heartbeatStaleAfterMs: 30_000,
  startupGraceMs: 60_000,
  eventCursorStaleAfterMs: 5 * 60_000,
  checkpointStaleAfterMs: 10 * 60_000,
  crashLoopRestarts: 3,
};

export interface RuntimeHealthVerdict {
  state: RuntimeState;
  reasons: string[];
  mayStartNewWork: boolean;
  /** Stated on every verdict, because "healthy" is the word most likely to be read as "authorized". */
  note: string;
}

export const RUNTIME_HEALTH_NOTE =
  "Runtime health describes the agent process. It says nothing about financial authority: the ContextLock policy on chain decides whether this agent may act." as const;

export function evaluateRuntime(i: RuntimeObservationInputs, policy: RuntimeHealthPolicy = DEFAULT_RUNTIME_POLICY): RuntimeHealthVerdict {
  const reasons: string[] = [];
  const note = RUNTIME_HEALTH_NOTE;

  // Crash-looping first: a process that keeps dying looks STARTING every time it is asked, which is
  // how a crash loop hides as a slow start.
  if (i.restartsInWindow >= policy.crashLoopRestarts) {
    return { state: "CRASH_LOOP", reasons: [`${i.restartsInWindow} restarts within the crash-loop window; the runtime is not staying up`], mayStartNewWork: false, note };
  }
  if (i.stopping) return { state: "STOPPING", reasons: [], mayStartNewWork: false, note };
  if (!i.containerRunning) {
    return { state: i.paused ? "PAUSED" : "STOPPED", reasons: i.paused ? ["paused by an operator"] : ["the container is not running"], mayStartNewWork: false, note };
  }
  if (i.paused) return { state: "PAUSED", reasons: ["paused by an operator"], mayStartNewWork: false, note };

  /*
   * The container is running. Everything below decides whether that means anything.
   */
  if (!i.contextlockBrokerReachable) reasons.push("the ContextLock Broker is unreachable — this agent cannot obtain authorization for any action");
  if (!i.controlPlaneReachable) reasons.push("the control plane is unreachable");
  if (!i.modelGatewayReachable) reasons.push("the Model Gateway is unreachable");
  if (!i.adapterBrokerReachable) reasons.push("the Adapter Broker is unreachable");
  if (!i.credentialValid) reasons.push("the runtime's scoped credential is not valid");
  else if (i.credentialExpiresAtMs !== null && i.credentialExpiresAtMs <= i.nowMs) reasons.push("the runtime's scoped credential has expired");
  if (i.eventCursorAgeMs !== null && i.eventCursorAgeMs > policy.eventCursorStaleAfterMs) {
    reasons.push(`the event cursor is ${Math.round(i.eventCursorAgeMs / 1000)}s behind; this agent is deciding on a stale view`);
  }
  if (i.strategyCheckpointAgeMs !== null && i.strategyCheckpointAgeMs > policy.checkpointStaleAfterMs) {
    reasons.push(`the strategy checkpoint is ${Math.round(i.strategyCheckpointAgeMs / 1000)}s old`);
  }

  const uptime = i.processStartedAtMs === null ? 0 : i.nowMs - i.processStartedAtMs;
  if (i.lastHeartbeatMs === null) {
    if (uptime < policy.startupGraceMs) return { state: "STARTING", reasons, mayStartNewWork: false, note };
    reasons.push("no heartbeat has ever been emitted");
    return { state: "FAILED", reasons, mayStartNewWork: false, note };
  }
  if (i.nowMs - i.lastHeartbeatMs > policy.heartbeatStaleAfterMs) {
    reasons.push(`the last heartbeat was ${Math.round((i.nowMs - i.lastHeartbeatMs) / 1000)}s ago`);
  }

  if (reasons.length > 0) return { state: "DEGRADED", reasons, mayStartNewWork: false, note };
  return { state: "HEALTHY", reasons: [], mayStartNewWork: true, note };
}

export function runtimeObservation(v: RuntimeHealthVerdict, atMs: number, ttlMs = DEFAULT_TTLS.runtime): Observation<RuntimeHealthVerdict> {
  const state = v.state === "HEALTHY" ? "HEALTHY" : v.state === "UNKNOWN" ? "NOT_CONFIGURED" : v.state === "PAUSED" || v.state === "STOPPED" ? "BLOCKED" : "DEGRADED";
  return v.state === "UNKNOWN"
    ? unavailable("NOT_CONFIGURED", { atMs, source: "runtime", ttlMs, reason: "the runtime has not been observed" })
    : observed(v, { atMs, source: "runtime", ttlMs, state, ...(v.reasons.length ? { reason: v.reasons.join("; ") } : {}) });
}

/* ─────────────────────────── revision fencing ─────────────────────────── */

export const FENCE_REASONS = {
  FENCED: "RUNTIME-REVISION-FENCED",
  NOT_ACTIVE: "RUNTIME-REVISION-NOT-ACTIVE",
} as const;
export type FenceReason = (typeof FENCE_REASONS)[keyof typeof FENCE_REASONS];

export class RuntimeFenceError extends Error {
  constructor(readonly reason: FenceReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "RuntimeFenceError";
  }
}

export interface FencedRevision {
  revisionId: string;
  fencedAtMs: number;
  reason: string;
  /** The revision that replaced it. */
  supersededBy: string;
}

/**
 * The revision fence.
 *
 * One active revision per agent. Everything else is fenced, and a fenced revision's credential is
 * refused by every gateway — §25.37's "a stale container still physically running must be
 * operationally powerless".
 *
 * The fence is keyed on the REVISION, not on the token. Revoking individual sessions would mean
 * hunting down every token the old revision was ever issued, and missing one is the whole failure.
 * Fencing the revision refuses all of them at once, including tokens issued a second before the
 * switch.
 */
export class RuntimeRevisionFence {
  private active = new Map<string, string>();
  private readonly fenced = new Map<string, FencedRevision>();

  constructor(private readonly nowMs: () => number) {}

  /** Make a revision active, fencing whatever it replaced. */
  activate(agentId: string, revisionId: string, reason = "superseded by a newer revision"): FencedRevision | null {
    const previous = this.active.get(agentId);
    this.active.set(agentId, revisionId);
    // A revision becoming active again — a rollback — must be un-fenced, or the rollback target
    // would come up powerless and the rollback would appear to succeed while doing nothing.
    this.fenced.delete(revisionId);
    if (!previous || previous === revisionId) return null;
    const f: FencedRevision = { revisionId: previous, fencedAtMs: this.nowMs(), reason, supersededBy: revisionId };
    this.fenced.set(previous, f);
    return f;
  }

  activeRevision(agentId: string): string | null {
    return this.active.get(agentId) ?? null;
  }

  isFenced(revisionId: string): boolean {
    return this.fenced.has(revisionId);
  }

  fencedRevisions(): FencedRevision[] {
    return [...this.fenced.values()].sort((a, b) => a.fencedAtMs - b.fencedAtMs);
  }

  /**
   * The check every gateway makes.
   *
   * Called by the Model Gateway, the Adapter Broker, the ContextLock Broker and the Telemetry
   * gateway before honouring a runtime token. A fenced revision gets a named refusal so the event
   * log shows a stale container trying to work, which is worth seeing.
   */
  assertActive(agentId: string, revisionId: string): void {
    const f = this.fenced.get(revisionId);
    if (f) {
      throw new RuntimeFenceError(
        FENCE_REASONS.FENCED,
        `runtime revision ${revisionId} was fenced at ${new Date(f.fencedAtMs).toISOString()} (${f.reason}; superseded by ${f.supersededBy}). Its credential is no longer honoured.`,
      );
    }
    const active = this.active.get(agentId);
    if (active !== revisionId) {
      throw new RuntimeFenceError(
        FENCE_REASONS.NOT_ACTIVE,
        `runtime revision ${revisionId} is not the active revision for agent "${agentId}" (${active ?? "none"})`,
      );
    }
  }
}

/* ─────────────────────── is this agent actually live? ─────────────────────── */

export interface LivenessInputs {
  runtime: RuntimeState;
  policyEnabled: boolean | null;
  policyIsCurrent: boolean;
  identityActive: boolean | null;
  requiredAdapters: AdapterHealth[];
  /** Null when the Blueprint requires no CRE workflow. */
  creRequired: boolean;
  creActive: boolean | null;
}

/**
 * The LIVE badge.
 *
 * §25.25 and §25.26. A deployment that is deliberately inactive must not show LIVE, and an agent
 * whose required CRE workflow does not exist cannot be displayed as fully healthy however good
 * everything else looks.
 *
 * `policyIsCurrent` is a separate input from `policyEnabled` on purpose: a stale reading cannot
 * make an agent LIVE, because the badge is a claim about right now.
 */
export function agentIsLive(i: LivenessInputs): { live: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (i.runtime !== "HEALTHY") reasons.push(`runtime is ${i.runtime}`);
  if (i.policyEnabled === null) reasons.push("the policy state is unknown");
  else if (!i.policyEnabled) reasons.push("the ContextLock policy is disabled");
  if (!i.policyIsCurrent) reasons.push("the policy reading is not current");
  if (i.identityActive === null) reasons.push("the identity state is unknown");
  else if (!i.identityActive) reasons.push("the agent identity is not active");
  for (const a of i.requiredAdapters) if (a.state !== "HEALTHY") reasons.push(`adapter ${a.adapterId} is ${a.state}`);
  if (i.creRequired) {
    if (i.creActive === null) reasons.push("this agent requires a CRE workflow and its state is unknown");
    else if (!i.creActive) reasons.push("this agent requires a CRE workflow and it is not active");
  }
  return { live: reasons.length === 0, reasons };
}
