import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  broadcastFlags, limitsFlags, assertLimitsSatisfyGate, assertNotUserWallet,
  type NetworkRef,
} from "@contextlock/studio-network";
import {
  newSimulationId, SimulationError, SIM_REASONS, SimulationConfigSchema,
  type CreRuntimeProvider, type SimulationConfig, type SimulationEvent, type SimulationSession, type SimState, type TriggerKind,
} from "./provider.js";

/**
 * The official CRE CLI simulator, driven as a supervised child process.
 *
 * This is the primary provider, and it runs the real `cre workflow simulate`. Nothing here
 * reimplements CRE semantics: limits, trigger handling, capability calls and write preparation all
 * happen inside Chainlink's binary, which is the only way a simulation's agreement with production
 * means anything.
 *
 * What ContextLock adds is supervision and honesty — a process that can crash, a state machine that
 * distinguishes "crashed" from "wants a login", and identifiers that cannot be mistaken for a
 * deployment.
 */

export interface CliProviderDeps {
  binary?: string;
  nowMs?: () => number;
  /** Injected so tests drive the state machine without a CLI. */
  spawnFn?: typeof spawn;
  /** Where the burner key is resolved, for a broadcast. Never returns it to the caller. */
  resolveBurner?: (deploymentId: string) => Promise<{ address: string; privateKeyEnv: Record<string, string> }>;
  onEvent?: (e: SimulationEvent) => void;
}

interface Live {
  session: SimulationSession;
  child: ChildProcess | null;
  events: SimulationEvent[];
  /** Set when the CLI's own output says it needs authentication. */
  sawAuthPrompt: boolean;
}

/** Output lines that mean the CLI wants a login rather than that it failed. */
const AUTH_PATTERNS = [/not authenticated/i, /cre login/i, /session (has )?expired/i, /unauthoriz/i];

/** Output lines worth turning into events. Everything else is bounded and dropped. */
const RESULT_PATTERNS: Array<{ re: RegExp; type: SimulationEvent["type"] }> = [
  { re: /trigger (received|fired|matched)/i, type: "CRE_SIM_TRIGGER_RECEIVED" },
  { re: /execution (started|beginning)/i, type: "CRE_SIM_EXECUTION_STARTED" },
  { re: /(workflow (completed|finished)|execution (succeeded|completed))/i, type: "CRE_SIM_RESULT" },
  { re: /would (send|broadcast)|dry.?run|simulated (write|transaction)/i, type: "CRE_SIM_WRITE_DRY_RUN" },
  { re: /broadcast(ing)? (transaction|tx)|sent transaction/i, type: "CRE_SIM_TESTNET_BROADCAST" },
  { re: /error|panic|failed/i, type: "CRE_SIM_ERROR" },
];

export class OfficialCliCreSimulationProvider implements CreRuntimeProvider {
  readonly id = "official-cre-cli";
  readonly mode: "SIMULATED_PLATFORM" | "SIMULATED_USER";
  private readonly live = new Map<string, Live>();

  constructor(mode: "SIMULATED_PLATFORM" | "SIMULATED_USER", private readonly deps: CliProviderDeps = {}) {
    this.mode = mode;
  }

