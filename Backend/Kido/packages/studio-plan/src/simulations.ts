import type { ExecutionPlan } from "./schema.js";
import { ARRIVAL_REASONS } from "./arrival.js";
import { PLAN_REASONS } from "./machine.js";

/**
 * Cross-chain scenarios.
 *
 * Every blocked scenario names the exact code it expects. The reason this matters more here than
 * anywhere else: cross-chain failures all look alike from the outside — nothing arrived — and a
 * test that only asserts "nothing arrived" passes whether the system refused a hostile message or
 * simply lost a good one.
 */

export interface PlanScenario {
  id: string;
  title: string;
  probes: string;
  expected: { outcome: "PERMITTED" | "BLOCKED" | "PARTIAL"; reasonCode: string | null };
}

export function generatePlanScenarios(plan: ExecutionPlan): PlanScenario[] {
  const crossChain = plan.steps.filter((s) => s.chainId !== plan.sourceChainId);
  const out: PlanScenario[] = [
    {
      id: "XCHAIN-NORMAL",
      title: "The plan executes in order across both chains",
      probes: "The permitted path still works; the controls have not simply disabled cross-chain execution.",
      expected: { outcome: "PERMITTED", reasonCode: null },
    },
    {
      id: "XCHAIN-WRONG-DESTINATION",
      title: "The message is delivered to a chain the plan did not name",
      probes: "Destination is compared against the plan, not against what the message says about itself.",
      expected: { outcome: "BLOCKED", reasonCode: ARRIVAL_REASONS.WRONG_DESTINATION },
    },
    {
      id: "XCHAIN-WRONG-RECEIVER",
      title: "The message arrives for a different receiver",
      probes: "A receiver substitution is caught even when every other field is correct.",
      expected: { outcome: "BLOCKED", reasonCode: ARRIVAL_REASONS.WRONG_RECEIVER },
    },
    {
      id: "XCHAIN-WRONG-SENDER",
      title: "A message from an unexpected source sender",
      probes: "Anyone can get a message delivered; only the planned sender's message counts.",
      expected: { outcome: "BLOCKED", reasonCode: ARRIVAL_REASONS.WRONG_SENDER },
    },
    {
      id: "XCHAIN-AMOUNT-MUTATION",
      title: "The arriving amount differs from the amount the plan authorized",
      probes: "The destination action is authorized for an amount, not for an event.",
      expected: { outcome: "BLOCKED", reasonCode: ARRIVAL_REASONS.AMOUNT_MISMATCH },
    },
    {
      id: "XCHAIN-TOKEN-MISMATCH",
      title: "A different token arrives under the same message",
      probes: "Token identity is part of what was authorized.",
      expected: { outcome: "BLOCKED", reasonCode: ARRIVAL_REASONS.TOKEN_MISMATCH },
    },
    {
      id: "XCHAIN-DUPLICATE-MESSAGE",
      title: "The same message is observed twice",
      probes: "One cross-chain message must not fund two destination executions.",
      expected: { outcome: "BLOCKED", reasonCode: ARRIVAL_REASONS.DUPLICATE },
    },
    {
      id: "XCHAIN-OUT-OF-ORDER",
      title: "The destination step is attempted before the source step confirms",
      probes: "Submitted is not arrived. Dependencies are satisfied only by CONFIRMED steps.",
      expected: { outcome: "BLOCKED", reasonCode: PLAN_REASONS.DEPENDENCY_NOT_SATISFIED },
    },
    {
      id: "XCHAIN-SOURCE-REORG-LIKE-UNCERTAINTY",
      title: "The source step is submitted but never confirms",
      probes: "An unconfirmed source leaves the destination unauthorized rather than assumed.",
      expected: { outcome: "BLOCKED", reasonCode: PLAN_REASONS.DEPENDENCY_NOT_SATISFIED },
    },
    {
      id: "XCHAIN-DESTINATION-RPC-FAILURE",
      title: "The destination chain cannot be observed",
      probes: "Inability to see an arrival is not evidence of one.",
      expected: { outcome: "BLOCKED", reasonCode: PLAN_REASONS.DEPENDENCY_NOT_SATISFIED },
    },
    {
      id: "XCHAIN-TIMEOUT",
      title: "The step exceeds its stated timeout",
      probes: "A step that has run out of time cannot be executed late on the original authorization.",
      expected: { outcome: "BLOCKED", reasonCode: PLAN_REASONS.TIMED_OUT },
    },
    {
      id: "XCHAIN-STEP2-FAILS",
      title: "The source step succeeds and the destination step fails",
      probes: "The honest state is PARTIAL. Value moved; there is no rollback to report.",
      expected: { outcome: "PARTIAL", reasonCode: null },
    },
    {
      id: "XCHAIN-PLAN-MUTATION",
      title: "The plan is edited after authorization",
      probes: "Any change to what would execute derives a new hash and invalidates the old approval.",
      expected: { outcome: "BLOCKED", reasonCode: PLAN_REASONS.PLAN_MUTATED },
    },
    {
      id: "XCHAIN-OLD-PLAN-REPLAY",
      title: "A capability from a superseded plan revision is presented",
      probes: "A scope minted against an earlier plan matches nothing in the current one.",
      expected: { outcome: "BLOCKED", reasonCode: PLAN_REASONS.PLAN_MUTATED },
    },
    {
      id: "XCHAIN-STEP-CAPABILITY-REUSE",
      title: "The capability for step 1 is presented for step 2",
      probes: "A step capability is scoped to one step; it is not a plan-wide grant.",
      expected: { outcome: "BLOCKED", reasonCode: PLAN_REASONS.SCOPE_MISMATCH },
    },
    {
      id: "XCHAIN-ESCALATE-MIDPLAN",
      title: "Step 1 is autonomous and step 2 needs a person",
      probes: "Approving the plan's start is not approving its escalating step.",
      expected: { outcome: "BLOCKED", reasonCode: PLAN_REASONS.HUMAN_APPROVAL_REQUIRED },
    },
  ];

  if (crossChain.length === 0) {
    return out.filter((s) => !s.id.startsWith("XCHAIN-") || s.id === "XCHAIN-PLAN-MUTATION" || s.id === "XCHAIN-STEP-CAPABILITY-REUSE");
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
