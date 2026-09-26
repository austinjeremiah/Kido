import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  OfficialCliCreSimulationProvider, superviseState, DEFAULT_SUPERVISOR,
} from "../src/cli-provider.js";
import {
  SimulationEventSchema, FORBIDDEN_SIM_EVENT_TYPES, SIM_STATES, SIM_REASONS, SimulationError,
  type SimulationEvent, type SimulationSession,
} from "../src/provider.js";
import {
  CreSimulationScheduler, CRON_SIMULATION_LABEL, FORBIDDEN_CRON_LABEL, FASTEST_CRON_INTERVAL_MS,
  SchedulerError, SCHEDULER_REASONS, TriggerGateway, TriggerGatewayError, TRIGGER_GATEWAY_REASONS,
  HTTP_TRIGGER_RATE_LIMIT, MAX_TRIGGER_PAYLOAD_BYTES, assertLogTriggerSourceAllowed,
} from "../src/scheduler.js";
import { baseConfig, recorder, sourceLines, isComment } from "./fixtures.js";

/**
 * Process supervision: what the simulator does when it stops behaving.
 *
 * A live run proves the CLI works. It cannot prove what happens when the CLI crashes on the third
 * restart, or hangs alive and silent, or asks for a login — so those are driven through an injected
 * child process, and the live evidence covers the happy path it can actually produce.
 */

const REAL_TX = "0x62753fddb9c92d2ff9989c430e2ca47224f992ac3243eb77bea05eda21679843";

const newProvider = () => {
  const rec = recorder();
  const provider = new OfficialCliCreSimulationProvider("SIMULATED_USER", {
    binary: "/opt/cre/bin/cre",
    spawnFn: rec.spawnFn,
    nowMs: () => 1_000_000,
  });
  return { provider, rec };
};

const sessionAt = (over: Partial<SimulationSession>): SimulationSession => ({
  simulationId: "cre-sim://contextlock/session/0189a1c4-4f2e-47b7-9c58-2b1d3e5f7a90",
  config: baseConfig(), state: "RUNNING", startedAtMs: 1_000, lastEventAtMs: 1_000,
  restarts: 0, commandLine: ["cre"], exitCode: null, detail: null, ...over,
});

/* ─────────────────────────── CRELAB-003 ─────────────────────────── */

describe("CRELAB-003 the official CLI is what actually runs", () => {
  it("CRELAB-003 the command built is a real `cre workflow simulate` invocation", async () => {
    const { provider, rec } = newProvider();
    const session = await provider.prepare(baseConfig());
    await provider.start(session.simulationId);

    const call = rec.calls[0];
    expect(call?.bin).toBe("/opt/cre/bin/cre");
    expect(call?.args.slice(0, 3)).toEqual(["workflow", "simulate", "./policy"]);
    expect(call?.args).toContain("--non-interactive");
    expect(call?.args).toContain("--target");
    expect(call?.args).toContain("staging-settings");
    // Production limits are stated on the command line rather than inherited from a default.
    expect(call?.args.join(" ")).toMatch(/--limits default/);
  });

  it("CRELAB-003b the executed argv is recorded on the session, so the claim is checkable", async () => {
    const { provider } = newProvider();
    const s = await provider.prepare(baseConfig());
    const started = await provider.start(s.simulationId);
    expect(started.commandLine[0]).toBe("/opt/cre/bin/cre");
    expect(started.commandLine.join(" ")).toMatch(/workflow simulate .\/policy --non-interactive/);
  });

  it("CRELAB-003c nothing is simulated without the CLI: no child, no result", async () => {
    /*
     * The package contains no CRE engine. If the binary never runs, there is no path that produces
     * a result anyway — which is what stops a reimplementation quietly becoming the source of truth.
     */
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    const run = provider.invoke(s.simulationId, { kind: "EVM_LOG_ONESHOT", txHash: REAL_TX, eventIndex: 0 });
    rec.last().finish(127); // binary missing
    const out = await run;
    expect(out.exitCode).toBe(127);
    expect(out.events.some((e) => e.type === "CRE_SIM_RESULT")).toBe(false);
    expect(out.events.some((e) => e.type === "CRE_SIM_ERROR")).toBe(true);
  });

  it("CRELAB-003d the default binary is the installed CRE CLI, not a bundled one", () => {
    const bare = new OfficialCliCreSimulationProvider("SIMULATED_USER", {});
    expect(bare.id).toBe("official-cre-cli");
    expect(bare.mode).toBe("SIMULATED_USER");
  });

  it("CRELAB-003e a config for a different mode is refused by the provider that would run it", async () => {
    const { provider } = newProvider();
    let err: SimulationError | null = null;
    try { await provider.prepare(baseConfig({ mode: "SIMULATED_PLATFORM" })); } catch (e) { err = e as SimulationError; }
    expect(err?.reason).toBe(SIM_REASONS.WRONG_MODE);
  });

  it("CRELAB-003f a one-shot EVM run passes the real transaction and event index through", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    const run = provider.invoke(s.simulationId, { kind: "EVM_LOG_ONESHOT", txHash: REAL_TX, eventIndex: 0 });
    rec.last().finish(0);
    await run;
    const args = rec.calls[0]?.args ?? [];
    expect(args).toContain("--evm-tx-hash");
    expect(args[args.indexOf("--evm-tx-hash") + 1]).toBe(REAL_TX);
    expect(args).toContain("--evm-event-index");
    expect(args[args.indexOf("--evm-event-index") + 1]).toBe("0");
    // A one-shot run must exit, so it must not ask the simulator to keep listening.
    expect(args).not.toContain("--listen");
  });
});

