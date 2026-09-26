import type { FastifyInstance } from "fastify";
import type { DB } from "../db.js";
import {
  assertPublicSafe, buildTrace, correlationIdFor, scanForSecrets,
} from "@contextlock/studio-events";
import {
  AlertEngine, CommandLog, assertCommandValid, newCommand, ControlCommandError,
  OPERATION_REQUIREMENTS, CONTROL_OPERATIONS, OPERATOR_CAPABILITIES, runtimePauseClaim,
  newEmergencyLock, runEmergencyLock, emergencySummary,
  presentable, type Actor, type ControlCommand,
} from "@contextlock/studio-control-plane";
import { SqliteEventStore, loadAlerts, persistAlert, beginCommand, completeCommand, listCommands, loadObservation } from "./store.js";

/**
 * The control-plane HTTP surface.
 *
 * §25's architecture rule: the browser is not the control plane. These routes hand a client
 * PERSISTED state and OBSERVATIONS — each carrying the moment it was read — and accept typed
 * commands. There is no route that performs an operation from parameters a component assembled;
 * every mutation goes through `ControlCommand`, which is validated here rather than in the browser.
 *
 * Every response passes the redaction scanner on its way out (§25.4 names `frontend API responses`
 * as one of the five surfaces), so a field added upstream cannot leak by being forwarded.
 */

/** Resolve the caller's operator capabilities. P26 replaces this with real team membership. */
function actorFrom(req: { headers: Record<string, unknown> }): Actor {
  const header = String(req.headers["x-contextlock-capabilities"] ?? "");
  const claimed = header.split(",").map((c) => c.trim()).filter(Boolean);
  const capabilities = claimed.filter((c) => (OPERATOR_CAPABILITIES as readonly string[]).includes(c)) as Actor["capabilities"];
  return {
    actorId: String(req.headers["x-contextlock-actor"] ?? "usr_local"),
    displayName: String(req.headers["x-contextlock-actor-name"] ?? "local operator"),
    // VIEW is implicit; everything else must be granted. An empty header therefore yields a viewer,
    // which can read and operate nothing.
    capabilities: capabilities.length > 0 ? capabilities : ["VIEW"],
  };
}

/** Every response is scanned before it leaves. */
function safe<T>(payload: T): T {
  assertPublicSafe(payload, "api-response");
  return payload;
}

export interface ControlPlaneDeps {
  db: DB;
  alerts: AlertEngine;
  commands: CommandLog;
  nowMs: () => number;
  /** Re-reads external state. Injected so a route never reaches for a cached value by accident. */
  refresh: (deploymentId: string) => Promise<{
    policy: ReturnType<typeof presentable>;
    runtime: { state: string; reasons: string[]; note: string };
    cre: Record<string, unknown>;
    adapters: Array<Record<string, unknown>>;
    identity: ReturnType<typeof presentable> | null;
    drift: Array<Record<string, unknown>>;
    currentRevision: string;
    live: { live: boolean; reasons: string[] };
  }>;
  /** Performs an operation once its command has been authorized. */
  execute: (cmd: ControlCommand) => Promise<{ ok: boolean; detail: string; result: unknown }>;
}

