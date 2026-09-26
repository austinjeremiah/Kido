import { z } from "zod";

/**
 * CRE execution modes.
 *
 * The reframing this phase exists for: the absence of CRE Deploy Access is not an incomplete
 * deployment. Official CLI simulation is a first-class mode, and a real DON deployment is optional.
 *
 * What must not happen is the three modes blurring. A simulation is not a deployment; the CLI
 * simulator is not a DON; and neither of them is a hardware TEE. Each of those is a claim someone
 * would be entitled to rely on, so each is separately typed and separately evidenced.
 */

export const CRE_EXECUTION_MODES = [
  /**
   * The official CRE CLI simulator, run by ContextLock's own infrastructure.
   *
   * The user needs no CRE login. It MUST NOT be represented as the user's CRE account, because it
   * is not — it is ContextLock's simulator running the user's reviewed workflow.
   *
   * Whether a shared multi-tenant simulation service is acceptable under Chainlink's terms has not
   * been established by this project. Until it is, this mode is INTERNAL_ONLY — see
   * BLK-CRE-PLATFORM-MULTITENANT.
   */
  "SIMULATED_PLATFORM",
  /** The official CLI simulator, run through the user's Local Bridge under their own `cre login`. */
  "SIMULATED_USER",
  /** A real workflow, deployed to a real DON, under the user's account and Deploy Access. */
  "DEPLOYED_USER",
] as const;
export const CreExecutionModeSchema = z.enum(CRE_EXECUTION_MODES);
export type CreExecutionMode = z.infer<typeof CreExecutionModeSchema>;

/** Modes that are simulation. Nothing in this set touches a DON. */
export const SIMULATED_MODES: ReadonlySet<CreExecutionMode> = new Set<CreExecutionMode>(["SIMULATED_PLATFORM", "SIMULATED_USER"]);

export const isSimulated = (m: CreExecutionMode): boolean => SIMULATED_MODES.has(m);

/**
 * Availability of the platform simulator.
 *
 * A constant rather than a config flag, because the question it answers is legal rather than
 * technical: may ContextLock operate a shared CRE simulation service for other people's workflows?
 * That has not been verified with Chainlink, so the answer is no for public use and the mode is
 * usable internally only.
 */
export const PLATFORM_SIMULATION_AVAILABILITY = "INTERNAL_ONLY" as const;
export const PLATFORM_SIMULATION_BLOCKER = "BLK-CRE-PLATFORM-MULTITENANT" as const;

export const CRE_MODE_REASONS = {
  SIMULATION_IS_NOT_DEPLOYMENT: "CRE_SIMULATION_IS_NOT_DEPLOYMENT",
  PLATFORM_NOT_PUBLIC: "CRE_PLATFORM_SIMULATION_INTERNAL_ONLY",
  DEPLOY_ACCESS_REQUIRED: "CRE_DEPLOY_ACCESS_REQUIRED",
  WRONG_MODE_OPERATION: "CRE_OPERATION_WRONG_FOR_MODE",
  FALSE_DON_CLAIM: "CRE_FALSE_DON_CLAIM",
  FALSE_TEE_CLAIM: "CRE_FALSE_TEE_CLAIM",
} as const;
export type CreModeReason = (typeof CRE_MODE_REASONS)[keyof typeof CRE_MODE_REASONS];

export class CreModeError extends Error {
  constructor(readonly reason: CreModeReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "CreModeError";
  }
}

/**
 * Whether this deployment may use the platform simulator.
 *
 * `internalUse` has to be asserted by the caller rather than defaulted, so enabling it for a public
 * tenant is a decision someone makes rather than a default nobody noticed.
 */
export function assertPlatformSimulationAllowed(internalUse: boolean): void {
  if (PLATFORM_SIMULATION_AVAILABILITY === "INTERNAL_ONLY" && !internalUse) {
    throw new CreModeError(
      CRE_MODE_REASONS.PLATFORM_NOT_PUBLIC,
      `SIMULATED_PLATFORM runs the official CRE CLI under ContextLock's own infrastructure. Whether operating that as a shared multi-tenant service is acceptable under Chainlink's terms has not been established by this project (${PLATFORM_SIMULATION_BLOCKER}), so it is available for internal use only. Use SIMULATED_USER, which runs under the user's own cre login.`,
    );
  }
}

/* ───────────────────── identifiers that must not be confused ───────────────────── */

/**
 * A simulation session identifier.
 *
 * Deliberately not a workflow id, and deliberately not even the same SHAPE. A real CRE workflow id
 * is 64 hex characters; this is a URI. Code expecting a workflow id will fail to parse this rather
 * than accepting it, which is the property §P26.2 asks for.
 */
export const CRE_SIMULATION_ID_PREFIX = "cre-sim://" as const;
export const CreSimulationIdSchema = z
  .string()
  .regex(/^cre-sim:\/\/[a-z0-9][a-z0-9_-]*\/session\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "cre-sim://<project>/session/<uuid>");
export type CreSimulationId = z.infer<typeof CreSimulationIdSchema>;

