import { createHash } from "node:crypto";
import { z } from "zod";
import {
  sealSnapshot, type MarketObservation, type MarketSnapshot, type SnapshotSource,
} from "./snapshot.js";
import type { DataTrustClass } from "@contextlock/studio-adapters";

/**
 * Scenario overlays: what if the world were worse?
 *
 * The value of a shock test is that it uses a real market picture and changes one thing. The danger
 * is that the result looks exactly like a real market picture — same schema, same fields, same
 * plausible numbers — and gets cited as one.
 *
 * Three rules keep them distinguishable, and each is enforced separately:
 *
 * 1. **The base snapshot is never modified.** An overlay produces a new sealed snapshot; the
 *    original still hashes to what it hashed to before.
 * 2. **A synthetic value is labelled as one.** Trust does not improve by being edited, and it does
 *    not stay the same either — `SIMULATED_FROM_VERIFIED_ORACLE` is not `VERIFIED_ORACLE`.
 * 3. **The mutation has to be possible.** A negative price or a health factor denominated in
 *    dollars is not a pessimistic scenario, it is a broken one, and a strategy's response to it
 *    tells you nothing.
 */

export const OVERLAY_SCHEMA_VERSION = "contextlock.scenario-overlay/v1" as const;

export const OVERLAY_OPS = ["PERCENT", "ADD_BPS", "SET", "AGE_BY_MS", "LAG_BY_BLOCKS"] as const;
export const OverlayOpSchema = z.enum(OVERLAY_OPS);
export type OverlayOp = z.infer<typeof OverlayOpSchema>;

export const OverlayMutationSchema = z.object({
  /** Which observation, by metric. */
  metric: z.string().min(1),
  op: OverlayOpSchema,
  /** Percent as a signed integer: -20 is a 20% fall. Bps and ms are literal. */
  operand: z.number().int(),
  note: z.string().min(1),
});
export type OverlayMutation = z.infer<typeof OverlayMutationSchema>;

export const ScenarioOverlaySchema = z.object({
  schemaVersion: z.literal(OVERLAY_SCHEMA_VERSION),
  overlayId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  mutations: z.array(OverlayMutationSchema).min(1),
});
export type ScenarioOverlay = z.infer<typeof ScenarioOverlaySchema>;

export const OVERLAY_REASONS = {
  IMPOSSIBLE_VALUE: "OVERLAY_PRODUCES_IMPOSSIBLE_VALUE",
  UNKNOWN_METRIC: "OVERLAY_METRIC_NOT_IN_SNAPSHOT",
  WRONG_OP: "OVERLAY_OP_INVALID_FOR_DATATYPE",
  BASE_MUTATED: "OVERLAY_MUST_NOT_MUTATE_BASE",
  TRUST_INFLATION: "OVERLAY_CANNOT_INCREASE_TRUST",
} as const;
export type OverlayReason = (typeof OVERLAY_REASONS)[keyof typeof OVERLAY_REASONS];

export class OverlayError extends Error {
  constructor(readonly reason: OverlayReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "OverlayError";
  }
}

/* ───────────────────────────── trust, downgraded ───────────────────────────── */

export const SIMULATED_TRUST_PREFIX = "SIMULATED_FROM_" as const;

/**
 * The provenance label a synthetic value carries.
 *
 * §P27.39 forbids the upgrade — an overlay on indexed data does not become a verified oracle
 * reading. This goes further and refuses to leave it EQUAL: a synthetic value derived from a
 * verified oracle reading is not itself a verified oracle reading, because no oracle attested to
 * it. `SIMULATED_FROM_VERIFIED_ORACLE` records where it came from without inheriting the standing.
 */
export function simulatedTrustLabel(base: DataTrustClass): string {
  return `${SIMULATED_TRUST_PREFIX}${base}`;
}

/**
 * The trust class a synthetic value carries in the type system.
 *
 * `USER_UNTRUSTED`, and the reasoning is worth stating because it looks harsh. A scenario value was
 * chosen by whoever wrote the overlay. That is the same provenance as a value supplied by an agent,
 * and the trust model already has a name for it. A strategy requiring `VERIFIED_ORACLE` will refuse
 * to act on a scenario value, which is correct: the scenario exists to see how the strategy behaves
 * under stress, not to grant it new authority.
 */
export const SYNTHETIC_TRUST_CLASS: DataTrustClass = "USER_UNTRUSTED";

/* ───────────────────────────── validation ───────────────────────────── */

/** Data types whose values may never be negative. */
const NON_NEGATIVE_TYPES = new Set(["PRICE", "AMOUNT", "COUNT", "HEALTH_FACTOR", "TIMESTAMP"]);

