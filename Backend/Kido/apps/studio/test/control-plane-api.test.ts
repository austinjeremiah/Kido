import { describe, expect, it, beforeEach } from "vitest";
import { buildServer } from "../src/api.js";
import { SqliteEventStore, persistAlert, loadAlerts } from "../src/control/store.js";
import { AlertEngine, CommandLog, presentable, observed, DEFAULT_TTLS, type ControlPlaneDeps } from "@contextlock/studio-control-plane";
import { CANARIES, type EventDraft } from "@contextlock/studio-events";
import { openStudioDb, type DB } from "../src/db.js";

const NOW = 1_780_000_000_000;
const DEPLOYMENT = "dep_group_e_live_0001";
const TX = `0x${"ab".repeat(32)}`;

const evt = (over: Partial<EventDraft>): EventDraft => ({
  organizationId: null, projectId: "prj_guardian", deploymentId: DEPLOYMENT, agentId: "guardian",
  source: "CHAIN", type: "POLICY_STATE_OBSERVED", severity: "INFO", timestamp: NOW,
  correlationId: "corr_1", agentRunId: null, modelRunId: null, strategyEvaluationId: null,
  creExecutionId: null, authorizationId: null, capabilityId: null, chainId: 11155111,
  blockNumber: "11674959", txHash: null, creWorkflowId: null, adapterId: null, runtimeRevision: null,
  buildRevision: 2, deploymentRevision: "rev_1", correctsEventId: null, publicMetadata: { enabled: false },
  ...over,
});

/**
 * A control plane wired to observers under test control.
 *
 * `refresh` is what the routes call; nothing in a route reaches for a cached value on its own, so
 * substituting this is enough to drive every path.
 */
function harness(over: Partial<{ policyEnabled: boolean; currentRevision: string; executeOk: boolean }> = {}) {
  const alerts = new AlertEngine();
  const commands = new CommandLog();
  const executed: string[] = [];
  let db!: DB;

  const controlPlane = (): ControlPlaneDeps => ({
    db,
    alerts,
    commands,
    nowMs: () => NOW,
    async refresh() {
      const policy = observed({ enabled: over.policyEnabled ?? false, bindingVersion: "1", policyAdmin: "0x93e0" }, { atMs: NOW, source: "chain:11155111", ttlMs: DEFAULT_TTLS.policy });
      return {
        policy: presentable(policy, NOW) as never,
        runtime: { state: "STOPPED", reasons: ["the container is not running"], note: "Runtime health says nothing about financial authority." },
        cre: { state: "BLOCKED", headline: "Waiting for deployment access", blockedBy: "CRE_DEPLOY_ACCESS_REQUIRED" },
        adapters: [{ adapterId: "aave-v3", state: "UNKNOWN" }],
        identity: null,
        drift: [],
        currentRevision: over.currentRevision ?? "rev_1",
        live: { live: false, reasons: ["runtime is STOPPED", "the ContextLock policy is disabled"] },
      };
    },
    async execute(cmd) {
      executed.push(cmd.operation);
      return over.executeOk === false
        ? { ok: false, detail: "the signer declined", result: null }
        : { ok: true, detail: `${cmd.operation} applied`, result: { operation: cmd.operation } };
    },
  });

  // Its own in-memory database. Sharing the on-disk studio.db would let one test's events be
  // counted by another's, which is how an idempotency assertion silently stops meaning anything.
  db = openStudioDb(":memory:");
  const server = buildServer({ db, controlPlane: controlPlane() });
  return { app: server.app, db, alerts, executed };
}

const op = (caps: string[]) => ({
  "x-contextlock-actor": "usr_test",
  "x-contextlock-actor-name": "test operator",
  "x-contextlock-capabilities": caps.join(","),
});

