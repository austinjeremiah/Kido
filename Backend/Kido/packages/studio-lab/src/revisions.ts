import { z } from "zod";
import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";

/**
 * Revisions, and the diff a user sees before an authority change ships.
 *
 * §P28.48 forbids the thing every product does by default:
 *
 *     Do not mutate live policy invisibly.
 *
 * Editing a limit on a running agent is a financial act. The flow makes it one: a revision is
 * created, recompiled, revalidated, simulated, diffed, deployed and activated — and the old runtime
 * is fenced rather than replaced in place.
 *
 * §P28.49 adds the part that makes the diff worth reading: **highlight authority expansions
 * prominently.** A diff that renders "$500 → $1,000" in the same weight as a renamed label has told
 * the user nothing about which change matters.
 */

export const REVISION_KINDS = ["BLUEPRINT", "STRATEGY", "BUILD", "DEPLOYMENT", "RUNTIME", "CRE_ARTIFACT", "MARKET_SNAPSHOT"] as const;
export const RevisionKindSchema = z.enum(REVISION_KINDS);
export type RevisionKind = z.infer<typeof RevisionKindSchema>;

export const RevisionSchema = z.object({
  kind: RevisionKindSchema,
  /** A number for the counted ones, a hash for the content-addressed ones. */
  value: z.string().min(1),
  /** Whether a change upstream has invalidated this. */
  stale: z.boolean(),
  staleBecause: z.string().nullable(),
});
export type Revision = z.infer<typeof RevisionSchema>;

/**
 * What each revision depends on.
 *
 * Declared as data so staleness propagates by traversal rather than by a chain of `if` statements
 * somebody has to keep in sync. Editing a Blueprint invalidates everything downstream of it, and
 * this table is the only place that fact is written.
 */
const DEPENDS_ON: Record<RevisionKind, ReadonlyArray<RevisionKind>> = {
  BLUEPRINT: [],
  STRATEGY: ["BLUEPRINT"],
  BUILD: ["BLUEPRINT", "STRATEGY"],
  CRE_ARTIFACT: ["BLUEPRINT", "STRATEGY", "BUILD"],
  DEPLOYMENT: ["BLUEPRINT", "STRATEGY", "BUILD", "CRE_ARTIFACT"],
  RUNTIME: ["BUILD", "DEPLOYMENT"],
  // A snapshot is a reading of the world and does not depend on the design; it ages on its own.
  MARKET_SNAPSHOT: [],
};

/**
 * Mark everything downstream of a change as stale.
 *
 * Returns a new set rather than mutating, so a caller can show "what would go stale if I changed
 * this" without changing anything — which is the difference between a warning and a consequence.
 */
export function markStale(revisions: ReadonlyArray<Revision>, changed: RevisionKind): Revision[] {
  const affected = new Set<RevisionKind>();
  for (const kind of REVISION_KINDS) {
    if (kind === changed) continue;
    if (DEPENDS_ON[kind].includes(changed)) affected.add(kind);
  }
  // Transitive: a stale build makes the deployment that used it stale too.
  let grew = true;
  while (grew) {
    grew = false;
    for (const kind of REVISION_KINDS) {
      if (affected.has(kind)) continue;
      if (DEPENDS_ON[kind].some((d) => affected.has(d))) {
        affected.add(kind);
        grew = true;
      }
    }
  }

  return revisions.map((r) =>
    affected.has(r.kind)
      ? { ...r, stale: true, staleBecause: `the ${changed.toLowerCase().replace(/_/g, " ")} changed` }
      : r,
  );
}

/* ─────────────────────────── the security diff ─────────────────────────── */

export const CHANGE_IMPACTS = ["AUTHORITY_EXPANDED", "AUTHORITY_REDUCED", "AUTHORITY_UNCHANGED", "SOURCE_CHANGED", "SCOPE_CHANGED"] as const;
export const ChangeImpactSchema = z.enum(CHANGE_IMPACTS);
export type ChangeImpact = z.infer<typeof ChangeImpactSchema>;

export const SecurityChangeSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
  before: z.string(),
  after: z.string(),
  impact: ChangeImpactSchema,
  /** Plain-language consequence. Required for an expansion — the whole point of the screen. */
  consequence: z.string().min(1),
});
export type SecurityChange = z.infer<typeof SecurityChangeSchema>;

