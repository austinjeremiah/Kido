import { z } from "zod";

export const EXECUTION_PLAN_VERSION = "contextlock.execution-plan/v1" as const;

/**
 * The Execution Plan.
 *
 * A plan is a sequence of financial actions that execute at different times, on different chains,
 * and can fail independently. The single most important thing this type does is REFUSE to pretend
 * otherwise: there is no field anywhere that expresses "roll back", because across chains there is
 * nothing to roll back to. A bridge that has delivered has delivered.
 *
 * The second most important thing: a plan is not authority. It is a description of intended work.
 * Every financial step still needs its own ContextLock capability, scoped to that step, and holding
 * one confers nothing about any other.
 */

const id = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/, "lowercase kebab id");

/** uint64 CCIP-style chain selector. A string because it does not fit in a JS number. */
const chainSelector = z.string().regex(/^\d+$/, "decimal uint64 as a string");

export const PlanStepStatusSchema = z.enum([
  "PENDING",
  "AUTHORIZED",
  "SUBMITTED",
  "CONFIRMED",
  "WAITING_EXTERNAL",
  "FAILED",
  "TIMED_OUT",
  "SKIPPED",
]);
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;

/**
 * What a step is expected to change.
 *
 * Declared BEFORE execution so that "did this do what we authorized?" is a comparison rather than a
 * judgement call made afterwards by whatever code happens to observe the result.
 */
export const ExpectedEffectSchema = z.object({
  kind: z.enum(["TOKEN_OUT", "TOKEN_IN", "MESSAGE_SENT", "MESSAGE_DELIVERED", "APPROVAL_SET"]),
  chainId: z.number().int().positive(),
  token: z.string().optional(),
  /** Integer base units. Never a float, never a display string. */
  amount: z.string().regex(/^\d+$/).optional(),
  party: z.string().optional(),
});
export type ExpectedEffect = z.infer<typeof ExpectedEffectSchema>;

export const PreconditionSchema = z.object({
  kind: z.enum(["STEP_CONFIRMED", "ARRIVAL_PROVEN", "BALANCE_AT_LEAST", "TIME_AFTER"]),
  stepId: z.string().optional(),
  token: z.string().optional(),
  amount: z.string().regex(/^\d+$/).optional(),
  unixSeconds: z.number().int().optional(),
});

/**
 * How a step is authorized.
 *
 * `capabilityScope` is the load-bearing field. It binds a capability to exactly one step of exactly
 * one plan, so a capability minted for step 1 is not a capability for step 2 — see P19.3. There is
 * deliberately no "plan-wide" variant.
 */
export const AuthorizationRequirementSchema = z.object({
  /** Verdict this step needs before it may run. */
  disposition: z.enum(["AUTONOMOUS", "REQUIRES_HUMAN", "DENY"]),
  /** USD cents this step is expected to move. Null is UNKNOWN and blocks, never "unlimited". */
  valueUsdCents: z.number().int().nonnegative().nullable(),
  /** Filled once a capability exists. Bound to planHash+stepId; see hash.ts. */
  capabilityScope: z.string().nullable(),
});

export const PlanStepSchema = z.object({
  stepId: id,
  chainId: z.number().int().positive(),
  adapterId: z.string().min(1),
  adapterVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "exact version, never a range"),
  action: z.string().min(1),
  /**
   * The adapter's own normalized intent. Opaque to the plan layer on purpose: the plan does not
   * re-interpret what an adapter means, it only sequences and authorizes.
   */
  normalizedIntent: z.record(z.string(), z.unknown()),
  dependencies: z.array(z.string()),
  preconditions: z.array(PreconditionSchema),
  expectedEffects: z.array(ExpectedEffectSchema),
  /** Milliseconds this step may remain unresolved before it is TIMED_OUT. */
  timeoutMs: z.number().int().positive(),
  authorizationRequirement: AuthorizationRequirementSchema,
  status: PlanStepStatusSchema,
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

/**
 * What to do when a step fails after an earlier step already moved value.
 *
 * `ROLLBACK` is not a member, and that is the point. Across chains the only honest options are to
 * hold, to retry the exact same destination action, to escalate to a person, or to invoke a refund
 * the protocol genuinely provides. Inventing a fifth would be inventing a guarantee.
 */
export const FailurePolicySchema = z.object({
  onStepFailure: z.enum(["HOLD_AND_ESCALATE", "RETRY_SAME_STEP", "ABORT_REMAINING"]),
  maxRetries: z.number().int().min(0).max(5),
  /** Only settable when the protocol actually exposes a refund; see CCIP_ADAPTER.md. */
  protocolRefundAvailable: z.boolean(),
});

export const PlanStateSchema = z.enum([
  "DRAFT",
  "VALIDATED",
  "AWAITING_AUTHORIZATION",
  "READY",
  "STEP_PENDING",
  "STEP_SUBMITTED",
  "STEP_CONFIRMED",
  "WAITING_EXTERNAL",
  "STEP_FAILED",
  "TIMED_OUT",
  "PARTIAL",
  "COMPLETED",
  "ABORTED",
]);
export type PlanState = z.infer<typeof PlanStateSchema>;

export const ExecutionPlanSchema = z.object({
  schemaVersion: z.literal(EXECUTION_PLAN_VERSION),
  planId: z.string().min(1),
  revision: z.number().int().positive(),
  strategyId: z.string().min(1),
  organizationId: z.string().nullable(),
  sourceChainId: z.number().int().positive(),
  steps: z.array(PlanStepSchema).min(1),
  invariants: z.array(z.object({ id: z.string(), statement: z.string() })),
  timeoutPolicy: z.object({
    totalMs: z.number().int().positive(),
    perStepDefaultMs: z.number().int().positive(),
  }),
  failurePolicy: FailurePolicySchema,
  /** A plan is COMPLETED only when every required step has satisfied its completion criteria. */
  completionPolicy: z.object({
    requiredStepIds: z.array(z.string()).min(1),
  }),
  state: PlanStateSchema,
});
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

export const ChainSelectorSchema = chainSelector;
