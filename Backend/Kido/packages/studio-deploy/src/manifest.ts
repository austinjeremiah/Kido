import { z } from "zod";
import { DeploymentEnvironmentSchema } from "./environment.js";
import { digestOf } from "./hash.js";

/**
 * The DeploymentManifest.
 *
 * One immutable document that answers, before anything is deployed: what exactly goes where, which
 * key authorizes each part, what it costs, and what state everything starts in.
 *
 * Two properties do the work.
 *
 *   EVERY DEPLOYABLE ARTIFACT IS PINNED BY CONTENT HASH. Not by tag, not by version range, not by
 *   "latest". A tag is a mutable pointer, and a manifest that pins a tag is a manifest that
 *   describes whatever that tag pointed at last, which is not necessarily what was reviewed.
 *
 *   THE INITIAL STATES ARE PART OF THE DOCUMENT. `policyInitialState` and `runtimeInitialState` are
 *   fields, they are constrained to DISABLED/INACTIVE, and they are inside the hash. So "the agent
 *   deploys switched off" is not a convention the orchestrator is trusted to follow — it is a term
 *   of the approval, and an orchestrator that started it enabled would be executing a manifest
 *   nobody signed.
 */

export const DEPLOYMENT_MANIFEST_VERSION = "contextlock.deployment-manifest/v1" as const;

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "0x-prefixed 20-byte address");
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, "0x-prefixed 32-byte hash, lowercase");
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, "sha256:<hex> digest");

/**
 * How a contract entry gets satisfied.
 *
 * The default must never be DEPLOY_NEW. Redeploying the ContextLock core for every agent would
 * multiply the addresses a user has to trust by the number of agents they build, and each copy
 * would need its own verification. Reuse is the safe default; deploying is the exception that has
 * to justify itself.
 */
export const ContractDispositionSchema = z.enum([
  "REUSE_VERIFIED",
  "DEPLOY_NEW",
  "CONFIGURE_EXISTING",
  "CREATE_AGENT_SPECIFIC",
]);
export type ContractDisposition = z.infer<typeof ContractDispositionSchema>;

export const ManifestContractSchema = z.object({
  name: z.string().min(1),
  chainId: z.number().int().positive(),
  disposition: ContractDispositionSchema,
  /** Present for anything that already exists. Null only for DEPLOY_NEW/CREATE_AGENT_SPECIFIC. */
  address: hexAddress.nullable(),
  /**
   * keccak256 of the deployed runtime bytecode we expect at `address`.
   *
   * This is what makes REUSE_VERIFIED mean something. An address is a claim; the code hash is the
   * evidence. See reuse.ts — trusting an address without checking its code is how a user ends up
   * pointing an agent at a contract that shares a name with the one they reviewed.
   */
  runtimeCodeHash: hex32.nullable(),
  /** keccak256 of creation bytecode + constructor args, for anything being deployed. */
  creationCodeHash: hex32.nullable(),
  /** Compiler settings, so a verified reuse can be reproduced rather than merely asserted. */
  compiler: z.object({ solc: z.string(), optimizer: z.boolean(), runs: z.number().int(), evmVersion: z.string() }).nullable(),
});
export type ManifestContract = z.infer<typeof ManifestContractSchema>;

export const ManifestEnsSchema = z.object({
  name: z.string().min(1),
  node: hex32,
  chainId: z.number().int().positive(),
  resolver: hexAddress,
  /** The address the identity will bind to. Verified from chain state after the write, never inferred. */
  boundAgent: hexAddress,
});

