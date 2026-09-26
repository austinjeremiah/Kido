import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import type { Address, Hex } from "viem";
import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";
import { AnvilForkProvider, type ForkDescriptor, type ForkTransaction, type MarketSnapshot, type ShadowDecision } from "@contextlock/studio-reality";
import {
  AlertEngine, ChainObserver, CommandLog, agentIsLive, evaluateRuntime, presentable, reconcile, alertForDrift,
  newEmergencyLock, runEmergencyLock, emergencySummary, observed, unavailable, DEFAULT_TTLS,
  type ControlCommand, type ChainQueries, type AdapterHealth, type RuntimeState, type PolicyState, type IdentityState,
} from "@contextlock/studio-control-plane";
import { type EventStore } from "@contextlock/studio-events";
import type { DecisionInputs } from "@contextlock/studio-lab";
import type { DB } from "../db.js";
import type { ControlPlaneDeps } from "../control/api.js";
import { SqliteEventStore, persistAlert, loadAlerts } from "../control/store.js";
import { indexedReader } from "../thegraph.js";
import {
  AAVE_POOL_ABI, DEFAULT_UPSTREAM_PROVIDER_ID, DEFAULT_UPSTREAM_RPC, ERC20_ABI, IDENTITY_ABI, MAINNET, POLICY_REGISTRY_ABI, USDC_DECIMALS, VARIABLE_RATE,
  ForkKeyring, artifactsPresent, forkChainReader, forkPublicClient, forkWalletClient, jsonRpc,
} from "./chain.js";
import { prepareRecord, runForkDeployment, POSITION } from "./deployer.js";
import { ForkDeploymentRecordSchema, FORK_DEPLOY_PHASES, type ForkDeploymentRecord, type ForkDeploymentState, type ForkDeployPhaseKey, type PhaseRecord } from "./record.js";
import { ForkAgentRuntime, type ApprovalSignature, type ApprovalTypedData, type DecisionRecord, type ExecutionRecord, type PendingEscalation, type TickSample } from "./runtime.js";
import { SCENARIO_DRIVERS, driversFor, type DriverObservation, type StressOption } from "./drivers.js";

/**
 * The fork lab.
 *
 * Owns every deployment to a local mainnet fork: the row that records it, the Anvil process that
 * is it, and the agent runtime that runs against it. Exposes three views of the same thing — the
 * deployment record for the Deploy screen, the control-plane readers for the deployed-agent
 * console, and the Lab readers for the lifecycle projection — and computes each from the live
 * state rather than from a status written earlier.
 *
 * What lives only in memory (the fork, the runtime) is reconciled to STOPPED on the next server
 * start. A row that outlived its process must say so.
 */

export interface ForkLabDeps {
  db: DB;
  upstreamRpcUrl?: string;
  upstreamProviderId?: string;
  repoRoot?: string;
  basePort?: number;
  tickMs?: number;
  nowMs?: () => number;
  anvilBinary?: string;
  /** Forks that may run at once; `FORK_LIMITS.maxConcurrentPerUser` when unset. A swarm needs one per member. */
  maxConcurrentForks?: number;
  /** The Blueprint reader the Lab already has. Injected so the two cannot disagree. */
  readBlueprint: (projectId: string) => Promise<ContextLockAgentBlueprint | null>;
  /** Injected for tests: replaces the fork provider and the runtime's clients. */
  forks?: AnvilForkProvider;
}

export interface ForkReadiness {
  gates: Array<{ label: string; status: "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN"; detail: string; blocker: string | null }>;
  canDeploy: boolean;
  blockedBy: string[];
  executionNetwork: { chainId: number; name: string; role: string; forkedFrom: number };
  mainnetWrites: "PROHIBITED";
  policyInitialState: "DISABLED";
  phases: ReadonlyArray<{ key: string; label: string }>;
  /** A deployment already running for this project, if there is one. */
  existing: ForkDeploymentView | null;
}

