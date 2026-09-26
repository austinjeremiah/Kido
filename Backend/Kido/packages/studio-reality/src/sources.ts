import { z } from "zod";
import { DataTrustClassSchema, satisfiesTrust, type DataTrustClass } from "@contextlock/studio-adapters";

/**
 * Market source lifecycle and selection.
 *
 * §P27.11 states the discipline plainly: **do not hard-code a feed based solely on current
 * availability.** A feed address that worked when it was pasted keeps working right up until it
 * does not, and the failure mode is not an error — it is a stale value returned confidently by a
 * contract nobody is updating any more.
 *
 * So every source carries lifecycle metadata, selection is a deterministic resolver over that
 * metadata, and a source approaching deprecation is loud rather than convenient.
 */

export const SOURCE_LIFECYCLE_STATES = [
  /** Verified live and supported. */
  "ACTIVE",
  /** Announced for retirement on a known date. Usable, and must warn. */
  "DEPRECATION_SCHEDULED",
  /** Retired. May still answer; must not be selected. */
  "DEPRECATED",
  /** Known to exist and not reachable right now. */
  "UNAVAILABLE",
  /**
   * We have not checked.
   *
   * Distinct from ACTIVE on purpose, and it is the default. "We never looked" and "we looked and it
   * is fine" are different facts, and collapsing them is how an unverified source acquires the
   * standing of a verified one.
   */
  "UNKNOWN",
] as const;
export const SourceLifecycleSchema = z.enum(SOURCE_LIFECYCLE_STATES);
export type SourceLifecycle = z.infer<typeof SourceLifecycleSchema>;

export const SOURCE_KINDS = ["CHAINLINK_DATA_FEED", "CHAINLINK_DATA_STREAM", "THE_GRAPH", "READ_ONLY_RPC", "EXTERNAL_API"] as const;
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const MarketSourceSchema = z.object({
  sourceId: z.string().min(1),
  kind: SourceKindSchema,
  /** The asset pair or subject, canonical ids rather than symbols. */
  subject: z.string().min(1),
  chainId: z.number().int().positive(),
  /** A feed's contract address, a stream's id, a subgraph's deployment id. */
  identity: z.string().min(1),
  trustClass: DataTrustClassSchema,
  /** How long a reading from this source stays meaningful. A feed's heartbeat, in ms. */
  heartbeatMs: z.number().int().positive(),
  decimals: z.number().int().min(0).max(36),
  lifecycle: SourceLifecycleSchema,
  /** ISO date. Required when the lifecycle says a retirement is scheduled. */
  deprecationDate: z.string().nullable(),
  /** The sourceId that replaces this one, when one is known. */
  replacedBy: z.string().nullable(),
  /** Whether it can answer about a specific past block. */
  historical: z.boolean(),
  /** Whether reading it needs a credential we may not have. */
  requiresAuth: z.boolean(),
  /** What established the above. Required, and checked for length. */
  verifiedBy: z.string().min(10),
  verifiedAt: z.string().min(4),
});
export type MarketSource = z.infer<typeof MarketSourceSchema>;

export const SOURCE_REASONS = {
  NO_COMPATIBLE: "NO_COMPATIBLE_MARKET_SOURCE",
  DEPRECATED: "MARKET_SOURCE_DEPRECATED",
  UNVERIFIED: "MARKET_SOURCE_LIFECYCLE_UNKNOWN",
  TRUST_NOT_MET: "MARKET_SOURCE_TRUST_INSUFFICIENT",
  FRESHNESS_NOT_MET: "MARKET_SOURCE_TOO_SLOW_FOR_POLICY",
  SILENT_MIGRATION: "MARKET_SOURCE_SILENT_MIGRATION_REFUSED",
  AUTH_MISSING: "MARKET_SOURCE_CREDENTIAL_MISSING",
} as const;
export type SourceReason = (typeof SOURCE_REASONS)[keyof typeof SOURCE_REASONS];

export class SourceError extends Error {
  constructor(readonly reason: SourceReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "SourceError";
  }
}

export const DATA_SOURCE_DEPRECATION_WARNING = "DATA_SOURCE_DEPRECATION_WARNING" as const;

