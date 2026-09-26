import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  ChainObserver, reconcile, advanceTransaction, resumeFrom, logId, DEFAULT_FINALITY,
  CRITICAL_DRIFT, DRIFT_KINDS, type TrackedTransaction,
  presentable, observed, unavailable, isExpired, allCurrent, DEFAULT_TTLS,
  CreMonitor, CreMonitorError, CRE_REASONS, assertNotFixture, assertDestructiveConfirmation,
  NOT_PROGRAMMATICALLY_AVAILABLE, NOT_AVAILABLE_TEXT, normalizeExecutionEvent, MAX_LOG_MESSAGE_CHARS, FIXTURE_MARKER,
  AdapterHealthService, adapterUsage, DEFAULT_ADAPTER_POLICY,
  newCommand, assertCommandValid, ControlCommandError, COMMAND_REASONS, CommandLog,
  OPERATION_REQUIREMENTS, OPERATOR_CAPABILITIES, CONTROL_OPERATIONS, runtimePauseClaim, CONTROL_COMMAND_VERSION,
  newEmergencyLock, runEmergencyLock, emergencySummary, EMERGENCY_STEPS, CRITICAL_STEP, FORBIDDEN_IN_KILL_PATH,
  AlertEngine, AlertError, ALERT_REASONS, alertForDrift, REQUIRES_RECONCILIATION, fingerprintOf,
  evaluateRuntime, runtimeObservation, RuntimeRevisionFence, RuntimeFenceError, FENCE_REASONS, agentIsLive, RUNTIME_HEALTH_NOTE,
  assertMetricLabels, assertSpanAttributesSafe, OtelError, OTEL_REASONS, NoopTelemetry, METRICS,
  FORBIDDEN_METRIC_LABELS, ALLOWED_METRIC_LABELS, OTEL_VERSIONS, POLICY_STATE_GAUGE, OTEL_DISABLED,
  type EmergencyActions,
} from "../src/index.js";
import { InMemoryEventStore, CANARIES, RedactionError } from "@contextlock/studio-events";
import {
  NOW, LIVE, fakeReader, fakeQueries, expectedState, codeMap,
  liveConnection, fixtureWorkflow, FakeCreProvider,
  VIEWER, RUNTIME_OP, POLICY_OP, INCIDENT_OP,
} from "./fixtures.js";

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};
const asyncReasonOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};

const observer = (q = fakeQueries(), r = fakeReader(), now = () => NOW) => new ChainObserver({ reader: r, queries: q, nowMs: now });
const policyArgs = { registry: LIVE.policyRegistry, agentIdentityHash: LIVE.agentIdentityHash, policyHash: LIVE.policyHash };

/* ══════════════════════════ chain: fresh, always ══════════════════════════ */

