import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  newCommand, assertCommandValid, ControlCommandError, COMMAND_REASONS, CommandLog,
  OPERATION_REQUIREMENTS, OPERATOR_CAPABILITIES, CONTROL_OPERATIONS, runtimePauseClaim, CONTROL_COMMAND_VERSION,
  newEmergencyLock, runEmergencyLock, emergencySummary, EMERGENCY_STEPS, CRITICAL_STEP, FORBIDDEN_IN_KILL_PATH,
  AlertEngine, AlertError, ALERT_REASONS, alertForDrift, REQUIRES_RECONCILIATION, fingerprintOf, ALERT_RULES,
  evaluateRuntime, runtimeObservation, RuntimeRevisionFence, RuntimeFenceError, FENCE_REASONS, agentIsLive,
  RUNTIME_HEALTH_NOTE, DEFAULT_RUNTIME_POLICY,
  assertMetricLabels, assertSpanAttributesSafe, OtelError, OTEL_REASONS, NoopTelemetry, METRICS,
  FORBIDDEN_METRIC_LABELS, ALLOWED_METRIC_LABELS, OTEL_VERSIONS, POLICY_STATE_GAUGE, OTEL_DISABLED,
  reconcile,
  type EmergencyActions, type RuntimeObservationInputs, type ControlCommand,
} from "../src/index.js";
import { InMemoryEventStore, CANARIES, RedactionError, scanForSecrets } from "@contextlock/studio-events";
import { NOW, LIVE, VIEWER, RUNTIME_OP, POLICY_OP, INCIDENT_OP, actor } from "./fixtures.js";

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};

const cmd = (over: Partial<Parameters<typeof newCommand>[0]> = {}): ControlCommand =>
  newCommand({
    projectId: "prj_guardian",
    deploymentId: "dep_group_e_live_0001",
    actor: INCIDENT_OP,
    operation: "PAUSE_RUNTIME",
    target: { agentId: "guardian", runtimeRevision: "rev_1", creWorkflowName: null, policyHash: null, identityNode: null },
    expectedRevision: "rev_1",
    issuedAtMs: NOW,
    expiresAtMs: NOW + 120_000,
    confirmation: null,
    reason: "routine maintenance",
    ...over,
  });

const ctx = (over: Record<string, unknown> = {}) => ({ currentRevision: "rev_1", nowMs: NOW, ...over });

/* ══════════════════════════ control commands ══════════════════════════ */

