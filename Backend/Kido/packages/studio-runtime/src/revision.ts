import { z } from "zod";
import { RuntimeProviderError, RUNTIME_REASONS, type RuntimeRevision } from "./provider.js";

/**
 * Immutable revisions: update and rollback.
 *
 * §24.12's rule, made structural:
 *
 *     A RUNTIME UPDATE CREATES A NEW IMMUTABLE IMAGE DIGEST. CODE INSIDE A RUNNING PRODUCTION
 *     CONTAINER IS NEVER MUTATED.
 *
 * The consequence people miss is that this makes rollback trivial and honest. Because every
 * revision names a digest and the digest it replaced, "roll back" is "start this specific digest"
 * — a pinned target, not an inference about which build was last known good.
 *
 * The revision history is retained rather than overwritten. A history of one is a history in which
 * rollback has nowhere to go.
 */

export const RevisionHistoryEntrySchema = z.object({
  revisionId: z.string().min(1),
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  blueprintRevision: z.number().int().nonnegative(),
  buildRevision: z.number().int().nonnegative(),
  createdAtMs: z.number().int().positive(),
  previousRevisionId: z.string().nullable(),
  /** Did this revision ever pass a health check? Only a healthy revision is a rollback target. */
  everHealthy: z.boolean(),
  retiredAtMs: z.number().int().positive().nullable(),
  retiredReason: z.string().nullable(),
});
export type RevisionHistoryEntry = z.infer<typeof RevisionHistoryEntrySchema>;

export class RevisionHistory {
  private readonly entries: RevisionHistoryEntry[] = [];

  constructor(private readonly retain = 5) {}

  /**
   * Record a new revision.
   *
   * Refuses a digest that is already the current one. An "update" that changes nothing but the
   * revision id would produce a rollback target identical to the thing being rolled back from.
   */
  add(entry: RevisionHistoryEntry): void {
    const current = this.current();
    if (current && current.imageDigest === entry.imageDigest) {
      throw new RuntimeProviderError(
        RUNTIME_REASONS.MUTATION_ATTEMPTED,
        `revision ${entry.revisionId} names the same digest as the current revision ${current.revisionId}. An update is a new image, not a new label on the same one.`,
      );
    }
    this.entries.push(entry);
    // Retained beyond the current one, or rollback has nowhere to go.
    while (this.entries.length > this.retain) this.entries.shift();
  }

  current(): RevisionHistoryEntry | null {
    return this.entries.filter((e) => e.retiredAtMs === null).at(-1) ?? this.entries.at(-1) ?? null;
  }

  all(): RevisionHistoryEntry[] {
    return [...this.entries];
  }

  markHealthy(revisionId: string): void {
    const e = this.entries.find((x) => x.revisionId === revisionId);
    if (e) e.everHealthy = true;
  }

  retire(revisionId: string, reason: string, atMs: number): void {
    const e = this.entries.find((x) => x.revisionId === revisionId);
    if (e) { e.retiredAtMs = atMs; e.retiredReason = reason; }
  }

  /**
   * The revision to roll back to.
   *
   * The most recent retained revision, before the current one, that was ever healthy. "Ever
   * healthy" is the filter that matters: rolling back to a revision that never came up would turn
   * one bad deployment into two.
   */
  rollbackTarget(): RevisionHistoryEntry {
    const current = this.current();
    const candidates = this.entries.filter((e) => e.revisionId !== current?.revisionId && e.everHealthy);
    const target = candidates.at(-1);
    if (!target) {
      throw new RuntimeProviderError(
        RUNTIME_REASONS.NO_ROLLBACK_TARGET,
        `no retained revision for this agent was ever healthy, so there is nothing to roll back to. ${this.entries.length} revision(s) are retained.`,
      );
    }
    return target;
  }
}

/** An update must present a genuinely new build, not a re-tag. */
export function assertIsNewRevision(next: RuntimeRevision, current: RuntimeRevision | null): void {
  if (!current) return;
  if (next.imageDigest === current.imageDigest) {
    throw new RuntimeProviderError(
      RUNTIME_REASONS.MUTATION_ATTEMPTED,
      `digest ${next.imageDigest} is already running as revision ${current.revisionId}`,
    );
  }
  if (next.revisionId === current.revisionId) {
    throw new RuntimeProviderError(RUNTIME_REASONS.MUTATION_ATTEMPTED, `revision id ${next.revisionId} is already in use`);
  }
}

/**
 * Operations that would mutate a running container, named so their absence is testable.
 *
 * None of them exists on `AgentRuntimeProvider`. RUN-024 checks that the interface has no member
 * whose name suggests one, which is what stops a convenience method being added later.
 */
export const FORBIDDEN_MUTATION_OPERATIONS = [
  "exec",
  "execInContainer",
  "copyInto",
  "patch",
  "hotReload",
  "updateCode",
  "installPackage",
  "restartWithNewCode",
] as const;