const usd = (cents: number): string => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
/**
 * Unwrap a `MaybeUnknown` financial value.
 *
 * The Blueprint wraps every financial parameter as `{ known: true, value, sourceQuote }` or
 * `{ known: false, reason, requiredBefore }` — there is deliberately no bare number and no absent
 * state a reader could mistake for a default. Treating the wrapper as a plain value reads every
 * established limit as UNKNOWN, which is the failure this helper exists to avoid.
 */
const knownNumber = (v: unknown): number | null => {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "known" in v) {
    const w = v as { known: boolean; value?: unknown };
    return w.known && typeof w.value === "number" ? w.value : null;
  }
  return null;
};
const known = knownNumber;

/**
 * Diff two Blueprints on the fields that carry authority.
 *
 * Only security-bearing fields. A diff that included every changed string would bury the one line
 * that matters, and the reader would learn to skim it — which is the failure mode this screen is
 * supposed to prevent, arrived at through completeness rather than omission.
 */
export function securityDiff(before: ContextLockAgentBlueprint, after: ContextLockAgentBlueprint): SecurityChange[] {
  const changes: SecurityChange[] = [];

  const compareLimit = (
    field: string,
    label: string,
    b: unknown,
    a: unknown,
    expandDirection: "HIGHER_IS_MORE" | "HIGHER_IS_LESS",
  ): void => {
    const bv = known(b);
    const av = known(a);
    if (bv === av) return;
    if (bv === null || av === null) {
      changes.push({
        field, label,
        before: bv === null ? "UNKNOWN" : usd(bv),
        after: av === null ? "UNKNOWN" : usd(av),
        impact: av === null ? "AUTHORITY_EXPANDED" : "SCOPE_CHANGED",
        consequence: av === null
          ? `${label} is no longer established. An unestablished limit is not a limit.`
          : `${label} is now established at ${usd(av)}.`,
      });
      return;
    }
    const expanded = expandDirection === "HIGHER_IS_MORE" ? av > bv : av < bv;
    const delta = Math.abs(av - bv);
    changes.push({
      field, label,
      before: usd(bv),
      after: usd(av),
      impact: expanded ? "AUTHORITY_EXPANDED" : "AUTHORITY_REDUCED",
      consequence: expanded
        ? `The agent can autonomously move an additional ${usd(delta)} per action.`
        : `The agent can move ${usd(delta)} less per action than before.`,
    });
  };

  compareLimit("autonomousPolicy.maxValueUsdCents", "Autonomous limit", before.autonomousPolicy.maxValueUsdCents, after.autonomousPolicy.maxValueUsdCents, "HIGHER_IS_MORE");
  compareLimit("escalationPolicy.maxValueUsdCents", "Hard cap", before.escalationPolicy.maxValueUsdCents, after.escalationPolicy.maxValueUsdCents, "HIGHER_IS_MORE");
  compareLimit("escalationPolicy.minValueUsdCents", "Escalation floor", before.escalationPolicy.minValueUsdCents, after.escalationPolicy.minValueUsdCents, "HIGHER_IS_MORE");

  /* ── permissions ─────────────────────────────────────────────────────── */

  const beforeAllowed = new Set(before.permissions.allowed.map((p) => p.statement));
  const afterAllowed = new Set(after.permissions.allowed.map((p) => p.statement));
  for (const s of afterAllowed) {
    if (!beforeAllowed.has(s)) {
      changes.push({ field: "permissions.allowed", label: "Permission added", before: "—", after: s, impact: "AUTHORITY_EXPANDED", consequence: `The agent can now: ${s}` });
    }
  }
  for (const s of beforeAllowed) {
    if (!afterAllowed.has(s)) {
      changes.push({ field: "permissions.allowed", label: "Permission removed", before: s, after: "—", impact: "AUTHORITY_REDUCED", consequence: `The agent can no longer: ${s}` });
    }
  }

  const beforeDenied = new Set(before.permissions.denied.map((p) => p.statement));
  const afterDenied = new Set(after.permissions.denied.map((p) => p.statement));
  for (const s of beforeDenied) {
    if (!afterDenied.has(s)) {
      // A removed denial is an expansion, and the least obvious one on this screen.
      changes.push({
        field: "permissions.denied", label: "Denial removed", before: s, after: "—",
        impact: "AUTHORITY_EXPANDED",
        consequence: `"${s}" is no longer explicitly forbidden. Removing a denial is not the same as never having had one — it widens what this agent may do.`,
      });
    }
  }
  for (const s of afterDenied) {
    if (!beforeDenied.has(s)) {
      changes.push({ field: "permissions.denied", label: "Denial added", before: "—", after: s, impact: "AUTHORITY_REDUCED", consequence: `Now explicitly forbidden: ${s}` });
    }
  }

  /* ── data sources ────────────────────────────────────────────────────── */

  const beforeAdapters = new Map(before.adapters.map((a) => [a.configRef, a]));
  for (const a of after.adapters) {
    const b = beforeAdapters.get(a.configRef);
    if (!b) {
      changes.push({ field: `adapters.${a.configRef}`, label: "Adapter added", before: "—", after: `${a.adapterId}@${a.adapterVersion}`, impact: "SOURCE_CHANGED", consequence: `${a.configRef} is now served by ${a.adapterId}.` });
      continue;
    }
    if (b.adapterId !== a.adapterId || b.adapterVersion !== a.adapterVersion) {
      changes.push({
        field: `adapters.${a.configRef}`, label: "Adapter changed",
        before: `${b.adapterId}@${b.adapterVersion}`, after: `${a.adapterId}@${a.adapterVersion}`,
        impact: "SOURCE_CHANGED",
        consequence: `${a.configRef} now comes from a different source. A source change alters the trust and freshness this deployment was approved against, and needs a new review.`,
      });
    }
  }

  for (const s of after.contextSources) {
    const b = before.contextSources.find((x) => x.id === s.id);
    if (b && b.minimumTrustClass !== s.minimumTrustClass) {
      changes.push({
        field: `contextSources.${s.id}.minimumTrustClass`, label: "Required trust changed",
        before: b.minimumTrustClass, after: s.minimumTrustClass,
        impact: "AUTHORITY_EXPANDED",
        consequence: `${s.dataKind} now accepts ${s.minimumTrustClass} where it required ${b.minimumTrustClass}. A weaker trust requirement admits weaker data.`,
      });
    }
    if (b && s.fallbackAllowed && !b.fallbackAllowed) {
      changes.push({
        field: `contextSources.${s.id}.fallbackAllowed`, label: "Fallback enabled",
        before: "false", after: "true",
        impact: "AUTHORITY_EXPANDED",
        consequence: `${s.dataKind} may now silently fall back to a lower-trust source.`,
      });
    }
  }

  return changes;
}

