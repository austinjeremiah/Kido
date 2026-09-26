import type { Address } from "viem";
import { assertWriteAllowed, EnvironmentError, type DeploymentEnvironment } from "./environment.js";
import { manifestHash, type DeploymentManifest } from "./manifest.js";
import { assertCosted, validatePlan, WRITING_STEP_TYPES, type DeploymentPlan } from "./plan.js";
import { resolveReuse, type ReuseReport } from "./reuse.js";
import { aggregateByChain, quoteIsStale, type ChainFunding } from "./cost.js";
import type { ChainReader } from "./chain.js";
import {
  assertDeployAccess, assertLimitsSatisfied, assertQuotasOk, checkQuotas, CreError,
  creSupportsChain, selectRegistry,
  type CreArtifact, type CreQuotaSnapshot, type CreStatus, type LimitSimulationResult,
} from "./cre.js";
import { assertNoSecrets } from "./secrets.js";
import { buildApprovalScreen, type ApprovalScreen, type PreflightBlocker } from "./approval.js";

/**
 * The preflight run.
 *
 * Every check the addendum's test ladder (§22.17) names, in one place, producing either
 * PREFLIGHT_READY or PREFLIGHT_BLOCKED with a list of blockers a person can act on.
 *
 * The design decision worth stating: this function COLLECTS blockers rather than throwing on the
 * first. A preflight that fails fast makes the user fix one thing, re-run, discover the next, and
 * repeat — and each re-run costs RPC calls, a CRE build and their patience. The exceptions are the
 * checks that make the rest meaningless: an unverified reused contract, or a mainnet target.
 *
 * Nothing here writes. Not one function in the P22 package sends a transaction, deploys a workflow,
 * or starts a container. That is not an accident of the current implementation — it is the phase
 * boundary, and the orchestrator in P23 is the only thing that crosses it.
 */

export interface PreflightInput {
  manifest: DeploymentManifest;
  plan: DeploymentPlan;
  readers: Map<number, ChainReader>;
  /** Balance of each chain's designated gas holder, read live. */
  balances: Map<number, bigint>;
  creStatus: CreStatus | null;
  creArtifact: CreArtifact | null;
  creQuota: CreQuotaSnapshot | null;
  creLimits: LimitSimulationResult | null;
  requestedRegistry?: string;
  nowMs: number;
}

export interface PreflightResult {
  readiness: "PREFLIGHT_READY" | "PREFLIGHT_BLOCKED";
  blockers: PreflightBlocker[];
  reuse: ReuseReport;
  funding: ChainFunding[];
  screen: ApprovalScreen;
  registry: string | null;
  manifestHash: string;
}

const blocker = (code: string, detail: string, remedy: string): PreflightBlocker => ({ code, severity: "BLOCKER", detail, remedy });
const warning = (code: string, detail: string, remedy: string): PreflightBlocker => ({ code, severity: "WARNING", detail, remedy });

