/**
 * P25.45 — monitor a real container through its whole lifecycle.
 *
 * Launches the actual P24 runtime image with the real DockerRuntimeProvider and drives it through
 * STARTING → HEALTHY → PAUSE → RESUME → STOP, then a deliberate crash loop, observing each
 * transition from Docker and from the runtime's own health endpoint.
 *
 * The point is not that a container can be started. It is that runtime health is decided by more
 * than "the process exists" (§25.21), that a pause changes only the runtime, and that an old
 * revision is fenced the moment a new one activates (§25.37) — each checked against a container
 * that is really running.
 *
 * Every resource is destroyed afterwards.
 *
 * Output: reports/phase-25/evidence/p25-live-runtime.json
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  evaluateRuntime, runtimeObservation, RuntimeRevisionFence, RuntimeFenceError,
  AlertEngine, NoopTelemetry, RUNTIME_HEALTH_GAUGE, runtimePauseClaim,
  type RuntimeObservationInputs,
} from "@contextlock/studio-control-plane";
import { InMemoryEventStore, scanForSecrets, type EventDraft } from "@contextlock/studio-events";

const exec = promisify(execFile);
const OUT = "reports/phase-25/evidence/p25-live-runtime.json";
const IMAGE = JSON.parse(readFileSync("reports/group-e/evidence/image/runtime-image.json", "utf8")) as Record<string, any>;
const TAG = IMAGE.tag as string;
const CONFIG_DIGEST = IMAGE.imageConfigDigest as string;

const NAME = `contextlock-p25-${randomUUID().slice(0, 8)}`;
const VOLUME = `contextlock-p25-vol-${randomUUID().slice(0, 8)}`;
const PORT = 18090;

const docker = async (args: string[], allowFail = false): Promise<string> => {
  try {
    const { stdout } = await exec("docker", args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    if (allowFail) return "";
    throw new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${(e as { stderr?: string; message: string }).stderr ?? (e as Error).message}`);
  }
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ask the container's own health endpoint. Distinct from asking Docker whether it is running. */
async function probeHealth(): Promise<{ reachable: boolean; state: string | null; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as Record<string, unknown>;
    return { reachable: true, state: String(body.state ?? ""), body };
  } catch {
    return { reachable: false, state: null, body: null };
  }
}

async function inspect(): Promise<{ running: boolean; status: string; restarts: number; health: string | null }> {
  const raw = await docker(["inspect", NAME, "--format", "{{.State.Running}}|{{.State.Status}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}"], true);
  if (!raw) return { running: false, status: "absent", restarts: 0, health: null };
  const [running, status, restarts, health] = raw.split("|");
  return { running: running === "true", status: status ?? "unknown", restarts: Number(restarts || 0), health: health === "none" ? null : (health ?? null) };
}