/** The expansions, first. What the screen leads with. */
export function authorityExpansions(changes: ReadonlyArray<SecurityChange>): SecurityChange[] {
  return changes.filter((c) => c.impact === "AUTHORITY_EXPANDED");
}

export const REVISION_REASONS = {
  LIVE_MUTATION: "LIVE_POLICY_MUTATION_REFUSED",
  STALE_ARTIFACT: "ARTIFACT_STALE_FOR_ACTIVATION",
  OLD_REVISION: "RUNTIME_REVISION_SUPERSEDED",
} as const;

export class RevisionError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "RevisionError";
  }
}

/**
 * Refuse an in-place edit of a live agent's authority.
 *
 * The tempting shortcut is to write the new limit to the running policy. It is one call and it is
 * invisible: no diff, no review, no new revision, and an audit trail that shows an agent whose
 * limits changed with no record of who changed them or what was reviewed.
 */
export function assertNotLiveMutation(isLive: boolean, createsRevision: boolean, context: string): void {
  if (!isLive) return;
  if (createsRevision) return;
  throw new RevisionError(
    REVISION_REASONS.LIVE_MUTATION,
    `${context}: this agent holds financial authority and the change does not create a revision. Editing a live policy in place leaves no diff to review and no record of what was approved. Create a revision, recompile, revalidate, simulate, review the diff and deploy it.`,
  );
}

/** Refuse to activate a revision whose upstream artifacts have gone stale. */
export function assertNoStaleArtifacts(revisions: ReadonlyArray<Revision>, context: string): void {
  const stale = revisions.filter((r) => r.stale);
  if (stale.length > 0) {
    throw new RevisionError(
      REVISION_REASONS.STALE_ARTIFACT,
      `${context}: ${stale.map((s) => `${s.kind} (${s.staleBecause})`).join(", ")}. Rebuild and retest before activating.`,
    );
  }
}

/**
 * Fence a superseded runtime.
 *
 * The old container may still be physically running — P25 established that it usually is, for a
 * while. What it must not do is authenticate. This is keyed on the revision rather than on the
 * process, because a process that has not noticed it was replaced still believes it is current.
 */
export function assertCurrentRevision(presented: string, current: string, context: string): void {
  if (presented === current) return;
  throw new RevisionError(
    REVISION_REASONS.OLD_REVISION,
    `${context}: runtime revision ${presented} was superseded by ${current}. The old runtime may still be running; it may not act.`,
  );
}
