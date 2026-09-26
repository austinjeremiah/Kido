import { z } from "zod";
import { lookupNetwork, isProductionChain, fenceWriteByChain } from "@contextlock/studio-network";

/**
 * The deploy gate, the cost display, and the activation order.
 *
 * §P28.29 states the rule this file exists to hold:
 *
 *     Never enable financial policy as part of opaque deployment progress.
 *
 * Deployment and activation are two decisions, taken at different moments by a person who has seen
 * different evidence. Group E made that structural — `READY_TO_ACTIVATE` is terminal and there is no
 * path from a deployment to an enabled policy. This is the product surface over it, and its job is
 * to make the two decisions look like two decisions.
 */

/* ─────────────────────────── the deploy gate ─────────────────────────── */

export const DeployGateSchema = z.object({
  label: z.string().min(1),
  status: z.enum(["PASS", "FAIL", "BLOCKED", "NOT_RUN"]),
  detail: z.string().min(1),
  /** A gate that is BLOCKED names the blocker; one that failed names the reason. */
  blocker: z.string().nullable(),
});
export type DeployGate = z.infer<typeof DeployGateSchema>;

export interface DeployReadiness {
  gates: DeployGate[];
  canDeploy: boolean;
  /** Every reason deployment is not offered, not just the first. */
  blockedBy: string[];
  executionNetwork: { chainId: number; name: string; role: string };
  mainnetWrites: "PROHIBITED";
  policyInitialState: "DISABLED";
}

export interface DeployInputs {
  architecturePassed: boolean;
  securityTestsPassed: boolean;
  creSimulationPassed: boolean;
  realityTestPassed: boolean;
  preflightPassed: boolean;
  executionChainId: number;
  runtimeImageDigest: string | null;
  estimatedGas: bigint | null;
  walletBalanceWei: bigint | null;
  requiredBalanceWei: bigint | null;
}

/**
 * Whether "Deploy to Testnet Lab" is offered, and why not when it is not.
 *
 * Returns every failing gate rather than the first. An operator who fixes one gate and re-runs to
 * discover the next loses a cycle per gate, and a screen that shows one problem at a time teaches
 * that there is only ever one problem.
 */
export function deployReadiness(input: DeployInputs): DeployReadiness {
  const gates: DeployGate[] = [];
  const push = (label: string, ok: boolean, detail: string, blocker: string | null = null): void => {
    gates.push({ label, status: ok ? "PASS" : blocker ? "BLOCKED" : "FAIL", detail, blocker });
  };

  push("Architecture", input.architecturePassed, input.architecturePassed ? "The Blueprint compiled and validated" : "The Blueprint has unresolved issues");
  push("Security tests", input.securityTestsPassed, input.securityTestsPassed ? "Deterministic simulations passed" : "Deterministic simulations have not passed");
  push("CRE simulation", input.creSimulationPassed, input.creSimulationPassed ? "The official Chainlink CRE CLI simulation passed under production limits" : "The official CRE simulation has not passed");
  push("Reality test", input.realityTestPassed, input.realityTestPassed ? "A market snapshot was produced and the strategy evaluated against it" : "No reality test has been run");
  push("Deployment preflight", input.preflightPassed, input.preflightPassed ? "The P22 preflight passed" : "The deployment preflight has not passed");

  const net = lookupNetwork(input.executionChainId);
  const networkOk = net !== null && net.role === "TESTNET_EXECUTION";
  push(
    "Execution network",
    networkOk,
    networkOk ? `${net.name} (${net.role})` : `chain ${input.executionChainId} is not an approved testnet execution network`,
  );

  push("Runtime image", input.runtimeImageDigest !== null, input.runtimeImageDigest ?? "No runtime image has been built");

  const balanceOk = input.walletBalanceWei !== null && input.requiredBalanceWei !== null && input.walletBalanceWei >= input.requiredBalanceWei;
  push(
    "Wallet balance",
    balanceOk,
    balanceOk
      ? `${formatEth(input.walletBalanceWei!)} available, ${formatEth(input.requiredBalanceWei!)} recommended`
      : input.walletBalanceWei === null
        ? "The deployer balance has not been read"
        : `${formatEth(input.walletBalanceWei)} available, ${formatEth(input.requiredBalanceWei ?? 0n)} recommended`,
  );

  // Not a gate that can fail — a statement of the boundary, shown alongside the gates because it is
  // the fact a reader most wants confirmed before pressing the button.
  gates.push({ label: "Mainnet writes", status: "PASS", detail: "PROHIBITED — no production chain is write-capable", blocker: null });
  gates.push({ label: "Policy", status: "PASS", detail: "WILL START DISABLED — activation is a separate decision", blocker: null });

  const blockedBy = gates.filter((g) => g.status !== "PASS").map((g) => g.label);
  return {
    gates,
    canDeploy: blockedBy.length === 0,
    blockedBy,
    executionNetwork: { chainId: input.executionChainId, name: net?.name ?? `chain ${input.executionChainId}`, role: net?.role ?? "unknown" },
    mainnetWrites: "PROHIBITED",
    policyInitialState: "DISABLED",
  };
}

