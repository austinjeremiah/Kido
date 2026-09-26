import type { ExecutionPlan, PlanState, PlanStep } from "./schema.js";
import { capabilityScopeFor, planHash } from "./hash.js";
import { fenceWriteByChain } from "@contextlock/studio-network";

/**
 * The plan state machine.
 *
 * Two rules carry the weight.
 *
 * A step may not run until its dependencies are actually satisfied — not scheduled, not submitted,
 * CONFIRMED. Across chains the tempting shortcut is to treat "we sent it" as "it arrived", and that
 * shortcut is how a destination action executes against funds that never showed up.
 *
 * A plan is COMPLETED only when every required step is CONFIRMED. Anything else that has moved
 * value is PARTIAL. There is no state that means "failed, so nothing happened", because after a
 * bridge has delivered, something did happen and saying otherwise is a lie the UI would tell on
 * every subsequent screen.
 */

export const PLAN_REASONS = {
  DEPENDENCY_NOT_SATISFIED: "PLAN-DEPENDENCY-NOT-SATISFIED",
  STEP_NOT_AUTHORIZED: "PLAN-STEP-NOT-AUTHORIZED",
  SCOPE_MISMATCH: "PLAN-SCOPE-MISMATCH",
  PLAN_MUTATED: "PLAN-MUTATED-SINCE-AUTHORIZATION",
  UNKNOWN_STEP: "PLAN-UNKNOWN-STEP",
  STEP_NOT_PENDING: "PLAN-STEP-NOT-PENDING",
  TIMED_OUT: "PLAN-STEP-TIMED-OUT",
  HUMAN_APPROVAL_REQUIRED: "PLAN-HUMAN-APPROVAL-REQUIRED",
  DENIED: "PLAN-STEP-DENIED",
  UNKNOWN_VALUE: "PLAN-STEP-VALUE-UNKNOWN",
} as const;
export type PlanReason = (typeof PLAN_REASONS)[keyof typeof PLAN_REASONS];

export class PlanError extends Error {
  constructor(readonly reason: PlanReason, readonly detail: Record<string, unknown> = {}) {
    super(`${reason} ${JSON.stringify(detail)}`);
    this.name = "PlanError";
  }
}

export const stepOf = (plan: ExecutionPlan, stepId: string): PlanStep => {
  const s = plan.steps.find((x) => x.stepId === stepId);
  if (!s) throw new PlanError(PLAN_REASONS.UNKNOWN_STEP, { stepId });
  return s;
};