describe("control commands", () => {
  it("LIVE-013 pausing the runtime changes only the runtime, and says so", () => {
    const req = OPERATION_REQUIREMENTS.PAUSE_RUNTIME;
    expect(req.affects).toBe("the agent process only");
    expect(req.isFinancialStop).toBe(false);

    // The sentence a status screen wants to print, and the one it gets instead.
    const withPolicyOn = runtimePauseClaim(true);
    expect(withPolicyOn.runtimeStopped).toBe(true);
    expect(withPolicyOn.financiallySecured).toBe(false);
    expect(withPolicyOn.warning).toMatch(/still ENABLED/);
    expect(withPolicyOn.warning).toMatch(/capability already issued remains valid/);
    expect(JSON.stringify(withPolicyOn)).not.toMatch(/treasury secured|funds are safe/i);

    const withPolicyOff = runtimePauseClaim(false);
    expect(withPolicyOff.financiallySecured).toBe(true);
    expect(withPolicyOff.warning).toBeNull();

    // Unknown policy state is not "secured".
    const unknown = runtimePauseClaim(null);
    expect(unknown.financiallySecured).toBe(false);
    expect(unknown.warning).toMatch(/UNKNOWN/);
  });

  it("LIVE-030 the P0-P24 regression actually runs the new suites, and the inventory gate says so", () => {
    /*
     * "The regression is green" is a claim about a harness run and belongs in TEST_RESULTS. What is
     * checkable here is the part that silently rots: whether the cumulative harness executes the
     * suites P25 added.
     *
     * Group D found a suite that had hidden outside the harness for two phase groups and had never
     * passed. This asserts the new packages are wired into both the runner and the inventory gate.
     */
    const harness = readFileSync("scripts/test-all.sh", "utf8");
    const inventory = readFileSync("scripts/suite-inventory.sh", "utf8");
    for (const pkg of ["packages/studio-events", "packages/studio-control-plane"]) {
      expect(harness, `${pkg} must be run by the cumulative harness`).toContain(pkg);
      expect(inventory, `${pkg}/test must be covered by the suite inventory`).toContain(`${pkg}/test`);
    }
    // Everything P22-P24 added must still be there too.
    for (const pkg of ["packages/studio-deploy", "packages/studio-orchestrator", "packages/studio-runtime", "apps/agent-runtime"]) {
      expect(harness, pkg).toContain(pkg);
    }
    expect(harness).toContain("no test count parsed — treating as failure");
  });

  it("LIVE-030b every operation names a required capability and the layer it affects", () => {
    for (const op of CONTROL_OPERATIONS) {
      const r = OPERATION_REQUIREMENTS[op];
      expect(OPERATOR_CAPABILITIES, op).toContain(r.capability);
      expect(r.affects.length, op).toBeGreaterThan(10);
    }
    // The only two financial stops.
    const stops = CONTROL_OPERATIONS.filter((o) => OPERATION_REQUIREMENTS[o].isFinancialStop);
    expect(stops).toEqual(["DISABLE_POLICY", "EMERGENCY_LOCK"]);
    // Powers are split: pausing a container and withdrawing financial authority are different.
    expect(OPERATION_REQUIREMENTS.PAUSE_RUNTIME.capability).toBe("RUNTIME_CONTROL");
    expect(OPERATION_REQUIREMENTS.DISABLE_POLICY.capability).toBe("POLICY_CONTROL");
  });

  it("LIVE-030c an authenticated viewer cannot operate controls", () => {
    expect(reasonOf(() => assertCommandValid(cmd({ actor: VIEWER }), ctx()))).toBe(COMMAND_REASONS.NOT_AUTHORIZED);
    // A runtime operator can pause a runtime and cannot touch the policy.
    expect(() => assertCommandValid(cmd({ actor: RUNTIME_OP }), ctx())).not.toThrow();
    expect(reasonOf(() => assertCommandValid(cmd({ actor: RUNTIME_OP, operation: "DISABLE_POLICY" }), ctx()))).toBe(COMMAND_REASONS.NOT_AUTHORIZED);
    expect(reasonOf(() => assertCommandValid(cmd({ actor: POLICY_OP, operation: "PAUSE_RUNTIME" }), ctx()))).toBe(COMMAND_REASONS.NOT_AUTHORIZED);
    expect(() => assertCommandValid(cmd({ actor: POLICY_OP, operation: "DISABLE_POLICY" }), ctx())).not.toThrow();
    // Emergency lock needs its own capability, not merely "some control".
    expect(reasonOf(() => assertCommandValid(cmd({ actor: RUNTIME_OP, operation: "EMERGENCY_LOCK" }), ctx()))).toBe(COMMAND_REASONS.NOT_AUTHORIZED);
  });

  it("LIVE-035 a command issued against a revision that is no longer current is rejected", () => {
    // The operator clicked "pause" on a screen showing rev_1; the deployment is now rev_2.
    const r = reasonOf(() => assertCommandValid(cmd({ expectedRevision: "rev_1" }), ctx({ currentRevision: "rev_2" })));
    expect(r).toBe(COMMAND_REASONS.STALE_REVISION);
    expect(() => assertCommandValid(cmd({ expectedRevision: "rev_1" }), ctx({ currentRevision: "rev_2" })))
      .toThrow(/the screen you acted on described a different deployment/);

    // Expiry is checked too — a command sitting in a queue for an hour is not consent.
    expect(reasonOf(() => assertCommandValid(cmd(), ctx({ nowMs: NOW + 300_000 })))).toBe(COMMAND_REASONS.EXPIRED);
  });

  it("LIVE-036 the same intent submitted twice is one operation", () => {
    const log = new CommandLog();
    const a = cmd();
    const b = cmd();

    // Different command ids, same intent, same idempotency key.
    expect(a.commandId).not.toBe(b.commandId);
    expect(a.idempotencyKey).toBe(b.idempotencyKey);

    expect(log.begin(a, NOW)).toBeNull();
    log.complete(a, "APPLIED", "runtime paused", { paused: true }, NOW + 10);

    // The replay returns the ORIGINAL result rather than performing it again.
    const replay = log.begin(b, NOW + 20);
    expect(replay).not.toBeNull();
    expect(replay!.outcome).toBe("APPLIED");
    expect(replay!.commandId).toBe(a.commandId);
    expect(replay!.result).toEqual({ paused: true });

    // A genuinely different intent gets its own key.
    expect(cmd({ operation: "RESUME_RUNTIME" }).idempotencyKey).not.toBe(a.idempotencyKey);
    expect(cmd({ expectedRevision: "rev_2" }).idempotencyKey).not.toBe(a.idempotencyKey);
  });

  it("LIVE-018b a destructive operation without confirmation is refused", () => {
    expect(reasonOf(() => assertCommandValid(cmd({ operation: "DELETE_CRE", confirmation: null }), ctx()))).toBe(COMMAND_REASONS.CONFIRMATION_REQUIRED);
    expect(reasonOf(() => assertCommandValid(cmd({ operation: "REVOKE_IDENTITY", confirmation: null }), ctx()))).toBe(COMMAND_REASONS.CONFIRMATION_REQUIRED);
    expect(() => assertCommandValid(cmd({ operation: "DELETE_CRE", confirmation: { typedWorkflowName: "contextlock-policy" } }), ctx())).not.toThrow();
  });

  it("LIVE-035b a command is a value the backend validates, not a call from a component", () => {
    const c = cmd();
    expect(c.schemaVersion).toBe(CONTROL_COMMAND_VERSION);
    expect(CONTROL_COMMAND_VERSION).toBe("contextlock.control-command/v1");
    // Everything the backend needs to decide is IN the value.
    for (const k of ["commandId", "actor", "operation", "target", "expectedRevision", "idempotencyKey", "expiresAtMs"]) {
      expect(Object.keys(c)).toContain(k);
    }
    // And it carries nothing secret.
    expect(scanForSecrets(c, "command")).toEqual([]);
  });

  it("LIVE-034c an emergency lock refuses the operations that would restore capability", () => {
    const locked = ctx({ emergencyLockActive: true });
    for (const op of ["ENABLE_POLICY", "ACTIVATE_CRE", "RESUME_RUNTIME"] as const) {
      expect(reasonOf(() => assertCommandValid(cmd({ operation: op }), locked)), op).toBe(COMMAND_REASONS.EMERGENCY_LOCK_ACTIVE);
    }
    // Making things safer stays available during an incident.
    for (const op of ["PAUSE_RUNTIME", "DISABLE_POLICY", "PAUSE_CRE"] as const) {
      expect(() => assertCommandValid(cmd({ operation: op }), locked), op).not.toThrow();
    }
  });
});