const formatEth = (wei: bigint): string => `${(Number(wei) / 1e18).toFixed(6)} ETH`;

/* ─────────────────────────── cost ─────────────────────────── */

/**
 * The cost breakdown.
 *
 * §P28.27 asks for four things to be kept apart, and the fourth is the one that matters:
 * **never merge testnet faucet assets with real dollar capital.** Testnet ETH has no price, and a
 * screen that renders "0.0008 ETH ≈ $2.90" has invented a number and taught the user that the
 * testnet balance is money. Every figure below is denominated in the asset it is actually
 * denominated in, and `usdEquivalent` does not exist as a field.
 */
export const CostBreakdownSchema = z.object({
  deployment: z.object({
    estimatedGas: z.string().regex(/^\d+$/),
    estimatedWei: z.string().regex(/^\d+$/),
    safetyBufferPercent: z.number().int().nonnegative(),
    recommendedWei: z.string().regex(/^\d+$/),
    currentBalanceWei: z.string().regex(/^\d+$/).nullable(),
    /** The asset, named. Not "ETH" — the testnet's ETH. */
    asset: z.string().min(1),
    note: z.string().min(1),
  }),
  agentExecutionGas: z.object({ perActionEstimateWei: z.string().nullable(), asset: z.string(), note: z.string() }),
  modelUsage: z.object({ note: z.string() }),
  hostingAndCre: z.object({ note: z.string() }),
});
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;

export const DEPLOY_SAFETY_BUFFER_PERCENT = 20;

export function costBreakdown(args: {
  estimatedGas: bigint;
  gasPriceWei: bigint;
  currentBalanceWei: bigint | null;
  executionChainId: number;
  perActionGas?: bigint | null;
}): CostBreakdown {
  const net = lookupNetwork(args.executionChainId);
  const estimatedWei = args.estimatedGas * args.gasPriceWei;
  // Integer arithmetic throughout: a 20% buffer computed in floating point displayed itself as
  // 19.99% in Group E (FND-V2-E-003), and the fix was to stop leaving bigint.
  const recommendedWei = (estimatedWei * BigInt(100 + DEPLOY_SAFETY_BUFFER_PERCENT)) / 100n;
  const asset = `${net?.name ?? `chain ${args.executionChainId}`} ${net?.nativeSymbol ?? "ETH"}`;

  return CostBreakdownSchema.parse({
    deployment: {
      estimatedGas: args.estimatedGas.toString(),
      estimatedWei: estimatedWei.toString(),
      safetyBufferPercent: DEPLOY_SAFETY_BUFFER_PERCENT,
      recommendedWei: recommendedWei.toString(),
      currentBalanceWei: args.currentBalanceWei?.toString() ?? null,
      asset,
      note: "A one-time cost, paid in testnet gas. Testnet assets have no market value and are not shown with a dollar equivalent.",
    },
    agentExecutionGas: {
      perActionEstimateWei: args.perActionGas ? (args.perActionGas * args.gasPriceWei).toString() : null,
      asset,
      note: "Paid per action by the relayer, in the same testnet gas. Separate from the one-time deployment cost.",
    },
    modelUsage: { note: "Model tokens are billed separately and are not paid in any chain asset." },
    hostingAndCre: { note: "Runtime hosting and the CRE mode are separate from both. The official CRE simulator runs locally and costs no gas." },
  });
}

/** Fields a cost display must never carry for a testnet asset. Enumerated so absence is testable. */
export const FORBIDDEN_COST_FIELDS = ["usdEquivalent", "usdValue", "dollarValue", "fiatValue", "marketValue", "worth"] as const;

/* ─────────────────────────── deployment phases ─────────────────────────── */

/**
 * The visible phases of a deployment.
 *
 * `CONFIGURING_POLICY_DISABLED` is in the list and is shown, rather than being an implementation
 * detail. A user watching a progress bar should see the policy being configured *off* — it is the
 * single most reassuring step and it is invisible if the phases are summarised.
 */