/** Which operations are meaningful for which data type. */
const OP_ALLOWED: Record<OverlayOp, ReadonlySet<string>> = {
  PERCENT: new Set(["PRICE", "AMOUNT", "RATE", "RATIO", "COUNT", "HEALTH_FACTOR"]),
  ADD_BPS: new Set(["BPS", "RATE", "RATIO"]),
  SET: new Set(["PRICE", "AMOUNT", "RATE", "RATIO", "BPS", "COUNT", "HEALTH_FACTOR"]),
  AGE_BY_MS: new Set(["PRICE", "AMOUNT", "RATE", "RATIO", "BPS", "COUNT", "HEALTH_FACTOR", "TIMESTAMP"]),
  LAG_BY_BLOCKS: new Set(["PRICE", "AMOUNT", "RATE", "RATIO", "BPS", "COUNT", "HEALTH_FACTOR"]),
};

/**
 * Apply one mutation to one observation, and refuse an impossible result.
 *
 * §P27.38. The checks are on the RESULT rather than on the operand, because `-20%` is a perfectly
 * reasonable instruction that produces a negative price when applied twice to a small number — the
 * operand is not where impossibility appears.
 */
function applyMutation(o: MarketObservation, m: OverlayMutation): MarketObservation {
  const allowed = OP_ALLOWED[m.op];
  if (!allowed.has(o.dataType)) {
    throw new OverlayError(
      OVERLAY_REASONS.WRONG_OP,
      `${m.op} is not meaningful for a ${o.dataType} (${o.metric}). A percentage change to a timestamp, or a basis-point addition to a price, produces a number with no interpretation.`,
    );
  }

  let value = BigInt(o.value);
  let sourceTimestampMs = o.sourceTimestampMs;
  let blockNumber = o.blockNumber;

  switch (m.op) {
    case "PERCENT":
      value = (value * BigInt(100 + m.operand)) / 100n;
      break;
    case "ADD_BPS":
      value = value + BigInt(m.operand);
      break;
    case "SET":
      value = BigInt(m.operand);
      break;
    case "AGE_BY_MS":
      // Ageing moves the value's timestamp backwards; the value itself is untouched.
      sourceTimestampMs = sourceTimestampMs === null ? null : Math.max(0, sourceTimestampMs - m.operand);
      break;
    case "LAG_BY_BLOCKS":
      blockNumber = blockNumber === null ? null : String(Math.max(0, Number(blockNumber) - m.operand));
      break;
  }

  if (NON_NEGATIVE_TYPES.has(o.dataType) && value < 0n) {
    throw new OverlayError(
      OVERLAY_REASONS.IMPOSSIBLE_VALUE,
      `${m.op} ${m.operand} on ${o.metric} produces ${value}, and a ${o.dataType} cannot be negative. A scenario a strategy could never encounter tells you nothing about the strategy.`,
    );
  }
  if (!Number.isFinite(Number(value))) {
    throw new OverlayError(OVERLAY_REASONS.IMPOSSIBLE_VALUE, `${m.op} on ${o.metric} produced a non-finite value`);
  }
  if (sourceTimestampMs !== null && !Number.isFinite(sourceTimestampMs)) {
    throw new OverlayError(OVERLAY_REASONS.IMPOSSIBLE_VALUE, `${m.op} on ${o.metric} produced a non-finite timestamp`);
  }

  return {
    ...o,
    value: value.toString(),
    sourceTimestampMs,
    blockNumber,
    // The two fields that stop this being mistaken for a measurement.
    trustClass: SYNTHETIC_TRUST_CLASS,
    derivedFrom: `${o.observationId}@${simulatedTrustLabel(o.trustClass)}`,
    provenance: `${simulatedTrustLabel(o.trustClass)}: ${m.note} (${m.op} ${m.operand} applied to ${o.observationId}, originally ${o.provenance})`,
  };
}

/* ───────────────────────────── application ───────────────────────────── */

export interface ScenarioResult {
  overlay: ScenarioOverlay;
  baseSnapshotHash: string;
  scenarioHash: string;
  snapshot: MarketSnapshot;
  /** Which observations were changed, so a reader can see the synthetic ones at a glance. */
  mutatedMetrics: string[];
}

/**
 * The scenario hash binds the base and the overlay.
 *
 * §P27.37. Neither alone identifies the result: the same overlay on a different snapshot is a
 * different scenario, and so is a different overlay on the same snapshot.
 */
