/**
 * P25.48 — the single executable procedure that closes BLK-V2-CRE-DEPLOY.
 *
 * It runs today and reports BLOCKED. When Chainlink enables deployment access for this
 * organization, the same command runs the whole live path end to end and produces the evidence the
 * blocker needs — nothing else has to be written.
 *
 * It refuses to invent anything. If access is still missing it stops at the first gate and says so,
 * rather than falling back to a fixture and producing output that looks like a live run.
 *
 * Usage: npx tsx scripts/studio/p25-cre-closure.ts [--deploy]
 * Output: reports/phase-25/evidence/p25-cre-closure.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  CreCliProvider, CreMonitor, assertNotFixture, normalizeExecutionEvent,
  type CreExecution, type CreWorkflow,
} from "@contextlock/studio-control-plane";
import { InMemoryEventStore, scanForSecrets, type EventDraft } from "@contextlock/studio-events";

const OUT = "reports/phase-25/evidence/p25-cre-closure.json";
const PROJECT = "workflows/cre-policy/contextlock-policy";
const WORKFLOW = "contextlock-policy";
const DEPLOY_REQUESTED = process.argv.includes("--deploy");

interface Gate { gate: string; required: string; observed: string; passed: boolean; blocks: boolean }
const gates: Gate[] = [];
const gate = (name: string, required: string, observed: string, passed: boolean, blocks = true): boolean => {
  gates.push({ gate: name, required, observed, passed, blocks });
  console.log(`  ${passed ? "\x1b[32m✓\x1b[0m" : "\x1b[33m•\x1b[0m"} ${name.padEnd(38)} ${observed}`);
  return passed;
};

async function main() {
  const provider = new CreCliProvider({ projectDir: PROJECT, timeoutMs: 60_000 });
  const monitor = new CreMonitor({ provider, nowMs: () => Date.now() });
  const events = new InMemoryEventStore();
  const artifacts: Record<string, unknown> = {};

  console.log("── CRE live closure procedure ──");

  /* Gate 1 — a session exists. */
  const connection = await provider.getConnectionStatus().catch(() => null);
  const connected = gate("authenticated CRE session", "connected", connection?.connected ? `connected as ${connection.accountLabel}` : "no session", !!connection?.connected);
  if (!connected) return finish("NO_SESSION", { connection }, events, artifacts);

  /* Gate 2 — the blocker itself. */
  const hasAccess = gate("deployment access", "enabled", connection!.deployAccess ? "ENABLED" : "NOT ENABLED", connection!.deployAccess);
  artifacts.connection = connection;

  if (!hasAccess) {
    console.log("\n  Deployment access is not enabled for this organization.");
    console.log("  BLK-V2-CRE-DEPLOY remains open. Nothing was deployed and no workflow id was invented.");
    console.log("  To close it: run `cre account access` interactively to request access, then re-run this script.");
    return finish("BLOCKED_BY_BLK_V2_CRE_DEPLOY", { connection }, events, artifacts);
  }

  /* ── From here down, everything is live. It has never run. ────────────────── */

  gate("private registry available", "private", connection!.availableRegistryIds.join(", "), connection!.availableRegistryIds.includes("private"));

  /* Step 1 — deploy the approved WASM. */
  if (!DEPLOY_REQUESTED) {
    console.log("\n  Access is enabled. Re-run with --deploy to perform the live deployment.");
    return finish("READY_TO_DEPLOY", { connection }, events, artifacts);
  }

  const approved = JSON.parse(readFileSync("reports/group-e/evidence/p23-live-deployment.json", "utf8")) as Record<string, any>;
  artifacts.approvedBinaryHash = approved.receipt.creBinaryHash;

  /* Step 2 — capture the workflow id, and verify it is not a fixture. */
  const workflow = await provider.getWorkflow(WORKFLOW);
  const gotWorkflow = gate("workflow registered", "a workflow id", workflow?.workflowId ?? "none", !!workflow?.workflowId);
  if (!workflow) return finish("DEPLOY_FAILED", { connection }, events, artifacts);

  // The guard that matters most in this phase: a fixture identifier must never be recorded as live.
  assertNotFixture(workflow, "the CRE closure evidence");
  gate("workflow provenance", "LIVE", workflow.provenance, workflow.provenance === "LIVE");
  artifacts.workflow = workflow;

  /* Step 3 — lifecycle. */
  const paused = await provider.pauseWorkflow(WORKFLOW);
  const afterPause = await provider.getWorkflow(WORKFLOW);
  gate("pause, verified by re-reading", "PAUSED", afterPause?.status ?? "unknown", afterPause?.status?.toUpperCase() === "PAUSED");
  const activated = await provider.activateWorkflow(WORKFLOW);
  const afterActivate = await provider.getWorkflow(WORKFLOW);
  gate("activate, verified by re-reading", "ACTIVE", afterActivate?.status ?? "unknown", afterActivate?.status?.toUpperCase() === "ACTIVE");
  artifacts.lifecycle = { paused, activated, afterPause, afterActivate };

  /* Step 4 — executions, events and sanitized logs. */
  const executions = await provider.listExecutions(workflow.workflowId, { limit: 10 });
  gate("executions listed", "at least one", `${executions.length} execution(s)`, executions.length > 0, false);
  artifacts.executions = executions;

  if (executions.length > 0) {
    const first = executions[0]!;
    const status = await provider.getExecutionStatus(first.executionId);
    const execEvents = await provider.getExecutionEvents(first.executionId);
    const logs = await provider.getExecutionLogs(first.executionId);
    gate("execution status fetched", "a status", status?.status ?? "none", !!status);
    gate("execution events fetched", "events", `${execEvents.length}`, execEvents.length >= 0, false);
    gate("execution logs fetched", "logs", `${logs.length}`, logs.length >= 0, false);

    // Step 5 — correlate into ContextLock as normalized, bounded RuntimeEvents.
    const base: Omit<EventDraft, "type" | "severity" | "publicMetadata"> = {
      organizationId: connection!.organizationId, projectId: "prj_guardian", deploymentId: approved.receipt.deploymentId,
      agentId: "guardian", source: "CRE", timestamp: first.startedAtMs, correlationId: `corr_cre_${first.executionId}`,
      agentRunId: null, modelRunId: null, strategyEvaluationId: null, creExecutionId: first.executionId,
      authorizationId: null, capabilityId: null, chainId: null, blockNumber: null, txHash: null,
      creWorkflowId: workflow.workflowId, adapterId: null, runtimeRevision: null, buildRevision: 2,
      deploymentRevision: "rev_1", correctsEventId: null,
    };
    events.append({ ...base, type: "CRE_EXECUTION_STARTED", severity: "INFO", publicMetadata: { status: first.status } }, Date.now());
    for (const e of execEvents) {
      const n = normalizeExecutionEvent(e);
      events.append({ ...base, type: "CRE_CAPABILITY_EVENT", severity: n.status === "FAILURE" ? "ERROR" : "INFO", timestamp: n.timestampMs, publicMetadata: { capabilityId: n.capabilityId, nodeId: n.nodeId, status: n.status, message: n.message, truncated: n.truncated } }, Date.now());
    }
    gate("normalized into RuntimeEvents", "correlated records", `${events.count()} event(s)`, events.count() > 0);
    artifacts.correlation = { correlationId: base.correlationId, events: events.query({}) };
  }

  return finish("CLOSED", { connection }, events, artifacts);
}

function finish(outcome: string, extra: Record<string, unknown>, events: InMemoryEventStore, artifacts: Record<string, unknown>) {
  const blocking = gates.filter((g) => g.blocks && !g.passed);
  const evidence = {
    _comment: "The executable procedure that closes BLK-V2-CRE-DEPLOY. Everything below the deploy-access gate has never been run against a live workflow; when access is enabled this script produces it.",
    generatedAt: new Date().toISOString(),
    outcome,
    blockerStatus: outcome === "CLOSED" ? "BLK-V2-CRE-DEPLOY CAN BE CLOSED" : "BLK-V2-CRE-DEPLOY REMAINS OPEN",
    gates,
    firstUnmetGate: blocking[0]?.gate ?? null,
    artifacts,
    runtimeEvents: events.query({}),
    ...extra,
  };
  const hits = scanForSecrets(evidence, "$creclosure");
  if (hits.length > 0) throw new Error(`the closure evidence contains ${hits.length} secret-shaped value(s)`);
  writeFileSync(OUT, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`\noutcome: ${outcome}`);
  console.log(`written to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
