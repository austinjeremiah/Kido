import type { SpecialistName } from "@kido/agents";
import type { CompileContext } from "./compile.js";
import type { EventLog } from "./events.js";
import type { ActionExecutor } from "./executor.js";
import { ReasoningGate, type DeterministicResponder, type GateDecision, type WakeCondition } from "./gate.js";
import type { MonitorEngine, MonitorEvent } from "./monitor.js";
import { validateProposal } from "./plan.js";
import { executePlan, type PlanRun, type RecoveryPolicy } from "./recovery.js";

/** A woken specialist: returns an untrusted proposal (or null) for the given situation. */
export type Specialist = (input: { specialist: SpecialistName; condition: WakeCondition; reason: string; event: MonitorEvent | null; run: PlanRun | null }) => Promise<unknown | null>;

export interface AgentRuntimeDeps<W> {
  agentId: string;
  monitors: MonitorEngine;
  responders: DeterministicResponder<W>[];
  world: () => Promise<W>;
  compile: () => CompileContext;
  executor: ActionExecutor;
  log: EventLog;
  recovery: RecoveryPolicy;
  maxRecoveryAttempts: number;
  known: { chains: CompileContext["bindings"] extends Record<infer C, unknown> ? C[] : never; assets: string[] };
  /** Absent: reasoning-required events are logged and left for the owner. */
  specialist?: Specialist | undefined;
}

export interface TickResult {
  events: MonitorEvent[];
  decisions: GateDecision[];
  runs: PlanRun[];
}

/**
 * The running agent (bible §16–§19): deterministic monitors produce events, the gate answers them
 * with a deterministic plan or wakes a specialist, and every plan — deterministic, specialist or
 * recovery — goes through the same compile, preflight and Amane path.
 */
export class AgentRuntime<W> {
  private readonly gate: ReasoningGate<W>;
  constructor(private readonly d: AgentRuntimeDeps<W>) {
    this.gate = new ReasoningGate(d.responders);
  }

  async tick(): Promise<TickResult> {
    const events = await this.d.monitors.tick();
    for (const [, h] of this.d.monitors.health) if (h.status !== "OK") this.d.log.append({ agentId: this.d.agentId, type: "MONITOR_HEALTH", severity: "WARNING", data: { ...h } });
    const decisions: GateDecision[] = [];
    const runs: PlanRun[] = [];
    for (const event of events) {
      this.d.log.append({ agentId: this.d.agentId, type: "MONITOR_EVENT", severity: "NOTICE", data: { monitorId: event.monitorId, kind: event.kind, ...event.data } });
      const decision = this.gate.decide(event, await this.d.world());
      decisions.push(decision);
      this.d.log.append({ agentId: this.d.agentId, type: "GATE_DECISION", severity: "INFO", data: { path: decision.path, ...(decision.path === "DETERMINISTIC" ? { responder: decision.responder } : decision.path === "REASONING_REQUIRED" ? { condition: decision.condition, specialist: decision.specialist, reason: decision.reason } : { reason: decision.reason }) } });
      if (decision.path === "DETERMINISTIC") runs.push(...(await this.run(decision.steps, event)));
      else if (decision.path === "REASONING_REQUIRED") runs.push(...(await this.reason(decision.specialist, decision.condition, decision.reason, event, null)));
    }
    return { events, decisions, runs };
  }

  private async run(steps: Parameters<typeof executePlan>[0], event: MonitorEvent | null, attempt = 0): Promise<PlanRun[]> {
    const run = await executePlan(steps, this.d.compile(), this.d.executor, this.d.log, { agentId: this.d.agentId, recovery: this.d.recovery });
    if (run.wake && attempt < this.d.maxRecoveryAttempts) return [run, ...(await this.reason("RecoveryAgent", run.wake.condition, run.wake.reason, event, run, attempt + 1))];
    return [run];
  }

  private async reason(specialist: SpecialistName, condition: WakeCondition, reason: string, event: MonitorEvent | null, prior: PlanRun | null, attempt = 0): Promise<PlanRun[]> {
    this.d.log.append({ agentId: this.d.agentId, type: "REASONING_WOKEN", severity: "NOTICE", data: { specialist, condition, reason } });
    if (!this.d.specialist) {
      this.d.log.append({ agentId: this.d.agentId, type: "OWNER_NOTIFIED", severity: "WARNING", data: { reason: `reasoning required (${condition}) and no specialist is configured` } });
      return [];
    }
    const proposal = await this.d.specialist({ specialist, condition, reason, event, run: prior });
    if (proposal === null) return [];
    const v = validateProposal(proposal, specialist, this.d.known);
    if (!v.ok) {
      this.d.log.append({ agentId: this.d.agentId, type: "PLAN_REFUSED", severity: "WARNING", data: { specialist, reasons: v.reasons } });
      return [];
    }
    return this.run(v.steps, event, attempt);
  }
}