export async function runPreflight(input: PreflightInput): Promise<PreflightResult> {
  const { manifest: m, plan } = input;
  const blockers: PreflightBlocker[] = [];

  /* 1. Environment. Checked first and hardest: if the target is wrong, nothing downstream matters,
   *    and estimating gas for a mainnet deployment would be building the thing we refuse to do. */
  for (const step of plan.steps) {
    if (step.chainId !== null && WRITING_STEP_TYPES.has(step.type)) {
      try {
        assertWriteAllowed(m.environment, step.chainId);
      } catch (e) {
        const err = e as EnvironmentError;
        blockers.push(
          blocker(err.reason, `step "${step.id}": ${err.message}`, "Select a testnet environment. Mainnet writes are prohibited until Phase 27."),
        );
      }
    }
  }

  /* 2. Chain identity. An RPC labelled Sepolia that answers 84532 is a misconfiguration that would
   *    otherwise be discovered by a transaction landing on the wrong network. */
  for (const [chainId, reader] of input.readers) {
    try {
      const observed = await reader.getChainId();
      if (observed !== chainId) {
        blockers.push(
          blocker("ENV-CHAIN-ID-MISMATCH", `the RPC configured for chain ${chainId} reports chainId ${observed}`, `Point the chain-${chainId} RPC at the right network.`),
        );
      }
    } catch (e) {
      blockers.push(blocker("PREFLIGHT-RPC-UNREACHABLE", `chain ${chainId}: ${(e as Error).message}`, "Check the RPC endpoint and try again."));
    }
  }

  /* 3. Plan shape. */
  try {
    validatePlan(plan, new Set(m.requiredSigners.map((s) => s.signerId)));
  } catch (e) {
    blockers.push(blocker("PLAN-INVALID", (e as Error).message, "Regenerate the deployment plan."));
  }
  try {
    assertCosted(plan);
  } catch (e) {
    blockers.push(blocker("PLAN-MISSING-COST", (e as Error).message, "Run cost estimation before requesting approval."));
  }

  /* 4. Reuse. An unverified reuse is fatal to the whole preflight, not one line of it: every other
   *    check assumes the core contracts are the ones that were reviewed. */
  const reuse = await resolveReuse(m.contracts, input.readers);
  for (const r of reuse.rejected) {
    blockers.push(
      blocker(r.reason, r.detail, "Do not deploy against this address. Re-resolve the canonical deployment for this chain, or deploy a fresh core."),
    );
  }

  /* 5. Funding. Gas only; operating capital is a separate list with its own heading. */
  const chainMeta = new Map<number, { symbol: string; decimals: number; holder: Address }>();
  for (const c of m.environment.chains) {
    const gasHolder = m.requiredSigners.find((s) => s.role === "DEPLOYER" && s.chainIds.includes(c.chainId))?.address;
    if (gasHolder) chainMeta.set(c.chainId, { symbol: c.nativeSymbol, decimals: c.nativeDecimals, holder: gasHolder as Address });
  }
  const funding = aggregateByChain(plan.steps, chainMeta, input.balances);
  for (const f of funding) {
    if (!f.sufficient) {
      blockers.push(
        blocker(
          "COST-INSUFFICIENT-BALANCE",
          `chain ${f.chainId}: ${f.holder} holds ${f.balanceWei} wei, this deployment needs ${f.recommendedWei} wei (short by ${f.shortfallWei})`,
          `Fund ${f.holder} on chain ${f.chainId} with at least ${f.shortfallWei} wei of ${f.symbol}.`,
        ),
      );
    }
    if (quoteIsStale({ quotedAtMs: f.quotedAtMs }, input.nowMs)) {
      blockers.push(
        blocker("COST-QUOTE-STALE", `chain ${f.chainId}: fee quote taken at ${new Date(f.quotedAtMs).toISOString()} has expired`, "Refresh the cost estimate."),
      );
    }
    if (!f.fromLiveNode) {
      // A warning, not a blocker: a fork or local environment legitimately has no live fee market.
      // But it is stated, because a number labelled as an estimate that came from a fixture is a
      // different kind of number than one that came from a node.
      blockers.push(warning("COST-NOT-LIVE", `chain ${f.chainId}: at least one estimate did not come from a live node`, "Estimates from fixtures are shown as such and must not be presented as quotes."));
    }
  }

  /* 6. CRE. Only when the manifest actually contains a workflow — an agent with no CRE component
   *     must not be blocked by a CRE check it does not need. */
  let registry: string | null = null;
  if (m.creWorkflows.length > 0) {
    try {
      registry = selectRegistry(m.environment, input.requestedRegistry);
    } catch (e) {
      blockers.push(blocker((e as { reason?: string }).reason ?? "CRE-REGISTRY", (e as Error).message, "Use the private registry for testnet deployments."));
    }
    if (!input.creStatus) {
      blockers.push(blocker("CRE-NOT-CONNECTED", "no CRE connection has been established", "Connect Chainlink CRE via the Local Bridge."));
    } else {
      try {
        assertDeployAccess(input.creStatus);
      } catch (e) {
        blockers.push(
          blocker((e as CreError).reason, (e as Error).message, "Run `cre account access` to request deployment access for your organization. The build itself is unaffected."),
        );
      }
      for (const c of m.environment.chains) {
        if (c.chainSelector && !creSupportsChain(input.creStatus, c.chainSelector)) {
          blockers.push(
            blocker("CRE-CHAIN-UNSUPPORTED", `chain ${c.name} (selector ${c.chainSelector}) is not in this tenant's supported-chain list`, "Choose a chain CRE supports, or remove the CRE component."),
          );
        }
      }
    }
    if (!input.creArtifact) {
      blockers.push(blocker("CRE-NOT-BUILT", "the CRE workflow has not been built, so no binary hash can be pinned", "Run the CRE build step; approval is given against a specific binary."));
    }
    try {
      assertLimitsSatisfied(input.creLimits);
    } catch (e) {
      blockers.push(blocker((e as CreError).reason, (e as Error).message, "Run `cre workflow simulate --limits default` and resolve the violations."));
    }
    if (input.creQuota && input.creArtifact) {
      try {
        assertQuotasOk(
          checkQuotas(input.creQuota, {
            wasmBytes: input.creArtifact.wasmBytes,
            // Compression is measured by the deploy path, not assumed. Until it is, the raw size is
            // used, which can only over-report — the safe direction for a limit check.
            compressedWasmBytes: input.creArtifact.wasmBytes,
            configBytes: 0,
            triggerCount: 1,
          }),
        );
      } catch (e) {
        blockers.push(blocker((e as CreError).reason, (e as Error).message, "Reduce the workflow's size or free a workflow slot."));
      }
    } else if (!input.creQuota) {
      blockers.push(blocker("CRE-QUOTA-NOT-CAPTURED", "no CRE quota snapshot was captured for this tenant", "Re-run the CRE preflight; quotas are read, never assumed."));
    }
  }

  /* 7. Nothing secret in what we are about to persist and show. */
  try {
    assertNoSecrets(m, "manifest");
    assertNoSecrets(plan, "plan");
  } catch (e) {
    blockers.push(blocker("DEPLOY-SECRET-PRESENT", (e as Error).message, "Remove the credential. Deployment artifacts hold addresses and hashes only."));
  }

  const screen = buildApprovalScreen({
    manifest: m,
    plan,
    funding,
    cre:
      m.creWorkflows.length > 0
        ? {
            registry: registry ?? "(unresolved)",
            deployAccess: input.creStatus?.deployAccess ?? false,
            workflowSlots: {
              used: input.creQuota?.workflowsInUse ?? 0,
              allowed: input.creQuota?.maxWorkflowsPrivateRegistry ?? 0,
            },
            binaryHash: input.creArtifact?.binaryHash ?? "(not built)",
            workflowHash: input.creArtifact?.workflowHash ?? "(not built)",
            limitsSimulated: input.creLimits?.ran ?? false,
          }
        : null,
    blockers,
  });

  return {
    readiness: blockers.some((b) => b.severity === "BLOCKER") ? "PREFLIGHT_BLOCKED" : "PREFLIGHT_READY",
    blockers,
    reuse,
    funding,
    screen,
    registry,
    manifestHash: manifestHash(m),
  };
}