/* ══════════════════════════ emergency lock ══════════════════════════ */

describe("emergency lock", () => {
  const applicability = { creWorkflowExists: true, runtimeExists: true, identityExists: true };

  const actions = (over: Partial<EmergencyActions> = {}, order: string[] = []): EmergencyActions => ({
    async disablePolicy() { order.push("DISABLE_POLICY"); return { ok: true, verification: "fresh chain read: enabled=false at block 11674400", detail: "policy disabled" }; },
    async denyNewCapabilities() { order.push("DENY_NEW_CAPABILITIES"); return { ok: true, verification: "issuer refusing", detail: "capability issuance stopped" }; },
    async pauseCre() { order.push("PAUSE_CRE"); return { ok: true, verification: "cre workflow get: PAUSED", detail: "workflow paused" }; },
    async stopRuntime() { order.push("STOP_RUNTIME"); return { ok: true, verification: "container removed", detail: "runtime stopped" }; },
    async revokeIdentity() { order.push("REVOKE_IDENTITY"); return { ok: true, verification: "resolver returns null", detail: "identity revoked" }; },
    nowMs: () => NOW,
    ...over,
  });

  const lock = (over: Record<string, unknown> = {}) =>
    newEmergencyLock({ lockId: "lock_1", deploymentId: "dep_1", idempotencyKey: "idem_lock_1", initiatedBy: "usr_incident-op", nowMs: NOW, includeIdentityRevocation: false, applicability, ...over });

  it("LIVE-016 the policy stop goes first, always", async () => {
    const order: string[] = [];
    const r = await runEmergencyLock(lock(), actions({}, order));
    expect(order[0]).toBe("DISABLE_POLICY");
    expect(EMERGENCY_STEPS[0]).toBe("DISABLE_POLICY");
    expect(CRITICAL_STEP).toBe("DISABLE_POLICY");
    expect(r.state).toBe("COMPLETE");
    expect(r.financialPolicyDisabled).toBe(true);
    // The critical step's success is backed by a fresh chain read, not a receipt.
    expect(r.steps[0]!.verification).toMatch(/fresh chain read/);
  });

  it("LIVE-038 the lock works with the Model Gateway completely down, and no model is in the path", async () => {
    /*
     * The lock takes no planner, no strategy and no model client — the step order is a frozen
     * array. This asserts it structurally rather than by observing one run.
     */
    const source = readFileSync("packages/studio-control-plane/src/emergency.ts", "utf8");
    for (const forbidden of ["ModelGateway", "openai", "@openai/agents", "luna", "complete("]) {
      expect(source.toLowerCase(), `the kill path must not reference ${forbidden}`).not.toContain(`import.*${forbidden.toLowerCase()}`);
    }
    expect(source).not.toMatch(/^import .*(openai|ModelGateway|luna)/mi);
    expect(FORBIDDEN_IN_KILL_PATH).toContain("ModelGateway");

    // And behaviourally: every model-ish dependency throws, and the lock still disables the policy.
    const order: string[] = [];
    const r = await runEmergencyLock(lock(), actions({}, order));
    expect(order[0]).toBe("DISABLE_POLICY");
    expect(r.financialPolicyDisabled).toBe(true);
    // Nothing was awaited before step 1 — it is the first thing that happened.
    expect(order.indexOf("DISABLE_POLICY")).toBe(0);
  });

  it("LIVE-017 partial completion is recorded honestly, and the headline is about the money", async () => {
    const r = await runEmergencyLock(lock(), actions({
      async pauseCre() { return { ok: false, verification: "", detail: "the Local Bridge is offline" }; },
    }));

    expect(r.state).toBe("PARTIAL");
    expect(r.financialPolicyDisabled).toBe(true);
    expect(r.steps.find((s) => s.step === "PAUSE_CRE")!.outcome).toBe("FAILED");
    // Later steps still ran: weaker controls are better than none.
    expect(r.steps.find((s) => s.step === "STOP_RUNTIME")!.outcome).toBe("SUCCEEDED");

    const summary = emergencySummary(r);
    expect(summary.financialPolicy).toBe("DISABLED");
    expect(summary.headline).toMatch(/PARTIAL/);
    expect(summary.headline).toMatch(/financial policy is disabled/);
    expect(summary.lines.join("\n")).toMatch(/pause cre: FAILED — the Local Bridge is offline/);
  });

  it("LIVE-017b a failed policy disable is FAILED, not PARTIAL, and says the agent may still act", async () => {
    const r = await runEmergencyLock(lock(), actions({
      async disablePolicy() { return { ok: false, verification: "", detail: "signer rejected" }; },
    }));
    expect(r.state).toBe("FAILED");
    expect(r.financialPolicyDisabled).toBe(false);
    // The other steps were still attempted.
    expect(r.steps.find((s) => s.step === "STOP_RUNTIME")!.outcome).toBe("SUCCEEDED");
    expect(emergencySummary(r).headline).toMatch(/may still be able to move value/);
  });

  it("LIVE-039 repeated and concurrent invocations are safe and do not hide prior success", async () => {
    let creAttempts = 0;
    let revokeAttempts = 0;
    const flaky = actions({
      async pauseCre() { creAttempts += 1; return creAttempts === 1 ? { ok: false, verification: "", detail: "bridge offline" } : { ok: true, verification: "PAUSED", detail: "paused" }; },
      async revokeIdentity() { revokeAttempts += 1; return { ok: true, verification: "revoked", detail: "revoked" }; },
    });

    const first = await runEmergencyLock(lock({ includeIdentityRevocation: true }), flaky);
    expect(first.state).toBe("PARTIAL");
    expect(revokeAttempts).toBe(1);

    // Retry the SAME record. Steps that succeeded are not re-run — a retry must not undo anything
    // or double-execute the identity revocation.
    const second = await runEmergencyLock(first, flaky);
    expect(second.state).toBe("COMPLETE");
    expect(creAttempts).toBe(2);
    expect(revokeAttempts).toBe(1);
    expect(second.steps.find((s) => s.step === "PAUSE_CRE")!.attempts).toBe(2);
    expect(second.steps.find((s) => s.step === "DISABLE_POLICY")!.attempts).toBe(1);

    // Two operators pressing simultaneously against one record converge rather than conflict.
    const [a, b] = await Promise.all([runEmergencyLock(second, flaky), runEmergencyLock(second, flaky)]);
    expect(a.state).toBe("COMPLETE");
    expect(b.state).toBe("COMPLETE");
    expect(a.financialPolicyDisabled && b.financialPolicyDisabled).toBe(true);
  });

  it("LIVE-017c steps that do not apply are NOT_APPLICABLE, not failures", async () => {
    const r = await runEmergencyLock(
      newEmergencyLock({ lockId: "l", deploymentId: "d", idempotencyKey: "idem_x", initiatedBy: "u", nowMs: NOW, includeIdentityRevocation: false, applicability: { creWorkflowExists: false, runtimeExists: true, identityExists: true } }),
      actions(),
    );
    // This deployment has no CRE workflow — reporting that as a failure would make every emergency
    // lock here a PARTIAL and train operators to ignore the word.
    expect(r.steps.find((s) => s.step === "PAUSE_CRE")!.outcome).toBe("NOT_APPLICABLE");
    expect(r.steps.find((s) => s.step === "REVOKE_IDENTITY")!.outcome).toBe("NOT_APPLICABLE");
    expect(r.state).toBe("COMPLETE");
  });
});

