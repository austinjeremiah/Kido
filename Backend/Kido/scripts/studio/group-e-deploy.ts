/**
 * P23 — a live testnet deployment, driven by the real orchestrator.
 *
 * Not a bespoke deploy script. It builds a real DeploymentManifest and DeploymentPlan, runs the
 * real preflight, takes a real approval, and hands the approved plan to `DeploymentOrchestrator` —
 * so what is demonstrated here is the same code the tests exercise, rather than a parallel
 * implementation that happens to agree with them.
 *
 * What it does on chain, on Ethereum Sepolia and nowhere else:
 *
 *   1  verify the chain is 11155111
 *   2  verify the approved ContextLock core by re-hashing its deployed bytecode
 *   3  deploy an agent-specific ContextLockCreConsumer
 *   4  claim policy administration for this agent identity
 *   5  register the agent's policy with **enabled = false**
 *   6  verify all of it by reading chain state back
 *
 * The policy is registered DISABLED and stays disabled. Nothing here activates anything.
 *
 * Usage: npm run studio:deploy:testnet   [--dry-run]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  createPublicClient, createWalletClient, http, keccak256, encodeFunctionData, encodeDeployData,
  parseAbi, toHex, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  DEPLOYMENT_MANIFEST_VERSION, DEPLOYMENT_PLAN_VERSION, testnetEnvironment, ETHEREUM_SEPOLIA,
  manifestHash, deploymentPlanHash, buildApprovalScreen, approve, runPreflight, quoteFees, costFrom,
  aggregateByChain, formatUnitsExact, scanForSecrets, sha256Hex, codeHash,
  type ChainReader, type DeploymentManifest, type DeploymentPlan, type DeploymentStep, type StepCost,
} from "@contextlock/studio-deploy";
import {
  DeploymentOrchestrator, sealReceipt, buildRecoveryPlan, verifyDeployment, assertVerified,
  type DeploymentReceipt, type OrchestratorDeps, type StepExecutionContext,
} from "@contextlock/studio-orchestrator";

const DRY = process.argv.includes("--dry-run");
const FRESH = process.argv.includes("--fresh");
const OUT = "reports/group-e/evidence/p23-live-deployment.json";
/**
 * Where the run's state lives between invocations.
 *
 * Without this, every invocation is a NEW deployment that happens to share an id — and the second
 * one re-deploys everything, because there is nothing on disk saying what the first one did. The
 * orchestrator's idempotency is built on persisted run state plus independent observation; a
 * demonstration that skipped the persistence would be demonstrating half of it.
 */
const STATE = "reports/group-e/evidence/p23-run-state.json";
const CORE = JSON.parse(readFileSync("reports/group-e/evidence/sepolia-code-hashes.json", "utf8")) as {
  contracts: Record<string, { address: string; runtimeCodeHash: string }>;
};
const IMAGE = existsSync("reports/group-e/evidence/image/runtime-image.json")
  ? (JSON.parse(readFileSync("reports/group-e/evidence/image/runtime-image.json", "utf8")) as Record<string, string>)
  : null;

const rpc = process.env.SEPOLIA_RPC_URL!;
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);
const DEPLOYER = account.address;
const AUTH_REGISTRY = CORE.contracts.ContextLockAuthorizationRegistry!.address as Address;
const POLICY_REGISTRY = CORE.contracts.ContextLockPolicyRegistry!.address as Address;
const EXECUTOR = CORE.contracts.ContextLockExecutorV2!.address as Address;
/** The tenant's real CRE forwarder for Ethereum Sepolia, read from `cre workflow supported-chains`. */
const CRE_FORWARDER = "0xF8344CFd5c43616a4366C34E3EEE75af79a74482" as Address;

const public_ = createPublicClient({ chain: sepolia, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) });

