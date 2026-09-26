import type { DB } from "./db.js";

/**
 * The canonical Studio event stream.
 *
 * Events are persisted first and broadcast second. That order matters: a subscriber that connects
 * late, or reconnects after a refresh, replays from the database and sees exactly what a subscriber
 * present the whole time saw. If broadcasting came first, the live view and the recovered view
 * would diverge, and the recovered one would be missing precisely the events that arrived while
 * nobody was listening.
 */

export const STUDIO_EVENT_TYPES = [
  "build.created",
  "requirements.started",
  "requirements.completed",
  "blueprint.started",
  "blueprint.updated",
  "blueprint.completed",
  "security.started",
  "security.finding",
  "security.completed",
  "approval.requested",
  "approval.granted",
  "code.started",
  "code.file.created",
  "code.file.updated",
  "code.file.deleted",
  "test.started",
  "test.passed",
  "test.failed",
  "repair.started",
  "repair.completed",
  "simulation.started",
  "simulation.step",
  "simulation.completed",
  "usage.updated",
  "usage.warning",
  "build.completed",
  "build.failed",
  "build.paused",
  "build.limit_reached",
  "build.abandoned",
] as const;

export type StudioEventType = (typeof STUDIO_EVENT_TYPES)[number];

export interface StudioEvent {
  seq: number;
  buildId: string;
  type: StudioEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

type Listener = (e: StudioEvent) => void;

export class StudioEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly db: DB) {}

  emit(buildId: string, type: StudioEventType, payload: Record<string, unknown> = {}): StudioEvent {
    const createdAt = new Date().toISOString();
    const info = this.db
      .prepare(`INSERT INTO studio_build_events (build_id, type, payload, created_at) VALUES (?, ?, ?, ?)`)
      .run(buildId, type, JSON.stringify(payload), createdAt);
    const event: StudioEvent = {
      seq: Number(info.lastInsertRowid),
      buildId,
      type,
      payload,
      createdAt,
    };
    for (const l of this.listeners.get(buildId) ?? []) {
      // A failing subscriber must not take down the build that is emitting to it.
      try {
        l(event);
      } catch {
        /* ignore */
      }
    }
    return event;
  }

  subscribe(buildId: string, listener: Listener): () => void {
    const set = this.listeners.get(buildId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(buildId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(buildId);
    };
  }

  /** Replay. `afterSeq` lets a reconnecting client resume without re-reading what it already has. */
  history(buildId: string, afterSeq = 0): StudioEvent[] {
    const rows = this.db
      .prepare(
        `SELECT seq, build_id AS buildId, type, payload, created_at AS createdAt
         FROM studio_build_events WHERE build_id = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(buildId, afterSeq) as Array<{
      seq: number;
      buildId: string;
      type: StudioEventType;
      payload: string;
      createdAt: string;
    }>;
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  }
}