/* ══════════════════════════ runtime + fencing ══════════════════════════ */

describe("runtime monitoring", () => {
  const inputs = (over: Partial<RuntimeObservationInputs> = {}): RuntimeObservationInputs => ({
    containerRunning: true, containerHealth: "healthy", restartsInWindow: 0, observedImageDigest: `sha256:${"1".repeat(64)}`,
    lastHeartbeatMs: NOW - 1000, controlPlaneReachable: true, modelGatewayReachable: true,
    adapterBrokerReachable: true, contextlockBrokerReachable: true, eventCursorAgeMs: 1000,
    credentialValid: true, credentialExpiresAtMs: NOW + 600_000, strategyCheckpointAgeMs: 1000,
    paused: false, stopping: false, processStartedAtMs: NOW - 120_000, nowMs: NOW, ...over,
  });

  it("LIVE-046 a running process with an unreachable broker is DEGRADED, not HEALTHY", () => {
    expect(evaluateRuntime(inputs()).state).toBe("HEALTHY");

    const v = evaluateRuntime(inputs({ contextlockBrokerReachable: false }));
    expect(v.state).toBe("DEGRADED");
    expect(v.mayStartNewWork).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/cannot obtain authorization for any action/);
    // Docker still says the container is running. That is not health.
    expect(inputs({ contextlockBrokerReachable: false }).containerRunning).toBe(true);

    for (const [k, label] of [["modelGatewayReachable", "Model Gateway"], ["adapterBrokerReachable", "Adapter Broker"], ["controlPlaneReachable", "control plane"]] as const) {
      expect(evaluateRuntime(inputs({ [k]: false })).state, k).toBe("DEGRADED");
      expect(evaluateRuntime(inputs({ [k]: false })).reasons.join(" ")).toContain(label);
    }
    // An expired or invalid credential is a runtime that cannot work.
    expect(evaluateRuntime(inputs({ credentialValid: false })).state).toBe("DEGRADED");
    expect(evaluateRuntime(inputs({ credentialExpiresAtMs: NOW - 1 })).state).toBe("DEGRADED");
    // Stale cursor or checkpoint: deciding on an old view.
    expect(evaluateRuntime(inputs({ eventCursorAgeMs: 10 * 60_000 })).reasons.join(" ")).toMatch(/stale view/);
    expect(evaluateRuntime(inputs({ strategyCheckpointAgeMs: 30 * 60_000 })).state).toBe("DEGRADED");
  });

  it("LIVE-026 a crash loop is detected rather than looking like a slow start", () => {
    const looping = evaluateRuntime(inputs({ restartsInWindow: DEFAULT_RUNTIME_POLICY.crashLoopRestarts, lastHeartbeatMs: null, processStartedAtMs: NOW - 500 }));
    expect(looping.state).toBe("CRASH_LOOP");
    expect(looping.reasons.join(" ")).toMatch(/not staying up/);

    expect(evaluateRuntime(inputs({ lastHeartbeatMs: null, processStartedAtMs: NOW - 1000 })).state).toBe("STARTING");
    expect(evaluateRuntime(inputs({ lastHeartbeatMs: null, processStartedAtMs: NOW - 120_000 })).state).toBe("FAILED");
    expect(evaluateRuntime(inputs({ containerRunning: false })).state).toBe("STOPPED");
    expect(evaluateRuntime(inputs({ paused: true })).state).toBe("PAUSED");
    expect(evaluateRuntime(inputs({ stopping: true })).state).toBe("STOPPING");
  });

  it("LIVE-046b health never implies authority", () => {
    expect(evaluateRuntime(inputs()).note).toBe(RUNTIME_HEALTH_NOTE);
    expect(RUNTIME_HEALTH_NOTE).toMatch(/says nothing about financial authority/);
    expect(runtimeObservation(evaluateRuntime(inputs()), NOW).state).toBe("HEALTHY");
    expect(runtimeObservation(evaluateRuntime(inputs({ paused: true })), NOW).state).toBe("BLOCKED");
  });

  it("LIVE-037 an old runtime revision is fenced the instant a new one activates", () => {
    const fence = new RuntimeRevisionFence(() => NOW);
    fence.activate("guardian", "rev_1");
    expect(() => fence.assertActive("guardian", "rev_1")).not.toThrow();

    const fenced = fence.activate("guardian", "rev_2")!;
    expect(fenced.revisionId).toBe("rev_1");
    expect(fenced.supersededBy).toBe("rev_2");

    // The stale container may still be physically running. It is now powerless.
    const r = reasonOf(() => fence.assertActive("guardian", "rev_1"));
    expect(r).toBe(FENCE_REASONS.FENCED);
    expect(() => fence.assertActive("guardian", "rev_1")).toThrow(/credential is no longer honoured/);
    expect(fence.isFenced("rev_1")).toBe(true);
    expect(() => fence.assertActive("guardian", "rev_2")).not.toThrow();

    // Fencing is keyed on the REVISION, so every token it was ever issued is refused at once —
    // including one minted a second before the switch.
    expect(reasonOf(() => fence.assertActive("guardian", "rev_1"))).toBe(FENCE_REASONS.FENCED);

    // A revision nobody activated is refused for a different, correctly-named reason.
    expect(reasonOf(() => fence.assertActive("guardian", "rev_99"))).toBe(FENCE_REASONS.NOT_ACTIVE);
  });

  it("LIVE-019 a rollback re-activates the previous revision and un-fences it", () => {
    const fence = new RuntimeRevisionFence(() => NOW);
    fence.activate("guardian", "rev_1");
    fence.activate("guardian", "rev_2");
    expect(fence.isFenced("rev_1")).toBe(true);

    // Roll back. The target must come up with a working credential, or the rollback would appear
    // to succeed while doing nothing.
    fence.activate("guardian", "rev_1", "rolled back");
    expect(fence.isFenced("rev_1")).toBe(false);
    expect(fence.isFenced("rev_2")).toBe(true);
    expect(() => fence.assertActive("guardian", "rev_1")).not.toThrow();
    expect(reasonOf(() => fence.assertActive("guardian", "rev_2"))).toBe(FENCE_REASONS.FENCED);
    expect(fence.activeRevision("guardian")).toBe("rev_1");
  });

  it("LIVE-020 two agents' revisions are fenced independently", () => {
    const fence = new RuntimeRevisionFence(() => NOW);
    fence.activate("guardian", "g_rev_1");
    fence.activate("rebalancer", "r_rev_1");
    fence.activate("guardian", "g_rev_2");
    // Rotating one agent must not fence another's runtime.
    expect(() => fence.assertActive("rebalancer", "r_rev_1")).not.toThrow();
    expect(fence.isFenced("g_rev_1")).toBe(true);
    expect(fence.fencedRevisions().map((f) => f.revisionId)).toEqual(["g_rev_1"]);
  });

  it("LIVE-025b the LIVE badge requires everything, including a CURRENT policy reading", () => {
    const healthy = { runtime: "HEALTHY" as const, policyEnabled: true, policyIsCurrent: true, identityActive: true, requiredAdapters: [], creRequired: false, creActive: null };
    expect(agentIsLive(healthy).live).toBe(true);

    // A deliberately inactive deployment is not LIVE.
    expect(agentIsLive({ ...healthy, policyEnabled: false }).reasons).toContain("the ContextLock policy is disabled");
    expect(agentIsLive({ ...healthy, runtime: "STOPPED" }).live).toBe(false);
    // A stale reading cannot make an agent LIVE — the badge is a claim about right now.
    expect(agentIsLive({ ...healthy, policyIsCurrent: false }).reasons).toContain("the policy reading is not current");
    expect(agentIsLive({ ...healthy, policyEnabled: null }).reasons).toContain("the policy state is unknown");

    // An agent whose Blueprint requires CRE cannot be LIVE without it (§25.26).
    expect(agentIsLive({ ...healthy, creRequired: true, creActive: false }).reasons).toContain("this agent requires a CRE workflow and it is not active");
    expect(agentIsLive({ ...healthy, creRequired: true, creActive: null }).live).toBe(false);
    expect(agentIsLive({ ...healthy, creRequired: true, creActive: true }).live).toBe(true);

    // A required adapter that is not healthy blocks it too.
    const degraded = { adapterId: "aave-v3", adapterVersion: "1.2.0", state: "DEGRADED" as const, lastSuccessAtMs: null, lastFailureAtMs: null, latencyMsP50: null, latencyMsP95: null, recentErrorRate: 1, dataFreshnessMs: null, lastProviderReason: null, lastCheckedAtMs: NOW, disabledReason: null };
    expect(agentIsLive({ ...healthy, requiredAdapters: [degraded] }).reasons).toContain("adapter aave-v3 is DEGRADED");
  });
});

