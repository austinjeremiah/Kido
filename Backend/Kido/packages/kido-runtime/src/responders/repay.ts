import type { Chain } from "@kido/agents";
import type { DeterministicResponder } from "../gate.js";
import type { MonitorEvent } from "../monitor.js";
import type { AavePosition } from "../monitors/aave.js";

export interface RepayWorld {
  /** Spendable balance of the repay asset in the account endpoint, base units. */
  available: bigint;
  /** Lease per-action cap for the repay asset, base units. */
  perActionCap: bigint;
}

export interface RepaySizerConfig {
  chain: Chain;
  asset: string;
  beneficiaryLabel: string;
  /** Health factor the repayment aims to restore. */
  targetHealthFactor: number;
}

const SCALE = 1_000_000n;

/**
 * Amount of the repay asset that brings the position to the target health factor:
 * debt' = collateral × LT / target, repay = debt − debt', converted with the pool oracle price.
 */
export function repayAmountFor(p: AavePosition, target: number): bigint {
  const t = BigInt(Math.round(target * Number(SCALE)));
  const debtAfter = (p.collateralBase * p.liquidationThreshold * SCALE) / (10_000n * t);
  if (p.debtBase <= debtAfter || p.assetPriceBase === 0n) return 0n;
  const base = p.debtBase - debtAfter;
  return (base * 10n ** BigInt(p.assetDecimals) + p.assetPriceBase - 1n) / p.assetPriceBase;
}

/**
 * Deterministic REPAY for a health-factor breach. It repays what is needed, capped by the lease's
 * per-action limit; with no spendable balance it wakes the specialist to find funds (the only case
 * that needs reasoning).
 */
export function repayResponder(c: RepaySizerConfig): DeterministicResponder<RepayWorld> {
  return {
    id: "aave-repay-sizer",
    handles: "HEALTH_FACTOR_BREACH",
    respond(event: MonitorEvent, world: RepayWorld) {
      const p = event.observations[0]?.value as AavePosition | undefined;
      if (!p) return { kind: "NO_ACTION", reason: "no position observation" };
      const need = repayAmountFor(p, c.targetHealthFactor);
      if (need === 0n) return { kind: "NO_ACTION", reason: "position already at or above target" };
      const amount = [need, world.perActionCap, world.available].reduce((a, b) => (a < b ? a : b));
      if (amount === 0n) return { kind: "WAKE", condition: "RESOURCE_SHORTFALL", specialist: "RepayDebtAgent", reason: `needs ${need} ${c.asset} on ${c.chain}; endpoint holds none` };
      return { kind: "ACTIONS", steps: [{ stepId: "repay", chain: c.chain, action: "REPAY", asset: c.asset, assetOut: null, amount, payee: c.beneficiaryLabel, dependsOn: [], origin: "DETERMINISTIC" }] };
    },
  };
}
