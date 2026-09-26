import { z } from "zod";

/**
 * The activation ceremony, and its opposite.
 *
 * Two ordered sequences, and the ordering is the security property.
 *
 * ACTIVATION goes outside-in: start the runtime, prove it is healthy, resume the CRE workflow,
 * prove that is healthy, and only then enable the onchain ContextLock policy. Every step before the
 * last one happens while the agent still cannot move money, so a component that comes up wrong is
 * discovered by something that is not a financial loss.
 *
 * DEACTIVATION goes inside-out: disable the policy FIRST, then pause CRE, then stop the runtime,
 * then revoke identity if the incident calls for it. The reason is that during an incident every
 * step takes time and any of them can fail, so the first one has to be the one that actually stops
 * money moving. Stopping the container first would leave the policy enabled while the operator is
 * still typing.
 *
 * The two are exact reverses, which is not a coincidence and is asserted by ACT-004.
 */

export const ACTIVATION_STEPS = [
  "START_RUNTIME",
  "VERIFY_RUNTIME_HEARTBEAT",
  "RESUME_CRE_WORKFLOW",
  "VERIFY_CRE_HEALTH",
  "ENABLE_CONTEXTLOCK_POLICY",
] as const;
export type ActivationStep = (typeof ACTIVATION_STEPS)[number];

export const DEACTIVATION_STEPS = [
  "DISABLE_CONTEXTLOCK_POLICY",
  "PAUSE_CRE_WORKFLOW",
  "STOP_RUNTIME",
  "REVOKE_AGENT_IDENTITY",
] as const;
export type DeactivationStep = (typeof DEACTIVATION_STEPS)[number];

/**
 * The kill hierarchy.
 *
 * Four different things people mean by "stop the agent", ranked by what they actually stop. The UI
 * must show the difference, because the intuitive action — stop the container — is the one that
 * stops the least.
 */
export const KILL_HIERARCHY = [
  {
    id: "OPERATIONAL_STOP",
    action: "Pause the runtime, or scale it to zero",
    stops: "The agent process. It stops deciding and stops calling the gateways.",
    doesNotStop:
      "Anything already authorized. A capability that has been issued remains valid, a submitted transaction still lands, and the onchain policy still says this agent may act.",
    isSecurityKill: false,
  },
  {
    id: "SECURITY_STOP",
    action: "Disable the ContextLock policy on chain",
    stops: "Financial execution. The executor refuses, whatever the runtime, the DON or the model does.",
    doesNotStop: "The container, which keeps running and keeps being refused.",
    isSecurityKill: true,
  },
  {
    id: "IDENTITY_STOP",
    action: "Revoke the agent's ENS identity",
    stops: "Anything that authenticates the agent by its identity binding, including future capability issuance.",
    doesNotStop: "Capabilities already issued against the old binding, until they expire.",
    isSecurityKill: true,
  },
  {
    id: "CRE_STOP",
    action: "`cre workflow pause`",
    stops: "The workflow responding to triggers on the DON.",
    doesNotStop:
      "Financial execution by any other path. Pausing CRE is not the kill switch; it is one input being switched off.",
    isSecurityKill: false,
  },
] as const;

export const ACTIVATION_REASONS = {
  OUT_OF_ORDER: "ACTIVATION-OUT-OF-ORDER",
  RUNTIME_NOT_READY: "ACTIVATION-RUNTIME-NOT-READY",
  NOT_VERIFIED: "ACTIVATION-DEPLOYMENT-NOT-VERIFIED",
  POLICY_BEFORE_HEALTH: "ACTIVATION-POLICY-BEFORE-HEALTH",
  RUNTIME_STOP_IS_NOT_A_SECURITY_KILL: "KILL-RUNTIME-STOP-IS-NOT-A-SECURITY-KILL",
} as const;
export type ActivationReason = (typeof ACTIVATION_REASONS)[keyof typeof ACTIVATION_REASONS];

export class ActivationError extends Error {
  constructor(readonly reason: ActivationReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ActivationError";
  }
}

export const ActivationProgressSchema = z.object({
  deploymentId: z.string().min(1),
  completed: z.array(z.enum(ACTIVATION_STEPS)),
  startedAtMs: z.number().int().positive(),
  /** Set only when every step, in order, has completed. */
  activatedAtMs: z.number().int().positive().nullable(),
});
export type ActivationProgress = z.infer<typeof ActivationProgressSchema>;

/**
 * May this activation step run now?
 *
 * Order is enforced positionally rather than by a set of preconditions, so there is no arrangement
 * of flags that lets `ENABLE_CONTEXTLOCK_POLICY` run before the runtime has proven itself healthy.
 */
export function assertActivationStep(progress: ActivationProgress, step: ActivationStep, deploymentVerified: boolean): void {
  if (!deploymentVerified) {
    throw new ActivationError(
      ACTIVATION_REASONS.NOT_VERIFIED,
      `deployment ${progress.deploymentId} has not reached READY_TO_ACTIVATE; activation cannot begin`,
    );
  }
  const expected = ACTIVATION_STEPS[progress.completed.length];
  if (expected !== step) {
    throw new ActivationError(
      ACTIVATION_REASONS.OUT_OF_ORDER,
      `the next activation step is ${expected ?? "(none — already activated)"}, not ${step}. ` +
        (step === "ENABLE_CONTEXTLOCK_POLICY"
          ? "Enabling the policy is last, after the runtime and the workflow have each proven healthy, because it is the step that grants the ability to move value."
          : "The ceremony is ordered so that everything is checked while the agent still cannot act."),
    );
  }
}

export function advanceActivation(progress: ActivationProgress, step: ActivationStep, nowMs: number): ActivationProgress {
  const completed = [...progress.completed, step];
  return {
    ...progress,
    completed,
    activatedAtMs: completed.length === ACTIVATION_STEPS.length ? nowMs : null,
  };
}

/** The deactivation order for an incident. Returned as a list so the UI cannot reorder it. */
export function emergencyStopOrder(includeIdentityRevocation: boolean): DeactivationStep[] {
  const order: DeactivationStep[] = ["DISABLE_CONTEXTLOCK_POLICY", "PAUSE_CRE_WORKFLOW", "STOP_RUNTIME"];
  if (includeIdentityRevocation) order.push("REVOKE_AGENT_IDENTITY");
  return order;
}

/**
 * What a runtime stop is entitled to claim.
 *
 * Called wherever the UI reports the result of stopping a container. It cannot say the policy is
 * disabled, because stopping a container does not disable a policy — and RUN-022 exists because
 * that is exactly the sentence a status screen wants to print.
 */
export function runtimeStopClaim(policyStillEnabled: boolean): { stopped: true; policyDisabled: boolean; message: string } {
  return {
    stopped: true,
    policyDisabled: !policyStillEnabled,
    message: policyStillEnabled
      ? "The runtime is stopped. The ContextLock policy is still ENABLED: this agent's authority to move value has not been withdrawn, and any already-issued capability remains valid. To stop financial execution, disable the policy."
      : "The runtime is stopped and the ContextLock policy is disabled.",
  };
}

export function assertNotClaimingSecurityKill(claim: { policyDisabled: boolean }, policyEnabledOnChain: boolean): void {
  if (claim.policyDisabled && policyEnabledOnChain) {
    throw new ActivationError(
      ACTIVATION_REASONS.RUNTIME_STOP_IS_NOT_A_SECURITY_KILL,
      "a runtime stop reported the policy as disabled while the chain says it is enabled",
    );
  }
}