export const DEPLOY_PHASES = [
  { key: "PREPARING_RELEASE", label: "Preparing release" },
  { key: "DEPLOYING_CONTRACTS", label: "Deploying testnet contracts" },
  { key: "CONFIGURING_POLICY_DISABLED", label: "Configuring policy DISABLED" },
  { key: "VERIFYING_CONTRACTS", label: "Verifying contracts" },
  { key: "BUILDING_RUNTIME", label: "Building runtime" },
  { key: "STARTING_CRE_SIMULATOR", label: "Starting CRE simulator" },
  { key: "STARTING_RUNTIME", label: "Starting agent runtime" },
  { key: "HEALTH_CHECKS", label: "Running health checks" },
  { key: "READY_TO_ACTIVATE", label: "READY TO ACTIVATE" },
] as const;

/* ─────────────────────────── activation ─────────────────────────── */

export const ACTIVATION_CHECKS = [
  "DEPLOYMENT_VERIFIED",
  "CURRENT_REVISION",
  "RUNTIME_HEALTHY",
  "CRE_MODE_CONFIRMED",
  "DATA_REQUIREMENTS_MET",
  "NO_CRITICAL_DRIFT",
  "TESTNET_SIGNER_PRESENT",
  "MAINNET_FENCES_INTACT",
] as const;
export type ActivationCheck = (typeof ACTIVATION_CHECKS)[number];

export const ACTIVATION_REASONS = {
  CHECK_FAILED: "ACTIVATION_CHECK_FAILED",
  POLICY_ENABLED_EARLY: "POLICY_ENABLED_BEFORE_CHECKS_COMPLETED",
  NOT_VERIFIED_FROM_CHAIN: "ACTIVATION_NOT_VERIFIED_FROM_CHAIN",
} as const;

export class ActivationError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ActivationError";
  }
}

export interface ActivationResult {
  checks: Array<{ check: ActivationCheck; passed: boolean; detail: string }>;
  policyEnabled: boolean;
  /** The block the enabled state was read at. Null means it was not verified from chain. */
  verifiedAtBlock: string | null;
}

/**
 * Activate, in order, with the policy last.
 *
 * §P28.31's ordering is the entire function. Every check runs and must pass **before** `enablePolicy`
 * is called, and the result is then read back from the chain rather than inferred from the call
 * having returned. A transaction that was submitted is not a policy that is enabled.
 *
 * `enablePolicy` and `readPolicyFromChain` are injected so this ordering can be tested without a
 * chain — and so a test can assert `enablePolicy` was *not* called when a check failed, which is a
 * stronger statement than asserting the function threw.
 */
export async function activate(args: {
  checks: Record<ActivationCheck, { passed: boolean; detail: string }>;
  executionChainId: number;
  enablePolicy: () => Promise<void>;
  readPolicyFromChain: () => Promise<{ enabled: boolean; blockNumber: string }>;
}): Promise<ActivationResult> {
  // The boundary, re-asserted at the last possible moment rather than trusted from earlier.
  if (isProductionChain(args.executionChainId)) {
    throw new ActivationError(ACTIVATION_REASONS.CHECK_FAILED, `chain ${args.executionChainId} is a production network and cannot be activated`);
  }
  fenceWriteByChain("DEPLOYMENT_PREFLIGHT", args.executionChainId);

  const results: ActivationResult["checks"] = [];
  const failed: string[] = [];
  for (const check of ACTIVATION_CHECKS) {
    const r = args.checks[check];
    results.push({ check, passed: r.passed, detail: r.detail });
    if (!r.passed) failed.push(`${check} (${r.detail})`);
  }

  if (failed.length > 0) {
    throw new ActivationError(
      ACTIVATION_REASONS.CHECK_FAILED,
      `${failed.length} activation check${failed.length > 1 ? "s" : ""} did not pass, so the ContextLock policy was not enabled: ${failed.join("; ")}`,
    );
  }

  // Last. Everything above has passed.
  await args.enablePolicy();

  /*
   * Read it back from the chain.
   *
   * §P28.31: "Then fresh chain read proves enabled." A submitted transaction is not an enabled
   * policy — it may revert, it may be replaced, it may still be pending. The only evidence that the
   * policy is enabled is the chain saying so.
   */
  const onChain = await args.readPolicyFromChain();
  if (!onChain.enabled) {
    throw new ActivationError(
      ACTIVATION_REASONS.NOT_VERIFIED_FROM_CHAIN,
      `the enable transaction was submitted and a fresh read at block ${onChain.blockNumber} reports the policy is still disabled. The agent is not active.`,
    );
  }

  return { checks: results, policyEnabled: true, verifiedAtBlock: onChain.blockNumber };
}

