import type { DataObservation, TrustClass } from "./observation.js";
import { isFresh, meetsTrust } from "./observation.js";

export interface MonitorEvent {
  monitorId: string;
  kind: string;
  /** Stable identity of the underlying condition, so a re-observed condition is not a new event. */
  key: string;
  at: number;
  data: Record<string, unknown>;
  observations: DataObservation<unknown>[];
}

export interface MonitorSpec {
  id: string;
  requiredTrust: TrustClass;
  observe(): Promise<DataObservation<unknown>[]>;
  evaluate(observations: DataObservation<unknown>[], now: number): Omit<MonitorEvent, "monitorId" | "at" | "observations">[];
}

export type MonitorHealth = { monitorId: string; status: "OK" | "STALE" | "UNTRUSTED" | "ERROR"; detail?: string };

/**
 * Deterministic watcher. It never calls a model: it observes, evaluates pure predicates and emits
 * events. Whether an event needs reasoning is the gate's decision, made afterwards.
 */
export class MonitorEngine {
  private readonly seen = new Set<string>();
  readonly health = new Map<string, MonitorHealth>();

  constructor(private readonly specs: MonitorSpec[], private readonly clock: () => number = Date.now) {}

  async tick(): Promise<MonitorEvent[]> {
    const out: MonitorEvent[] = [];
    for (const spec of this.specs) {
      let obs: DataObservation<unknown>[];
      try {
        obs = await spec.observe();
      } catch (err) {
        this.health.set(spec.id, { monitorId: spec.id, status: "ERROR", detail: (err as Error).message.slice(0, 200) });
        continue;
      }
      const now = this.clock();
      if (obs.some((o) => !isFresh(o, now))) {
        this.health.set(spec.id, { monitorId: spec.id, status: "STALE" });
        continue;
      }
      if (obs.some((o) => !meetsTrust(o, spec.requiredTrust))) {
        this.health.set(spec.id, { monitorId: spec.id, status: "UNTRUSTED" });
        continue;
      }
      this.health.set(spec.id, { monitorId: spec.id, status: "OK" });
      for (const e of spec.evaluate(obs, now)) {
        if (this.seen.has(e.key)) continue;
        this.seen.add(e.key);
        out.push({ ...e, monitorId: spec.id, at: now, observations: obs });
      }
    }
    return out;
  }
}
