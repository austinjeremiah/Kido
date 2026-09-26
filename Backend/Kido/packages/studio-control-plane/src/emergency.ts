import { z } from "zod";

/**
 * Emergency Lock.
 *
 * Deterministic orchestration, in a fixed order, with no decision to make. §25.40 states the rule
 * that shapes the whole file:
 *
 *     NO LLM IS IN THE KILL PATH.
 *
 * Not "we do not currently call one". This module imports nothing that can reach a model gateway,
 * takes no planner, accepts no strategy, and the step order is a frozen array rather than something
 * computed. LIVE-038 runs the whole thing with the Model Gateway hard down and asserts the policy
 * disable still goes first; a mutation that inserts a model call before step 1 fails it.
 *
 * The second property is honest partial completion. §25.38: if step 1 succeeds and step 3 fails,
 * that is `EMERGENCY_LOCK_PARTIAL` with `financialPolicy: DISABLED` and `cre: PAUSE_FAILED` — not a
 * failure, because the thing that mattered worked. Retrying must not hide the prior success, so
 * each step's outcome is persisted and a retry skips what already succeeded.
 */

/**
 * The order. Frozen, and security-first.
 *
 * Step 1 is the only step that stops money moving. Everything after it is cleanup, and every one of
 * them can fail without changing whether the treasury is safe. That is why the ordering is not
 * configurable and not derived: any arrangement where policy disable is not first is an arrangement
 * where an operator's first action during an incident is something that does not help.
 */
export const EMERGENCY_STEPS = [
  "DISABLE_POLICY",
  "DENY_NEW_CAPABILITIES",
  "PAUSE_CRE",
  "STOP_RUNTIME",
  "REVOKE_IDENTITY",
] as const;
export type EmergencyStep = (typeof EMERGENCY_STEPS)[number];

/** The one step whose failure means the emergency lock did not achieve its purpose. */
export const CRITICAL_STEP: EmergencyStep = "DISABLE_POLICY";

/** Optional by default: revoking identity is disruptive and not always what an incident calls for. */
export const OPTIONAL_STEPS: ReadonlySet<EmergencyStep> = new Set<EmergencyStep>(["REVOKE_IDENTITY"]);

export const StepOutcomeSchema = z.enum(["PENDING", "SUCCEEDED", "FAILED", "SKIPPED", "NOT_APPLICABLE"]);
export type StepOutcome = z.infer<typeof StepOutcomeSchema>;

export const EmergencyStepStateSchema = z.object({
  step: z.enum(EMERGENCY_STEPS),
  outcome: StepOutcomeSchema,
  attemptedAtMs: z.number().int().positive().nullable(),
  completedAtMs: z.number().int().positive().nullable(),
  detail: z.string().nullable(),
  /** How we know it worked. For DISABLE_POLICY this is a fresh chain read, never a receipt. */
  verification: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
});
export type EmergencyStepState = z.infer<typeof EmergencyStepStateSchema>;

export const EMERGENCY_STATES = ["NOT_STARTED", "IN_PROGRESS", "COMPLETE", "PARTIAL", "FAILED"] as const;
export const EmergencyStateSchema = z.enum(EMERGENCY_STATES);
export type EmergencyState = z.infer<typeof EmergencyStateSchema>;

export const EmergencyLockRecordSchema = z.object({
  lockId: z.string().min(1),
  deploymentId: z.string().min(1),
  idempotencyKey: z.string().min(8),
  initiatedBy: z.string().min(1),
  initiatedAtMs: z.number().int().positive(),
  state: EmergencyStateSchema,
  steps: z.array(EmergencyStepStateSchema),
  includeIdentityRevocation: z.boolean(),
  /** The headline an operator needs: is the money safe? */
  financialPolicyDisabled: z.boolean(),
  completedAtMs: z.number().int().positive().nullable(),
});
export type EmergencyLockRecord = z.infer<typeof EmergencyLockRecordSchema>;

/**
 * What each step needs the world to do.
 *
 * Every one returns a verification string rather than a boolean. "It worked" is not good enough for
 * the step that withdraws financial authority: `disablePolicy` must come back having READ the chain,
 * and what it read is recorded.
 */
export interface EmergencyActions {
  /** Must verify from a fresh chain read. Returning without reading is the one unacceptable shortcut. */
  disablePolicy(): Promise<{ ok: boolean; verification: string; detail: string }>;
  denyNewCapabilities(): Promise<{ ok: boolean; verification: string; detail: string }>;
  pauseCre(): Promise<{ ok: boolean; verification: string; detail: string }>;
  stopRuntime(): Promise<{ ok: boolean; verification: string; detail: string }>;
  revokeIdentity(): Promise<{ ok: boolean; verification: string; detail: string }>;
  nowMs(): number;
  /** Emitted per step so an operator watches it happen rather than waiting for a final answer. */
  onStep?(state: EmergencyStepState, record: EmergencyLockRecord): void;
}

/**
 * Steps that do not apply to this deployment.
 *
 * A deployment with no CRE workflow cannot pause one, and reporting that as a FAILURE would turn
 * every emergency lock on this deployment into a PARTIAL — which would train operators to ignore
 * the word.
 */
export interface EmergencyApplicability {
  creWorkflowExists: boolean;
  runtimeExists: boolean;
  identityExists: boolean;
}

