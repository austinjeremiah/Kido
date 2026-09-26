/**
 * The canonical P28 Blueprint — §P28.57's prompt, in one place.
 *
 * Both halves of the prompt are here: the Aave repayment limits ($1,000 / $5,000) and the Uniswap
 * treasury rebalancing limits ($500 / $2,000). Encoding the second needs `perActionLimits`, which
 * P28 added because the prompt exposed the gap — a single global pair can only tighten repayment
 * silently or loosen rebalancing silently, and the second is how an agent ends up running
 * autonomously at four times the value its owner authorised.
 *
 * This module exists because it was previously defined twice. `p28-write-blueprint.ts` recorded the
 * two-half document and `p28-demo.ts` built a one-half one, and the demo wrote its version over the
 * recorded file — so the API, the tests and the reports disagreed about which agent P28 is about,
 * depending on which script ran last. One definition, two callers.
 */
import { validGuardian } from "../../packages/studio-blueprint/test/fixtures.js";
import type { ContextLockAgentBlueprint } from "../../packages/studio-blueprint/src/schema.js";

const q = (value: number, sourceQuote: string) => ({ known: true as const, value, sourceQuote });

/** The Sepolia SwapRouter02 the rebalancing action is allowed to call, and nothing else. */
const UNISWAP_ROUTER = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E";

export const CANONICAL_OBJECTIVE = "Prevent liquidation of the Aave position and keep the treasury balanced";

export function canonicalP28Blueprint(): ContextLockAgentBlueprint {
  const base = validGuardian({ objective: CANONICAL_OBJECTIVE });

  const uniswapProtocol = {
    id: "uniswap-v3",
    displayName: "Uniswap V3",
    kind: "dex" as const,
    chainId: 11155111 as const,
    contracts: [{ role: "router", address: { known: true as const, value: UNISWAP_ROUTER, sourceQuote: "Sepolia SwapRouter02" } }],
  };

  const rebalanceAction = {
    id: "rebalance-treasury",
    kind: "UNISWAP_SWAP",
    displayName: "Rebalance treasury via Uniswap",
    protocolRef: "uniswap-v3",
    targetPolicy: { mode: "fixed-allowlist" as const, allowed: [{ known: true as const, value: UNISWAP_ROUTER, sourceQuote: "Use Uniswap" }] },
    /* "Never send funds outside the treasury" — the value returns to where it came from. */
    recipientPolicy: { mode: "self-only" as const },
    spendsAssets: ["WETH", "USDC"],
    approvals: [{ assetSymbol: "WETH", spenderRole: "router", unlimited: false as const, maxAmountPolicy: "exact-action-amount" as const }],
  };

  return {
    ...base,
    protocols: [...base.protocols, uniswapProtocol],
    actions: [...base.actions, rebalanceAction],
    permissions: {
      allowed: [
        ...base.permissions.allowed,
        { id: "p-rebalance", statement: "rebalance the treasury between ETH and USDC via Uniswap", actionRef: "rebalance-treasury" },
      ],
      denied: [
        ...base.permissions.denied,
        { id: "d-external", statement: "send funds outside the treasury" },
        { id: "d-borrow", statement: "borrow" },
      ],
    },
    /* The repayment limits are the global ceiling. */
    autonomousPolicy: {
      maxValueUsdCents: q(100_000, "For repayment: up to $1,000 automatic."),
      allowedActionRefs: [...base.autonomousPolicy.allowedActionRefs, "rebalance-treasury"],
    },
    escalationPolicy: {
      minValueUsdCents: q(100_000, "$1,000 to $5,000 requires approval."),
      maxValueUsdCents: q(500_000, "above $5,000 deny."),
      mechanism: "approval-registry-standin",
      denyIsTerminal: true,
    },
    /* Rebalancing is tighter, and may only ever be tighter. */
    perActionLimits: [
      {
        actionRef: "rebalance-treasury",
        autonomousMaxUsdCents: q(50_000, "For treasury rebalancing: up to $500 automatic."),
        escalationMinUsdCents: q(50_000, "$500 to $2,000 requires approval."),
        escalationMaxUsdCents: q(200_000, "above $2,000 deny."),
        sourceQuote: "For treasury rebalancing: keep ETH between 40% and 50%. Use Uniswap. up to $500 automatic. $500 to $2,000 requires approval. above $2,000 deny.",
      },
    ],
  } as ContextLockAgentBlueprint;
}
