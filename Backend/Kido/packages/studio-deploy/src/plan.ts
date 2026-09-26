import { z } from "zod";
import { digestOf } from "./hash.js";

/**
 * The DeploymentPlan.
 *
 * An ordered list of steps, each of which names its own actor, its own artifact, its own cost and —
 * the field that matters most — whether it can be undone.
 *
 * `reversible` is not documentation. A plan whose irreversible steps run before its verification
 * steps is a plan that discovers problems after they cost something, so the planner orders by
 * dependency and the orchestrator refuses to run a step whose dependencies have not been
 * INDEPENDENTLY verified. "The previous HTTP call returned 200" is not verification.
 */

export const DEPLOYMENT_PLAN_VERSION = "contextlock.deployment-plan/v1" as const;

/**
 * The step vocabulary.
 *
 * Closed. A plan cannot contain a step type the orchestrator has no handler for, which is the same
 * discipline the bridge applies to its operation list: an open vocabulary means the executor has to
 * decide what to do with something it has never seen, and the safe answer to that is always
 * "nothing", so it may as well be unrepresentable.
 */
export const DeploymentStepTypeSchema = z.enum([
  "VERIFY_CHAIN",
  "VERIFY_CORE",
  "DEPLOY_CONTRACT",
  "CONFIGURE_CONTRACT",
  "REGISTER_POLICY_DISABLED",
  "REGISTER_ENS_IDENTITY",
  "BUILD_CRE_WASM",
  "VERIFY_CRE_HASH",
  "CHECK_CRE_ACCESS",
  "DEPLOY_CRE_PRIVATE",
  "PAUSE_CRE",
  "BUILD_RUNTIME_IMAGE",
  "SCAN_RUNTIME_IMAGE",
  "PUBLISH_RUNTIME_IMAGE",
  "CREATE_RUNTIME_DISABLED",
  "POST_DEPLOY_VERIFY",
  "ACTIVATE",
]);
export type DeploymentStepType = z.infer<typeof DeploymentStepTypeSchema>;

/** Who performs a step. Determines whether a human, a key or a service is the blocking resource. */
export const ActorTypeSchema = z.enum([
  /** A wallet the user controls. The Studio server never holds the key. */
  "USER_WALLET",
  /** The user's own machine, via the Local Bridge. Where `cre` and any hardware live. */
  "LOCAL_BRIDGE",
  /** A trusted ContextLock service. Never holds a wallet key. */
  "CONTROL_PLANE",
  /** A read against a public RPC or registry. No authority required. */
  "READ_ONLY",
]);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const DeploymentStepStatusSchema = z.enum([
  "PENDING",
  "READY",
  "SUBMITTED",
  /** Sent, and we do not know what happened. See receipts.ts — this is NOT a retryable state. */
  "UNKNOWN_SUBMISSION_STATE",
  "CONFIRMED",
  "VERIFIED",
  "FAILED",
  "SKIPPED_ALREADY_SATISFIED",
]);
export type DeploymentStepStatus = z.infer<typeof DeploymentStepStatusSchema>;

/**
 * A cost estimate for one step.
 *
 * `estimatedGas` is what the node said; `bufferBps` is what we add because it may be wrong. They
 * are separate fields and separately displayed — a single padded number would let a 20% buffer
 * masquerade as precision (§22.5, DEP-PRE-010).
 */
export const StepCostSchema = z.object({
  /** Decimal string. eth_estimateGas result, unpadded. */
  estimatedGas: z.string().regex(/^\d+$/),
  feeMode: z.enum(["EIP1559", "LEGACY"]),
  maxFeePerGasWei: z.string().regex(/^\d+$/),
  maxPriorityFeePerGasWei: z.string().regex(/^\d+$/).nullable(),
  /** estimatedGas * maxFeePerGas. The unbuffered number. */
  baseNativeWei: z.string().regex(/^\d+$/),
  bufferBps: z.number().int().min(0).max(10_000),
  bufferNativeWei: z.string().regex(/^\d+$/),
  totalNativeWei: z.string().regex(/^\d+$/),
  /**
   * When the fee data was read.
   *
   * Gas prices move. An estimate carries its own age so the approval screen can refuse to be
   * approved against stale numbers rather than showing a figure from twenty minutes ago as current
   * (DEP-PRE-024).
   */
  quotedAtMs: z.number().int().positive(),
  /** True when the estimate came from a real node. False means a fixture, and it is displayed. */
  fromLiveNode: z.boolean(),
});
export type StepCost = z.infer<typeof StepCostSchema>;

