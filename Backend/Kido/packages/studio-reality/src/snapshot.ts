import { createHash } from "node:crypto";
import { z } from "zod";
import { DataTrustClassSchema, type DataTrustClass } from "@contextlock/studio-adapters";

/**
 * The market snapshot: what the world looked like, according to whom, and when.
 *
 * §P27.47 asks that every evaluation be able to answer seven questions — what state was seen, from
 * where, at what block, how fresh, at what trust, what was synthetic, and where execution actually
 * happened. A snapshot is the data structure that makes those answerable, which is why it carries
 * so much more than the numbers a strategy consumes.
 *
 * Two properties do the work:
 *
 * **Immutable.** There is no setter and no in-place correction. A correction produces a NEW
 * snapshot with a new hash and a `supersedes` pointer, because a mutable record of what was
 * believed at decision time cannot be used to audit the decision.
 *
 * **Hashed over everything security-relevant.** If a price, a block, a source, a trust class, an
 * asset identity, a timestamp or an adapter version changes, the hash changes. That is what lets a
 * `ShadowDecision` cite a snapshot by hash and mean it.
 */

export const SNAPSHOT_SCHEMA_VERSION = "contextlock.market-snapshot/v1" as const;

export const REALITY_MODES = ["LIVE_MIRROR", "HISTORICAL_REPLAY", "LOCAL_FORK"] as const;
export const RealityModeSchema = z.enum(REALITY_MODES);
export type RealityMode = z.infer<typeof RealityModeSchema>;

/** Whether a source can answer a question about a specific past block. */
export const SOURCE_TIME_SUPPORT = ["BLOCK_SCOPED", "TIME_SCOPED", "NON_HISTORICAL_SOURCE"] as const;
export const SourceTimeSupportSchema = z.enum(SOURCE_TIME_SUPPORT);
export type SourceTimeSupport = z.infer<typeof SourceTimeSupportSchema>;

export const SNAPSHOT_STATES = ["FRESH", "STALE", "INCOHERENT", "INCOMPLETE"] as const;
export const SnapshotStateSchema = z.enum(SNAPSHOT_STATES);
export type SnapshotState = z.infer<typeof SnapshotStateSchema>;

/* ───────────────────────────── sources ───────────────────────────── */

export const SnapshotSourceSchema = z.object({
  sourceId: z.string().min(1),
  kind: z.enum(["CHAINLINK_DATA_FEED", "CHAINLINK_DATA_STREAM", "THE_GRAPH", "READ_ONLY_RPC", "LOCAL_FORK_RPC", "EXTERNAL_API"]),
  adapterId: z.string().min(1),
  adapterVersion: z.string().min(1),
  trustClass: DataTrustClassSchema,
  /** The chain this source describes. For a subgraph, the chain it indexes. */
  sourceChainId: z.number().int().positive(),
  timeSupport: SourceTimeSupportSchema,
  /** The block this source's data reflects, where it can say. */
  observedBlock: z.string().regex(/^\d+$/).nullable(),
  /** For an indexer: how far behind the head it was. */
  lagBlocks: z.number().int().nonnegative().nullable(),
  healthy: z.boolean(),
  detail: z.string().nullable(),
});
export type SnapshotSource = z.infer<typeof SnapshotSourceSchema>;

/* ───────────────────────────── observations ───────────────────────────── */

/**
 * One measured fact.
 *
 * §P27.7 is explicit that observations must not collapse to primitive numbers too early, and the
 * reason is the trust model: `2434.42` from a Chainlink feed and `2434.42` from a subgraph are the
 * same double and are not the same claim. Once a value has been unwrapped to a number, the
 * information needed to refuse it is gone.
 *
 * `value` is a decimal STRING with an explicit `decimals`, not a float. A price with eight decimals
 * of precision does not survive IEEE-754 intact, and the whole point of a verified oracle reading
 * is that it is exact.
 */
