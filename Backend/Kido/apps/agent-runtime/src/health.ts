import { z } from "zod";

/**
 * Runtime health.
 *
 * The rule this file exists to enforce:
 *
 *     DO NOT CALL AN AGENT HEALTHY MERELY BECAUSE THE CONTAINER PROCESS EXISTS.
 *
 * A financial agent whose process is up but which cannot reach the ContextLock Broker is not
 * degraded in an interesting way — it is an agent that will keep deciding and be unable to act, or
 * worse, keep deciding and act on a stale view. So reachability of each gateway is a health input,
 * and so is the age of the event cursor: an agent processing events from an hour ago is not healthy
 * just because it is busy.
 */

export const RUNTIME_HEALTH_STATES = [
  "PROVISIONING",
  "STARTING",
  "HEALTHY",
  "DEGRADED",
  "PAUSED",
  "STOPPING",
  "STOPPED",
  "CRASH_LOOP",
  "FAILED",
] as const;
export const RuntimeHealthStateSchema = z.enum(RUNTIME_HEALTH_STATES);
export type RuntimeHealthState = z.infer<typeof RuntimeHealthStateSchema>;

export interface HealthInputs {
  processStartedAtMs: number;
  lastHeartbeatMs: number | null;
  controlPlaneReachable: boolean;
  modelGatewayReachable: boolean;
  adapterBrokerReachable: boolean;
  contextlockBrokerReachable: boolean;
  /** Age of the newest processed event cursor. Null when this agent is not event-driven. */
  eventCursorAgeMs: number | null;
  paused: boolean;
  stopping: boolean;
  /** Restarts inside the crash-loop window. */
  recentRestarts: number;
  nowMs: number;
}

export interface HealthPolicy {
  heartbeatStaleAfterMs: number;
  startupGraceMs: number;
  eventCursorStaleAfterMs: number;
  crashLoopRestarts: number;
}

export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
  heartbeatStaleAfterMs: 30_000,
  startupGraceMs: 60_000,
  eventCursorStaleAfterMs: 5 * 60_000,
  crashLoopRestarts: 3,
};

export interface HealthVerdict {
  state: RuntimeHealthState;
  /** Every input that is not satisfied, in words. A DEGRADED with no reason is unactionable. */
  reasons: string[];
  /** May this runtime start new work? Separate from health: a PAUSED runtime is not unhealthy. */
  mayStartNewWork: boolean;
}

export function evaluateHealth(i: HealthInputs, policy: HealthPolicy = DEFAULT_HEALTH_POLICY): HealthVerdict {
  const reasons: string[] = [];

  // Crash-looping is decided before anything else: a process that keeps dying will look STARTING
  // every time it is asked, which is how a crash loop hides as a slow start.
  if (i.recentRestarts >= policy.crashLoopRestarts) {
    return {
      state: "CRASH_LOOP",
      reasons: [`${i.recentRestarts} restarts within the crash-loop window; the runtime is not staying up`],
      mayStartNewWork: false,
    };
  }
  if (i.stopping) return { state: "STOPPING", reasons: [], mayStartNewWork: false };
  if (i.paused) {
    return { state: "PAUSED", reasons: ["paused by an operator"], mayStartNewWork: false };
  }

  if (!i.controlPlaneReachable) reasons.push("the control plane is unreachable");
  if (!i.modelGatewayReachable) reasons.push("the Model Gateway is unreachable");
  if (!i.adapterBrokerReachable) reasons.push("the Adapter Broker is unreachable");
  if (!i.contextlockBrokerReachable) reasons.push("the ContextLock Broker is unreachable — this agent cannot obtain authorization for any action");
  if (i.eventCursorAgeMs !== null && i.eventCursorAgeMs > policy.eventCursorStaleAfterMs) {
    reasons.push(`the event cursor is ${Math.round(i.eventCursorAgeMs / 1000)}s behind; this agent is deciding on a stale view`);
  }

  const uptime = i.nowMs - i.processStartedAtMs;
  if (i.lastHeartbeatMs === null) {
    if (uptime < policy.startupGraceMs) return { state: "STARTING", reasons, mayStartNewWork: false };
    reasons.push("no heartbeat has ever been emitted");
    return { state: "FAILED", reasons, mayStartNewWork: false };
  }
  if (i.nowMs - i.lastHeartbeatMs > policy.heartbeatStaleAfterMs) {
    reasons.push(`the last heartbeat was ${Math.round((i.nowMs - i.lastHeartbeatMs) / 1000)}s ago`);
  }

  if (reasons.length > 0) return { state: "DEGRADED", reasons, mayStartNewWork: false };
  return { state: "HEALTHY", reasons: [], mayStartNewWork: true };
}

/**
 * What the health endpoint returns.
 *
 * Deliberately contains no configuration, no token, no address and no hash beyond the image digest
 * — a health endpoint is the most-scraped surface a container has.
 */
export const HealthResponseSchema = z.object({
  state: RuntimeHealthStateSchema,
  agentId: z.string(),
  deploymentId: z.string(),
  imageDigest: z.string(),
  uptimeMs: z.number().int().nonnegative(),
  reasons: z.array(z.string()),
  /**
   * Stated on every health response, because "the agent is healthy" is the sentence most likely to
   * be misread as "the agent is authorized".
   */
  note: z.literal("Runtime health says nothing about financial authority. The ContextLock policy on chain decides whether this agent may act."),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const HEALTH_NOTE = "Runtime health says nothing about financial authority. The ContextLock policy on chain decides whether this agent may act." as const;