/* ─────────────────────────── CRELAB-007 ─────────────────────────── */

describe("CRELAB-007 the HTTP trigger is supervised and gated", () => {
  it("CRELAB-007 an HTTP listen run asks the simulator to keep listening", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig({ triggerKind: "HTTP", httpTriggerPort: 7357 }));
    const run = provider.invoke(s.simulationId, { kind: "HTTP" });
    rec.last().finish(0);
    await run;
    const args = rec.calls[0]?.args ?? [];
    expect(args).toContain("--listen");
    expect(args).toContain("--http-trigger-port");
  });

  it("CRELAB-007b a one-shot HTTP payload does not listen", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig({ triggerKind: "HTTP", httpTriggerPort: 7357 }));
    const run = provider.invoke(s.simulationId, { kind: "HTTP", payload: { hello: "world" } });
    rec.last().finish(0);
    await run;
    expect(rec.calls[0]?.args).not.toContain("--listen");
    expect(rec.calls[0]?.args).toContain("--http-payload");
  });

  it("CRELAB-007c an unauthenticated trigger never reaches the CLI", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    const gw = new TriggerGateway(provider, () => new Set(["dep_contextlock_001"]), () => 1_000);
    await expect(gw.submit({
      projectId: "contextlock", deploymentId: "dep_contextlock_001", simulationId: s.simulationId,
      payload: {}, idempotencyKey: "k1", actorId: null,
    })).rejects.toMatchObject({ reason: TRIGGER_GATEWAY_REASONS.UNAUTHENTICATED });
    expect(rec.calls.length, "the CLI must not be spawned for a rejected trigger").toBe(0);
  });

  it("CRELAB-007d an unknown deployment is refused", async () => {
    const { provider } = newProvider();
    const s = await provider.prepare(baseConfig());
    const gw = new TriggerGateway(provider, () => new Set(["dep_other"]), () => 1_000);
    await expect(gw.submit({
      projectId: "contextlock", deploymentId: "dep_contextlock_001", simulationId: s.simulationId,
      payload: {}, idempotencyKey: "k1", actorId: "user_1",
    })).rejects.toMatchObject({ reason: TRIGGER_GATEWAY_REASONS.UNKNOWN_DEPLOYMENT });
  });

  it("CRELAB-007e an oversized payload is refused before it is parsed", async () => {
    const { provider } = newProvider();
    const s = await provider.prepare(baseConfig());
    const gw = new TriggerGateway(provider, () => new Set(["dep_contextlock_001"]), () => 1_000);
    await expect(gw.submit({
      projectId: "contextlock", deploymentId: "dep_contextlock_001", simulationId: s.simulationId,
      payload: { blob: "x".repeat(MAX_TRIGGER_PAYLOAD_BYTES + 1) }, idempotencyKey: "k1", actorId: "user_1",
    })).rejects.toMatchObject({ reason: TRIGGER_GATEWAY_REASONS.PAYLOAD_TOO_LARGE });
  });

  it("CRELAB-007f a payload failing the declared schema is refused", async () => {
    const { provider } = newProvider();
    const s = await provider.prepare(baseConfig());
    const gw = new TriggerGateway(provider, () => new Set(["dep_contextlock_001"]), () => 1_000);
    const schema = z.object({ amount: z.number().positive() });
    await expect(gw.submit({
      projectId: "contextlock", deploymentId: "dep_contextlock_001", simulationId: s.simulationId,
      payload: { amount: -5 }, idempotencyKey: "k1", actorId: "user_1",
    }, schema)).rejects.toMatchObject({ reason: TRIGGER_GATEWAY_REASONS.SCHEMA_INVALID });
  });

  it("CRELAB-007g the gateway mirrors CRE's own rate limit rather than inventing one", async () => {
    expect(HTTP_TRIGGER_RATE_LIMIT).toEqual({ windowMs: 30_000, max: 1 });
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    let now = 1_000;
    const gw = new TriggerGateway(provider, () => new Set(["dep_contextlock_001"]), () => now);
    const req = (k: string) => ({
      projectId: "contextlock", deploymentId: "dep_contextlock_001", simulationId: s.simulationId,
      payload: { n: 1 }, idempotencyKey: k, actorId: "user_1",
    });

    const first = gw.submit(req("k1"));
    rec.last().finish(0);
    await first;

    await expect(gw.submit(req("k2"))).rejects.toMatchObject({ reason: TRIGGER_GATEWAY_REASONS.RATE_LIMITED });

    // Past the window, it is allowed again — a limit, not a one-shot lock.
    now += HTTP_TRIGGER_RATE_LIMIT.windowMs + 1;
    const third = gw.submit(req("k3"));
    rec.last().finish(0);
    await expect(third).resolves.toMatchObject({ accepted: true });
  });

  it("CRELAB-007h a replayed idempotency key is refused", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    let now = 1_000;
    const gw = new TriggerGateway(provider, () => new Set(["dep_contextlock_001"]), () => now);
    const req = { projectId: "contextlock", deploymentId: "dep_contextlock_001", simulationId: s.simulationId, payload: { n: 1 }, idempotencyKey: "same", actorId: "user_1" };
    const first = gw.submit(req);
    rec.last().finish(0);
    await first;
    now += HTTP_TRIGGER_RATE_LIMIT.windowMs + 1; // past the rate limit, so ONLY replay can catch it
    await expect(gw.submit(req)).rejects.toMatchObject({ reason: TRIGGER_GATEWAY_REASONS.REPLAY });
  });

  it("CRELAB-007i a silent simulator goes STALE rather than staying RUNNING", () => {
    const s = sessionAt({ state: "RUNNING", lastEventAtMs: 1_000 });
    const verdict = superviseState(s, 1_000 + DEFAULT_SUPERVISOR.staleAfterMs + 1);
    expect(verdict.state).toBe("STALE");
    expect(verdict.reason).toMatch(/no simulator output/);
    expect(verdict.shouldRestart, "a hang is not something a restart is entitled to fix silently").toBe(false);
  });

  it("CRELAB-007j a simulator inside the window stays RUNNING", () => {
    const s = sessionAt({ state: "RUNNING", lastEventAtMs: 1_000 });
    expect(superviseState(s, 1_000 + DEFAULT_SUPERVISOR.staleAfterMs - 1).state).toBe("RUNNING");
  });
});