/* ══════════════════════════ alerts ══════════════════════════ */

describe("the alert engine", () => {
  const engine = () => new AlertEngine();
  const raise = (e: AlertEngine, over: Record<string, unknown> = {}) =>
    e.raise({ rule: "ADAPTER_STALE", severity: "WARNING", projectId: "prj_1", deploymentId: "dep_1", subject: "aave-v3", reason: "no data for 12m", nowMs: NOW, ...over } as never);

  it("LIVE-049 repeated observations aggregate, they do not create one alert per poll", () => {
    const e = engine();
    const first = raise(e);
    expect(first.created).toBe(true);
    expect(first.alert.occurrences).toBe(1);

    // A 15s polling loop over an hour would file 240 rows. It files one.
    for (let i = 1; i <= 240; i++) raise(e, { nowMs: NOW + i * 15_000 });
    const all = e.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.occurrences).toBe(241);
    expect(all[0]!.firstSeenAtMs).toBe(NOW);
    expect(all[0]!.lastSeenAtMs).toBe(NOW + 240 * 15_000);

    // A different subject is a different problem.
    raise(e, { subject: "the-graph" });
    expect(e.all()).toHaveLength(2);
    expect(fingerprintOf("ADAPTER_STALE", "dep_1", "aave-v3")).not.toBe(fingerprintOf("ADAPTER_STALE", "dep_1", "the-graph"));
  });

  it("LIVE-042b alerts carry states, and severity escalates but never de-escalates", () => {
    const e = engine();
    const { alert } = raise(e);
    expect(alert.state).toBe("OPEN");

    e.acknowledge(alert.alertId, "usr_op", NOW + 1000);
    expect(e.get(alert.alertId)!.state).toBe("ACKNOWLEDGED");
    expect(e.get(alert.alertId)!.acknowledgedBy).toBe("usr_op");

    raise(e, { severity: "CRITICAL", nowMs: NOW + 2000 });
    expect(e.get(alert.alertId)!.severity).toBe("CRITICAL");
    // A problem that was critical once stays critical until someone resolves it deliberately.
    raise(e, { severity: "WARNING", nowMs: NOW + 3000 });
    expect(e.get(alert.alertId)!.severity).toBe("CRITICAL");
  });

  it("LIVE-050b a critical security drift cannot be auto-resolved by a later poll", () => {
    const e = engine();
    const { alert } = e.raise({ rule: "POLICY_UNEXPECTEDLY_ENABLED", severity: "CRITICAL", projectId: "p", deploymentId: "dep_1", subject: "policy 0xabc", reason: "chain says enabled", nowMs: NOW });
    expect(alert.requiresReconciliation).toBe(true);

    // The next poll comes back normal. The policy being disabled again does not un-happen the fact
    // that it was enabled.
    expect(e.autoResolve("POLICY_UNEXPECTEDLY_ENABLED", "dep_1", "policy 0xabc", NOW + 60_000)).toBeNull();
    expect(e.get(alert.alertId)!.state).toBe("OPEN");

    // A person resolving it must supply evidence.
    expect(reasonOf(() => e.resolve(alert.alertId, { actorId: "usr_op", evidence: null, nowMs: NOW + 1000 }))).toBe(ALERT_REASONS.RECONCILIATION_REQUIRED);
    expect(reasonOf(() => e.resolve(alert.alertId, { actorId: "usr_op", evidence: "looked ok", nowMs: NOW + 1000 }))).toBe(ALERT_REASONS.RECONCILIATION_REQUIRED);

    const resolved = e.resolve(alert.alertId, { actorId: "usr_op", evidence: "Enabled at 14:02 by a deploy script run by [an engineer]; re-disabled at 14:09; tx 0xabc reviewed.", nowMs: NOW + 2000 });
    expect(resolved.state).toBe("RESOLVED");
    expect(resolved.resolutionEvidence).toMatch(/re-disabled/);

    // Conditions that genuinely clear on their own still can.
    const { alert: stale } = e.raise({ rule: "ADAPTER_STALE", severity: "WARNING", projectId: "p", deploymentId: "dep_1", subject: "the-graph", reason: "stale", nowMs: NOW });
    expect(stale.requiresReconciliation).toBe(false);
    expect(e.autoResolve("ADAPTER_STALE", "dep_1", "the-graph", NOW + 1000)!.state).toBe("RESOLVED");
  });

  it("LIVE-027 the mandated alert rules exist and map from observed drift", () => {
    for (const rule of ["RUNTIME_CRASH_LOOP", "CRE_TELEMETRY_STALE", "CRE_FAILURE_SPIKE", "ADAPTER_STALE", "ADAPTER_UNAVAILABLE",
      "POLICY_UNEXPECTEDLY_ENABLED", "POLICY_UNEXPECTEDLY_DISABLED", "ENS_IDENTITY_CHANGED", "ADMIN_CHANGED", "BYTECODE_DRIFT",
      "REPEATED_DENY", "PROMPT_INJECTION_ATTEMPTS", "BUDGET_WARNING", "TRANSACTION_REVERT_SPIKE", "BRIDGE_DISCONNECTED", "CHAIN_OBSERVER_STALE"]) {
      expect(ALERT_RULES as readonly string[], rule).toContain(rule);
    }
    for (const r of ["POLICY_UNEXPECTEDLY_ENABLED", "ADMIN_CHANGED", "BYTECODE_DRIFT", "RUNTIME_IMAGE_DRIFT", "ENS_IDENTITY_CHANGED"]) {
      expect(REQUIRES_RECONCILIATION.has(r as never), r).toBe(true);
    }

    const args = alertForDrift(
      { kind: "BYTECODE_DRIFT", severity: "CRITICAL", subject: "ContextLockExecutorV2", expected: "0xaa", observed: "0xbb", detail: "code changed", observedAtMs: NOW, blockNumber: "100", requiresReconciliation: true },
      { projectId: "p", deploymentId: "dep_1" },
    );
    expect(args).toMatchObject({ rule: "BYTECODE_DRIFT", severity: "CRITICAL", subject: "ContextLockExecutorV2" });
    expect(args.evidence).toMatchObject({ expected: "0xaa", observed: "0xbb", blockNumber: "100" });
  });

  it("LIVE-027b a resolved alert that recurs becomes a new row, not a reopened one", () => {
    const e = engine();
    const { alert } = raise(e);
    e.resolve(alert.alertId, { actorId: "u", evidence: null, nowMs: NOW + 1000 });
    const again = raise(e, { nowMs: NOW + 2000 });
    expect(again.created).toBe(true);
    expect(again.alert.alertId).not.toBe(alert.alertId);
    expect(again.alert.occurrences).toBe(1);
  });

  it("LIVE-003d alert payloads pass the same secret scanner", () => {
    const e = engine();
    const { alert } = e.raise({ rule: "ADAPTER_UNAVAILABLE", severity: "WARNING", projectId: "p", deploymentId: "d", subject: "acme", reason: "502", evidence: { status: 502, host: "api.acme.test" }, nowMs: NOW });
    expect(scanForSecrets(alert, "alert-payload")).toEqual([]);
    // And the scanner really fires on an alert that picked one up.
    expect(scanForSecrets({ evidence: { authorization: CANARIES.jwt } }, "alert-payload").length).toBeGreaterThan(0);
  });
});

