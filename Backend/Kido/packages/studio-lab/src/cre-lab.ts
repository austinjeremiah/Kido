import { z } from "zod";
import {
  CRE_EXECUTION_MODES, isSimulated, creModeLabel, assertPlatformSimulationAllowed,
  PLATFORM_SIMULATION_AVAILABILITY, PLATFORM_SIMULATION_BLOCKER,
  privacyEvidenceFor, assertPrivacyEvidenceHonest, isProductionChain,
  type CreExecutionMode, type PrivacyEvidence,
} from "@contextlock/studio-network";

/**
 * CRE, as the product presents it.
 *
 * The mode model from P26 is unchanged and is not re-litigated here. What this adds is the display
 * contract and the connection boundary — §P28.14's requirement being the one that does the work:
 *
 *     Never collapse to "CRE Connected ✓" without semantics.
 *
 * A green tick is a summary of six independent facts, and five of them are usually "no". Collapsing
 * them produces a badge that is true of *something* and tells the reader nothing about which. The
 * status below is six fields because it is six claims.
 */

export const CRE_DISPLAY_FIELDS = ["mode", "account", "workflowBinary", "productionLimits", "donDeployment", "hardwareTee"] as const;

export const CreStatusSchema = z.object({
  /** What is actually running, in words a reader can act on. */
  mode: z.string().min(1),
  executionMode: z.enum(CRE_EXECUTION_MODES),
  /** Whose login. Never a token, never a session file — a description. */
  account: z.string().min(1),
  organizationId: z.string().nullable(),
  /** The exact artifact. A CRE claim with no artifact hash is a claim about nothing in particular. */
  workflowBinary: z.string().nullable(),
  productionLimits: z.enum(["ENABLED", "DISABLED", "UNKNOWN"]),
  /** Three separate no's, because they are three separate questions. */
  donDeployment: z.enum(["YES", "NO"]),
  hardwareTee: z.enum(["YES", "NO"]),
  teeAttestation: z.enum(["YES", "NO"]),
  deployAccess: z.enum(["ENABLED", "NOT_ENABLED", "UNKNOWN"]),
  registries: z.array(z.string()),
});
export type CreStatus = z.infer<typeof CreStatusSchema>;

export const CRE_LAB_REASONS = {
  FALSE_DON: "CRE_DISPLAY_CLAIMS_DON_DEPLOYMENT",
  FALSE_TEE: "CRE_DISPLAY_CLAIMS_TEE",
  COLLAPSED: "CRE_STATUS_COLLAPSED_TO_A_BOOLEAN",
  SESSION_EXPORTED: "CRE_SESSION_WOULD_LEAVE_THE_MACHINE",
  PLATFORM_NOT_PUBLIC: "CRE_PLATFORM_SIMULATION_INTERNAL_ONLY",
  PROMOTION_UNAVAILABLE: "CRE_PROMOTION_REQUIRES_DEPLOY_ACCESS",
  ARTIFACT_CHANGED: "CRE_PROMOTION_ARTIFACT_CHANGED",
  ONCHAIN_REGISTRY: "PRODUCTION_NETWORK_WRITE_PROHIBITED",
  DEPLOYED_UNAVAILABLE: "CRE_DEPLOYED_UNAVAILABLE",
} as const;
export type CreLabReason = (typeof CRE_LAB_REASONS)[keyof typeof CRE_LAB_REASONS];

export class CreLabError extends Error {
  constructor(readonly reason: CreLabReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "CreLabError";
  }
}

/**
 * Build the status display from the mode and the evidence.
 *
 * Derived, never assembled by hand at a call site. The DON and TEE fields come from
 * `privacyEvidenceFor`, which P26 already guarantees never returns a true TEE claim — so the
 * display cannot claim one even if a caller passes evidence that does.
 */