/* ─────────────────────────── CRELAB-008 ─────────────────────────── */

describe("CRELAB-008 the EVM log trigger is supervised, and cannot grant authority", () => {
  it("CRELAB-008 a listening EVM run passes --listen", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig({ triggerKind: "EVM_LOG_LISTEN" }));
    const run = provider.invoke(s.simulationId, { kind: "EVM_LOG_LISTEN" });
    rec.last().finish(0);
    await run;
    expect(rec.calls[0]?.args).toContain("--listen");
  });

  it("CRELAB-008b a mainnet log may trigger a simulation when the Blueprint declares it", () => {
    // §P26.10: observation is a different permission from execution.
    expect(() => assertLogTriggerSourceAllowed({ chainId: 1, role: "READ_ONLY_SOURCE" }, true)).not.toThrow();
  });

  it("CRELAB-008c an undeclared mainnet observation is refused", () => {
    let err: TriggerGatewayError | null = null;
    try { assertLogTriggerSourceAllowed({ chainId: 1, role: "READ_ONLY_SOURCE" }, false); } catch (e) { err = e as TriggerGatewayError; }
    expect(err).toBeInstanceOf(TriggerGatewayError);
    expect(err?.message).toMatch(/read-only source/);
  });

  it("CRELAB-008d observing mainnet grants no mainnet execution authority", async () => {
    /*
     * The central rule of the group, at a real seam: a Blueprint that IS allowed to watch mainnet
     * still cannot broadcast there. The read permission and the write permission never meet.
     */
    const { assertDataCannotGrantExecution } = await import("@contextlock/studio-network");
    expect(() => assertLogTriggerSourceAllowed({ chainId: 1, role: "READ_ONLY_SOURCE" }, true)).not.toThrow();
    expect(() => assertDataCannotGrantExecution(
      [{ chainId: 1, role: "READ_ONLY_SOURCE", forkedFrom: null, forkBlock: null }],
      { chainId: 1, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null },
      "CRE_BROADCAST",
    )).toThrow(/PRODUCTION_NETWORK_WRITE_PROHIBITED/);
    // The same read set with a testnet target is fine, so it is the target that decided.
    expect(() => assertDataCannotGrantExecution(
      [{ chainId: 1, role: "READ_ONLY_SOURCE", forkedFrom: null, forkBlock: null }],
      { chainId: 11155111, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null },
      "CRE_BROADCAST",
    )).not.toThrow();
  });
});

