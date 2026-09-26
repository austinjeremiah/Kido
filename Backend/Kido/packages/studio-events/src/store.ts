import { z } from "zod";
import { RuntimeEventSchema, deriveEventId, type RuntimeEvent, type EventSeverity, type EventSource, type EventType } from "./event.js";
import { assertPublicSafe } from "./redaction.js";

/**
 * The RuntimeEvent store.
 *
 * Append-only, idempotent, and independent of everything else. Two properties carry it.
 *
 * INGESTION IS IDEMPOTENT BECAUSE IDENTITY IS DERIVED. `append` computes the id from the content
 * and refuses to write a second row for it — so a resumed chain cursor replaying its reorg overlap,
 * a retried webhook, or two observers watching the same thing all converge on one record. This is
 * not a de-duplication pass bolted on afterwards; there is no way to express two rows for one
 * observation.
 *
 * WRITES DO NOT DEPEND ON TELEMETRY. Nothing in this file imports OpenTelemetry, and nothing in it
 * can fail because an exporter is down. §25.23 is explicit that dropping telemetry must not lose
 * financial audit events, and the way to guarantee that is for the audit path not to touch the
 * telemetry path at all. LIVE-047 proves it with an exporter that throws on every call.
 */

export const APPEND_REASONS = {
  DUPLICATE: "EVENT-DUPLICATE",
  IMMUTABLE: "EVENT-IMMUTABLE",
  MALFORMED: "EVENT-MALFORMED",
  UNSAFE: "EVENT-SECRET-PRESENT",
} as const;
export type AppendReason = (typeof APPEND_REASONS)[keyof typeof APPEND_REASONS];

export type AppendResult =
  /** Written for the first time. */
  | { ok: true; created: true; event: RuntimeEvent }
  /** Already present, byte-identical. The caller's retry succeeded the first time. */
  | { ok: true; created: false; event: RuntimeEvent };

export class EventStoreError extends Error {
  constructor(readonly reason: AppendReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "EventStoreError";
  }
}

export interface EventQuery {
  projectId?: string;
  deploymentId?: string;
  agentId?: string;
  source?: EventSource;
  type?: EventType;
  severity?: EventSeverity;
  minSeverity?: EventSeverity;
  correlationId?: string;
  chainId?: number;
  txHash?: string;
  adapterId?: string;
  creExecutionId?: string;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
  /** Ascending by default; a timeline reads forwards, an incident review reads backwards. */
  order?: "asc" | "desc";
}

const SEVERITY_RANK: Record<EventSeverity, number> = {
  DEBUG: 0, INFO: 1, NOTICE: 2, WARNING: 3, ERROR: 4, CRITICAL: 5,
};

/** What a caller supplies. The store derives the rest, so identity cannot be forged upstream. */
export type EventDraft = Omit<RuntimeEvent, "schemaVersion" | "eventId" | "observedAtMs"> &
  Partial<Pick<RuntimeEvent, "schemaVersion">>;

export interface EventStore {
  append(draft: EventDraft, observedAtMs: number): AppendResult;
  get(eventId: string): RuntimeEvent | null;
  query(q: EventQuery): RuntimeEvent[];
  /** Every event sharing a correlation id, in time order. The unit an incident is read in. */
  correlated(correlationId: string): RuntimeEvent[];
  count(): number;
}

/**
 * An in-memory store.
 *
 * The reference implementation and what the tests run against. The Studio's SQLite-backed store
 * implements the same interface and the same identity rule; keeping the reference in memory means
 * the idempotency tests are about the RULE rather than about a database's uniqueness constraint.
 */
export class InMemoryEventStore implements EventStore {
  private readonly byId = new Map<string, RuntimeEvent>();
  private readonly order: string[] = [];

