import { z } from "zod";

/**
 * The deployment state machine.
 *
 * Application-controlled, and ordered so that the security controls come off LAST — which is to say
 * they never come off during a deployment at all. The whole sequence runs with the onchain
 * ContextLock policy disabled, and reaches `READY_TO_ACTIVATE`, not `ACTIVE`.
 *
 * There is no transition anywhere in this table from a deploying state to an activated one.
 * Activation is a separate operation with its own ceremony, and the reason it is separate is that
 * "the deployment finished" and "this agent may now move money" are different claims, made by
 * different evidence, at different times.
 *
 * The failure states are worth as much as the happy path. `DEPLOYMENT_PARTIAL` exists because a
 * cross-chain, multi-artifact deployment containing irreversible steps genuinely can end half-done,
 * and calling that FAILED would suggest nothing happened.
 */

export const DEPLOYMENT_STATES = [
  "DEPLOYMENT_APPROVED",
  "DEPLOYING_CHAIN_COMPONENTS",
  "CONFIGURING_POLICY_DISABLED",
  "DEPLOYING_CRE",
  "PAUSING_OR_CONFIRMING_CRE_STATE",
  "BUILDING_RUNTIME_IMAGE",
  "VERIFYING_DEPLOYMENT",
  "READY_TO_ACTIVATE",
  /* failure states */
  "DEPLOYMENT_PAUSED_USER",
  "DEPLOYMENT_PAUSED_SIGNER",
  "DEPLOYMENT_PAUSED_CRE_AUTH",
  "DEPLOYMENT_PARTIAL",
  "DEPLOYMENT_FAILED_RECOVERABLE",
  "DEPLOYMENT_FAILED_TERMINAL",
] as const;
export const DeploymentStateSchema = z.enum(DEPLOYMENT_STATES);
export type DeploymentState = z.infer<typeof DeploymentStateSchema>;

/** States from which work can resume. Everything else needs a human decision first. */
export const RESUMABLE_STATES: ReadonlySet<DeploymentState> = new Set<DeploymentState>([
  "DEPLOYMENT_APPROVED",
  "DEPLOYING_CHAIN_COMPONENTS",
  "CONFIGURING_POLICY_DISABLED",
  "DEPLOYING_CRE",
  "PAUSING_OR_CONFIRMING_CRE_STATE",
  "BUILDING_RUNTIME_IMAGE",
  "VERIFYING_DEPLOYMENT",
  "DEPLOYMENT_PAUSED_USER",
  "DEPLOYMENT_PAUSED_SIGNER",
  "DEPLOYMENT_PAUSED_CRE_AUTH",
  "DEPLOYMENT_FAILED_RECOVERABLE",
  "DEPLOYMENT_PARTIAL",
]);

const HAPPY_PATH: DeploymentState[] = [
  "DEPLOYMENT_APPROVED",
  "DEPLOYING_CHAIN_COMPONENTS",
  "CONFIGURING_POLICY_DISABLED",
  "DEPLOYING_CRE",
  "PAUSING_OR_CONFIRMING_CRE_STATE",
  "BUILDING_RUNTIME_IMAGE",
  "VERIFYING_DEPLOYMENT",
  "READY_TO_ACTIVATE",
];

const PAUSES: DeploymentState[] = [
  "DEPLOYMENT_PAUSED_USER",
  "DEPLOYMENT_PAUSED_SIGNER",
  "DEPLOYMENT_PAUSED_CRE_AUTH",
  "DEPLOYMENT_FAILED_RECOVERABLE",
  "DEPLOYMENT_PARTIAL",
];