/* ══════════════════════════ OpenTelemetry ══════════════════════════ */

describe("OpenTelemetry", () => {
  it("LIVE-045 high-cardinality identifiers are prohibited as metric labels", () => {
    const t = new NoopTelemetry();
    expect(() => t.counter("agent_runs_total", 1, { deployment_id: "dep_1", agent_id: "guardian" })).not.toThrow();

    for (const label of ["tx_hash", "txHash", "wallet_address", "correlation_id", "correlationId", "capability_id", "block_number", "trace_id"]) {
      const r = reasonOf(() => t.counter("agent_runs_total", 1, { [label]: "x" } as never));
      expect(r, label).toBe(OTEL_REASONS.HIGH_CARDINALITY);
    }
    expect(() => t.counter("agent_runs_total", 1, { tx_hash: "0xabc" } as never))
      .toThrow(/one time series per value would be created/);

    // A label nobody declared is refused too — an allow-list, not a deny-list.
    expect(reasonOf(() => t.counter("agent_runs_total", 1, { something_new: "x" } as never))).toBe(OTEL_REASONS.UNKNOWN_LABEL);
    expect(reasonOf(() => t.counter("not_a_metric" as never, 1))).toBe(OTEL_REASONS.UNKNOWN_METRIC);
  });

  it("LIVE-024d every metric §25.24 mandates is declared, with bounded labels", () => {
    for (const m of ["agent_runs_total", "agent_decisions_total", "agent_actions_total", "agent_action_failures_total",
      "capabilities_issued_total", "capabilities_rejected_total", "runtime_health", "runtime_restarts_total",
      "adapter_requests_total", "adapter_errors_total", "adapter_latency", "cre_sync_age", "chain_sync_age",
      "policy_state", "model_requests_total", "model_input_tokens", "model_output_tokens", "model_errors_total"]) {
      expect(METRICS as readonly string[], m).toContain(m);
    }
    for (const l of FORBIDDEN_METRIC_LABELS) expect(ALLOWED_METRIC_LABELS as readonly string[], l).not.toContain(l);

    // A current-state gauge is numeric, not a label — otherwise every state the system has ever
    // been in shows simultaneously and never returns to zero.
    expect(POLICY_STATE_GAUGE).toEqual({ UNKNOWN: -1, DISABLED: 0, ENABLED: 1 });
    const t = new NoopTelemetry();
    t.gauge("policy_state", POLICY_STATE_GAUGE.DISABLED, { deployment_id: "dep_1" });
    expect(t.emitted).toContainEqual({ metric: "policy_state", value: 0, labels: { deployment_id: "dep_1" } });
  });

  it("LIVE-021 span attributes are scanned by the same recursive scanner", () => {
    const t = new NoopTelemetry();
    expect(() => t.startSpan("agent.run", { deployment_id: "dep_1", correlation_id: "corr_1" })).not.toThrow();
    // Instrumenting code tends to attach "whatever might be useful", which is how a prompt reaches
    // a vendor.
    expect(() => t.startSpan("agent.run", { systemPrompt: "you are..." })).toThrow(RedactionError);
    expect(() => t.startSpan("agent.run", { nested: { apiKey: CANARIES.openaiKey } })).toThrow(RedactionError);
    expect(() => assertSpanAttributesSafe({ chainOfThought: "..." })).toThrow(RedactionError);

    const span = t.startSpan("agent.run", { deployment_id: "d" });
    expect(() => span.setAttribute("privateThreshold", 500)).toThrow(RedactionError);
    expect(() => span.end({ outcome: "ALLOW" })).not.toThrow();
  });

  it("LIVE-047 telemetry is not the audit ledger — an exporter that always throws loses no event", () => {
    /*
     * §25.23. Structural first: nothing in studio-events imports the telemetry layer, so a broken
     * exporter cannot reach the audit path at all.
     */
    for (const f of ["event.ts", "store.ts", "redaction.ts", "correlation.ts", "index.ts"]) {
      const src = readFileSync(`packages/studio-events/src/${f}`, "utf8");
      // IMPORT lines only. Grepping the whole file would fire on the comments that explain why
      // this separation exists, which is the opposite of useful.
      const imports = src.split("\n").filter((l) => /^\s*(import|export)\s.*\sfrom\s/.test(l) || /^\s*(import|export)\s*\(/.test(l));
      for (const line of imports) {
        expect(line.toLowerCase(), `${f} must not import telemetry: ${line.trim()}`).not.toMatch(/opentelemetry|otel|control-plane/);
      }
    }

    // Behavioural: an exporter that throws on every call, and a full event stream written through it.
    class ExplodingTelemetry extends NoopTelemetry {
      override counter(): void { throw new Error("OTLP collector unreachable"); }
      override gauge(): void { throw new Error("OTLP collector unreachable"); }
      override histogram(): void { throw new Error("OTLP collector unreachable"); }
      override startSpan(): never { throw new Error("OTLP collector unreachable"); }
    }
    const telemetry = new ExplodingTelemetry();
    const store = new InMemoryEventStore();

    for (let i = 0; i < 10; i++) {
      // The audit write happens first and unconditionally; telemetry is best-effort beside it.
      store.append({
        organizationId: null, projectId: "p", deploymentId: "d", agentId: "guardian",
        source: "CONTEXTLOCK", type: "DECISION_ALLOW", severity: "INFO", timestamp: NOW + i,
        correlationId: `corr_${i}`, agentRunId: null, modelRunId: null, strategyEvaluationId: null,
        creExecutionId: null, authorizationId: null, capabilityId: null, chainId: null,
        blockNumber: null, txHash: null, creWorkflowId: null, adapterId: null, runtimeRevision: null,
        buildRevision: 1, deploymentRevision: "rev_1", correctsEventId: null, publicMetadata: {},
      }, NOW + i);
      try { telemetry.counter("agent_decisions_total", 1, { verdict: "ALLOW" }); } catch { /* telemetry is allowed to fail */ }
    }

    expect(store.count()).toBe(10);
    expect(store.query({ type: "DECISION_ALLOW" })).toHaveLength(10);
  });

  it("LIVE-047b no external vendor is mandatory, and versions are pinned after checking", () => {
    expect(OTEL_DISABLED.enabled).toBe(false);
    expect(OTEL_DISABLED.otlpTracesEndpoint).toBeNull();
    expect(OTEL_DISABLED.otlpMetricsEndpoint).toBeNull();

    // Stable packages on their stable majors; exporters on the experimental line, which is why
    // logs are deliberately not used here.
    expect(OTEL_VERSIONS["@opentelemetry/api"]).toBe("1.9.1");
    expect(OTEL_VERSIONS["@opentelemetry/sdk-trace-node"]).toMatch(/^2\./);
    expect(OTEL_VERSIONS["@opentelemetry/sdk-metrics"]).toMatch(/^2\./);
    expect(OTEL_VERSIONS["@opentelemetry/exporter-trace-otlp-http"]).toMatch(/^0\./);
    expect(Object.keys(OTEL_VERSIONS)).not.toContain("@opentelemetry/sdk-logs");

    // With telemetry disabled the guards still run, so a cardinality bug is caught in development
    // rather than on the day someone enables the exporter.
    const t = new NoopTelemetry();
    expect(reasonOf(() => t.counter("agent_runs_total", 1, { tx_hash: "0x" } as never))).toBe(OTEL_REASONS.HIGH_CARDINALITY);
  });
});