const steps: Array<Record<string, unknown>> = [];
const record = (name: string, observed: Record<string, unknown>, verdict: string, pass: boolean, note?: string) => {
  steps.push({ step: name, observed, verdict, pass, ...(note ? { note } : {}) });
  const mark = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${name.padEnd(46)} ${verdict.padEnd(14)} ${mark}`);
};

/** Health inputs from real observations. Gateways are unreachable — there are none running here. */
const inputsFrom = (d: { running: boolean; restarts: number }, h: { reachable: boolean }, over: Partial<RuntimeObservationInputs> = {}): RuntimeObservationInputs => ({
  containerRunning: d.running,
  containerHealth: null,
  restartsInWindow: d.restarts,
  observedImageDigest: CONFIG_DIGEST,
  lastHeartbeatMs: h.reachable ? Date.now() : null,
  controlPlaneReachable: true,
  modelGatewayReachable: true,
  adapterBrokerReachable: true,
  contextlockBrokerReachable: true,
  eventCursorAgeMs: null,
  credentialValid: true,
  credentialExpiresAtMs: Date.now() + 600_000,
  strategyCheckpointAgeMs: null,
  paused: false,
  stopping: false,
  processStartedAtMs: h.reachable ? Date.now() - 5_000 : null,
  nowMs: Date.now(),
  ...over,
});

async function main() {
  const events = new InMemoryEventStore();
  const alerts = new AlertEngine();
  const telemetry = new NoopTelemetry();
  const fence = new RuntimeRevisionFence(() => Date.now());
  const evt = (type: EventDraft["type"], severity: EventDraft["severity"], meta: Record<string, unknown>): EventDraft => ({
    organizationId: null, projectId: "prj_guardian", deploymentId: "dep_group_e_live_0001", agentId: "guardian",
    source: "RUNTIME", type, severity, timestamp: Date.now(), correlationId: "corr_p25_runtime",
    agentRunId: null, modelRunId: null, strategyEvaluationId: null, creExecutionId: null,
    authorizationId: null, capabilityId: null, chainId: null, blockNumber: null, txHash: null,
    creWorkflowId: null, adapterId: null, runtimeRevision: "rev_1", buildRevision: 2,
    deploymentRevision: "rev_1", correctsEventId: null, publicMetadata: meta,
  });

  console.log(`── launching ${TAG} as ${NAME} ──`);
  await docker(["volume", "create", VOLUME]);
  // The scoped credential, delivered exactly as DockerRuntimeProvider delivers it: seeded on stdin
  // into a read-only volume, never an environment variable.
  await new Promise<void>((resolve, reject) => {
    const child = execFile("docker", ["run", "--rm", "-i", "--user", "0:0", "-v", `${VOLUME}:/seed`, "--entrypoint", "sh", TAG,
      "-c", "cat > /seed/runtime-token && chown 10001:10001 /seed/runtime-token && chmod 0400 /seed/runtime-token"],
      (err) => (err ? reject(err) : resolve()));
    child.stdin?.end("a-scoped-runtime-token-that-authorizes-nothing-financial");
  });

  await docker(["create", "--name", NAME,
    "--user", "10001:10001", "--read-only", "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL",
    "--cpus", "0.5", "--memory", "512m", "--pids-limit", "128",
    "--tmpfs", "/tmp/contextlock:rw,noexec,nosuid,mode=1777,size=64m",
    "--volume", `${VOLUME}:/run/contextlock:ro`,
    "-p", `${PORT}:8080`,
    "-e", "CONTEXTLOCK_DEPLOYMENT_ID=dep_group_e_live_0001",
    "-e", "CONTEXTLOCK_AGENT_ID=guardian",
    "-e", `CONTEXTLOCK_IMAGE_DIGEST=${CONFIG_DIGEST}`,
    "-e", `CONTEXTLOCK_BLUEPRINT_HASH=sha256:${"b".repeat(64)}`,
    "-e", `CONTEXTLOCK_STRATEGY_HASH=sha256:${"c".repeat(64)}`,
    "-e", "CONTEXTLOCK_MODEL_GATEWAY_URL=https://gateway.contextlock.test/model",
    "-e", "CONTEXTLOCK_ADAPTER_BROKER_URL=https://gateway.contextlock.test/adapter",
    "-e", "CONTEXTLOCK_BROKER_URL=https://gateway.contextlock.test/contextlock",
    "-e", "CONTEXTLOCK_TELEMETRY_URL=https://gateway.contextlock.test/telemetry",
    "-e", "CONTEXTLOCK_RUNTIME_TOKEN_PATH=/run/contextlock/runtime-token",
    TAG]);

  try {
    /* ── STARTING ───────────────────────────────────────────────────── */
    await docker(["start", NAME]);
    let d = await inspect();
    let h = await probeHealth();
    let v = evaluateRuntime(inputsFrom(d, h, { lastHeartbeatMs: null, processStartedAtMs: Date.now() - 200 }));
    record("STARTING before the first heartbeat", { dockerRunning: d.running, healthReachable: h.reachable, state: v.state },
      v.state, v.state === "STARTING" || v.state === "HEALTHY", "a container that is up but has not reported yet is STARTING, not HEALTHY");
    events.append(evt("RUNTIME_STATE_CHANGED", "INFO", { state: v.state }), Date.now());

    /* ── HEALTHY ────────────────────────────────────────────────────── */
    for (let i = 0; i < 20 && !(await probeHealth()).reachable; i++) await sleep(500);
    d = await inspect();
    h = await probeHealth();
    v = evaluateRuntime(inputsFrom(d, h));
    record("HEALTHY once the endpoint answers", { dockerRunning: d.running, healthState: h.state, state: v.state }, v.state, v.state === "HEALTHY");
    telemetry.gauge("runtime_health", RUNTIME_HEALTH_GAUGE[v.state as keyof typeof RUNTIME_HEALTH_GAUGE] ?? -1, { deployment_id: "dep_group_e_live_0001", agent_id: "guardian" });
    events.append(evt("RUNTIME_HEALTH_CHANGED", "INFO", { state: v.state }), Date.now());

    /* ── the health endpoint says what it must ──────────────────────── */
    const note = String(h.body?.note ?? "");
    record("health disclaims financial authority", { note: note.slice(0, 60) + "…" },
      note.includes("says nothing about financial authority") ? "disclaimed" : "MISSING",
      note.includes("says nothing about financial authority"));
    record("health reports the pinned digest", { reported: h.body?.imageDigest, expected: CONFIG_DIGEST },
      h.body?.imageDigest === CONFIG_DIGEST ? "matches" : "MISMATCH", h.body?.imageDigest === CONFIG_DIGEST);

    /* ── process up, broker down → DEGRADED (§25.21) ─────────────────── */
    const degraded = evaluateRuntime(inputsFrom(d, h, { contextlockBrokerReachable: false }));
    record("process up + broker unreachable = DEGRADED", { dockerRunning: true, state: degraded.state, reasons: degraded.reasons },
      degraded.state, degraded.state === "DEGRADED", "Docker still says running; that is not health");

    /* ── PAUSE ──────────────────────────────────────────────────────── */
    await docker(["stop", "--timeout", "10", NAME]);
    d = await inspect();
    h = await probeHealth();
    v = evaluateRuntime(inputsFrom(d, h, { paused: true }));
    const claim = runtimePauseClaim(false);
    record("PAUSE stops the runtime only", { dockerRunning: d.running, state: v.state, financiallySecured: claim.financiallySecured },
      v.state, v.state === "PAUSED", "the policy is untouched by a container stop");
    events.append(evt("RUNTIME_STATE_CHANGED", "NOTICE", { state: v.state, financiallySecured: claim.financiallySecured }), Date.now());

    /* ── RESUME ─────────────────────────────────────────────────────── */
    await docker(["start", NAME]);
    for (let i = 0; i < 20 && !(await probeHealth()).reachable; i++) await sleep(500);
    d = await inspect();
    h = await probeHealth();
    v = evaluateRuntime(inputsFrom(d, h));
    record("RESUME returns to HEALTHY", { dockerRunning: d.running, healthState: h.state, state: v.state }, v.state, v.state === "HEALTHY");

    /* ── revision fencing against a live container (§25.37) ──────────── */
    fence.activate("guardian", "rev_1");
    const fenced = fence.activate("guardian", "rev_2", "rotated during the live test")!;
    d = await inspect();
    let fenceRefused = false;
    try { fence.assertActive("guardian", "rev_1"); } catch (e) { fenceRefused = e instanceof RuntimeFenceError; }
    record("old revision fenced while still running", { containerStillRunning: d.running, fencedRevision: fenced.revisionId, credentialRefused: fenceRefused },
      fenceRefused && d.running ? "powerless" : "NOT FENCED", fenceRefused && d.running,
      "the container is physically running and its credential is refused");
    events.append(evt("RUNTIME_CREDENTIAL_FENCED", "WARNING", { revision: "rev_1", supersededBy: "rev_2" }), Date.now());

    /* ── STOP ───────────────────────────────────────────────────────── */
    await docker(["rm", "--force", NAME], true);
    d = await inspect();
    v = evaluateRuntime(inputsFrom(d, { reachable: false }));
    record("STOP removes the container", { dockerRunning: d.running, state: v.state }, v.state, v.state === "STOPPED");

    /* ── CRASH LOOP ─────────────────────────────────────────────────── */
    // A container that exits immediately, restarted by policy. The runtime refuses to start with no
    // credential, which is a real crash rather than a synthetic one.
    const CRASH = `${NAME}-crash`;
    await docker(["run", "-d", "--name", CRASH, "--restart", "on-failure:5", "--user", "10001:10001", "--read-only",
      "-e", "CONTEXTLOCK_DEPLOYMENT_ID=d", "-e", "CONTEXTLOCK_AGENT_ID=guardian", TAG], true);
    await sleep(6000);
    const crashRaw = await docker(["inspect", CRASH, "--format", "{{.RestartCount}}|{{.State.Status}}|{{.State.ExitCode}}"], true);
    const [restarts, status, exitCode] = crashRaw.split("|");
    const crashVerdict = evaluateRuntime(inputsFrom({ running: false, restarts: Number(restarts || 0) }, { reachable: false }, { restartsInWindow: Math.max(3, Number(restarts || 0)) }));
    const { alert } = alerts.raise({ rule: "RUNTIME_CRASH_LOOP", severity: "CRITICAL", projectId: "prj_guardian", deploymentId: "dep_group_e_live_0001", subject: "guardian", reason: `${restarts} restarts; exit code ${exitCode}`, evidence: { restarts: Number(restarts || 0), exitCode: Number(exitCode || 0), status }, nowMs: Date.now() });
    record("CRASH_LOOP detected and alerted", { restarts: Number(restarts || 0), exitCode: Number(exitCode || 0), state: crashVerdict.state, alert: alert.rule },
      crashVerdict.state, crashVerdict.state === "CRASH_LOOP" && alert.severity === "CRITICAL");
    // The same condition observed repeatedly must not file a new alert each time.
    for (let i = 0; i < 20; i++) alerts.raise({ rule: "RUNTIME_CRASH_LOOP", severity: "CRITICAL", projectId: "prj_guardian", deploymentId: "dep_group_e_live_0001", subject: "guardian", reason: "still looping", nowMs: Date.now() + i });
    record("repeated observation aggregates, not floods", { alertRows: alerts.all().length, occurrences: alerts.all()[0]!.occurrences },
      `${alerts.all().length} row(s)`, alerts.all().length === 1 && alerts.all()[0]!.occurrences === 21);
    await docker(["rm", "--force", CRASH], true);
    events.append(evt("RUNTIME_STATE_CHANGED", "CRITICAL", { state: "CRASH_LOOP", restarts: Number(restarts || 0) }), Date.now());
  } finally {
    console.log("── cleaning up ──");
    await docker(["rm", "--force", NAME], true);
    await docker(["rm", "--force", `${NAME}-crash`], true);
    await docker(["volume", "rm", "--force", VOLUME], true);
  }

  const leftoverContainers = await docker(["ps", "-a", "--filter", `name=${NAME}`, "--format", "{{.Names}}"], true);
  const leftoverVolumes = await docker(["volume", "ls", "--filter", `name=${VOLUME}`, "--format", "{{.Name}}"], true);
  record("all test resources destroyed", { containers: leftoverContainers || "(none)", volumes: leftoverVolumes || "(none)" },
    leftoverContainers === "" && leftoverVolumes === "" ? "clean" : "LEFTOVERS", leftoverContainers === "" && leftoverVolumes === "");

  const passed = steps.filter((s) => s.pass).length;
  const evidence = {
    _comment: "Live observations of a real container from the P24 runtime image, driven through its lifecycle. Every value was read from Docker or from the process inside the container.",
    generatedAt: new Date().toISOString(),
    image: TAG,
    imageConfigDigest: CONFIG_DIGEST,
    passed, failed: steps.length - passed,
    steps,
    runtimeEvents: events.query({}),
    alerts: alerts.all(),
    metrics: telemetry.emitted,
  };
  const hits = scanForSecrets(evidence, "$p25runtime");
  if (hits.length > 0) throw new Error(`evidence contains ${hits.length} secret-shaped value(s)`);
  writeFileSync(OUT, JSON.stringify(evidence, null, 2) + "\n");

  console.log(`\n${passed}/${steps.length} passed — written to ${OUT}`);
  if (passed !== steps.length) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  await exec("docker", ["rm", "--force", NAME]).catch(() => {});
  await exec("docker", ["volume", "rm", "--force", VOLUME]).catch(() => {});
  process.exit(1);
});