/**
 * The distinction the control panel exists to teach.
 *
 * §P28.45. Pausing a container stops the agent from *asking*. It does not remove the authority the
 * policy grants, and a paused runtime with an enabled policy is one `docker unpause` away from
 * acting. Returned as data so no screen has to remember to say it.
 */
export const CONTROL_SEMANTICS = {
  PAUSE_RUNTIME: {
    label: "Pause Runtime",
    kind: "OPERATIONAL" as const,
    effect: "The container stops. The agent cannot ask for anything.",
    doesNot: "This does NOT remove financial authority. The ContextLock policy stays enabled.",
  },
  DISABLE_POLICY: {
    label: "Disable Policy",
    kind: "FINANCIAL" as const,
    effect: "The ContextLock policy is disabled on chain. No capability can be issued.",
    doesNot: "This does not stop the container. The agent keeps running and is refused.",
  },
  EMERGENCY_LOCK: {
    label: "Emergency Lock",
    kind: "FINANCIAL" as const,
    effect: "Every financial control is applied in a fixed order, strongest first.",
    doesNot: "This is not a model decision and involves no model.",
  },
} as const;

export function assertPauseNotDescribedAsSecure(text: string): void {
  const claimsSecurity = /(secur|safe|protect|no risk|funds are safe)/i.test(text);
  const isPause = /pause/i.test(text) && !/polic/i.test(text);
  if (isPause && claimsSecurity) {
    throw new ActivationError(
      "PAUSE_DESCRIBED_AS_FINANCIAL_CONTROL",
      `"${text}" describes pausing a runtime as securing something. Pausing a container is an operational stop; the ContextLock policy is what carries financial authority, and it is unaffected.`,
    );
  }
}

/* ─────────────────────────── testnet token requirements ─────────────────────────── */

/**
 * The test assets a strategy needs before it can run.
 *
 * §P28.28 attaches two rules to this list and both are about what a balance means. **Do not
 * automatically request faucets** — a product that tops itself up teaches that the balance is a
 * detail rather than a thing the operator controls. And **no requirement may imply the tokens have
 * real market value**, which is why every row carries `realWorldValue: "NONE"` and no row has a
 * price field to fill in.
 */
export const TokenRequirementSchema = z.object({
  symbol: z.string().min(1),
  /** What it is needed for, in the strategy's terms rather than the chain's. */
  purpose: z.string().min(1),
  /** The network it is needed on, named with its role. */
  network: z.string().min(1),
  /** Where the user gets it. A statement, not a button. */
  source: z.string().min(1),
  /** Fixed. There is no value of this field that says a test token is worth something. */
  realWorldValue: z.literal("NONE"),
  /** Fixed. ContextLock never calls a faucet on the user's behalf. */
  automaticallyRequested: z.literal(false),
});
export type TokenRequirement = z.infer<typeof TokenRequirementSchema>;

export interface TokenRequirementsInput {
  executionChainId: number;
  /** Asset symbols the Blueprint's actions spend, in Blueprint order. */
  spendsAssets: ReadonlyArray<string>;
  /** Whether the deployment itself needs native gas. Effectively always true; stated, not assumed. */
  needsNativeGas: boolean;
}

export function tokenRequirements(input: TokenRequirementsInput): TokenRequirement[] {
  const net = lookupNetwork(input.executionChainId);
  const network = net ? `${net.name} — ${net.role.replace(/_/g, " ")}` : `chain ${input.executionChainId}`;
  const native = net?.nativeSymbol ?? "ETH";

  const rows: TokenRequirement[] = [];
  if (input.needsNativeGas) {
    rows.push({
      symbol: native,
      purpose: "Gas for deployment and for every action the agent takes",
      network,
      source: `A public ${net?.name ?? "testnet"} faucet. Request it yourself — ContextLock does not.`,
      realWorldValue: "NONE",
      automaticallyRequested: false,
    });
  }

  // Deduplicated, order preserved: the Blueprint's order is the order the user described them in.
  const seen = new Set<string>([native.toUpperCase()]);
  for (const symbol of input.spendsAssets) {
    const key = symbol.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      symbol,
      purpose: `The strategy spends ${symbol}, so the agent's account must hold it`,
      network,
      source: `A test ${symbol} faucet or a swap on ${net?.name ?? "the testnet"}. Request it yourself.`,
      realWorldValue: "NONE",
      automaticallyRequested: false,
    });
  }
  return rows;
}

