import type { Chain } from "@kido/agents";
import type { DeterministicResponder } from "../gate.js";
import type { AllocationState } from "../monitors/allocation.js";

export interface RebalanceWorld {
  /** Lease per-action cap per asset, raw units. */
  perActionCap: Record<string, bigint>;
}

/**
 * Deterministic rebalance: sells the over-weight asset back towards the target share, capped by the
 * lease per-action limit. It only trades in directions the owner pinned a price floor for; the
 * other direction is left to the owner (no floor means no authority to trade it).
 */
export function rebalanceResponder(c: { chain: Chain; quote: string; base: string; floorDirections: [string, string][] }): DeterministicResponder<RebalanceWorld> {
  return {
    id: "allocation-rebalancer",
    handles: "ALLOCATION_DRIFT",
    respond(event, world) {
      const s = event.observations[0]?.value as AllocationState | undefined;
      if (!s) return { kind: "NO_ACTION", reason: "no allocation observation" };
      const sellQuote = s.share > s.target;
      const [assetIn, assetOut] = sellQuote ? [c.quote, c.base] : [c.base, c.quote];
      if (!c.floorDirections.some(([i, o]) => i === assetIn && o === assetOut)) return { kind: "NO_ACTION", reason: `no owner floor for ${assetIn} → ${assetOut}; rebalancing that way needs the owner` };
      const excessQuote = BigInt(Math.floor(Math.abs(s.share - s.target) * 1_000_000)) * s.total / 1_000_000n;
      const inUnits = sellQuote ? excessQuote : s.valueInQuote[c.base] === 0n ? 0n : (excessQuote * s.balances[c.base]!) / s.valueInQuote[c.base]!;
      const cap = world.perActionCap[assetIn] ?? 0n;
      const amount = inUnits < cap ? inUnits : cap;
      if (amount <= 0n) return { kind: "NO_ACTION", reason: "nothing to sell within the lease" };
      return { kind: "ACTIONS", steps: [{ stepId: "rebalance", chain: c.chain, action: "SWAP", asset: assetIn, assetOut, amount, payee: null, dependsOn: [], origin: "DETERMINISTIC" }] };
    },
  };
}