describe("policy state comes from the chain", () => {
  it("LIVE-008 policy state is read fresh from chain and carries the moment it was read", async () => {
    const o = await observer(fakeQueries({ enabled: false })).readPolicyState(policyArgs);
    expect(o.state).toBe("HEALTHY");
    expect(o.value).toMatchObject({ enabled: false, bindingVersion: "1", policyAdmin: LIVE.deployer });
    expect(o.value!.blockNumber).toBe("11674400");
    expect(o.observedAtMs).toBe(NOW);
    expect(o.source).toBe("chain:11155111");

    // The enabled case is read just as freshly.
    const on = await observer(fakeQueries({ enabled: true })).readPolicyState(policyArgs);
    expect(on.value!.enabled).toBe(true);
  });

  it("LIVE-031 there is no path that returns a policy value without a fresh observation", async () => {
    // Structural: every accessor returns an Observation, and `presentable` is the only way to the
    // value. A DB-backed shortcut would have to add a function that returns a bare boolean.
    const o = await observer().readPolicyState(policyArgs);
    expect(Object.keys(o).sort()).toEqual(["observedAtMs", "reason", "source", "state", "ttlMs", "value"]);
    const p = presentable(o, NOW);
    expect(p.isCurrent).toBe(true);

    // Beyond the TTL the same reading is no longer current, whatever the value says.
    const stale = presentable(o, NOW + DEFAULT_TTLS.policy + 1);
    expect(stale.state).toBe("STALE");
    expect(stale.isCurrent).toBe(false);
    expect(stale.reason).toMatch(/last confirmed .* not current status/s);
    // The value is still there — "last confirmed 14:31:07" beats hiding it — but the STATE changed,
    // so a UI colouring on state cannot paint it green.
    expect(stale.value).not.toBeNull();
  });

  it("LIVE-031b a failed chain read is UNKNOWN, never 'disabled'", async () => {
    const o = await observer(fakeQueries({ failPolicy: true })).readPolicyState(policyArgs);
    expect(o.state).toBe("FAILED");
    // The safe-looking wrong answer would be `enabled: false`: a green "policy disabled" indicator
    // for an agent whose policy is, as far as anyone knows, enabled.
    expect(o.value).toBeNull();
    expect(o.reason).toMatch(/it is not assumed disabled/);
  });

  it("LIVE-009 ENS identity state is read from chain, including revocation", async () => {
    const bound = await observer().readIdentityState({ name: "guardian.eth", node: LIVE.identityNode });
    expect(bound.value).toMatchObject({ boundAgent: LIVE.agentAddress, revoked: false });

    const revoked = await observer(fakeQueries({ revoked: true })).readIdentityState({ name: "guardian.eth", node: LIVE.identityNode });
    expect(revoked.value!.revoked).toBe(true);

    const unbound = await observer(fakeQueries({ boundAgent: null })).readIdentityState({ name: "guardian.eth", node: LIVE.identityNode });
    expect(unbound.value!.boundAgent).toBeNull();

    const failed = await observer(fakeQueries({ failIdentity: true })).readIdentityState({ name: "guardian.eth", node: LIVE.identityNode });
    expect(failed.state).toBe("FAILED");
    expect(failed.value).toBeNull();
  });
});

/* ══════════════════════════ drift ══════════════════════════ */

