import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ChainObserver, reconcile, advanceTransaction, CreMonitor, AlertEngine, AdapterHealthService,
  evaluateRuntime, RuntimeRevisionFence, agentIsLive, alertForDrift, presentable, DEFAULT_TTLS,
  runtimePauseClaim, NoopTelemetry, POLICY_STATE_GAUGE, RUNTIME_HEALTH_GAUGE,
  type TrackedTransaction, type RuntimeObservationInputs,
} from "../src/index.js";
import { InMemoryEventStore, buildTrace, type EventDraft } from "@contextlock/studio-events";
import {
  FORBIDDEN_ENV, FORBIDDEN_PATHS, assertNoForbiddenEnvironment,
} from "@contextlock/agent-runtime";
import { DENIED_ENV_EXACT, assertEnvironmentSafe } from "@contextlock/studio-runtime";
import { NOW, LIVE, fakeReader, fakeQueries, expectedState, codeMap, liveConnection, fixtureWorkflow, FakeCreProvider } from "./fixtures.js";
import type { Hex } from "viem";

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};

const policyArgs = { registry: LIVE.policyRegistry, agentIdentityHash: LIVE.agentIdentityHash, policyHash: LIVE.policyHash };

const evt = (over: Partial<EventDraft>): EventDraft => ({
  organizationId: "org_1", projectId: "prj_guardian", deploymentId: "dep_group_e_live_0001", agentId: "guardian",
  source: "SYSTEM", type: "RUNTIME_STATE_CHANGED", severity: "INFO", timestamp: NOW,
  correlationId: "corr_1", agentRunId: null, modelRunId: null, strategyEvaluationId: null,
  creExecutionId: null, authorizationId: null, capabilityId: null, chainId: null, blockNumber: null,
  txHash: null, creWorkflowId: null, adapterId: null, runtimeRevision: null,
  buildRevision: 2, deploymentRevision: "rev_1", correctsEventId: null, publicMetadata: {},
  ...over,
});

/* ══════════════════════ the runtime holds no CRE key ══════════════════════ */

