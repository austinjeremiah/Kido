import { keccak256, recoverAddress, toHex, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { evaluatePolicy, type EvaluationRequest, type MarketContext, type PolicyDecision, type PrivatePolicy } from "@contextlock/policy";
import { CAPABILITY_TYPES, CAPABILITY_VERSION, capabilityDigest, domain, requestHash, type Capability } from "@contextlock/protocol";
import { policyFromBlueprint } from "@contextlock/studio-lab";
import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";
import { assertExecutionAllowed } from "@contextlock/studio-network";
import { LOCAL_FORK_TX_LABEL, type ForkTransaction } from "@contextlock/studio-reality";
import type { EventDraft, EventStore, EventType, EventSeverity, EventSource } from "@contextlock/studio-events";
import type { RuntimeObservationInputs } from "@contextlock/studio-control-plane";
import {
  APPROVAL_REGISTRY_ABI, AUTH_REGISTRY_ABI, ERC20_ABI, EXECUTOR_ABI, MAINNET, POLICY_REGISTRY_ABI,
  forkPublicClient, forkWalletClient, type ForkKeyring,
} from "./chain.js";
import { actionKindHash } from "./deployer.js";
import { driversFor, readEthUsd, type DriverContext, type DriverObservation, type Proposal, type ScenarioDriver } from "./drivers.js";
import type { ForkDeploymentRecord } from "./record.js";

/**
 * The agent runtime, on the fork.
 *
 * This is the generated agent's loop made concrete: observe every position it guards, decide
 * whether to ask, ask, and do exactly what the answer allows. It holds no key of its own. When the
 * policy engine says ALLOW, the ContextLock path runs in full — a capability signed by the issuer
 * role, an authorization recorded on the fork's registry by the authorizer role, and an `execute`
 * submitted by the relayer role — and the executor contract re-checks every one of those before it
 * calls the protocol. When it says ESCALATE, the same capability is issued and its authorization
 * recorded as ESCALATE, and it waits: only a signature from the approver — the stand-in for the
 * Ledger device — recorded in the approval registry lets the executor run it. DENY stops here.
 *
 * Every tick is sampled for the performance view. Every decision and every transaction is an
 * event in the control plane's log, with a correlation id, so "why did it act?" has an answer.
 */

/** How often the agent looks. Frequent enough to react within a few blocks of a change. */
export const DEFAULT_TICK_MS = 6_000;
/** A repeated non-ALLOW verdict is re-recorded no more often than this while nothing changes. */
const REPEAT_DECISION_MS = 60_000;
/** A calm observation is recorded to the activity log no more often than this. */
const OBSERVATION_LOG_MS = 60_000;
/** How many tick samples the performance view keeps. At 6s, an hour. */
const SAMPLE_LIMIT = 600;
/** How long a capability and its authorization stay valid on the fork. An hour: the executor's ceiling, and a human's window. */
const CAPABILITY_TTL_S = 3_600n;
const AUTHORIZATION_TTL_S = 3_600n;

export interface TickSample {
  atMs: number;
  blockNumber: string;
  blockTimestampMs: number;
  /** The lowest health across the lending positions, for the chart; 100000 (10.0) when there is none. */
  healthFactorBps: number;
  ethUsd: number;
  vaultUsdc: number;
  vaultEth: number;
  policyEnabled: boolean;
  /** Every protocol's own reading on this tick. */
  protocols: DriverObservation[];
  /** What the agent did on this tick, if anything. */
  action: "NONE" | "PROPOSED" | "EXECUTED" | "ERROR";
  verdict: PolicyDecision["verdict"] | null;
  reasonCode: string | null;
  correlationId: string | null;
}

export interface DecisionRecord {
  correlationId: string;
  atMs: number;
  driverId: string;
  protocol: string;
  actionKind: string;
  label: string;
  verdict: PolicyDecision["verdict"];
  reasonCode: string;
  riskBand: PolicyDecision["riskBand"];
  /** USD, 6 decimals. */
  amountUsd6: string;
  healthFactorBps: number | null;
  ethUsd: number;
  policyEnabled: boolean;
  /** Which fields the engine saw from the fork, and which were neutralised. Stated, not implied. */
  basis: { fromFork: string[]; neutralised: string[] };
  executed: boolean;
  /** Set once a human approved an escalation; the executor consumed the approval on execution. */
  approvedByHuman: boolean;
  txHashes: Hex[];
  healthFactorAfterBps: number | null;
}

export interface ExecutionRecord {
  correlationId: string;
  atMs: number;
  driverId: string;
  label: string;
  amountUsd6: string;
  txs: ForkTransaction[];
  healthFactorBeforeBps: number | null;
  healthFactorAfterBps: number | null;
  approvedByHuman: boolean;
}

/** An escalated proposal, with its capabilities already issued, waiting for a human. */
/** One signature a wallet produced over the approval registry's EIP-712 digest for one step. */
export interface ApprovalSignature {
  capabilityDigest: Hex;
  /** Unix seconds; the same value that was in the signed message. */
  expiresAt: number;
  signature: Hex;
}

/** What a wallet is asked to sign: the registry's domain, its one type, and a message per step. */
export interface ApprovalTypedData {
  correlationId: string;
  approver: Address;
  approverMode: "STAND_IN" | "WALLET";
  domain: { name: "ContextLockApproval"; version: "1"; chainId: 31337; verifyingContract: Address };
  types: { ContextLockApproval: Array<{ name: string; type: string }> };
  primaryType: "ContextLockApproval";
  messages: Array<{ label: string; message: { capabilityDigest: Hex; approver: Address; expiresAt: number } }>;
  /** The fork's clock, so a client can see how long the signature is good for. */
  forkTimestampUnix: number;
}

export interface PendingEscalation {
  correlationId: string;
  driverId: string;
  protocol: string;
  label: string;
  amountUsd6: string;
  reasonCode: string;
  sinceMs: number;
  /** The capability digests a human's signature must cover, one per step. */
  capabilityIds: Hex[];
  expiresAtUnix: number;
}

interface PreparedStep {
  kind: string;
  target: Address;
  calldata: Hex;
  value: bigint;
  label: string;
  cap: Capability;
  signature: Hex;
  digest: Hex;
}

export interface ForkAgentRuntimeDeps {
  record: ForkDeploymentRecord;
  blueprint: ContextLockAgentBlueprint;
  /** The deployment's keys: the issuer signs, the authorizer records, the relayer submits, the approver approves. */
  keyring: ForkKeyring;
  events: EventStore;
  nowMs?: () => number;
  tickMs?: number;
  /** Injected for tests; defaults to real clients on the fork. */
  clients?: { pub: PublicClient; authorizer: WalletClient; relayer: WalletClient; user: WalletClient };
  onSample?: (s: TickSample) => void;
}

const NEUTRALISED = [
  "slippageBps = 0 — repayments and stakes carry no execution slippage; a swap's is bounded by its minimum output in calldata",
  "volatilityBps = 0 — not observed on the fork; 0 cannot trip the volatility bound",
  "liquidity = the policy's own minimum — not observed; the minimum cannot fall below itself",
];
const FROM_FORK = [
  "healthFactorBps — the position's own health, read on the fork (Aave getUserAccountData, Comet balances, Morpho position and oracle)",
  "the action amount — sized from the fork's balances, and valued in USD at the Chainlink ETH/USD feed on the fork",
  "policy.enabled — ContextLockPolicyRegistry.isPolicyEnabled on the fork",
];

export class ForkAgentRuntime {
  readonly samples: TickSample[] = [];
  readonly decisions: DecisionRecord[] = [];
  readonly executions: ExecutionRecord[] = [];
  readonly drivers: ScenarioDriver[];
  readonly state = {
    paused: false,
    stopping: false,
    startedAtMs: null as number | null,
    lastHeartbeatMs: null as number | null,
    lastTickAtMs: null as number | null,
    ticks: 0,
    consecutiveErrors: 0,
    lastError: null as string | null,
  };
  /** Escalations awaiting a human, by correlation id. The prepared steps stay in memory only. */
  private readonly pendingByCorrelation = new Map<string, { escalation: PendingEscalation; steps: PreparedStep[]; obs: DriverObservation }>();
  /** The last non-ALLOW verdict per driver, so the same answer to the same situation is not re-logged every tick. */
  private readonly lastVerdict = new Map<string, { key: string; atMs: number }>();

  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<TickSample | null> | null = null;
  private nonceSeq = 0n;
  private lastObservationLogMs = 0;
  private readonly pub: PublicClient;
  private readonly authorizer: WalletClient;
  private readonly relayer: WalletClient;
  private readonly userWallet: WalletClient;
  private readonly policy: PrivatePolicy;
  private readonly ctx: DriverContext;

  constructor(private readonly deps: ForkAgentRuntimeDeps) {
    const endpoint = deps.record.fork?.endpoint;
    if (!endpoint || !deps.record.contracts || !deps.record.position) {
      throw new Error("the runtime needs a deployed record: fork, contracts and position");
    }
    this.pub = deps.clients?.pub ?? forkPublicClient(endpoint);
    this.authorizer = deps.clients?.authorizer ?? forkWalletClient(endpoint, deps.keyring.account("authorizer"));
    this.relayer = deps.clients?.relayer ?? forkWalletClient(endpoint, deps.keyring.account("relayer"));
    this.userWallet = deps.clients?.user ?? forkWalletClient(endpoint, deps.keyring.account("user"));
    // The same derivation the fork's public policy hash committed to, with the engine's private
    // fields intact. Held here, in the confidential half, and never written to an event.
    const base = policyFromBlueprint(deps.blueprint);
    this.policy = {
      ...base,
      allowedActionKinds: deps.record.policy.allowedActionKinds,
      allowedTargets: deps.record.policy.allowedTargets,
      authorizedAgentIdentityHashes: [deps.record.agentIdentityHash],
    };
    this.drivers = driversFor(deps.record.position.scenarios.map((s) => s.actionKind)).drivers;
    this.ctx = {
      pub: this.pub, vault: deps.record.contracts.ContextLockExecutor, user: deps.record.roles.user, userWallet: this.userWallet,
      policy: deps.record.policy, relayer: deps.record.roles.relayer, ethBaseline: { wei: BigInt(deps.record.position.ethBaselineWei) },
      ethUsd: () => readEthUsd(this.pub),
    };
  }

  private now(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  /** The driver context, for the service's stress controls. */
  driverContext(): DriverContext {
    return this.ctx;
  }

  /* ───────────────────────────── lifecycle ───────────────────────────── */

  start(): void {
    if (this.timer) return;
    this.state.startedAtMs = this.now();
    this.state.lastHeartbeatMs = this.now();
    this.emit({ type: "RUNTIME_STATE_CHANGED", source: "RUNTIME", severity: "INFO", correlationId: `corr_runtime_${this.deps.record.deploymentId}`, publicMetadata: { state: "STARTING", protocols: this.drivers.map((d) => d.protocol), note: "the agent runtime observes the fork; the ContextLock policy on the fork decides whether it may act" } });
    const loop = () => {
      this.timer = setTimeout(() => {
        void this.tick().finally(() => { if (!this.state.stopping) loop(); });
      }, this.deps.tickMs ?? DEFAULT_TICK_MS);
      this.timer.unref?.();
    };
    void this.tick().finally(loop);
  }

  stop(reason: string): void {
    this.state.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.emit({ type: "RUNTIME_STATE_CHANGED", source: "RUNTIME", severity: "NOTICE", correlationId: `corr_runtime_${this.deps.record.deploymentId}`, publicMetadata: { state: "STOPPED", reason, note: "stopping the runtime does NOT disable the ContextLock policy" } });
  }

  pause(): void {
    this.state.paused = true;
    this.emit({ type: "RUNTIME_STATE_CHANGED", source: "RUNTIME", severity: "NOTICE", correlationId: `corr_runtime_${this.deps.record.deploymentId}`, publicMetadata: { state: "PAUSED", note: "a paused runtime does not observe or propose; the policy on the fork is unchanged" } });
  }

  resume(): void {
    this.state.paused = false;
    this.emit({ type: "RUNTIME_STATE_CHANGED", source: "RUNTIME", severity: "INFO", correlationId: `corr_runtime_${this.deps.record.deploymentId}`, publicMetadata: { state: "HEALTHY" } });
  }

  /** What the control plane's health model reads. The loop is the container. */
  runtimeInputs(): RuntimeObservationInputs {
    const now = this.now();
    return {
      containerRunning: !this.state.stopping && this.timer !== null,
      containerHealth: this.state.consecutiveErrors >= 3 ? "unhealthy" : "healthy",
      restartsInWindow: 0,
      observedImageDigest: `fork-runtime:${this.deps.record.deploymentId}`,
      lastHeartbeatMs: this.state.lastHeartbeatMs,
      controlPlaneReachable: true,
      modelGatewayReachable: true,
      adapterBrokerReachable: this.state.consecutiveErrors === 0,
      contextlockBrokerReachable: true,
      eventCursorAgeMs: this.state.lastTickAtMs === null ? null : now - this.state.lastTickAtMs,
      credentialValid: true,
      credentialExpiresAtMs: null,
      strategyCheckpointAgeMs: this.state.lastTickAtMs === null ? null : now - this.state.lastTickAtMs,
      paused: this.state.paused,
      // STOPPING only while the loop is still winding down; once the timer is gone it is STOPPED.
      stopping: this.state.stopping && this.timer !== null,
      processStartedAtMs: this.state.startedAtMs,
      nowMs: now,
    };
  }

  latest(): TickSample | null {
    return this.samples.at(-1) ?? null;
  }

  pending(): PendingEscalation[] {
    return [...this.pendingByCorrelation.values()].map((p) => p.escalation);
  }

  /* ───────────────────────────── the tick ───────────────────────────── */

  tick(): Promise<TickSample | null> {
    if (this.state.stopping) return Promise.resolve(null);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async runTick(): Promise<TickSample | null> {
    const now = this.now();
    this.state.lastHeartbeatMs = now;
    try {
      if (this.state.paused) return null;
      const sample = await this.observe(now);
      this.state.lastTickAtMs = now;
      this.state.ticks += 1;
      this.state.consecutiveErrors = 0;
      this.state.lastError = null;

      let result: TickSample = sample;
      for (const d of this.drivers) {
        const obs = sample.protocols.find((o) => o.driverId === d.id)!;
        const r = await this.decide(d, obs, sample);
        // The sample records the most consequential thing that happened on this tick.
        if (r && (result.action === "NONE" || r.action === "EXECUTED" || r.action === "ERROR")) result = { ...sample, ...r };
      }
      if (result.action === "NONE" && now - this.lastObservationLogMs >= OBSERVATION_LOG_MS) {
        this.lastObservationLogMs = now;
        this.emit({ type: "ADAPTER_READ", source: "ADAPTER", severity: "DEBUG", correlationId: `corr_observe_${now}`, adapterId: "fork-position-readers", chainId: 31337, blockNumber: sample.blockNumber, publicMetadata: { protocols: sample.protocols.map((p) => ({ protocol: p.protocol, detail: p.detail })), ethUsd: sample.ethUsd, policyEnabled: sample.policyEnabled, verdict: "no action needed" } });
      }
      this.pushSample(result);
      return result;
    } catch (e) {
      this.state.consecutiveErrors += 1;
      this.state.lastError = (e as Error).message;
      this.emit({ type: "ADAPTER_FAILED", source: "ADAPTER", severity: "WARNING", correlationId: `corr_tick_${now}`, adapterId: "fork-position-readers", publicMetadata: { error: (e as Error).message.slice(0, 300), consecutiveErrors: this.state.consecutiveErrors } });
      return null;
    }
  }

  private async observe(atMs: number): Promise<TickSample> {
    const rec = this.deps.record;
    const block = await this.pub.getBlock();
    const [ethUsd8, vaultUsdc, vaultEth, policyEnabled] = await Promise.all([
      readEthUsd(this.pub),
      this.pub.readContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [rec.contracts!.ContextLockExecutor] }),
      this.pub.getBalance({ address: rec.contracts!.ContextLockExecutor }),
      this.pub.readContract({ address: rec.contracts!.ContextLockPolicyRegistry, abi: POLICY_REGISTRY_ABI, functionName: "isPolicyEnabled", args: [rec.agentIdentityHash as Hex, rec.policyHash as Hex] }),
    ]);
    const protocols: DriverObservation[] = [];
    for (const d of this.drivers) protocols.push(await d.observe(this.ctx));
    const healths = protocols.map((p) => p.healthBps).filter((h): h is number => h !== null);
    return {
      atMs, blockNumber: block.number.toString(), blockTimestampMs: Number(block.timestamp) * 1000,
      healthFactorBps: healths.length ? Math.min(...healths) : 100_000,
      ethUsd: Number(ethUsd8) / 1e8, vaultUsdc: Number(vaultUsdc) / 1e6, vaultEth: Number(vaultEth) / 1e18, policyEnabled, protocols,
      action: "NONE", verdict: null, reasonCode: null, correlationId: null,
    };
  }

  private pushSample(s: TickSample): void {
    this.samples.push(s);
    if (this.samples.length > SAMPLE_LIMIT) this.samples.splice(0, this.samples.length - SAMPLE_LIMIT);
    this.deps.onSample?.(s);
  }

  /* ───────────────────────────── deciding ───────────────────────────── */

  private async decide(driver: ScenarioDriver, obs: DriverObservation, sample: TickSample): Promise<Pick<TickSample, "action" | "verdict" | "reasonCode" | "correlationId"> | null> {
    const rec = this.deps.record;
    const now = this.now();

    // A driver with an escalation outstanding does not propose again; the human has the floor.
    const outstanding = [...this.pendingByCorrelation.values()].find((p) => p.escalation.driverId === driver.id);
    if (outstanding) return { action: "PROPOSED", verdict: "ESCALATE", reasonCode: outstanding.escalation.reasonCode, correlationId: outstanding.escalation.correlationId };

    const proposal = await driver.propose(this.ctx, obs);
    if (!proposal) {
      if (this.lastVerdict.has(driver.id)) {
        this.lastVerdict.delete(driver.id);
        this.emit({ type: "DECISION_NO_ACTION", source: "AGENT", severity: "INFO", correlationId: `corr_${rec.deploymentId.slice(4)}_${now.toString(36)}`, publicMetadata: { protocol: driver.protocol, detail: "the condition that prompted the proposal has cleared; nothing to do" } });
      }
      return null;
    }

    const ctx: MarketContext = { observedAtUnix: Math.floor(now / 1000), slippageBps: 0, volatilityBps: 0, liquidity: this.policy.minLiquidity, healthFactorBps: obs.healthBps ?? this.policy.targetHealthFactorBps };
    // The policy the engine rules with reflects the fork's registry bit: DISABLED there is DISABLED here.
    const policy: PrivatePolicy = { ...this.policy, enabled: sample.policyEnabled };
    const correlationId = `corr_${rec.deploymentId.slice(4)}_${now.toString(36)}_${driver.id.slice(0, 4)}`;
    const nowUnix = Math.floor(now / 1000);

    // Every step is ruled on; the worst verdict stands. An approve is judged at the action's amount.
    let decision: PolicyDecision | null = null;
    for (const step of proposal.steps) {
      const d = evaluatePolicy(this.request(correlationId, step.kind, step.target, step.calldata, proposal.amountUsd6), policy, ctx, nowUnix);
      decision = decision ? worst(decision, d) : d;
    }
    decision = decision!;

    const key = `${decision.verdict}:${decision.reasonCode}:${bucket(proposal.amountUsd6)}`;
    const prior = this.lastVerdict.get(driver.id);
    if (decision.verdict !== "ALLOW" && prior?.key === key && now - prior.atMs < REPEAT_DECISION_MS) {
      // The same answer to the same situation. Not re-recorded every six seconds.
      return { action: "PROPOSED", verdict: decision.verdict, reasonCode: decision.reasonCode, correlationId: null };
    }
    this.lastVerdict.set(driver.id, { key, atMs: now });

    const amountUsd = Number(proposal.amountUsd6) / 1e6;
    this.emit({ type: "AGENT_TRIGGERED", source: "AGENT", severity: "INFO", correlationId, agentRunId: correlationId, chainId: 31337, blockNumber: sample.blockNumber, publicMetadata: { protocol: driver.protocol, trigger: obs.detail, ...proposal.detail } });
    this.emit({ type: "ADAPTER_READ", source: "ADAPTER", severity: "INFO", correlationId, agentRunId: correlationId, adapterId: `${driver.protocol}-state`, chainId: 31337, blockNumber: sample.blockNumber, publicMetadata: { ...obs.metrics, trustClass: "DIRECT_CHAIN_DATA" } });
    this.emit({ type: "ADAPTER_READ", source: "ADAPTER", severity: "INFO", correlationId, agentRunId: correlationId, adapterId: "reference-oracle", chainId: 31337, blockNumber: sample.blockNumber, publicMetadata: { metric: "weth/usd:price", ethUsd: sample.ethUsd, trustClass: "VERIFIED_ORACLE" } });
    this.emit({ type: "STRATEGY_EVALUATED", source: "AGENT", severity: "INFO", correlationId, agentRunId: correlationId, strategyEvaluationId: `${correlationId}:strategy`, publicMetadata: { protocol: driver.protocol, proposal: proposal.label, actionKind: proposal.kind, amountUsd } });
    this.emit({
      type: decision.verdict === "ALLOW" ? "DECISION_ALLOW" : decision.verdict === "ESCALATE" ? "DECISION_ESCALATE" : "DECISION_DENY",
      source: "CONTEXTLOCK", severity: decision.verdict === "ALLOW" ? "NOTICE" : "WARNING",
      correlationId, agentRunId: correlationId, strategyEvaluationId: `${correlationId}:strategy`,
      publicMetadata: { protocol: driver.protocol, verdict: decision.verdict, reasonCode: decision.reasonCode, riskBand: decision.riskBand, amountUsd, policyEnabled: sample.policyEnabled, basis: { fromFork: FROM_FORK, neutralised: NEUTRALISED } },
    });

    const record: DecisionRecord = {
      correlationId, atMs: now, driverId: driver.id, protocol: driver.protocol, actionKind: proposal.kind, label: proposal.label,
      verdict: decision.verdict, reasonCode: decision.reasonCode, riskBand: decision.riskBand, amountUsd6: proposal.amountUsd6.toString(),
      healthFactorBps: obs.healthBps, ethUsd: sample.ethUsd, policyEnabled: sample.policyEnabled,
      basis: { fromFork: FROM_FORK, neutralised: NEUTRALISED }, executed: false, approvedByHuman: false, txHashes: [], healthFactorAfterBps: null,
    };
    this.decisions.push(record);
    if (this.decisions.length > 200) this.decisions.splice(0, this.decisions.length - 200);

    if (decision.verdict === "DENY") return { action: "PROPOSED", verdict: "DENY", reasonCode: decision.reasonCode, correlationId };

    try {
      // ALLOW and ESCALATE both get a real capability and a real authorization. The verdict is
      // what the authorizer records, and it is what the executor reads.
      const prepared = await this.prepare(correlationId, proposal, ctx, decision.verdict);
      if (decision.verdict === "ESCALATE") {
        const expiresAtUnix = Number(prepared[0]!.cap.expiresAt);
        this.pendingByCorrelation.set(correlationId, {
          escalation: { correlationId, driverId: driver.id, protocol: driver.protocol, label: proposal.label, amountUsd6: proposal.amountUsd6.toString(), reasonCode: decision.reasonCode, sinceMs: now, capabilityIds: prepared.map((p) => p.digest), expiresAtUnix },
          steps: prepared, obs,
        });
        this.emit({ type: "CAPABILITY_REQUESTED", source: "CONTEXTLOCK", severity: "WARNING", correlationId, agentRunId: correlationId, publicMetadata: { protocol: driver.protocol, waitingFor: rec.approverMode === "WALLET" ? "a human signature in the approval registry (the operator's connected wallet; no Ledger device — BLK-002)" : "a human signature in the approval registry (stand-in approver; no Ledger device — BLK-002)", capabilityIds: prepared.map((p) => p.digest), expiresAtUnix } });
        return { action: "PROPOSED", verdict: "ESCALATE", reasonCode: decision.reasonCode, correlationId };
      }
      const exec = await this.execute(correlationId, driver, obs, proposal, prepared, false);
      record.executed = true;
      record.txHashes = exec.txs.map((t) => t.hash as Hex);
      record.healthFactorAfterBps = exec.healthFactorAfterBps;
      return { action: "EXECUTED", verdict: "ALLOW", reasonCode: decision.reasonCode, correlationId };
    } catch (e) {
      this.emit({ type: "AGENT_RUN_FAILED", source: "AGENT", severity: "ERROR", correlationId, agentRunId: correlationId, publicMetadata: { protocol: driver.protocol, error: (e as Error).message.slice(0, 400) } });
      return { action: "ERROR", verdict: decision.verdict, reasonCode: decision.reasonCode, correlationId };
    }
  }

  private request(correlationId: string, kind: string, target: Address, calldata: Hex, amountUsd6: bigint): EvaluationRequest {
    const rec = this.deps.record;
    return {
      requestHash: keccak256(toHex(`${correlationId}:${kind}:request`)),
      agentIdentityHash: rec.agentIdentityHash,
      ensNode: rec.ensNode,
      agent: rec.roles.user,
      chainId: 31337,
      target,
      value: 0n,
      calldataHash: keccak256(calldata),
      selector: calldata.slice(0, 10),
      decodedRecipient: rec.roles.user,
      decodedAmount: amountUsd6,
      intentHash: keccak256(toHex(`${correlationId}:${kind}`)),
      policyId: this.policy.policyId,
      policyVersion: this.policy.policyVersion,
      actionKind: kind,
    };
  }

  /* ───────────────────────────── the ContextLock path ───────────────────────────── */

  /**
   * Issue a capability per step and record its authorization with the verdict.
   *
   * ALLOW and ESCALATE differ only in the recorded verdict; the executor treats them differently.
   * The fork's own clock is used for every on-chain time field — Anvil's blocks continue from the
   * pinned block's timestamp, and the executor compares against block.timestamp.
   */
  private async prepare(correlationId: string, proposal: Proposal, ctx: MarketContext, verdict: "ALLOW" | "ESCALATE"): Promise<PreparedStep[]> {
    const rec = this.deps.record;
    const executor = rec.contracts!.ContextLockExecutor;
    const issuer = this.deps.keyring.account("issuer");
    const contextCommitment = keccak256(toHex(JSON.stringify({ ...ctx, liquidity: ctx.liquidity.toString() })));
    const latest = await this.pub.getBlock();
    const issuedAt = latest.timestamp;
    const out: PreparedStep[] = [];
    for (const step of proposal.steps) {
      this.nonceSeq += 1n;
      const cap: Capability = {
        version: CAPABILITY_VERSION,
        agentIdentityHash: rec.agentIdentityHash as Hex,
        agent: rec.roles.user,
        chainId: 31337n,
        executor,
        target: step.target,
        value: step.value,
        calldataHash: keccak256(step.calldata),
        intentHash: keccak256(toHex(`${correlationId}:${step.kind}`)),
        policyHash: rec.policyHash as Hex,
        authorizationId: keccak256(toHex(`${correlationId}:${step.kind}:authorization`)),
        contextCommitment,
        issuedAt,
        expiresAt: issuedAt + CAPABILITY_TTL_S,
        nonce: BigInt(this.now()) * 1000n + this.nonceSeq,
      };
      const signature = await issuer.signTypedData({ domain: domain(cap.chainId, cap.executor), types: CAPABILITY_TYPES, primaryType: "Capability", message: cap });
      const digest = capabilityDigest(cap);
      this.emit({ type: "CAPABILITY_ISSUED", source: "CONTEXTLOCK", severity: "INFO", correlationId, agentRunId: correlationId, capabilityId: digest, authorizationId: cap.authorizationId, chainId: 31337, publicMetadata: { actionKind: step.kind, target: step.target, valueWei: step.value.toString(), verdict, expiresAt: Number(cap.expiresAt), label: step.label } });

      assertExecutionAllowed({ chainId: 31337, role: "LOCAL_FORK", forkedFrom: 1, forkBlock: rec.fork!.forkBlock }, "LOCAL_WRITE", `fork runtime: ${step.label}`);
      const authHash = await this.authorizer.writeContract({
        address: rec.contracts!.ContextLockAuthorizationRegistry, abi: AUTH_REGISTRY_ABI, functionName: "recordAuthorization",
        args: [cap.authorizationId, requestHash(cap), cap.policyHash, cap.contextCommitment, issuedAt, issuedAt + AUTHORIZATION_TTL_S, verdict === "ALLOW" ? 1 : 2],
        account: this.authorizer.account!, chain: this.authorizer.chain,
      });
      const authReceipt = await this.pub.waitForTransactionReceipt({ hash: authHash, timeout: 180_000 });
      this.emit({ type: "AUTHORIZATION_RECORDED", source: "CHAIN", severity: "INFO", correlationId, agentRunId: correlationId, authorizationId: cap.authorizationId, capabilityId: digest, chainId: 31337, blockNumber: authReceipt.blockNumber.toString(), txHash: authHash, publicMetadata: { verdict, network: LOCAL_FORK_TX_LABEL, approvedUntil: Number(issuedAt + AUTHORIZATION_TTL_S) } });
      out.push({ ...step, cap, signature, digest });
    }
    return out;
  }

  /** Submit each prepared step through the executor. The executor re-checks everything. */
  private async execute(correlationId: string, driver: ScenarioDriver, before: DriverObservation, proposal: Proposal, steps: PreparedStep[], approvedByHuman: boolean): Promise<ExecutionRecord> {
    const rec = this.deps.record;
    const executor = rec.contracts!.ContextLockExecutor;
    const txs: ForkTransaction[] = [];
    for (const step of steps) {
      this.emit({ type: "EXECUTION_SUBMITTED", source: "CHAIN", severity: "INFO", correlationId, agentRunId: correlationId, capabilityId: step.digest, chainId: 31337, publicMetadata: { label: step.label, target: step.target, via: "ContextLockExecutor.execute", submittedBy: "relayer role", approvedByHuman, network: LOCAL_FORK_TX_LABEL } });
      let hash: Hex;
      try {
        hash = await this.relayer.writeContract({
          address: executor, abi: EXECUTOR_ABI, functionName: "execute",
          args: [step.cap, step.signature, step.calldata, actionKindHash(step.kind)],
          value: step.value,
          account: this.relayer.account!, chain: this.relayer.chain, gas: 900_000n,
        });
      } catch (e) {
        this.emit({ type: "EXECUTION_REVERTED", source: "CHAIN", severity: "ERROR", correlationId, agentRunId: correlationId, capabilityId: step.digest, chainId: 31337, publicMetadata: { label: step.label, error: (e as Error).message.slice(0, 400), network: LOCAL_FORK_TX_LABEL } });
        throw e;
      }
      const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      txs.push(this.forkTx(hash, receipt, rec.roles.relayer, executor));
      if (receipt.status !== "success") {
        this.emit({ type: "EXECUTION_REVERTED", source: "CHAIN", severity: "ERROR", correlationId, agentRunId: correlationId, capabilityId: step.digest, chainId: 31337, blockNumber: receipt.blockNumber.toString(), txHash: hash, publicMetadata: { label: step.label, network: LOCAL_FORK_TX_LABEL } });
        throw new Error(`${step.label} reverted on the fork`);
      }
      this.emit({ type: "EXECUTION_MINED", source: "CHAIN", severity: "NOTICE", correlationId, agentRunId: correlationId, capabilityId: step.digest, chainId: 31337, blockNumber: receipt.blockNumber.toString(), txHash: hash, publicMetadata: { label: step.label, gasUsed: receipt.gasUsed.toString(), network: LOCAL_FORK_TX_LABEL, explorer: "none — a fork transaction exists only on this machine" } });
    }

    const after = await driver.observe(this.ctx);
    const result: ExecutionRecord = {
      correlationId, atMs: this.now(), driverId: driver.id, label: proposal.label, amountUsd6: proposal.amountUsd6.toString(), txs,
      healthFactorBeforeBps: before.healthBps, healthFactorAfterBps: after.healthBps, approvedByHuman,
    };
    this.executions.push(result);
    if (this.executions.length > 100) this.executions.splice(0, this.executions.length - 100);
    this.emit({ type: "AGENT_RUN_COMPLETED", source: "AGENT", severity: "NOTICE", correlationId, agentRunId: correlationId, chainId: 31337, publicMetadata: { protocol: driver.protocol, action: proposal.label, amountUsd: Number(proposal.amountUsd6) / 1e6, before: before.detail, after: after.detail, transactions: txs.length, approvedByHuman, network: LOCAL_FORK_TX_LABEL } });
    return result;
  }

  /**
   * A human approves an escalation.
   *
   * The approver signs the approval registry's EIP-712 digest over each capability digest, the
   * signature is recorded on the fork, and the executor — which reads the registry itself — is
   * asked to run the steps. The approver is a stand-in key, not a Ledger device (BLK-002), and
   * the record says so.
   */
  async approve(correlationId: string, signatures: ApprovalSignature[] | null = null): Promise<ExecutionRecord> {
    const pending = this.pendingByCorrelation.get(correlationId);
    if (!pending) throw new Error(`no escalation ${correlationId} is waiting for approval`);
    const rec = this.deps.record;
    const registry = rec.contracts!.ContextLockApprovalRegistry;
    const approverAddress = rec.roles.approver;
    const relay = this.relayer;
    const latest = await this.pub.getBlock();
    const walletMode = rec.approverMode === "WALLET";
    const signerNote = walletMode
      ? "the operator's connected wallet (EIP-712) — NOT a Ledger device (BLK-002)"
      : "stand-in approver key — NOT a Ledger device (BLK-002)";

    /*
     * Two ways to a signature, one rule: the registry only accepts its configured approver's.
     *
     * STAND_IN signs here with the fork's own key. WALLET cannot — the key is in the browser — so
     * the signatures arrive with the request, one per step, and each is checked to recover to the
     * approver BEFORE it is relayed. The contract checks again; the pre-check is so a wrong wallet
     * gets a named refusal rather than a revert.
     */
    const signed = new Map<Hex, { expiresAt: bigint; signature: Hex }>();
    if (walletMode) {
      if (!signatures || signatures.length === 0) throw new Error("this deployment's approver is the connected wallet; the approval needs its EIP-712 signatures");
      for (const s of signatures) {
        const expiresAt = BigInt(s.expiresAt);
        if (expiresAt <= latest.timestamp) throw new Error(`the signed approval for ${s.capabilityDigest.slice(0, 12)}… has already expired on the fork`);
        const digest = await this.pub.readContract({ address: registry, abi: APPROVAL_REGISTRY_ABI, functionName: "approvalDigest", args: [s.capabilityDigest, approverAddress, expiresAt] });
        const recovered = await recoverAddress({ hash: digest, signature: s.signature });
        if (recovered.toLowerCase() !== approverAddress.toLowerCase()) {
          throw new Error(`the signature for ${s.capabilityDigest.slice(0, 12)}… was made by ${recovered}, not the deployment's approver ${approverAddress}`);
        }
        signed.set(s.capabilityDigest.toLowerCase() as Hex, { expiresAt, signature: s.signature });
      }
      const missing = pending.steps.filter((st) => !signed.has(st.digest.toLowerCase() as Hex));
      if (missing.length > 0) throw new Error(`no signature for ${missing.map((m) => m.label).join(", ")}; every step of an escalation needs one`);
    } else {
      const approver = this.deps.keyring.account("approver");
      const expiresAt = latest.timestamp + 1_800n;
      for (const step of pending.steps) {
        const digest = await this.pub.readContract({ address: registry, abi: APPROVAL_REGISTRY_ABI, functionName: "approvalDigest", args: [step.digest, approver.address, expiresAt] });
        signed.set(step.digest.toLowerCase() as Hex, { expiresAt, signature: await approver.sign({ hash: digest }) });
      }
    }

    for (const step of pending.steps) {
      const { expiresAt, signature } = signed.get(step.digest.toLowerCase() as Hex)!;
      const hash = await relay.writeContract({ address: registry, abi: APPROVAL_REGISTRY_ABI, functionName: "submitApproval", args: [step.digest, expiresAt, signature], account: relay.account!, chain: relay.chain });
      const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== "success") throw new Error(`the approval for ${step.label} was not recorded (tx ${hash})`);
      this.emit({ type: "AUTHORIZATION_RECORDED", source: "OPERATOR", severity: "NOTICE", correlationId, agentRunId: correlationId, capabilityId: step.digest, chainId: 31337, blockNumber: receipt.blockNumber.toString(), txHash: hash, publicMetadata: { approval: "human approval recorded in ContextLockApprovalRegistry", signer: signerNote, approver: approverAddress, expiresAt: Number(expiresAt), network: LOCAL_FORK_TX_LABEL } });
    }
    const driver = this.drivers.find((d) => d.id === pending.escalation.driverId)!;
    const proposal: Proposal = { driverId: driver.id, kind: pending.steps.at(-1)!.kind, label: pending.escalation.label, amountUsd6: BigInt(pending.escalation.amountUsd6), steps: pending.steps, detail: {} };
    this.pendingByCorrelation.delete(correlationId);
    const exec = await this.execute(correlationId, driver, pending.obs, proposal, pending.steps, true);
    const d = this.decisions.find((x) => x.correlationId === correlationId);
    if (d) { d.executed = true; d.approvedByHuman = true; d.txHashes = exec.txs.map((t) => t.hash as Hex); d.healthFactorAfterBps = exec.healthFactorAfterBps; }
    this.lastVerdict.delete(driver.id);
    return exec;
  }

  /**
   * The EIP-712 payloads for one escalation, ready for `eth_signTypedData_v4`.
   *
   * Mirrors the registry's constructor: name "ContextLockApproval", version "1", the fork's chain id
   * and the registry's address, over `ContextLockApproval(bytes32 capabilityDigest,address approver,
   * uint64 expiresAt)`. The expiry is the fork's clock plus thirty minutes — the fork's, not the
   * wall clock, because Anvil's timestamps continue from the pinned block.
   */
  async approvalTypedData(correlationId: string): Promise<ApprovalTypedData> {
    const pending = this.pendingByCorrelation.get(correlationId);
    if (!pending) throw new Error(`no escalation ${correlationId} is waiting for approval`);
    const rec = this.deps.record;
    const latest = await this.pub.getBlock();
    const expiresAt = Number(latest.timestamp + 1_800n);
    return {
      correlationId,
      approver: rec.roles.approver,
      approverMode: rec.approverMode,
      domain: { name: "ContextLockApproval", version: "1", chainId: 31337, verifyingContract: rec.contracts!.ContextLockApprovalRegistry },
      types: { ContextLockApproval: [{ name: "capabilityDigest", type: "bytes32" }, { name: "approver", type: "address" }, { name: "expiresAt", type: "uint64" }] },
      primaryType: "ContextLockApproval",
      messages: pending.steps.map((step) => ({ label: step.label, message: { capabilityDigest: step.digest, approver: rec.roles.approver, expiresAt } })),
      forkTimestampUnix: Number(latest.timestamp),
    };
  }

  /** A human declines an escalation. Nothing is executed; the authorization stays ESCALATE and cannot run. */
  decline(correlationId: string, reason: string): void {
    const pending = this.pendingByCorrelation.get(correlationId);
    if (!pending) throw new Error(`no escalation ${correlationId} is waiting for approval`);
    this.pendingByCorrelation.delete(correlationId);
    this.emit({ type: "CAPABILITY_REJECTED", source: "OPERATOR", severity: "NOTICE", correlationId, agentRunId: correlationId, publicMetadata: { declined: true, reason: reason.slice(0, 200), note: "the escalation was declined; its authorization stays ESCALATE and the executor will never run it without an approval" } });
  }

  private forkTx(hash: Hex, receipt: { blockNumber: bigint; gasUsed: bigint; status: "success" | "reverted" }, from: Address, to: Address): ForkTransaction {
    const fork = this.deps.record.fork!;
    return {
      hash, forkId: fork.forkId, chainId: 31337, forkedFrom: fork.sourceChainId, forkBlock: fork.forkBlock,
      blockNumber: receipt.blockNumber.toString(), from, to, status: receipt.status, gasUsed: receipt.gasUsed.toString(),
      label: LOCAL_FORK_TX_LABEL, impersonated: false,
    };
  }

  /* ───────────────────────────── events ───────────────────────────── */

  private emit(over: Partial<EventDraft> & { type: EventType; source: EventSource; severity: EventSeverity; correlationId: string }): void {
    const rec = this.deps.record;
    const draft: EventDraft = {
      organizationId: null, projectId: rec.projectId, deploymentId: rec.deploymentId, agentId: rec.agentId,
      timestamp: this.now(), agentRunId: null, modelRunId: null, strategyEvaluationId: null, creExecutionId: null,
      authorizationId: null, capabilityId: null, chainId: null, blockNumber: null, txHash: null, creWorkflowId: null,
      adapterId: null, runtimeRevision: `fork-runtime:${rec.deploymentId}`, buildRevision: rec.blueprintRevision,
      deploymentRevision: "rev_1", correctsEventId: null, publicMetadata: {},
      ...over,
    };
    try {
      this.deps.events.append(draft, this.now());
    } catch (e) {
      // An event the store refuses (a secret-shaped value, a malformed field) must not stop the
      // agent, but it must not vanish either.
      this.state.lastError = `event rejected: ${(e as Error).message.slice(0, 200)}`;
    }
  }
}

export function hfBps(healthFactorWad: bigint): number {
  // Aave reports type(uint256).max when there is no debt. Clamp to something a chart can draw.
  const capped = healthFactorWad > 10n ** 24n ? 10n ** 24n : healthFactorWad;
  return Number(capped / 10n ** 14n);
}

const worst = (a: PolicyDecision, b: PolicyDecision): PolicyDecision => {
  const rank = { ALLOW: 0, ESCALATE: 1, DENY: 2 } as const;
  return rank[b.verdict] > rank[a.verdict] ? b : a;
};

/** Amounts within the same $100 bucket are the same proposal for repeat-suppression. */
const bucket = (amountUsd6: bigint): string => (amountUsd6 / 100_000_000n).toString();