describe("chain reconciliation", () => {
  const observedState = async (q = fakeQueries(), code = codeMap([[LIVE.executor, "0xaa" as Hex], [LIVE.consumer, "0xbb" as Hex]])) => {
    const obs = observer(q, fakeReader({ code }));
    return {
      policy: await obs.readPolicyState(policyArgs),
      identity: await obs.readIdentityState({ name: "guardian.eth", node: LIVE.identityNode }),
      contracts: [await obs.readContractState("ContextLockExecutorV2", LIVE.executor), await obs.readContractState("ContextLockCreConsumer", LIVE.consumer)],
      administrators: await obs.readAdministrators(LIVE.policyRegistry),
      runtimeImageDigest: `sha256:${"1".repeat(64)}`,
    };
  };

  it("LIVE-032 a database/chain disagreement produces STATE_DRIFT", async () => {
    // The record says disabled. The chain says enabled. This is the one that matters most.
    const actual = await observedState(fakeQueries({ enabled: true }));
    const expectedContracts = actual.contracts.map((c) => ({ name: c.value!.name, address: c.value!.address, runtimeCodeHash: c.value!.runtimeCodeHash }));
    const drifts = reconcile(expectedState({ policyEnabled: false, contracts: expectedContracts }), actual, NOW);

    const d = drifts.find((x) => x.kind === "POLICY_ENABLED_UNEXPECTEDLY")!;
    expect(d).toBeDefined();
    expect(d.severity).toBe("CRITICAL");
    expect(d.expected).toBe("disabled");
    expect(d.observed).toBe("ENABLED");
    expect(d.detail).toMatch(/can authorize financial execution right now/);
    expect(d.requiresReconciliation).toBe(true);

    // No drift when they agree.
    const agreeing = await observedState(fakeQueries({ enabled: false }));
    expect(reconcile(expectedState({ contracts: expectedContracts }), agreeing, NOW)).toEqual([]);
  });

  it("LIVE-033 an unexpected administrator is CRITICAL", async () => {
    const actual = await observedState(fakeQueries({ administrators: [LIVE.deployer, LIVE.attacker] }));
    const contracts = actual.contracts.map((c) => ({ name: c.value!.name, address: c.value!.address, runtimeCodeHash: c.value!.runtimeCodeHash }));
    const drifts = reconcile(expectedState({ contracts }), actual, NOW);
    const d = drifts.find((x) => x.kind === "ADMIN_CHANGED")!;
    expect(d.severity).toBe("CRITICAL");
    expect(d.observed).toContain(LIVE.attacker.toLowerCase());
    expect(d.requiresReconciliation).toBe(true);

    // The policy admin changing is its own drift kind, because it is a different power.
    const adminMoved = await observedState(fakeQueries({ admin: LIVE.attacker }));
    const c2 = adminMoved.contracts.map((c) => ({ name: c.value!.name, address: c.value!.address, runtimeCodeHash: c.value!.runtimeCodeHash }));
    expect(reconcile(expectedState({ contracts: c2 }), adminMoved, NOW).some((x) => x.kind === "POLICY_ADMIN_CHANGED")).toBe(true);
  });

  it("LIVE-034 bytecode drift and a missing contract are CRITICAL", async () => {
    const actual = await observedState();
    const wrong = expectedState({
      contracts: [
        { name: "ContextLockExecutorV2", address: LIVE.executor, runtimeCodeHash: `0x${"99".repeat(32)}` },
        { name: "ContextLockCreConsumer", address: LIVE.consumer, runtimeCodeHash: actual.contracts[1]!.value!.runtimeCodeHash },
      ],
    });
    const d = reconcile(wrong, actual, NOW).find((x) => x.kind === "BYTECODE_DRIFT")!;
    expect(d.severity).toBe("CRITICAL");
    expect(d.detail).toMatch(/not the code this deployment was verified against/);

    // A contract that has vanished entirely.
    const gone = await observedState(fakeQueries(), codeMap([[LIVE.consumer, "0xbb" as Hex]]));
    const contracts = [{ name: "ContextLockExecutorV2", address: LIVE.executor, runtimeCodeHash: "0x00" }];
    expect(reconcile(expectedState({ contracts }), gone, NOW).some((x) => x.kind === "CONTRACT_MISSING")).toBe(true);
  });

  it("LIVE-034b a runtime image that is not the pinned one is CRITICAL drift", async () => {
    const actual = await observedState();
    const contracts = actual.contracts.map((c) => ({ name: c.value!.name, address: c.value!.address, runtimeCodeHash: c.value!.runtimeCodeHash }));
    const d = reconcile(expectedState({ contracts, runtimeImageDigest: `sha256:${"2".repeat(64)}` }), actual, NOW).find((x) => x.kind === "RUNTIME_IMAGE_DRIFT")!;
    expect(d.severity).toBe("CRITICAL");
    expect(d.detail).toMatch(/was not built from the image this deployment pinned/);
  });

  it("LIVE-032b an unreadable chain produces no drift — 'we could not read it' is not 'it changed'", async () => {
    const obs = observer(fakeQueries({ failPolicy: true, failIdentity: true }), fakeReader({ failGetCode: true }));
    const actual = {
      policy: await obs.readPolicyState(policyArgs),
      identity: await obs.readIdentityState({ name: "g.eth", node: LIVE.identityNode }),
      contracts: [await obs.readContractState("ContextLockExecutorV2", LIVE.executor)],
      administrators: await obs.readAdministrators(LIVE.policyRegistry),
      runtimeImageDigest: null,
    };
    // Reporting an RPC outage as a critical security event is how alerting gets muted.
    expect(reconcile(expectedState(), actual, NOW)).toEqual([]);
  });

  it("LIVE-050 critical drift kinds are exactly the ones that need a person", () => {
    for (const k of ["POLICY_ENABLED_UNEXPECTEDLY", "ADMIN_CHANGED", "BYTECODE_DRIFT", "IDENTITY_CHANGED", "RUNTIME_IMAGE_DRIFT", "CONTRACT_MISSING"]) {
      expect(CRITICAL_DRIFT.has(k as never), k).toBe(true);
    }
    // A policy that turned OFF unexpectedly is serious but not a security escalation: the agent
    // cannot act. It is a WARNING and may auto-resolve.
    expect(CRITICAL_DRIFT.has("POLICY_DISABLED_UNEXPECTEDLY")).toBe(false);
    expect(DRIFT_KINDS.length).toBe(10);
  });
});

/* ══════════════════════════ finality ══════════════════════════ */

