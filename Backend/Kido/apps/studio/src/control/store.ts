import type { DB } from "../db.js";
import {
  RuntimeEventSchema, deriveEventId, assertPublicSafe,
  type AppendResult, type EventDraft, type EventQuery, type EventStore, type RuntimeEvent,
} from "@contextlock/studio-events";
import type { Alert, CommandRecord, ControlCommand, Observation } from "@contextlock/studio-control-plane";

/**
 * The SQLite-backed control-plane store.
 *
 * Implements the same `EventStore` interface as the in-memory reference, with the same identity
 * rule — so the idempotency tests are about the RULE and this implementation inherits it, rather
 * than the two agreeing by coincidence.
 *
 * The database enforces both invariants independently of the code:
 *
 *   `event_id` is a PRIMARY KEY, so a duplicate is refused by SQLite even if the application layer
 *   is bypassed or wrong.
 *
 *   `idx_alert_open` is a partial UNIQUE index over non-resolved alerts, so a polling loop cannot
 *   insert a second open row for one fingerprint. A resolved row may coexist, which is what lets a
 *   recurrence become a new row rather than reopening an old one.
 */

const toRow = (e: RuntimeEvent) => ({
  event_id: e.eventId, schema_version: e.schemaVersion, organization_id: e.organizationId,
  project_id: e.projectId, deployment_id: e.deploymentId, agent_id: e.agentId,
  source: e.source, type: e.type, severity: e.severity, timestamp: e.timestamp,
  observed_at: e.observedAtMs, correlation_id: e.correlationId, agent_run_id: e.agentRunId,
  model_run_id: e.modelRunId, strategy_evaluation_id: e.strategyEvaluationId,
  cre_execution_id: e.creExecutionId, authorization_id: e.authorizationId, capability_id: e.capabilityId,
  chain_id: e.chainId, block_number: e.blockNumber, tx_hash: e.txHash, cre_workflow_id: e.creWorkflowId,
  adapter_id: e.adapterId, runtime_revision: e.runtimeRevision, build_revision: e.buildRevision,
  deployment_revision: e.deploymentRevision, corrects_event_id: e.correctsEventId,
  public_metadata: JSON.stringify(e.publicMetadata),
});

const fromRow = (r: Record<string, unknown>): RuntimeEvent => ({
  schemaVersion: r.schema_version as RuntimeEvent["schemaVersion"],
  eventId: r.event_id as string,
  organizationId: (r.organization_id as string) ?? null,
  projectId: r.project_id as string,
  deploymentId: r.deployment_id as string,
  agentId: (r.agent_id as string) ?? null,
  source: r.source as RuntimeEvent["source"],
  type: r.type as RuntimeEvent["type"],
  severity: r.severity as RuntimeEvent["severity"],
  timestamp: r.timestamp as number,
  observedAtMs: r.observed_at as number,
  correlationId: r.correlation_id as string,
  agentRunId: (r.agent_run_id as string) ?? null,
  modelRunId: (r.model_run_id as string) ?? null,
  strategyEvaluationId: (r.strategy_evaluation_id as string) ?? null,
  creExecutionId: (r.cre_execution_id as string) ?? null,
  authorizationId: (r.authorization_id as string) ?? null,
  capabilityId: (r.capability_id as string) ?? null,
  chainId: (r.chain_id as number) ?? null,
  blockNumber: (r.block_number as string) ?? null,
  txHash: (r.tx_hash as string) ?? null,
  creWorkflowId: (r.cre_workflow_id as string) ?? null,
  adapterId: (r.adapter_id as string) ?? null,
  runtimeRevision: (r.runtime_revision as string) ?? null,
  buildRevision: (r.build_revision as number) ?? null,
  deploymentRevision: (r.deployment_revision as string) ?? null,
  correctsEventId: (r.corrects_event_id as string) ?? null,
  publicMetadata: JSON.parse((r.public_metadata as string) ?? "{}") as Record<string, unknown>,
});

const SEVERITY_RANK: Record<string, number> = { DEBUG: 0, INFO: 1, NOTICE: 2, WARNING: 3, ERROR: 4, CRITICAL: 5 };

export class SqliteEventStore implements EventStore {
  constructor(private readonly db: DB) {}

  append(draft: EventDraft, observedAtMs: number): AppendResult {
    const withVersion = { ...draft, schemaVersion: "contextlock.runtime-event/v1" as const };
    // Public-safety before identity, so a refused event never gets an id anything could reference.
    assertPublicSafe(withVersion.publicMetadata, "runtime-event");

    const eventId = deriveEventId(withVersion as Omit<RuntimeEvent, "eventId" | "observedAtMs">);
    const candidate = RuntimeEventSchema.parse({ ...withVersion, eventId, observedAtMs });

    const existing = this.get(eventId);
    if (existing) return { ok: true, created: false, event: existing };

    const row = toRow(candidate);
    const cols = Object.keys(row);
    this.db
      .prepare(`INSERT OR IGNORE INTO control_runtime_events (${cols.join(",")}) VALUES (${cols.map((c) => `@${c}`).join(",")})`)
      .run(row);
    // Re-read rather than trusting the insert: with OR IGNORE a concurrent writer may have won,
    // and the row that exists is the one that counts.
    return { ok: true, created: true, event: this.get(eventId) ?? candidate };
  }