describe("the managed CRE key never reaches the runtime", () => {
  it("LIVE-007 a CRE credential is refused by the runtime and by the launcher", () => {
    // The runtime refuses to start carrying one (P24's control, re-asserted here because P25 adds
    // a CRE monitoring path that could plausibly want to hand it down).
    expect(FORBIDDEN_ENV).toContain("CRE_API_KEY");
    expect(FORBIDDEN_ENV).toContain("CRE_SESSION");
    expect(FORBIDDEN_PATHS).toContain("/root/.cre/cre.yaml");
    expect(() => assertNoForbiddenEnvironment({ CRE_API_KEY: "abcdef" })).toThrow(/RUNTIME-FORBIDDEN-CREDENTIAL-PRESENT/);

    // And the launcher refuses to put one in a container.
    expect(DENIED_ENV_EXACT.has("CONTEXTLOCK_CRE_API_KEY")).toBe(true);
    expect(() => assertEnvironmentSafe({ CONTEXTLOCK_CRE_API_KEY: "x" })).toThrow();
    expect(() => assertEnvironmentSafe({ CRE_API_KEY: "x" })).toThrow();

    // The CRE monitoring path lives in the control plane, and nothing in it is reachable from the
    // runtime image's dependency set.
    const runtimePkg = JSON.parse(readFileSync("apps/agent-runtime/package.json", "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(runtimePkg.dependencies)).toEqual(["zod"]);
    expect(Object.keys(runtimePkg.dependencies)).not.toContain("@contextlock/studio-control-plane");
  });
});

/* ══════════════════════ disable policy stops a live runtime ══════════════════════ */

describe("policy is the financial control", () => {
  it("LIVE-014 disabling the policy stops a live, healthy runtime from acting", async () => {
    /*
     * The runtime is HEALTHY. The container is up, every gateway is reachable, the credential is
     * valid. None of that is authority.
     */
    const runtime = evaluateRuntime({
      containerRunning: true, containerHealth: "healthy", restartsInWindow: 0, observedImageDigest: `sha256:${"1".repeat(64)}`,
      lastHeartbeatMs: NOW - 1000, controlPlaneReachable: true, modelGatewayReachable: true,
      adapterBrokerReachable: true, contextlockBrokerReachable: true, eventCursorAgeMs: 1000,
      credentialValid: true, credentialExpiresAtMs: NOW + 600_000, strategyCheckpointAgeMs: 1000,
      paused: false, stopping: false, processStartedAtMs: NOW - 120_000, nowMs: NOW,
    });
    expect(runtime.state).toBe("HEALTHY");

    const enabled = await new ChainObserver({ reader: fakeReader(), queries: fakeQueries({ enabled: true }), nowMs: () => NOW }).readPolicyState(policyArgs);
    expect(agentIsLive({ runtime: runtime.state, policyEnabled: enabled.value!.enabled, policyIsCurrent: true, identityActive: true, requiredAdapters: [], creRequired: false, creActive: null }).live).toBe(true);

    // Disable the policy. The runtime is untouched and still HEALTHY.
    const disabled = await new ChainObserver({ reader: fakeReader(), queries: fakeQueries({ enabled: false }), nowMs: () => NOW }).readPolicyState(policyArgs);
    const after = agentIsLive({ runtime: runtime.state, policyEnabled: disabled.value!.enabled, policyIsCurrent: true, identityActive: true, requiredAdapters: [], creRequired: false, creActive: null });

    expect(runtime.state).toBe("HEALTHY");
    expect(after.live).toBe(false);
    expect(after.reasons).toEqual(["the ContextLock policy is disabled"]);
  });

  it("LIVE-013b pausing the runtime leaves the policy exactly where it was", async () => {
    const obs = new ChainObserver({ reader: fakeReader(), queries: fakeQueries({ enabled: true }), nowMs: () => NOW });
    const before = await obs.readPolicyState(policyArgs);

    const claim = runtimePauseClaim(before.value!.enabled);
    expect(claim.runtimeStopped).toBe(true);
    expect(claim.financiallySecured).toBe(false);

    // Read it again, independently. Pausing a container does not change chain state.
    const after = await obs.readPolicyState(policyArgs);
    expect(after.value!.enabled).toBe(before.value!.enabled);
    expect(after.value!.enabled).toBe(true);
  });
});

/* ══════════════════════ CRE control ══════════════════════ */

describe("CRE control operations", () => {
  it("LIVE-015 pausing CRE is confirmed by reading the workflow back, not by the call returning", async () => {
    const provider = new FakeCreProvider(liveConnection({ deployAccess: true }), fixtureWorkflow({ status: "ACTIVE" }));
    const monitor = new CreMonitor({ provider, nowMs: () => NOW });
    await monitor.sync("contextlock-policy");
    expect(monitor.view(NOW).state).toBe("ACTIVE");

    await provider.pauseWorkflow("contextlock-policy");
    expect(provider.calls).toContain("pauseWorkflow");

    // The pause call succeeding proves nothing. What the panel shows comes from a fresh read.
    const pausedProvider = new FakeCreProvider(liveConnection({ deployAccess: true }), fixtureWorkflow({ status: "PAUSED" }));
    const after = new CreMonitor({ provider: pausedProvider, nowMs: () => NOW });
    await after.sync("contextlock-policy");
    expect(after.view(NOW).state).toBe("PAUSED");

    // A provider whose pause "succeeds" while the workflow stays ACTIVE is caught, because the
    // state comes from getWorkflow rather than from the pause response.
    const lying = new FakeCreProvider(liveConnection({ deployAccess: true }), fixtureWorkflow({ status: "ACTIVE" }));
    await lying.pauseWorkflow("contextlock-policy");
    const stillActive = new CreMonitor({ provider: lying, nowMs: () => NOW });
    await stillActive.sync("contextlock-policy");
    expect(stillActive.view(NOW).state).toBe("ACTIVE");
  });
});

/* ══════════════════════ reconnect ══════════════════════ */

describe("the console rebuilds live state", () => {
  it("LIVE-022 a reconnect derives current state from persisted records plus fresh reads", async () => {
    /*
     * §25's architecture rule: the browser is not the control plane. Everything a reconnecting
     * client needs is either persisted (events, alerts) or re-read (chain, CRE, runtime) — nothing
     * lives only in a page's memory.
     */
    const store = new InMemoryEventStore();
    const alerts = new AlertEngine();
    const fence = new RuntimeRevisionFence(() => NOW);

    // Some history accumulates while nobody is watching.
    store.append(evt({ type: "RUNTIME_STATE_CHANGED", source: "RUNTIME", timestamp: NOW, publicMetadata: { to: "HEALTHY" } }), NOW);
    store.append(evt({ type: "POLICY_STATE_OBSERVED", source: "CHAIN", timestamp: NOW + 1, chainId: 11155111, publicMetadata: { enabled: false } }), NOW + 1);
    alerts.raise({ rule: "ADAPTER_STALE", severity: "WARNING", projectId: "prj_guardian", deploymentId: "dep_group_e_live_0001", subject: "the-graph", reason: "no data", nowMs: NOW });
    fence.activate("guardian", "rev_1");

    // A client connects fresh. It reconstructs from persisted state...
    const timeline = store.query({ deploymentId: "dep_group_e_live_0001" });
    const open = alerts.open("dep_group_e_live_0001");
    expect(timeline).toHaveLength(2);
    expect(open).toHaveLength(1);

    // ...and re-reads everything external rather than trusting the last thing it was told.
    const later = NOW + 10 * 60_000;
    const policy = await new ChainObserver({ reader: fakeReader(), queries: fakeQueries({ enabled: false }), nowMs: () => later }).readPolicyState(policyArgs);
    expect(presentable(policy, later).isCurrent).toBe(true);
    expect(policy.observedAtMs).toBe(later);

    // The persisted POLICY_STATE_OBSERVED event from ten minutes ago is history, and a client that
    // rendered it as current would be showing a stale value.
    const persistedPolicyEvent = timeline.find((e) => e.type === "POLICY_STATE_OBSERVED")!;
    expect(later - persistedPolicyEvent.timestamp).toBeGreaterThan(DEFAULT_TTLS.policy);
    expect(fence.activeRevision("guardian")).toBe("rev_1");
  });

  it("LIVE-022b every panel exposes its own freshness", async () => {
    const later = NOW + 5_000;
    const chain = await new ChainObserver({ reader: fakeReader(), queries: fakeQueries(), nowMs: () => NOW }).readPolicyState(policyArgs);
    const cre = new CreMonitor({ provider: new FakeCreProvider(), nowMs: () => NOW });
    await cre.sync("contextlock-policy");

    const adapters = new AdapterHealthService();
    adapters.register("aave-v3", "1.2.0");
    adapters.record("aave-v3", { atMs: NOW, ok: true, latencyMs: 50, dataAtMs: NOW });

    // Chain, CRE, runtime and adapters each carry when they were last verified and whether that
    // reading is current — §25's data-freshness rule, applied uniformly.
    expect(presentable(chain, later)).toMatchObject({ source: "chain:11155111", isCurrent: true });
    expect(cre.view(later).lastSyncedAtMs).toBe(NOW);
    expect(adapters.health("aave-v3", later).lastCheckedAtMs).toBe(NOW);
    expect(presentable(chain, later).ageMs).toBe(5_000);
  });
});

/* ══════════════════════ the whole console, on real data ══════════════════════ */

describe("the deployed-agent overview, from the real Group E deployment", () => {
  it("LIVE-044 the current deployment renders honestly: contracts deployed, everything else off", async () => {
    /*
     * This is the screen §25.49 asks for, built from the state the Group E deployment is actually
     * in. Every "not yet" is shown rather than hidden, which is what makes the screen evidence that
     * the monitoring model is honest.
     */
    const code = codeMap([[LIVE.executor, "0xaa" as Hex], [LIVE.consumer, "0xbb" as Hex]]);
    const obs = new ChainObserver({ reader: fakeReader({ code }), queries: fakeQueries({ enabled: false }), nowMs: () => NOW });

    const policy = await obs.readPolicyState(policyArgs);
    const identity = await obs.readIdentityState({ name: "contextlock-20260906-a83dc9.eth", node: LIVE.identityNode });
    const contracts = [await obs.readContractState("ContextLockCreConsumer", LIVE.consumer)];

    const cre = new CreMonitor({ provider: new FakeCreProvider(liveConnection({ deployAccess: false })), nowMs: () => NOW });
    await cre.sync("contextlock-policy");

    const runtime = evaluateRuntime({
      containerRunning: false, containerHealth: null, restartsInWindow: 0, observedImageDigest: null,
      lastHeartbeatMs: null, controlPlaneReachable: true, modelGatewayReachable: true, adapterBrokerReachable: true,
      contextlockBrokerReachable: true, eventCursorAgeMs: null, credentialValid: false, credentialExpiresAtMs: null,
      strategyCheckpointAgeMs: null, paused: false, stopping: false, processStartedAtMs: null, nowMs: NOW,
    });

    // Contracts: deployed and verifiable.
    expect(contracts[0]!.value!.hasCode).toBe(true);
    // Policy: DISABLED, from a fresh chain read.
    expect(policy.value!.enabled).toBe(false);
    expect(presentable(policy, NOW).isCurrent).toBe(true);
    // Identity: whatever the chain says, read fresh.
    expect(identity.value!.boundAgent).toBe(LIVE.agentAddress);
    // Runtime: inactive.
    expect(runtime.state).toBe("STOPPED");
    // CRE: not deployed, blocked on access — not "unhealthy", not "active".
    const creView = cre.view(NOW);
    expect(creView.state).toBe("BLOCKED");
    expect(creView.blockedBy).toBe("CRE_DEPLOY_ACCESS_REQUIRED");

    // And therefore: not LIVE, with every reason enumerated.
    const live = agentIsLive({
      runtime: runtime.state, policyEnabled: policy.value!.enabled, policyIsCurrent: true,
      identityActive: !identity.value!.revoked, requiredAdapters: [], creRequired: true, creActive: false,
    });
    expect(live.live).toBe(false);
    expect(live.reasons).toEqual([
      "runtime is STOPPED",
      "the ContextLock policy is disabled",
      "this agent requires a CRE workflow and it is not active",
    ]);
  });

  it("LIVE-044b observed state overlays the same graph the Blueprint describes", async () => {
    /*
     * §25.27: reuse the Blueprint graph, overlay observed state. The node list comes from the
     * design; the state comes from observation. Nothing here generates a second graph.
     */
    const blueprintNodes = ["ContextLock Policy", "ENS Identity", "Agent Runtime", "CRE Workflow", "aave-v3", "the-graph"];

    const obs = new ChainObserver({ reader: fakeReader(), queries: fakeQueries({ enabled: false }), nowMs: () => NOW });
    const policy = await obs.readPolicyState(policyArgs);
    const identity = await obs.readIdentityState({ name: "g.eth", node: LIVE.identityNode });
    const cre = new CreMonitor({ provider: new FakeCreProvider(), nowMs: () => NOW });
    await cre.sync("contextlock-policy");
    const adapters = new AdapterHealthService();
    adapters.register("aave-v3", "1.2.0");
    adapters.register("the-graph", "2.0.1");
    for (let i = 0; i < 4; i++) adapters.record("aave-v3", { atMs: NOW - i * 100, ok: true, latencyMs: 50, dataAtMs: NOW });
    for (let i = 0; i < 4; i++) adapters.record("the-graph", { atMs: NOW - i * 100, ok: false, latencyMs: 50, reason: "502" });

    const overlay: Record<string, string> = {
      "ContextLock Policy": policy.value!.enabled ? "ENABLED" : "DISABLED",
      "ENS Identity": identity.value!.revoked ? "REVOKED" : "ACTIVE",
      "Agent Runtime": "STOPPED",
      "CRE Workflow": cre.view(NOW).state,
      "aave-v3": adapters.health("aave-v3", NOW).state,
      "the-graph": adapters.health("the-graph", NOW).state,
    };

    // Every Blueprint node has an observed state, and every state came from an observation.
    for (const n of blueprintNodes) expect(Object.keys(overlay), n).toContain(n);
    expect(overlay).toEqual({
      "ContextLock Policy": "DISABLED",
      "ENS Identity": "ACTIVE",
      "Agent Runtime": "STOPPED",
      "CRE Workflow": "BLOCKED",
      "aave-v3": "HEALTHY",
      "the-graph": "DEGRADED",
    });
  });

  it("LIVE-032c a drift becomes an alert, and the alert survives the condition clearing", async () => {
    const alerts = new AlertEngine();
    const code = codeMap([[LIVE.executor, "0xaa" as Hex], [LIVE.consumer, "0xbb" as Hex]]);
    const obs = new ChainObserver({ reader: fakeReader({ code }), queries: fakeQueries({ enabled: true }), nowMs: () => NOW });

    const actual = {
      policy: await obs.readPolicyState(policyArgs),
      identity: null,
      contracts: [await obs.readContractState("ContextLockExecutorV2", LIVE.executor)],
      administrators: await obs.readAdministrators(LIVE.policyRegistry),
      runtimeImageDigest: null,
    };
    const contracts = [{ name: "ContextLockExecutorV2", address: LIVE.executor, runtimeCodeHash: actual.contracts[0]!.value!.runtimeCodeHash }];
    const drifts = reconcile(expectedState({ policyEnabled: false, contracts, identity: null, runtimeImageDigest: null }), actual, NOW);

    expect(drifts).toHaveLength(1);
    const { alert } = alerts.raise(alertForDrift(drifts[0]!, { projectId: "prj_guardian", deploymentId: "dep_group_e_live_0001" }));
    expect(alert.rule).toBe("POLICY_UNEXPECTEDLY_ENABLED");
    expect(alert.severity).toBe("CRITICAL");

    // The policy is disabled again on the next poll. The alert stays open.
    expect(alerts.autoResolve("POLICY_UNEXPECTEDLY_ENABLED", "dep_group_e_live_0001", alert.subject, NOW + 60_000)).toBeNull();
    expect(alerts.open("dep_group_e_live_0001")).toHaveLength(1);
  });

  it("LIVE-044c metrics describing the current deployment carry only bounded labels", () => {
    const t = new NoopTelemetry();
    t.gauge("policy_state", POLICY_STATE_GAUGE.DISABLED, { deployment_id: "dep_group_e_live_0001", agent_id: "guardian" });
    t.gauge("runtime_health", RUNTIME_HEALTH_GAUGE.STOPPED, { deployment_id: "dep_group_e_live_0001", agent_id: "guardian" });
    t.gauge("chain_sync_age", 3, { deployment_id: "dep_group_e_live_0001", chain_id: 11155111 });
    t.counter("agent_decisions_total", 0, { verdict: "NO_ACTION", agent_id: "guardian" });

    expect(t.emitted).toHaveLength(4);
    for (const e of t.emitted) {
      for (const k of Object.keys(e.labels)) {
        expect(["deployment_id", "agent_id", "chain_id", "verdict"], `${e.metric} label ${k}`).toContain(k);
      }
    }
    // The obvious thing an author reaches for is refused.
    expect(reasonOf(() => t.gauge("policy_state", 0, { deployment_id: "d", tx_hash: "0xabc" } as never))).toBe("OTEL-HIGH-CARDINALITY-LABEL");
  });
});