export const ObservationSchema = z.object({
  observationId: z.string().min(1),
  /** What is being measured. `weth/usd:price`, `aave-v3:weth:liquidityIndex`. */
  metric: z.string().min(1),
  /** Raw integer value as a string, scaled by `decimals`. */
  value: z.string().regex(/^-?\d+$/),
  decimals: z.number().int().min(0).max(36),
  unit: z.string().min(1),
  dataType: z.enum(["PRICE", "RATE", "AMOUNT", "RATIO", "BPS", "TIMESTAMP", "COUNT", "HEALTH_FACTOR"]),
  canonicalAssetId: z.string().nullable(),
  sourceId: z.string().min(1),
  sourceChainId: z.number().int().positive(),
  blockNumber: z.string().regex(/^\d+$/).nullable(),
  /** When the SOURCE says the value was true. A feed's `updatedAt`, not our clock. */
  sourceTimestampMs: z.number().int().nonnegative().nullable(),
  /** When WE fetched it. The two differ, and the difference is the freshness that matters. */
  retrievedAtMs: z.number().int().positive(),
  trustClass: DataTrustClassSchema,
  adapterId: z.string().min(1),
  adapterVersion: z.string().min(1),
  /** Set when the value is not measured but derived — a scenario overlay, a computed ratio. */
  derivedFrom: z.string().nullable(),
  provenance: z.string().min(1),
});
export type MarketObservation = z.infer<typeof ObservationSchema>;

/* ───────────────────────────── coherence ───────────────────────────── */

export const CoherenceSchema = z.object({
  oldestObservationMs: z.number().int().nonnegative(),
  newestObservationMs: z.number().int().nonnegative(),
  maxTimeSkewMs: z.number().int().nonnegative(),
  /** Only across sources that report a block on the same chain; null when incomparable. */
  maxBlockSkew: z.number().int().nonnegative().nullable(),
  staleSources: z.array(z.string()),
  incomparableSources: z.array(z.string()),
  coherent: z.boolean(),
  reason: z.string().nullable(),
});
export type SnapshotCoherence = z.infer<typeof CoherenceSchema>;

/* ───────────────────────────── the snapshot ───────────────────────────── */

export const MarketSnapshotSchema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  mode: RealityModeSchema,
  observedAtMs: z.number().int().positive(),
  /** The chain whose block number anchors this snapshot in time. */
  anchorChainId: z.number().int().positive(),
  anchorBlock: z.string().regex(/^\d+$/),
  anchorBlockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  anchorBlockTimestampMs: z.number().int().positive(),
  sources: z.array(SnapshotSourceSchema).min(1),
  observations: z.array(ObservationSchema),
  canonicalAssetIds: z.array(z.string()),
  coherence: CoherenceSchema,
  provenance: z.array(z.string()).min(1),
  /** Set on a correction. The superseded snapshot is not modified. */
  supersedes: z.string().nullable(),
  snapshotHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const SNAPSHOT_REASONS = {
  IMMUTABLE: "MARKET_SNAPSHOT_IS_IMMUTABLE",
  STALE: "MARKET_SNAPSHOT_STALE",
  NO_VALID_CONTEXT: "NO_VALID_CONTEXT",
  INCOHERENT: "MARKET_SNAPSHOT_INCOHERENT",
  HASH_MISMATCH: "MARKET_SNAPSHOT_HASH_MISMATCH",
} as const;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[keyof typeof SNAPSHOT_REASONS];

export class SnapshotError extends Error {
  constructor(readonly reason: SnapshotReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "SnapshotError";
  }
}

/* ───────────────────────────── the hash ───────────────────────────── */

/**
 * Fields that are part of the snapshot's identity.
 *
 * Enumerated rather than "everything except the hash", because the difference between those two is
 * exactly where this kind of bug lives. A field added to the schema and not added here would be
 * silently outside the hash — so `REALITY-003c` cross-checks these lists against the schema's own
 * keys and fails when they diverge, which turns "remember to update the hash" into a test failure.
 */
const HASHED_OBSERVATION_FIELDS = [
  "observationId", "metric", "value", "decimals", "unit", "dataType", "canonicalAssetId",
  "sourceId", "sourceChainId", "blockNumber", "sourceTimestampMs", "retrievedAtMs",
  "trustClass", "adapterId", "adapterVersion", "derivedFrom", "provenance",
] as const;

const HASHED_SOURCE_FIELDS = [
  "sourceId", "kind", "adapterId", "adapterVersion", "trustClass", "sourceChainId",
  "timeSupport", "observedBlock", "lagBlocks", "healthy",
] as const;

/** Exported so a test can compare them against the schema rather than trusting this comment. */
export const HASHED_FIELDS = {
  observation: HASHED_OBSERVATION_FIELDS,
  source: HASHED_SOURCE_FIELDS,
} as const;

