import { z } from "zod";
import { assertNoSecrets, digestOf } from "@contextlock/studio-deploy";
import { TransactionRecordSchema } from "./receipts.js";

/**
 * The deployment receipt.
 *
 * What actually happened, written down so it can be checked by someone who was not there. Addresses,
 * hashes, transaction identifiers and costs — and nothing else, because a receipt is the artifact
 * most likely to be exported, pasted into an issue, or attached to a support ticket.
 *
 * `assertNoSecrets` runs on every receipt before it is persisted. Not as a belt-and-braces gesture:
 * the receipt is assembled from many sources over a long-running process, and the field nobody
 * thought about is the one that leaks.
 */

export const DeploymentReceiptSchema = z.object({
  schemaVersion: z.literal("contextlock.deployment-receipt/v1"),
  deploymentId: z.string().min(1),
  manifestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  planHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  approvedBy: z.string().min(1),
  approvedAtMs: z.number().int().positive(),

  environmentKind: z.string().min(1),
  chains: z.array(z.number().int().positive()),

  /** The account each write came from. An address, never a key. */
  walletAddresses: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),

  transactions: z.array(TransactionRecordSchema),
  contractAddresses: z.record(z.string(), z.string().regex(/^0x[0-9a-fA-F]{40}$/)),

  creWorkflowId: z.string().nullable(),
  creBinaryHash: z.string().nullable(),
  creRegistry: z.string().nullable(),
  creStatusAtDeploy: z.string().nullable(),

  runtimeImageDigest: z.string().nullable(),
  sbomDigest: z.string().nullable(),
  provenanceDigest: z.string().nullable(),

  /** Actual, summed. Kept beside the estimate rather than instead of it. */
  actualGasCostWeiByChain: z.record(z.string(), z.string().regex(/^\d+$/)),
  estimatedGasCostWeiByChain: z.record(z.string(), z.string().regex(/^\d+$/)),

  verifiedAtMs: z.number().int().positive().nullable(),
  verificationChecks: z.array(z.object({ id: z.string(), ok: z.boolean(), expected: z.string(), observed: z.string() })),

  /**
   * The states everything was left in.
   *
   * Recorded because a receipt that says "deployed" without saying "and disabled" invites the
   * reader to assume the agent is running.
   */
  finalStates: z.object({
    policy: z.literal("DISABLED"),
    runtime: z.literal("INACTIVE"),
    cre: z.string(),
    deployment: z.string(),
  }),
  generatedAtMs: z.number().int().positive(),
});
export type DeploymentReceipt = z.infer<typeof DeploymentReceiptSchema>;

export function sealReceipt(receipt: DeploymentReceipt): { receipt: DeploymentReceipt; digest: string } {
  assertNoSecrets(receipt, "deployment receipt");
  return { receipt, digest: digestOf(receipt) };
}

/**
 * The recovery document for a partial deployment.
 *
 * Not a rollback. Across an irreversible sequence there is nothing to roll back to — a contract that
 * has been created exists, and an image that has been published has been published. What an
 * operator needs instead is an inventory: what exists, what it cost, what is safe to leave, and
 * what must be dealt with by hand.
 *
 * Written in the same spirit as P19's ExecutionPlan, which has no ROLLBACK member for the same
 * reason: inventing one would be inventing a guarantee.
 */
export interface RecoveryPlan {
  deploymentId: string;
  /** Things that now exist on chain and cannot be removed. */
  irreversiblyCreated: Array<{ what: string; where: string; note: string }>;
  /** Things that can be re-run safely because they are idempotent configuration. */
  safelyRepeatable: string[];
  /** Things a person must decide about. */
  requiresHumanDecision: Array<{ what: string; why: string; options: string[] }>;
  /** Whether it is safe to simply resume, and why or why not. */
  resumable: boolean;
  resumeNote: string;
}

export function buildRecoveryPlan(args: {
  deploymentId: string;
  created: Array<{ name: string; address: string; chainId: number }>;
  unknownTransactions: Array<{ stepId: string; from: string; nonce: number; detail: string }>;
  configuredSteps: string[];
  crePublished: boolean;
  imagePublished: boolean;
}): RecoveryPlan {
  const irreversiblyCreated = args.created.map((c) => ({
    what: c.name,
    where: `${c.address} on chain ${c.chainId}`,
    note: "A deployed contract cannot be removed. It holds no authority unless a policy references it, and the policy for this deployment is disabled. Leaving it costs nothing; re-running the deployment would create a second one.",
  }));
  if (args.crePublished) {
    irreversiblyCreated.push({ what: "CRE workflow registration", where: "the private registry", note: "Registered and paused. Delete it with `cre workflow delete` if this deployment is abandoned; it consumes one of the organization's workflow slots until then." });
  }
  if (args.imagePublished) {
    irreversiblyCreated.push({ what: "runtime image", where: "the image registry, by digest", note: "Published images are immutable. An unused digest is inert — nothing runs it unless a runtime revision references it." });
  }

  const requiresHumanDecision = args.unknownTransactions.map((t) => ({
    what: `step "${t.stepId}"`,
    why: t.detail,
    options: [
      `Look up nonce ${t.nonce} on ${t.from} in a block explorer and identify what was mined.`,
      "If it was this step's transaction and it succeeded, mark the step verified from its receipt and resume.",
      "If it was this step's transaction and it reverted, resume; the step will be re-run against a nonce that is now free.",
      "Do NOT resubmit before answering this. A duplicate send here is a second deployment or a replaced transaction.",
    ],
  }));

  return {
    deploymentId: args.deploymentId,
    irreversiblyCreated,
    safelyRepeatable: args.configuredSteps,
    requiresHumanDecision,
    resumable: requiresHumanDecision.length === 0,
    resumeNote:
      requiresHumanDecision.length === 0
        ? "Every step's outcome is known. Resuming re-reads chain, CRE and runtime state, marks as complete only what it can independently verify, and continues from the first unsatisfied step."
        : `${requiresHumanDecision.length} transaction(s) have an unknown outcome. Resolve those first; the orchestrator will refuse to resubmit them.`,
  };
}