export function creStatus(args: {
  mode: CreExecutionMode;
  organizationId: string | null;
  workflowBinaryHash: string | null;
  productionLimits: boolean;
  deployAccess: boolean | null;
  registries: ReadonlyArray<string>;
  officialSimulationRan: boolean;
}): CreStatus {
  const evidence = privacyEvidenceFor(args.mode, args.officialSimulationRan);
  // Refuse to render a display from evidence the mode cannot support.
  assertPrivacyEvidenceHonest(args.mode, evidence);

  const label = creModeLabel(args.mode);

  return CreStatusSchema.parse({
    mode: args.mode === "DEPLOYED_USER" ? "DEPLOYED TO A CHAINLINK DON" : "OFFICIAL CLI SIMULATION",
    executionMode: args.mode,
    account: args.mode === "SIMULATED_PLATFORM" ? "ContextLock internal session" : "Local user session",
    organizationId: args.organizationId,
    workflowBinary: args.workflowBinaryHash,
    productionLimits: args.productionLimits ? "ENABLED" : "DISABLED",
    donDeployment: label.don === "DEPLOYED" ? "YES" : "NO",
    hardwareTee: evidence.realTeeExecution ? "YES" : "NO",
    teeAttestation: evidence.teeAttestation ? "YES" : "NO",
    deployAccess: args.deployAccess === null ? "UNKNOWN" : args.deployAccess ? "ENABLED" : "NOT_ENABLED",
    registries: [...args.registries],
  });
}

/**
 * Refuse a display that overstates what ran.
 *
 * Two independent guards, because they are two different lies and each can be told without the
 * other: a simulation labelled as a DON deployment, and a TEE claimed with no attestation.
 */
export function assertCreDisplayHonest(status: CreStatus): void {
  if (isSimulated(status.executionMode) && status.donDeployment === "YES") {
    throw new CreLabError(
      CRE_LAB_REASONS.FALSE_DON,
      `${status.executionMode} runs the CRE CLI simulator. No DON participates, and a display saying otherwise is a false statement about where this workflow executed.`,
    );
  }
  if (status.hardwareTee === "YES" && status.teeAttestation === "NO") {
    throw new CreLabError(
      CRE_LAB_REASONS.FALSE_TEE,
      "a hardware TEE claim requires a verified attestation. Without one there is no evidence the code ran in a trusted execution environment, and 'we believe it did' is not a confidentiality guarantee.",
    );
  }
  if (isSimulated(status.executionMode) && status.hardwareTee === "YES") {
    throw new CreLabError(CRE_LAB_REASONS.FALSE_TEE, `${status.executionMode} is a local simulator process. There is no TEE.`);
  }
}

/**
 * Which mode the product offers a given installation.
 *
 * §P28.13: `SIMULATED_PLATFORM` stays internal while `BLK-CRE-PLATFORM-MULTITENANT` is open, and
 * the public architecture prefers `SIMULATED_USER`. `internalUse` is a required argument rather
 * than a default, so enabling the platform mode is a decision someone makes at a call site.
 */
export function defaultCreMode(internalUse: boolean): CreExecutionMode {
  if (!internalUse) return "SIMULATED_USER";
  try {
    assertPlatformSimulationAllowed(true);
    return "SIMULATED_PLATFORM";
  } catch {
    return "SIMULATED_USER";
  }
}

export function platformModeAvailability(): { availability: typeof PLATFORM_SIMULATION_AVAILABILITY; blocker: typeof PLATFORM_SIMULATION_BLOCKER; publicUse: false } {
  return { availability: PLATFORM_SIMULATION_AVAILABILITY, blocker: PLATFORM_SIMULATION_BLOCKER, publicUse: false };
}

/* ─────────────────────────── connection ─────────────────────────── */

/**
 * What travels from the Local Bridge to ContextLock.
 *
 * §P28.16 names what must never move: `~/.cre/cre.yaml`, in an export, a container, a sandbox, an
 * evidence file or a log. The schema below is the entire permitted payload — it has no token field,
 * no session field and no file path, so "upload the session" is not a shape this can express.
 */
export const CreConnectionInfoSchema = z.object({
  connected: z.boolean(),
  organizationId: z.string().nullable(),
  organizationName: z.string().nullable(),
  userEmail: z.string().nullable(),
  deployAccess: z.boolean().nullable(),
  registries: z.array(z.string()),
  cliVersion: z.string().nullable(),
  /** Where the credential lives. A path, stated so the user knows it did not move. */
  credentialLocation: z.literal("local user CRE directory"),
});
export type CreConnectionInfo = z.infer<typeof CreConnectionInfoSchema>;

/** Things ContextLock must never ask a user for, and never accept. */
export const NEVER_REQUESTED = ["email password", "OTP", "CRE session token", "cre.yaml", "API key for CRE", "seed phrase"] as const;

/** Field names that would mean a CRE session leaked into a payload. */
export const CRE_SESSION_FIELDS = ["creYaml", "cre_yaml", "sessionToken", "session_token", "accessToken", "access_token", "refreshToken", "idToken", "cookie", "authorization"] as const;