export const ManifestCreWorkflowSchema = z.object({
  workflowName: z.string().min(1),
  /** `private` on testnets. `onchain:*` is refused before P27; see cre.ts. */
  registry: z.string().min(1),
  /** From `cre workflow hash`. The binary that will be deployed, not the source it came from. */
  binaryHash: z.string().min(16),
  configHash: z.string().min(16),
  workflowHash: z.string().min(16),
  /** sha256 of the reviewed source tree, so a source edit is detectable even if it rebuilds identically. */
  sourceTreeHash: sha256,
  creCliVersion: z.string().min(1),
  /** Deployed paused/inactive. A workflow that triggers before verification must find policy disabled. */
  initialState: z.literal("PAUSED"),
});
export type ManifestCreWorkflow = z.infer<typeof ManifestCreWorkflowSchema>;

export const ManifestRuntimeImageSchema = z.object({
  /** The agent security principal this image runs. One principal per image; see P24.1. */
  agentId: z.string().min(1),
  /** Human-facing label. Explicitly NOT what gets deployed. */
  tag: z.string().min(1),
  /**
   * The immutable digest. This is what the runtime provider is given.
   *
   * Null before the image exists — P22 plans the build, P23 performs it — but a manifest with a
   * null digest can never reach DEPLOYMENT_APPROVED for a step that runs the image.
   */
  imageDigest: sha256.nullable(),
  sbomDigest: sha256.nullable(),
  provenanceDigest: sha256.nullable(),
  vulnerabilityReportDigest: sha256.nullable(),
  baseImageDigest: sha256.nullable(),
});
export type ManifestRuntimeImage = z.infer<typeof ManifestRuntimeImageSchema>;

export const RequiredBalanceCategorySchema = z.enum([
  /** Gas. The only category that is actually a deployment fee. */
  "NATIVE_GAS",
  /** Test tokens the agent will operate on. Capital, not cost. */
  "TEST_PROTOCOL_ASSET",
  "BRIDGE_FEE",
  "CCIP_FEE_TOKEN",
  "TREASURY_SEED_ASSET",
]);
export type RequiredBalanceCategory = z.infer<typeof RequiredBalanceCategorySchema>;

export const RequiredBalanceSchema = z.object({
  category: RequiredBalanceCategorySchema,
  chainId: z.number().int().positive(),
  /** Null means the chain's native asset. */
  token: hexAddress.nullable(),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
  /** Integer base units, decimal string. Never a float — 0.1 ETH is not representable as one. */
  amount: z.string().regex(/^\d+$/),
  /** Which account must hold it. A balance requirement with no holder is unverifiable. */
  holder: hexAddress,
  /**
   * Why this is needed, in words a user can act on.
   *
   * Required, not optional, because §22.6 exists: a UI that shows "500 USDC" beside "0.003 ETH"
   * under one heading has told the user that operating capital is a deployment fee.
   */
  purpose: z.string().min(1),
});
export type RequiredBalance = z.infer<typeof RequiredBalanceSchema>;

export const SignerRequirementSchema = z.object({
  /** Stable id referenced by plan steps. */
  signerId: z.string().min(1),
  role: z.enum(["DEPLOYER", "POLICY_ADMIN", "CAPABILITY_ISSUER", "ENS_OWNER", "CRE_OWNER", "APPROVER"]),
  address: hexAddress.nullable(),
  mode: z.enum(["BROWSER_WALLET", "LOCAL_BRIDGE_WALLET"]),
  chainIds: z.array(z.number().int().positive()),
  /** What this signer is being asked to authorize, shown verbatim on the approval screen. */
  authorizes: z.string().min(1),
});
export type SignerRequirement = z.infer<typeof SignerRequirementSchema>;

