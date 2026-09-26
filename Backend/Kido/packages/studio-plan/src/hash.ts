import { keccak256, toHex } from "viem";
import type { ExecutionPlan, PlanStep } from "./schema.js";

/**
 * Canonical plan hashing.
 *
 * The property being bought: an approval is an approval of a SPECIFIC plan, and any change to what
 * would execute produces a different hash and therefore invalidates it. Approving "move $500 to
 * Base Sepolia" must not silently become authority for "move $500 to somewhere else".
 *
 * So the hash covers everything that determines what happens, and deliberately excludes everything
 * that does not — status fields move as a plan executes and must not change its identity, or the
 * act of running the plan would invalidate its own approval.
 */

/** Deterministic serialization: keys sorted at every level, no whitespace, bigints rejected. */
export function canonicalize(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "bigint") {
      // A bigint would serialize differently across runtimes. Chain selectors are strings for
      // exactly this reason; anything else reaching here is a bug worth failing on.
      throw new Error("PLAN-HASH-BIGINT: encode large integers as decimal strings before hashing");
    }
    if (v === undefined) return null;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = walk(o[k]);
      return out;
    }
    throw new Error(`PLAN-HASH-UNSERIALIZABLE: ${typeof v}`);
  };
  return JSON.stringify(walk(value));
}

/**
 * Fields excluded from a step's identity.
 *
 * `status` is execution progress, not intent. If it were hashed, submitting step 1 would change the
 * plan hash and invalidate the approval for step 2 — the plan would destroy its own authorization
 * by running.
 *
 * `authorizationRequirement.capabilityScope` is excluded for the same reason and a sharper one: the
 * scope is DERIVED from the hash, so including it would be circular.
 */
function stepIdentity(step: PlanStep) {
  const { status: _status, authorizationRequirement, ...rest } = step;
  const { capabilityScope: _scope, ...auth } = authorizationRequirement;
  return { ...rest, authorizationRequirement: auth };
}

function planIdentity(plan: ExecutionPlan) {
  const { state: _state, steps, ...rest } = plan;
  return { ...rest, steps: steps.map(stepIdentity) };
}

export function planHash(plan: ExecutionPlan): `0x${string}` {
  return keccak256(toHex(canonicalize(planIdentity(plan))));
}

/**
 * A step's hash binds it to its plan.
 *
 * `planHash` is an input, so the same step in a different plan hashes differently. That is what
 * makes a step capability non-portable: it is scoped to one step of one plan, and lifting it into
 * another plan produces a scope that matches nothing.
 */
export function stepHash(plan: ExecutionPlan, stepId: string): `0x${string}` {
  const step = plan.steps.find((s) => s.stepId === stepId);
  if (!step) throw new Error(`PLAN-HASH-NO-STEP: ${stepId}`);
  return keccak256(
    toHex(canonicalize({ planHash: planHash(plan), stepId, step: stepIdentity(step) })),
  );
}

/**
 * The capability scope string.
 *
 * Human-readable on purpose: it appears in approval UI and in logs, and a scope nobody can read is
 * a scope nobody checks.
 */
export function capabilityScopeFor(plan: ExecutionPlan, stepId: string): string {
  const step = plan.steps.find((s) => s.stepId === stepId);
  if (!step) throw new Error(`PLAN-HASH-NO-STEP: ${stepId}`);
  return `contextlock:plan:${planHash(plan)}:step:${stepId}:chain:${step.chainId}:hash:${stepHash(plan, stepId)}`;
}
