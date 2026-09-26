import { z } from "zod";
import { sourceById, type MarketSource } from "./sources.js";
import type { ReadOnlyChainProvider } from "./rpc.js";
import type { MarketObservation, SnapshotSource } from "./snapshot.js";

/**
 * Historical replay.
 *
 * §P27.19–20. The requirement that does the work is the negative one:
 *
 *     Do not pretend current API data came from the historical block.
 *
 * A replay gathers from several sources, and they do not all support the same question. An archive
 * RPC answers "what was the state at block N". A price feed's aggregator answers it too, via
 * `getRoundData`. A REST endpoint returning "the current price" answers a different question
 * entirely, and putting its answer into a snapshot labelled with a past block is the failure this
 * module exists to prevent — not because it is dishonest by intent, but because the resulting
 * snapshot is indistinguishable from an honest one.
 *
 * So a source that cannot be pinned is either excluded, or included and marked
 * `NON_HISTORICAL_SOURCE` with the snapshot flagged as mixed-time. Never quietly included.
 */

export const REPLAY_POLICIES = ["EXCLUDE_NON_HISTORICAL", "ALLOW_MIXED_TIME"] as const;
export const ReplayPolicySchema = z.enum(REPLAY_POLICIES);
export type ReplayPolicy = z.infer<typeof ReplayPolicySchema>;

export const REPLAY_REASONS = {
  NO_EXACT_BLOCK: "REPLAY_REQUIRES_EXACT_BLOCK",
  NO_ARCHIVE: "REPLAY_PROVIDER_CANNOT_SERVE_HISTORICAL_STATE",
  MIXED_TIME_NOT_ALLOWED: "REPLAY_SOURCE_CANNOT_BE_PINNED",
  UNRESOLVABLE_TIMESTAMP: "REPLAY_TIMESTAMP_UNRESOLVABLE",
  BLOCK_NOT_FOUND: "REPLAY_BLOCK_NOT_FOUND",
} as const;
export type ReplayReason = (typeof REPLAY_REASONS)[keyof typeof REPLAY_REASONS];

export class ReplayError extends Error {
  constructor(readonly reason: ReplayReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ReplayError";
  }
}

export const ReplayTargetSchema = z.object({
  /** The exact block. Always resolved and persisted, never "roughly that date". */
  blockNumber: z.string().regex(/^\d+$/),
  blockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  blockTimestampMs: z.number().int().positive(),
  chainId: z.number().int().positive(),
  /** How the block was arrived at, so a reader can reproduce the choice. */
  resolvedFrom: z.enum(["EXPLICIT_BLOCK", "TIMESTAMP_SEARCH"]),
  requestedTimestampMs: z.number().int().positive().nullable(),
});
export type ReplayTarget = z.infer<typeof ReplayTargetSchema>;

/**
 * Resolve a timestamp to an exact block, deterministically.
 *
 * Binary search over block numbers, returning the last block at or before the target time. The
 * result is pinned and stored: §P27.19 forbids running a replay against "roughly that date" without
 * recording the exact state reference, because two runs of the same replay must describe the same
 * moment or the comparison between them means nothing.
 */
export async function resolveBlockForTimestamp(
  provider: ReadOnlyChainProvider,
  targetMs: number,
  bounds?: { lo: bigint; hi: bigint },
): Promise<ReplayTarget> {
  const hi0 = bounds?.hi ?? (await provider.getBlockNumber());
  let lo = bounds?.lo ?? 1n;
  let hi = hi0;

  const headBlock = await provider.getBlock(hi);
  if (Number(headBlock.timestamp) * 1000 < targetMs) {
    throw new ReplayError(
      REPLAY_REASONS.UNRESOLVABLE_TIMESTAMP,
      `${new Date(targetMs).toISOString()} is in the future for chain ${provider.chainId}; the head block ${hi} is ${new Date(Number(headBlock.timestamp) * 1000).toISOString()}`,
    );
  }

  let best = lo;
  while (lo <= hi) {
    const mid = lo + (hi - lo) / 2n;
    const block = await provider.getBlock(mid);
    const blockMs = Number(block.timestamp) * 1000;
    if (blockMs <= targetMs) {
      best = mid;
      lo = mid + 1n;
    } else {
      if (mid === 0n) break;
      hi = mid - 1n;
    }
  }

  const chosen = await provider.getBlock(best);
  return ReplayTargetSchema.parse({
    blockNumber: chosen.number.toString(),
    blockHash: chosen.hash.toLowerCase(),
    blockTimestampMs: Number(chosen.timestamp) * 1000,
    chainId: provider.chainId,
    resolvedFrom: "TIMESTAMP_SEARCH",
    requestedTimestampMs: targetMs,
  });
}

