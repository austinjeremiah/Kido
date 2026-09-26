import { z } from "zod";
import type { Address, Hex } from "viem";
import { ForkDescriptorSchema, MarketSnapshotSchema } from "@contextlock/studio-reality";
import { CORE_CONTRACTS, FORK_ROLES } from "./chain.js";

/**
 * The durable record of a fork deployment.
 *
 * Everything a later reader needs to know what was deployed, where, from which Blueprint, and how
 * far it got. Stored as one JSON document on the deployment row so the shape can grow without a
 * migration, and parsed through this schema on every read so a drifted document fails loudly.
 */

export const FORK_DEPLOYMENT_STATES = ["DEPLOYING", "READY_TO_ACTIVATE", "STOPPED", "FAILED"] as const;
export const ForkDeploymentStateSchema = z.enum(FORK_DEPLOYMENT_STATES);
export type ForkDeploymentState = z.infer<typeof ForkDeploymentStateSchema>;

/**
 * The phases, in order.
 *
 * Shown in full on the Deploy screen before the button is pressed (§P28.29): the policy is
 * configured DISABLED as its own step, and activation is not on this list at all.
 */
export const FORK_DEPLOY_PHASES = [
  { key: "PREPARING_RELEASE", label: "Preparing release from the approved Blueprint" },
  { key: "FORKING_MAINNET", label: "Forking Ethereum mainnet at an exact block (local Anvil)" },
  { key: "VERIFYING_ANCHOR", label: "Verifying the fork anchor against an independent upstream read" },
  { key: "DEPLOYING_CONTRACTS", label: "Deploying the ContextLock core and this agent's consumer on the fork" },
  { key: "CONFIGURING_POLICY_DISABLED", label: "Configuring policy DISABLED" },
  { key: "OPENING_POSITION", label: "Opening the positions the agent guards on each protocol, and funding its vault" },
  { key: "TAKING_SNAPSHOT", label: "Sealing a market snapshot from the fork (reality test)" },
  { key: "VERIFYING_CONTRACTS", label: "Verifying contracts by reading the fork back" },
  { key: "STARTING_RUNTIME", label: "Starting the agent runtime (observing; policy still DISABLED)" },
  { key: "HEALTH_CHECKS", label: "Running health checks" },
  { key: "READY_TO_ACTIVATE", label: "READY TO ACTIVATE" },
] as const;
export type ForkDeployPhaseKey = (typeof FORK_DEPLOY_PHASES)[number]["key"];

export const PhaseStatusSchema = z.enum(["PENDING", "RUNNING", "DONE", "FAILED"]);
export const PhaseRecordSchema = z.object({
  key: z.string(),
  status: PhaseStatusSchema,
  startedAtMs: z.number().int().nullable(),
  finishedAtMs: z.number().int().nullable(),
  detail: z.string().nullable(),
});
export type PhaseRecord = z.infer<typeof PhaseRecordSchema>;

/* Typed as viem's template literals so a parsed record can be handed to a client without casts. */
const address = z.custom<Address>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v), "expected a 20-byte hex address");
const hex32 = z.custom<Hex>((v) => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v), "expected a 32-byte lowercase hex string");

export const SetupTransactionSchema = z.object({
  label: z.string(),
  hash: hex32,
  blockNumber: z.string().regex(/^\d+$/),
  gasUsed: z.string().regex(/^\d+$/),
  status: z.enum(["success", "reverted"]),
  /** Fixed. A setup transaction on the fork is a fork transaction like any other. */
  network: z.literal("LOCAL FORK TRANSACTION"),
});
export type SetupTransaction = z.infer<typeof SetupTransactionSchema>;

export const ForkPolicySchema = z.object({
  policyId: z.string(),
  policyVersion: z.number().int(),
  /** 6dp USD base units, as strings — bigint does not survive JSON. */
  autoLimit: z.string().regex(/^\d+$/),
  escalationLimit: z.string().regex(/^\d+$/),
  minHealthFactorBps: z.number().int(),
  targetHealthFactorBps: z.number().int(),
  /** Where the agent aims when it repays. Above the target so one action does not re-trigger. */
  restoreHealthFactorBps: z.number().int(),
  allowedActionKinds: z.array(z.string()),
  allowedTargets: z.array(address),
  maxValueHardCapWei: z.string().regex(/^\d+$/),
});
export type ForkPolicy = z.infer<typeof ForkPolicySchema>;

/** One protocol scenario the deployment opened, as its driver described it. */
export const ForkScenarioSchema = z.object({
  driverId: z.string(),
  protocol: z.string(),
  actionKind: z.string(),
  detail: z.string(),
});
export type ForkScenario = z.infer<typeof ForkScenarioSchema>;

export const ForkPositionSchema = z.object({
  user: address,
  vault: address,
  /** The relayer's balance at open, wei as a string: native ETH that arrives after is the treasury's. */
  ethBaselineWei: z.string().regex(/^\d+$/),
  scenarios: z.array(ForkScenarioSchema),
  /** Action kinds the Blueprint grants that the fork lab has no scenario for. Stated, not hidden. */
  unexercisedActionKinds: z.array(z.string()),
});
export type ForkPosition = z.infer<typeof ForkPositionSchema>;

export const ForkDeploymentRecordSchema = z.object({
  deploymentId: z.string(),
  projectId: z.string(),
  buildId: z.string().nullable(),
  blueprintRevision: z.number().int(),
  agentId: z.string(),
  ensName: z.string(),
  agentIdentityHash: hex32,
  ensNode: hex32,
  policyHash: hex32,
  upstream: z.object({
    providerId: z.string(),
    headBlock: z.string().regex(/^\d+$/).nullable(),
    forkBlock: z.string().regex(/^\d+$/).nullable(),
  }),
  fork: ForkDescriptorSchema.nullable(),
  contracts: z.record(z.enum(CORE_CONTRACTS), address).nullable(),
  roles: z.record(z.enum(FORK_ROLES), address),
  /**
   * Who signs escalations. STAND_IN is a key generated for this fork and held in memory; WALLET is
   * the operator's connected browser wallet, whose address was set as the approval registry's
   * approver at deployment and which signs the registry's EIP-712 digest in the browser. Neither is
   * a Ledger device (BLK-002), and every surface that names the signer says which it was.
   */
  approverMode: z.enum(["STAND_IN", "WALLET"]).default("STAND_IN"),
  policy: ForkPolicySchema,
  position: ForkPositionSchema.nullable(),
  snapshot: MarketSnapshotSchema.nullable(),
  phases: z.array(PhaseRecordSchema),
  setupTransactions: z.array(SetupTransactionSchema),
  /** Why the deployment stopped, when it did. Null on a deployment that reached the end. */
  failure: z.string().nullable(),
  /** Set when the fork process is gone: destroyed by an operator, or died with a previous server. */
  stoppedReason: z.string().nullable(),
});
export type ForkDeploymentRecord = z.infer<typeof ForkDeploymentRecordSchema>;

export function initialPhases(): PhaseRecord[] {
  return FORK_DEPLOY_PHASES.map((p) => ({ key: p.key, status: "PENDING", startedAtMs: null, finishedAtMs: null, detail: null }));
}
