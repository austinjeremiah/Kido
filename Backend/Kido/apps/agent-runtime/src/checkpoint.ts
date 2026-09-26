import { z } from "zod";

/**
 * The event cursor, kept OUTSIDE the container.
 *
 * §24.9's rule, stated as a shape: the container is replaceable, so nothing that matters may live
 * in its filesystem. The cursor is loaded from the control plane at startup and written back
 * through the telemetry gateway — it survives the container, and the container survives without it.
 *
 * The second property is idempotent replay. A restart re-reads from the last checkpoint, which
 * means events between the checkpoint and the crash are seen twice. For a financial agent "seen
 * twice" must not become "acted on twice", so every event carries an identity and processing is
 * keyed on it. The dedup window is bounded, and the bound is stated rather than assumed infinite.
 */

export const EventCursorSchema = z.object({
  chainId: z.number().int().positive(),
  subscriptionId: z.string().min(1),
  eventSource: z.string().min(1),
  /**
   * The last FINALIZED block processed.
   *
   * Finalized, not latest. A cursor advanced to an unfinalized block is a cursor that can be ahead
   * of a chain that reorganized, and the events it skipped would never be replayed.
   */
  lastFinalizedBlock: z.string().regex(/^\d+$/),
  /** Uniquely identifies the last event: block, tx and log index together. */
  lastProcessedEventId: z.string().min(1),
  checkpointedAtMs: z.number().int().positive(),
  /** Which agent's cursor this is. Two agents in one organization do not share one. */
  agentId: z.string().min(1),
  deploymentId: z.string().min(1),
});
export type EventCursor = z.infer<typeof EventCursorSchema>;

export const CHECKPOINT_REASONS = {
  WOULD_GO_BACKWARDS: "CHECKPOINT-WOULD-GO-BACKWARDS",
  WRONG_AGENT: "CHECKPOINT-WRONG-AGENT",
  NOT_FINALIZED: "CHECKPOINT-BLOCK-NOT-FINALIZED",
  LOCAL_ONLY: "CHECKPOINT-STORED-LOCALLY",
} as const;
export type CheckpointReason = (typeof CHECKPOINT_REASONS)[keyof typeof CHECKPOINT_REASONS];

export class CheckpointError extends Error {
  constructor(readonly reason: CheckpointReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "CheckpointError";
  }
}

/** A cursor may only move forward, and only into finalized territory. */
export function assertAdvance(from: EventCursor | null, to: EventCursor, finalizedHead: bigint): void {
  if (to.agentId !== (from?.agentId ?? to.agentId) || to.deploymentId !== (from?.deploymentId ?? to.deploymentId)) {
    throw new CheckpointError(CHECKPOINT_REASONS.WRONG_AGENT, `cursor belongs to ${from?.agentId}/${from?.deploymentId}, not ${to.agentId}/${to.deploymentId}`);
  }
  if (BigInt(to.lastFinalizedBlock) > finalizedHead) {
    throw new CheckpointError(
      CHECKPOINT_REASONS.NOT_FINALIZED,
      `block ${to.lastFinalizedBlock} is beyond the finalized head ${finalizedHead}; advancing there would skip events a reorganization could restore`,
    );
  }
  if (from && BigInt(to.lastFinalizedBlock) < BigInt(from.lastFinalizedBlock)) {
    throw new CheckpointError(
      CHECKPOINT_REASONS.WOULD_GO_BACKWARDS,
      `cursor would move from block ${from.lastFinalizedBlock} back to ${to.lastFinalizedBlock}`,
    );
  }
}

/**
 * Idempotent event processing.
 *
 * Bounded, and the bound is the point. An unbounded seen-set is a memory leak in a long-running
 * process; a bounded one means events older than the window can be re-processed, so the window has
 * to be wider than the widest gap a restart can produce. Stated here so the number is a decision.
 */
export class ProcessedEventLog {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs = 24 * 60 * 60 * 1000, private readonly maxEntries = 100_000) {}

  /** True when this event has not been processed before, and records it. False means skip it. */
  admit(eventId: string, nowMs: number): boolean {
    this.evict(nowMs);
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, nowMs);
    return true;
  }

  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  get size(): number {
    return this.seen.size;
  }

  private evict(nowMs: number): void {
    for (const [id, at] of this.seen) {
      if (nowMs - at > this.windowMs) this.seen.delete(id);
    }
    // Oldest-first, because Map preserves insertion order and insertion order here is time order.
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

/** A stable identity for an EVM log. Block alone is not unique; a transaction alone is not either. */
export const eventIdOf = (e: { chainId: number; blockNumber: bigint | string; transactionHash: string; logIndex: number }): string =>
  `${e.chainId}:${e.blockNumber}:${e.transactionHash.toLowerCase()}:${e.logIndex}`;

/**
 * Where a checkpoint may be stored.
 *
 * The container's writable layer and its tmpfs are both explicitly refused. A checkpoint written
 * there survives exactly as long as the container, which is to say it is not a checkpoint.
 */
export function assertExternalStore(location: string): void {
  if (/^(\/tmp|\/var\/tmp|\/app|\/home|\/root)(\/|$)/.test(location)) {
    throw new CheckpointError(
      CHECKPOINT_REASONS.LOCAL_ONLY,
      `"${location}" is inside the container. The runtime is replaceable, so a checkpoint kept there is lost with it; checkpoints go to the control plane through the telemetry gateway.`,
    );
  }
}