/* ─────────────────────────── CRELAB-009 ─────────────────────────── */

describe("CRELAB-009 a scheduled run is labelled as simulated", () => {
  it("CRELAB-009 every tick carries the simulated-cron label", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    const sched = new CreSimulationScheduler(provider, () => 5_000);
    sched.schedule({ simulationId: s.simulationId, deploymentId: "dep_contextlock_001", intervalMs: 60_000, triggerIndex: 0, enabled: true });

    const tick = sched.tick(s.simulationId);
    rec.last().finish(0);
    const out = await tick;

    expect(out.label).toBe(CRON_SIMULATION_LABEL);
    expect(out.label).toMatch(/simulated by ContextLock scheduler/);
    expect(out.label).not.toBe(FORBIDDEN_CRON_LABEL);
    expect(sched.get(s.simulationId)?.runs).toBe(1);
    expect(sched.get(s.simulationId)?.lastRunAtMs).toBe(5_000);
  });

  it("CRELAB-009b the forbidden label appears nowhere except as the thing being forbidden", () => {
    const lines = sourceLines(/CRE DON cron running/);
    /*
     * The sentence may appear in commentary that explains the rule, and in exactly one line of
     * code: the constant that names it in order to forbid it. Any other code occurrence is a label
     * some renderer could reach.
     */
    const code = lines.filter((l) => !isComment(l.text) && !l.text.includes("FORBIDDEN_CRON_LABEL"));
    expect(code.map((l) => `${l.file}:${l.text.trim()}`)).toEqual([]);
    expect(lines.length, "the search found nothing at all — it is looking in the wrong place").toBeGreaterThan(0);
  });

  it("CRELAB-009c a schedule faster than CRE's own minimum is refused", () => {
    const { provider } = newProvider();
    const sched = new CreSimulationScheduler(provider, () => 0);
    let err: SchedulerError | null = null;
    try {
      sched.schedule({ simulationId: "s", deploymentId: "d", intervalMs: FASTEST_CRON_INTERVAL_MS - 1, triggerIndex: 0, enabled: true });
    } catch (e) { err = e as SchedulerError; }
    expect(err?.reason).toBe(SCHEDULER_REASONS.TOO_FAST);
    expect(err?.message).toMatch(/does not test production/);
    expect(FASTEST_CRON_INTERVAL_MS).toBe(30_000);
  });

  it("CRELAB-009d exactly the minimum is allowed", () => {
    const { provider } = newProvider();
    const sched = new CreSimulationScheduler(provider, () => 0);
    expect(() => sched.schedule({ simulationId: "s", deploymentId: "d", intervalMs: FASTEST_CRON_INTERVAL_MS, triggerIndex: 0, enabled: true })).not.toThrow();
  });

  it("CRELAB-009e a tick for an unknown schedule is an error, not a silent no-op", async () => {
    const { provider } = newProvider();
    const sched = new CreSimulationScheduler(provider, () => 0);
    await expect(sched.tick("cre-sim://nope/session/x")).rejects.toMatchObject({ reason: SCHEDULER_REASONS.NOT_FOUND });
  });
});