export const DeploymentStepSchema = z.object({
  /**
   * Stable across replans.
   *
   * Derived from what the step DOES, not from its position, so inserting a step earlier in a plan
   * does not renumber the steps after it — which would make a partially-executed deployment
   * unresumable exactly when resuming matters.
   */
  id: z.string().regex(/^[a-z][a-z0-9-]{2,79}$/),
  type: DeploymentStepTypeSchema,
  chainId: z.number().int().positive().nullable(),
  dependencyIds: z.array(z.string()),

  actorType: ActorTypeSchema,
  /** References a SignerRequirement.signerId. Null for steps needing no authority. */
  requiredSigner: z.string().nullable(),

  /** The content hash of whatever this step deploys or publishes. */
  artifactHash: z.string().nullable(),
  /** Address or name being acted on. */
  target: z.string().nullable(),
  /** sha256 of the exact calldata. Signing something else is then detectable, not merely unlikely. */
  calldataHash: z.string().nullable(),

  cost: StepCostSchema.nullable(),

  /**
   * Can this be undone?
   *
   * `false` for every contract creation, because it cannot. The honest consequence is not a
   * rollback feature; it is that the plan states plainly which steps are one-way, and the recovery
   * document for a partial deployment says what exists rather than pretending it can be removed.
   */
  reversible: z.boolean(),
  rollbackAction: z.string().nullable(),

  status: DeploymentStepStatusSchema,
});
export type DeploymentStep = z.infer<typeof DeploymentStepSchema>;

export const DEPLOYMENT_READINESS = [
  "PREFLIGHT_DRAFT",
  "PREFLIGHT_RUNNING",
  "PREFLIGHT_BLOCKED",
  "PREFLIGHT_READY",
  "DEPLOYMENT_APPROVED",
] as const;
export const ReadinessSchema = z.enum(DEPLOYMENT_READINESS);
export type Readiness = z.infer<typeof ReadinessSchema>;

export const DeploymentPlanSchema = z.object({
  schemaVersion: z.literal(DEPLOYMENT_PLAN_VERSION),
  planId: z.string().min(1),
  /** The manifest this plan executes. Bound by hash so the two cannot drift apart. */
  manifestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  steps: z.array(DeploymentStepSchema).min(1),
  readiness: ReadinessSchema,
  /** Populated only at DEPLOYMENT_APPROVED. See approval.ts. */
  approval: z
    .object({
      approvedBy: z.string().min(1),
      approvedAtMs: z.number().int().positive(),
      /** The exact manifest and plan hashes the human saw. */
      manifestHash: z.string(),
      planHash: z.string(),
      /** Every artifact hash shown on the approval screen, so drift is detectable per artifact. */
      artifactHashes: z.record(z.string(), z.string()),
    })
    .nullable(),
});
export type DeploymentPlan = z.infer<typeof DeploymentPlanSchema>;

export const PLAN_REASONS = {
  UNKNOWN_DEPENDENCY: "PLAN-UNKNOWN-DEPENDENCY",
  CYCLE: "PLAN-DEPENDENCY-CYCLE",
  DUPLICATE_STEP_ID: "PLAN-DUPLICATE-STEP-ID",
  SELF_DEPENDENCY: "PLAN-SELF-DEPENDENCY",
  FORWARD_DEPENDENCY: "PLAN-FORWARD-DEPENDENCY",
  UNKNOWN_SIGNER: "PLAN-UNKNOWN-SIGNER",
  MISSING_SIGNER: "PLAN-MISSING-SIGNER",
  ACTIVATE_IN_DEPLOYMENT_PLAN: "PLAN-ACTIVATE-IS-NOT-DEPLOYMENT",
  MISSING_COST: "PLAN-MISSING-COST",
  DEPENDENCY_NOT_VERIFIED: "PLAN-DEPENDENCY-NOT-VERIFIED",
} as const;
export type PlanReason = (typeof PLAN_REASONS)[keyof typeof PLAN_REASONS];

export class DeploymentPlanError extends Error {
  constructor(readonly reason: PlanReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "DeploymentPlanError";
  }
}

/** Step types that write onchain and therefore need gas estimated before approval. */
export const WRITING_STEP_TYPES: ReadonlySet<DeploymentStepType> = new Set<DeploymentStepType>([
  "DEPLOY_CONTRACT",
  "CONFIGURE_CONTRACT",
  "REGISTER_POLICY_DISABLED",
  "REGISTER_ENS_IDENTITY",
]);

/** Step types that cannot be undone once they succeed. */
export const IRREVERSIBLE_STEP_TYPES: ReadonlySet<DeploymentStepType> = new Set<DeploymentStepType>([
  "DEPLOY_CONTRACT",
  "REGISTER_ENS_IDENTITY",
  "PUBLISH_RUNTIME_IMAGE",
  "DEPLOY_CRE_PRIVATE",
]);

