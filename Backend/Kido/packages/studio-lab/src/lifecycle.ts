import { z } from "zod";
import type { DeploymentState } from "@contextlock/studio-orchestrator";
import type { CreState, RuntimeState } from "@contextlock/studio-control-plane";

/**
 * The one lifecycle a user sees.
 *
 * Phases 11 through 27 each built a state machine, and each was right for its own layer: a build has
 * stages, a deployment has states, a runtime has health, CRE has a mode, a policy is on or off.
 * Asking a user to hold five of those in their head is the reason this phase exists.
 *
 * §P28.1 attaches the condition that matters:
 *
 *     Do not derive this from one boolean. Compute it from actual underlying states.
 *
 * A single `isActive` column would be a second source of truth, and a second source of truth about
 * whether an agent has financial authority is the failure this whole product is built to avoid. So
 * `LabProjectState` is a **projection**, computed on every read from the states the underlying
 * systems actually report. It is never stored, and there is no setter.
 *
 * The ordering below is deliberate and is the whole of the logic worth reviewing: the most alarming
 * true statement wins. An emergency lock outranks a healthy runtime; a failed deployment outranks a
 * passing simulation. A projection that reported the most flattering true statement would be
 * accurate and useless.
 */

export const LAB_PROJECT_STATES = [
  /** A prompt exists. Nothing has been compiled. */
  "DRAFT",
  /** A Blueprint compiled and its architecture is renderable. */
  "ARCHITECTURE_READY",
  /** The pipeline is waiting for a human to approve the security review. */
  "REVIEW_REQUIRED",
  "BUILDING",
  /** Code generated and its own tests pass. Nothing has been simulated. */
  "BUILD_READY",
  /** Deterministic simulations and the CRE simulator have both passed. */
  "SIMULATION_READY",
  /** Everything upstream passed; the deployment preflight has not been satisfied. */
  "PREFLIGHT_REQUIRED",
  "READY_TO_DEPLOY",
  "DEPLOYING",
  /** Deployed, verified, policy still DISABLED. The state P23 deliberately terminates in. */
  "READY_TO_ACTIVATE",
  /** Policy enabled, runtime healthy, CRE healthy. The only state with financial authority. */
  "LAB_ACTIVE",
  /** Runtime stopped by an operator. Financial authority may still be enabled — see `PAUSED`. */
  "PAUSED",
  "EMERGENCY_LOCKED",
  /** Active, and something it depends on is unhealthy. */
  "DEGRADED",
  "FAILED",
] as const;
export const LabProjectStateSchema = z.enum(LAB_PROJECT_STATES);
export type LabProjectState = z.infer<typeof LabProjectStateSchema>;

/** Whether the ContextLock policy is enabled — read from the chain, never from a local flag. */
export const PolicyAuthoritySchema = z.object({
  enabled: z.boolean(),
  /** The block the reading came from. A policy state with no block is not a reading. */
  observedAtBlock: z.string().regex(/^\d+$/).nullable(),
  observedAtMs: z.number().int().nonnegative(),
  /** How the value was obtained. "cached" is a source, and it says so. */
  source: z.string().min(1),
});
export type PolicyAuthority = z.infer<typeof PolicyAuthoritySchema>;

/**
 * Everything the projection reads.
 *
 * Every field is a state some other system owns. Nothing here is a summary someone computed
 * earlier — that is the point, and `LAB-001` asserts the projection is a pure function of these.
 */
