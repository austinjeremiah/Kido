import { z } from "zod";
import { lookupNetwork, networkLabel, type NetworkRole } from "@contextlock/studio-network";
import { marketSources, type ArchiveDepth } from "@contextlock/studio-reality";

/**
 * The Reality selector, and the degraded states it must show honestly.
 *
 * §P28.8 attaches a requirement that is easy to agree with and easy to violate:
 *
 *     Do not hide disabled options. Explain them.
 *
 * The failure being prevented is not deception. It is the ordinary product instinct to hide what
 * does not work, which here removes the user's only signal that a capability exists at all — and
 * leaves them believing the three modes they can see are the three modes there are. Worse, a hidden
 * option cannot carry the reason it is unavailable, so nobody ever fixes it.
 *
 * So availability is computed from real capability and every mode is returned, including the
 * unavailable ones, each carrying its reason and its blocker id.
 */

export const REALITY_UX_MODES = ["LIVE_MAINNET_MIRROR", "HISTORICAL_REPLAY", "LOCAL_MAINNET_FORK", "SYNTHETIC"] as const;
export const RealityUxModeSchema = z.enum(REALITY_UX_MODES);
export type RealityUxMode = z.infer<typeof RealityUxModeSchema>;

export const AVAILABILITY = ["AVAILABLE", "LIMITED", "BLOCKED"] as const;
export const AvailabilitySchema = z.enum(AVAILABILITY);
export type Availability = z.infer<typeof AvailabilitySchema>;

export const RealityModeOptionSchema = z.object({
  mode: RealityUxModeSchema,
  label: z.string().min(1),
  availability: AvailabilitySchema,
  /** Required whenever availability is not AVAILABLE. An unavailable option with no reason is a dead end. */
  reason: z.string().nullable(),
  blocker: z.string().nullable(),
  /** What the user can do about it, when anything. */
  remedy: z.string().nullable(),
  /** What is lost by not having it. Stated, so the trade-off is visible. */
  effect: z.string().nullable(),
});
export type RealityModeOption = z.infer<typeof RealityModeOptionSchema>;

export interface RealityCapabilities {
  /** A mainnet read endpoint is configured and answered. */
  mainnetReadAvailable: boolean;
  /** Declared depth of the configured historical endpoint. */
  archiveDepth: ArchiveDepth | null;
  /** Anvil is installed and a fork can be started. */
  forkAvailable: boolean;
  /** Credentials this deployment actually holds, by sourceId. */
  availableCredentials: ReadonlySet<string>;
}

/**
 * Availability, computed rather than configured.
 *
 * Each answer traces to something checkable: an endpoint that answered, a declared archive depth, a
 * binary on the path, a credential that exists. `LAB-048` asserts none of these can report
 * `AVAILABLE` from a stored flag.
 */
export function realityModes(caps: RealityCapabilities): RealityModeOption[] {
  const graph = marketSources().find((s) => s.kind === "THE_GRAPH");
  const graphUsable = graph !== undefined && graph.lifecycle === "ACTIVE" && (!graph.requiresAuth || caps.availableCredentials.has(graph.sourceId));

  const options: RealityModeOption[] = [];

  options.push(
    caps.mainnetReadAvailable
      ? {
          mode: "LIVE_MAINNET_MIRROR",
          label: "Live Mainnet Mirror",
          availability: graphUsable ? "AVAILABLE" : "AVAILABLE",
          reason: graphUsable ? null : "Indexed history from The Graph is not included",
          blocker: graphUsable ? null : "BLK-V2-GRAPH-KEY",
          remedy: graphUsable ? null : "Configure a The Graph API key through the credential boundary",
          effect: graphUsable ? null : "Chainlink verified data and direct protocol state are included; indexed historical context is not, and nothing was substituted for it",
        }
      : {
          mode: "LIVE_MAINNET_MIRROR",
          label: "Live Mainnet Mirror",
          availability: "BLOCKED",
          reason: "No mainnet read endpoint answered",
          blocker: null,
          remedy: "Configure a mainnet read RPC",
          effect: "No live market context is available",
        },
  );

  /*
   * Historical replay depends on a property of the endpoint, not on whether an endpoint exists.
   *
   * `UNKNOWN` is LIMITED rather than AVAILABLE, on the same reasoning as the source lifecycle's
   * UNKNOWN: an endpoint whose depth nobody established cannot produce evidence-grade replay,
   * because the result would be a statement about the provider as much as about the chain.
   */
  if (caps.archiveDepth === "ARCHIVE") {
    options.push({
      mode: "HISTORICAL_REPLAY", label: "Historical Replay", availability: "AVAILABLE",
      reason: null, blocker: null, remedy: null, effect: null,
    });
  } else {
    const depth = caps.archiveDepth ?? "not configured";
    options.push({
      mode: "HISTORICAL_REPLAY",
      label: "Historical Replay",
      availability: caps.mainnetReadAvailable ? "LIMITED" : "BLOCKED",
      reason: `The configured endpoint is ${depth}. Evidence-grade replay needs an archive-capable RPC`,
      blocker: "BLK-V2-ARCHIVE-RPC",
      remedy: "Configure an archive RPC",
      effect: "Recent blocks can still be read. A pruned endpoint is not run and labelled replay — it would answer from present state and produce a snapshot that looks historical and is not",
    });
  }

  options.push(
    caps.forkAvailable
      ? { mode: "LOCAL_MAINNET_FORK", label: "Local Mainnet Fork", availability: "AVAILABLE", reason: null, blocker: null, remedy: null, effect: null }
      : {
          mode: "LOCAL_MAINNET_FORK", label: "Local Mainnet Fork", availability: "BLOCKED",
          reason: "Anvil is not available", blocker: null, remedy: "Install Foundry",
          effect: "Fork execution and Shadow Agent runs are unavailable",
        },
  );

  options.push({
    mode: "SYNTHETIC",
    label: "Synthetic",
    availability: "AVAILABLE",
    reason: null,
    blocker: null,
    remedy: null,
    // Available and deliberately weaker. Saying so here is cheaper than a user discovering it later.
    effect: "Values are chosen rather than measured, and carry USER_UNTRUSTED. A strategy requiring a verified oracle will refuse to act on them",
  });

  return options;
}

