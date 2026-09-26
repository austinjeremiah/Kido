import { z } from "zod";
import { presentable, DEFAULT_TTLS, type Observation } from "./freshness.js";

/**
 * Adapter health.
 *
 * Generic. §25.20 is emphatic that there must be no provider-specific branching in the Studio: the
 * same record describes Uniswap, The Graph, Chainlink, Aave, CCIP and a third-party OpenAPI import,
 * because the moment the control plane knows which provider it is talking to, it starts encoding
 * one provider's quirks into the product.
 *
 * Health here is not "did the last call succeed". It is a rolling window, because a provider that
 * fails one call in twenty is degraded and a provider that failed once an hour ago is not.
 */

export const ADAPTER_HEALTH_STATES = ["HEALTHY", "DEGRADED", "DISABLED", "UNKNOWN"] as const;
export const AdapterHealthStateSchema = z.enum(ADAPTER_HEALTH_STATES);
export type AdapterHealthState = z.infer<typeof AdapterHealthStateSchema>;

export const AdapterHealthSchema = z.object({
  adapterId: z.string().min(1),
  adapterVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  state: AdapterHealthStateSchema,
  lastSuccessAtMs: z.number().int().positive().nullable(),
  lastFailureAtMs: z.number().int().positive().nullable(),
  /** Median over the window, in ms. Median rather than mean: one 30 s timeout skews a mean. */
  latencyMsP50: z.number().int().nonnegative().nullable(),
  latencyMsP95: z.number().int().nonnegative().nullable(),
  recentErrorRate: z.number().min(0).max(1),
  /** Age of the newest data this adapter returned. A fast adapter serving old data is degraded. */
  dataFreshnessMs: z.number().int().nonnegative().nullable(),
  /** The provider's own words for why, when it gave any. */
  lastProviderReason: z.string().nullable(),
  lastCheckedAtMs: z.number().int().positive(),
  /** Set by an operator or by policy. A disabled adapter is not unhealthy; it is switched off. */
  disabledReason: z.string().nullable(),
});
export type AdapterHealth = z.infer<typeof AdapterHealthSchema>;

export interface AdapterHealthPolicy {
  windowMs: number;
  minSamples: number;
  degradedErrorRate: number;
  /** Beyond this, the data an adapter returns is too old to decide on. */
  staleDataMs: number;
  /** A single call slower than this counts as a failure for health purposes. */
  timeoutMs: number;
}

export const DEFAULT_ADAPTER_POLICY: AdapterHealthPolicy = {
  windowMs: 10 * 60_000,
  minSamples: 3,
  degradedErrorRate: 0.2,
  staleDataMs: 5 * 60_000,
  timeoutMs: 10_000,
};

interface Sample {
  atMs: number;
  ok: boolean;
  latencyMs: number;
  dataAtMs: number | null;
  reason: string | null;
}

/**
 * The health service.
 *
 * One instance holds every adapter's window. Records are computed on read rather than on write, so
 * an adapter that stops being called decays to UNKNOWN instead of remaining green forever — the
 * failure mode where a dashboard shows a healthy integration nobody has exercised in a day.
 */
export class AdapterHealthService {
  private readonly samples = new Map<string, Sample[]>();
  private readonly disabled = new Map<string, string>();
  private readonly versions = new Map<string, string>();

  constructor(private readonly policy: AdapterHealthPolicy = DEFAULT_ADAPTER_POLICY) {}

  register(adapterId: string, adapterVersion: string): void {
    this.versions.set(adapterId, adapterVersion);
    if (!this.samples.has(adapterId)) this.samples.set(adapterId, []);
  }

  /** An operator or a policy switching an adapter off. Distinct from it being broken. */
  disable(adapterId: string, reason: string): void {
    this.disabled.set(adapterId, reason);
  }

  enable(adapterId: string): void {
    this.disabled.delete(adapterId);
  }

  record(adapterId: string, s: { atMs: number; ok: boolean; latencyMs: number; dataAtMs?: number | null; reason?: string | null }): void {
    const list = this.samples.get(adapterId) ?? [];
    // A call that took longer than the timeout is a failure even if it eventually returned; a
    // strategy that waited 30 s for a price did not get a usable price.
    const ok = s.ok && s.latencyMs <= this.policy.timeoutMs;
    list.push({ atMs: s.atMs, ok, latencyMs: s.latencyMs, dataAtMs: s.dataAtMs ?? null, reason: s.reason ?? (ok ? null : "call failed") });
    this.samples.set(adapterId, list.filter((x) => s.atMs - x.atMs <= this.policy.windowMs));
  }