/* ─────────────────────── CRELAB-010 / 011 ─────────────────────── */

describe("CRELAB-010 a crash is detected and distinguished", () => {
  it("CRELAB-010 a non-zero exit becomes CRASHED with an error event", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    await provider.start(s.simulationId);
    rec.last().finish(3);
    const after = await provider.getStatus(s.simulationId);
    expect(after.state).toBe("CRASHED");
    expect(after.exitCode).toBe(3);
    const events = await provider.getEvents(s.simulationId);
    expect(events.some((e) => e.type === "CRE_SIM_ERROR")).toBe(true);
  });

  it("CRELAB-010b a clean exit is STOPPED, not a crash", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    await provider.start(s.simulationId);
    rec.last().finish(0);
    expect((await provider.getStatus(s.simulationId)).state).toBe("STOPPED");
  });

  it("CRELAB-010c an auth prompt is AUTH_REQUIRED even though the exit code is a crash", async () => {
    /*
     * Two states a naive supervisor would merge. The fix for a missing login is a login; the fix for
     * a crash is a restart. Restarting a logged-out CLI loops forever and reports nothing useful.
     */
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    await provider.start(s.simulationId);
    rec.last().err("Error: not authenticated. Run `cre login` to continue.");
    rec.last().finish(1);
    expect((await provider.getStatus(s.simulationId)).state).toBe("AUTH_REQUIRED");
  });

  it("CRELAB-010d the supervisor refuses to restart an unauthenticated simulator", () => {
    const v = superviseState(sessionAt({ state: "AUTH_REQUIRED" }), 2_000);
    expect(v.shouldRestart).toBe(false);
    expect(v.reason).toMatch(/restarting will not fix it/);
  });

  it("CRELAB-010e a crash within the budget is restartable", () => {
    const v = superviseState(sessionAt({ state: "CRASHED", exitCode: 2, restarts: 1 }), 2_000);
    expect(v.shouldRestart).toBe(true);
    expect(v.reason).toMatch(/exited with code 2/);
  });

  it("CRELAB-010f a crash past the budget is not", () => {
    const v = superviseState(sessionAt({ state: "CRASHED", exitCode: 2, restarts: DEFAULT_SUPERVISOR.maxRestarts }), 2_000);
    expect(v.shouldRestart).toBe(false);
    expect(v.reason).toMatch(/not retrying/);
  });

  it("CRELAB-010g every state in the machine is reachable as a named constant", () => {
    expect([...SIM_STATES]).toContain("AUTH_REQUIRED");
    expect([...SIM_STATES]).toContain("STALE");
    expect(SIM_STATES.length).toBe(8);
  });
});