export function computeScenarioHash(baseSnapshotHash: string, overlay: ScenarioOverlay): string {
  const body = [
    `base=${baseSnapshotHash}`,
    `overlay=${overlay.overlayId}`,
    `schema=${overlay.schemaVersion}`,
    ...overlay.mutations.map((m) => `m:${m.metric}|${m.op}|${m.operand}`),
  ].join("&");
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

/**
 * Apply an overlay, producing a new sealed snapshot.
 *
 * The base is read and never written. Every observation is copied before it is changed, so an
 * accidental in-place edit would be a type error rather than a silent corruption of the record a
 * decision already cited.
 */
export function applyOverlay(base: MarketSnapshot, overlay: ScenarioOverlay, opts: { snapshotId: string; nowMs?: number }): ScenarioResult {
  ScenarioOverlaySchema.parse(overlay);

  const byMetric = new Map(base.observations.map((o) => [o.metric, o]));
  for (const m of overlay.mutations) {
    if (!byMetric.has(m.metric)) {
      throw new OverlayError(
        OVERLAY_REASONS.UNKNOWN_METRIC,
        `the overlay changes "${m.metric}" and the base snapshot has no such observation. Known: ${[...byMetric.keys()].join(", ")}. Adding a metric an overlay invented would put a value into the picture that no source ever reported.`,
      );
    }
  }

  const mutatedMetrics: string[] = [];
  const observations = base.observations.map((o) => {
    const mutations = overlay.mutations.filter((m) => m.metric === o.metric);
    if (mutations.length === 0) return { ...o };
    mutatedMetrics.push(o.metric);
    return mutations.reduce((acc, m) => applyMutation(acc, m), { ...o });
  });

  // The overlay is recorded as a source of its own, so provenance points at something nameable.
  const overlaySource: SnapshotSource = {
    sourceId: `overlay:${overlay.overlayId}`,
    kind: "EXTERNAL_API",
    adapterId: "contextlock-scenario-overlay",
    adapterVersion: OVERLAY_SCHEMA_VERSION,
    trustClass: SYNTHETIC_TRUST_CLASS,
    sourceChainId: base.anchorChainId,
    timeSupport: "NON_HISTORICAL_SOURCE",
    observedBlock: base.anchorBlock,
    lagBlocks: null,
    healthy: true,
    detail: `synthetic: ${overlay.name}`,
  };

  const snapshot = sealSnapshot({
    snapshotId: opts.snapshotId,
    mode: base.mode,
    observedAtMs: base.observedAtMs,
    anchorChainId: base.anchorChainId,
    anchorBlock: base.anchorBlock,
    anchorBlockHash: base.anchorBlockHash,
    anchorBlockTimestampMs: base.anchorBlockTimestampMs,
    sources: [...base.sources, overlaySource],
    observations,
    provenance: [
      ...base.provenance,
      `scenario overlay "${overlay.name}" (${overlay.overlayId}) applied to ${base.snapshotId} (${base.snapshotHash})`,
      `mutated: ${mutatedMetrics.join(", ") || "nothing"}`,
    ],
    supersedes: null,
    nowMs: opts.nowMs ?? base.observedAtMs,
    // A scenario deliberately ages values, so skew is not a defect here.
    maxTimeSkewMs: Number.MAX_SAFE_INTEGER,
    maxSourceAgeMs: Number.MAX_SAFE_INTEGER,
  });

  return {
    overlay,
    baseSnapshotHash: base.snapshotHash,
    scenarioHash: computeScenarioHash(base.snapshotHash, overlay),
    snapshot,
    mutatedMetrics,
  };
}

/**
 * Confirm the base survived an overlay untouched.
 *
 * A test could assert this itself, and having it as a function means the property is checked at
 * every call site rather than only where someone remembered to look.
 */
export function assertBaseUnchanged(base: MarketSnapshot, hashBefore: string): void {
  if (base.snapshotHash !== hashBefore) {
    throw new OverlayError(
      OVERLAY_REASONS.BASE_MUTATED,
      `the base snapshot hashed to ${hashBefore} before the overlay and ${base.snapshotHash} after. An overlay that edits its input destroys the record the original decision was made against.`,
    );
  }
}

/* ───────────────────────────── stock scenarios ───────────────────────────── */

/** A flash crash: price down hard, volatility up, liquidity thin. */
export const FLASH_CRASH: ScenarioOverlay = {
  schemaVersion: OVERLAY_SCHEMA_VERSION,
  overlayId: "flash-crash-20",
  name: "Flash crash",
  description: "A 20% drawdown with volatility spiking and liquidity halving — the shape of a cascade, not a drift.",
  mutations: [
    { metric: "weth/usd:price", op: "PERCENT", operand: -20, note: "price falls 20%" },
    { metric: "market:volatilityBps", op: "SET", operand: 5000, note: "volatility to 5000bps" },
    { metric: "market:liquidity", op: "PERCENT", operand: -50, note: "liquidity halves" },
  ],
};

/** An oracle that stopped updating while the market moved. */
export const STALE_ORACLE: ScenarioOverlay = {
  schemaVersion: OVERLAY_SCHEMA_VERSION,
  overlayId: "stale-oracle-120s",
  name: "Stale oracle",
  description: "The price is unchanged and two minutes old. Tests whether freshness is checked or assumed.",
  mutations: [{ metric: "weth/usd:price", op: "AGE_BY_MS", operand: 120_000, note: "the feed last updated two minutes ago" }],
};