/**
 * Fields deliberately outside the hash, with the reason.
 *
 * `detail` is human prose that a provider may reword; `reason` and the derived coherence bounds are
 * computed FROM hashed inputs, so including them would be hashing the same facts twice. Everything
 * else is inside.
 */
export const UNHASHED_FIELDS = {
  source: ["detail"],
  coherence: ["oldestObservationMs", "newestObservationMs", "incomparableSources", "reason"],
  snapshot: ["snapshotHash", "provenance"],
} as const;

/**
 * Canonical serialization.
 *
 * Keys in a fixed order, arrays sorted by their identifier, `null` preserved. JSON key order is
 * insertion order in practice, so two structurally identical snapshots built by different code
 * paths would otherwise hash differently — making the hash a measure of how the object was
 * constructed rather than of what it says.
 */
export function canonicalSnapshotBody(snapshot: Omit<MarketSnapshot, "snapshotHash">): string {
  const sources = [...snapshot.sources]
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
    .map((s) => HASHED_SOURCE_FIELDS.map((f) => `${f}=${JSON.stringify(s[f])}`).join("|"));

  const observations = [...snapshot.observations]
    .sort((a, b) => a.observationId.localeCompare(b.observationId))
    .map((o) => HASHED_OBSERVATION_FIELDS.map((f) => `${f}=${JSON.stringify(o[f])}`).join("|"));

  return [
    `schemaVersion=${snapshot.schemaVersion}`,
    `snapshotId=${snapshot.snapshotId}`,
    `mode=${snapshot.mode}`,
    `observedAtMs=${snapshot.observedAtMs}`,
    `anchorChainId=${snapshot.anchorChainId}`,
    `anchorBlock=${snapshot.anchorBlock}`,
    `anchorBlockHash=${snapshot.anchorBlockHash}`,
    `anchorBlockTimestampMs=${snapshot.anchorBlockTimestampMs}`,
    `supersedes=${JSON.stringify(snapshot.supersedes)}`,
    `canonicalAssetIds=${[...snapshot.canonicalAssetIds].sort().join(",")}`,
    `coherenceMaxTimeSkewMs=${snapshot.coherence.maxTimeSkewMs}`,
    `coherenceMaxBlockSkew=${JSON.stringify(snapshot.coherence.maxBlockSkew)}`,
    `coherenceStaleSources=${[...snapshot.coherence.staleSources].sort().join(",")}`,
    `coherenceCoherent=${snapshot.coherence.coherent}`,
    `sources=[${sources.join(";")}]`,
    `observations=[${observations.join(";")}]`,
  ].join("&");
}

export function computeSnapshotHash(snapshot: Omit<MarketSnapshot, "snapshotHash">): string {
  return `sha256:${createHash("sha256").update(canonicalSnapshotBody(snapshot), "utf8").digest("hex")}`;
}

/** Recompute and compare. A snapshot whose hash does not match its body is not evidence. */
export function verifySnapshotHash(snapshot: MarketSnapshot): void {
  const { snapshotHash: _ignored, ...body } = snapshot;
  const recomputed = computeSnapshotHash(body);
  if (recomputed !== snapshot.snapshotHash) {
    throw new SnapshotError(
      SNAPSHOT_REASONS.HASH_MISMATCH,
      `${snapshot.snapshotId} carries ${snapshot.snapshotHash} and its contents hash to ${recomputed}. Something changed after it was sealed.`,
    );
  }
}

/* ───────────────────────────── construction ───────────────────────────── */

/**
 * Compute coherence from the observations themselves.
 *
 * §P27.9 puts the trap plainly: **do not call a snapshot coherent merely because all requests
 * succeeded.** Five sources that each answered instantly, describing five different moments, is
 * five successes and one incoherent picture. So this measures skew rather than counting failures.
 */