describe("CRELAB-011 restart", () => {
  it("CRELAB-011 a restart spawns the CLI again and counts itself", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    await provider.start(s.simulationId);
    rec.last().finish(1);

    const restarted = await provider.restart(s.simulationId);
    expect(restarted.restarts).toBe(1);
    expect(restarted.state).toBe("RUNNING");
    expect(rec.calls.length, "the CLI is genuinely spawned a second time").toBe(2);
    expect(rec.calls[1]?.args).toEqual(rec.calls[0]?.args);

    const events = await provider.getEvents(s.simulationId);
    expect(events.some((e) => e.type === "CRE_SIM_RESTARTED")).toBe(true);
  });

  it("CRELAB-011b a restart of a live process stops it first", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    await provider.start(s.simulationId);
    const first = rec.last();
    await provider.restart(s.simulationId);
    expect(first.signals).toContain("SIGTERM");
  });

  it("CRELAB-011c starting an already-running simulation is refused rather than doubled", async () => {
    const { provider } = newProvider();
    const s = await provider.prepare(baseConfig());
    await provider.start(s.simulationId);
    await expect(provider.start(s.simulationId)).rejects.toMatchObject({ reason: SIM_REASONS.ALREADY_RUNNING });
  });

  it("CRELAB-011d destroy kills the process and forgets the session", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    await provider.start(s.simulationId);
    const child = rec.last();
    await provider.destroy(s.simulationId);
    expect(child.signals).toContain("SIGKILL");
    await expect(provider.getStatus(s.simulationId)).rejects.toMatchObject({ reason: SIM_REASONS.NOT_PREPARED });
  });

  it("CRELAB-011e an unprepared simulation cannot be started", async () => {
    const { provider } = newProvider();
    await expect(provider.start("cre-sim://x/session/y")).rejects.toMatchObject({ reason: SIM_REASONS.NOT_PREPARED });
  });
});

/* ─────────────────────── CRELAB-012 / 013 ─────────────────────── */

describe("CRELAB-012 simulator output is normalized before it is stored", () => {
  it("CRELAB-012 a very long output line is bounded", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    await provider.start(s.simulationId);
    rec.last().say(`execution started ${"x".repeat(9_000)}`);
    const events = await provider.getEvents(s.simulationId);
    const long = events.find((e) => e.type === "CRE_SIM_EXECUTION_STARTED");
    expect(long?.message.length).toBeLessThanOrEqual(2_000);
    expect(SimulationEventSchema.safeParse(long).success).toBe(true);
  });

  it("CRELAB-012j the schema bounds the message itself, independently of the truncation", () => {
    /*
     * Two guards, and until this test only one of them was exercised.
     *
     * `emit()` truncates before building the event, so every event the provider produces is already
     * short — which means the schema's own `.max(2000)` never had to catch anything, and deleting it
     * left the whole suite green. This drives the schema directly, with a message no truncation has
     * touched, so each guard now fails on its own.
     */
    const overlong = { simulationId: "cre-sim://p/session/x", type: "CRE_SIM_RESULT", atMs: 1, message: "z".repeat(2_001), detail: {} };
    expect(SimulationEventSchema.safeParse(overlong).success).toBe(false);
    expect(SimulationEventSchema.safeParse({ ...overlong, message: "z".repeat(2_000) }).success).toBe(true);
  });

  it("CRELAB-012f every emitted event validates against the schema", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    await provider.start(s.simulationId);
    const child = rec.last();
    child.say("trigger received: CapabilityRequested");
    child.say("execution started");
    child.say("workflow completed");
    child.say("dry-run: would send 1 transaction");
    child.finish(0);
    const events = await provider.getEvents(s.simulationId);
    expect(events.length).toBeGreaterThan(4);
    for (const e of events) expect(SimulationEventSchema.safeParse(e).success, e.type).toBe(true);
  });

  it("CRELAB-012g blank output produces no events", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    await provider.start(s.simulationId);
    const before = (await provider.getEvents(s.simulationId)).length;
    rec.last().say("   ");
    rec.last().say("");
    expect((await provider.getEvents(s.simulationId)).length).toBe(before);
  });

  it("CRELAB-012h a simulation cannot emit a deployment event, because the type does not exist", () => {
    /*
     * The absence is the assertion. An event named CRE_DEPLOYED inside an audit log would be
     * indistinguishable from a true one, so there is no way to construct it.
     */
    for (const forbidden of FORBIDDEN_SIM_EVENT_TYPES) {
      const candidate = { simulationId: "s", type: forbidden, atMs: 1, message: "m", detail: {} };
      expect(SimulationEventSchema.safeParse(candidate).success, forbidden).toBe(false);
    }
  });

  it("CRELAB-012i output claiming a broadcast in a dry run is still recorded honestly", async () => {
    /*
     * The event type follows the CLI's words; whether a transaction was really sent follows the
     * config. Both are kept, so a mismatch is visible rather than reconciled away.
     */
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    await provider.start(s.simulationId);
    rec.last().say("dry-run: simulated write prepared");
    const events = await provider.getEvents(s.simulationId);
    expect(events.some((e) => e.type === "CRE_SIM_WRITE_DRY_RUN")).toBe(true);
    expect((await provider.getStatus(s.simulationId)).config.broadcastMode).toBe("DRY_RUN");
  });
});

