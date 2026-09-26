import { STRATEGY_IR_VERSION, type Strategy } from "../src/ir.js";
import { UNITS } from "../src/units.js";

/**
 * The canonical treasury strategy: The Graph history + Chainlink price + wallet balances →
 * ETH allocation → swap decision.
 */
export function treasuryStrategy(over: Partial<Strategy> = {}): Strategy {
  return {
    schemaVersion: STRATEGY_IR_VERSION,
    planId: "treasury-rebalancer",
    revision: 1,
    triggers: [{ id: "allocation-drift", kind: "threshold", description: "ETH allocation leaves the target band." }],
    inputs: [
      {
        id: "eth-price", requirementKey: "ethUsd", dataKind: "eth_usd_price",
        unit: UNITS.price("USD", 8), minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 30_000,
        description: "Verified ETH/USD reference price.",
      },
      {
        id: "eth-balance", requirementKey: "ethBalance", dataKind: "indexed_token_balance",
        unit: UNITS.token("ETH", 18), minimumTrustClass: "INDEXED_CHAIN_DATA", maxAgeMs: 120_000,
        description: "Treasury ETH balance.",
      },
      {
        id: "portfolio-usd", requirementKey: "portfolioUsd", dataKind: "aave_total_collateral_usd",
        unit: UNITS.usd, minimumTrustClass: "DIRECT_CHAIN_DATA", maxAgeMs: 120_000,
        description: "Total treasury value in USD.",
      },
    ],
    transforms: [
      { id: "eth-usd-value", op: "TOKEN_TO_USD", inputs: ["eth-balance", "eth-price"], description: "ETH holdings valued in USD." },
      { id: "eth-allocation-bps", op: "RATIO_TO_BPS", inputs: ["eth-usd-value", "portfolio-usd"], description: "ETH share of the treasury." },
    ],
    decisions: [
      {
        id: "rebalance-when-low",
        when: { type: "compare", op: "LT", left: { type: "ref", id: "eth-allocation-bps" }, right: { type: "literal", value: "4000", unit: UNITS.bps } },
        actionRef: "swap-usdc-to-eth",
        autonomousMaxUsdCents: 50_000,
        escalationMaxUsdCents: 200_000,
        aboveCeiling: "DENY",
        description: "Below 40% ETH, buy ETH with USDC.",
      },
    ],
    actions: [
      { id: "swap-usdc-to-eth", capability: "TOKEN_SWAP", actionKind: "TOKEN_SWAP", spendsAsset: "USDC", recipientPolicy: "self-only", description: "Swap USDC into ETH." },
    ],
    unknowns: [],
    invariants: [{ id: "SI-1", statement: "Funds never leave the treasury." }],
    requiresCapability: [],
    ...over,
  };
}
