import { z } from "zod";
import { digestOf } from "./hash.js";
import { manifestHash, pinnedArtifacts, type DeploymentManifest } from "./manifest.js";
import { deploymentPlanHash, type DeploymentPlan, type Readiness } from "./plan.js";
import type { ChainFunding } from "./cost.js";
import { quoteIsStale } from "./cost.js";

/**
 * Deployment approval.
 *
 * The moment a human takes responsibility, and therefore the moment worth being pedantic about.
 *
 * An approval records the exact hashes the person saw. Not "the plan was approved" — the manifest
 * hash, the plan hash, and every pinned artifact hash, stored individually. When the orchestrator
 * later asks "may I run this?", the question it actually answers is "is this the same thing?", and
 * a per-artifact record means the answer can name the artifact that changed rather than shrugging.
 *
 * The second property: an approval cannot be given for something the screen could not show. A
 * signer requirement referencing an unknown signer, a write step with no gas estimate, a stale fee
 * quote — each blocks approval, because a user cannot consent to a number that was not on screen.
 */

export const APPROVAL_REASONS = {
  NOT_READY: "APPROVAL-PLAN-NOT-READY",
  STALE_COSTS: "APPROVAL-COST-ESTIMATE-STALE",
  INSUFFICIENT_FUNDS: "APPROVAL-INSUFFICIENT-BALANCE",
  UNKNOWN_SIGNER: "APPROVAL-UNKNOWN-SIGNER-REQUIREMENT",
  MANIFEST_DRIFT: "APPROVAL-MANIFEST-CHANGED",
  PLAN_DRIFT: "APPROVAL-PLAN-CHANGED",
  ARTIFACT_DRIFT: "DEPLOYMENT_ARTIFACT_DRIFT",
  BLOCKED: "APPROVAL-PREFLIGHT-BLOCKED",
  NOT_APPROVED: "APPROVAL-ABSENT",
} as const;
export type ApprovalReason = (typeof APPROVAL_REASONS)[keyof typeof APPROVAL_REASONS];

export class ApprovalError extends Error {
  constructor(readonly reason: ApprovalReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ApprovalError";
  }
}

/* ─────────────────────────────── readiness machine ─────────────────────────────── */

/**
 * Legal readiness transitions.
 *
 * PREFLIGHT_BLOCKED goes back to RUNNING, never straight to READY: whatever blocked has to be
 * re-checked, not merely acknowledged. And DEPLOYMENT_APPROVED is terminal for this phase — P22
 * ends there, and getting out of it is P23's problem.
 */
const READINESS_TRANSITIONS: Record<Readiness, readonly Readiness[]> = {
  PREFLIGHT_DRAFT: ["PREFLIGHT_RUNNING"],
  PREFLIGHT_RUNNING: ["PREFLIGHT_BLOCKED", "PREFLIGHT_READY"],
  PREFLIGHT_BLOCKED: ["PREFLIGHT_RUNNING"],
  PREFLIGHT_READY: ["DEPLOYMENT_APPROVED", "PREFLIGHT_RUNNING"],
  DEPLOYMENT_APPROVED: [],
};

export function assertReadinessTransition(from: Readiness, to: Readiness): void {
  if (!READINESS_TRANSITIONS[from].includes(to)) {
    throw new ApprovalError(
      APPROVAL_REASONS.NOT_READY,
      `readiness cannot go ${from} -> ${to}; legal next states are [${READINESS_TRANSITIONS[from].join(", ") || "none"}]`,
    );
  }
}

/* ──────────────────────────────── blockers ──────────────────────────────── */

export const PreflightBlockerSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["BLOCKER", "WARNING"]),
  detail: z.string().min(1),
  /** What the user can actually do. A blocker with no remedy is a dead end with a code number. */
  remedy: z.string().min(1),
});
export type PreflightBlocker = z.infer<typeof PreflightBlockerSchema>;

/* ─────────────────────────── the approval screen model ─────────────────────────── */

/**
 * Exactly what §22.15 requires the user to see, as data.
 *
 * A model rather than a rendered string so the same object is what gets hashed into the approval.
 * If the UI drew something the model does not contain, the approval would be for a different
 * document than the one displayed.
 */
