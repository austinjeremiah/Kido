import type { MonitorSpec } from "../monitor.js";
import type { DataObservation } from "../observation.js";

export interface AllocationState {
  /** Raw balances held by the account endpoint. */
  balances: Record<string, bigint>;
  /** Value of every asset expressed in raw units of `quote` (the target asset). */
  valueInQuote: Record<string, bigint>;
  quote: string;
  share: number;
  target: number;
  total: bigint;
}

export interface AllocationMonitorConfig {
  id: string;
  chain: string;
  /** Asset whose share is targeted, and the other asset held against it. */
  quote: string;
  base: string;
  target: number;
  /** Drift (in percentage points) that triggers a rebalance. */
  driftPct: number;
  maxAgeMs: number;
  /** Raw balance of an asset in the account endpoint. */
  balance: (asset: string) => Promise<bigint>;
  /** Raw units of `base` per raw unit of `quote`, from the pinned pool, as a fraction. */
  price: () => Promise<{ num: bigint; den: bigint }>;
  clock?: (() => number) | undefined;
}

/** Portfolio share of the target asset, priced from the pool the agent is allowed to trade on. */
export function allocationMonitor(c: AllocationMonitorConfig): MonitorSpec {
  return {
    id: c.id,
    requiredTrust: "RPC_DIRECT",
    async observe() {
      const [q, b, p] = await Promise.all([c.balance(c.quote), c.balance(c.base), c.price()]);
      const bInQuote = p.num === 0n ? 0n : (b * p.den) / p.num;
      const total = q + bInQuote;
      const share = total === 0n ? c.target : Number((q * 1_000_000n) / total) / 1_000_000;
      const value: AllocationState = { balances: { [c.quote]: q, [c.base]: b }, valueInQuote: { [c.quote]: q, [c.base]: bInQuote }, quote: c.quote, share, target: c.target, total };
      const o: DataObservation<AllocationState> = { id: `${c.id}:${Date.now()}`, adapterId: "allocation", chain: c.chain, subject: `${c.quote}/${c.base}`, kind: "ALLOCATION", value, observedAt: (c.clock ?? Date.now)(), freshnessMs: c.maxAgeMs, trust: "RPC_DIRECT" };
      return [o];
    },
    evaluate(obs) {
      const s = obs[0]!.value as AllocationState;
      const drift = Math.abs(s.share - s.target) * 100;
      const key = `${c.id}:drift`;
      return [drift > c.driftPct ? { kind: "ALLOCATION_DRIFT", key, data: { share: s.share, target: s.target, driftPct: drift } } : { kind: "CLEAR", key, data: {} }];
    },
  };
}