  get(eventId: string): RuntimeEvent | null {
    const r = this.db.prepare("SELECT * FROM control_runtime_events WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
    return r ? fromRow(r) : null;
  }

  query(q: EventQuery): RuntimeEvent[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    const eq = (col: string, key: string, v: unknown) => {
      if (v === undefined) return;
      where.push(`${col} = @${key}`);
      params[key] = v;
    };
    eq("project_id", "projectId", q.projectId);
    eq("deployment_id", "deploymentId", q.deploymentId);
    eq("agent_id", "agentId", q.agentId);
    eq("source", "source", q.source);
    eq("type", "type", q.type);
    eq("severity", "severity", q.severity);
    eq("correlation_id", "correlationId", q.correlationId);
    eq("chain_id", "chainId", q.chainId);
    eq("adapter_id", "adapterId", q.adapterId);
    eq("cre_execution_id", "creExecutionId", q.creExecutionId);
    if (q.txHash !== undefined) { where.push("lower(tx_hash) = @txHash"); params.txHash = q.txHash.toLowerCase(); }
    if (q.sinceMs !== undefined) { where.push("timestamp >= @sinceMs"); params.sinceMs = q.sinceMs; }
    if (q.untilMs !== undefined) { where.push("timestamp <= @untilMs"); params.untilMs = q.untilMs; }

    const order = q.order === "desc" ? "DESC" : "ASC";
    // Ties broken by event_id so ordering is total — two events in the same millisecond must not
    // swap places between two reads of the same timeline.
    const sql = `SELECT * FROM control_runtime_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY timestamp ${order}, event_id ${order} ${q.limit ? "LIMIT @limit" : ""}`;
    if (q.limit) params.limit = q.limit;
    let rows = (this.db.prepare(sql).all(params) as Array<Record<string, unknown>>).map(fromRow);
    if (q.minSeverity) rows = rows.filter((r) => (SEVERITY_RANK[r.severity] ?? 0) >= (SEVERITY_RANK[q.minSeverity!] ?? 0));
    return rows;
  }

  correlated(correlationId: string): RuntimeEvent[] {
    return this.query({ correlationId });
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM control_runtime_events").get() as { n: number }).n;
  }
}

/* ─────────────────────────────── alerts ─────────────────────────────── */

export function persistAlert(db: DB, a: Alert): void {
  db.prepare(
    `INSERT INTO control_alerts (alert_id,fingerprint,rule,severity,state,project_id,deployment_id,subject,reason,evidence,first_seen_at,last_seen_at,occurrences,acknowledged_by,acknowledged_at,resolved_at,resolved_by,resolution_evidence,requires_reconciliation)
     VALUES (@alert_id,@fingerprint,@rule,@severity,@state,@project_id,@deployment_id,@subject,@reason,@evidence,@first_seen_at,@last_seen_at,@occurrences,@acknowledged_by,@acknowledged_at,@resolved_at,@resolved_by,@resolution_evidence,@requires_reconciliation)
     ON CONFLICT(alert_id) DO UPDATE SET
       severity=@severity, state=@state, reason=@reason, evidence=@evidence, last_seen_at=@last_seen_at,
       occurrences=@occurrences, acknowledged_by=@acknowledged_by, acknowledged_at=@acknowledged_at,
       resolved_at=@resolved_at, resolved_by=@resolved_by, resolution_evidence=@resolution_evidence`,
  ).run({
    alert_id: a.alertId, fingerprint: a.fingerprint, rule: a.rule, severity: a.severity, state: a.state,
    project_id: a.projectId, deployment_id: a.deploymentId, subject: a.subject, reason: a.reason,
    evidence: JSON.stringify(a.evidence), first_seen_at: a.firstSeenAtMs, last_seen_at: a.lastSeenAtMs,
    occurrences: a.occurrences, acknowledged_by: a.acknowledgedBy, acknowledged_at: a.acknowledgedAtMs,
    resolved_at: a.resolvedAtMs, resolved_by: a.resolvedBy, resolution_evidence: a.resolutionEvidence,
    requires_reconciliation: a.requiresReconciliation ? 1 : 0,
  });
}

export function loadAlerts(db: DB, deploymentId?: string): Alert[] {
  const rows = (deploymentId
    ? db.prepare("SELECT * FROM control_alerts WHERE deployment_id = ? ORDER BY first_seen_at").all(deploymentId)
    : db.prepare("SELECT * FROM control_alerts ORDER BY first_seen_at").all()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    alertId: r.alert_id as string, fingerprint: r.fingerprint as string, rule: r.rule as Alert["rule"],
    severity: r.severity as Alert["severity"], state: r.state as Alert["state"],
    projectId: r.project_id as string, deploymentId: r.deployment_id as string,
    subject: r.subject as string, reason: r.reason as string,
    evidence: JSON.parse((r.evidence as string) ?? "{}") as Record<string, unknown>,
    firstSeenAtMs: r.first_seen_at as number, lastSeenAtMs: r.last_seen_at as number,
    occurrences: r.occurrences as number, acknowledgedBy: (r.acknowledged_by as string) ?? null,
    acknowledgedAtMs: (r.acknowledged_at as number) ?? null, resolvedAtMs: (r.resolved_at as number) ?? null,
    resolvedBy: (r.resolved_by as string) ?? null, resolutionEvidence: (r.resolution_evidence as string) ?? null,
    requiresReconciliation: (r.requires_reconciliation as number) === 1,
  }));
}