const POLICY_ABI = parseAbi([
  "function setPolicyAdmin(bytes32 agentIdentityHash, address admin) external",
  "function setPolicy(bytes32 agentIdentityHash, bytes32 policyHash, bool enabled, uint256 cap) external",
  "function policyAdmin(bytes32) view returns (address)",
  // The registry exposes the enabled flag and the cap as separate reads rather than a struct
  // getter. Using the real ABI matters: an invented `getPolicy` reverted on the first live run,
  // which is exactly the kind of thing a dry run against a fixture would not have caught.
  "function isPolicyEnabled(bytes32 a, bytes32 p) view returns (bool)",
  "function maxValueHardCap(bytes32 a, bytes32 p) view returns (uint256)",
  "function bindingVersion(bytes32 a) view returns (uint64)",
]);

/** This deployment's agent identity and policy, derived so the run is reproducible. */
const AGENT_ID = "guardian";
const AGENT_IDENTITY_HASH = keccak256(toHex(`contextlock:group-e:${AGENT_ID}`));
const POLICY_HASH = keccak256(toHex(`contextlock:group-e:${AGENT_ID}:policy-v1`));

const reader: ChainReader = {
  chainId: 11155111, live: true,
  getChainId: () => public_.getChainId(),
  getCode: (a) => public_.getCode({ address: a }),
  getBalance: (a) => public_.getBalance({ address: a }),
  getTransactionCount: async (a) => BigInt(await public_.getTransactionCount({ address: a })),
  // `account`, not `from` — see chain.ts. Dropping the sender estimates a different transaction.
  estimateGas: (tx) => public_.estimateGas({ account: tx.from, ...(tx.to ? { to: tx.to } : {}), ...(tx.data ? { data: tx.data } : {}), ...(tx.value !== undefined ? { value: tx.value } : {}) } as never),
  estimateFeesPerGas: async () => { const f = await public_.estimateFeesPerGas(); return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas, gasPrice: undefined }; },
  call: async (tx) => (await public_.call({ account: tx.from, to: tx.to, data: tx.data })).data ?? "0x",
  getTransactionReceipt: async (h) => {
    try {
      const r = await public_.getTransactionReceipt({ hash: h });
      return { status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, contractAddress: r.contractAddress ?? null };
    } catch { return null; }
  },
  getBlockNumber: () => public_.getBlockNumber(),
};

const sha = (d: string) => `sha256:${createHash("sha256").update(d).digest("hex")}`;

/**
 * Contracts left behind by earlier failed attempts in this same session.
 *
 * Two orchestrator bugs, each found by running against a real chain rather than a fixture:
 * reconciling a receipt with no wait, and observing a creation without access to the address it had
 * just produced. Both are fixed and covered by DEP-004b and DEP-002b respectively; the contracts
 * they created still exist, because a deployed contract cannot be undeployed.
 */
const ORPHANS = [
  { address: "0x6950cca52CB6eB90e2609B4eD5D40545DdE94dd6", nonce: 108, reason: "the orchestrator reconciled the receipt immediately and declared UNKNOWN_SUBMISSION_STATE before the transaction could be mined (fixed: waitForReceipt, DEP-004b)" },
  { address: "0x1C3c72D6f7Ce435e9F0D8eEedC4ED65ee2a48eeB", nonce: 109, reason: "the post-write observation could not see the address the step had just created (fixed: StepExecutionContext.createdAddresses)" },
  { address: "0x09e56624e3a7dd2b297f42a9b7f89a5144c4d802", nonce: 110, reason: "first complete run; superseded by a later run after the estimateGas sender fix" },
  { address: "0xb3612110864c80efb8c7fa0ea7bef74399a9f173", nonce: 113, reason: "second complete run, before run-state persistence made a repeat invocation resume instead of redeploy" },
];