/** Pin an explicitly-given block, reading its hash so the reference is complete. */
export async function pinBlock(provider: ReadOnlyChainProvider, blockNumber: string): Promise<ReplayTarget> {
  if (!/^\d+$/.test(blockNumber)) {
    throw new ReplayError(
      REPLAY_REASONS.NO_EXACT_BLOCK,
      `"${blockNumber}" is not an exact block. A replay against "latest" describes a different moment every time it runs, so two runs cannot be compared.`,
    );
  }
  const block = await provider.getBlock(BigInt(blockNumber));
  return ReplayTargetSchema.parse({
    blockNumber: block.number.toString(),
    blockHash: block.hash.toLowerCase(),
    blockTimestampMs: Number(block.timestamp) * 1000,
    chainId: provider.chainId,
    resolvedFrom: "EXPLICIT_BLOCK",
    requestedTimestampMs: null,
  });
}

/* ───────────────────────────── source pinning ───────────────────────────── */

export interface ReplaySourcePlan {
  included: Array<{ source: MarketSource; timeSupport: "BLOCK_SCOPED" | "TIME_SCOPED" }>;
  /** Present only under ALLOW_MIXED_TIME, and always visible in the result. */
  mixedTime: MarketSource[];
  excluded: Array<{ sourceId: string; reason: string }>;
  mixedTimeSnapshot: boolean;
}

/**
 * Decide what a replay may read from.
 *
 * The two policies differ in what they do with an unpinnable source, and neither of them quietly
 * includes it. Under `EXCLUDE_NON_HISTORICAL` the snapshot is smaller and every value is from the
 * requested block. Under `ALLOW_MIXED_TIME` the value is included, marked, and the whole snapshot
 * is flagged — so a reader is told the picture spans two moments rather than discovering it.
 */
export function planReplaySources(sourceIds: ReadonlyArray<string>, policy: ReplayPolicy): ReplaySourcePlan {
  const included: ReplaySourcePlan["included"] = [];
  const mixedTime: MarketSource[] = [];
  const excluded: ReplaySourcePlan["excluded"] = [];

  for (const id of sourceIds) {
    const s = sourceById(id);
    if (!s) {
      excluded.push({ sourceId: id, reason: "not in the source registry" });
      continue;
    }
    if (s.lifecycle === "UNAVAILABLE" || s.lifecycle === "DEPRECATED") {
      excluded.push({ sourceId: id, reason: `lifecycle is ${s.lifecycle}` });
      continue;
    }
    if (s.historical) {
      included.push({ source: s, timeSupport: "BLOCK_SCOPED" });
      continue;
    }
    if (policy === "EXCLUDE_NON_HISTORICAL") {
      excluded.push({
        sourceId: id,
        reason: "cannot answer about a past block, and this replay excludes sources it cannot pin",
      });
      continue;
    }
    mixedTime.push(s);
  }

  return { included, mixedTime, excluded, mixedTimeSnapshot: mixedTime.length > 0 };
}

/** Refuse an unpinnable source where the policy does not allow one. */
export function assertSourcePinnable(source: MarketSource, policy: ReplayPolicy, context: string): void {
  if (source.historical) return;
  if (policy === "ALLOW_MIXED_TIME") return;
  throw new ReplayError(
    REPLAY_REASONS.MIXED_TIME_NOT_ALLOWED,
    `${context}: ${source.sourceId} cannot answer about a past block. Including its current value in a snapshot labelled with a historical block would produce a record that looks historical and is not.`,
  );
}

/**
 * Mark an observation that came from an unpinnable source.
 *
 * The mark travels on the observation itself rather than only on the snapshot, so a consumer
 * reading one value cannot lose the caveat by reading it out of context.
 */