export interface SourceWarning {
  code: typeof DATA_SOURCE_DEPRECATION_WARNING;
  sourceId: string;
  identity: string;
  effectiveDate: string | null;
  replacement: string | null;
  message: string;
}

/* ───────────────────────────── the registry ───────────────────────────── */

/**
 * Sources this project has actually checked, with the date it checked them.
 *
 * `verifiedAt` matters as much as `verifiedBy`: a lifecycle claim is a statement about a moment,
 * and a registry entry verified two years ago is `UNKNOWN` in every sense that counts. The
 * staleness of the verification itself is checked by `sourceVerificationAge`.
 */
const SOURCES: ReadonlyArray<MarketSource> = [
  {
    sourceId: "chainlink-feed-eth-usd-mainnet",
    kind: "CHAINLINK_DATA_FEED",
    subject: "weth/usd",
    chainId: 1,
    identity: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    trustClass: "VERIFIED_ORACLE",
    // The published mainnet ETH/USD aggregator heartbeat.
    heartbeatMs: 3_600_000,
    decimals: 8,
    lifecycle: "ACTIVE",
    deprecationDate: null,
    replacedBy: null,
    historical: true,
    requiresAuth: false,
    verifiedBy: "P27 live read: description() == \"ETH / USD\", decimals() == 8, latestRoundData() returned a round updated within the heartbeat",
    verifiedAt: "2026-09-10",
  },
  {
    sourceId: "mainnet-read-rpc",
    kind: "READ_ONLY_RPC",
    subject: "ethereum-mainnet:state",
    chainId: 1,
    identity: "ethereum-mainnet",
    trustClass: "DIRECT_CHAIN_DATA",
    heartbeatMs: 60_000,
    decimals: 0,
    lifecycle: "ACTIVE",
    deprecationDate: null,
    replacedBy: null,
    historical: true,
    requiresAuth: false,
    verifiedBy: "P27 live read: eth_blockNumber agreed across two independent providers at the same height",
    verifiedAt: "2026-09-10",
  },
  {
    sourceId: "aave-v3-mainnet-reserves",
    kind: "READ_ONLY_RPC",
    subject: "aave-v3:reserves",
    chainId: 1,
    identity: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    trustClass: "DIRECT_CHAIN_DATA",
    heartbeatMs: 60_000,
    decimals: 27,
    lifecycle: "ACTIVE",
    deprecationDate: null,
    replacedBy: null,
    historical: true,
    requiresAuth: false,
    verifiedBy: "P27 live read: getReserveData(WETH) on the Aave v3 mainnet Pool returned populated aToken/variableDebtToken addresses",
    verifiedAt: "2026-09-10",
  },
  {
    sourceId: "thegraph-uniswap-v3-mainnet",
    kind: "THE_GRAPH",
    subject: "uniswap-v3:history",
    chainId: 1,
    identity: "gateway.thegraph.com/api/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
    trustClass: "INDEXED_CHAIN_DATA",
    heartbeatMs: 300_000,
    decimals: 18,
    // ACTIVE describes the source; whether THIS backend may use it is `requiresAuth`, answered by
    // the capabilities probe. Without the key the source is still reported UNAVAILABLE (BLK-V2-GRAPH-KEY).
    lifecycle: "ACTIVE",
    deprecationDate: null,
    replacedBy: null,
    historical: true,
    requiresAuth: true,
    verifiedBy: "Live probe with THEGRAPH_API_KEY: the decentralised gateway answered `_meta` and `pool(id, block:{number})` for the USDC/WETH 0.05% pool at block 25963602 (deployment QmTZ8ejXJxRo7vDBS4uwqBeGoxLSWbhaA7oXa1RvxunLy7). Without the key it returns `auth error: missing authorization header` — BLK-V2-GRAPH-KEY",
    verifiedAt: "2026-09-12",
  },
];

const BY_ID = new Map(SOURCES.map((s) => [s.sourceId, s]));

export function marketSources(): ReadonlyArray<MarketSource> {
  return SOURCES;
}

export function sourceById(sourceId: string): MarketSource | null {
  return BY_ID.get(sourceId) ?? null;
}

/* ───────────────────────────── selection ───────────────────────────── */

