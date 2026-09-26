import { z } from "zod";

/**
 * Freshness, as a type rather than a convention.
 *
 * Every external state this control plane displays — chain, CRE, runtime, adapters — was true at
 * some moment in the past. §25.11 and the data-freshness UX rule both come down to one thing:
 *
 *     DO NOT SHOW GREEN BECAUSE DATA ONCE SUCCEEDED.
 *
 * So an observation is never a bare value. It is a value, the moment it was read, the source that
 * read it, and a TTL beyond which it stops being presentable as current. A consumer that wants the
 * value has to go through `presentable()`, which will tell it the reading is stale — there is no
 * accessor that hands back the value while hiding its age.
 */

export const OBSERVATION_STATES = [
  /** Never been read. Not an error; an integration that has not run yet. */
  "NOT_CONFIGURED",
  /** Read successfully, within its TTL. */
  "HEALTHY",
  /** Read successfully, but the reading is older than its TTL. The value is history, not status. */
  "STALE",
  /** Read, and the thing reported a problem. */
  "DEGRADED",
  /** Could not be read at all. */
  "FAILED",
  /** Cannot be read because something else is missing, and that is expected. */
  "BLOCKED",
  /** Read, and it disagrees with what we expected. */
  "DRIFT",
] as const;
export const ObservationStateSchema = z.enum(OBSERVATION_STATES);
export type ObservationState = z.infer<typeof ObservationStateSchema>;

export interface Observation<T> {
  state: ObservationState;
  /** Null unless state is HEALTHY, DEGRADED or DRIFT — a FAILED read has no value to offer. */
  value: T | null;
  /** When the underlying system was actually read. */
  observedAtMs: number;
  /** What did the reading. Shown to the user; "cached" is a source, and it says so. */
  source: string;
  ttlMs: number;
  /** Present when the state is not HEALTHY. A degraded reading with no reason is unactionable. */
  reason: string | null;
}

export function observed<T>(value: T, args: { atMs: number; source: string; ttlMs: number; state?: ObservationState; reason?: string }): Observation<T> {
  return {
    state: args.state ?? "HEALTHY",
    value,
    observedAtMs: args.atMs,
    source: args.source,
    ttlMs: args.ttlMs,
    reason: args.reason ?? null,
  };
}

export function unavailable<T>(state: Extract<ObservationState, "NOT_CONFIGURED" | "FAILED" | "BLOCKED">, args: { atMs: number; source: string; ttlMs: number; reason: string }): Observation<T> {
  return { state, value: null, observedAtMs: args.atMs, source: args.source, ttlMs: args.ttlMs, reason: args.reason };
}

export const isExpired = (o: Observation<unknown>, nowMs: number): boolean => nowMs - o.observedAtMs > o.ttlMs;

/**
 * What may be shown, and how.
 *
 * The only way to get at an observation's value. An expired reading comes back as STALE with the
 * value still attached — because "last confirmed 14:31:07, current status UNKNOWN" is more useful
 * than hiding it — but the state has changed, so a UI that colours on `state` cannot paint it
 * green, and one that only reads `value` fails the LIVE-006 test.
 */
export function presentable<T>(o: Observation<T>, nowMs: number): Observation<T> & { ageMs: number; isCurrent: boolean } {
  const ageMs = nowMs - o.observedAtMs;
  const expired = isExpired(o, nowMs);
  if (expired && (o.state === "HEALTHY" || o.state === "DEGRADED")) {
    return {
      ...o,
      state: "STALE",
      reason: `last confirmed ${new Date(o.observedAtMs).toISOString()}, ${Math.round(ageMs / 1000)}s ago; beyond the ${Math.round(o.ttlMs / 1000)}s freshness window, so this is the last known value and not current status`,
      ageMs,
      isCurrent: false,
    };
  }
  return { ...o, ageMs, isCurrent: !expired && o.state === "HEALTHY" };
}

/**
 * Default freshness windows.
 *
 * Each is roughly "how long before this being out of date could mislead someone into a decision".
 * Chain state is the tightest because it is what the prominent POLICY ENABLED/DISABLED indicator
 * reads from, and a stale reading there is the one that matters most.
 */
export const DEFAULT_TTLS = {
  chain: 30_000,
  policy: 30_000,
  identity: 60_000,
  cre: 120_000,
  runtime: 30_000,
  adapter: 120_000,
} as const;

/** True only when every input is genuinely current. Used by the "is this agent LIVE?" question. */
export function allCurrent(observations: Array<Observation<unknown>>, nowMs: number): boolean {
  return observations.length > 0 && observations.every((o) => presentable(o, nowMs).isCurrent);
}