export interface LabInputs {
  /** From the P11 build pipeline. */
  build: {
    stage: "INTAKE" | "REQUIREMENTS" | "BLUEPRINT" | "SECURITY_REVIEW" | "AWAITING_APPROVAL" | "BUILD" | "TEST" | "SIMULATE" | "REPAIR" | "FINAL_VERIFY" | "EXPORT_READY";
    status: "RUNNING" | "AWAITING_APPROVAL" | "COMPLETED" | "FAILED" | "PAUSED" | "BUILD_LIMIT_REACHED" | "BUILD_NEEDS_USER_REVIEW" | "BUILD_PAUSED_UPSTREAM_LIMIT" | "ABANDONED";
  } | null;
  /** Deterministic simulations (P13) and the official CRE simulator (P26). Both, separately. */
  deterministicSimulationsPassed: boolean;
  creSimulationPassed: boolean;
  /** The P22 preflight verdict. */
  preflightPassed: boolean;
  /** From the P23 orchestrator. Null before a deployment is started. */
  deployment: DeploymentState | null;
  /** From the P25 control plane. Null before a runtime exists. */
  runtime: RuntimeState | null;
  cre: CreState | null;
  /** Read fresh from chain. Null when no deployment exists to read. */
  policy: PolicyAuthority | null;
  emergencyLockActive: boolean;
  /** Any dependency the control plane reports unhealthy — an adapter, a data source. */
  degradedDependencies: ReadonlyArray<string>;
}

export interface LabProjection {
  state: LabProjectState;
  /** Which input decided it. Every state names its evidence, so a surprising answer is checkable. */
  because: string;
  /** True only in `LAB_ACTIVE`. The one question that matters, answered from one place. */
  hasFinancialAuthority: boolean;
  /** What the user can do next, derived rather than hard-coded per screen. */
  nextAction: string | null;
  degradedDependencies: ReadonlyArray<string>;
}

const DEPLOYING_STATES: ReadonlySet<DeploymentState> = new Set<DeploymentState>([
  "DEPLOYMENT_APPROVED",
  "DEPLOYING_CHAIN_COMPONENTS",
  "CONFIGURING_POLICY_DISABLED",
  "DEPLOYING_CRE",
  "PAUSING_OR_CONFIRMING_CRE_STATE",
  "BUILDING_RUNTIME_IMAGE",
  "VERIFYING_DEPLOYMENT",
]);

const FAILED_DEPLOYMENT_STATES: ReadonlySet<DeploymentState> = new Set<DeploymentState>([
  "DEPLOYMENT_FAILED_TERMINAL",
  "DEPLOYMENT_FAILED_RECOVERABLE",
  "DEPLOYMENT_PARTIAL",
  "DEPLOYMENT_PAUSED_USER",
  "DEPLOYMENT_PAUSED_SIGNER",
  "DEPLOYMENT_PAUSED_CRE_AUTH",
]);

/** Runtime states that mean the agent is not currently able to act. */
const RUNTIME_NOT_WORKING: ReadonlySet<RuntimeState> = new Set<RuntimeState>([
  "CRASH_LOOP", "FAILED", "STOPPED", "UNKNOWN",
]);

/**
 * Compute the lifecycle state.
 *
 * Pure. Same inputs, same answer, no clock and no I/O — so the projection can be recomputed on a
 * page load, in a test, or from a stored snapshot of inputs and give the same result. `PRODUCT-002`
 * depends on exactly that.
 */