/** The sentence that must accompany the list, kept here so no screen has to remember it. */
export const TESTNET_ASSET_NOTE =
  "These are test assets on a test network. They are not purchased, they are not held, and they are worth nothing. " +
  "No figure on this screen is denominated in money.";

/* ─────────────────────────── ready to activate ─────────────────────────── */

/**
 * The screen between a finished deployment and an agent with financial authority.
 *
 * §P28.30. Its six rows are the evidence for the decision the button below them takes, and the
 * important two are the last: the policy is DISABLED and mainnet execution is IMPOSSIBLE. Both are
 * true at this moment and one of them is about to change — which is the whole reason this is a
 * screen rather than the tail of a progress bar.
 */
export const ActivationReadinessRowSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  status: z.enum(["READY", "NOT_READY", "STATEMENT"]),
  detail: z.string().min(1),
});
export type ActivationReadinessRow = z.infer<typeof ActivationReadinessRowSchema>;

export interface ActivationReadiness {
  rows: ActivationReadinessRow[];
  canActivate: boolean;
  blockedBy: string[];
  /** What pressing the button does, stated before it is pressed. */
  consequence: string;
  buttonLabel: "ACTIVATE TESTNET AGENT";
}

export interface ActivationReadinessInput {
  contractsVerified: boolean;
  runtimeHealthy: boolean;
  creSimulatorHealthy: boolean;
  realityDataHealthy: boolean;
  policyEnabled: boolean;
  executionChainId: number;
}

export function activationReadiness(input: ActivationReadinessInput): ActivationReadiness {
  const rows: ActivationReadinessRow[] = [
    { label: "Contracts", value: input.contractsVerified ? "VERIFIED" : "NOT VERIFIED", status: input.contractsVerified ? "READY" : "NOT_READY", detail: input.contractsVerified ? "Source verified against the deployed bytecode" : "The deployed contracts have not been verified" },
    { label: "Runtime", value: input.runtimeHealthy ? "HEALTHY" : "NOT HEALTHY", status: input.runtimeHealthy ? "READY" : "NOT_READY", detail: input.runtimeHealthy ? "The agent container is running and passing health checks" : "The agent container is not reporting healthy" },
    { label: "CRE", value: input.creSimulatorHealthy ? "SIMULATOR HEALTHY" : "SIMULATOR NOT HEALTHY", status: input.creSimulatorHealthy ? "READY" : "NOT_READY", detail: input.creSimulatorHealthy ? "The official CRE simulator responds and evaluates the workflow" : "The CRE simulator is not responding" },
    { label: "Reality data", value: input.realityDataHealthy ? "HEALTHY" : "DEGRADED", status: input.realityDataHealthy ? "READY" : "NOT_READY", detail: input.realityDataHealthy ? "Verified market data is fresh and within its age bound" : "At least one required data source is unavailable or stale" },
  ];

  /*
   * The policy row is READY when the policy is DISABLED — the inversion is deliberate.
   *
   * Arriving here with the policy already enabled means something enabled it outside activation,
   * and that is a reason to stop rather than a head start.
   */
  rows.push({
    label: "Policy",
    value: input.policyEnabled ? "ALREADY ENABLED" : "DISABLED",
    status: input.policyEnabled ? "NOT_READY" : "READY",
    detail: input.policyEnabled
      ? "The ContextLock policy is already enabled. Activation enables it last, so something else did — find out what before continuing."
      : "The agent holds no financial authority. Activation is what grants it.",
  });

  const production = isProductionChain(input.executionChainId);
  rows.push({
    label: "Mainnet execution",
    value: production ? "POSSIBLE — STOP" : "IMPOSSIBLE",
    status: production ? "NOT_READY" : "STATEMENT",
    detail: production
      ? `chain ${input.executionChainId} is a production network and must never be an execution target`
      : "No production chain is write-capable, at any layer, in any mode.",
  });

  const blockedBy = rows.filter((r) => r.status === "NOT_READY").map((r) => r.label);
  return {
    rows,
    canActivate: blockedBy.length === 0,
    blockedBy,
    consequence:
      "This enables the ContextLock policy on chain, last, after every check above is re-run. " +
      "From that moment the agent can obtain capabilities and act on the testnet within its limits.",
    buttonLabel: "ACTIVATE TESTNET AGENT",
  };
}