export interface SourceRequirement {
  subject: string;
  chainId: number;
  requiredTrust: DataTrustClass;
  /** How old a reading this policy tolerates. A source whose heartbeat exceeds it cannot satisfy it. */
  maxAgeMs: number;
  historicalRequired?: boolean;
  /** Credentials the deployment actually holds. A source needing one we lack is unavailable. */
  availableCredentials?: ReadonlySet<string>;
}

export interface SourceSelection {
  source: MarketSource;
  warnings: SourceWarning[];
  /** Every source considered and why it lost. The audit answer to "why this one?". */
  rejected: Array<{ sourceId: string; reason: SourceReason; detail: string }>;
}

/**
 * Pick a source deterministically.
 *
 * §P27.13 warns against the specific temptation of choosing Data Streams because they sound newer.
 * Nothing here ranks by novelty: a source qualifies on subject, chain, trust, freshness, lifecycle
 * and credentials, and among qualifying sources the tie-break prefers the one that is ACTIVE and
 * then the one with the tighter heartbeat. A Data Feed that satisfies the policy wins over a Data
 * Stream that also satisfies it, because the Feed needs no credential and no additional
 * infrastructure — and "it satisfies the policy" is the whole question.
 */
export function selectSource(req: SourceRequirement): SourceSelection {
  return selectFrom(SOURCES, req);
}

/**
 * The resolver, over an explicit candidate list.
 *
 * Separated from `selectSource` so every lifecycle state can be exercised. The registry holds no
 * retired source today, which meant the `DEPRECATED` branch had nothing to test it — a mutation
 * deleting that branch escaped the entire suite. A guard whose input never occurs in production
 * data still has to be reachable from a test, or it is decoration.
 */
export function selectFrom(sources: ReadonlyArray<MarketSource>, req: SourceRequirement): SourceSelection {
  const rejected: SourceSelection["rejected"] = [];
  const warnings: SourceWarning[] = [];
  const candidates: MarketSource[] = [];

  for (const s of sources) {
    if (s.subject !== req.subject || s.chainId !== req.chainId) continue;

    if (s.lifecycle === "DEPRECATED") {
      rejected.push({ sourceId: s.sourceId, reason: SOURCE_REASONS.DEPRECATED, detail: `retired${s.deprecationDate ? ` on ${s.deprecationDate}` : ""}` });
      continue;
    }
    if (s.lifecycle === "UNKNOWN") {
      rejected.push({ sourceId: s.sourceId, reason: SOURCE_REASONS.UNVERIFIED, detail: "lifecycle never verified; an unchecked source is not an approved source" });
      continue;
    }
    if (s.lifecycle === "UNAVAILABLE") {
      rejected.push({ sourceId: s.sourceId, reason: SOURCE_REASONS.NO_COMPATIBLE, detail: `unavailable: ${s.verifiedBy}` });
      continue;
    }
    if (!satisfiesTrust(s.trustClass, req.requiredTrust)) {
      rejected.push({ sourceId: s.sourceId, reason: SOURCE_REASONS.TRUST_NOT_MET, detail: `offers ${s.trustClass}, policy requires ${req.requiredTrust}` });
      continue;
    }
    if (s.heartbeatMs > req.maxAgeMs) {
      rejected.push({
        sourceId: s.sourceId,
        reason: SOURCE_REASONS.FRESHNESS_NOT_MET,
        detail: `updates at most every ${Math.round(s.heartbeatMs / 1000)}s and the policy requires data no older than ${Math.round(req.maxAgeMs / 1000)}s`,
      });
      continue;
    }
    if (req.historicalRequired && !s.historical) {
      rejected.push({ sourceId: s.sourceId, reason: SOURCE_REASONS.NO_COMPATIBLE, detail: "cannot answer about a past block" });
      continue;
    }
    if (s.requiresAuth && !(req.availableCredentials?.has(s.sourceId) ?? false)) {
      rejected.push({ sourceId: s.sourceId, reason: SOURCE_REASONS.AUTH_MISSING, detail: "needs a credential this deployment does not hold" });
      continue;
    }
    candidates.push(s);
  }

  if (candidates.length === 0) {
    throw new SourceError(
      SOURCE_REASONS.NO_COMPATIBLE,
      `no source can supply ${req.subject} on chain ${req.chainId} at ${req.requiredTrust} within ${Math.round(req.maxAgeMs / 1000)}s. Considered: ${
        // The detail, not only the reason code: "deprecated" is less useful than "retired on
        // 2026-01-01", and this message is what an operator sees when a build stops.
        rejected.map((r) => `${r.sourceId} (${r.reason}: ${r.detail})`).join("; ") || "nothing with that subject"
      }. Downgrading trust silently is not an option this resolver has.`,
    );
  }

  candidates.sort((a, b) => {
    // ACTIVE before DEPRECATION_SCHEDULED. §P27.12: prefer a supported alternative for new builds.
    if (a.lifecycle !== b.lifecycle) return a.lifecycle === "ACTIVE" ? -1 : 1;
    // Then the source that updates more often.
    if (a.heartbeatMs !== b.heartbeatMs) return a.heartbeatMs - b.heartbeatMs;
    return a.sourceId.localeCompare(b.sourceId);
  });

  const chosen = candidates[0] as MarketSource;
  for (const c of candidates) {
    if (c.lifecycle === "DEPRECATION_SCHEDULED") warnings.push(deprecationWarning(c));
  }
  return { source: chosen, warnings, rejected };
}