export function computeCoherence(
  observations: ReadonlyArray<MarketObservation>,
  sources: ReadonlyArray<SnapshotSource>,
  opts: {
    maxTimeSkewMs: number;
    anchorChainId: number;
    nowMs: number;
    /** The fallback age limit, for a source with no declared heartbeat. */
    maxSourceAgeMs: number;
    /**
     * Per-source age limits, keyed by sourceId.
     *
     * A single global limit is wrong for a heterogeneous snapshot and was wrong the first time this
     * ran against live data: an hourly Chainlink feed sitting beside per-block RPC reads was marked
     * stale for behaving exactly as specified. A source is stale when it is older than ITS OWN
     * update contract, so the threshold comes from the source's heartbeat.
     */
    sourceMaxAgeMs?: ReadonlyMap<string, number>;
  },
): SnapshotCoherence {
  if (observations.length === 0) {
    return {
      oldestObservationMs: 0, newestObservationMs: 0, maxTimeSkewMs: 0, maxBlockSkew: null,
      staleSources: [], incomparableSources: sources.map((s) => s.sourceId),
      coherent: false, reason: "the snapshot contains no observations",
    };
  }

  // The source's own timestamp where it has one, our retrieval time where it does not — using our
  // clock for a value the source timestamped would understate the skew.
  const times = observations.map((o) => o.sourceTimestampMs ?? o.retrievedAtMs);
  const oldest = Math.min(...times);
  const newest = Math.max(...times);
  const skew = newest - oldest;

  // Blocks are only comparable on the same chain. A Sepolia block number and a mainnet block number
  // are both integers and their difference means nothing.
  const comparable = sources.filter((s) => s.sourceChainId === opts.anchorChainId && s.observedBlock !== null);
  const incomparable = sources
    .filter((s) => s.sourceChainId !== opts.anchorChainId || s.observedBlock === null)
    .map((s) => s.sourceId);
  let blockSkew: number | null = null;
  if (comparable.length > 1) {
    const blocks = comparable.map((s) => Number(s.observedBlock));
    blockSkew = Math.max(...blocks) - Math.min(...blocks);
  }

  const stale = observations
    .filter((o) => {
      const limit = opts.sourceMaxAgeMs?.get(o.sourceId) ?? opts.maxSourceAgeMs;
      return opts.nowMs - (o.sourceTimestampMs ?? o.retrievedAtMs) > limit;
    })
    .map((o) => o.sourceId);
  const staleSources = [...new Set(stale)].sort();
  const unhealthy = sources.filter((s) => !s.healthy).map((s) => s.sourceId);

  const problems: string[] = [];
  if (skew > opts.maxTimeSkewMs) {
    problems.push(`observations span ${Math.round(skew / 1000)}s, more than the ${Math.round(opts.maxTimeSkewMs / 1000)}s this snapshot allows`);
  }
  if (staleSources.length > 0) problems.push(`stale sources: ${staleSources.join(", ")}`);
  if (unhealthy.length > 0) problems.push(`unhealthy sources: ${unhealthy.join(", ")}`);

  return {
    oldestObservationMs: oldest,
    newestObservationMs: newest,
    maxTimeSkewMs: skew,
    maxBlockSkew: blockSkew,
    staleSources,
    incomparableSources: incomparable,
    coherent: problems.length === 0,
    reason: problems.length > 0 ? problems.join("; ") : null,
  };
}

export interface SnapshotInput {
  snapshotId: string;
  mode: RealityMode;
  observedAtMs: number;
  anchorChainId: number;
  anchorBlock: string;
  anchorBlockHash: string;
  anchorBlockTimestampMs: number;
  sources: ReadonlyArray<SnapshotSource>;
  observations: ReadonlyArray<MarketObservation>;
  provenance: ReadonlyArray<string>;
  supersedes?: string | null;
  maxTimeSkewMs?: number;
  maxSourceAgeMs?: number;
  /** Per-source age limits, from each source's own heartbeat. See `computeCoherence`. */
  sourceMaxAgeMs?: ReadonlyMap<string, number>;
  nowMs?: number;
}

/**
 * Seal a snapshot.
 *
 * Returns a deeply frozen object. `Object.freeze` is shallow, so each array and nested object is
 * frozen individually — the goal is that a caller holding a snapshot cannot alter what a decision
 * cited, and freezing makes the attempt throw in strict mode rather than silently succeed.
 */
