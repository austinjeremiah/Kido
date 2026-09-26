import type { AmaneOutcome } from "@kido/amane-bridge";
import { compileStep, type CompileContext } from "./compile.js";
import type { EventLog } from "./events.js";
import type { ActionExecutor } from "./executor.js";
import type { WakeCondition } from "./gate.js";
import { planHash, type SemanticStep } from "./plan.js";

export type StepStatus = "PENDING" | "EXECUTED" | "REFUSED" | "REJECTED_BY_AMANE" | "NONCE_CONSUMED" | "OPERATIONAL_FAILURE" | "SKIPPED";
export type PlanStatus = "COMPLETED" | "REFUSED" | "REJECTED" | "FAILED" | "RECOVERY_REQUIRED";

export interface StepRecord {
  step: SemanticStep;
  status: StepStatus;
  code?: string | undefined;
  tx?: string | undefined;
}

export interface PlanRun {
  planHash: `0x${string}`;
  status: PlanStatus;
  steps: StepRecord[];
  /** Set when the recovery policy asks for reasoning. */
  wake?: { condition: WakeCondition; reason: string } | undefined;
}

export type RecoveryPolicy = "HALT_AND_NOTIFY" | "WAKE_RECOVERY_AGENT" | "FAIL_CLOSED";

/** Orders steps so every dependency runs first; a cycle or unknown dependency is a refusal. */
export function orderSteps(steps: SemanticStep[]): SemanticStep[] | null {
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const out: SemanticStep[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (s: SemanticStep): boolean => {
    if (state.get(s.stepId) === 2) return true;
    if (state.get(s.stepId) === 1) return false;
    state.set(s.stepId, 1);
    for (const d of s.dependsOn) {
      const dep = byId.get(d);
      if (!dep || !visit(dep)) return false;
    }
    state.set(s.stepId, 2);
    out.push(s);
    return true;
  };
  for (const s of steps) if (!visit(s)) return null;
  return out;
}

const STATUS: Record<AmaneOutcome["kind"], StepStatus> = { EXECUTED: "EXECUTED", REJECTED_BY_AMANE: "REJECTED_BY_AMANE", NONCE_CONSUMED: "NONCE_CONSUMED", OPERATIONAL_FAILURE: "OPERATIONAL_FAILURE" };

/**
 * Runs a validated plan step by step (bible §19). Every step is compiled and preflighted before
 * anything is submitted, so an out-of-policy plan moves nothing. A failure after at least one
 * executed step is a partial execution: the plan enters RECOVERY_REQUIRED and the recovery policy
 * decides whether the owner is notified or the recovery specialist is woken. Recovery never gets
 * more authority than the plan had: it goes through the same lease and preflight.
 */
export async function executePlan(steps: SemanticStep[], ctx: CompileContext, executor: ActionExecutor, log: EventLog, o: { agentId: string; recovery: RecoveryPolicy }): Promise<PlanRun> {
  const hash = planHash(steps);
  const base = { agentId: o.agentId, planHash: hash };
  const ordered = orderSteps(steps);
  if (!ordered) {
    log.append({ ...base, type: "PLAN_REFUSED", severity: "WARNING", data: { reason: "cyclic or unknown dependency" } });
    return { planHash: hash, status: "REFUSED", steps: steps.map((step) => ({ step, status: "REFUSED" })) };
  }
  const compiled = ordered.map((s, i) => ({ s, c: compileStep(s, hash, i, ctx, { preflight: true }) }));
  const refused = compiled.filter((x) => !x.c.ok);
  if (refused.length) {
    for (const r of refused) log.append({ ...base, type: "PLAN_REFUSED", severity: "WARNING", chain: r.s.chain, code: (r.c as { code: string }).code, data: { stepId: r.s.stepId, detail: (r.c as { detail: string }).detail } });
    return { planHash: hash, status: "REFUSED", steps: compiled.map((x) => ({ step: x.s, status: x.c.ok ? "SKIPPED" : "REFUSED", code: x.c.ok ? undefined : x.c.code })) };
  }
  log.append({ ...base, type: "PLAN_COMPILED", severity: "INFO", data: { steps: ordered.map((s) => s.stepId) } });

  const records: StepRecord[] = ordered.map((step) => ({ step, status: "PENDING" }));
  for (let i = 0; i < compiled.length; i++) {
    const { s, c } = compiled[i]!;
    const out = await executor.submit((c as { intent: Parameters<ActionExecutor["submit"]>[0] }).intent, s);
    records[i] = { step: s, status: STATUS[out.kind], code: out.kind === "REJECTED_BY_AMANE" ? out.code : undefined, tx: "tx" in out ? (out.tx as string | undefined) : undefined };
    if (out.kind === "EXECUTED") continue;
    for (let j = i + 1; j < records.length; j++) records[j] = { step: records[j]!.step, status: "SKIPPED" };
    const executed = records.filter((r) => r.status === "EXECUTED").length;
    if (executed === 0) return { planHash: hash, status: out.kind === "REJECTED_BY_AMANE" ? "REJECTED" : "FAILED", steps: records };
    const reason = `${executed} of ${records.length} steps executed; ${s.stepId} ended ${out.kind}`;
    log.append({ ...base, type: "RECOVERY_REQUIRED", severity: "WARNING", data: { reason, policy: o.recovery, completed: records.filter((r) => r.status === "EXECUTED").map((r) => r.step.stepId) } });
    if (o.recovery === "WAKE_RECOVERY_AGENT") {
      log.append({ ...base, type: "RECOVERY_STARTED", severity: "NOTICE", data: { reason } });
      return { planHash: hash, status: "RECOVERY_REQUIRED", steps: records, wake: { condition: out.kind === "NONCE_CONSUMED" ? "UNKNOWN_ADAPTER_STATE" : "PARTIAL_EXECUTION", reason } };
    }
    log.append({ ...base, type: "OWNER_NOTIFIED", severity: "WARNING", data: { reason } });
    return { planHash: hash, status: "RECOVERY_REQUIRED", steps: records };
  }
  return { planHash: hash, status: "COMPLETED", steps: records };
}