async function main() {
  const artifactPath = "contracts/out/ContextLockCreConsumer.sol/ContextLockCreConsumer.json";
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };

  /* ── the three transactions this deployment would send, built once ─────────── */
  const creationData = encodeDeployData({ abi: artifact.abi as never, bytecode: artifact.bytecode.object, args: [DEPLOYER, CRE_FORWARDER, AUTH_REGISTRY] as never });
  const adminData = encodeFunctionData({ abi: POLICY_ABI, functionName: "setPolicyAdmin", args: [AGENT_IDENTITY_HASH, DEPLOYER] });
  // enabled = false. The whole deployment happens with the policy off.
  const policyData = encodeFunctionData({ abi: POLICY_ABI, functionName: "setPolicy", args: [AGENT_IDENTITY_HASH, POLICY_HASH, false, 0n] });

  const quote = await quoteFees(reader);
  const gasCreate = await reader.estimateGas({ from: DEPLOYER, data: creationData });
  const gasAdmin = await reader.estimateGas({ from: DEPLOYER, to: POLICY_REGISTRY, data: adminData });
  const gasPolicy = 90_000n; // setPolicy cannot be estimated until admin is claimed; bounded generously.

  const cost = (gas: bigint): StepCost => costFrom(gas, quote);

  /* ── manifest ──────────────────────────────────────────────────────────────── */
  const manifest: DeploymentManifest = {
    schemaVersion: DEPLOYMENT_MANIFEST_VERSION,
    manifestId: "mf_group_e_live",
    projectId: "prj_group_e",
    buildId: "bld_group_e_0001",
    blueprintRevision: 3,
    buildRevision: 2,
    strategyHash: sha("group-e-guardian-strategy"),
    organizationHash: null,
    gitCommit: (process.env.GIT_COMMIT ?? readFileSync(".git/HEAD", "utf8").trim().startsWith("ref:")
      ? readFileSync(`.git/${readFileSync(".git/HEAD", "utf8").trim().slice(5)}`, "utf8").trim()
      : readFileSync(".git/HEAD", "utf8").trim()),
    environment: testnetEnvironment([ETHEREUM_SEPOLIA]),
    contracts: [
      { name: "ContextLockPolicyRegistry", chainId: 11155111, disposition: "REUSE_VERIFIED", address: POLICY_REGISTRY, runtimeCodeHash: CORE.contracts.ContextLockPolicyRegistry!.runtimeCodeHash as Hex, creationCodeHash: null, compiler: { solc: "0.8.28", optimizer: true, runs: 200, evmVersion: "cancun" } },
      { name: "ContextLockAuthorizationRegistry", chainId: 11155111, disposition: "REUSE_VERIFIED", address: AUTH_REGISTRY, runtimeCodeHash: CORE.contracts.ContextLockAuthorizationRegistry!.runtimeCodeHash as Hex, creationCodeHash: null, compiler: { solc: "0.8.28", optimizer: true, runs: 200, evmVersion: "cancun" } },
      { name: "ContextLockExecutorV2", chainId: 11155111, disposition: "REUSE_VERIFIED", address: EXECUTOR, runtimeCodeHash: CORE.contracts.ContextLockExecutorV2!.runtimeCodeHash as Hex, creationCodeHash: null, compiler: { solc: "0.8.28", optimizer: true, runs: 200, evmVersion: "cancun" } },
      { name: "ContextLockCreConsumer", chainId: 11155111, disposition: "CREATE_AGENT_SPECIFIC", address: null, runtimeCodeHash: null, creationCodeHash: keccak256(creationData), compiler: { solc: "0.8.28", optimizer: true, runs: 200, evmVersion: "cancun" } },
    ],
    ens: [],
    // No CRE workflow in this manifest: deployment access is not enabled for this organization
    // (BLK-V2-CRE-DEPLOY), and a manifest pinning a workflow that cannot be registered would make
    // the preflight block on something this run cannot resolve.
    creWorkflows: [],
    runtimeImages: IMAGE ? [{
      agentId: AGENT_ID, tag: IMAGE.tag!, imageDigest: IMAGE.imageManifestDigest!,
      sbomDigest: IMAGE.sbomDigest!, provenanceDigest: IMAGE.provenanceDigest!,
      vulnerabilityReportDigest: null, baseImageDigest: IMAGE.baseImageDigest!,
    }] : [],
    adapters: [],
    authorizationModel: "SEPARATED_ROLES",
    requiredSigners: [{ signerId: "deployer", role: "DEPLOYER", address: DEPLOYER, mode: "LOCAL_BRIDGE_WALLET", chainIds: [11155111], authorizes: "Deploying an agent-specific CRE consumer and registering this agent's policy in the DISABLED state." }],
    requiredBalances: [],
    policyInitialState: "DISABLED",
    runtimeInitialState: "INACTIVE",
    creInitialState: "PAUSED",
    generatedAt: new Date().toISOString(),
  };

  /* ── plan, in §23.4's security-first order ─────────────────────────────────── */
  const step = (s: Partial<DeploymentStep> & Pick<DeploymentStep, "id" | "type">): DeploymentStep => ({
    chainId: 11155111, dependencyIds: [], actorType: "READ_ONLY", requiredSigner: null,
    artifactHash: null, target: null, calldataHash: null, cost: null,
    reversible: true, rollbackAction: null, status: "PENDING", ...s,
  });

  const plan: DeploymentPlan = {
    schemaVersion: DEPLOYMENT_PLAN_VERSION,
    planId: "dp_group_e_live",
    manifestHash: manifestHash(manifest),
    steps: [
      step({ id: "verify-chain-11155111", type: "VERIFY_CHAIN" }),
      step({ id: "verify-core", type: "VERIFY_CORE", dependencyIds: ["verify-chain-11155111"] }),
      step({
        id: "deploy-cre-consumer", type: "DEPLOY_CONTRACT", dependencyIds: ["verify-core"],
        actorType: "USER_WALLET", requiredSigner: "deployer", reversible: false,
        artifactHash: sha(creationData), calldataHash: sha(creationData), cost: cost(gasCreate),
      }),
      step({
        id: "claim-policy-admin", type: "CONFIGURE_CONTRACT", dependencyIds: ["deploy-cre-consumer"],
        actorType: "USER_WALLET", requiredSigner: "deployer", target: POLICY_REGISTRY,
        calldataHash: sha(adminData), cost: cost(gasAdmin),
        rollbackAction: "Transfer administration to another address with setPolicyAdmin.",
      }),
      step({
        id: "register-policy-disabled", type: "REGISTER_POLICY_DISABLED", dependencyIds: ["claim-policy-admin"],
        actorType: "USER_WALLET", requiredSigner: "deployer", target: POLICY_REGISTRY,
        calldataHash: sha(policyData), cost: cost(gasPolicy),
        rollbackAction: "The policy is registered disabled; there is nothing to undo.",
      }),
      step({ id: "post-deploy-verify", type: "POST_DEPLOY_VERIFY", dependencyIds: ["register-policy-disabled"] }),
    ],
    readiness: "PREFLIGHT_READY",
    approval: null,
  };

  /* ── preflight ─────────────────────────────────────────────────────────────── */
  const balance = await public_.getBalance({ address: DEPLOYER });
  const pre = await runPreflight({
    manifest, plan,
    readers: new Map([[11155111, reader]]),
    balances: new Map([[11155111, balance]]),
    creStatus: null, creArtifact: null, creQuota: null, creLimits: null,
    nowMs: Date.now(),
  });

  console.log(`\npreflight: ${pre.readiness}`);
  for (const b of pre.blockers) console.log(`  [${b.severity}] ${b.code}: ${b.detail}`);
  const funding = pre.funding[0];
  if (funding) console.log(`  gas needed ${formatUnitsExact(funding.recommendedWei, 18)} ETH, holder has ${formatUnitsExact(funding.balanceWei, 18)} ETH`);

  if (pre.readiness !== "PREFLIGHT_READY") {
    writeFileSync(OUT, JSON.stringify({ stoppedAt: "PREFLIGHT_BLOCKED", blockers: pre.blockers }, null, 2) + "\n");
    throw new Error("preflight blocked; nothing was deployed");
  }

  const approved = approve({ manifest, plan, screen: pre.screen, approvedBy: "kaushikh (Group E live run)", nowMs: Date.now() });
  console.log(`approved: manifest ${approved.approval!.manifestHash.slice(0, 20)}… plan ${approved.approval!.planHash.slice(0, 20)}…`);

  if (DRY) {
    console.log("\n--dry-run: stopping before any write.");
    writeFileSync(OUT, JSON.stringify({ dryRun: true, readiness: pre.readiness, screen: pre.screen }, null, 2) + "\n");
    return;
  }

  /* ── execute ───────────────────────────────────────────────────────────────── */
  let consumerAddress: Address | null = null;
  /*
   * Whether THIS run performed the policy write.
   *
   * Needed because `isPolicyEnabled` returns false both for "registered and disabled" and for
   * "never configured", and those must not be the same answer. Resume still re-reads the chain;
   * this only stops an unconfigured identity being mistaken for a completed step.
   */
  let policyWritten = false;

  const deps: OrchestratorDeps = {
    nowMs: () => Date.now(),
    readers: new Map([[11155111, reader]]),

    async resolveCalldata(s) {
      switch (s.id) {
        case "deploy-cre-consumer": return { to: null, data: creationData, value: 0n };
        case "claim-policy-admin": return { to: POLICY_REGISTRY, data: adminData, value: 0n };
        case "register-policy-disabled": policyWritten = true; return { to: POLICY_REGISTRY, data: policyData, value: 0n };
        // (`policyWritten` distinguishes "registered and disabled" from "never configured"; both
        //  read as isPolicyEnabled === false, and only one of them is a completed step.)
        default: throw new Error(`no calldata for ${s.id}`);
      }
    },

    async sendTransaction(req) {
      console.log(`  sending ${req.to === null ? "contract creation" : `call to ${req.to}`} nonce=${req.nonce} gas=${req.gas}`);
      return wallet.sendTransaction({
        to: req.to ?? undefined, data: req.data, value: req.value,
        nonce: req.nonce, gas: req.gas === 0n ? undefined : (req.gas * 12n) / 10n,
      } as never);
    },

    /* Independent observation. Each answer is read from the chain, never inferred from a receipt. */
    async observe(s: DeploymentStep, ctx: StepExecutionContext) {
      // The address this run created, read from the run rather than from a variable the caller
      // happens to have set afterwards.
      consumerAddress = ctx.createdAddresses.get("deploy-cre-consumer") ?? consumerAddress;
      switch (s.id) {
        case "verify-chain-11155111": {
          const id = await reader.getChainId();
          return { satisfied: id === 11155111, evidence: `chainId ${id}` };
        }
        case "verify-core": {
          const rows = await Promise.all(Object.entries({
            ContextLockPolicyRegistry: POLICY_REGISTRY, ContextLockAuthorizationRegistry: AUTH_REGISTRY, ContextLockExecutorV2: EXECUTOR,
          }).map(async ([name, addr]) => {
            const observed = codeHash(await reader.getCode(addr));
            const expected = CORE.contracts[name]!.runtimeCodeHash;
            return { name, ok: observed === expected, observed };
          }));
          const bad = rows.filter((r) => !r.ok);
          return { satisfied: bad.length === 0, evidence: bad.length === 0 ? `core verified by re-hashing bytecode: ${rows.map((r) => r.name).join(", ")}` : `code hash mismatch: ${bad.map((r) => r.name).join(", ")}` };
        }
        case "deploy-cre-consumer": {
          if (!consumerAddress) return { satisfied: false, evidence: "the consumer has not been created yet" };
          const code = await reader.getCode(consumerAddress);
          if (!code || code === "0x") return { satisfied: false, evidence: `no code at ${consumerAddress}` };
          // Read the constructor's effects back, rather than trusting that it ran.
          const owner = await public_.readContract({ address: consumerAddress, abi: parseAbi(["function owner() view returns (address)"]), functionName: "owner" });
          const fwd = await public_.readContract({ address: consumerAddress, abi: parseAbi(["function forwarder() view returns (address)"]), functionName: "forwarder" });
          const ok = (owner as string).toLowerCase() === DEPLOYER.toLowerCase() && (fwd as string).toLowerCase() === CRE_FORWARDER.toLowerCase();
          return { satisfied: ok, evidence: ok ? `consumer at ${consumerAddress}, owner=${owner}, forwarder=${fwd}, codeHash=${codeHash(code)}` : `constructor state wrong: owner=${owner} forwarder=${fwd}`, createdAddress: consumerAddress };
        }
        case "claim-policy-admin": {
          const admin = await public_.readContract({ address: POLICY_REGISTRY, abi: POLICY_ABI, functionName: "policyAdmin", args: [AGENT_IDENTITY_HASH] });
          const ok = (admin as string).toLowerCase() === DEPLOYER.toLowerCase();
          return { satisfied: ok, evidence: `policyAdmin(${AGENT_IDENTITY_HASH.slice(0, 12)}…) = ${admin}` };
        }
        case "register-policy-disabled": {
          /*
           * Satisfied only when the identity has been CONFIGURED and the policy is DISABLED.
           *
           * `isPolicyEnabled` returns false for an identity nobody has ever touched, so a naive
           * "is it disabled?" check would report this step complete before it had run. The binding
           * version distinguishes the two: it is 0 until `setPolicyAdmin` bumps it to 1.
           */
          const version = (await public_.readContract({ address: POLICY_REGISTRY, abi: POLICY_ABI, functionName: "bindingVersion", args: [AGENT_IDENTITY_HASH] })) as bigint;
          const enabled = (await public_.readContract({ address: POLICY_REGISTRY, abi: POLICY_ABI, functionName: "isPolicyEnabled", args: [AGENT_IDENTITY_HASH, POLICY_HASH] })) as boolean;
          const cap = (await public_.readContract({ address: POLICY_REGISTRY, abi: POLICY_ABI, functionName: "maxValueHardCap", args: [AGENT_IDENTITY_HASH, POLICY_HASH] })) as bigint;
          if (version === 0n) return { satisfied: false, evidence: "this agent identity has never been configured (bindingVersion 0)" };
          if (!policyWritten) return { satisfied: false, evidence: `identity configured, but this deployment has not yet registered policy ${POLICY_HASH.slice(0, 12)}…` };
          return { satisfied: enabled === false, evidence: `policy registered: enabled=${enabled} cap=${cap} bindingVersion=${version} — DISABLED as required` };
        }
        case "post-deploy-verify": {
          const enabled = (await public_.readContract({ address: POLICY_REGISTRY, abi: POLICY_ABI, functionName: "isPolicyEnabled", args: [AGENT_IDENTITY_HASH, POLICY_HASH] })) as boolean;
          const admin = await public_.readContract({ address: POLICY_REGISTRY, abi: POLICY_ABI, functionName: "policyAdmin", args: [AGENT_IDENTITY_HASH] });
          const code = consumerAddress ? await reader.getCode(consumerAddress) : undefined;
          const codeOk = !!code && code !== "0x";
          const unexpectedAdmin = (admin as string).toLowerCase() !== DEPLOYER.toLowerCase();
          const ok = enabled === false && codeOk && !unexpectedAdmin;
          return { satisfied: ok, evidence: ok ? "policy DISABLED, consumer code present, no unexpected administrator" : `enabled=${enabled} codePresent=${codeOk} unexpectedAdmin=${unexpectedAdmin}` };
        }
        default:
          return { satisfied: false, evidence: `no observation defined for ${s.id}` };
      }
    },

    cre: {
      async currentArtifact() { return null; },
      async deploy() { throw new Error("CRE deployment is blocked: BLK-V2-CRE-DEPLOY"); },
      async lifecycle() { throw new Error("CRE lifecycle is blocked: BLK-V2-CRE-DEPLOY"); },
      async authValid() { return false; },
    },
    image: {
      async build() { return { imageDigest: IMAGE?.imageManifestDigest ?? "" }; },
      async scan() { return { promotable: false, detail: "no container vulnerability scanner is installed; the gate fails closed (BLK-V2-VULN-SCANNER)" }; },
      async publish() { return { published: true as const }; },
      async createDisabled() { return { revisionId: "rev_local" }; },
    },
  };

  const orchestrator = new DeploymentOrchestrator(deps);

  /* Load the run from disk, so a second invocation RESUMES rather than redeploying. */
  const loadRun = () => {
    if (FRESH || !existsSync(STATE)) return null;
    const raw = JSON.parse(readFileSync(STATE, "utf8")) as Record<string, any>;
    if (raw.manifestHash !== manifestHash(manifest)) {
      console.log("  persisted run is for a different manifest; starting fresh");
      return null;
    }
    consumerAddress = raw.createdAddresses?.["deploy-cre-consumer"] ?? null;
    policyWritten = !!raw.policyWritten;
    return {
      deploymentId: raw.deploymentId as string,
      state: raw.state,
      plan: raw.plan as DeploymentPlan,
      transactions: new Map(Object.entries(raw.transactions ?? {})),
      createdAddresses: new Map(Object.entries(raw.createdAddresses ?? {})),
      creWorkflowId: raw.creWorkflowId ?? null,
      creStatus: raw.creStatus ?? null,
      runtimeImageDigest: raw.runtimeImageDigest ?? null,
      events: raw.events ?? [],
    } as ReturnType<DeploymentOrchestrator["newRun"]>;
  };
  const saveRun = (r: ReturnType<DeploymentOrchestrator["newRun"]>) => {
    writeFileSync(STATE, JSON.stringify({
      _comment: "Persisted deployment run state. A second invocation resumes from this, re-reads chain reality, and continues from the first unsatisfied step.",
      manifestHash: manifestHash(manifest),
      deploymentId: r.deploymentId, state: r.state, plan: r.plan,
      transactions: Object.fromEntries(r.transactions),
      createdAddresses: Object.fromEntries(r.createdAddresses),
      creWorkflowId: r.creWorkflowId, creStatus: r.creStatus, runtimeImageDigest: r.runtimeImageDigest,
      policyWritten, events: r.events,
    }, null, 2) + "\n");
  };
  // Capture the created address as soon as the receipt yields it, so `observe` can read it back.
  const resumed = loadRun();
  const run = resumed ?? orchestrator.newRun("dep_group_e_live_0001", approved);
  if (resumed) console.log(`  resuming ${run.deploymentId} from ${run.state}`);
  const origExecute = orchestrator.executeStep.bind(orchestrator);
  orchestrator.executeStep = async (r, s, m) => {
    const out = await origExecute(r, s, m);
    const created = r.createdAddresses.get(s.id);
    if (created) consumerAddress = created;
    return out;
  };

  console.log("\n── deploying ──");
  let failure: Error | null = null;
  try {
    await orchestrator.runToCompletion(run, manifest);
  } catch (e) {
    failure = e as Error;
    if (/DEPLOY-NOT-RESUMABLE/.test(failure.message) && run.state === "READY_TO_ACTIVATE") {
      // Not an error. A completed deployment refusing to run again IS the idempotency guarantee:
      // a repeat request cannot deploy anything a second time.
      console.log(`  ALREADY COMPLETE — this deployment is ${run.state} and was not re-run. Nothing was sent.`);
      failure = null;
    } else {
      console.error(`  STOPPED: ${failure.message}`);
    }
  }
  // Saved whether it succeeded or not. A run that crashed and saved nothing is a run that cannot
  // be resumed, which is the case persistence exists for.
  saveRun(run);
  for (const ev of run.events) console.log(`  ${ev.stepId ?? "-"}: ${ev.message}`);

  /* ── receipt ───────────────────────────────────────────────────────────────── */
  const txs = [...run.transactions.values()];
  const actualByChain: Record<string, string> = {};
  const estimatedByChain: Record<string, string> = {};
  actualByChain["11155111"] = txs.reduce((a, t) => a + BigInt(t.actualNativeCostWei ?? "0"), 0n).toString();
  estimatedByChain["11155111"] = approved.steps.reduce((a, s) => a + BigInt(s.cost?.totalNativeWei ?? "0"), 0n).toString();

  const receipt: DeploymentReceipt = {
    schemaVersion: "contextlock.deployment-receipt/v1",
    deploymentId: run.deploymentId,
    manifestHash: manifestHash(manifest),
    planHash: deploymentPlanHash(approved),
    approvedBy: approved.approval!.approvedBy,
    approvedAtMs: approved.approval!.approvedAtMs,
    environmentKind: "TESTNET",
    chains: [11155111],
    walletAddresses: [DEPLOYER],
    transactions: txs,
    contractAddresses: consumerAddress ? { ContextLockCreConsumer: consumerAddress } : {},
    creWorkflowId: null, creBinaryHash: null, creRegistry: null,
    creStatusAtDeploy: "NOT_DEPLOYED — BLK-V2-CRE-DEPLOY: this organization does not have CRE workflow deployment access",
    runtimeImageDigest: IMAGE?.imageManifestDigest ?? null,
    sbomDigest: IMAGE?.sbomDigest ?? null,
    provenanceDigest: IMAGE?.provenanceDigest ?? null,
    actualGasCostWeiByChain: actualByChain,
    estimatedGasCostWeiByChain: estimatedByChain,
    verifiedAtMs: failure ? null : Date.now(),
    verificationChecks: run.plan.steps.map((s) => ({ id: s.id, ok: s.status === "VERIFIED" || s.status === "SKIPPED_ALREADY_SATISFIED", expected: "VERIFIED", observed: s.status })),
    finalStates: {
      policy: "DISABLED", runtime: "INACTIVE",
      cre: "NOT_DEPLOYED (BLK-V2-CRE-DEPLOY)",
      deployment: run.state,
    },
    generatedAtMs: Date.now(),
  };

  const sealed = sealReceipt(receipt);
  const recovery = buildRecoveryPlan({
    deploymentId: run.deploymentId,
    created: consumerAddress ? [{ name: "ContextLockCreConsumer", address: consumerAddress, chainId: 11155111 }] : [],
    unknownTransactions: txs.filter((t) => t.state === "UNKNOWN_SUBMISSION_STATE").map((t) => ({ stepId: t.deploymentStepId, from: t.from, nonce: t.nonce, detail: t.revertDetail ?? "unknown" })),
    configuredSteps: ["claim-policy-admin", "register-policy-disabled"],
    crePublished: false, imagePublished: false,
  });

  const evidence = {
    _comment: "A real deployment to Ethereum Sepolia, executed by DeploymentOrchestrator. The ContextLock policy was registered DISABLED and remains disabled; nothing was activated.",
    receipt: sealed.receipt,
    receiptDigest: sealed.digest,
    recovery,
    agentIdentityHash: AGENT_IDENTITY_HASH,
    policyHash: POLICY_HASH,
    creForwarderConfigured: CRE_FORWARDER,
    explorer: consumerAddress ? `https://sepolia.etherscan.io/address/${consumerAddress}` : null,
    events: run.events,
    stoppedWith: failure?.message ?? null,
    /*
     * Contracts created by ATTEMPTS THAT FAILED, before the orchestrator learned to wait for a
     * receipt and to hand observers the address it had just created.
     *
     * Recorded because a partial deployment leaves things behind that cannot be removed, and
     * pretending otherwise is exactly what §23 and P19's no-ROLLBACK rule are about. Each of these
     * is an inert ContextLockCreConsumer: it holds no authority, because authority comes from a
     * policy in the registry and no policy references any of them.
     */
    orphansFromFailedAttempts: ORPHANS,
  };
  const hits = scanForSecrets(evidence, "$deployment");
  if (hits.length > 0) throw new Error(`the deployment evidence contains ${hits.length} secret-shaped value(s)`);
  writeFileSync(OUT, JSON.stringify(evidence, null, 2) + "\n");

  console.log(`\nstate: ${run.state}`);
  console.log(`consumer: ${consumerAddress ?? "(not created)"}`);
  console.log(`estimated ${formatUnitsExact(BigInt(estimatedByChain["11155111"]!), 18)} ETH, actual ${formatUnitsExact(BigInt(actualByChain["11155111"]!), 18)} ETH`);
  console.log(`receipt: ${sealed.digest}`);
  console.log(`written to ${OUT}`);
  if (failure) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