export function sealSnapshot(input: SnapshotInput): MarketSnapshot {
  const nowMs = input.nowMs ?? input.observedAtMs;
  const coherence = computeCoherence(input.observations, input.sources, {
    maxTimeSkewMs: input.maxTimeSkewMs ?? 60_000,
    maxSourceAgeMs: input.maxSourceAgeMs ?? 3_600_000,
    ...(input.sourceMaxAgeMs ? { sourceMaxAgeMs: input.sourceMaxAgeMs } : {}),
    anchorChainId: input.anchorChainId,
    nowMs,
  });

  const canonicalAssetIds = [
    ...new Set(input.observations.map((o) => o.canonicalAssetId).filter((a): a is string => a !== null)),
  ].sort();

  const body: Omit<MarketSnapshot, "snapshotHash"> = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: input.snapshotId,
    mode: input.mode,
    observedAtMs: input.observedAtMs,
    anchorChainId: input.anchorChainId,
    anchorBlock: input.anchorBlock,
    anchorBlockHash: input.anchorBlockHash,
    anchorBlockTimestampMs: input.anchorBlockTimestampMs,
    sources: input.sources.map((s) => Object.freeze({ ...s })),
    observations: input.observations.map((o) => Object.freeze({ ...o })),
    canonicalAssetIds,
    coherence,
    provenance: [...input.provenance],
    supersedes: input.supersedes ?? null,
  };

  const snapshot: MarketSnapshot = { ...body, snapshotHash: computeSnapshotHash(body) };
  MarketSnapshotSchema.parse(snapshot);

  Object.freeze(snapshot.sources);
  Object.freeze(snapshot.observations);
  Object.freeze(snapshot.provenance);
  Object.freeze(snapshot.canonicalAssetIds);
  Object.freeze(snapshot.coherence);
  return Object.freeze(snapshot);
}

/**
 * Correct a snapshot by producing a new one.
 *
 * The only supported way to change anything. The original is untouched and still hashes to what a
 * decision cited, which is the property that makes the audit trail worth having.
 */
export function correctSnapshot(original: MarketSnapshot, changes: Partial<SnapshotInput>, newId: string): MarketSnapshot {
  return sealSnapshot({
    snapshotId: newId,
    mode: original.mode,
    observedAtMs: original.observedAtMs,
    anchorChainId: original.anchorChainId,
    anchorBlock: original.anchorBlock,
    anchorBlockHash: original.anchorBlockHash,
    anchorBlockTimestampMs: original.anchorBlockTimestampMs,
    sources: original.sources,
    observations: original.observations,
    provenance: [...original.provenance, `corrects ${original.snapshotId} (${original.snapshotHash})`],
    ...changes,
    supersedes: original.snapshotId,
  });
}

/* ───────────────────────────── freshness ───────────────────────────── */

/**
 * Whether a snapshot may still authorize a new action.
 *
 * §P27.42: once a snapshot exceeds the strategy's freshness threshold, a running Shadow Agent must
 * not keep authorizing on it. The answer is a state rather than a boolean so the caller cannot
 * treat "stale" and "incoherent" as the same problem — one is fixed by refreshing and the other
 * is not.
 */
export function snapshotState(
  snapshot: MarketSnapshot,
  nowMs: number,
  maxAgeMs: number,
): { state: SnapshotState; ageMs: number; reason: string | null } {
  const ageMs = nowMs - snapshot.observedAtMs;
  if (ageMs > maxAgeMs) {
    return {
      state: "STALE",
      ageMs,
      reason: `the snapshot is ${Math.round(ageMs / 1000)}s old and this strategy requires context no older than ${Math.round(maxAgeMs / 1000)}s`,
    };
  }
  if (snapshot.observations.length === 0) {
    return { state: "INCOMPLETE", ageMs, reason: "no observations" };
  }
  if (!snapshot.coherence.coherent) {
    return { state: "INCOHERENT", ageMs, reason: snapshot.coherence.reason };
  }
  return { state: "FRESH", ageMs, reason: null };
}

/** Refuse to act on a snapshot that is not fresh. Throws `NO_VALID_CONTEXT`, per §P27.42. */
export function assertSnapshotUsable(snapshot: MarketSnapshot, nowMs: number, maxAgeMs: number, context: string): void {
  const s = snapshotState(snapshot, nowMs, maxAgeMs);
  if (s.state !== "FRESH") {
    throw new SnapshotError(
      SNAPSHOT_REASONS.NO_VALID_CONTEXT,
      `${context}: snapshot ${snapshot.snapshotId} is ${s.state} — ${s.reason}. Refresh it or stop; continuing would authorize an action against a world that has moved.`,
    );
  }
}

export type { DataTrustClass };
