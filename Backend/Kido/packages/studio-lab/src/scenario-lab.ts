import { z } from "zod";
import {
  OVERLAY_SCHEMA_VERSION, SYNTHETIC_TRUST_CLASS, FLASH_CRASH, STALE_ORACLE,
  applyOverlay, assertBaseUnchanged, verifySnapshotHash, type ScenarioOverlay, type ScenarioResult, type MarketSnapshot,
} from "@contextlock/studio-reality";

/**
 * Market shock presets, and the comparison they exist to produce.
 *
 * §P28.42 names six presets and one rule: **never rewrite the original MarketSnapshot.** The
 * overlay engine already holds that structurally — `applyOverlay` copies before it changes, and
 * `assertBaseUnchanged` is checkable evidence rather than a promise. What this file adds is the
 * product surface: a named set of shocks a user can reach for, and a comparison that shows the
 * decision moving.
 *
 * Every result carries SYNTHETIC. A shocked snapshot is a question, not a reading, and a screen
 * that showed "$1,704" without saying it was invented would be a fabricated market price.
 */

export const SYNTHETIC_LABEL = "SYNTHETIC OVERLAY" as const;

const overlay = (overlayId: string, name: string, description: string, mutations: ScenarioOverlay["mutations"]): ScenarioOverlay => ({
  schemaVersion: OVERLAY_SCHEMA_VERSION,
  overlayId,
  name,
  description,
  mutations,
});

/** ETH down 10%: a bad day, not a crisis. The one most likely to sit near a threshold. */
export const ETH_MINUS_10: ScenarioOverlay = overlay(
  "eth-minus-10", "ETH −10%",
  "A 10% drawdown with everything else unchanged. Isolates the price from the conditions that usually accompany it.",
  [{ metric: "weth/usd:price", op: "PERCENT", operand: -10, note: "price falls 10%" }],
);

/** ETH down 30%: past most health-factor thresholds. */
export const ETH_MINUS_30: ScenarioOverlay = overlay(
  "eth-minus-30", "ETH −30%",
  "A 30% drawdown. Past the point where a collateral position designed for a 1.6 health factor is comfortable.",
  [{ metric: "weth/usd:price", op: "PERCENT", operand: -30, note: "price falls 30%" }],
);

/** Liquidity thinning without a price move — the shape that makes a swap expensive, not wrong. */
export const LIQUIDITY_REDUCTION: ScenarioOverlay = overlay(
  "liquidity-minus-70", "Liquidity reduction",
  "Pool depth falls 70% with the price unchanged. Tests whether size is checked against depth or only against a limit.",
  [{ metric: "market:liquidity", op: "PERCENT", operand: -70, note: "liquidity falls 70%" }],
);

/** The Graph lagging behind the chain, which is its normal failure rather than an outage. */
export const GRAPH_LAG: ScenarioOverlay = overlay(
  "graph-lag-40", "Graph lag",
  "Indexed data is 40 blocks behind the chain. Tests whether indexed context is treated as current.",
  [{ metric: "graph:indexedBlockLag", op: "LAG_BY_BLOCKS", operand: 40, note: "the index trails the chain by 40 blocks" }],
);

/**
 * The preset set, §P28.42's six.
 *
 * `FLASH_CRASH` and `STALE_ORACLE` are the P27 stock overlays, imported rather than restated: two
 * definitions of "flash crash" that drifted apart would make two screens disagree about what was
 * tested.
 */
export const SHOCK_PRESETS: ReadonlyArray<ScenarioOverlay> = [
  ETH_MINUS_10, ETH_MINUS_30, FLASH_CRASH, STALE_ORACLE, LIQUIDITY_REDUCTION, GRAPH_LAG,
];

export const ShockPresetViewSchema = z.object({
  overlayId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  /** The metrics it changes, so a reader knows what is being invented. */
  mutates: z.array(z.string().min(1)),
  applicable: z.boolean(),
  /** Why a preset cannot run against this snapshot. Null when it can. */
  unavailableReason: z.string().nullable(),
  label: z.literal(SYNTHETIC_LABEL),
  trustClass: z.string().min(1),
});
export type ShockPresetView = z.infer<typeof ShockPresetViewSchema>;