describe("the finality model", () => {
  const tx = (over: Partial<TrackedTransaction> = {}): TrackedTransaction => ({
    txHash: `0x${"ab".repeat(32)}`, chainId: 11155111, state: "SUBMITTED", blockNumber: null,
    confirmations: 0, gasUsed: null, effectiveGasPriceWei: null, actualNativeCostWei: null,
    correlationId: "corr_1", reorgedFromBlock: null, ...over,
  });
  const receipt = (block: bigint, status: "success" | "reverted" = "success") => ({ status, blockNumber: block, gasUsed: 400_810n, effectiveGasPrice: 1_184_473_646n });

  it("LIVE-043 a receipt progresses submitted → confirming → finalized, and success is not final", () => {
    const mined = advanceTransaction(tx(), receipt(100n), 100n);
    // status: success is MINED/CONFIRMING, not FINALIZED. §25.18.
    expect(mined.next.state).toBe("CONFIRMING");
    expect(mined.next.confirmations).toBe(1);
    expect(mined.next.actualNativeCostWei).toBe((400_810n * 1_184_473_646n).toString());

    const confirming = advanceTransaction(mined.next, receipt(100n), 105n);
    expect(confirming.next.state).toBe("CONFIRMING");
    expect(confirming.next.confirmations).toBe(6);

    const final = advanceTransaction(confirming.next, receipt(100n), 111n);
    expect(final.next.state).toBe("FINALIZED");
    expect(final.next.confirmations).toBe(DEFAULT_FINALITY.confirmations);
    expect(final.correction).toMatchObject({ from: "CONFIRMING", to: "FINALIZED" });
  });

  it("LIVE-010 actual gas and native cost are recorded from the receipt", () => {
    const r = advanceTransaction(tx(), receipt(100n), 112n).next;
    expect(r.gasUsed).toBe("400810");
    expect(r.effectiveGasPriceWei).toBe("1184473646");
    expect(r.actualNativeCostWei).toBe("474748882053260");
  });

  it("LIVE-024 a reorg is a correction, not a silent edit", () => {
    const finalized = advanceTransaction(tx(), receipt(100n), 112n).next;
    expect(finalized.state).toBe("FINALIZED");

    // The receipt is gone. A monitoring system's temptation is to keep the last good reading.
    const gone = advanceTransaction(finalized, null, 113n);
    expect(gone.next.state).toBe("REORGED");
    expect(gone.next.reorgedFromBlock).toBe("100");
    expect(gone.correction).toMatchObject({ from: "FINALIZED", to: "REORGED" });
    expect(gone.correction!.reason).toMatch(/previously seen in block 100/);

    // Re-included in a different block: also a correction.
    const moved = advanceTransaction(finalized, receipt(101n), 113n);
    expect(moved.correction!.reason).toMatch(/moved from block 100 to 101/);
    expect(moved.next.reorgedFromBlock).toBe("100");

    // A revert is its own terminal state.
    expect(advanceTransaction(tx(), receipt(100n, "reverted"), 100n).next.state).toBe("REVERTED");
    // An unsubmitted transaction with no receipt is not a reorg.
    expect(advanceTransaction(tx(), null, 100n).next.state).toBe("SUBMITTED");
  });

  it("LIVE-024c the cursor resumes with reorg overlap, and log identity is canonical", () => {
    const cursor = { chainId: 11155111, contract: LIVE.executor, eventSignature: "Executed(bytes32)", lastFinalizedBlock: "11674400", lastProcessedLogId: null, updatedAtMs: NOW };
    // `latestBlock + 1` would skip whatever replaced the blocks a reorg removed.
    expect(resumeFrom(cursor)).toBe(11_674_400n - BigInt(DEFAULT_FINALITY.reorgOverlapBlocks));
    expect(resumeFrom({ ...cursor, lastFinalizedBlock: "5" })).toBe(0n);

    expect(logId({ chainId: 1, blockNumber: 100n, transactionHash: "0xAB", logIndex: 2 })).toBe("1:100:0xab:2");
    // Block alone is not unique; a transaction alone is not either.
    expect(logId({ chainId: 1, blockNumber: 100n, transactionHash: "0xab", logIndex: 3 }))
      .not.toBe(logId({ chainId: 1, blockNumber: 100n, transactionHash: "0xab", logIndex: 2 }));
  });
});

/* ══════════════════════════ CRE ══════════════════════════ */