export function deprecationWarning(s: MarketSource): SourceWarning {
  return {
    code: DATA_SOURCE_DEPRECATION_WARNING,
    sourceId: s.sourceId,
    identity: s.identity,
    effectiveDate: s.deprecationDate,
    replacement: s.replacedBy,
    message: `${s.sourceId} (${s.identity}) is scheduled for deprecation${s.deprecationDate ? ` on ${s.deprecationDate}` : ""}. ${
      s.replacedBy ? `A replacement is known: ${s.replacedBy}.` : "No replacement is recorded."
    } Existing projects keep working and are warned; new builds prefer a supported source.`,
  };
}

/**
 * Refuse to move an approved strategy onto a different source without revalidation.
 *
 * §P27.45: **do not auto-migrate an already approved strategy.** The migration may well be correct,
 * and it still changes what the approval was granted against — a different feed is a different
 * trust claim, a different heartbeat and a different failure mode. Someone re-approves, or nothing
 * moves.
 */
export function assertNoSilentMigration(
  approvedSourceId: string,
  proposedSourceId: string,
  revalidated: boolean,
): void {
  if (approvedSourceId === proposedSourceId) return;
  if (revalidated) return;
  const from = BY_ID.get(approvedSourceId);
  const to = BY_ID.get(proposedSourceId);
  throw new SourceError(
    SOURCE_REASONS.SILENT_MIGRATION,
    `this deployment was approved against ${approvedSourceId}${from ? ` (${from.trustClass}, ${Math.round(from.heartbeatMs / 1000)}s heartbeat)` : ""} and would now read ${proposedSourceId}${
      to ? ` (${to.trustClass}, ${Math.round(to.heartbeatMs / 1000)}s heartbeat)` : ""
    }. A source change alters the trust and freshness the approval was granted against, so it needs a new review rather than a restart.`,
  );
}

/**
 * How long ago a source's lifecycle was actually checked.
 *
 * A lifecycle field is a claim with a date on it. This is what lets a report say "verified 3 days
 * ago" instead of "ACTIVE", which are different statements.
 */
export function sourceVerificationAgeDays(s: MarketSource, nowIso: string): number {
  const then = Date.parse(`${s.verifiedAt}T00:00:00Z`);
  const now = Date.parse(nowIso.length === 10 ? `${nowIso}T00:00:00Z` : nowIso);
  return Math.max(0, Math.round((now - then) / 86_400_000));
}

/* ───────────────────────────── disagreement ───────────────────────────── */

export interface Disagreement {
  metric: string;
  readings: Array<{ sourceId: string; value: string; decimals: number; trustClass: DataTrustClass }>;
  /** Basis points between the highest and lowest reading. */
  spreadBps: number;
  disagrees: boolean;
  /** The reading policy should use, chosen by trust — never an average. */
  authoritative: { sourceId: string; value: string; decimals: number; trustClass: DataTrustClass };
}