/** Dependencies are satisfied only by CONFIRMED steps. Submitted is not arrived. */
export function dependenciesSatisfied(plan: ExecutionPlan, stepId: string): { ok: true } | { ok: false; missing: string[] } {
  const step = stepOf(plan, stepId);
  const missing = step.dependencies.filter((d) => {
    const dep = plan.steps.find((x) => x.stepId === d);
    return !dep || dep.status !== "CONFIRMED";
  });
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

export interface StepAuthorization {
  /** Scope string as minted at approval time. */
  capabilityScope: string;
  /** Human approval, where the step's disposition requires one. */
  humanApproved: boolean;
}

/**
 * May this step execute right now?
 *
 * Every refusal names an exact reason. This is the function the whole phase exists to make
 * possible: a plan can be well-formed, approved, and still not authorize this particular step at
 * this particular moment.
 */
export function assertStepExecutable(
  plan: ExecutionPlan,
  stepId: string,
  auth: StepAuthorization,
  nowMs: number,
  startedAtMs: number,
): void {
  const step = stepOf(plan, stepId);

  /*
   * The execution-plan write fence.
   *
   * FIRST, before status, dependencies, timeouts or authorization. A step targeting a production
   * chain is not a step that becomes acceptable once its dependencies are satisfied — it is a step
   * that must never run, and checking it first means no other condition can be the thing that
   * happens to stop it.
   */
  fenceWriteByChain("EXECUTION_PLAN_VALIDATOR", step.chainId);

  if (step.status !== "PENDING" && step.status !== "AUTHORIZED") {
    throw new PlanError(PLAN_REASONS.STEP_NOT_PENDING, { stepId, status: step.status });
  }

  const deps = dependenciesSatisfied(plan, stepId);
  if (!deps.ok) throw new PlanError(PLAN_REASONS.DEPENDENCY_NOT_SATISFIED, { stepId, missing: deps.missing });

  if (nowMs - startedAtMs > step.timeoutMs) {
    throw new PlanError(PLAN_REASONS.TIMED_OUT, { stepId, timeoutMs: step.timeoutMs });
  }

  const req = step.authorizationRequirement;
  if (req.disposition === "DENY") throw new PlanError(PLAN_REASONS.DENIED, { stepId });
  if (req.valueUsdCents === null) {
    // An unknown value is not a small value. It cannot be checked against any limit.
    throw new PlanError(PLAN_REASONS.UNKNOWN_VALUE, { stepId });
  }
  if (req.disposition === "REQUIRES_HUMAN" && !auth.humanApproved) {
    throw new PlanError(PLAN_REASONS.HUMAN_APPROVAL_REQUIRED, { stepId });
  }

  if (!auth.capabilityScope) throw new PlanError(PLAN_REASONS.STEP_NOT_AUTHORIZED, { stepId });

  // The scope is derived from the CURRENT plan. A capability minted for another step, or for this
  // step before the plan changed, will not match — which is the whole mechanism.
  const expected = capabilityScopeFor(plan, stepId);
  if (auth.capabilityScope !== expected) {
    const forAnotherStep = plan.steps.some(
      (s) => s.stepId !== stepId && capabilityScopeFor(plan, s.stepId) === auth.capabilityScope,
    );
    throw new PlanError(forAnotherStep ? PLAN_REASONS.SCOPE_MISMATCH : PLAN_REASONS.PLAN_MUTATED, {
      stepId,
      expected,
      presented: auth.capabilityScope,
      ...(forAnotherStep ? { presentedScopeBelongsToAnotherStepOfThisPlan: true } : { currentPlanHash: planHash(plan) }),
    });
  }
}

/**
 * Derive the plan's state from its steps.
 *
 * Deliberately computed rather than stored: a stored state can drift from what the steps say, and
 * the one thing a user must be able to trust here is that the headline matches the detail.
 */
export function derivePlanState(plan: ExecutionPlan): PlanState {
  const required = plan.completionPolicy.requiredStepIds.map((id) => stepOf(plan, id));
  const all = plan.steps;

  const anyValueMoved = all.some((s) => s.status === "CONFIRMED" && s.expectedEffects.some((e) => e.kind === "TOKEN_OUT" || e.kind === "MESSAGE_DELIVERED"));

  if (required.every((s) => s.status === "CONFIRMED")) return "COMPLETED";

  const failed = all.filter((s) => s.status === "FAILED");
  const timedOut = all.filter((s) => s.status === "TIMED_OUT");

  if (failed.length > 0 || timedOut.length > 0) {
    // The distinction that matters: if value already moved, this is PARTIAL. Reporting it as
    // FAILED would tell the user nothing happened, while their money sits on another chain.
    if (anyValueMoved) return "PARTIAL";
    return timedOut.length > 0 && failed.length === 0 ? "TIMED_OUT" : "STEP_FAILED";
  }

  if (all.some((s) => s.status === "WAITING_EXTERNAL")) return "WAITING_EXTERNAL";
  if (all.some((s) => s.status === "SUBMITTED")) return "STEP_SUBMITTED";
  if (all.some((s) => s.status === "CONFIRMED")) return "STEP_CONFIRMED";
  if (all.every((s) => s.status === "PENDING")) return plan.state === "DRAFT" ? "DRAFT" : "READY";
  return "STEP_PENDING";
}

/** Steps whose dependencies are met and which are still waiting to run. */
export function runnableSteps(plan: ExecutionPlan): PlanStep[] {
  return plan.steps.filter(
    (s) => (s.status === "PENDING" || s.status === "AUTHORIZED") && dependenciesSatisfied(plan, s.stepId).ok,
  );
}