export function projectLabState(inputs: LabInputs): LabProjection {
  const degraded = [...inputs.degradedDependencies];

  /*
   * Alarming first.
   *
   * An emergency lock is the strongest statement the system can make about itself, and it outranks
   * every healthy signal underneath it. Reporting LAB_ACTIVE while a lock is engaged would be true
   * of the policy bit and wrong about the system.
   */
  if (inputs.emergencyLockActive) {
    return {
      state: "EMERGENCY_LOCKED",
      because: "an emergency lock is engaged",
      hasFinancialAuthority: false,
      nextAction: "Review the emergency lock before doing anything else",
      degradedDependencies: degraded,
    };
  }

  if (inputs.deployment !== null && FAILED_DEPLOYMENT_STATES.has(inputs.deployment)) {
    return {
      state: "FAILED",
      because: `the deployment is ${inputs.deployment}`,
      hasFinancialAuthority: false,
      nextAction: "Inspect the deployment receipt",
      degradedDependencies: degraded,
    };
  }

  if (inputs.build?.status === "FAILED" || inputs.build?.status === "ABANDONED") {
    return {
      state: "FAILED",
      because: `the build is ${inputs.build.status}`,
      hasFinancialAuthority: false,
      nextAction: "Start a new build",
      degradedDependencies: degraded,
    };
  }

  /* ── deployed territory ─────────────────────────────────────────────────── */

  if (inputs.deployment === "READY_TO_ACTIVATE") {
    const policyEnabled = inputs.policy?.enabled === true;

    if (!policyEnabled) {
      // A paused runtime before activation is still just "not activated".
      return {
        state: "READY_TO_ACTIVATE",
        because: "the deployment is verified and the ContextLock policy is disabled",
        hasFinancialAuthority: false,
        nextAction: "Activate the testnet agent",
        degradedDependencies: degraded,
      };
    }

    /*
     * Policy enabled. Now the runtime and CRE decide between ACTIVE, PAUSED and DEGRADED — and
     * PAUSED deliberately does NOT clear financial authority, because it does not.
     *
     * §P28.45: pausing a container is an operational stop. The policy is what carries authority,
     * and a projection that reported PAUSED as safe would teach the exact misunderstanding the
     * control panel is built to prevent.
     */
    if (inputs.runtime === "PAUSED") {
      return {
        state: "PAUSED",
        because: "the runtime is paused; the ContextLock policy is still ENABLED",
        hasFinancialAuthority: true,
        nextAction: "Disable the policy if you intend to remove financial authority",
        degradedDependencies: degraded,
      };
    }

    const runtimeBroken = inputs.runtime !== null && RUNTIME_NOT_WORKING.has(inputs.runtime);
    const creBroken = inputs.cre === "DEGRADED" || inputs.cre === "FAILED" || inputs.cre === "STALE";

    if (runtimeBroken || creBroken || inputs.runtime === "DEGRADED" || degraded.length > 0) {
      const reasons = [
        runtimeBroken || inputs.runtime === "DEGRADED" ? `runtime is ${inputs.runtime}` : null,
        creBroken ? `CRE is ${inputs.cre}` : null,
        degraded.length > 0 ? `unhealthy: ${degraded.join(", ")}` : null,
      ].filter((r): r is string => r !== null);
      return {
        state: "DEGRADED",
        because: `the policy is enabled and ${reasons.join("; ")}`,
        // Still true, and still the thing to say out loud.
        hasFinancialAuthority: true,
        nextAction: "Disable the policy or repair the dependency",
        degradedDependencies: degraded,
      };
    }

    return {
      state: "LAB_ACTIVE",
      because: "the policy is enabled, the runtime is healthy and CRE is healthy",
      hasFinancialAuthority: true,
      nextAction: "Monitor activity, or run the Attack Lab",
      degradedDependencies: degraded,
    };
  }

  if (inputs.deployment !== null && DEPLOYING_STATES.has(inputs.deployment)) {
    return {
      state: "DEPLOYING",
      because: `the deployment is ${inputs.deployment}`,
      hasFinancialAuthority: false,
      nextAction: null,
      degradedDependencies: degraded,
    };
  }

  /* ── pre-deployment ─────────────────────────────────────────────────────── */

  if (inputs.build === null) {
    return { state: "DRAFT", because: "no build exists yet", hasFinancialAuthority: false, nextAction: "Describe the agent you want", degradedDependencies: degraded };
  }

  if (inputs.build.status === "AWAITING_APPROVAL" || inputs.build.stage === "AWAITING_APPROVAL") {
    return {
      state: "REVIEW_REQUIRED",
      because: "the security review needs a human decision",
      hasFinancialAuthority: false,
      nextAction: "Review what this agent can and cannot do",
      degradedDependencies: degraded,
    };
  }

  if (inputs.build.status !== "COMPLETED") {
    // Everything from INTAKE to FINAL_VERIFY that is still moving.
    if (inputs.build.stage === "INTAKE" || inputs.build.stage === "REQUIREMENTS") {
      return { state: "DRAFT", because: `the build is at ${inputs.build.stage}`, hasFinancialAuthority: false, nextAction: null, degradedDependencies: degraded };
    }
    if (inputs.build.stage === "BLUEPRINT" || inputs.build.stage === "SECURITY_REVIEW") {
      return { state: "ARCHITECTURE_READY", because: `the build is at ${inputs.build.stage}`, hasFinancialAuthority: false, nextAction: null, degradedDependencies: degraded };
    }
    return { state: "BUILDING", because: `the build is at ${inputs.build.stage}`, hasFinancialAuthority: false, nextAction: null, degradedDependencies: degraded };
  }

  // The build finished. What has been proved about it since?
  if (!inputs.deterministicSimulationsPassed || !inputs.creSimulationPassed) {
    const missing = [
      !inputs.deterministicSimulationsPassed ? "deterministic simulations" : null,
      !inputs.creSimulationPassed ? "the official CRE simulation" : null,
    ].filter((m): m is string => m !== null);
    return {
      state: "BUILD_READY",
      because: `the build completed and ${missing.join(" and ")} ${missing.length > 1 ? "have" : "has"} not passed`,
      hasFinancialAuthority: false,
      nextAction: "Run the simulations",
      degradedDependencies: degraded,
    };
  }

  if (!inputs.preflightPassed) {
    return {
      state: "PREFLIGHT_REQUIRED",
      because: "simulations passed and the deployment preflight has not",
      hasFinancialAuthority: false,
      nextAction: "Run the deployment preflight",
      degradedDependencies: degraded,
    };
  }

  if (inputs.deployment === null) {
    return {
      state: "READY_TO_DEPLOY",
      because: "every gate upstream of deployment has passed",
      hasFinancialAuthority: false,
      nextAction: "Deploy to Testnet Lab",
      degradedDependencies: degraded,
    };
  }

  return {
    state: "SIMULATION_READY",
    because: "simulations passed",
    hasFinancialAuthority: false,
    nextAction: "Run the deployment preflight",
    degradedDependencies: degraded,
  };
}