export interface ApprovalScreen {
  target: { environmentKind: string; chains: Array<{ chainId: number; name: string }> };
  contracts: { reused: number; configured: number; deployedNew: number; rows: Array<{ name: string; disposition: string; address: string | null }> };
  cre: {
    registry: string;
    deployAccess: boolean;
    workflowSlots: { used: number; allowed: number };
    binaryHash: string;
    workflowHash: string;
    limitsSimulated: boolean;
  } | null;
  runtime: { images: Array<{ agentId: string; tag: string; imageDigest: string | null }>; initialState: "INACTIVE" };
  funds: Array<{ chainId: number; symbol: string; baseWei: string; bufferWei: string; recommendedWei: string; balanceWei: string; sufficient: boolean }>;
  /** Operating capital, on its own list, with its own heading. Never summed with `funds`. */
  operatingAssets: Array<{ category: string; chainId: number; symbol: string; amount: string; purpose: string }>;
  security: {
    policyInitialState: "DISABLED";
    agentInitialState: "INACTIVE";
    creInitialState: "PAUSED";
    /**
     * Stated on the screen, verbatim, because it is the one thing a user is most likely to assume
     * wrongly: pausing the CRE workflow is not the kill switch. The onchain policy is.
     */
    notes: string[];
  };
  signers: Array<{ signerId: string; role: string; address: string | null; mode: string; authorizes: string }>;
  blockers: PreflightBlocker[];
  manifestHash: string;
  planHash: string;
}

export function buildApprovalScreen(args: {
  manifest: DeploymentManifest;
  plan: DeploymentPlan;
  funding: ChainFunding[];
  cre: ApprovalScreen["cre"];
  blockers: PreflightBlocker[];
}): ApprovalScreen {
  const { manifest: m, plan } = args;
  const reused = m.contracts.filter((c) => c.disposition === "REUSE_VERIFIED").length;
  const configured = m.contracts.filter((c) => c.disposition === "CONFIGURE_EXISTING").length;
  const deployedNew = m.contracts.filter((c) => c.disposition === "DEPLOY_NEW" || c.disposition === "CREATE_AGENT_SPECIFIC").length;
  return {
    target: { environmentKind: m.environment.kind, chains: m.environment.chains.map((c) => ({ chainId: c.chainId, name: c.name })) },
    contracts: {
      reused,
      configured,
      deployedNew,
      rows: m.contracts.map((c) => ({ name: c.name, disposition: c.disposition, address: c.address })),
    },
    cre: args.cre,
    runtime: { images: m.runtimeImages.map((i) => ({ agentId: i.agentId, tag: i.tag, imageDigest: i.imageDigest })), initialState: "INACTIVE" },
    funds: args.funding.map((f) => ({
      chainId: f.chainId,
      symbol: f.symbol,
      baseWei: f.baseWei.toString(),
      bufferWei: f.bufferWei.toString(),
      recommendedWei: f.recommendedWei.toString(),
      balanceWei: f.balanceWei.toString(),
      sufficient: f.sufficient,
    })),
    operatingAssets: m.requiredBalances
      .filter((b) => b.category !== "NATIVE_GAS")
      .map((b) => ({ category: b.category, chainId: b.chainId, symbol: b.symbol, amount: b.amount, purpose: b.purpose })),
    security: {
      policyInitialState: "DISABLED",
      agentInitialState: "INACTIVE",
      creInitialState: "PAUSED",
      notes: [
        "ContextLock financial policy is DISABLED for the whole of this deployment and stays disabled until a separate activation.",
        "CRE workflow pause is NOT trusted as the kill switch. Disabling the onchain ContextLock policy is what stops financial execution.",
        "Deploying does not activate. The agent will not be able to move value when this deployment finishes.",
      ],
    },
    signers: m.requiredSigners.map((s) => ({ signerId: s.signerId, role: s.role, address: s.address, mode: s.mode, authorizes: s.authorizes })),
    blockers: args.blockers,
    manifestHash: manifestHash(m),
    planHash: deploymentPlanHash(plan),
  };
}

/* ──────────────────────────────── approving ──────────────────────────────── */

/**
 * Approve a plan.
 *
 * Every precondition here is a way the screen could have shown the user something they cannot
 * meaningfully consent to. Approval is refused rather than warned about, because a warning on an
 * approval screen is a thing people click past.
 */