/**
 * Refuse a payload carrying a CRE session.
 *
 * Recursive, and applied to exports, container environments, evidence and logs — the four
 * destinations §P28.16 enumerates. The value is never included in the error; the point is to refuse
 * it, not to copy it somewhere else.
 */
export function assertNoCreSession(payload: unknown, destination: string, path: string[] = []): void {
  if (payload === null || typeof payload !== "object") {
    if (typeof payload === "string" && /\.cre\/cre\.ya?ml/.test(payload)) {
      throw new CreLabError(
        CRE_LAB_REASONS.SESSION_EXPORTED,
        `${destination}: a value at ${path.join(".") || "<root>"} references the local CRE session file. It stays on the user's machine — only sanitized connection information travels.`,
      );
    }
    return;
  }
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => assertNoCreSession(v, destination, [...path, String(i)]));
    return;
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (CRE_SESSION_FIELDS.some((f) => key.toLowerCase() === f.toLowerCase())) {
      throw new CreLabError(
        CRE_LAB_REASONS.SESSION_EXPORTED,
        `${destination}: the payload carries "${[...path, key].join(".")}". A CRE session never leaves the user's machine — not into an export, a container, a build sandbox, an evidence file or a log.`,
      );
    }
    assertNoCreSession(value, destination, [...path, key]);
  }
}

/* ─────────────────────────── promotion ─────────────────────────── */

/**
 * The artifact a promotion would deploy.
 *
 * §P28.20: build once, promote the exact artifact. Every hash is recorded at approval time and
 * rechecked immediately before deployment, because the gap between "this was approved" and "this is
 * being deployed" is where a silent recompile fits.
 */
export const PromotionArtifactSchema = z.object({
  workflowSourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  wasmSha256: z.string().regex(/^[0-9a-f]{64}$/),
  workflowConfigHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  blueprintRevision: z.number().int().nonnegative(),
  strategyRevision: z.number().int().nonnegative(),
  creCliVersion: z.string().min(1),
  /** Whether the approved simulation ran under production limits. A NONE run cannot gate this. */
  simulatedUnderProductionLimits: z.boolean(),
});
export type PromotionArtifact = z.infer<typeof PromotionArtifactSchema>;

/** CRE registries. `onchain:ethereum-mainnet` is deliberately absent from the permitted set. */
export const PERMITTED_REGISTRIES = ["private"] as const;
export const PROHIBITED_REGISTRIES = ["onchain:ethereum-mainnet", "onchain:ethereum", "onchain:mainnet"] as const;

/**
 * Which registry a promotion may use.
 *
 * §P28.22–23. The private registry's lifecycle is authorized by the CRE login session and needs no
 * mainnet RPC, no linked wallet and no registry gas — which is exactly why it fits a product that
 * prohibits mainnet writes. An onchain mainnet registry would require a mainnet transaction, and
 * that is the boundary, not a preference.
 *
 * The refusal reuses `PRODUCTION_NETWORK_WRITE_PROHIBITED` rather than inventing a CRE-specific
 * code, because it is the same prohibition arriving through a different door.
 */
export function assertRegistryAllowed(registry: string, context: string): void {
  if ((PERMITTED_REGISTRIES as readonly string[]).includes(registry)) return;

  const onchainMainnet = /^onchain:/.test(registry) && /mainnet|ethereum$/.test(registry);
  if (onchainMainnet || (PROHIBITED_REGISTRIES as readonly string[]).includes(registry)) {
    throw new CreLabError(
      CRE_LAB_REASONS.ONCHAIN_REGISTRY,
      `${context}: "${registry}" registers a workflow with an on-chain transaction on a production network. ContextLock does not write to production chains, and managing a CRE workflow is not an exception to that — the private registry is authorized by the CRE login session and needs no mainnet transaction.`,
    );
  }
  throw new CreLabError(
    CRE_LAB_REASONS.ONCHAIN_REGISTRY,
    `${context}: "${registry}" is not a permitted registry. Testnet Lab promotion uses the private registry.`,
  );
}

export interface PromotionAvailability {
  available: boolean;
  reason: string;
  /** Shown to the user. Deliberately not an error — no deploy access is a normal, complete state. */
  message: string;
  blocker: string | null;
}

/**
 * Whether "Promote to Chainlink CRE" is offered.
 *
 * §P28.18's requirement is a product one and worth honouring literally: absent deploy access is
 * **not** a failure and gets no red error. The Testnet Lab is complete without it. This returns a
 * message that says so.
 */