/**
 * Which presets this snapshot can answer.
 *
 * An overlay naming a metric the snapshot does not carry is refused by the engine, and offering it
 * anyway produces a button that always errors. Availability is computed from the snapshot's own
 * observations — the same rule the reality selector follows.
 */
export function shockPresets(base: MarketSnapshot): ShockPresetView[] {
  const metrics = new Set(base.observations.map((o) => o.metric));
  return SHOCK_PRESETS.map((o) => {
    const missing = o.mutations.map((m) => m.metric).filter((m) => !metrics.has(m));
    return {
      overlayId: o.overlayId,
      name: o.name,
      description: o.description,
      mutates: o.mutations.map((m) => m.metric),
      applicable: missing.length === 0,
      unavailableReason: missing.length === 0
        ? null
        : `this snapshot carries no ${missing.join(", ")} observation, and an overlay may not add a metric no source reported`,
      label: SYNTHETIC_LABEL,
      trustClass: SYNTHETIC_TRUST_CLASS,
    };
  });
}

export function presetById(overlayId: string): ScenarioOverlay | null {
  return SHOCK_PRESETS.find((o) => o.overlayId === overlayId) ?? null;
}

/* ─────────────────────────── comparison ─────────────────────────── */

export const ComparisonRowSchema = z.object({
  label: z.string().min(1),
  /** BASE for the real snapshot; the overlay id for a shock. */
  scenario: z.string().min(1),
  synthetic: z.boolean(),
  verdict: z.string().min(1),
  reasonCode: z.string().min(1),
  /** The hash the decision was made against, so a row can be traced to a sealed picture. */
  snapshotHash: z.string().min(1),
  scenarioHash: z.string().nullable(),
  /** How this row differs from the base row. Empty on the base row itself. */
  changedFromBase: z.string().nullable(),
});
export type ComparisonRow = z.infer<typeof ComparisonRowSchema>;

export interface ScenarioDecision {
  verdict: string;
  reasonCode: string;
}

export const SCENARIO_REASONS = {
  BASE_MUTATED: "SCENARIO_BASE_SNAPSHOT_MUTATED",
  SYNTHETIC_UNLABELLED: "SCENARIO_SYNTHETIC_RESULT_UNLABELLED",
} as const;

export class ScenarioLabError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ScenarioLabError";
  }
}

/**
 * Apply a preset and confirm the base survived.
 *
 * Two checks, and they catch different things.
 *
 * `assertBaseUnchanged` compares the base's declared hash before and after. It is redundant today —
 * `applyOverlay` copies every observation before changing it, so the base cannot change — and a
 * mutation run confirms that: removing this line leaves every test green, because the layer above
 * holds the property structurally. It stays as a cheap second check against a future edit to
 * `applyOverlay` that stopped copying.
 *
 * `verifySnapshotHash` is the one with teeth. It recomputes the hash from the content, so a base
 * whose observations were edited in place — leaving the declared hash describing a snapshot that no
 * longer exists — is refused rather than shocked. Shocking a tampered base would produce a
 * comparison against a record nobody sealed.
 */
export function runShock(base: MarketSnapshot, preset: ScenarioOverlay, opts: { snapshotId: string; nowMs?: number }): ScenarioResult {
  const before = base.snapshotHash;
  const result = opts.nowMs === undefined
    ? applyOverlay(base, preset, { snapshotId: opts.snapshotId })
    : applyOverlay(base, preset, { snapshotId: opts.snapshotId, nowMs: opts.nowMs });
  assertBaseUnchanged(base, before);
  verifySnapshotHash(base);
  return result;
}