  health(adapterId: string, nowMs: number): AdapterHealth {
    const version = this.versions.get(adapterId) ?? "0.0.0";
    const disabledReason = this.disabled.get(adapterId) ?? null;
    const all = (this.samples.get(adapterId) ?? []).filter((x) => nowMs - x.atMs <= this.policy.windowMs);
    const successes = all.filter((x) => x.ok);
    const failures = all.filter((x) => !x.ok);
    const latencies = all.map((x) => x.latencyMs).sort((a, b) => a - b);
    const pick = (q: number) => (latencies.length === 0 ? null : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))]!);
    const newestData = successes.map((x) => x.dataAtMs).filter((x): x is number => x !== null).sort((a, b) => b - a)[0] ?? null;
    const dataFreshnessMs = newestData === null ? null : Math.max(0, nowMs - newestData);
    const errorRate = all.length === 0 ? 0 : failures.length / all.length;

    const base = {
      adapterId, adapterVersion: version,
      lastSuccessAtMs: successes.map((x) => x.atMs).sort((a, b) => b - a)[0] ?? null,
      lastFailureAtMs: failures.map((x) => x.atMs).sort((a, b) => b - a)[0] ?? null,
      latencyMsP50: pick(0.5), latencyMsP95: pick(0.95),
      recentErrorRate: errorRate,
      dataFreshnessMs,
      lastProviderReason: all.slice().reverse().find((x) => x.reason !== null)?.reason ?? null,
      lastCheckedAtMs: all.map((x) => x.atMs).sort((a, b) => b - a)[0] ?? nowMs,
      disabledReason,
    };

    // Disabled beats everything: a switched-off adapter's error rate is not interesting.
    if (disabledReason !== null) return { ...base, state: "DISABLED" };
    // Too few samples to say anything. UNKNOWN, not HEALTHY — silence is not success.
    if (all.length < this.policy.minSamples) return { ...base, state: "UNKNOWN" };
    if (errorRate > this.policy.degradedErrorRate) return { ...base, state: "DEGRADED" };
    if (dataFreshnessMs !== null && dataFreshnessMs > this.policy.staleDataMs) return { ...base, state: "DEGRADED" };
    return { ...base, state: "HEALTHY" };
  }

  all(nowMs: number): AdapterHealth[] {
    return [...this.versions.keys()].map((id) => this.health(id, nowMs)).sort((a, b) => a.adapterId.localeCompare(b.adapterId));
  }

  /** Adapters a Blueprint requires that are not currently usable. Drives policy-enable preconditions. */
  unusable(required: readonly string[], nowMs: number): AdapterHealth[] {
    return required.map((id) => this.health(id, nowMs)).filter((h) => h.state !== "HEALTHY");
  }
}

/**
 * What a runtime is allowed to do with an adapter in a given state.
 *
 * §25.20's last line — the runtime must obey the disabled/degraded rules policy already defines —
 * expressed once, here, rather than reimplemented at each call site.
 */
export function adapterUsage(h: AdapterHealth): { mayRead: boolean; mayDecideOn: boolean; reason: string } {
  switch (h.state) {
    case "HEALTHY":
      return { mayRead: true, mayDecideOn: true, reason: "healthy" };
    case "DEGRADED":
      // Reading is fine; deciding on it is not. A degraded price feed can be displayed and must not
      // be the basis of a trade.
      return { mayRead: true, mayDecideOn: false, reason: h.lastProviderReason ?? `error rate ${(h.recentErrorRate * 100).toFixed(0)}%` };
    case "DISABLED":
      return { mayRead: false, mayDecideOn: false, reason: h.disabledReason ?? "disabled" };
    case "UNKNOWN":
      return { mayRead: true, mayDecideOn: false, reason: "not enough recent samples to establish health" };
  }
}

export const asObservation = (h: AdapterHealth, nowMs: number, ttlMs = DEFAULT_TTLS.adapter): Observation<AdapterHealth> & { ageMs: number; isCurrent: boolean } =>
  presentable(
    {
      state: h.state === "HEALTHY" ? "HEALTHY" : h.state === "DEGRADED" ? "DEGRADED" : h.state === "DISABLED" ? "BLOCKED" : "NOT_CONFIGURED",
      value: h, observedAtMs: h.lastCheckedAtMs, source: `adapter:${h.adapterId}`, ttlMs,
      reason: h.state === "HEALTHY" ? null : (h.disabledReason ?? h.lastProviderReason ?? h.state),
    },
    nowMs,
  );