/* ─────────────────────────── network badging ─────────────────────────── */

export const NetworkBadgeSchema = z.object({
  chainId: z.number().int().positive(),
  name: z.string().min(1),
  role: z.string().min(1),
  /** The role, always. §P28.9: never "Network: Ethereum" with no role. */
  roleLabel: z.string().min(1),
  purpose: z.enum(["MARKET_SOURCE", "EXECUTION_TARGET"]),
});
export type NetworkBadge = z.infer<typeof NetworkBadgeSchema>;

export const BADGE_REASONS = {
  ROLELESS: "NETWORK_DISPLAYED_WITHOUT_ROLE",
  MERGED: "MARKET_SOURCE_AND_EXECUTION_TARGET_MERGED",
} as const;

export class BadgeError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "BadgeError";
  }
}

/**
 * A network badge. There is no way to build one without a role.
 *
 * The role is not an optional decoration — it is the difference between a chain you read and a
 * chain you write to, and those are the two things §P28.9 requires never be confused.
 */
export function networkBadge(chainId: number, purpose: NetworkBadge["purpose"], forkedFrom?: number | null): NetworkBadge {
  const net = lookupNetwork(chainId);
  if (!net) {
    throw new BadgeError(BADGE_REASONS.ROLELESS, `chain ${chainId} is not in the registry, so its role is unknown and it cannot be displayed`);
  }

  if (purpose === "EXECUTION_TARGET" && net.role === "READ_ONLY_SOURCE") {
    throw new BadgeError(
      BADGE_REASONS.MERGED,
      `${net.name} is a READ_ONLY_SOURCE and cannot be displayed as an execution target. A UI that showed it as one would be describing a capability that does not exist.`,
    );
  }

  const roleLabel = networkLabel({
    chainId,
    role: net.role,
    forkedFrom: forkedFrom ?? null,
    forkBlock: null,
  });

  return { chainId, name: net.name, role: net.role, roleLabel, purpose };
}

/**
 * The two badges, side by side, never merged.
 *
 * Returned as a pair with distinct fields rather than a list, so a renderer cannot iterate them into
 * one row labelled "Networks" — which is exactly how the distinction gets lost.
 */
export interface RealityDisplay {
  marketSource: NetworkBadge;
  executionTarget: NetworkBadge;
}

export function realityDisplay(args: {
  marketChainId: number;
  executionChainId: number;
  forkedFrom?: number | null;
}): RealityDisplay {
  return {
    marketSource: networkBadge(args.marketChainId, "MARKET_SOURCE"),
    executionTarget: networkBadge(args.executionChainId, "EXECUTION_TARGET", args.forkedFrom ?? null),
  };
}

/* ─────────────────────────── source health ─────────────────────────── */

export const SourceStatusSchema = z.object({
  sourceId: z.string(),
  displayName: z.string(),
  status: z.enum(["HEALTHY", "STALE", "UNAVAILABLE", "NOT_CONFIGURED"]),
  reason: z.string().nullable(),
  effect: z.string().nullable(),
  /** The claim that matters when a source is missing: nothing took its place. */
  securityImpact: z.string().nullable(),
  blocker: z.string().nullable(),
});
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

/**
 * The Graph's degraded card, §P28.10.
 *
 * `securityImpact` exists because the interesting fact about a missing source is not that it is
 * missing — it is that nothing quietly replaced it. A user looking at an incomplete picture needs
 * to know the picture is incomplete rather than wrong.
 */
export function graphStatus(caps: RealityCapabilities): SourceStatus {
  const graph = marketSources().find((s) => s.kind === "THE_GRAPH");
  if (!graph) {
    return { sourceId: "thegraph", displayName: "The Graph", status: "NOT_CONFIGURED", reason: "No subgraph source is configured", effect: null, securityImpact: null, blocker: null };
  }
  if (graph.lifecycle === "ACTIVE" && (!graph.requiresAuth || caps.availableCredentials.has(graph.sourceId))) {
    return { sourceId: graph.sourceId, displayName: "The Graph", status: "HEALTHY", reason: null, effect: null, securityImpact: null, blocker: null };
  }
  return {
    sourceId: graph.sourceId,
    displayName: "The Graph",
    status: "UNAVAILABLE",
    reason: "API authentication required",
    effect: "Historical indexed context not included",
    securityImpact: "No fallback substitution occurred",
    blocker: "BLK-V2-GRAPH-KEY",
  };
}

/**
 * A status that is never green when the thing behind it is not.
 *
 * The one-line rule §P28's product tests assert: a blocked source cannot render as healthy, and a
 * stale reading loses its healthy badge. Both are properties of this function, so no screen has to
 * remember them.
 */
export function badgeTone(status: SourceStatus["status"]): "GREEN" | "AMBER" | "GREY" {
  switch (status) {
    case "HEALTHY": return "GREEN";
    case "STALE": return "AMBER";
    case "UNAVAILABLE": return "AMBER";
    case "NOT_CONFIGURED": return "GREY";
  }
}

export type { NetworkRole };