export function approve(args: {
  manifest: DeploymentManifest;
  plan: DeploymentPlan;
  screen: ApprovalScreen;
  approvedBy: string;
  nowMs: number;
}): DeploymentPlan {
  const { manifest: m, plan, screen } = args;

  assertReadinessTransition(plan.readiness, "DEPLOYMENT_APPROVED");

  const hardBlockers = screen.blockers.filter((b) => b.severity === "BLOCKER");
  if (hardBlockers.length > 0) {
    throw new ApprovalError(
      APPROVAL_REASONS.BLOCKED,
      `${hardBlockers.length} blocker(s) remain: ${hardBlockers.map((b) => b.code).join(", ")}`,
    );
  }

  for (const s of plan.steps) {
    if (s.cost && quoteIsStale({ quotedAtMs: s.cost.quotedAtMs }, args.nowMs)) {
      throw new ApprovalError(
        APPROVAL_REASONS.STALE_COSTS,
        `step "${s.id}" was costed at ${new Date(s.cost.quotedAtMs).toISOString()}, which is beyond the fee-quote lifetime; refresh the estimate before approving`,
      );
    }
  }

  const short = screen.funds.filter((f) => !f.sufficient);
  if (short.length > 0) {
    throw new ApprovalError(
      APPROVAL_REASONS.INSUFFICIENT_FUNDS,
      short.map((f) => `chain ${f.chainId}: has ${f.balanceWei} wei, needs ${f.recommendedWei} wei`).join("; "),
    );
  }

  const knownSigners = new Set(m.requiredSigners.map((s) => s.signerId));
  for (const s of plan.steps) {
    if (s.requiredSigner && !knownSigners.has(s.requiredSigner)) {
      throw new ApprovalError(APPROVAL_REASONS.UNKNOWN_SIGNER, `step "${s.id}" needs signer "${s.requiredSigner}"`);
    }
  }

  // The screen must describe THIS manifest and THIS plan. A screen built from an earlier revision
  // is the exact failure this whole mechanism exists to catch, so it is checked at the last moment.
  const mh = manifestHash(m);
  const ph = deploymentPlanHash(plan);
  if (screen.manifestHash !== mh) throw new ApprovalError(APPROVAL_REASONS.MANIFEST_DRIFT, `screen showed ${screen.manifestHash}, manifest is ${mh}`);
  if (screen.planHash !== ph) throw new ApprovalError(APPROVAL_REASONS.PLAN_DRIFT, `screen showed ${screen.planHash}, plan is ${ph}`);

  const artifactHashes: Record<string, string> = {};
  for (const a of pinnedArtifacts(m)) artifactHashes[`${a.kind}:${a.id}`] = a.hash;

  return {
    ...plan,
    readiness: "DEPLOYMENT_APPROVED",
    approval: { approvedBy: args.approvedBy, approvedAtMs: args.nowMs, manifestHash: mh, planHash: ph, artifactHashes },
  };
}

/**
 * Re-check an approval against current reality, immediately before executing.
 *
 * Called by P23 at the start of every resumed deployment. Returns the specific artifacts that
 * differ, so the operator sees "the CRE binary hash changed" rather than a generic refusal.
 */
export function approvalDrift(plan: DeploymentPlan, current: DeploymentManifest): string[] {
  if (!plan.approval) return ["no approval is recorded for this plan"];
  const drift: string[] = [];
  const mh = manifestHash(current);
  if (plan.approval.manifestHash !== mh) drift.push(`manifest: approved ${plan.approval.manifestHash}, now ${mh}`);
  const now = new Map(pinnedArtifacts(current).map((a) => [`${a.kind}:${a.id}`, a.hash]));
  for (const [key, hash] of Object.entries(plan.approval.artifactHashes)) {
    const cur = now.get(key);
    if (cur === undefined) drift.push(`${key}: was pinned at approval, is absent now`);
    else if (cur !== hash) drift.push(`${key}: approved ${hash}, now ${cur}`);
  }
  for (const [key, hash] of now) {
    if (!(key in plan.approval.artifactHashes)) drift.push(`${key}: present now (${hash}) but not part of the approval`);
  }
  return drift;
}

export function assertApprovedFor(plan: DeploymentPlan, current: DeploymentManifest): void {
  if (plan.readiness !== "DEPLOYMENT_APPROVED" || !plan.approval) {
    throw new ApprovalError(APPROVAL_REASONS.NOT_APPROVED, `plan ${plan.planId} is ${plan.readiness}`);
  }
  const drift = approvalDrift(plan, current);
  if (drift.length > 0) {
    throw new ApprovalError(
      APPROVAL_REASONS.ARTIFACT_DRIFT,
      `what would be deployed is no longer what was approved:\n  ${drift.join("\n  ")}`,
    );
  }
}

/** Digest of a screen, so what a user was shown can be evidenced later. */
export const approvalScreenDigest = (s: ApprovalScreen): string => digestOf(s);