describe("CRELAB-013 no secret reaches the simulator's process, or its records", () => {
  const BURNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

  it("CRELAB-013 the child environment is narrow, and does not inherit the parent's", async () => {
    const { provider, rec } = newProvider();
    process.env.CONTEXTLOCK_TEST_LEAK_CANARY = "leak-canary-must-not-propagate";
    try {
      const s = await provider.prepare(baseConfig());
      await provider.start(s.simulationId);
      const env = rec.calls[0]?.env ?? {};
      expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
      expect(JSON.stringify(env)).not.toMatch(/leak-canary-must-not-propagate/);
    } finally {
      delete process.env.CONTEXTLOCK_TEST_LEAK_CANARY;
    }
  });

  it("CRELAB-013b a broadcast burner key reaches the CLI's env and nothing else", async () => {
    const rec = recorder();
    const provider = new OfficialCliCreSimulationProvider("SIMULATED_USER", {
      binary: "/opt/cre/bin/cre", spawnFn: rec.spawnFn, nowMs: () => 1_000,
      resolveBurner: async () => ({ address: "0x0000000000000000000000000000000000000bee", privateKeyEnv: { CRE_ETH_PRIVATE_KEY: BURNER_KEY } }),
    });
    const s = await provider.prepare(baseConfig({
      broadcastMode: "TESTNET_BROADCAST",
      broadcastNetwork: { chainId: 11155111, role: "TESTNET_EXECUTION" },
    }));
    await provider.start(s.simulationId);

    // In the environment, because the CLI needs it to sign.
    expect(rec.calls[0]?.env.CRE_ETH_PRIVATE_KEY).toBe(BURNER_KEY);

    // And nowhere a human or an audit record would ever see it.
    const status = await provider.getStatus(s.simulationId);
    const events = await provider.getEvents(s.simulationId);
    expect(JSON.stringify(status)).not.toContain(BURNER_KEY);
    expect(JSON.stringify(status.commandLine)).not.toContain(BURNER_KEY);
    expect(JSON.stringify(events)).not.toContain(BURNER_KEY);
  });

  it("CRELAB-013c a broadcast without an approved network is refused before a key is resolved", async () => {
    let resolved = 0;
    const rec = recorder();
    const provider = new OfficialCliCreSimulationProvider("SIMULATED_USER", {
      binary: "/opt/cre/bin/cre", spawnFn: rec.spawnFn,
      resolveBurner: async () => { resolved += 1; return { address: "0x0", privateKeyEnv: {} }; },
    });
    await expect(provider.prepare(baseConfig({ broadcastMode: "TESTNET_BROADCAST", broadcastNetwork: null })))
      .rejects.toMatchObject({ reason: SIM_REASONS.WRONG_MODE });
    expect(resolved, "a key must not be minted for a broadcast that was never going to be allowed").toBe(0);
  });

  it("CRELAB-013d a dry run resolves no key at all", async () => {
    let resolved = 0;
    const rec = recorder();
    const provider = new OfficialCliCreSimulationProvider("SIMULATED_USER", {
      binary: "/opt/cre/bin/cre", spawnFn: rec.spawnFn,
      resolveBurner: async () => { resolved += 1; return { address: "0x0", privateKeyEnv: { CRE_ETH_PRIVATE_KEY: BURNER_KEY } }; },
    });
    const s = await provider.prepare(baseConfig());
    await provider.start(s.simulationId);
    expect(resolved).toBe(0);
    expect(rec.calls[0]?.env.CRE_ETH_PRIVATE_KEY).toBeUndefined();
  });

  it("CRELAB-013e an event never carries raw provider output beyond its bound", async () => {
    const { provider, rec } = newProvider();
    const s = await provider.prepare(baseConfig());
    await provider.start(s.simulationId);
    rec.last().err(`error: ${BURNER_KEY} ${"y".repeat(5_000)}`);
    const events: SimulationEvent[] = await provider.getEvents(s.simulationId);
    for (const e of events) expect(e.message.length).toBeLessThanOrEqual(2_000);
  });
});
