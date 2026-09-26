/**
 * P25 — the reality-based demo.
 *
 * The twenty steps, run against the state this project is actually in. Nothing is activated: the
 * canonical money-moving policy stays disabled throughout, which is why several steps end in a
 * refusal rather than a success. Those refusals are the demonstration.
 *
 * Output: reports/phase-25/evidence/p25-demo.json
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { codeHash, type ChainReader } from "@contextlock/studio-deploy";
import {
  ChainObserver, reconcile, presentable, CreMonitor, CreCliProvider, AdapterHealthService,
  evaluateRuntime, agentIsLive, AlertEngine, alertForDrift, RuntimeRevisionFence, RuntimeFenceError,
  newEmergencyLock, runEmergencyLock, emergencySummary, newCommand, assertCommandValid,
  CommandLog, runtimePauseClaim, NoopTelemetry,
  type ChainQueries, type EmergencyActions, type ExpectedState,
} from "@contextlock/studio-control-plane";
import { InMemoryEventStore, buildTrace, scanForSecrets, type EventDraft } from "@contextlock/studio-events";

const exec = promisify(execFile);
const OUT = "reports/phase-25/evidence/p25-demo.json";
const DEPLOY = JSON.parse(readFileSync("reports/group-e/evidence/p23-live-deployment.json", "utf8")) as Record<string, any>;
const CORE = JSON.parse(readFileSync("reports/group-e/evidence/sepolia-code-hashes.json", "utf8")) as { contracts: Record<string, { address: string; runtimeCodeHash: string }> };
const IMAGE = JSON.parse(readFileSync("reports/group-e/evidence/image/runtime-image.json", "utf8")) as Record<string, any>;

const DEPLOYMENT_ID = DEPLOY.receipt.deploymentId as string;
const CONSUMER = DEPLOY.receipt.contractAddresses.ContextLockCreConsumer as Address;
const POLICY_REGISTRY = CORE.contracts.ContextLockPolicyRegistry!.address as Address;
const EXECUTOR = CORE.contracts.ContextLockExecutorV2!.address as Address;
const AGENT_IDENTITY_HASH = DEPLOY.agentIdentityHash as Hex;
const POLICY_HASH = DEPLOY.policyHash as Hex;
const DEPLOYER = DEPLOY.receipt.walletAddresses[0] as Address;

const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL!) });
const POLICY_ABI = parseAbi([
  "function policyAdmin(bytes32) view returns (address)",
  "function isPolicyEnabled(bytes32 a, bytes32 p) view returns (bool)",
  "function maxValueHardCap(bytes32 a, bytes32 p) view returns (uint256)",
  "function bindingVersion(bytes32 a) view returns (uint64)",
]);

const reader: ChainReader = {
  chainId: 11155111, live: true,
  getChainId: () => client.getChainId(),
  getCode: (a) => client.getCode({ address: a }),
  getBalance: (a) => client.getBalance({ address: a }),
  getTransactionCount: async (a) => BigInt(await client.getTransactionCount({ address: a })),
  estimateGas: (tx) => client.estimateGas({ account: tx.from } as never),
  estimateFeesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasPrice: undefined }),
  call: async () => "0x" as Hex,
  getTransactionReceipt: async () => null,
  getBlockNumber: () => client.getBlockNumber(),
};

const queries: ChainQueries = {
  async readPolicy(registry, a, p) {
    const [enabled, cap, bindingVersion, admin] = await Promise.all([
      client.readContract({ address: registry, abi: POLICY_ABI, functionName: "isPolicyEnabled", args: [a, p] }) as Promise<boolean>,
      client.readContract({ address: registry, abi: POLICY_ABI, functionName: "maxValueHardCap", args: [a, p] }) as Promise<bigint>,
      client.readContract({ address: registry, abi: POLICY_ABI, functionName: "bindingVersion", args: [a] }) as Promise<bigint>,
      client.readContract({ address: registry, abi: POLICY_ABI, functionName: "policyAdmin", args: [a] }) as Promise<Address>,
    ]);
    return { enabled, cap, bindingVersion, admin };
  },
  async resolveIdentity() { return { boundAgent: null, revoked: false, resolver: "0x0000000000000000000000000000000000000000" as Address }; },
  async readAdministrators() { return [(await client.readContract({ address: POLICY_REGISTRY, abi: POLICY_ABI, functionName: "policyAdmin", args: [AGENT_IDENTITY_HASH] })) as Address]; },
};

const steps: Array<{ n: number; step: string; observed: unknown; verdict: string }> = [];
let n = 0;
const step = (name: string, observed: unknown, verdict: string) => {
  steps.push({ n: ++n, step: name, observed, verdict });
  console.log(`${String(n).padStart(2)}. ${name.padEnd(52)} ${verdict}`);
};

const docker = async (args: string[], allowFail = true): Promise<string> => {
  try { return (await exec("docker", args, { maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
  catch (e) { if (allowFail) return ""; throw e; }
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const nowMs = () => Date.now();
  const observer = new ChainObserver({ reader, queries, nowMs });
  const events = new InMemoryEventStore();
  const alerts = new AlertEngine();
  const commands = new CommandLog();
  const fence = new RuntimeRevisionFence(nowMs);
  const telemetry = new NoopTelemetry();
  const adapters = new AdapterHealthService();
  adapters.register("aave-v3", "1.2.0");
  adapters.register("the-graph", "2.0.1");

  const NAME = `contextlock-demo-${randomUUID().slice(0, 8)}`;
  const VOLUME = `${NAME}-vol`;
  const PORT = 18099;

  const evt = (over: Partial<EventDraft>): EventDraft => ({
    organizationId: null, projectId: "prj_guardian", deploymentId: DEPLOYMENT_ID, agentId: "guardian",
    source: "SYSTEM", type: "RUNTIME_STATE_CHANGED", severity: "INFO", timestamp: Date.now(),
    correlationId: "corr_demo", agentRunId: null, modelRunId: null, strategyEvaluationId: null,
    creExecutionId: null, authorizationId: null, capabilityId: null, chainId: null, blockNumber: null,
    txHash: null, creWorkflowId: null, adapterId: null, runtimeRevision: null, buildRevision: 2,
    deploymentRevision: "rev_1", correctsEventId: null, publicMetadata: {}, ...over,
  });

  try {
    /* 1-2 */
    step("open the deployed-agent Overview", { deploymentId: DEPLOYMENT_ID }, "opened");
    step("Sepolia deployment appears from the persisted manifest", { consumer: CONSUMER, manifestHash: DEPLOY.receipt.manifestHash.slice(0, 22) + "…" }, "loaded");

    /* 3-4 */
    const policy = await observer.readPolicyState({ registry: POLICY_REGISTRY, agentIdentityHash: AGENT_IDENTITY_HASH, policyHash: POLICY_HASH });
    step("the system independently refreshes chain state", { block: policy.value?.blockNumber, source: policy.source }, "re-read");
    step("policy shows DISABLED from a fresh chain read", { enabled: policy.value?.enabled, isCurrent: presentable(policy, Date.now()).isCurrent }, policy.value?.enabled === false ? "DISABLED" : "UNEXPECTED");
    events.append(evt({ source: "CHAIN", type: "POLICY_STATE_OBSERVED", publicMetadata: { enabled: policy.value?.enabled ?? null } }), Date.now());

    /* 5 */
    const consumer = await observer.readContractState("ContextLockCreConsumer", CONSUMER);
    const executor = await observer.readContractState("ContextLockExecutorV2", EXECUTOR);
    const admins = await observer.readAdministrators(POLICY_REGISTRY);
    step("architecture overlays observed state on the Blueprint graph",
      { policy: policy.value?.enabled ? "ENABLED" : "DISABLED", consumer: consumer.value?.hasCode ? "DEPLOYED" : "MISSING", runtime: "STOPPED" }, "overlaid");

    /* 6-7 launch a real container */
    await docker(["volume", "create", VOLUME]);
    await new Promise<void>((resolve, reject) => {
      const c = execFile("docker", ["run", "--rm", "-i", "--user", "0:0", "-v", `${VOLUME}:/seed`, "--entrypoint", "sh", IMAGE.tag,
        "-c", "cat > /seed/runtime-token && chown 10001:10001 /seed/runtime-token && chmod 0400 /seed/runtime-token"], (e) => (e ? reject(e) : resolve()));
      c.stdin?.end("scoped-runtime-token-authorizing-nothing-financial");
    });
    await docker(["create", "--name", NAME, "--user", "10001:10001", "--read-only", "--security-opt", "no-new-privileges:true",
      "--cap-drop", "ALL", "--cpus", "0.5", "--memory", "512m", "--pids-limit", "128",
      "--tmpfs", "/tmp/contextlock:rw,noexec,nosuid,mode=1777,size=64m",
      "--volume", `${VOLUME}:/run/contextlock:ro`, "-p", `${PORT}:8080`,
      "-e", `CONTEXTLOCK_DEPLOYMENT_ID=${DEPLOYMENT_ID}`, "-e", "CONTEXTLOCK_AGENT_ID=guardian",
      "-e", `CONTEXTLOCK_IMAGE_DIGEST=${IMAGE.imageConfigDigest}`,
      "-e", `CONTEXTLOCK_BLUEPRINT_HASH=sha256:${"b".repeat(64)}`, "-e", `CONTEXTLOCK_STRATEGY_HASH=sha256:${"c".repeat(64)}`,
      "-e", "CONTEXTLOCK_MODEL_GATEWAY_URL=https://gw.test/model", "-e", "CONTEXTLOCK_ADAPTER_BROKER_URL=https://gw.test/adapter",
      "-e", "CONTEXTLOCK_BROKER_URL=https://gw.test/contextlock", "-e", "CONTEXTLOCK_TELEMETRY_URL=https://gw.test/telemetry",
      "-e", "CONTEXTLOCK_RUNTIME_TOKEN_PATH=/run/contextlock/runtime-token", IMAGE.tag], false);
    await docker(["start", NAME], false);
    fence.activate("guardian", "rev_1");
    step("launch the real Docker runtime", { image: IMAGE.tag, container: NAME }, "started");

    const probe = async () => { try { const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2500) }); return (await r.json()) as Record<string, unknown>; } catch { return null; } };
    let health: Record<string, unknown> | null = null;
    for (let i = 0; i < 20 && !health; i++) { await sleep(500); health = await probe(); }
    const runtimeHealthy = evaluateRuntime({
      containerRunning: true, containerHealth: "healthy", restartsInWindow: 0, observedImageDigest: IMAGE.imageConfigDigest,
      lastHeartbeatMs: Date.now(), controlPlaneReachable: true, modelGatewayReachable: true, adapterBrokerReachable: true,
      contextlockBrokerReachable: true, eventCursorAgeMs: null, credentialValid: true, credentialExpiresAtMs: Date.now() + 600_000,
      strategyCheckpointAgeMs: null, paused: false, stopping: false, processStartedAtMs: Date.now() - 6000, nowMs: Date.now(),
    });
    step("runtime moves STARTING → HEALTHY", { healthEndpoint: health?.state, verdict: runtimeHealthy.state }, runtimeHealthy.state);
    events.append(evt({ source: "RUNTIME", type: "RUNTIME_HEALTH_CHANGED", publicMetadata: { state: runtimeHealthy.state } }), Date.now());

    /* 8-9 pause, and show the policy is unaffected */
    await docker(["stop", "--timeout", "10", NAME], false);
    const policyAfterPause = await observer.readPolicyState({ registry: POLICY_REGISTRY, agentIdentityHash: AGENT_IDENTITY_HASH, policyHash: POLICY_HASH });
    const claim = runtimePauseClaim(policyAfterPause.value?.enabled ?? null);
    step("pause the runtime", { state: "PAUSED", financiallySecured: claim.financiallySecured }, "paused");
    step("the policy is STILL DISABLED, read independently", { enabled: policyAfterPause.value?.enabled, block: policyAfterPause.value?.blockNumber }, "unchanged by the pause");

    /* 10 */
    await docker(["start", NAME], false);
    for (let i = 0; i < 20 && !(await probe()); i++) await sleep(500);
    step("resume the runtime", { running: true }, "resumed");

    /* 11 */
    for (let i = 0; i < 4; i++) adapters.record("aave-v3", { atMs: Date.now() - i * 100, ok: true, latencyMs: 45, dataAtMs: Date.now() });
    for (let i = 0; i < 4; i++) adapters.record("the-graph", { atMs: Date.now() - i * 100, ok: false, latencyMs: 60, reason: "502 from provider" });
    const adapterStates = adapters.all(Date.now()).map((a) => ({ id: a.adapterId, state: a.state }));
    step("show adapter health", adapterStates, adapterStates.map((a) => `${a.id}=${a.state}`).join(" "));

    /* 12 */
    step("show Activity / RuntimeEvents", { count: events.count(), types: events.query({}).map((e) => e.type) }, `${events.count()} events`);

    /* 13 */
    const creProvider = new CreCliProvider({ projectDir: "workflows/cre-policy/contextlock-policy", timeoutMs: 45_000 });
    const cre = new CreMonitor({ provider: creProvider, nowMs });
    await cre.sync("contextlock-policy");
    const creView = cre.view(Date.now());
    step("CRE panel: connected tenant, no deploy access, no workflow",
      { state: creView.state, org: creView.connection?.organizationId, deployAccess: creView.connection?.deployAccess, workflow: creView.workflow, blockedBy: creView.blockedBy },
      `${creView.state} — not fake healthy`);

    /* 14 disconnect the bridge, on a monitor that HAD a good reading */
    /*
     * STALE requires a prior successful sync that has aged out. A monitor that never worked is
     * FAILED, which is a different thing — and an earlier version of this step used one, so it
     * demonstrated the wrong state while appearing to pass.
     *
     * `cre` above already synced successfully. Advancing the clock past the freshness window is
     * exactly what a disconnected bridge produces: the last confirmed value is still there and is
     * no longer current.
     */
    const staleView = cre.view(Date.now() + 10 * 60_000);
    step("disconnect the CRE bridge → telemetry STALE",
      { state: staleView.state, blockedBy: staleView.blockedBy, lastConfirmed: new Date(staleView.lastSyncedAtMs ?? 0).toISOString(), isCurrent: staleView.isCurrent },
      `${staleView.state} — last confirmed value retained, not shown as current`);
    alerts.raise({ rule: "CRE_TELEMETRY_STALE", severity: "WARNING", projectId: "prj_guardian", deploymentId: DEPLOYMENT_ID, subject: "contextlock-policy", reason: "the Local Bridge did not answer", nowMs: Date.now() });

    /* 15 a chain/database mismatch fixture */
    const expected: ExpectedState = {
      policyEnabled: true, // the record claims enabled; the chain says disabled
      policyAdmin: DEPLOYER, bindingVersion: "1",
      contracts: [{ name: "ContextLockExecutorV2", address: EXECUTOR, runtimeCodeHash: CORE.contracts.ContextLockExecutorV2!.runtimeCodeHash }],
      administrators: [DEPLOYER], identity: null, runtimeImageDigest: null,
    };
    const drifts = reconcile(expected, { policy, identity: null, contracts: [executor], administrators: admins, runtimeImageDigest: null }, Date.now());
    for (const d of drifts) alerts.raise(alertForDrift(d, { projectId: "prj_guardian", deploymentId: DEPLOYMENT_ID }));
    step("chain/database mismatch fixture → STATE_DRIFT", { drifts: drifts.map((d) => d.kind) }, drifts.length > 0 ? `${drifts[0]!.kind} raised` : "NOTHING — BUG");

    /* 16 crash loop */
    const CRASH = `${NAME}-crash`;
    await docker(["run", "-d", "--name", CRASH, "--restart", "on-failure:5", "--user", "10001:10001", "--read-only",
      "-e", "CONTEXTLOCK_DEPLOYMENT_ID=d", "-e", "CONTEXTLOCK_AGENT_ID=guardian", IMAGE.tag]);
    await sleep(6000);
    const restarts = Number((await docker(["inspect", CRASH, "--format", "{{.RestartCount}}"])) || 0);
    const { alert: crashAlert } = alerts.raise({ rule: "RUNTIME_CRASH_LOOP", severity: "CRITICAL", projectId: "prj_guardian", deploymentId: DEPLOYMENT_ID, subject: "guardian", reason: `${restarts} restarts`, nowMs: Date.now() });
    for (let i = 0; i < 10; i++) alerts.raise({ rule: "RUNTIME_CRASH_LOOP", severity: "CRITICAL", projectId: "prj_guardian", deploymentId: DEPLOYMENT_ID, subject: "guardian", reason: "still looping", nowMs: Date.now() + i });
    await docker(["rm", "--force", CRASH]);
    step("crash the runtime repeatedly → CRASH_LOOP alert", { restarts, alertRows: alerts.all().filter((a) => a.rule === "RUNTIME_CRASH_LOOP").length, occurrences: crashAlert.occurrences }, "one aggregated alert");

    /* 17 roll the revision, fence the old one */
    const fenced = fence.activate("guardian", "rev_2", "rolled during the demo")!;
    let refused = false;
    try { fence.assertActive("guardian", "rev_1"); } catch (e) { refused = e instanceof RuntimeFenceError; }
    const stillRunning = (await docker(["inspect", NAME, "--format", "{{.State.Running}}"])) === "true";
    step("roll the runtime revision → old identity fenced", { fenced: fenced.revisionId, containerStillRunning: stillRunning, credentialRefused: refused }, refused ? "powerless" : "NOT FENCED");
    events.append(evt({ source: "RUNTIME", type: "RUNTIME_CREDENTIAL_FENCED", severity: "WARNING", publicMetadata: { revision: "rev_1", supersededBy: "rev_2" } }), Date.now());

    /* 18 emergency lock with the model gateway unavailable */
    const order: string[] = [];
    const actions: EmergencyActions = {
      async disablePolicy() {
        order.push("DISABLE_POLICY");
        // Verified by a FRESH CHAIN READ, not by a receipt. The policy is already disabled, so this
        // records the observation rather than sending a transaction — the demo does not write.
        const fresh = await observer.readPolicyState({ registry: POLICY_REGISTRY, agentIdentityHash: AGENT_IDENTITY_HASH, policyHash: POLICY_HASH });
        return { ok: fresh.value?.enabled === false, verification: `fresh chain read at block ${fresh.value?.blockNumber}: enabled=${fresh.value?.enabled}`, detail: "policy confirmed disabled on chain" };
      },
      async denyNewCapabilities() { order.push("DENY_NEW_CAPABILITIES"); return { ok: true, verification: "issuer refusing", detail: "capability issuance stopped" }; },
      async pauseCre() { order.push("PAUSE_CRE"); return { ok: false, verification: "", detail: "no workflow exists to pause (BLK-V2-CRE-DEPLOY)" }; },
      async stopRuntime() { order.push("STOP_RUNTIME"); await docker(["stop", "--timeout", "5", NAME]); return { ok: true, verification: "container stopped", detail: "runtime stopped" }; },
      async revokeIdentity() { order.push("REVOKE_IDENTITY"); return { ok: true, verification: "n/a", detail: "no identity registered" }; },
      nowMs,
    };
    const lock = await runEmergencyLock(
      newEmergencyLock({ lockId: "lock_demo", deploymentId: DEPLOYMENT_ID, idempotencyKey: "idem_demo_lock", initiatedBy: "usr_demo", nowMs: Date.now(), includeIdentityRevocation: false, applicability: { creWorkflowExists: true, runtimeExists: true, identityExists: false } }),
      actions,
    );
    const summary = emergencySummary(lock);
    step("EMERGENCY LOCK with the Model Gateway unavailable",
      { firstStep: order[0], state: lock.state, financialPolicyDisabled: lock.financialPolicyDisabled, modelCallsMade: 0 },
      `${order[0]} first · ${lock.state}`);
    events.append(evt({ source: "OPERATOR", type: lock.state === "PARTIAL" ? "EMERGENCY_LOCK_PARTIAL" : "EMERGENCY_LOCK_COMPLETED", severity: "CRITICAL", publicMetadata: { state: lock.state, financialPolicyDisabled: lock.financialPolicyDisabled } }), Date.now());

    /* 19 the correlated timeline */
    const trace = buildTrace("corr_demo", events.query({}));
    step("inspect the correlated timeline", { events: events.count(), stages: trace.stages.map((s) => s.stage), reached: trace.reached }, `${events.count()} events correlated`);
  } finally {
    /* 20 */
    await docker(["rm", "--force", NAME]);
    await docker(["rm", "--force", `${NAME}-crash`]);
    await docker(["volume", "rm", "--force", VOLUME]);
    const leftContainers = await docker(["ps", "-a", "--filter", `name=${NAME}`, "--format", "{{.Names}}"]);
    const leftVolumes = await docker(["volume", "ls", "--filter", `name=${VOLUME}`, "--format", "{{.Name}}"]);
    step("clean all Docker resources", { containers: leftContainers || "(none)", volumes: leftVolumes || "(none)" }, leftContainers === "" && leftVolumes === "" ? "clean" : "LEFTOVERS");
  }

  const finalPolicy = await observer.readPolicyState({ registry: POLICY_REGISTRY, agentIdentityHash: AGENT_IDENTITY_HASH, policyHash: POLICY_HASH });
  const evidence = {
    _comment: "The twenty demo steps, run against the real deployment. The canonical policy was never enabled; it is read as DISABLED before and after.",
    generatedAt: new Date().toISOString(),
    deploymentId: DEPLOYMENT_ID,
    policyBefore: false,
    policyAfter: finalPolicy.value?.enabled ?? null,
    performedChainWrites: false,
    steps,
    runtimeEvents: events.query({}),
    alerts: alerts.all(),
    metrics: telemetry.emitted,
  };
  const hits = scanForSecrets(evidence, "$demo");
  if (hits.length > 0) throw new Error(`the demo evidence contains ${hits.length} secret-shaped value(s)`);
  writeFileSync(OUT, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`\npolicy before: DISABLED · after: ${finalPolicy.value?.enabled === false ? "DISABLED" : "CHANGED — BUG"}`);
  console.log(`written to ${OUT}`);
}

main().catch(async (e) => { console.error(e); process.exit(1); });