/**
 * States in which the agent holds financial authority.
 *
 * Exported as data rather than left implicit in the projection, so a caller can ask the question
 * without re-deriving it and a test can assert the set has not quietly grown.
 */
export const AUTHORITY_STATES: ReadonlySet<LabProjectState> = new Set<LabProjectState>([
  "LAB_ACTIVE", "PAUSED", "DEGRADED",
]);

/**
 * The label a state gets in the UI.
 *
 * `PAUSED` says what it is and what it is not, because that is the distinction §P28.45 exists for.
 */
export function labStateLabel(state: LabProjectState): { headline: string; detail: string } {
  switch (state) {
    case "DRAFT": return { headline: "DRAFT", detail: "Nothing has been compiled yet" };
    case "ARCHITECTURE_READY": return { headline: "ARCHITECTURE READY", detail: "A Blueprint exists and can be reviewed" };
    case "REVIEW_REQUIRED": return { headline: "REVIEW REQUIRED", detail: "The security review needs a human decision" };
    case "BUILDING": return { headline: "BUILDING", detail: "Generating and testing code" };
    case "BUILD_READY": return { headline: "BUILD READY", detail: "Code passes its own tests; nothing has been simulated" };
    case "SIMULATION_READY": return { headline: "SIMULATION READY", detail: "Deterministic and CRE simulations passed" };
    case "PREFLIGHT_REQUIRED": return { headline: "PREFLIGHT REQUIRED", detail: "The deployment preflight has not passed" };
    case "READY_TO_DEPLOY": return { headline: "READY TO DEPLOY", detail: "Every gate upstream of deployment has passed" };
    case "DEPLOYING": return { headline: "DEPLOYING", detail: "Deploying to the testnet lab" };
    case "READY_TO_ACTIVATE": return { headline: "READY TO ACTIVATE", detail: "Deployed and verified. The policy is DISABLED" };
    case "LAB_ACTIVE": return { headline: "TESTNET LAB ACTIVE", detail: "The ContextLock policy is enabled on an approved execution network — a testnet or a local fork, never mainnet" };
    case "PAUSED":
      return {
        headline: "RUNTIME PAUSED",
        detail: "The container is stopped. The ContextLock policy is still ENABLED — pausing a runtime is an operational stop, not a financial one",
      };
    case "EMERGENCY_LOCKED": return { headline: "EMERGENCY LOCKED", detail: "An emergency lock is engaged" };
    case "DEGRADED": return { headline: "DEGRADED", detail: "The policy is enabled and something it depends on is unhealthy" };
    case "FAILED": return { headline: "FAILED", detail: "See the failure reason" };
  }
}