  private now(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private emit(l: Live, type: SimulationEvent["type"], message: string, detail: Record<string, unknown> = {}): void {
    const e: SimulationEvent = { simulationId: l.session.simulationId, type, atMs: this.now(), message: message.slice(0, 2000), detail };
    l.events.push(e);
    l.session.lastEventAtMs = e.atMs;
    this.deps.onEvent?.(e);
  }

  /**
   * Build the argv.
   *
   * The only place a `cre workflow simulate` command line is constructed, so what runs is derivable
   * from the config rather than assembled in three places that drift.
   */
  private argv(config: SimulationConfig, trigger?: { kind: TriggerKind; payload?: unknown; txHash?: string; eventIndex?: number }): string[] {
    const args = ["workflow", "simulate", config.projectDir, "--non-interactive"];
    if (config.target) args.push("--target", config.target);

    // Limits, always explicit. Relying on the CLI's default would leave the recorded command silent
    // about the thing the gate depends on.
    args.push(...limitsFlags(config.limitsMode, config.limitsFile ?? undefined));

    // Broadcast goes through the product-wide network guard, not a local check.
    const b = broadcastFlags({
      mode: config.broadcastMode,
      network: config.broadcastNetwork
        ? { chainId: config.broadcastNetwork.chainId, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null }
        : { chainId: 11155111, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null },
      signer: "EPHEMERAL_TESTNET_BURNER",
      context: `simulation ${config.deploymentId}`,
    });
    args.push(...b.flags);

    if (config.triggerIndex !== null) args.push("--trigger-index", String(config.triggerIndex));

    const kind = trigger?.kind ?? config.triggerKind;
    if (kind === "HTTP") {
      if (trigger?.payload !== undefined) args.push("--http-payload", typeof trigger.payload === "string" ? trigger.payload : JSON.stringify(trigger.payload));
      if (config.httpTriggerPort) args.push("--http-trigger-port", String(config.httpTriggerPort));
    }
    if (kind === "EVM_LOG_ONESHOT" && trigger?.txHash) {
      args.push("--evm-tx-hash", trigger.txHash);
      if (trigger.eventIndex !== undefined) args.push("--evm-event-index", String(trigger.eventIndex));
    }
    // `--listen` keeps the simulator alive watching for triggers. Only for the listening kinds.
    if (kind === "EVM_LOG_LISTEN" || (kind === "HTTP" && trigger?.payload === undefined)) args.push("--listen");

    return args;
  }

  async prepare(config: SimulationConfig): Promise<SimulationSession> {
    const parsed = SimulationConfigSchema.parse(config);
    if (parsed.mode !== this.mode) {
      throw new SimulationError(SIM_REASONS.WRONG_MODE, `this provider is ${this.mode} and the config is ${parsed.mode}`);
    }
    if (parsed.broadcastMode === "TESTNET_BROADCAST") {
      assertNotUserWallet("EPHEMERAL_TESTNET_BURNER", null);
      if (!parsed.broadcastNetwork) {
        throw new SimulationError(SIM_REASONS.WRONG_MODE, "TESTNET_BROADCAST requires an approved execution network");
      }
    }

    const simulationId = newSimulationId(parsed.projectId, randomUUID());
    const session: SimulationSession = {
      simulationId, config: parsed, state: "PREPARING", startedAtMs: null, lastEventAtMs: null,
      restarts: 0, commandLine: [this.deps.binary ?? "cre", ...this.argv(parsed)], exitCode: null, detail: null,
    };
    this.live.set(simulationId, { session, child: null, events: [], sawAuthPrompt: false });
    return session;
  }

  async start(simulationId: string): Promise<SimulationSession> {
    const l = this.mustFind(simulationId);
    if (l.child) throw new SimulationError(SIM_REASONS.ALREADY_RUNNING, simulationId);

    const binary = this.deps.binary ?? `${process.env.HOME}/.cre/bin/cre`;
    const args = this.argv(l.session.config);
    l.session.commandLine = [binary, ...args];
    l.session.state = "STARTING";

    /*
     * The environment.
     *
     * Deliberately narrow. The simulator worker gets what the CLI needs and nothing else — in
     * particular the agent runtime's environment is not inherited, so a secret that reaches the
     * simulator cannot reach the agent by sharing a process tree.
     */
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    if (l.session.config.broadcastMode === "TESTNET_BROADCAST" && this.deps.resolveBurner) {
      const burner = await this.deps.resolveBurner(l.session.config.deploymentId);
      Object.assign(env, burner.privateKeyEnv);
    }

    const spawnFn = this.deps.spawnFn ?? spawn;
    const child = spawnFn(binary, args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    l.child = child;
    l.session.startedAtMs = this.now();
    l.session.state = "RUNNING";
    this.emit(l, "CRE_SIM_STARTED", `official CRE CLI simulator started: ${args.join(" ")}`, {
      wasmSha256: l.session.config.wasmSha256, limits: l.session.config.limitsMode, broadcast: l.session.config.broadcastMode,
    });

    const onLine = (line: string) => {
      const text = line.trim();
      if (!text) return;
      if (AUTH_PATTERNS.some((re) => re.test(text))) {
        l.sawAuthPrompt = true;
        l.session.state = "AUTH_REQUIRED";
        this.emit(l, "CRE_SIM_ERROR", `the CRE CLI needs authentication: ${text}`, { authRequired: true });
        return;
      }
      const match = RESULT_PATTERNS.find((p) => p.re.test(text));
      if (match) this.emit(l, match.type, text, {});
    };

    child.stdout?.on("data", (d: Buffer) => d.toString().split("\n").forEach(onLine));
    child.stderr?.on("data", (d: Buffer) => d.toString().split("\n").forEach(onLine));
    child.on("exit", (code) => {
      l.session.exitCode = code;
      l.child = null;
      // A clean exit from a one-shot run is STOPPED. Anything else, or an auth prompt, is not.
      l.session.state = l.sawAuthPrompt ? "AUTH_REQUIRED" : code === 0 ? "STOPPED" : "CRASHED";
      this.emit(l, l.session.state === "CRASHED" ? "CRE_SIM_ERROR" : "CRE_SIM_STOPPED", `simulator exited with code ${code}`, { exitCode: code });
    });

    return l.session;
  }

  async stop(simulationId: string): Promise<SimulationSession> {
    const l = this.mustFind(simulationId);
    l.child?.kill("SIGTERM");
    l.child = null;
    l.session.state = "STOPPED";
    this.emit(l, "CRE_SIM_STOPPED", "simulator stopped by an operator", {});
    return l.session;
  }

  async restart(simulationId: string): Promise<SimulationSession> {
    const l = this.mustFind(simulationId);
    if (l.child) await this.stop(simulationId);
    l.session.restarts += 1;
    l.session.state = "RESTARTING";
    this.emit(l, "CRE_SIM_RESTARTED", `restart #${l.session.restarts}`, { restarts: l.session.restarts });
    return this.start(simulationId);
  }

  async getStatus(simulationId: string): Promise<SimulationSession> {
    return this.mustFind(simulationId).session;
  }

  /** A one-shot run. Resolves when the CLI exits, which is what makes a cron tick observable. */
  async invoke(simulationId: string, trigger: { kind: TriggerKind; payload?: unknown; txHash?: string; eventIndex?: number }): Promise<{ exitCode: number; events: SimulationEvent[] }> {
    const l = this.mustFind(simulationId);
    const binary = this.deps.binary ?? `${process.env.HOME}/.cre/bin/cre`;
    const args = this.argv(l.session.config, trigger);
    const before = l.events.length;

    this.emit(l, "CRE_SIM_TRIGGER_RECEIVED", `trigger ${trigger.kind}`, { kind: trigger.kind });

    const spawnFn = this.deps.spawnFn ?? spawn;
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const child = spawnFn(binary, args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });

    const onLine = (line: string) => {
      const text = line.trim();
      if (!text) return;
      if (AUTH_PATTERNS.some((re) => re.test(text))) { l.sawAuthPrompt = true; this.emit(l, "CRE_SIM_ERROR", text, { authRequired: true }); return; }
      const m = RESULT_PATTERNS.find((p) => p.re.test(text));
      if (m) this.emit(l, m.type, text, {});
    };
    child.stdout?.on("data", (d: Buffer) => d.toString().split("\n").forEach(onLine));
    child.stderr?.on("data", (d: Buffer) => d.toString().split("\n").forEach(onLine));

    const exitCode = await new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? -1)));
    if (exitCode !== 0 && !l.sawAuthPrompt) this.emit(l, "CRE_SIM_ERROR", `invocation exited ${exitCode}`, { exitCode });
    return { exitCode, events: l.events.slice(before) };
  }

  async getEvents(simulationId: string, sinceMs = 0): Promise<SimulationEvent[]> {
    return this.mustFind(simulationId).events.filter((e) => e.atMs >= sinceMs);
  }

  async destroy(simulationId: string): Promise<void> {
    const l = this.live.get(simulationId);
    l?.child?.kill("SIGKILL");
    this.live.delete(simulationId);
  }

  private mustFind(simulationId: string): Live {
    const l = this.live.get(simulationId);
    if (!l) throw new SimulationError(SIM_REASONS.NOT_PREPARED, simulationId);
    return l;
  }
}