/**
 * Validate a plan's shape before anyone is asked to approve it.
 *
 * Every check here is a way a plan could be internally inconsistent in a manner the orchestrator
 * would only discover halfway through — which, for a sequence containing irreversible steps, is the
 * worst time to discover anything.
 */
export function validatePlan(plan: DeploymentPlan, knownSignerIds: ReadonlySet<string>): void {
  const seen = new Set<string>();
  const index = new Map<string, number>();
  plan.steps.forEach((s, i) => {
    if (seen.has(s.id)) throw new DeploymentPlanError(PLAN_REASONS.DUPLICATE_STEP_ID, s.id);
    seen.add(s.id);
    index.set(s.id, i);
  });

  for (const s of plan.steps) {
    if (s.type === "ACTIVATE") {
      // Activation is a separate, explicit, post-verification operation with its own ceremony
      // (§23.13). Allowing it as the tail of a deployment plan would make "deploy" and "turn on"
      // one button, which is precisely the conflation this phase exists to prevent.
      throw new DeploymentPlanError(
        PLAN_REASONS.ACTIVATE_IN_DEPLOYMENT_PLAN,
        `step "${s.id}": activation is not part of a deployment plan; it is a separate ceremony after verification`,
      );
    }
    for (const d of s.dependencyIds) {
      if (d === s.id) throw new DeploymentPlanError(PLAN_REASONS.SELF_DEPENDENCY, s.id);
      if (!seen.has(d)) throw new DeploymentPlanError(PLAN_REASONS.UNKNOWN_DEPENDENCY, `${s.id} -> ${d}`);
      const di = index.get(d)!;
      const si = index.get(s.id)!;
      // The array order IS the execution order, so a dependency listed later is unsatisfiable.
      // Catching it here rather than at run time means the plan is never half-executed first.
      if (di >= si) {
        throw new DeploymentPlanError(
          PLAN_REASONS.FORWARD_DEPENDENCY,
          `${s.id} (position ${si}) depends on ${d} (position ${di}), which runs later or is itself`,
        );
      }
    }
    if (s.requiredSigner !== null && !knownSignerIds.has(s.requiredSigner)) {
      // DEP-PRE-026: a user cannot approve a requirement naming a signer that does not appear in
      // the manifest, because the approval screen would have nothing to show them about it.
      throw new DeploymentPlanError(
        PLAN_REASONS.UNKNOWN_SIGNER,
        `step "${s.id}" requires signer "${s.requiredSigner}", which the manifest does not describe`,
      );
    }
    if (s.actorType === "USER_WALLET" && s.requiredSigner === null) {
      throw new DeploymentPlanError(
        PLAN_REASONS.MISSING_SIGNER,
        `step "${s.id}" is signed by a user wallet but names no signer`,
      );
    }
    if (IRREVERSIBLE_STEP_TYPES.has(s.type) && s.reversible) {
      throw new DeploymentPlanError(
        PLAN_REASONS.CYCLE,
        `step "${s.id}" is a ${s.type} and cannot be marked reversible`,
      );
    }
  }
}

/** Every write step must carry a cost before the plan may be shown for approval. */
export function assertCosted(plan: DeploymentPlan): void {
  for (const s of plan.steps) {
    if (WRITING_STEP_TYPES.has(s.type) && s.cost === null) {
      throw new DeploymentPlanError(
        PLAN_REASONS.MISSING_COST,
        `step "${s.id}" (${s.type}) writes onchain but has no gas estimate; it cannot be approved`,
      );
    }
  }
}

/**
 * The steps that may run right now.
 *
 * A dependency counts as satisfied only at VERIFIED or SKIPPED_ALREADY_SATISFIED — never at
 * CONFIRMED. The gap between the two is the whole point: a transaction can be mined and still not
 * have produced the state we intended, and the orchestrator finds that out by reading the chain
 * (§23.11), not by reading a receipt status.
 */
export function runnableSteps(plan: DeploymentPlan): DeploymentStep[] {
  const done = new Set(
    plan.steps.filter((s) => s.status === "VERIFIED" || s.status === "SKIPPED_ALREADY_SATISFIED").map((s) => s.id),
  );
  return plan.steps.filter(
    (s) => (s.status === "PENDING" || s.status === "READY") && s.dependencyIds.every((d) => done.has(d)),
  );
}

/** Fields excluded from a plan's identity: execution progress and the approval derived from it. */
function planIdentity(plan: DeploymentPlan) {
  const { readiness: _r, approval: _a, steps, ...rest } = plan;
  return { ...rest, steps: steps.map(({ status: _s, ...step }) => step) };
}

export const deploymentPlanHash = (plan: DeploymentPlan): string => digestOf(planIdentity(plan));