function buildTransitions(): Record<DeploymentState, ReadonlySet<DeploymentState>> {
  const t: Record<string, Set<DeploymentState>> = {};
  for (const s of DEPLOYMENT_STATES) t[s] = new Set<DeploymentState>();

  HAPPY_PATH.forEach((s, i) => {
    /*
     * Forward to ANY later phase, not only the adjacent one.
     *
     * A plan need not contain steps for every phase: an agent with no CRE component has nothing to
     * do in DEPLOYING_CRE, and an agent that only reconfigures an existing deployment has nothing
     * to do in DEPLOYING_CHAIN_COMPONENTS. Requiring adjacency would mean either passing through
     * phases with no work in them — states that claim work is happening when none is — or refusing
     * perfectly ordinary plans.
     *
     * What is NOT relaxed is direction. There is no edge from any later phase to an earlier one, so
     * a deployment cannot go back to deploying contracts after it has started configuring policy.
     * And READY_TO_ACTIVATE is reachable from VERIFYING_DEPLOYMENT alone: verification is not a
     * phase that can be skipped, whatever the plan contains.
     */
    for (let j = i + 1; j < HAPPY_PATH.length; j++) {
      const to = HAPPY_PATH[j]!;
      if (to === "READY_TO_ACTIVATE" && s !== "VERIFYING_DEPLOYMENT") continue;
      t[s]!.add(to);
    }
    // Any in-flight state can pause or fail. A deployment that could only move forwards would have
    // to invent a success when something went wrong.
    if (s !== "READY_TO_ACTIVATE") {
      for (const p of PAUSES) t[s]!.add(p);
      t[s]!.add("DEPLOYMENT_FAILED_TERMINAL");
    }
  });

  // A pause resumes into the phase it paused in — which is decided by which steps are unsatisfied,
  // not remembered, so a resume after a restart lands in the same place. READY_TO_ACTIVATE is
  // excluded: a paused deployment resumes into work, never straight into readiness.
  for (const p of PAUSES) {
    for (const s of HAPPY_PATH) if (s !== "READY_TO_ACTIVATE") t[p]!.add(s);
    t[p]!.add("DEPLOYMENT_FAILED_TERMINAL");
    for (const q of PAUSES) if (q !== p) t[p]!.add(q);
  }

  // READY_TO_ACTIVATE and DEPLOYMENT_FAILED_TERMINAL are terminal for the deployment. Activation is
  // a separate operation on a separate object; there is no edge to it from here.
  return t as Record<DeploymentState, ReadonlySet<DeploymentState>>;
}

export const DEPLOYMENT_TRANSITIONS = buildTransitions();

export const MACHINE_REASONS = {
  ILLEGAL_TRANSITION: "DEPLOY-ILLEGAL-TRANSITION",
  NOT_RESUMABLE: "DEPLOY-NOT-RESUMABLE",
  TERMINAL: "DEPLOY-TERMINAL",
} as const;
export type MachineReason = (typeof MACHINE_REASONS)[keyof typeof MACHINE_REASONS];

export class DeploymentMachineError extends Error {
  constructor(readonly reason: MachineReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "DeploymentMachineError";
  }
}

export function assertTransition(from: DeploymentState, to: DeploymentState): void {
  if (!DEPLOYMENT_TRANSITIONS[from].has(to)) {
    throw new DeploymentMachineError(
      MACHINE_REASONS.ILLEGAL_TRANSITION,
      `${from} -> ${to} is not a legal deployment transition; from ${from} the legal next states are [${[...DEPLOYMENT_TRANSITIONS[from]].sort().join(", ") || "none — this state is terminal"}]`,
    );
  }
}

export const isTerminal = (s: DeploymentState): boolean => DEPLOYMENT_TRANSITIONS[s].size === 0;

/** Which phase a step type belongs to. Drives the state the machine should be in while it runs. */
export function phaseFor(stepType: string): DeploymentState {
  switch (stepType) {
    case "VERIFY_CHAIN":
    case "VERIFY_CORE":
    case "DEPLOY_CONTRACT":
      return "DEPLOYING_CHAIN_COMPONENTS";
    case "CONFIGURE_CONTRACT":
    case "REGISTER_POLICY_DISABLED":
    case "REGISTER_ENS_IDENTITY":
      return "CONFIGURING_POLICY_DISABLED";
    case "CHECK_CRE_ACCESS":
    case "BUILD_CRE_WASM":
    case "VERIFY_CRE_HASH":
    case "DEPLOY_CRE_PRIVATE":
      return "DEPLOYING_CRE";
    case "PAUSE_CRE":
      return "PAUSING_OR_CONFIRMING_CRE_STATE";
    case "BUILD_RUNTIME_IMAGE":
    case "SCAN_RUNTIME_IMAGE":
    case "PUBLISH_RUNTIME_IMAGE":
    case "CREATE_RUNTIME_DISABLED":
      return "BUILDING_RUNTIME_IMAGE";
    case "POST_DEPLOY_VERIFY":
      return "VERIFYING_DEPLOYMENT";
    default:
      throw new DeploymentMachineError(MACHINE_REASONS.ILLEGAL_TRANSITION, `no phase is defined for step type "${stepType}"`);
  }
}