export interface ForkDeploymentView {
  deploymentId: string;
  projectId: string;
  buildId: string | null;
  blueprintRevision: number;
  state: ForkDeploymentState;
  phase: string;
  revision: string;
  record: ForkDeploymentRecord;
  /** Whether the fork process and the runtime exist in THIS server process. */
  live: { fork: boolean; runtime: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface ForkPositionView {
  deploymentId: string;
  policyEnabled: boolean | null;
  latest: TickSample | null;
  samples: TickSample[];
  decisions: DecisionRecord[];
  executions: ExecutionRecord[];
  /** Escalations waiting for a human signature. */
  pending: PendingEscalation[];
  /** The protocols this deployment exercises, with the stress controls each offers. */
  scenarios: Array<{ driverId: string; protocol: string; actionKind: string; detail: string; stressOptions: StressOption[] }>;
  unexercisedActionKinds: string[];
  runtime: { state: RuntimeState; reasons: string[]; ticks: number; lastError: string | null; paused: boolean };
  policy: { targetHealthFactorBps: number; restoreHealthFactorBps: number; minHealthFactorBps: number; autoLimitUsd: number; escalationLimitUsd: number };
  vault: { address: Address; usdc: number | null; eth: number | null };
  approver: { address: Address; mode: "STAND_IN" | "WALLET"; note: string };
  network: { chainId: 31337; role: "LOCAL_FORK"; forkedFrom: 1; forkBlock: string | null; label: "LOCAL FORK TRANSACTION" };
}

interface Live {
  record: ForkDeploymentRecord;
  runtime: ForkAgentRuntime | null;
  blueprint: ContextLockAgentBlueprint;
  /** In memory only. Gone with the process, like the fork it signs for. */
  keyring: ForkKeyring;
  /** Set by an emergency lock. Outranks every healthy signal in the lifecycle projection. */
  emergencyLocked: boolean;
}

const nowIso = () => new Date().toISOString();

export class ForkLabService {
  readonly forks: AnvilForkProvider;
  readonly alerts = new AlertEngine();
  readonly commands = new CommandLog();
  readonly events: EventStore;
  private readonly live = new Map<string, Live>();
  private readonly now: () => number;
  private portSeq = 0;

  constructor(private readonly deps: ForkLabDeps) {
    this.now = deps.nowMs ?? Date.now;
    this.forks = deps.forks ?? new AnvilForkProvider({
      nowMs: this.now,
      ...(deps.anvilBinary ? { anvilBinary: deps.anvilBinary } : {}),
      ...(deps.maxConcurrentForks ? { maxConcurrentForks: deps.maxConcurrentForks } : {}),
    });
    this.events = new SqliteEventStore(deps.db);
  }

  /* ───────────────────────────── capabilities ───────────────────────────── */

  anvilAvailable(): boolean {
    try {
      execSync(`command -v ${this.deps.anvilBinary ?? "anvil"}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  async upstreamReachable(): Promise<{ ok: boolean; detail: string }> {
    try {
      const head = await jsonRpc(this.deps.upstreamRpcUrl ?? DEFAULT_UPSTREAM_RPC, "eth_blockNumber");
      return { ok: true, detail: `${this.deps.upstreamProviderId ?? DEFAULT_UPSTREAM_PROVIDER_ID} answers; mainnet head ${BigInt(head as string)}` };
    } catch (e) {
      return { ok: false, detail: `mainnet is unreachable through ${this.deps.upstreamProviderId ?? DEFAULT_UPSTREAM_PROVIDER_ID}: ${(e as Error).message}` };
    }
  }

  /* ───────────────────────────── readiness ───────────────────────────── */

  async readiness(projectId: string, inputs: { architecturePassed: boolean; securityTestsPassed: boolean; creSimulationPassed: boolean; creSimulationDetail: string }): Promise<ForkReadiness> {
    const gates: ForkReadiness["gates"] = [];
    const push = (label: string, ok: boolean, detail: string, blocker: string | null = null) =>
      gates.push({ label, status: ok ? "PASS" : blocker ? "BLOCKED" : "FAIL", detail, blocker });

    push("Architecture", inputs.architecturePassed, inputs.architecturePassed ? "The Blueprint compiled and validated" : "The Blueprint has unresolved issues");
    push("Security tests", inputs.securityTestsPassed, inputs.securityTestsPassed ? "Deterministic simulations passed" : "Deterministic simulations have not passed");
    push("CRE simulation", inputs.creSimulationPassed, inputs.creSimulationDetail);
    /*
     * The fork lab has one scenario: an Aave v3 position the agent repays. An agent whose actions
     * are something else could be deployed to the fork, but nothing there would exercise it, and
     * a green deployment that never asked the agent anything is the kind of pass this Lab refuses
     * to show. Stated as a gate with the agent's own actions in the reason.
     */
    const bp = await this.deps.readBlueprint(projectId);
    const kinds = bp?.actions.map((a) => a.kind) ?? [];
    const { drivers, unexercised } = driversFor(kinds);
    push(
      "Fork scenario",
      drivers.length > 0,
      drivers.length > 0
        ? `${drivers.map((d) => d.protocol).join(", ")} — the fork opens a position on each for the agent to act on${unexercised.length ? `; no scenario yet for ${unexercised.join(", ")}` : ""}`
        : `the fork lab has scenarios for ${SCENARIO_DRIVERS.map((d) => d.actionKind).join(", ")}; this agent's actions are ${kinds.length ? kinds.join(", ") : "none"}, which it has no way to exercise yet`,
      drivers.length > 0 ? null : "BLK-V2-FORK-SCENARIO",
    );
    const anvil = this.anvilAvailable();
    push("Fork provider", anvil, anvil ? "anvil is installed on this machine" : "anvil is not on the PATH — install Foundry", anvil ? null : "BLK-V2-NO-ANVIL");
    const artifacts = artifactsPresent(this.deps.repoRoot ?? ".");
    push("Compiled contracts", artifacts, artifacts ? "contracts/out holds the audited ContextLock core" : "contracts/out is missing — run `forge build` in contracts/", artifacts ? null : "BLK-V2-NO-ARTIFACTS");
    const up = await this.upstreamReachable();
    push("Mainnet read source", up.ok, up.detail, up.ok ? null : "BLK-V2-MAINNET-RPC");
    gates.push({ label: "Mainnet writes", status: "PASS", detail: "PROHIBITED — the fork is chain 31337 on this machine; nothing it does can reach a public chain", blocker: null });
    gates.push({ label: "Policy", status: "PASS", detail: "WILL START DISABLED — activation is a separate decision", blocker: null });

    const blockedBy = gates.filter((g) => g.status !== "PASS").map((g) => g.label);
    const existing = this.listForProject(projectId).find((d) => d.state === "DEPLOYING" || d.state === "READY_TO_ACTIVATE") ?? null;
    return {
      gates,
      canDeploy: blockedBy.length === 0 && existing === null,
      blockedBy: existing ? [...blockedBy, `a fork deployment already exists (${existing.deploymentId}); stop it first`] : blockedBy,
      executionNetwork: { chainId: 31337, name: "Local Anvil fork of Ethereum mainnet", role: "LOCAL_FORK", forkedFrom: 1 },
      mainnetWrites: "PROHIBITED",
      policyInitialState: "DISABLED",
      phases: FORK_DEPLOY_PHASES,
      existing,
    };
  }

  /* ───────────────────────────── persistence ───────────────────────────── */

  private persist(record: ForkDeploymentRecord, state: ForkDeploymentState, phase: string): void {
    const now = nowIso();
    this.deps.db.prepare(
      `INSERT INTO studio_fork_deployments (id, project_id, build_id, blueprint_revision, state, phase, revision, record, created_at, updated_at)
       VALUES (@id, @project_id, @build_id, @blueprint_revision, @state, @phase, 'rev_1', @record, @now, @now)
       ON CONFLICT(id) DO UPDATE SET state = @state, phase = @phase, record = @record, updated_at = @now`,
    ).run({
      id: record.deploymentId, project_id: record.projectId, build_id: record.buildId, blueprint_revision: record.blueprintRevision,
      state, phase, record: JSON.stringify(record), now,
    });
  }

  /**
   * A row that no longer parses under the current record schema.
   *
   * Written by an earlier phase; the schema has since gained fields. It is not a deployment this
   * process can reason about, so readers skip it — a listing that threw on one historical row would
   * hide every current deployment behind it.
   */
  private rowView(r: Record<string, unknown>): ForkDeploymentView | null {
    const id = r.id as string;
    const parsed = ForkDeploymentRecordSchema.safeParse(JSON.parse(r.record as string));
    if (!parsed.success) return null;
    const record = parsed.data;
    const live = this.live.get(id);
    return {
      deploymentId: id, projectId: r.project_id as string, buildId: (r.build_id as string | null) ?? null,
      blueprintRevision: r.blueprint_revision as number, state: r.state as ForkDeploymentState, phase: r.phase as string,
      revision: r.revision as string, record: live?.record ?? record,
      live: { fork: !!live && this.forks.get(record.fork?.forkId ?? "")?.state === "READY", runtime: !!live?.runtime && !live.runtime.state.stopping },
      createdAt: r.created_at as string, updatedAt: r.updated_at as string,
    };
  }

  get(deploymentId: string): ForkDeploymentView | null {
    const r = this.deps.db.prepare(`SELECT * FROM studio_fork_deployments WHERE id = ?`).get(deploymentId) as Record<string, unknown> | undefined;
    return r ? this.rowView(r) : null;
  }

  listForProject(projectId: string): ForkDeploymentView[] {
    return (this.deps.db.prepare(`SELECT * FROM studio_fork_deployments WHERE project_id = ? ORDER BY created_at DESC`).all(projectId) as Record<string, unknown>[])
      .map((r) => this.rowView(r))
      .filter((v): v is ForkDeploymentView => v !== null);
  }

  /** The deployment a project's lifecycle reads: the newest one that is not FAILED. */
  currentForProject(projectId: string): ForkDeploymentView | null {
    return this.listForProject(projectId).find((d) => d.state !== "FAILED") ?? null;
  }

  /**
   * Rows whose process died.
   *
   * Called once at startup. A deployment that was DEPLOYING or READY_TO_ACTIVATE in a previous
   * process has no fork now; saying otherwise would be the lab reporting a runtime nobody is running.
   */
  reconcileOrphaned(): string[] {
    const rows = this.deps.db.prepare(`SELECT * FROM studio_fork_deployments WHERE state IN ('DEPLOYING','READY_TO_ACTIVATE')`).all() as Record<string, unknown>[];
    for (const r of rows) {
      const record = ForkDeploymentRecordSchema.parse(JSON.parse(r.record as string));
      record.stoppedReason = "the Studio server that held this fork stopped; the fork process and the agent runtime died with it";
      if (record.fork) record.fork = { ...record.fork, state: "DESTROYED" };
      this.persist(record, "STOPPED", r.phase as string);
    }
    return rows.map((r) => r.id as string);
  }

  /* ───────────────────────────── deploying ───────────────────────────── */

  /**
   * Start a deployment. Returns as soon as the row exists; the phases run in the background and
   * the row is updated as each completes, so a client polls the record rather than holding a request.
   */
  async deploy(projectId: string, buildId: string | null, opts: { approverAddress?: Address | null } = {}): Promise<ForkDeploymentView> {
    const bp = await this.deps.readBlueprint(projectId);
    if (!bp) throw new Error(`project ${projectId} has no Blueprint to deploy`);
    if (this.listForProject(projectId).some((d) => d.state === "DEPLOYING" || d.state === "READY_TO_ACTIVATE")) {
      throw new Error("a fork deployment already exists for this project; stop it before starting another");
    }

    const keyring = ForkKeyring.generate();
    const record = prepareRecord({ bp, projectId, buildId, upstreamProviderId: this.deps.upstreamProviderId ?? DEFAULT_UPSTREAM_PROVIDER_ID, keyring });
    /*
     * The operator's wallet as the approver.
     *
     * The approval registry is constructed with `roles.approver`, so setting it here is what makes
     * the connected wallet the only address whose EIP-712 signature the registry accepts. The
     * stand-in key stays in the keyring, unused: nothing on the server can sign an escalation for
     * a WALLET deployment, which is the point.
     */
    if (opts.approverAddress) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(opts.approverAddress)) throw new Error("approverAddress must be a 20-byte hex address");
      record.roles = { ...record.roles, approver: opts.approverAddress };
      record.approverMode = "WALLET";
    }
    this.markPhase(record, "PREPARING_RELEASE", "RUNNING");
    this.markPhase(record, "PREPARING_RELEASE", "DONE", `Blueprint revision ${bp.revision}; agent ${bp.identity.agentId}; policy hash ${record.policyHash.slice(0, 18)}…`);
    this.persist(record, "DEPLOYING", "PREPARING_RELEASE");
    this.live.set(record.deploymentId, { record, runtime: null, blueprint: bp, keyring, emergencyLocked: false });
    this.systemEvent(record, "RUNTIME_STATE_CHANGED", "INFO", { state: "PROVISIONING", note: "fork deployment started" });

    void this.runDeployment(record.deploymentId);
    return this.get(record.deploymentId)!;
  }

  private markPhase(record: ForkDeploymentRecord, key: ForkDeployPhaseKey, status: PhaseRecord["status"], detail?: string): void {
    const p = record.phases.find((x) => x.key === key);
    if (!p) return;
    p.status = status;
    if (status === "RUNNING") p.startedAtMs = this.now();
    if (status === "DONE" || status === "FAILED") p.finishedAtMs = this.now();
    if (detail !== undefined) p.detail = detail;
  }

  private async runDeployment(deploymentId: string): Promise<void> {
    const live = this.live.get(deploymentId)!;
    let record = live.record;
    const port = (this.deps.basePort ?? 8760) + (this.portSeq++ % 20);

    try {
      record = await runForkDeployment(record, {
        keyring: live.keyring,
        upstreamRpcUrl: this.deps.upstreamRpcUrl ?? DEFAULT_UPSTREAM_RPC,
        upstreamProviderId: this.deps.upstreamProviderId ?? DEFAULT_UPSTREAM_PROVIDER_ID,
        repoRoot: this.deps.repoRoot ?? ".",
        indexed: indexedReader(this.deps.upstreamRpcUrl ?? DEFAULT_UPSTREAM_RPC),
        port,
        forks: this.forks,
        nowMs: this.now,
        onPhase: (key, status, detail) => {
          this.markPhase(live.record, key, status, detail);
          this.persist(live.record, "DEPLOYING", key);
        },
        onTransaction: (tx) => {
          this.systemEvent(live.record, "EXECUTION_MINED", "INFO", { label: tx.label, network: tx.network, gasUsed: tx.gasUsed }, { chainId: 31337, blockNumber: tx.blockNumber, txHash: tx.hash as Hex, source: "CHAIN" });
        },
      });
      live.record = record;

      /* ── the runtime ─────────────────────────────────────────────────── */
      this.markPhase(record, "STARTING_RUNTIME", "RUNNING");
      this.persist(record, "DEPLOYING", "STARTING_RUNTIME");
      const runtime = new ForkAgentRuntime({ record, blueprint: live.blueprint, keyring: live.keyring, events: this.events, nowMs: this.now, ...(this.deps.tickMs !== undefined ? { tickMs: this.deps.tickMs } : {}) });
      live.runtime = runtime;
      runtime.start();
      this.markPhase(record, "STARTING_RUNTIME", "DONE", "the agent runtime is observing the fork; it holds no key and the policy is DISABLED");

      this.markPhase(record, "HEALTH_CHECKS", "RUNNING");
      this.persist(record, "DEPLOYING", "HEALTH_CHECKS");
      const first = await runtime.tick();
      const health = evaluateRuntime(runtime.runtimeInputs());
      const pub = forkPublicClient(record.fork!.endpoint);
      const enabled = await pub.readContract({ address: record.contracts!.ContextLockPolicyRegistry, abi: POLICY_REGISTRY_ABI, functionName: "isPolicyEnabled", args: [record.agentIdentityHash as Hex, record.policyHash as Hex] });
      if (enabled) throw new Error("health check: the policy reads ENABLED before activation");
      if (!first) throw new Error(`health check: the runtime's first observation failed: ${runtime.state.lastError ?? "unknown"}`);
      this.markPhase(record, "HEALTH_CHECKS", "DONE", `runtime ${health.state}; first observation at fork block ${first.blockNumber}: health factor ${(first.healthFactorBps / 10_000).toFixed(4)}, policy DISABLED`);

      this.markPhase(record, "READY_TO_ACTIVATE", "DONE", "deployed and verified on the fork; the ContextLock policy is DISABLED until you activate it");
      this.persist(record, "READY_TO_ACTIVATE", "READY_TO_ACTIVATE");
      this.systemEvent(record, "POLICY_STATE_OBSERVED", "INFO", { enabled: false, note: "registered DISABLED by the deployment; activation is a separate decision" }, { source: "CHAIN", chainId: 31337 });
    } catch (e) {
      const failed = (e as { record?: ForkDeploymentRecord }).record ?? live.record;
      failed.failure = failed.failure ?? (e as Error).message;
      live.record = failed;
      live.runtime?.stop("deployment failed");
      // A failed deployment's fork is torn down: it holds nothing worth keeping and one port.
      if (failed.fork) await this.forks.destroy(failed.fork.forkId).catch(() => undefined);
      const phase = failed.phases.find((p) => p.status === "FAILED")?.key ?? failed.phases.find((p) => p.status === "RUNNING")?.key ?? "PREPARING_RELEASE";
      this.markPhase(failed, phase as ForkDeployPhaseKey, "FAILED", failed.failure);
      this.persist(failed, "FAILED", phase);
      this.systemEvent(failed, "RUNTIME_STATE_CHANGED", "ERROR", { state: "FAILED", reason: failed.failure });
    }
  }

  /* ───────────────────────────── stopping ───────────────────────────── */

  async stop(deploymentId: string, reason = "stopped by the operator"): Promise<ForkDeploymentView | null> {
    const view = this.get(deploymentId);
    if (!view) return null;
    const live = this.live.get(deploymentId);
    live?.runtime?.stop(reason);
    const record = live?.record ?? view.record;
    if (record.fork) {
      await this.forks.destroy(record.fork.forkId).catch(() => undefined);
      record.fork = { ...record.fork, state: "DESTROYED" };
    }
    record.stoppedReason = reason;
    this.persist(record, "STOPPED", view.phase);
    this.live.delete(deploymentId);
    return this.get(deploymentId);
  }

  async stopAll(reason: string): Promise<void> {
    for (const id of [...this.live.keys()]) await this.stop(id, reason);
  }

  /* ───────────────────────────── the position ───────────────────────────── */

  async position(deploymentId: string): Promise<ForkPositionView | null> {
    const view = this.get(deploymentId);
    if (!view) return null;
    const live = this.live.get(deploymentId);
    const rt = live?.runtime ?? null;
    const record = view.record;
    let policyEnabled: boolean | null = null;
    let vaultUsdc: number | null = null;
    let vaultEth: number | null = null;
    if (live && record.fork && record.contracts && view.live.fork) {
      try {
        const pub = forkPublicClient(record.fork.endpoint);
        policyEnabled = await pub.readContract({ address: record.contracts.ContextLockPolicyRegistry, abi: POLICY_REGISTRY_ABI, functionName: "isPolicyEnabled", args: [record.agentIdentityHash as Hex, record.policyHash as Hex] });
        vaultUsdc = Number(await pub.readContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [record.contracts.ContextLockExecutor] })) / 10 ** USDC_DECIMALS;
        vaultEth = Number(await pub.getBalance({ address: record.contracts.ContextLockExecutor })) / 1e18;
      } catch {
        policyEnabled = null;
      }
    }
    const health = rt ? evaluateRuntime(rt.runtimeInputs()) : { state: "STOPPED" as RuntimeState, reasons: ["no runtime in this server process"] };
    const scenarios = (record.position?.scenarios ?? []).map((sc) => ({ ...sc, stressOptions: SCENARIO_DRIVERS.find((d) => d.id === sc.driverId)?.stressOptions ?? [] }));
    return {
      deploymentId,
      policyEnabled,
      latest: rt?.latest() ?? null,
      samples: rt?.samples ?? [],
      decisions: rt ? [...rt.decisions].reverse() : [],
      executions: rt ? [...rt.executions].reverse() : [],
      pending: rt?.pending() ?? [],
      scenarios,
      unexercisedActionKinds: record.position?.unexercisedActionKinds ?? [],
      runtime: { state: health.state, reasons: health.reasons, ticks: rt?.state.ticks ?? 0, lastError: rt?.state.lastError ?? null, paused: rt?.state.paused ?? false },
      policy: {
        targetHealthFactorBps: record.policy.targetHealthFactorBps, restoreHealthFactorBps: record.policy.restoreHealthFactorBps, minHealthFactorBps: record.policy.minHealthFactorBps,
        autoLimitUsd: Number(record.policy.autoLimit) / 1e6, escalationLimitUsd: Number(record.policy.escalationLimit) / 1e6,
      },
      vault: { address: record.position?.vault ?? record.roles.deployer, usdc: vaultUsdc, eth: vaultEth },
      approver: {
        address: record.roles.approver,
        mode: record.approverMode,
        note: record.approverMode === "WALLET"
          ? "the operator's connected wallet — signs the approval registry's EIP-712 digest in the browser; NOT a Ledger device (BLK-002)"
          : "a stand-in key generated for this fork — NOT a Ledger device (BLK-002)",
      },
      network: { chainId: 31337, role: "LOCAL_FORK", forkedFrom: 1, forkBlock: record.fork?.forkBlock ?? null, label: "LOCAL FORK TRANSACTION" },
    };
  }

  /**
   * Stress one of the positions.
   *
   * Not something the agent does — the agent may only take its Blueprint's actions — and recorded
   * as an OPERATOR action so the timeline shows who moved the position. Each driver defines what a
   * stress means for its protocol: more debt on a lending position, funds arriving in the vault.
   */
  async stress(deploymentId: string, driverId: string, option: string, value: number): Promise<{ before: DriverObservation; after: DriverObservation; detail: string }> {
    const live = this.live.get(deploymentId);
    const record = live?.record;
    if (!live?.runtime || !record?.fork || !record.contracts || !record.position) throw new Error("no live fork deployment with that id");
    const driver = live.runtime.drivers.find((d) => d.id === driverId);
    if (!driver) throw new Error(`this deployment has no scenario "${driverId}"`);
    const opt = driver.stressOptions.find((o) => o.id === option);
    if (!opt) throw new Error(`scenario ${driverId} has no stress option "${option}"`);
    if (!Number.isFinite(value) || value <= 0) throw new Error("value must be a positive number");
    if (opt.kind === "health-target" && (value < 10_500 || value > 50_000)) throw new Error("a health-factor target is given in bps between 10500 (1.05) and 50000 (5.0)");

    const pub = forkPublicClient(record.fork.endpoint);
    const corr = `corr_stress_${this.now().toString(36)}`;
    const r = await driver.stress(live.runtime.driverContext(), option, value, async (label, tx) => {
      const hash = await tx();
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== "success") throw new Error(`${label} reverted on the fork (tx ${hash})`);
      this.systemEvent(record, "EXECUTION_MINED", "NOTICE", { label, protocol: driver.protocol, network: "LOCAL FORK TRANSACTION", by: "operator, not the agent" }, { source: "OPERATOR", chainId: 31337, blockNumber: receipt.blockNumber.toString(), txHash: hash, correlationId: corr });
    });
    this.systemEvent(record, "STATE_DRIFT_DETECTED", "NOTICE", { protocol: driver.protocol, stress: r.detail, before: r.before.detail, after: r.after.detail, by: "operator stress" }, { source: "OPERATOR", correlationId: corr });
    return r;
  }

  /**
   * A human approves an escalation; the runtime executes it.
   *
   * For a STAND_IN deployment the server signs with the fork's approver key. For a WALLET
   * deployment the signatures come from the browser and the server only relays them — see
   * `approvalTypedData` for what was signed.
   */
  async approve(deploymentId: string, correlationId: string, signatures: ApprovalSignature[] | null = null): Promise<ExecutionRecord> {
    const rt = this.live.get(deploymentId)?.runtime;
    if (!rt) throw new Error("no live fork deployment with that id");
    return rt.approve(correlationId, signatures);
  }

  /** The EIP-712 payloads a wallet must sign to approve one escalation. */
  async approvalTypedData(deploymentId: string, correlationId: string): Promise<ApprovalTypedData> {
    const rt = this.live.get(deploymentId)?.runtime;
    if (!rt) throw new Error("no live fork deployment with that id");
    return rt.approvalTypedData(correlationId);
  }

  async decline(deploymentId: string, correlationId: string, reason: string): Promise<void> {
    const rt = this.live.get(deploymentId)?.runtime;
    if (!rt) throw new Error("no live fork deployment with that id");
    rt.decline(correlationId, reason);
  }

  /** One observation now, outside the loop's cadence. For the UI's refresh button and for tests. */
  async tickNow(deploymentId: string): Promise<TickSample | null> {
    const rt = this.live.get(deploymentId)?.runtime;
    return rt ? rt.tick() : null;
  }

  /* ───────────────────────────── the control plane ───────────────────────────── */

  private queries(record: ForkDeploymentRecord): ChainQueries {
    const pub = forkPublicClient(record.fork!.endpoint);
    const registry = record.contracts!.ContextLockPolicyRegistry;
    const identity = record.contracts!.LocalAgentIdentityVerifier;
    return {
      async readPolicy(reg, a, p) {
        const [enabled, cap, bindingVersion, admin] = await Promise.all([
          pub.readContract({ address: reg, abi: POLICY_REGISTRY_ABI, functionName: "isPolicyEnabled", args: [a, p] }),
          pub.readContract({ address: reg, abi: POLICY_REGISTRY_ABI, functionName: "maxValueHardCap", args: [a, p] }),
          pub.readContract({ address: reg, abi: POLICY_REGISTRY_ABI, functionName: "bindingVersion", args: [a] }),
          pub.readContract({ address: reg, abi: POLICY_REGISTRY_ABI, functionName: "policyAdmin", args: [a] }),
        ]);
        return { enabled, cap, bindingVersion: BigInt(bindingVersion), admin };
      },
      async resolveIdentity() {
        const bound = await pub.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "boundAgent", args: [record.agentIdentityHash as Hex] });
        const zero = bound === "0x0000000000000000000000000000000000000000";
        return { boundAgent: zero ? null : bound, revoked: zero, resolver: identity };
      },
      async readAdministrators() {
        return [await pub.readContract({ address: registry, abi: POLICY_REGISTRY_ABI, functionName: "policyAdmin", args: [record.agentIdentityHash as Hex] })];
      },
    };
  }

  private adapterHealth(rt: ForkAgentRuntime | null): AdapterHealth[] {
    const now = this.now();
    const latest = rt?.latest() ?? null;
    const ok = rt !== null && rt.state.consecutiveErrors === 0 && latest !== null;
    const mk = (adapterId: string): AdapterHealth => ({
      adapterId, adapterVersion: "1.0.0",
      state: rt === null ? "UNKNOWN" : ok ? "HEALTHY" : "DEGRADED",
      lastSuccessAtMs: latest?.atMs ?? null, lastFailureAtMs: rt?.state.lastError ? now : null,
      latencyMsP50: null, latencyMsP95: null, recentErrorRate: rt && rt.state.consecutiveErrors > 0 ? 1 : 0,
      dataFreshnessMs: latest ? now - latest.atMs : null, lastProviderReason: rt?.state.lastError ?? null,
      lastCheckedAtMs: now, disabledReason: null,
    });
    return [mk("aave-v3-state"), mk("reference-oracle"), mk("aave-v3-execution")];
  }

  /** The deps the P25 control-plane routes take, backed by this lab's forks. */
  controlPlaneDeps(): ControlPlaneDeps {
    return {
      db: this.deps.db,
      alerts: this.alerts,
      commands: this.commands,
      nowMs: this.now,
      refresh: (deploymentId) => this.refresh(deploymentId),
      execute: (cmd) => this.execute(cmd),
    };
  }

  private async refresh(deploymentId: string): Promise<Awaited<ReturnType<ControlPlaneDeps["refresh"]>>> {
    const view = this.get(deploymentId);
    if (!view) throw Object.assign(new Error(`unknown deployment ${deploymentId}`), { statusCode: 404 });
    const live = this.live.get(deploymentId);
    const record = live?.record ?? view.record;
    const now = this.now();
    const rt = live?.runtime ?? null;
    const creRun = this.latestCreRun(record.projectId);

    const runtimeVerdict = rt ? evaluateRuntime(rt.runtimeInputs()) : { state: "STOPPED" as RuntimeState, reasons: [view.state === "STOPPED" ? (record.stoppedReason ?? "the fork is stopped") : "no runtime in this server process"], note: "Runtime health describes the agent process. It says nothing about financial authority: the ContextLock policy on the fork decides whether this agent may act." };
    const adapters = this.adapterHealth(rt);

    let policy = unavailable<PolicyState>("NOT_CONFIGURED", { atMs: now, source: "chain:31337", ttlMs: DEFAULT_TTLS.policy, reason: "the fork is not running; the policy cannot be read" });
    let identity: ReturnType<typeof observed<IdentityState>> | null = null;
    let drift: ReturnType<typeof reconcile> = [];

    if (live && record.fork && record.contracts && view.live.fork) {
      const observer = new ChainObserver({ reader: forkChainReader(record.fork.endpoint), queries: this.queries(record), nowMs: this.now });
      policy = await observer.readPolicyState({ registry: record.contracts.ContextLockPolicyRegistry, agentIdentityHash: record.agentIdentityHash as Hex, policyHash: record.policyHash as Hex });
      identity = await observer.readIdentityState({ name: record.ensName, node: record.ensNode as Hex });
      drift = reconcile(
        {
          // What the deployment record expects: the policy bit the operator last set is read from
          // chain, so the record's expectation is "whatever the last command applied".
          policyEnabled: policy.value?.enabled ?? false,
          policyAdmin: record.roles.deployer,
          bindingVersion: null,
          contracts: [],
          administrators: [record.roles.deployer.toLowerCase()],
          identity: { node: record.ensNode, boundAgent: record.roles.user },
          runtimeImageDigest: null,
        },
        { policy, identity, contracts: [], administrators: await observer.readAdministrators(record.contracts.ContextLockPolicyRegistry), runtimeImageDigest: null },
        now,
      );
      for (const d of drift) {
        const { alert } = this.alerts.raise(alertForDrift(d, { projectId: record.projectId, deploymentId }));
        persistAlert(this.deps.db, alert);
      }
    }

    const live_ = agentIsLive({
      runtime: runtimeVerdict.state,
      policyEnabled: policy.value?.enabled ?? null,
      policyIsCurrent: presentable(policy, now).isCurrent,
      identityActive: identity?.value ? !identity.value.revoked : null,
      requiredAdapters: adapters.filter((a) => a.adapterId !== "aave-v3-execution"),
      creRequired: false,
      creActive: null,
    });

    return {
      policy: presentable(policy, now),
      runtime: { state: runtimeVerdict.state, reasons: runtimeVerdict.reasons, note: runtimeVerdict.note },
      cre: {
        state: "SIMULATED",
        headline: creRun?.passed ? "Official CLI simulation passed" : "Official CRE simulation not passed for this project",
        detail: creRun ? `binary ${creRun.binaryHash?.slice(0, 16) ?? "?"}…, verdict ${creRun.verdict}, ${creRun.productionLimits ? "production limits" : "limits not confirmed"}` : "run it from the Deploy tab",
        blockedBy: "BLK-V2-CRE-DEPLOY",
        lastSyncedAtMs: creRun?.atMs ?? null,
        unavailable: { deployedWorkflow: "Deploy Access is not enabled for this CRE organization; the workflow runs in the official CLI simulator only" },
      },
      adapters: adapters.map((a) => ({ adapterId: a.adapterId, state: a.state, reason: a.lastProviderReason })),
      identity: identity ? presentable(identity, now) : null,
      drift,
      currentRevision: view.revision,
      live: live_,
    };
  }

  private latestCreRun(projectId: string): { passed: boolean; binaryHash: string | null; verdict: string; productionLimits: boolean; atMs: number } | null {
    const r = this.deps.db.prepare(`SELECT result, started_at FROM studio_lab_runs WHERE project_id = ? AND kind = 'CRE_SIMULATION' AND status != 'RUNNING' ORDER BY started_at DESC LIMIT 1`).get(projectId) as { result: string; started_at: string } | undefined;
    if (!r) return null;
    const res = JSON.parse(r.result) as { passed?: boolean; binaryHash?: string | null; verdict?: string; productionLimits?: boolean };
    return { passed: res.passed === true, binaryHash: res.binaryHash ?? null, verdict: res.verdict ?? "none", productionLimits: res.productionLimits === true, atMs: Date.parse(r.started_at) };
  }

  private async setPolicyEnabled(record: ForkDeploymentRecord, keyring: ForkKeyring, enabled: boolean): Promise<{ ok: boolean; verification: string; detail: string; txHash: Hex | null }> {
    const pub = forkPublicClient(record.fork!.endpoint);
    const deployer = forkWalletClient(record.fork!.endpoint, keyring.account("deployer"));
    const registry = record.contracts!.ContextLockPolicyRegistry;
    const a = record.agentIdentityHash as Hex;
    const p = record.policyHash as Hex;
    const hash = await deployer.writeContract({ address: registry, abi: POLICY_REGISTRY_ABI, functionName: "setPolicy", args: [a, p, enabled, BigInt(record.policy.maxValueHardCapWei)], account: deployer.account!, chain: deployer.chain });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    // Verified from a fresh read, never from the receipt alone.
    const now = await pub.readContract({ address: registry, abi: POLICY_REGISTRY_ABI, functionName: "isPolicyEnabled", args: [a, p] });
    const ok = receipt.status === "success" && now === enabled;
    this.systemEvent(record, ok ? "POLICY_CHANGED" : "CONTROL_COMMAND_FAILED", ok ? "NOTICE" : "ERROR", { enabled: now, requested: enabled, network: "LOCAL FORK TRANSACTION" }, { source: "CHAIN", chainId: 31337, blockNumber: receipt.blockNumber.toString(), txHash: hash });
    return { ok, verification: `isPolicyEnabled read back ${now} at fork block ${receipt.blockNumber}`, detail: ok ? `policy ${enabled ? "ENABLED" : "DISABLED"} on the fork` : `the fork reads ${now} after asking for ${enabled}`, txHash: hash };
  }

  private async execute(cmd: ControlCommand): Promise<{ ok: boolean; detail: string; result: unknown }> {
    const live = this.live.get(cmd.deploymentId);
    const view = this.get(cmd.deploymentId);
    if (!view) return { ok: false, detail: `unknown deployment ${cmd.deploymentId}`, result: null };
    const record = live?.record ?? view.record;
    const forkUp = !!live && view.live.fork && !!record.fork && !!record.contracts;
    const na = (what: string) => ({ ok: false, detail: `${what} is not applicable to a local fork deployment`, result: null });

    switch (cmd.operation) {
      case "ENABLE_POLICY":
      case "DISABLE_POLICY": {
        if (!forkUp) return { ok: false, detail: "the fork is not running; the policy cannot be changed", result: null };
        const r = await this.setPolicyEnabled(record, live!.keyring, cmd.operation === "ENABLE_POLICY");
        return { ok: r.ok, detail: r.detail, result: { verification: r.verification, txHash: r.txHash, network: "LOCAL FORK TRANSACTION" } };
      }
      case "PAUSE_RUNTIME": {
        if (!live?.runtime) return { ok: false, detail: "no runtime is running", result: null };
        live.runtime.pause();
        return { ok: true, detail: "the runtime is paused; it no longer observes or proposes. The policy on the fork is unchanged.", result: { state: "PAUSED" } };
      }
      case "RESUME_RUNTIME": {
        if (!live?.runtime) return { ok: false, detail: "no runtime is running", result: null };
        live.runtime.resume();
        return { ok: true, detail: "the runtime resumed", result: { state: "HEALTHY" } };
      }
      case "REVOKE_IDENTITY": {
        if (!forkUp) return { ok: false, detail: "the fork is not running", result: null };
        const r = await this.revokeIdentity(record, live!.keyring);
        return { ok: r.ok, detail: r.detail, result: { verification: r.verification } };
      }
      case "EMERGENCY_LOCK": {
        const includeIdentity = (cmd.confirmation as { includeIdentityRevocation?: boolean } | null)?.includeIdentityRevocation === true;
        const lock = newEmergencyLock({
          lockId: `lock_${randomUUID().slice(0, 8)}`, deploymentId: cmd.deploymentId, idempotencyKey: cmd.commandId,
          initiatedBy: cmd.actor.actorId, nowMs: this.now(), includeIdentityRevocation: includeIdentity,
          applicability: { creWorkflowExists: false, runtimeExists: !!live?.runtime, identityExists: forkUp },
        });
        const done = await runEmergencyLock(lock, {
          disablePolicy: async () => forkUp ? this.setPolicyEnabled(record, live!.keyring, false) : { ok: false, verification: "no fork", detail: "the fork is not running; the policy cannot be read or written" },
          denyNewCapabilities: async () => ({ ok: true, verification: "the fork runtime proposes through the policy engine, which returns DENY_POLICY_DISABLED once the registry bit is off", detail: "no capability can be issued against a disabled policy" }),
          pauseCre: async () => ({ ok: true, verification: "n/a", detail: "no CRE workflow is deployed" }),
          stopRuntime: async () => { live?.runtime?.stop("emergency lock"); return { ok: true, verification: live?.runtime ? `runtime stopping=${live.runtime.state.stopping}` : "no runtime", detail: "the agent runtime was stopped" }; },
          revokeIdentity: async () => forkUp ? this.revokeIdentity(record, live!.keyring) : { ok: false, verification: "no fork", detail: "the fork is not running" },
          nowMs: this.now,
        });
        if (live) live.emergencyLocked = true;
        const summary = emergencySummary(done);
        this.systemEvent(record, done.state === "COMPLETE" ? "EMERGENCY_LOCK_COMPLETED" : "EMERGENCY_LOCK_PARTIAL", "CRITICAL", { state: done.state, headline: summary.headline }, { source: "OPERATOR" });
        return { ok: done.state === "COMPLETE", detail: summary.headline, result: { ...summary, lock: done } };
      }
      case "PAUSE_CRE":
      case "ACTIVATE_CRE":
      case "DELETE_CRE":
        return na("a CRE workflow operation (no workflow is deployed; Deploy Access is not enabled)");
      case "ROLLBACK_RUNTIME":
      case "ROTATE_RUNTIME_REVISION":
        return na("a runtime revision operation (the fork runtime has one revision)");
      default:
        return na(String(cmd.operation));
    }
  }

  private async revokeIdentity(record: ForkDeploymentRecord, keyring: ForkKeyring): Promise<{ ok: boolean; verification: string; detail: string }> {
    const pub = forkPublicClient(record.fork!.endpoint);
    const deployer = forkWalletClient(record.fork!.endpoint, keyring.account("deployer"));
    const identity = record.contracts!.LocalAgentIdentityVerifier;
    const hash = await deployer.writeContract({ address: identity, abi: IDENTITY_ABI, functionName: "revoke", args: [record.agentIdentityHash as Hex], account: deployer.account!, chain: deployer.chain });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    const current = await pub.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "isIdentityCurrent", args: [record.agentIdentityHash as Hex, record.roles.user] });
    this.systemEvent(record, "IDENTITY_CHANGED", "CRITICAL", { revoked: !current, network: "LOCAL FORK TRANSACTION" }, { source: "CHAIN", chainId: 31337, blockNumber: receipt.blockNumber.toString(), txHash: hash });
    return { ok: receipt.status === "success" && !current, verification: `isIdentityCurrent read back ${current}`, detail: current ? "the identity still reads as bound" : "the agent identity is revoked on the fork; the executor will refuse every capability" };
  }

  /* ───────────────────────────── the Lab's readers ───────────────────────────── */

  /** Lifecycle inputs contributed by the current fork deployment, for `readInputs`. */
  async lifecycleInputs(projectId: string): Promise<{
    deployment: "DEPLOYING_CHAIN_COMPONENTS" | "READY_TO_ACTIVATE" | "DEPLOYMENT_FAILED_TERMINAL" | null;
    runtime: RuntimeState | null;
    policy: { enabled: boolean; observedAtBlock: string | null; observedAtMs: number; source: string } | null;
    degraded: string[];
    preflightPassed: boolean;
    emergencyLockActive: boolean;
  }> {
    const view = this.currentForProject(projectId);
    if (!view) return { deployment: null, runtime: null, policy: null, degraded: [], preflightPassed: false, emergencyLockActive: false };
    const live = this.live.get(view.deploymentId);
    const record = live?.record ?? view.record;
    const emergencyLockActive = live?.emergencyLocked ?? false;
    if (view.state === "FAILED") return { deployment: "DEPLOYMENT_FAILED_TERMINAL", runtime: null, policy: null, degraded: [], preflightPassed: false, emergencyLockActive };
    /*
     * A STOPPED deployment has no fork and no runtime: there is nothing to activate and nothing
     * holding authority. Reporting it as READY_TO_ACTIVATE made a dead fork read as a deployable
     * one; the honest lifecycle for a project whose fork is gone is the one before deployment.
     */
    if (view.state === "STOPPED") return { deployment: null, runtime: "STOPPED", policy: null, degraded: [], preflightPassed: false, emergencyLockActive };
    if (view.state === "DEPLOYING") return { deployment: "DEPLOYING_CHAIN_COMPONENTS", runtime: null, policy: null, degraded: [], preflightPassed: false, emergencyLockActive };

    const runtime: RuntimeState = live?.runtime ? evaluateRuntime(live.runtime.runtimeInputs()).state : "STOPPED";
    let policy: { enabled: boolean; observedAtBlock: string | null; observedAtMs: number; source: string } | null = null;
    const degraded: string[] = [];
    if (view.state === "READY_TO_ACTIVATE" && live && record.fork && record.contracts && view.live.fork) {
      try {
        const pub = forkPublicClient(record.fork.endpoint);
        const [enabled, block] = await Promise.all([
          pub.readContract({ address: record.contracts.ContextLockPolicyRegistry, abi: POLICY_REGISTRY_ABI, functionName: "isPolicyEnabled", args: [record.agentIdentityHash as Hex, record.policyHash as Hex] }),
          pub.getBlockNumber(),
        ]);
        policy = { enabled, observedAtBlock: block.toString(), observedAtMs: this.now(), source: "local fork rpc, fresh read" };
      } catch (e) {
        degraded.push(`fork rpc: ${(e as Error).message.slice(0, 80)}`);
      }
      if (live.runtime && live.runtime.state.consecutiveErrors > 0) degraded.push("aave-v3-state");
    }
    return { deployment: "READY_TO_ACTIVATE", runtime, policy, degraded, preflightPassed: view.state === "READY_TO_ACTIVATE", emergencyLockActive };
  }

  snapshotFor(projectId: string): MarketSnapshot | null {
    const view = this.currentForProject(projectId);
    return view?.record.snapshot ?? null;
  }

  /** The most recent executed repayment, in the shape the shadow panel reads. */
  shadowFor(projectId: string): { decision: ShadowDecision; fork: ForkDescriptor; tx: ForkTransaction; protocol: string; input: string; output: string } | null {
    const view = this.currentForProject(projectId);
    const live = view ? this.live.get(view.deploymentId) : undefined;
    const rt = live?.runtime;
    const record = live?.record;
    if (!rt || !record?.fork || !record.snapshot) return null;
    const exec = rt.executions.at(-1);
    if (!exec) return null;
    const decision = rt.decisions.find((d) => d.correlationId === exec.correlationId);
    if (!decision) return null;
    const repayTx = exec.txs.at(-1)!;
    const kindOf: Record<string, "REPAY" | "SUPPLY" | "SWAP" | "NONE"> = { AAVE_REPAY: "REPAY", COMPOUND_REPAY: "REPAY", MORPHO_REPAY: "REPAY", LIDO_STAKE: "SUPPLY", TOKEN_SWAP: "SWAP" };
    const hf = (b: number | null) => (b === null ? "—" : (b / 10_000).toFixed(3));
    const shadow: ShadowDecision = {
      decisionId: exec.correlationId,
      marketSnapshotHash: record.snapshot.snapshotHash,
      scenarioHash: null,
      strategyRevision: record.blueprintRevision,
      blueprintRevision: record.blueprintRevision,
      creSimulationId: null,
      verdict: "ALLOW",
      reasonCode: decision.reasonCode,
      proposedMainnetSemanticAction: {
        kind: kindOf[decision.actionKind] ?? "NONE", assetId: "usd", counterAssetId: null, amount: exec.amountUsd6, decimals: 6, protocol: decision.protocol,
        rationale: exec.label,
      },
      executionEnvironment: "LOCAL_FORK",
      environmentId: record.fork.forkId,
      executionChainId: 31337,
      simulatedExecutionResult: { executed: true, txHash: repayTx.hash, label: repayTx.label, detail: `executed through ContextLockExecutor on fork ${record.fork.forkId}` },
      decidedAtMs: decision.atMs,
    };
    return { decision: shadow, fork: record.fork, tx: repayTx, protocol: decision.protocol, input: `$${(Number(exec.amountUsd6) / 1e6).toFixed(2)} — ${exec.label}`, output: exec.healthFactorBeforeBps === null ? "executed" : `health factor ${hf(exec.healthFactorBeforeBps)} → ${hf(exec.healthFactorAfterBps)}` };
  }

  decisionFor(projectId: string, correlationId: string): DecisionInputs | null {
    const view = this.currentForProject(projectId);
    const live = view ? this.live.get(view.deploymentId) : undefined;
    const rt = live?.runtime;
    const record = live?.record;
    const d = rt?.decisions.find((x) => x.correlationId === correlationId);
    if (!d || !record) return null;
    return {
      correlationId,
      verdict: d.verdict,
      reasonCode: d.reasonCode,
      amount: `$${(Number(d.amountUsd6) / 1e6).toFixed(2)} — ${d.label}`,
      policyRef: `${record.policy.policyId} v${record.policy.policyVersion}`,
      marketSnapshotHash: record.snapshot?.snapshotHash ?? "sha256:" + "0".repeat(64),
      scenarioHash: null,
      verifiedPrice: { metric: "weth/usd:price", value: `$${d.ethUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`, sourceId: "chainlink-feed-eth-usd-mainnet", trustClass: "VERIFIED_ORACLE" },
      executionChainId: 31337,
      recipient: record.roles.user,
      recipientPolicy: "self-only",
      creMode: "OFFICIAL CLI SIMULATION",
    };
  }

  /* ───────────────────────────── events ───────────────────────────── */

  private systemEvent(
    record: ForkDeploymentRecord,
    type: Parameters<EventStore["append"]>[0]["type"],
    severity: Parameters<EventStore["append"]>[0]["severity"],
    publicMetadata: Record<string, unknown>,
    over: Partial<Parameters<EventStore["append"]>[0]> = {},
  ): void {
    try {
      this.events.append({
        organizationId: null, projectId: record.projectId, deploymentId: record.deploymentId, agentId: record.agentId,
        source: "SYSTEM", type, severity, timestamp: this.now(), correlationId: `corr_deploy_${record.deploymentId}`,
        agentRunId: null, modelRunId: null, strategyEvaluationId: null, creExecutionId: null, authorizationId: null, capabilityId: null,
        chainId: null, blockNumber: null, txHash: null, creWorkflowId: null, adapterId: null, runtimeRevision: null,
        buildRevision: record.blueprintRevision, deploymentRevision: "rev_1", correctsEventId: null, publicMetadata,
        ...over,
      }, this.now());
    } catch {
      // A refused event never blocks a deployment step; the row and the phase record still say what happened.
    }
  }

  /** Open alerts for a deployment, for callers that do not go through the control-plane routes. */
  openAlerts(deploymentId: string) {
    return loadAlerts(this.deps.db, deploymentId).filter((a) => a.state !== "RESOLVED");
  }
}

export { POSITION };