/**
 * Compare readings of the same metric from different sources.
 *
 * §P27.44 forbids the tempting move: **do not average them.** An average of a verified oracle
 * reading and an indexer's reading is a number no source stands behind, with the trust class of
 * neither — it is strictly worse than either input, because at least the inputs are attributable.
 *
 * So both are kept, the spread is measured, and the highest-trust reading is marked authoritative.
 * What to DO about a disagreement is the Blueprint's decision — warn, escalate or deny — and this
 * function deliberately does not make it.
 */
export function compareReadings(
  metric: string,
  readings: ReadonlyArray<{ sourceId: string; value: string; decimals: number; trustClass: DataTrustClass }>,
  toleranceBps: number,
): Disagreement {
  if (readings.length === 0) throw new SourceError(SOURCE_REASONS.NO_COMPATIBLE, `no readings for ${metric}`);

  // Normalize to a common scale before comparing; two values with different decimals are not
  // comparable as integers, and comparing them anyway is its own class of bug.
  const maxDecimals = Math.max(...readings.map((r) => r.decimals));
  const scaled = readings.map((r) => ({ ...r, scaled: BigInt(r.value) * 10n ** BigInt(maxDecimals - r.decimals) }));

  const values = scaled.map((r) => r.scaled);
  const min = values.reduce((a, b) => (b < a ? b : a));
  const max = values.reduce((a, b) => (b > a ? b : a));

  const spreadBps = min === 0n ? (max === 0n ? 0 : Number.MAX_SAFE_INTEGER) : Number(((max - min) * 10_000n) / (min < 0n ? -min : min));

  const byTrust = [...readings].sort((a, b) => {
    const rank = (t: DataTrustClass): number => (satisfiesTrust(t, "VERIFIED_ORACLE") ? 2 : satisfiesTrust(t, "INDEXED_CHAIN_DATA") ? 1 : 0);
    return rank(b.trustClass) - rank(a.trustClass);
  });

  return {
    metric,
    readings: [...readings],
    spreadBps,
    disagrees: spreadBps > toleranceBps,
    authoritative: byTrust[0] as Disagreement["authoritative"],
  };
}

/**
 * Refuse a lower-trust substitute unless it was explicitly authorized.
 *
 * §P27.43: if the Chainlink reading fails and the Blueprint requires a verified oracle, The Graph's
 * number is not a fallback — it is a different claim wearing the same units. Falling back is
 * allowed, and only when someone said so in advance.
 */
export function assertFallbackAuthorized(
  required: DataTrustClass,
  fallbackTrust: DataTrustClass,
  fallbackAuthorized: boolean,
  context: string,
): void {
  if (satisfiesTrust(fallbackTrust, required)) return;
  if (fallbackAuthorized) return;
  throw new SourceError(
    SOURCE_REASONS.TRUST_NOT_MET,
    `${context}: the policy requires ${required} and the available substitute offers ${fallbackTrust}. A lower-trust value is not a degraded version of a higher-trust one; it answers a different question. Authorize the fallback explicitly in the Blueprint or fail closed.`,
  );
}

/**
 * When a reading from this source stops being current.
 *
 * A feed with an hourly heartbeat is *specified* to update at most once an hour, so a reading
 * 59 minutes old is a healthy feed, not a stale one. The grace factor covers the gap between the
 * heartbeat and the moment the next update actually lands — a feed that has missed its heartbeat
 * by half again is genuinely late.
 *
 * Calling every source stale against one global limit was the first thing that went wrong when this
 * ran against live mainnet: a correctly-behaving Chainlink aggregator was reported as a problem
 * because it sat beside per-block RPC reads.
 */
export const STALENESS_GRACE_FACTOR = 1.5;

export function stalenessThresholdMs(s: MarketSource, graceFactor: number = STALENESS_GRACE_FACTOR): number {
  return Math.round(s.heartbeatMs * graceFactor);
}

/** Per-source age limits for `sealSnapshot`, built from the registry's declared heartbeats. */
export function sourceAgeLimits(sourceIds: ReadonlyArray<string>, graceFactor: number = STALENESS_GRACE_FACTOR): Map<string, number> {
  const map = new Map<string, number>();
  for (const id of sourceIds) {
    const s = BY_ID.get(id);
    if (s) map.set(id, stalenessThresholdMs(s, graceFactor));
  }
  return map;
}