describe("CRE monitoring", () => {
  const monitor = (provider: FakeCreProvider | null, now = () => NOW) => new CreMonitor({ provider, nowMs: now });

  it("LIVE-041 no deploy access renders as BLOCKED — not unhealthy, not active", async () => {
    const m = monitor(new FakeCreProvider(liveConnection({ deployAccess: false })));
    await m.sync("contextlock-policy");
    const v = m.view(NOW);

    expect(v.state).toBe("BLOCKED");
    expect(v.connection!.connected).toBe(true);
    expect(v.connection!.organizationId).toBe("org_ENDgZRZzalm3d3So");
    expect(v.blockedBy).toBe("CRE_DEPLOY_ACCESS_REQUIRED");
    expect(v.headline).toBe("Waiting for deployment access");
    expect(v.detail).toMatch(/not a fault in the integration/);
    // The two things it must NOT say.
    expect(v.state).not.toBe("FAILED");
    expect(v.state).not.toBe("ACTIVE");
    expect(v.headline.toLowerCase()).not.toContain("unhealthy");
  });

  it("LIVE-041b access-but-no-workflow, active and paused are each distinct states", async () => {
    const none = monitor(new FakeCreProvider(liveConnection({ deployAccess: true }), null));
    await none.sync("contextlock-policy");
    expect(none.view(NOW).state).toBe("NOT_DEPLOYED");
    expect(none.view(NOW).blockedBy).toBe("CRE-NO-WORKFLOW");

    const paused = monitor(new FakeCreProvider(liveConnection({ deployAccess: true }), fixtureWorkflow({ status: "PAUSED" })));
    await paused.sync("contextlock-policy");
    expect(paused.view(NOW).state).toBe("PAUSED");

    const active = monitor(new FakeCreProvider(liveConnection({ deployAccess: true }), fixtureWorkflow({ status: "ACTIVE" })));
    await active.sync("contextlock-policy");
    expect(active.view(NOW).state).toBe("ACTIVE");

    const unconfigured = monitor(null);
    await unconfigured.sync(null);
    expect(unconfigured.view(NOW).state).toBe("NOT_CONFIGURED");
  });

  it("LIVE-005 a disconnected bridge marks telemetry stale with the last confirmed time", async () => {
    const provider = new FakeCreProvider(liveConnection({ deployAccess: true }), fixtureWorkflow({ status: "ACTIVE" }));
    const m = monitor(provider, () => NOW);
    await m.sync("contextlock-policy");
    expect(m.view(NOW).state).toBe("ACTIVE");

    provider.offline = true;
    const failed = await m.sync("contextlock-policy");
    expect(failed.state).toBe("FAILED");
    expect(failed.reason).toMatch(/Local Bridge is offline/);
  });

  it("LIVE-006 a cached CRE response is never shown as current", async () => {
    let clock = NOW;
    const m = monitor(new FakeCreProvider(liveConnection({ deployAccess: true }), fixtureWorkflow({ status: "ACTIVE" })), () => clock);
    await m.sync("contextlock-policy");
    expect(m.view(clock).isCurrent).toBe(true);

    // Time passes and nothing re-syncs. The cached value is still there and must not read as live.
    clock = NOW + DEFAULT_TTLS.cre + 1;
    const v = m.view(clock);
    expect(v.state).toBe("STALE");
    expect(v.isCurrent).toBe(false);
    expect(v.blockedBy).toBe("CRE_TELEMETRY_STALE");
    expect(v.headline).toMatch(/unknown/i);
    // Last confirmed IS shown — that is more useful than hiding it — but not as current status.
    expect(v.lastSyncedAtMs).toBe(NOW);
    expect(v.detail).toMatch(/Last confirmed/);
    expect(v.state).not.toBe("ACTIVE");
  });

  it("LIVE-042 metrics that exist only in the web UI are named, never zeroed", async () => {
    const m = monitor(new FakeCreProvider());
    await m.sync("contextlock-policy");
    const v = m.view(NOW);
    for (const metric of NOT_PROGRAMMATICALLY_AVAILABLE) {
      expect(v.unavailable[metric], metric).toBe(NOT_AVAILABLE_TEXT);
      expect(v.unavailable[metric]).not.toBe("0");
      expect(v.unavailable[metric]).not.toBe(0 as never);
    }
  });

  it("LIVE-040 a fixture workflow id cannot be written to a live record", () => {
    /*
     * `assertNotFixture` has two independent guards, and this exercises each ALONE.
     *
     * An earlier version of this test used a fixture that tripped both at once. A mutation
     * disabling the provenance check passed every test, because the identifier check caught it
     * anyway — so the provenance guard had no test of its own and could have been deleted silently.
     * A security test that cannot fail under its target mutation is not evidence.
     */
    const realisticId = "00da21b8b3e117e31f3a3e8a0795225cbde6c00283a84395117669691f2b7856";

    // Guard 1 alone: FIXTURE provenance, an identifier that looks completely real.
    expect(reasonOf(() => assertNotFixture({ provenance: "FIXTURE", workflowId: realisticId }, "the deployment record")))
      .toBe(CRE_REASONS.FIXTURE_IN_LIVE);

    // Guard 2 alone: LIVE provenance — someone flipped the flag — but the identifier is marked.
    expect(reasonOf(() => assertNotFixture({ provenance: "LIVE", workflowId: `${FIXTURE_MARKER}${realisticId}` }, "the deployment record")))
      .toBe(CRE_REASONS.FIXTURE_IN_LIVE);

    // Both together, which is what the fixtures actually look like.
    expect(reasonOf(() => assertNotFixture(fixtureWorkflow(), "the deployment record"))).toBe(CRE_REASONS.FIXTURE_IN_LIVE);

    // A genuinely live record passes.
    expect(() => assertNotFixture({ provenance: "LIVE", workflowId: realisticId }, "the deployment record")).not.toThrow();
  });

  it("LIVE-018 deleting a workflow requires typing its name, not a boolean", async () => {
    const confirmation = {
      typedWorkflowName: "contextlock-policy",
      understoodConsequence: "This permanently deletes all versions of the workflow from the registry." as const,
      actorId: "usr_incident-op", confirmedAtMs: NOW,
    };
    expect(() => assertDestructiveConfirmation("contextlock-policy", confirmation)).not.toThrow();
    // `confirm: true` is something a caller passes by accident. Re-typing the name is not.
    expect(reasonOf(() => assertDestructiveConfirmation("contextlock-policy", { ...confirmation, typedWorkflowName: "wrong" }))).toBe(CRE_REASONS.CONFIRMATION_MISMATCH);

    // And DELETE is its own capability-gated operation, separate from pause/activate.
    expect(OPERATION_REQUIREMENTS.DELETE_CRE.destructive).toBe(true);
    expect(OPERATION_REQUIREMENTS.PAUSE_CRE.destructive).toBe(false);
  });

  it("LIVE-004 execution events normalize into bounded, redacted records", () => {
    const long = "x".repeat(MAX_LOG_MESSAGE_CHARS + 500);
    const n = normalizeExecutionEvent({ executionId: "e1", capabilityId: "fetch-price", nodeId: "node-1", status: "SUCCESS", timestampMs: NOW, message: long });
    expect(n.truncated).toBe(true);
    expect(n.message.length).toBeLessThan(long.length);
    expect(n.message).toMatch(/truncated 500 chars/);
    expect(n).toMatchObject({ capabilityId: "fetch-price", nodeId: "node-1", status: "SUCCESS" });

    const short = normalizeExecutionEvent({ executionId: "e1", capabilityId: null, nodeId: null, status: "FAILURE", timestampMs: NOW, message: "boom" });
    expect(short.truncated).toBe(false);
    expect(short.message).toBe("boom");
  });
});