/**
 * The compare table, §P28.43.
 *
 * The base row is first and is not synthetic. Every other row names the overlay that produced it
 * and how the decision moved — "ALLOW → ESCALATE" is the answer to the question the screen is
 * asking, and a table of verdicts with no base to compare against is not.
 */
export function compareScenarios(
  base: { decision: ScenarioDecision; snapshotHash: string },
  scenarios: ReadonlyArray<{ overlay: ScenarioOverlay; result: ScenarioResult; decision: ScenarioDecision }>,
): ComparisonRow[] {
  const rows: ComparisonRow[] = [{
    label: "Base market",
    scenario: "BASE",
    synthetic: false,
    verdict: base.decision.verdict,
    reasonCode: base.decision.reasonCode,
    snapshotHash: base.snapshotHash,
    scenarioHash: null,
    changedFromBase: null,
  }];

  for (const s of scenarios) {
    const changed = s.decision.verdict === base.decision.verdict && s.decision.reasonCode === base.decision.reasonCode
      ? "no change"
      : `${base.decision.verdict} → ${s.decision.verdict}${s.decision.reasonCode === base.decision.reasonCode ? "" : ` (${s.decision.reasonCode})`}`;
    rows.push({
      label: s.overlay.name,
      scenario: s.overlay.overlayId,
      synthetic: true,
      verdict: s.decision.verdict,
      reasonCode: s.decision.reasonCode,
      snapshotHash: s.result.snapshot.snapshotHash,
      scenarioHash: s.result.scenarioHash,
      changedFromBase: changed,
    });
  }
  return rows;
}

/**
 * Refuse a comparison whose synthetic rows are not marked as synthetic.
 *
 * The rendering rule made checkable. A table where the shocked rows look like readings is a table
 * of market prices that no source ever reported.
 */
export function assertSyntheticLabelled(rows: ReadonlyArray<ComparisonRow>, context: string): void {
  for (const r of rows) {
    if (r.scenario !== "BASE" && !r.synthetic) {
      throw new ScenarioLabError(
        SCENARIO_REASONS.SYNTHETIC_UNLABELLED,
        `${context}: row "${r.label}" came from overlay ${r.scenario} and is not marked synthetic. It would read as a market reading.`,
      );
    }
  }
}

/* ─────────────────────────── deciding against a snapshot ─────────────────────────── */

import { keccak256, toHex } from "viem";
import { evaluatePolicy, type EvaluationRequest, type MarketContext, type PrivatePolicy } from "@contextlock/policy";
import { assertSnapshotUsable, SnapshotError } from "@contextlock/studio-reality";

/**
 * How a scenario verdict was reached, field by field.
 *
 * §P28.43 says the reason comes from the deterministic engine, and this is what makes that
 * checkable rather than asserted. The interesting half is `neutralised`: the policy engine needs
 * slippage, volatility, liquidity and a health factor, and a mainnet price snapshot carries none of
 * them. Filling them with plausible numbers would let an invented value decide the verdict — so
 * they are set to values that *cannot* bind, and the list says which ones and why.
 */
export interface ScenarioDecisionBasis {
  /** Fields the snapshot actually supplied. */
  fromSnapshot: string[];
  /** Fields set to a deliberately non-binding value, so nothing invented moved the verdict. */
  neutralised: string[];
  /** The action being ruled on, stated because its size is what the price converts. */
  action: string;
}

export interface ScenarioDecisionResult extends ScenarioDecision {
  /** Which layer produced the verdict — the snapshot's own freshness gate, or the policy. */
  layer: "REALITY" | "POLICY";
  /** The action's value in USD at this scenario's price, formatted. */
  valuedAt: string | null;
  basis: ScenarioDecisionBasis;
}

const NEUTRALISED = [
  "slippageBps = 0 — a mainnet price snapshot carries no execution slippage, and 0 cannot trip the bound",
  "volatilityBps = 0 — not observed here; 0 cannot trip the volatility bound",
  "liquidity = the policy's own minimum — not observed here, and the minimum cannot fall below itself",
  "healthFactorBps = the policy's target — not observed here, and the target is never the escalation trigger",
];