export function markNonHistorical(o: MarketObservation, replayBlock: string): MarketObservation {
  return {
    ...o,
    blockNumber: null,
    provenance: `NON_HISTORICAL_SOURCE: ${o.provenance}. This value is CURRENT and is presented alongside state from block ${replayBlock}; it is not what this source said at that block.`,
  };
}

export function replaySourceDescriptor(s: MarketSource, target: ReplayTarget, pinned: boolean): SnapshotSource {
  return {
    sourceId: s.sourceId,
    kind: s.kind === "EXTERNAL_API" ? "EXTERNAL_API" : s.kind,
    adapterId: s.sourceId,
    adapterVersion: "1.0.0",
    trustClass: s.trustClass,
    sourceChainId: s.chainId,
    timeSupport: pinned ? "BLOCK_SCOPED" : "NON_HISTORICAL_SOURCE",
    observedBlock: pinned ? target.blockNumber : null,
    lagBlocks: null,
    healthy: true,
    detail: pinned ? `pinned to block ${target.blockNumber}` : "current value; this source cannot be pinned to a past block",
  };
}

/* ───────────────────────────── reproducibility ───────────────────────────── */

/**
 * Whether two replays of the same target describe the same thing.
 *
 * The snapshot ids and wall-clock retrieval times differ between runs and are not part of this
 * comparison; the block, the block hash and every pinned value are. §P27.24 asks for a reproducible
 * replay, and this is what "reproducible" means concretely — not that the objects are identical,
 * but that everything sourced from the pinned block is.
 */
export function replaysAgree(
  a: { target: ReplayTarget; observations: ReadonlyArray<MarketObservation> },
  b: { target: ReplayTarget; observations: ReadonlyArray<MarketObservation> },
): { agree: boolean; differences: string[] } {
  const differences: string[] = [];

  if (a.target.blockNumber !== b.target.blockNumber) differences.push(`block ${a.target.blockNumber} vs ${b.target.blockNumber}`);
  if (a.target.blockHash !== b.target.blockHash) differences.push(`block hash ${a.target.blockHash} vs ${b.target.blockHash}`);

  const pinnedA = new Map(a.observations.filter((o) => o.blockNumber !== null).map((o) => [o.metric, o]));
  const pinnedB = new Map(b.observations.filter((o) => o.blockNumber !== null).map((o) => [o.metric, o]));

  for (const [metric, oa] of pinnedA) {
    const ob = pinnedB.get(metric);
    if (!ob) {
      differences.push(`${metric} present in the first replay and absent from the second`);
      continue;
    }
    if (oa.value !== ob.value) differences.push(`${metric}: ${oa.value} vs ${ob.value}`);
    if (oa.blockNumber !== ob.blockNumber) differences.push(`${metric} block: ${oa.blockNumber} vs ${ob.blockNumber}`);
    if (oa.trustClass !== ob.trustClass) differences.push(`${metric} trust: ${oa.trustClass} vs ${ob.trustClass}`);
  }
  for (const metric of pinnedB.keys()) {
    if (!pinnedA.has(metric)) differences.push(`${metric} present in the second replay and absent from the first`);
  }

  return { agree: differences.length === 0, differences };
}

/* ───────────────────────────── curated events ───────────────────────────── */

/**
 * Curated replay descriptors.
 *
 * §P27.21 makes this optional for PASS and attaches a condition worth honouring: descriptors must
 * point at exact blocks and source evidence, not at unsourced stories. So this list is empty rather
 * than populated with plausible-sounding events whose block numbers nobody checked.
 *
 * An entry here requires a block number this project verified and a citation for what happened. The
 * type exists so adding one is easy; the array is empty because adding one honestly is work that
 * has not been done.
 */
export interface HistoricalEvent {
  eventId: string;
  name: string;
  chainId: number;
  blockNumber: string;
  blockHash: string;
  description: string;
  /** A URL or citation for the claim. Required — this is what stops it being a story. */
  evidence: string;
  verifiedBy: string;
}

export const CURATED_EVENTS: ReadonlyArray<HistoricalEvent> = [];