describe("the control-plane API", () => {
  it("LIVE-022c the overview is assembled from observations, each carrying its freshness", async () => {
    const { app } = harness();
    const res = await app.inject({ method: "GET", url: `/api/control/deployments/${DEPLOYMENT}/overview`, headers: op(["VIEW"]) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, any>;

    expect(body.badge).toBe("INACTIVE");
    expect(body.notLiveBecause).toContain("the ContextLock policy is disabled");
    expect(body.panels.policy.observedAtMs).toBe(NOW);
    expect(body.panels.policy.isCurrent).toBe(true);
    expect(body.panels.policy.source).toBe("chain:11155111");
    expect(body.panels.cre.blockedBy).toBe("CRE_DEPLOY_ACCESS_REQUIRED");
    // The sentence a renderer is most likely to get wrong is on the payload, not left to the client.
    expect(body.note).toMatch(/not current is showing history, not status/);
  });

  it("LIVE-028b the activity timeline is queryable by every axis, and ordered totally", async () => {
    const { app, db } = harness();
    const store = new SqliteEventStore(db);
    store.append(evt({ timestamp: NOW + 1, type: "DECISION_DENY", source: "CONTEXTLOCK", severity: "WARNING", correlationId: "corr_a" }), NOW);
    store.append(evt({ timestamp: NOW + 2, type: "ADAPTER_READ", source: "ADAPTER", adapterId: "aave-v3", correlationId: "corr_b" }), NOW);
    store.append(evt({ timestamp: NOW + 3, type: "EXECUTION_MINED", source: "CHAIN", txHash: TX, correlationId: "corr_b" }), NOW);

    const all = (await app.inject({ method: "GET", url: `/api/control/deployments/${DEPLOYMENT}/activity`, headers: op(["VIEW"]) })).json() as Record<string, any>;
    expect(all.count).toBe(3);
    // Newest first by default: an operator opening a timeline is looking at what just happened.
    expect(all.events[0].type).toBe("EXECUTION_MINED");

    const bySource = (await app.inject({ method: "GET", url: `/api/control/deployments/${DEPLOYMENT}/activity?source=CONTEXTLOCK`, headers: op(["VIEW"]) })).json() as Record<string, any>;
    expect(bySource.count).toBe(1);
    const bySeverity = (await app.inject({ method: "GET", url: `/api/control/deployments/${DEPLOYMENT}/activity?minSeverity=WARNING`, headers: op(["VIEW"]) })).json() as Record<string, any>;
    expect(bySeverity.count).toBe(1);
    const byCorrelation = (await app.inject({ method: "GET", url: `/api/control/deployments/${DEPLOYMENT}/activity?correlationId=corr_b`, headers: op(["VIEW"]) })).json() as Record<string, any>;
    expect(byCorrelation.count).toBe(2);
    const byTx = (await app.inject({ method: "GET", url: `/api/control/deployments/${DEPLOYMENT}/activity?txHash=${TX.toUpperCase()}`, headers: op(["VIEW"]) })).json() as Record<string, any>;
    expect(byTx.count).toBe(1);
  });

  it("LIVE-002f a transaction hash navigates back to the whole action", async () => {
    const { app, db } = harness();
    const store = new SqliteEventStore(db);
    store.append(evt({ timestamp: NOW, type: "AGENT_TRIGGERED", source: "AGENT", correlationId: "corr_x", agentRunId: "run_1" }), NOW);
    store.append(evt({ timestamp: NOW + 1, type: "DECISION_ALLOW", source: "CONTEXTLOCK", correlationId: "corr_x" }), NOW);
    store.append(evt({ timestamp: NOW + 2, type: "EXECUTION_MINED", source: "CHAIN", correlationId: "corr_x", txHash: TX }), NOW);

    const res = await app.inject({ method: "GET", url: `/api/control/deployments/${DEPLOYMENT}/trace-lookup?txHash=${TX}`, headers: op(["VIEW"]) });
    expect(res.statusCode).toBe(200);
    const trace = res.json() as Record<string, any>;
    expect(trace.correlationId).toBe("corr_x");
    expect(trace.stages.map((s: { stage: string }) => s.stage)).toEqual(["TRIGGER", "CONTEXTLOCK_DECISION", "TRANSACTION"]);
    expect(trace.identifiers.txHashes).toEqual([TX]);

    const missing = await app.inject({ method: "GET", url: `/api/control/deployments/${DEPLOYMENT}/trace-lookup?txHash=0x${"99".repeat(32)}`, headers: op(["VIEW"]) });
    expect(missing.statusCode).toBe(404);
  });

  it("LIVE-030d a viewer is refused with 403, and a stale command with 409", async () => {
    const { app, executed } = harness();
    const body = { operation: "PAUSE_RUNTIME", expectedRevision: "rev_1", target: { agentId: "guardian" } };

    const viewer = await app.inject({ method: "POST", url: `/api/control/deployments/${DEPLOYMENT}/commands`, headers: op(["VIEW"]), payload: body });
    expect(viewer.statusCode).toBe(403);
    expect((viewer.json() as Record<string, any>).reason).toBe("CONTROL-NOT-AUTHORIZED");
    expect(executed).toEqual([]);

    // An empty capability header yields a viewer, not an admin.
    const noHeader = await app.inject({ method: "POST", url: `/api/control/deployments/${DEPLOYMENT}/commands`, payload: body });
    expect(noHeader.statusCode).toBe(403);

    const stale = await app.inject({ method: "POST", url: `/api/control/deployments/${DEPLOYMENT}/commands`, headers: op(["RUNTIME_CONTROL"]), payload: { ...body, expectedRevision: "rev_0" } });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as Record<string, any>).reason).toBe("CONTROL-STALE-REVISION");
    expect(executed).toEqual([]);
  });

  it("LIVE-013c a pause is applied and the response says what it did NOT do", async () => {
    const { app, executed } = harness({ policyEnabled: true });
    const res = await app.inject({
      method: "POST", url: `/api/control/deployments/${DEPLOYMENT}/commands`,
      headers: op(["RUNTIME_CONTROL"]),
      payload: { operation: "PAUSE_RUNTIME", expectedRevision: "rev_1", target: { agentId: "guardian" }, reason: "maintenance" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(executed).toEqual(["PAUSE_RUNTIME"]);
    // The policy is enabled, so the response must say the agent can still act.
    expect(body.claim.financiallySecured).toBe(false);
    expect(body.claim.warning).toMatch(/still ENABLED/);
    expect(JSON.stringify(body)).not.toMatch(/treasury secured/i);
  });

  it("LIVE-036b the same intent submitted twice performs one operation", async () => {
    const { app, executed } = harness();
    const payload = { operation: "PAUSE_RUNTIME", expectedRevision: "rev_1", target: { agentId: "guardian" }, idempotencyKey: "idem_fixed_key_1" };
    const first = await app.inject({ method: "POST", url: `/api/control/deployments/${DEPLOYMENT}/commands`, headers: op(["RUNTIME_CONTROL"]), payload });
    const second = await app.inject({ method: "POST", url: `/api/control/deployments/${DEPLOYMENT}/commands`, headers: op(["RUNTIME_CONTROL"]), payload });

    expect(first.statusCode).toBe(200);
    expect((first.json() as Record<string, any>).idempotent).toBe(false);
    expect((second.json() as Record<string, any>).idempotent).toBe(true);
    // Performed once.
    expect(executed).toEqual(["PAUSE_RUNTIME"]);
  });

  it("LIVE-050c a critical alert refuses to resolve without evidence, with 409", async () => {
    const { app, alerts, db } = harness();
    const { alert } = alerts.raise({ rule: "POLICY_UNEXPECTEDLY_ENABLED", severity: "CRITICAL", projectId: "prj_guardian", deploymentId: DEPLOYMENT, subject: "policy 0xabc", reason: "chain says enabled", nowMs: NOW });
    persistAlert(db, alert);

    const listed = (await app.inject({ method: "GET", url: `/api/control/deployments/${DEPLOYMENT}/alerts`, headers: op(["VIEW"]) })).json() as Record<string, any>;
    expect(listed.alerts).toHaveLength(1);
    expect(listed.alerts[0].requiresReconciliation).toBe(true);

    const bare = await app.inject({ method: "POST", url: `/api/control/deployments/${DEPLOYMENT}/alerts/${alert.alertId}/resolve`, headers: op(["VIEW"]), payload: {} });
    expect(bare.statusCode).toBe(409);
    expect((bare.json() as Record<string, any>).reason).toBe("ALERT-RECONCILIATION-REQUIRED");

    const withEvidence = await app.inject({
      method: "POST", url: `/api/control/deployments/${DEPLOYMENT}/alerts/${alert.alertId}/resolve`,
      headers: op(["VIEW"]), payload: { evidence: "Enabled at 14:02 by a deploy script; re-disabled at 14:09; tx reviewed." },
    });
    expect(withEvidence.statusCode).toBe(200);
    expect((withEvidence.json() as Record<string, any>).alert.state).toBe("RESOLVED");
  });

  it("LIVE-006b a cached observation is returned WITH a warning that it is not current", async () => {
    const { app, db } = harness();
    const { cacheObservation } = await import("../src/control/store.js");
    cacheObservation(db, DEPLOYMENT, "policy", "0xabc", observed({ enabled: false }, { atMs: NOW - 10 * 60_000, source: "chain:11155111", ttlMs: DEFAULT_TTLS.policy }));

    const res = await app.inject({ method: "GET", url: `/api/control/deployments/${DEPLOYMENT}/observations/policy/0xabc`, headers: op(["VIEW"]) });
    const body = res.json() as Record<string, any>;
    expect(body.state).toBe("STALE");
    expect(body.isCurrent).toBe(false);
    expect(body.warning).toMatch(/NOT current/);
    // The value is still there — hiding it would be less useful — but it is labelled.
    expect(body.value).toEqual({ enabled: false });
  });

  it("LIVE-003e every API response passes the redaction scanner", async () => {
    const { app, db } = harness();
    const store = new SqliteEventStore(db);
    // A clean event goes through.
    store.append(evt({ publicMetadata: { enabled: false, block: "11674959" } }), NOW);
    const ok = await app.inject({ method: "GET", url: `/api/control/deployments/${DEPLOYMENT}/activity`, headers: op(["VIEW"]) });
    expect(ok.statusCode).toBe(200);

    // And the store refuses to persist one that is not, so it can never reach a response.
    expect(() => store.append(evt({ publicMetadata: { apiKey: CANARIES.openaiKey } }), NOW)).toThrow();
    expect(() => store.append(evt({ publicMetadata: { nested: { chainOfThought: "the agent reasoned..." } } }), NOW)).toThrow();
  });

  it("LIVE-023d ingestion through the database is idempotent", async () => {
    const { db } = harness();
    const store = new SqliteEventStore(db);
    const draft = evt({ timestamp: NOW + 99 });
    const first = store.append(draft, NOW);
    for (let i = 0; i < 5; i++) {
      const again = store.append(draft, NOW + i * 1000);
      expect(again.created).toBe(false);
      expect(again.event.eventId).toBe(first.event.eventId);
      // The FIRST observation time is kept: noticing it again is not new information.
      expect(again.event.observedAtMs).toBe(NOW);
    }
    expect(store.query({ deploymentId: DEPLOYMENT })).toHaveLength(1);
  });

  it("LIVE-030e the control surface advertises what each operation affects", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: "/api/control/operations", headers: op(["VIEW"]) })).json() as Record<string, any>;
    const byOp = Object.fromEntries(body.operations.map((o: Record<string, unknown>) => [o.operation, o]));
    expect(byOp.PAUSE_RUNTIME.affects).toBe("the agent process only");
    expect(byOp.PAUSE_RUNTIME.isFinancialStop).toBe(false);
    expect(byOp.DISABLE_POLICY.isFinancialStop).toBe(true);
    expect(byOp.DELETE_CRE.destructive).toBe(true);
    expect(body.capabilities).toContain("EMERGENCY_CONTROL");
  });
});