/**
 * Rule on a fixed-size action against a snapshot, through the real engines.
 *
 * The action is denominated in the asset rather than in dollars, which is the whole reason a price
 * shock changes the answer: a fixed 0.5 WETH repayment is a different amount of money at $2,438
 * than at $1,707, and that movement across a limit is what the compare table exists to show.
 */
export function decideOnSnapshot(args: {
  snapshot: MarketSnapshot;
  policy: PrivatePolicy;
  priceMetric: string;
  /** The action size, in the priced asset's smallest unit. */
  amount: bigint;
  amountDecimals: number;
  amountLabel: string;
  actionKind: string;
  agentIdentityHash: string;
  target: string;
  recipient: string;
  nowMs: number;
  maxSnapshotAgeMs: number;
}): ScenarioDecisionResult {
  const basis: ScenarioDecisionBasis = {
    fromSnapshot: [`${args.priceMetric} (verified oracle observation)`, "the observation's own source timestamp"],
    neutralised: NEUTRALISED,
    action: args.amountLabel,
  };

  try {
    assertSnapshotUsable(args.snapshot, args.nowMs, args.maxSnapshotAgeMs, "scenario decision");
  } catch (e) {
    if (e instanceof SnapshotError) {
      return { verdict: "DENY", reasonCode: "NO_VALID_CONTEXT", layer: "REALITY", valuedAt: null, basis };
    }
    throw e;
  }

  const price = args.snapshot.observations.find((o) => o.metric === args.priceMetric);
  if (!price) {
    return { verdict: "DENY", reasonCode: "NO_VALID_CONTEXT", layer: "REALITY", valuedAt: null, basis };
  }

  /*
   * Value the action, in integer arithmetic throughout.
   *
   * The policy engine works in 6dp base units. Converting through a float here would make the
   * verdict depend on rounding at a threshold, which is exactly where these scenarios sit.
   */
  const USD_DECIMALS = 6n;
  const scale = 10n ** (BigInt(args.amountDecimals) + BigInt(price.decimals) - USD_DECIMALS);
  const usdBase = (args.amount * BigInt(price.value)) / scale;

  /*
   * The observation's own timestamp, and the refusal to substitute one.
   *
   * A source that reports no timestamp cannot be aged, which means freshness cannot be checked —
   * and an unfreshness-checkable price is not a valid context. Falling back to the snapshot's
   * observedAtMs would make every such observation look fresh forever.
   */
  if (price.sourceTimestampMs === null) {
    return { verdict: "DENY", reasonCode: "NO_VALID_CONTEXT", layer: "REALITY", valuedAt: null, basis };
  }

  const ctx: MarketContext = {
    observedAtUnix: Math.floor(price.sourceTimestampMs / 1000),
    slippageBps: 0,
    volatilityBps: 0,
    liquidity: args.policy.minLiquidity,
    healthFactorBps: args.policy.targetHealthFactorBps,
  };

  const req: EvaluationRequest = {
    requestHash: keccak256(toHex(`scenario:${args.snapshot.snapshotHash}`)),
    agentIdentityHash: args.agentIdentityHash,
    ensNode: keccak256(toHex("scenario-ens")),
    agent: args.recipient,
    chainId: 11155111,
    target: args.target,
    value: 0n,
    calldataHash: keccak256(toHex("scenario-calldata")),
    selector: "0x573ade81",
    decodedRecipient: args.recipient,
    decodedAmount: usdBase,
    intentHash: keccak256(toHex("scenario-intent")),
    policyId: args.policy.policyId,
    policyVersion: args.policy.policyVersion,
    actionKind: args.actionKind,
  };

  const decision = evaluatePolicy(req, args.policy, ctx, Math.floor(args.nowMs / 1000));
  return {
    verdict: decision.verdict,
    reasonCode: decision.reasonCode,
    layer: "POLICY",
    valuedAt: `$${(Number(usdBase) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
    basis,
  };
}