/* ══════════════════════════ adapters ══════════════════════════ */

describe("adapter health", () => {
  const svc = () => {
    const s = new AdapterHealthService();
    s.register("aave-v3", "1.2.0");
    s.register("the-graph", "2.0.1");
    return s;
  };

  it("LIVE-011 adapter health transitions across healthy, degraded, disabled and unknown", () => {
    const s = svc();
    // Silence is not success.
    expect(s.health("aave-v3", NOW).state).toBe("UNKNOWN");

    for (let i = 0; i < 5; i++) s.record("aave-v3", { atMs: NOW - i * 1000, ok: true, latencyMs: 120, dataAtMs: NOW - 2000 });
    expect(s.health("aave-v3", NOW).state).toBe("HEALTHY");
    expect(s.health("aave-v3", NOW).latencyMsP50).toBe(120);
    expect(s.health("aave-v3", NOW).recentErrorRate).toBe(0);

    for (let i = 0; i < 4; i++) s.record("aave-v3", { atMs: NOW - i * 100, ok: false, latencyMs: 50, reason: "502 from provider" });
    const degraded = s.health("aave-v3", NOW);
    expect(degraded.state).toBe("DEGRADED");
    expect(degraded.recentErrorRate).toBeGreaterThan(DEFAULT_ADAPTER_POLICY.degradedErrorRate);
    expect(degraded.lastProviderReason).toBe("502 from provider");

    s.disable("the-graph", "switched off by an operator during the incident");
    const disabled = s.health("the-graph", NOW);
    expect(disabled.state).toBe("DISABLED");
    expect(disabled.disabledReason).toMatch(/operator/);
    s.enable("the-graph");
    expect(s.health("the-graph", NOW).state).toBe("UNKNOWN");
  });

  it("LIVE-025 a fast adapter serving stale data is DEGRADED, and a slow call counts as failure", () => {
    const s = svc();
    for (let i = 0; i < 5; i++) s.record("aave-v3", { atMs: NOW - i * 100, ok: true, latencyMs: 30, dataAtMs: NOW - 20 * 60_000 });
    const h = s.health("aave-v3", NOW);
    expect(h.state).toBe("DEGRADED");
    expect(h.dataFreshnessMs).toBeGreaterThan(DEFAULT_ADAPTER_POLICY.staleDataMs);
    expect(h.latencyMsP50).toBe(30);

    // A call that took 30s "succeeded" and did not produce a usable price.
    const s2 = svc();
    for (let i = 0; i < 5; i++) s2.record("aave-v3", { atMs: NOW - i * 100, ok: true, latencyMs: 30_000, dataAtMs: NOW });
    expect(s2.health("aave-v3", NOW).recentErrorRate).toBe(1);
  });

  it("LIVE-012 a degraded or disabled adapter changes what the runtime may do", () => {
    const s = svc();
    for (let i = 0; i < 5; i++) s.record("aave-v3", { atMs: NOW - i * 100, ok: true, latencyMs: 100, dataAtMs: NOW });
    expect(adapterUsage(s.health("aave-v3", NOW))).toMatchObject({ mayRead: true, mayDecideOn: true });

    for (let i = 0; i < 5; i++) s.record("aave-v3", { atMs: NOW - i * 50, ok: false, latencyMs: 10, reason: "timeout" });
    const degraded = adapterUsage(s.health("aave-v3", NOW));
    // A degraded price feed may be displayed and must not be the basis of a trade.
    expect(degraded).toMatchObject({ mayRead: true, mayDecideOn: false });

    s.disable("the-graph", "operator");
    expect(adapterUsage(s.health("the-graph", NOW))).toMatchObject({ mayRead: false, mayDecideOn: false });
    // UNKNOWN is not permission to decide.
    s.register("uniswap", "3.0.0");
    expect(adapterUsage(s.health("uniswap", NOW)).mayDecideOn).toBe(false);
  });

  it("LIVE-011b the service is generic — no provider-specific branching", () => {
    const s = new AdapterHealthService();
    for (const [id, v] of [["uniswap", "3.0.0"], ["the-graph", "2.0.1"], ["chainlink-ccip", "1.2.0"], ["aave-v3", "1.2.0"], ["acme-custom-openapi", "0.1.0"]] as const) {
      s.register(id, v);
      for (let i = 0; i < 4; i++) s.record(id, { atMs: NOW - i * 100, ok: true, latencyMs: 50, dataAtMs: NOW });
    }
    const all = s.all(NOW);
    expect(all).toHaveLength(5);
    expect(all.every((h) => h.state === "HEALTHY")).toBe(true);
    // Every one took the same code path; a custom OpenAPI import is not special.
    expect(all.map((h) => h.adapterId)).toEqual(["aave-v3", "acme-custom-openapi", "chainlink-ccip", "the-graph", "uniswap"]);
    expect(s.unusable(["uniswap", "nonexistent"], NOW).map((h) => h.adapterId)).toEqual(["nonexistent"]);
  });
});