export const DeploymentManifestSchema = z.object({
  schemaVersion: z.literal(DEPLOYMENT_MANIFEST_VERSION),
  manifestId: z.string().min(1),
  projectId: z.string().min(1),
  buildId: z.string().min(1),
  blueprintRevision: z.number().int().nonnegative(),
  buildRevision: z.number().int().nonnegative(),
  strategyHash: sha256,
  organizationHash: sha256.nullable(),
  /** The commit the reviewed source came from. Not decorative — post-deploy verification uses it. */
  gitCommit: z.string().regex(/^[0-9a-f]{7,40}$/),

  environment: DeploymentEnvironmentSchema,

  contracts: z.array(ManifestContractSchema),
  ens: z.array(ManifestEnsSchema),
  creWorkflows: z.array(ManifestCreWorkflowSchema),
  runtimeImages: z.array(ManifestRuntimeImageSchema),
  /** Adapters pinned by artifact hash as well as version; a version is a name, a hash is the thing. */
  adapters: z.array(z.object({ adapterId: z.string(), version: z.string().regex(/^\d+\.\d+\.\d+$/), artifactHash: sha256 })),

  authorizationModel: z.enum(["SINGLE_EOA", "SEPARATED_ROLES", "MULTISIG"]),
  requiredSigners: z.array(SignerRequirementSchema),

  requiredBalances: z.array(RequiredBalanceSchema),

  /**
   * The three initial states, inside the hash.
   *
   * Literal types, not enums with a permissive member. There is no representable manifest that says
   * "deploy this agent already enabled", which means no reviewer has to check for it.
   */
  policyInitialState: z.literal("DISABLED"),
  runtimeInitialState: z.literal("INACTIVE"),
  creInitialState: z.literal("PAUSED"),

  generatedAt: z.string().min(1),
});
export type DeploymentManifest = z.infer<typeof DeploymentManifestSchema>;

/**
 * Fields excluded from a manifest's identity.
 *
 * `generatedAt` and `manifestId` only. Everything else determines what happens, so everything else
 * is hashed — including the estimates, because an approval given against one cost estimate is not
 * an approval of a different one.
 *
 * The timestamp is excluded so that regenerating a manifest from unchanged inputs proves the inputs
 * are unchanged (DEP-PRE-001). If time were hashed, "deterministic" would be untestable.
 */
function manifestIdentity(m: DeploymentManifest) {
  const { generatedAt: _t, manifestId: _id, ...rest } = m;
  return rest;
}

export const manifestHash = (m: DeploymentManifest): string => digestOf(manifestIdentity(m));

/**
 * Everything the manifest pins, flattened.
 *
 * Used by post-deployment verification, which needs to compare reality against the manifest one
 * artifact at a time and report the specific one that differs — "the manifest does not match" is
 * not a usable thing to tell someone mid-deployment.
 */
export function pinnedArtifacts(m: DeploymentManifest): Array<{ kind: string; id: string; hash: string }> {
  const out: Array<{ kind: string; id: string; hash: string }> = [];
  out.push({ kind: "strategy", id: m.buildId, hash: m.strategyHash });
  if (m.organizationHash) out.push({ kind: "organization", id: m.buildId, hash: m.organizationHash });
  for (const c of m.contracts) {
    if (c.runtimeCodeHash) out.push({ kind: "contract-runtime-code", id: `${c.name}@${c.chainId}`, hash: c.runtimeCodeHash });
    if (c.creationCodeHash) out.push({ kind: "contract-creation-code", id: `${c.name}@${c.chainId}`, hash: c.creationCodeHash });
  }
  for (const w of m.creWorkflows) {
    out.push({ kind: "cre-binary", id: w.workflowName, hash: w.binaryHash });
    out.push({ kind: "cre-config", id: w.workflowName, hash: w.configHash });
    out.push({ kind: "cre-source", id: w.workflowName, hash: w.sourceTreeHash });
  }
  for (const i of m.runtimeImages) {
    if (i.imageDigest) out.push({ kind: "runtime-image", id: i.agentId, hash: i.imageDigest });
    if (i.sbomDigest) out.push({ kind: "runtime-sbom", id: i.agentId, hash: i.sbomDigest });
    if (i.provenanceDigest) out.push({ kind: "runtime-provenance", id: i.agentId, hash: i.provenanceDigest });
  }
  for (const a of m.adapters) out.push({ kind: "adapter", id: `${a.adapterId}@${a.version}`, hash: a.artifactHash });
  return out;
}