/* ─────────────────────────── commands ─────────────────────────── */

/**
 * Record a command, idempotently.
 *
 * Returns the EXISTING record when this intent has been seen — the uniqueness is on
 * `idempotency_key`, so two submissions of the same intent produce one row and the second reads
 * back the first's outcome rather than performing the operation again.
 */
export function beginCommand(db: DB, cmd: ControlCommand, nowMs: number): CommandRecord | null {
  const existing = db.prepare("SELECT * FROM control_commands WHERE idempotency_key = ?").get(cmd.idempotencyKey) as Record<string, unknown> | undefined;
  if (existing) {
    return {
      commandId: existing.command_id as string, idempotencyKey: existing.idempotency_key as string,
      operation: existing.operation as CommandRecord["operation"], actorId: existing.actor_id as string,
      issuedAtMs: existing.issued_at as number, completedAtMs: (existing.completed_at as number) ?? null,
      outcome: existing.outcome as CommandRecord["outcome"], detail: (existing.detail as string) ?? null,
      result: existing.result ? JSON.parse(existing.result as string) : null,
    };
  }
  db.prepare(
    `INSERT INTO control_commands (command_id,idempotency_key,project_id,deployment_id,operation,actor_id,actor_capabilities,target,expected_revision,issued_at,expires_at,outcome,reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(cmd.commandId, cmd.idempotencyKey, cmd.projectId, cmd.deploymentId, cmd.operation, cmd.actor.actorId,
    JSON.stringify(cmd.actor.capabilities), JSON.stringify(cmd.target), cmd.expectedRevision, cmd.issuedAtMs, cmd.expiresAtMs, "PENDING", cmd.reason);
  return null;
}

export function completeCommand(db: DB, cmd: ControlCommand, outcome: CommandRecord["outcome"], detail: string, result: unknown, nowMs: number): void {
  db.prepare("UPDATE control_commands SET outcome=?, detail=?, result=?, completed_at=? WHERE command_id=?")
    .run(outcome, detail, JSON.stringify(result ?? null), nowMs, cmd.commandId);
}

export function listCommands(db: DB, deploymentId: string): Array<Record<string, unknown>> {
  return db.prepare("SELECT command_id, operation, actor_id, issued_at, completed_at, outcome, detail FROM control_commands WHERE deployment_id = ? ORDER BY issued_at DESC LIMIT 100").all(deploymentId) as Array<Record<string, unknown>>;
}

/* ─────────────────────────── observations ─────────────────────────── */

/**
 * Cache the last observation of an external system.
 *
 * A cache, and named one. It exists to be COMPARED against a fresh read — §25.17 — and every read
 * of it comes back with `observedAtMs` so a caller must decide what to do about the age.
 */
export function cacheObservation(db: DB, deploymentId: string, kind: string, subject: string, o: Observation<unknown>): void {
  db.prepare(
    `INSERT INTO control_observations (deployment_id,kind,subject,state,value,observed_at,ttl_ms,source,reason)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(deployment_id,kind,subject) DO UPDATE SET state=excluded.state, value=excluded.value,
       observed_at=excluded.observed_at, ttl_ms=excluded.ttl_ms, source=excluded.source, reason=excluded.reason`,
  ).run(deploymentId, kind, subject, o.state, JSON.stringify(o.value ?? null), o.observedAtMs, o.ttlMs, o.source, o.reason);
}

export function loadObservation(db: DB, deploymentId: string, kind: string, subject: string): Observation<unknown> | null {
  const r = db.prepare("SELECT * FROM control_observations WHERE deployment_id=? AND kind=? AND subject=?").get(deploymentId, kind, subject) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    state: r.state as Observation<unknown>["state"],
    value: r.value ? JSON.parse(r.value as string) : null,
    observedAtMs: r.observed_at as number,
    ttlMs: r.ttl_ms as number,
    source: r.source as string,
    reason: (r.reason as string) ?? null,
  };
}