export function promotionAvailability(connection: CreConnectionInfo): PromotionAvailability {
  if (!connection.connected) {
    return {
      available: false,
      reason: "CRE_NOT_CONNECTED",
      message: "Connect your Chainlink CRE account to see whether real DON deployment is available. Your agent runs with the official CRE simulator either way.",
      blocker: null,
    };
  }
  if (connection.deployAccess !== true) {
    return {
      available: false,
      reason: CRE_LAB_REASONS.PROMOTION_UNAVAILABLE,
      message: "Your agent is running with the official CRE simulator. Real DON deployment is optional and requires Chainlink CRE Deploy Access.",
      blocker: "BLK-V2-CRE-DEPLOY",
    };
  }
  return { available: true, reason: "DEPLOY_ACCESS_ENABLED", message: "Real DON deployment is available for this account.", blocker: null };
}

/**
 * Recheck the artifact immediately before promotion.
 *
 * Six independent comparisons, each reported on its own, because a drift report naming only the
 * first difference sends someone round the loop once per field.
 */
export function assertArtifactUnchanged(approved: PromotionArtifact, current: PromotionArtifact, context: string): void {
  const drift: string[] = [];
  if (approved.wasmSha256 !== current.wasmSha256) drift.push(`WASM: approved ${approved.wasmSha256}, current ${current.wasmSha256}`);
  if (approved.workflowSourceHash !== current.workflowSourceHash) drift.push(`source: approved ${approved.workflowSourceHash}, current ${current.workflowSourceHash}`);
  if (approved.workflowConfigHash !== current.workflowConfigHash) drift.push(`config: approved ${approved.workflowConfigHash}, current ${current.workflowConfigHash}`);
  if (approved.blueprintRevision !== current.blueprintRevision) drift.push(`Blueprint revision: approved ${approved.blueprintRevision}, current ${current.blueprintRevision}`);
  if (approved.strategyRevision !== current.strategyRevision) drift.push(`Strategy revision: approved ${approved.strategyRevision}, current ${current.strategyRevision}`);
  if (approved.creCliVersion !== current.creCliVersion) drift.push(`CRE CLI: approved ${approved.creCliVersion}, current ${current.creCliVersion}`);

  if (drift.length > 0) {
    throw new CreLabError(
      CRE_LAB_REASONS.ARTIFACT_CHANGED,
      `${context}: the artifact is not the one that was approved.\n  ${drift.join("\n  ")}\nRebuild, retest and reapprove. Deploying a different artifact than the one reviewed makes the review a statement about something else.`,
    );
  }

  if (!current.simulatedUnderProductionLimits) {
    throw new CreLabError(
      CRE_LAB_REASONS.ARTIFACT_CHANGED,
      `${context}: the approved simulation did not run under production limits, so it did not test whether the workflow fits inside CRE's production constraints.`,
    );
  }
}

/**
 * A promoted CRE that stops answering.
 *
 * §P28.25 forbids the tempting behaviour: silently falling back to the simulator. The fallback is
 * available and correct — running the simulator is a legitimate mode — but doing it *silently*
 * changes the authority a decision was made under without anybody being told. So the financial
 * answer is to fail closed, and the mode change is an explicit user action that creates a new
 * runtime revision and a control-plane event.
 */
export function assertNoSilentFailover(deployedAvailable: boolean, requestedMode: CreExecutionMode, userSwitched: boolean, context: string): void {
  if (deployedAvailable) return;
  if (requestedMode !== "DEPLOYED_USER") return;
  if (userSwitched) return;
  throw new CreLabError(
    CRE_LAB_REASONS.DEPLOYED_UNAVAILABLE,
    `${context}: the deployed CRE workflow is unavailable. Financial action fails closed. Switching this Lab to CRE simulation is available and is an explicit choice — it creates a new runtime revision, a control-plane event and a different authority mode, and is labelled as such.`,
  );
}

/** Neither promotion nor failover changes the execution boundary. */
export function assertPromotionKeepsBoundary(executionChainId: number, context: string): void {
  if (isProductionChain(executionChainId)) {
    throw new CreLabError(
      CRE_LAB_REASONS.ONCHAIN_REGISTRY,
      `${context}: promoting the CRE workflow changes where the POLICY is evaluated. It does not change where the agent executes, and chain ${executionChainId} is a production network.`,
    );
  }
}

export type { CreExecutionMode, PrivacyEvidence };