/**
 * The supervisor.
 *
 * Watches a simulation and decides when RUNNING has stopped meaning anything — the same problem as
 * the runtime health model, for the same reason: a process that is alive and producing nothing is
 * not working.
 */
export interface SupervisorPolicy {
  staleAfterMs: number;
  maxRestarts: number;
  restartWindowMs: number;
}

export const DEFAULT_SUPERVISOR: SupervisorPolicy = { staleAfterMs: 120_000, maxRestarts: 3, restartWindowMs: 600_000 };

export function superviseState(session: SimulationSession, nowMs: number, policy: SupervisorPolicy = DEFAULT_SUPERVISOR): { state: SimState; reason: string | null; shouldRestart: boolean } {
  if (session.state === "AUTH_REQUIRED") {
    // Restarting will not fix a missing login, and doing so would loop.
    return { state: "AUTH_REQUIRED", reason: "the CRE CLI needs authentication; restarting will not fix it", shouldRestart: false };
  }
  if (session.state === "CRASHED") {
    const canRestart = session.restarts < policy.maxRestarts;
    return {
      state: "CRASHED",
      reason: canRestart ? `exited with code ${session.exitCode}` : `exited with code ${session.exitCode}; ${session.restarts} restarts already, not retrying`,
      shouldRestart: canRestart,
    };
  }
  if (session.state === "RUNNING" && session.lastEventAtMs !== null && nowMs - session.lastEventAtMs > policy.staleAfterMs) {
    return { state: "STALE", reason: `no simulator output for ${Math.round((nowMs - session.lastEventAtMs) / 1000)}s`, shouldRestart: false };
  }
  return { state: session.state, reason: null, shouldRestart: false };
}