  append(draft: EventDraft, observedAtMs: number): AppendResult {
    const withVersion = { ...draft, schemaVersion: "contextlock.runtime-event/v1" as const };

    // Public-safety BEFORE identity, so an unsafe event never even gets an id — nothing downstream
    // can then reference something that was refused.
    assertPublicSafe(withVersion.publicMetadata, "runtime-event");

    const eventId = deriveEventId(withVersion as Omit<RuntimeEvent, "eventId" | "observedAtMs">);
    const candidate: RuntimeEvent = { ...withVersion, eventId, observedAtMs };

    const parsed = RuntimeEventSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new EventStoreError(APPEND_REASONS.MALFORMED, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }

    const existing = this.byId.get(eventId);
    if (existing) {
      // Present already. Not an error: the whole point of a derived identity is that a retry is a
      // no-op rather than a duplicate. `observedAtMs` may differ and the FIRST observation is kept,
      // because when we noticed it second is not new information.
      return { ok: true, created: false, event: existing };
    }

    this.byId.set(eventId, parsed.data);
    this.order.push(eventId);
    return { ok: true, created: true, event: parsed.data };
  }

  get(eventId: string): RuntimeEvent | null {
    return this.byId.get(eventId) ?? null;
  }

  query(q: EventQuery): RuntimeEvent[] {
    let rows = this.order.map((id) => this.byId.get(id)!);
    const eq = <K extends keyof RuntimeEvent>(k: K, v: RuntimeEvent[K] | undefined) => {
      if (v === undefined) return;
      rows = rows.filter((r) => r[k] === v);
    };
    eq("projectId", q.projectId);
    eq("deploymentId", q.deploymentId);
    eq("agentId", q.agentId ?? undefined);
    eq("source", q.source);
    eq("type", q.type);
    eq("severity", q.severity);
    eq("correlationId", q.correlationId);
    eq("chainId", q.chainId ?? undefined);
    eq("txHash", q.txHash ?? undefined);
    eq("adapterId", q.adapterId ?? undefined);
    eq("creExecutionId", q.creExecutionId ?? undefined);
    if (q.minSeverity) rows = rows.filter((r) => SEVERITY_RANK[r.severity] >= SEVERITY_RANK[q.minSeverity!]);
    if (q.sinceMs !== undefined) rows = rows.filter((r) => r.timestamp >= q.sinceMs!);
    if (q.untilMs !== undefined) rows = rows.filter((r) => r.timestamp <= q.untilMs!);

    // Ties broken by eventId so ordering is total and stable — two events in the same millisecond
    // must not swap places between two reads of the same timeline.
    rows.sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId));
    if (q.order === "desc") rows.reverse();
    return q.limit !== undefined ? rows.slice(0, q.limit) : rows;
  }

  correlated(correlationId: string): RuntimeEvent[] {
    return this.query({ correlationId });
  }

  count(): number {
    return this.byId.size;
  }
}

/**
 * Record a correction.
 *
 * The only sanctioned way to say "what we recorded earlier is no longer true". It writes a NEW
 * event naming the old one; the old row is untouched. A monitoring system that edits its own
 * history cannot be used to reconstruct what an operator knew at the time they acted, which is the
 * question an incident review actually asks.
 */
export function correctionOf(
  original: RuntimeEvent,
  correction: { type: EventType; severity: EventSeverity; source: EventSource; timestamp: number; publicMetadata: Record<string, unknown> },
): EventDraft {
  return {
    organizationId: original.organizationId,
    projectId: original.projectId,
    deploymentId: original.deploymentId,
    agentId: original.agentId,
    source: correction.source,
    type: correction.type,
    severity: correction.severity,
    timestamp: correction.timestamp,
    correlationId: original.correlationId,
    agentRunId: original.agentRunId,
    modelRunId: original.modelRunId,
    strategyEvaluationId: original.strategyEvaluationId,
    creExecutionId: original.creExecutionId,
    authorizationId: original.authorizationId,
    capabilityId: original.capabilityId,
    chainId: original.chainId,
    blockNumber: original.blockNumber,
    txHash: original.txHash,
    creWorkflowId: original.creWorkflowId,
    adapterId: original.adapterId,
    runtimeRevision: original.runtimeRevision,
    buildRevision: original.buildRevision,
    deploymentRevision: original.deploymentRevision,
    correctsEventId: original.eventId,
    publicMetadata: { ...correction.publicMetadata, corrects: original.eventId, correctsType: original.type },
  };
}

export const EventQuerySchema = z.object({
  projectId: z.string().optional(),
  deploymentId: z.string().optional(),
  correlationId: z.string().optional(),
  source: z.string().optional(),
  minSeverity: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});