export function registerControlPlaneRoutes(app: FastifyInstance, deps: ControlPlaneDeps): void {
  const events = new SqliteEventStore(deps.db);

  /* ── Overview: everything a deployed-agent screen needs, with freshness on each panel ── */
  app.get<{ Params: { id: string } }>("/api/control/deployments/:id/overview", async (req, reply) => {
    const state = await deps.refresh(req.params.id);
    const openAlerts = loadAlerts(deps.db, req.params.id).filter((a) => a.state !== "RESOLVED");
    return reply.send(safe({
      deploymentId: req.params.id,
      badge: state.live.live ? "LIVE" : "INACTIVE",
      notLiveBecause: state.live.reasons,
      currentRevision: state.currentRevision,
      panels: {
        policy: state.policy,
        runtime: state.runtime,
        cre: state.cre,
        identity: state.identity,
        adapters: state.adapters,
      },
      drift: state.drift,
      alerts: { open: openAlerts.length, critical: openAlerts.filter((a) => a.severity === "CRITICAL").length, rows: openAlerts },
      // Stated on the payload rather than left to the client, because it is the sentence most
      // likely to be got wrong by whatever renders this.
      note: "Every panel carries the moment it was read. A panel that is not current is showing history, not status.",
    }));
  });

  /* ── Activity: the queryable timeline ── */
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>("/api/control/deployments/:id/activity", async (req, reply) => {
    const q = req.query;
    const rows = events.query({
      deploymentId: req.params.id,
      ...(q.source ? { source: q.source as never } : {}),
      ...(q.type ? { type: q.type as never } : {}),
      ...(q.minSeverity ? { minSeverity: q.minSeverity as never } : {}),
      ...(q.correlationId ? { correlationId: q.correlationId } : {}),
      ...(q.adapterId ? { adapterId: q.adapterId } : {}),
      ...(q.txHash ? { txHash: q.txHash } : {}),
      ...(q.sinceMs ? { sinceMs: Number(q.sinceMs) } : {}),
      limit: Math.min(Number(q.limit ?? 200), 1000),
      order: q.order === "asc" ? "asc" : "desc",
    });
    return reply.send(safe({ deploymentId: req.params.id, count: rows.length, events: rows }));
  });

  /* ── one attempted action, end to end ── */
  app.get<{ Params: { id: string; correlationId: string } }>("/api/control/deployments/:id/traces/:correlationId", async (req, reply) => {
    const all = events.query({ deploymentId: req.params.id, correlationId: req.params.correlationId });
    if (all.length === 0) return reply.code(404).send({ error: "no events for that correlation id" });
    return reply.send(safe(buildTrace(req.params.correlationId, all)));
  });

  /** A transaction hash is the entry point a block explorer gives a user. */
  app.get<{ Params: { id: string }; Querystring: { txHash?: string; capabilityId?: string } }>("/api/control/deployments/:id/trace-lookup", async (req, reply) => {
    const all = events.query({ deploymentId: req.params.id });
    const correlationId = correlationIdFor(all, {
      ...(req.query.txHash ? { txHash: req.query.txHash } : {}),
      ...(req.query.capabilityId ? { capabilityId: req.query.capabilityId } : {}),
    });
    if (!correlationId) return reply.code(404).send({ error: "nothing found for that identifier" });
    return reply.send(safe(buildTrace(correlationId, all)));
  });

  /* ── alerts ── */
  app.get<{ Params: { id: string } }>("/api/control/deployments/:id/alerts", async (req, reply) =>
    reply.send(safe({ alerts: loadAlerts(deps.db, req.params.id) })));

  app.post<{ Params: { id: string; alertId: string }; Body: { evidence?: string } }>("/api/control/deployments/:id/alerts/:alertId/resolve", async (req, reply) => {
    const actor = actorFrom(req as never);
    try {
      const a = deps.alerts.resolve(req.params.alertId, { actorId: actor.actorId, evidence: req.body?.evidence ?? null, nowMs: deps.nowMs() });
      persistAlert(deps.db, a);
      return reply.send(safe({ alert: a }));
    } catch (e) {
      // A critical drift refusing to resolve without evidence is a 409, not a 500: the request was
      // well-formed and the answer is no.
      return reply.code(409).send({ error: (e as Error).message, reason: (e as { reason?: string }).reason });
    }
  });

  /* ── the control surface ── */
  app.get("/api/control/operations", async (_req, reply) =>
    reply.send(safe({
      operations: CONTROL_OPERATIONS.map((op) => ({ operation: op, ...OPERATION_REQUIREMENTS[op] })),
      capabilities: OPERATOR_CAPABILITIES,
    })));

  /**
   * Issue a control command.
   *
   * The body carries an INTENT. The server builds the command, checks authorization, staleness and
   * expiry, and only then executes — so a client cannot construct a command that skips a check by
   * omitting a field.
   */
  app.post<{ Params: { id: string }; Body: { operation: string; target?: Record<string, string | null>; expectedRevision: string; reason?: string; confirmation?: Record<string, unknown> | null; idempotencyKey?: string } }>(
    "/api/control/deployments/:id/commands",
    async (req, reply) => {
      const actor = actorFrom(req as never);
      const body = req.body;
      if (!(CONTROL_OPERATIONS as readonly string[]).includes(body.operation)) {
        return reply.code(400).send({ error: `"${body.operation}" is not a control operation` });
      }
      const now = deps.nowMs();
      const cmd = newCommand({
        projectId: String((req.query as Record<string, string>)?.projectId ?? "prj_unknown"),
        deploymentId: req.params.id,
        actor,
        operation: body.operation as ControlCommand["operation"],
        target: {
          agentId: body.target?.agentId ?? null,
          runtimeRevision: body.target?.runtimeRevision ?? null,
          creWorkflowName: body.target?.creWorkflowName ?? null,
          policyHash: body.target?.policyHash ?? null,
          identityNode: body.target?.identityNode ?? null,
        },
        expectedRevision: body.expectedRevision,
        issuedAtMs: now,
        expiresAtMs: now + 120_000,
        confirmation: body.confirmation ?? null,
        reason: body.reason ?? null,
        ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      });

      const state = await deps.refresh(req.params.id);
      try {
        assertCommandValid(cmd, { currentRevision: state.currentRevision, nowMs: now });
      } catch (e) {
        const err = e as ControlCommandError;
        // 403 for authorization, 409 for a stale or expired command: different problems, and an
        // operator needs to know which without reading the message.
        const code = err.reason === "CONTROL-NOT-AUTHORIZED" ? 403 : 409;
        return reply.code(code).send({ error: err.message, reason: err.reason });
      }

      const replay = beginCommand(deps.db, cmd, now);
      if (replay) {
        // Same intent, already handled. Return what happened rather than doing it again.
        return reply.send(safe({ command: cmd.commandId, idempotent: true, previous: replay }));
      }

      const out = await deps.execute(cmd);
      completeCommand(deps.db, cmd, out.ok ? "APPLIED" : "FAILED", out.detail, out.result, deps.nowMs());

      // A runtime pause is the one result most likely to be over-read. The response says exactly
      // what it did and did not do.
      const extra = cmd.operation === "PAUSE_RUNTIME"
        ? { claim: runtimePauseClaim(state.policy.value ? (state.policy.value as { enabled: boolean }).enabled : null) }
        : {};

      return reply.send(safe({ command: cmd.commandId, idempotent: false, ok: out.ok, detail: out.detail, result: out.result, ...extra }));
    },
  );

  app.get<{ Params: { id: string } }>("/api/control/deployments/:id/commands", async (req, reply) =>
    reply.send(safe({ commands: listCommands(deps.db, req.params.id) })));

  /* ── the cached observation, exposed WITH its age so nobody mistakes it for current ── */
  app.get<{ Params: { id: string; kind: string; subject: string } }>("/api/control/deployments/:id/observations/:kind/:subject", async (req, reply) => {
    const o = loadObservation(deps.db, req.params.id, req.params.kind, req.params.subject);
    if (!o) return reply.code(404).send({ error: "no cached observation" });
    const p = presentable(o, deps.nowMs());
    return reply.send(safe({
      ...p,
      warning: p.isCurrent ? null : "This is a cached observation and is NOT current. Re-read the source before acting on it.",
    }));
  });
}