/** A real CRE workflow id: the onchain workflow identifier, 64 lowercase hex. */
export const CreWorkflowIdSchema = z.string().regex(/^[0-9a-f]{64}$/, "64 lowercase hex characters");
export type CreWorkflowId = z.infer<typeof CreWorkflowIdSchema>;

export const isSimulationId = (s: string): boolean => CreSimulationIdSchema.safeParse(s).success;
export const isWorkflowId = (s: string): boolean => CreWorkflowIdSchema.safeParse(s).success;

/**
 * Refuse a simulation id where a workflow id is required.
 *
 * The failure this prevents is a simulation session being recorded as a deployed workflow and then
 * reported, truthfully as far as the database is concerned, as a live DON deployment.
 */
export function assertRealWorkflowId(id: string, context: string): CreWorkflowId {
  if (isSimulationId(id)) {
    throw new CreModeError(
      CRE_MODE_REASONS.SIMULATION_IS_NOT_DEPLOYMENT,
      `${context}: "${id}" is a simulation session, not a deployed workflow. A simulation never reaches a DON, and recording one as a workflow would make the deployment record claim something that did not happen.`,
    );
  }
  const parsed = CreWorkflowIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new CreModeError(CRE_MODE_REASONS.SIMULATION_IS_NOT_DEPLOYMENT, `${context}: "${id}" is not a CRE workflow id`);
  }
  return parsed.data;
}

/* ───────────────────────────── privacy evidence ───────────────────────────── */

/**
 * What this deployment can honestly claim about confidentiality.
 *
 * Every field is a separate claim because each is separately falsifiable, and because collapsing
 * them into "confidential: true" is how a simulator becomes a TEE in a slide deck.
 *
 * `realDonConsensus` and `realTeeExecution` are `false` for every simulated mode and there is no
 * code path that sets them true without evidence — see `assertPrivacyEvidenceHonest`.
 */
export const PrivacyEvidenceSchema = z.object({
  /** The agent process cannot read the secret. True in every mode; the broker holds it. */
  agentCannotReadSecret: z.boolean(),
  /** Private policy values are not shown to the model. */
  privatePolicyNotShownToAgent: z.boolean(),
  /** The official Chainlink CLI simulator really ran. */
  officialCreSimulation: z.boolean(),
  /** A real DON reached consensus. Simulation never does this. */
  realDonConsensus: z.boolean(),
  /** Execution happened inside a hardware TEE. */
  realTeeExecution: z.boolean(),
  /** A TEE attestation was obtained and verified. */
  teeAttestation: z.boolean(),
});
export type PrivacyEvidence = z.infer<typeof PrivacyEvidenceSchema>;

export function privacyEvidenceFor(mode: CreExecutionMode, officialSimulationRan: boolean): PrivacyEvidence {
  return {
    agentCannotReadSecret: true,
    privatePolicyNotShownToAgent: true,
    officialCreSimulation: isSimulated(mode) && officialSimulationRan,
    // A simulation is a simulation. These stay false, and the assertion below stops them moving.
    realDonConsensus: mode === "DEPLOYED_USER",
    realTeeExecution: false,
    teeAttestation: false,
  };
}

/**
 * Refuse a privacy claim the mode cannot support.
 *
 * The two that matter: a simulated mode claiming DON consensus, and anything claiming TEE execution
 * without an attestation. Both would be believed.
 */
export function assertPrivacyEvidenceHonest(mode: CreExecutionMode, e: PrivacyEvidence): void {
  if (isSimulated(mode) && e.realDonConsensus) {
    throw new CreModeError(
      CRE_MODE_REASONS.FALSE_DON_CLAIM,
      `${mode} runs the CRE CLI simulator. No DON participates and no consensus occurs; claiming otherwise would be a false statement about where this workflow executed.`,
    );
  }
  if (e.realTeeExecution && !e.teeAttestation) {
    throw new CreModeError(
      CRE_MODE_REASONS.FALSE_TEE_CLAIM,
      "realTeeExecution requires a verified attestation. Without one there is no evidence the code ran in a trusted execution environment, and 'we believe it did' is not a confidentiality guarantee.",
    );
  }
  if (isSimulated(mode) && e.realTeeExecution) {
    throw new CreModeError(CRE_MODE_REASONS.FALSE_TEE_CLAIM, `${mode} is a local simulator process. There is no TEE.`);
  }
}

/** The UI text for a mode. Honest by construction — there is no branch that says "DON" for a sim. */
export function creModeLabel(mode: CreExecutionMode): { headline: string; don: string; tee: string; provider: string } {
  switch (mode) {
    case "SIMULATED_PLATFORM":
      return { headline: "SIMULATED (ContextLock simulator)", don: "NOT DEPLOYED", tee: "NOT ACTIVE", provider: "Official Chainlink CRE CLI" };
    case "SIMULATED_USER":
      return { headline: "SIMULATED (your CRE CLI)", don: "NOT DEPLOYED", tee: "NOT ACTIVE", provider: "Official Chainlink CRE CLI, via your Local Bridge" };
    case "DEPLOYED_USER":
      return { headline: "DEPLOYED", don: "DEPLOYED", tee: "NOT ESTABLISHED", provider: "Chainlink DON" };
  }
}