const freshSteps = (includeIdentity: boolean, app: EmergencyApplicability): EmergencyStepState[] =>
  EMERGENCY_STEPS.map((step) => {
    const notApplicable =
      (step === "PAUSE_CRE" && !app.creWorkflowExists) ||
      (step === "STOP_RUNTIME" && !app.runtimeExists) ||
      (step === "REVOKE_IDENTITY" && (!includeIdentity || !app.identityExists));
    return {
      step,
      outcome: notApplicable ? ("NOT_APPLICABLE" as const) : ("PENDING" as const),
      attemptedAtMs: null, completedAtMs: null,
      detail: notApplicable ? (step === "REVOKE_IDENTITY" && !includeIdentity ? "not requested" : "no such component in this deployment") : null,
      verification: null, attempts: 0,
    };
  });

export function newEmergencyLock(args: { lockId: string; deploymentId: string; idempotencyKey: string; initiatedBy: string; nowMs: number; includeIdentityRevocation: boolean; applicability: EmergencyApplicability }): EmergencyLockRecord {
  return {
    lockId: args.lockId,
    deploymentId: args.deploymentId,
    idempotencyKey: args.idempotencyKey,
    initiatedBy: args.initiatedBy,
    initiatedAtMs: args.nowMs,
    state: "NOT_STARTED",
    steps: freshSteps(args.includeIdentityRevocation, args.applicability),
    includeIdentityRevocation: args.includeIdentityRevocation,
    financialPolicyDisabled: false,
    completedAtMs: null,
  };
}

/**
 * Run the lock.
 *
 * Safe to call repeatedly on the same record: steps that already SUCCEEDED are not retried, so a
 * second operator pressing the button while the first is mid-flight cannot undo anything or
 * double-execute the identity revocation.
 *
 * There is deliberately no early return on failure. If `DISABLE_POLICY` fails we still attempt to
 * pause CRE and stop the runtime — they are weaker controls, but weaker is better than none, and an
 * incident where the strongest control is unavailable is exactly when the others matter.
 */
export async function runEmergencyLock(record: EmergencyLockRecord, actions: EmergencyActions): Promise<EmergencyLockRecord> {
  const r: EmergencyLockRecord = { ...record, steps: record.steps.map((s) => ({ ...s })), state: "IN_PROGRESS" };

  const runners: Record<EmergencyStep, () => Promise<{ ok: boolean; verification: string; detail: string }>> = {
    DISABLE_POLICY: () => actions.disablePolicy(),
    DENY_NEW_CAPABILITIES: () => actions.denyNewCapabilities(),
    PAUSE_CRE: () => actions.pauseCre(),
    STOP_RUNTIME: () => actions.stopRuntime(),
    REVOKE_IDENTITY: () => actions.revokeIdentity(),
  };

  // A plain `for` over the frozen array. No sorting, no planning, no branching on anything a model
  // could influence — the order is the order.
  for (const step of EMERGENCY_STEPS) {
    const s = r.steps.find((x) => x.step === step)!;
    if (s.outcome === "SUCCEEDED" || s.outcome === "NOT_APPLICABLE" || s.outcome === "SKIPPED") continue;

    s.attemptedAtMs = actions.nowMs();
    s.attempts += 1;
    try {
      const out = await runners[step]();
      s.outcome = out.ok ? "SUCCEEDED" : "FAILED";
      s.detail = out.detail;
      s.verification = out.verification;
      s.completedAtMs = actions.nowMs();
      if (step === CRITICAL_STEP && out.ok) r.financialPolicyDisabled = true;
    } catch (e) {
      s.outcome = "FAILED";
      s.detail = (e as Error).message;
      s.completedAtMs = actions.nowMs();
    }
    actions.onStep?.({ ...s }, r);
  }

  const relevant = r.steps.filter((s) => s.outcome !== "NOT_APPLICABLE");
  const failed = relevant.filter((s) => s.outcome === "FAILED");
  const critical = r.steps.find((s) => s.step === CRITICAL_STEP)!;

  r.state =
    critical.outcome === "FAILED" ? "FAILED"
    : failed.length > 0 ? "PARTIAL"
    : "COMPLETE";
  r.completedAtMs = actions.nowMs();
  return r;
}

/**
 * The sentence an operator reads afterwards.
 *
 * The headline is always about the money, whatever else happened, because that is the only question
 * being asked at that moment.
 */
export function emergencySummary(r: EmergencyLockRecord): { headline: string; financialPolicy: string; lines: string[] } {
  const lines = r.steps.map((s) => {
    const label = s.step.replace(/_/g, " ").toLowerCase();
    switch (s.outcome) {
      case "SUCCEEDED": return `${label}: done${s.verification ? ` (${s.verification})` : ""}`;
      case "FAILED": return `${label}: FAILED — ${s.detail ?? "no detail"}`;
      case "NOT_APPLICABLE": return `${label}: not applicable — ${s.detail ?? ""}`;
      case "SKIPPED": return `${label}: skipped`;
      default: return `${label}: not attempted`;
    }
  });

  const financialPolicy = r.financialPolicyDisabled ? "DISABLED" : "NOT CONFIRMED DISABLED";
  const headline =
    r.state === "COMPLETE" ? "Emergency lock complete. Financial policy is disabled."
    : r.state === "PARTIAL" ? "Emergency lock PARTIAL. The financial policy is disabled; one or more operational steps failed."
    : "Emergency lock FAILED to disable the financial policy. This agent may still be able to move value.";

  return { headline, financialPolicy, lines };
}

/**
 * Modules the emergency path may not import.
 *
 * Named so `LIVE-038`'s companion check can assert their absence from this file's dependency graph
 * rather than trusting a comment. A model call inserted before step 1 is the mutation this exists
 * to catch.
 */
export const FORBIDDEN_IN_KILL_PATH = [
  "@contextlock/studio-runtime/gateways",
  "openai",
  "@openai/agents",
  "ModelGateway",
  "luna",
] as const;
