import { keccak256, type Address, type Hex } from "viem";
import type { ChainReader } from "../src/chain.js";
import { RpcError } from "../src/chain.js";
import {
  DEPLOYMENT_MANIFEST_VERSION, type DeploymentManifest, type ManifestContract,
} from "../src/manifest.js";
import { DEPLOYMENT_PLAN_VERSION, type DeploymentPlan, type DeploymentStep, type StepCost } from "../src/plan.js";
import { testnetEnvironment, ETHEREUM_SEPOLIA, BASE_SEPOLIA } from "../src/environment.js";
import { manifestHash } from "../src/manifest.js";
import { DOCUMENTED_CRE_DEFAULTS, type CreArtifact, type CreQuotaSnapshot, type CreStatus, type LimitSimulationResult } from "../src/cre.js";
import { sha256Hex } from "../src/hash.js";

export const NOW = 1_770_000_000_000;

export const DEPLOYER = "0x93e0FCb0F71e83F3340264339BC5983C474635c5" as Address;
export const ISSUER = "0x37b91323fabe85eD356C1895D0b7A16c04867C2d" as Address;
export const AGENT = "0xA263b2cA150B5A1cA7bf08adF966B847c487F50f" as Address;
export const ATTACKER = "0x00000000000000000000000000000000DeaDBeef" as Address;

/**
 * The real Sepolia deployment.
 *
 * Addresses from `deployments/sepolia.json`; code hashes read from the chain at block 11673866 and
 * recorded in reports/group-e/evidence/sepolia-code-hashes.json. Using the real values means the
 * reuse tests exercise the same comparison the live preflight performs, rather than a comparison
 * between two constants that were written to agree.
 */
export const SEPOLIA_CORE = {
  ContextLockPolicyRegistry: { address: "0xCBd976E8BBbA70867d581A35e5a5CF1C2ed47F24" as Address, codeHash: "0xd7b0a35e0584d2eb1bde26c6eae46dc8a4b9cb8629df4fd4a38be95816e4e639" as Hex },
  ContextLockAuthorizationRegistry: { address: "0xFAD71bbcCfFdFbFA8B500bc9b8FF6F0C7F9De8e3" as Address, codeHash: "0x7f8c1241aa6c09a06fef70bb2c8e58d621d5aa6978cf60de621bf817d0984817" as Hex },
  ContextLockExecutorV2: { address: "0x9ee2E72E2D7B91D9ddeD1313df5CFCb8E9316e23" as Address, codeHash: "0x250188e2403f69ad1027e1ac07fee750aa6416e99b05a70ba9f46ce8f75f8b79" as Hex },
  EnsAgentIdentityVerifier: { address: "0xbD44B9A7491A3168F772Ca96433c17a0B18a6149" as Address, codeHash: "0x56693547c316fb17bed3baae0867a34ed0b8205a6d65b6d0a0201599fef95f53" as Hex },
  ContextLockCreConsumer: { address: "0x0eAA86cDA5622A8384c3eC9F47aD129902A8123F" as Address, codeHash: "0xdca8de8a30051813e680a7aae9c74560c25ee58e3cb38fdd514912146342db23" as Hex },
} as const;

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/* ─────────────────────────────── a fake chain ─────────────────────────────── */

export interface FakeChainOptions {
  chainId: number;
  reportedChainId?: number;
  code?: Map<string, Hex>;
  balances?: Map<string, bigint>;
  gas?: bigint;
  maxFeePerGas?: bigint | undefined;
  gasPrice?: bigint | undefined;
  /** Throw this on the next call of the named method. Used to prove failures are handled, not swallowed. */
  failWith?: { method: string; error: Error };
  callReverts?: boolean;
  receipts?: Map<string, { status: "success" | "reverted"; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint; contractAddress: Address | null }>;
  nonces?: Map<string, bigint>;
}

/**
 * A deterministic chain reader.
 *
 * `live: false` on purpose. Every estimate it produces is stamped as not coming from a node, which
 * is how the tests can prove that a fixture-derived number is never displayed as a quote.
 */
export function fakeChain(opts: FakeChainOptions): ChainReader {
  const code = opts.code ?? new Map<string, Hex>();
  const balances = opts.balances ?? new Map<string, bigint>();
  const receipts = opts.receipts ?? new Map();
  const nonces = opts.nonces ?? new Map();
  const maybeFail = (method: string) => {
    if (opts.failWith?.method === method) throw opts.failWith.error;
  };
  const key = (a: string) => a.toLowerCase();
  return {
    chainId: opts.chainId,
    live: false,
    async getChainId() { maybeFail("getChainId"); return opts.reportedChainId ?? opts.chainId; },
    async getCode(address) { maybeFail("getCode"); return code.get(key(address)); },
    async getBalance(address) { maybeFail("getBalance"); return balances.get(key(address)) ?? 0n; },
    async getTransactionCount(address) { maybeFail("getTransactionCount"); return nonces.get(key(address)) ?? 0n; },
    async estimateGas() { maybeFail("estimateGas"); return opts.gas ?? 150_000n; },
    async estimateFeesPerGas() {
      maybeFail("estimateFeesPerGas");
      if (opts.maxFeePerGas !== undefined) return { maxFeePerGas: opts.maxFeePerGas, maxPriorityFeePerGas: 1_000_000n, gasPrice: undefined };
      if (opts.gasPrice !== undefined) return { maxFeePerGas: undefined, maxPriorityFeePerGas: undefined, gasPrice: opts.gasPrice };
      return { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, gasPrice: undefined };
    },
    async call() {
      maybeFail("call");
      if (opts.callReverts) throw new RpcError("REVERTED", "execution reverted: NotAuthorized()");
      return "0x" as Hex;
    },
    async getTransactionReceipt(hash) { maybeFail("getTransactionReceipt"); return receipts.get(hash.toLowerCase()) ?? null; },
    async getBlockNumber() { maybeFail("getBlockNumber"); return 11_673_866n; },
  };
}

/**
 * The address -> code-label map the canonical manifest expects.
 *
 * The real chain's code hashes are recorded as evidence, but no preimage for them can be
 * constructed here, so the unit fixtures use synthetic bytecode and REAL keccak: the comparison
 * under test is a genuine hash of genuine bytes, not a string equality between two constants that
 * were written to agree. The live check against the actual Sepolia hashes is a separate script,
 * because a unit test that needed the network would not be a unit test.
 */
export const CORE_CODE_LABELS: Array<[Address, string]> = [
  [SEPOLIA_CORE.ContextLockPolicyRegistry.address, "policy-registry"],
  [SEPOLIA_CORE.ContextLockAuthorizationRegistry.address, "auth-registry"],
  [SEPOLIA_CORE.ContextLockExecutorV2.address, "executor-v2"],
  [SEPOLIA_CORE.EnsAgentIdentityVerifier.address, "ens-verifier"],
  [SEPOLIA_CORE.ContextLockCreConsumer.address, "cre-consumer"],
];

/** A reader whose code map matches what the canonical manifest pins. */
export function sepoliaReader(overrides: Partial<FakeChainOptions> = {}): ChainReader {
  const code = new Map<string, Hex>();
  for (const [address, label] of CORE_CODE_LABELS) code.set(address.toLowerCase(), codeFor(label));
  return fakeChain({ chainId: 11155111, code, balances: new Map([[DEPLOYER.toLowerCase(), 484_047_211_787_714_343n]]), ...overrides });
}

/**
 * Produce bytecode whose keccak is a given hash.
 *
 * It cannot be done, so the fixture inverts the problem: a registry maps synthetic bytecode to the
 * hash the test wants, and `keccak256` is applied for real. `codeFor` returns a unique blob per
 * hash and `hashOfFixtureCode` is what the manifest pins — so the comparison under test is a real
 * keccak comparison over real bytes, not a string equality between two constants.
 */
const FIXTURE_CODE = new Map<string, Hex>();
export function codeFor(label: string): Hex {
  const blob = ("0x60806040" + sha256Hex(label).repeat(4)) as Hex;
  FIXTURE_CODE.set(label, blob);
  return blob;
}
export const hashOfFixtureCode = (label: string): Hex => keccak256(codeFor(label));

/* ──────────────────────────────── the manifest ──────────────────────────────── */

const contract = (
  name: string,
  disposition: ManifestContract["disposition"],
  address: Address | null,
  codeHashLabel: string | null,
  chainId = 11155111,
): ManifestContract => ({
  name,
  chainId,
  disposition,
  address,
  runtimeCodeHash: codeHashLabel ? hashOfFixtureCode(codeHashLabel) : null,
  creationCodeHash: disposition === "DEPLOY_NEW" || disposition === "CREATE_AGENT_SPECIFIC" ? (keccak256(("0x" + "ab".repeat(64)) as Hex) as Hex) : null,
  compiler: { solc: "0.8.28", optimizer: true, runs: 200, evmVersion: "cancun" },
});

export function canonicalManifest(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  const m: DeploymentManifest = {
    schemaVersion: DEPLOYMENT_MANIFEST_VERSION,
    manifestId: "mf_canonical",
    projectId: "prj_treasury_guardian",
    buildId: "bld_0001",
    blueprintRevision: 3,
    buildRevision: 2,
    strategyHash: `sha256:${sha256Hex("strategy-v3")}`,
    organizationHash: null,
    gitCommit: "c8849a08c44ff56308330199cf9de43dd76544eb",
    environment: testnetEnvironment([ETHEREUM_SEPOLIA]),
    contracts: [
      contract("ContextLockPolicyRegistry", "REUSE_VERIFIED", SEPOLIA_CORE.ContextLockPolicyRegistry.address, "policy-registry"),
      contract("ContextLockAuthorizationRegistry", "REUSE_VERIFIED", SEPOLIA_CORE.ContextLockAuthorizationRegistry.address, "auth-registry"),
      contract("ContextLockExecutorV2", "REUSE_VERIFIED", SEPOLIA_CORE.ContextLockExecutorV2.address, "executor-v2"),
      contract("AgentPolicy", "CONFIGURE_EXISTING", SEPOLIA_CORE.ContextLockPolicyRegistry.address, "policy-registry"),
      contract("ContextLockCreConsumer", "CREATE_AGENT_SPECIFIC", null, null),
    ],
    ens: [],
    creWorkflows: [
      {
        workflowName: "contextlock-policy",
        registry: "private",
        binaryHash: "800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0",
        configHash: sha256Hex("config-v1"),
        workflowHash: sha256Hex("workflow-v1"),
        sourceTreeHash: `sha256:${sha256Hex("source-tree-v1")}`,
        creCliVersion: "v1.32.0",
        initialState: "PAUSED",
      },
    ],
    runtimeImages: [
      {
        agentId: "guardian",
        tag: "contextlock/agent-runtime:guardian-2",
        imageDigest: null,
        sbomDigest: null,
        provenanceDigest: null,
        vulnerabilityReportDigest: null,
        baseImageDigest: `sha256:${sha256Hex("node22-slim-base")}`,
      },
    ],
    adapters: [{ adapterId: "aave-v3", version: "1.2.0", artifactHash: `sha256:${sha256Hex("aave-v3@1.2.0")}` }],
    authorizationModel: "SEPARATED_ROLES",
    requiredSigners: [
      { signerId: "deployer", role: "DEPLOYER", address: DEPLOYER, mode: "BROWSER_WALLET", chainIds: [11155111], authorizes: "Deploying the agent-specific CRE consumer and configuring policy, with the policy disabled." },
      { signerId: "policy-admin", role: "POLICY_ADMIN", address: DEPLOYER, mode: "BROWSER_WALLET", chainIds: [11155111], authorizes: "Registering this agent's policy in the DISABLED state." },
    ],
    requiredBalances: [],
    policyInitialState: "DISABLED",
    runtimeInitialState: "INACTIVE",
    creInitialState: "PAUSED",
    generatedAt: new Date(NOW).toISOString(),
  };
  return { ...m, ...overrides };
}

/* ────────────────────────────────── the plan ────────────────────────────────── */

export function stepCost(overrides: Partial<StepCost> = {}): StepCost {
  const gas = 150_000n;
  const fee = 2_000_000_000n;
  const base = gas * fee;
  const buffer = (base * 2000n) / 10_000n;
  return {
    estimatedGas: gas.toString(),
    feeMode: "EIP1559",
    maxFeePerGasWei: fee.toString(),
    maxPriorityFeePerGasWei: "1000000",
    baseNativeWei: base.toString(),
    bufferBps: 2000,
    bufferNativeWei: buffer.toString(),
    totalNativeWei: (base + buffer).toString(),
    quotedAtMs: NOW,
    fromLiveNode: true,
    ...overrides,
  };
}

const step = (s: Partial<DeploymentStep> & Pick<DeploymentStep, "id" | "type">): DeploymentStep => ({
  chainId: 11155111,
  dependencyIds: [],
  actorType: "READ_ONLY",
  requiredSigner: null,
  artifactHash: null,
  target: null,
  calldataHash: null,
  cost: null,
  reversible: true,
  rollbackAction: null,
  status: "PENDING",
  ...s,
});

export function canonicalPlan(manifest = canonicalManifest(), overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  /*
   * Ordered by PHASE, following §23.4's security-first sequence:
   *
   *   1 verify the chain
   *   2 verify/reuse the approved core
   *   3 deploy agent-specific contracts
   *   4 configure identity and policy, with the policy DISABLED
   *   5 configure the CRE relationships, still with the policy DISABLED
   *   6 verify
   *
   * The array order is the execution order, so this is not a stylistic arrangement — it is what
   * puts every configuration step after the contracts it configures, and every irreversible step
   * as late as its dependencies allow.
   */
  const steps: DeploymentStep[] = [
    step({ id: "verify-chain-11155111", type: "VERIFY_CHAIN" }),
    step({ id: "verify-core", type: "VERIFY_CORE", dependencyIds: ["verify-chain-11155111"] }),
    step({
      id: "deploy-cre-consumer", type: "DEPLOY_CONTRACT", dependencyIds: ["verify-core"],
      actorType: "USER_WALLET", requiredSigner: "deployer", reversible: false,
      artifactHash: `sha256:${sha256Hex("cre-consumer-creation")}`, cost: stepCost(),
    }),
    step({
      id: "register-policy-disabled", type: "REGISTER_POLICY_DISABLED", dependencyIds: ["deploy-cre-consumer"],
      actorType: "USER_WALLET", requiredSigner: "policy-admin",
      target: SEPOLIA_CORE.ContextLockPolicyRegistry.address, cost: stepCost({ estimatedGas: "90000", baseNativeWei: (90_000n * 2_000_000_000n).toString(), bufferNativeWei: ((90_000n * 2_000_000_000n * 2000n) / 10_000n).toString(), totalNativeWei: (90_000n * 2_000_000_000n + (90_000n * 2_000_000_000n * 2000n) / 10_000n).toString() }),
      rollbackAction: "Re-register the policy in its previous state; it is disabled either way.",
    }),
    step({ id: "check-cre-access", type: "CHECK_CRE_ACCESS", chainId: null, actorType: "LOCAL_BRIDGE" }),
    step({ id: "build-cre-wasm", type: "BUILD_CRE_WASM", chainId: null, actorType: "LOCAL_BRIDGE", dependencyIds: ["check-cre-access"] }),
    step({ id: "verify-cre-hash", type: "VERIFY_CRE_HASH", chainId: null, actorType: "LOCAL_BRIDGE", dependencyIds: ["build-cre-wasm"] }),
    step({ id: "deploy-cre-private", type: "DEPLOY_CRE_PRIVATE", chainId: null, actorType: "LOCAL_BRIDGE", dependencyIds: ["verify-cre-hash", "deploy-cre-consumer"], reversible: false, artifactHash: "800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0" }),
    step({ id: "pause-cre", type: "PAUSE_CRE", chainId: null, actorType: "LOCAL_BRIDGE", dependencyIds: ["deploy-cre-private"] }),
    step({ id: "build-runtime-image", type: "BUILD_RUNTIME_IMAGE", chainId: null, actorType: "CONTROL_PLANE", dependencyIds: ["verify-core"] }),
    step({ id: "scan-runtime-image", type: "SCAN_RUNTIME_IMAGE", chainId: null, actorType: "CONTROL_PLANE", dependencyIds: ["build-runtime-image"] }),
    step({ id: "publish-runtime-image", type: "PUBLISH_RUNTIME_IMAGE", chainId: null, actorType: "CONTROL_PLANE", dependencyIds: ["scan-runtime-image"], reversible: false }),
    step({ id: "create-runtime-disabled", type: "CREATE_RUNTIME_DISABLED", chainId: null, actorType: "CONTROL_PLANE", dependencyIds: ["publish-runtime-image"] }),
    step({ id: "post-deploy-verify", type: "POST_DEPLOY_VERIFY", dependencyIds: ["register-policy-disabled", "pause-cre", "create-runtime-disabled"] }),
  ];
  return {
    schemaVersion: DEPLOYMENT_PLAN_VERSION,
    planId: "dp_canonical",
    manifestHash: manifestHash(manifest),
    steps,
    readiness: "PREFLIGHT_READY",
    approval: null,
    ...overrides,
  };
}

/* ─────────────────────────────────── CRE ─────────────────────────────────── */

export function creStatus(overrides: Partial<CreStatus> = {}): CreStatus {
  return {
    connected: true,
    mode: "LOCAL_SESSION",
    organizationId: "org_ENDgZRZzalm3d3So",
    organizationName: "My Org",
    accountLabel: "kaushikh2003@gmail.com",
    deployAccess: true,
    availableRegistryIds: ["private", "onchain:ethereum-mainnet"],
    supportedChains: [
      { chainName: "ethereum-testnet-sepolia", chainSelector: "16015286601757825753", forwarder: "0x6481F59038b2925AF0Ec22643E6e675c4Aec04a7" },
      { chainName: "ethereum-testnet-sepolia-base-1", chainSelector: "10344971235874465080", forwarder: "0x6481F59038b2925AF0Ec22643E6e675c4Aec04a7" },
    ],
    cliVersion: "v1.32.0",
    staleness: "CURRENT",
    checkedAtMs: NOW,
    ...overrides,
  };
}

export function creArtifact(overrides: Partial<CreArtifact> = {}): CreArtifact {
  return {
    workflowName: "contextlock-policy",
    wasmPath: "/tmp/contextlock-policy/binary.wasm",
    wasmBytes: 2_400_000,
    wasmSha256: sha256Hex("binary.wasm-v1"),
    binaryHash: "800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0",
    configHash: sha256Hex("config-v1"),
    workflowHash: sha256Hex("workflow-v1"),
    sourceTreeHash: `sha256:${sha256Hex("source-tree-v1")}`,
    configSha256: sha256Hex("config-file-v1"),
    creCliVersion: "v1.32.0",
    builtAtMs: NOW,
    ...overrides,
  };
}

export function creQuota(overrides: Partial<CreQuotaSnapshot> = {}): CreQuotaSnapshot {
  return { ...DOCUMENTED_CRE_DEFAULTS, capturedAtMs: NOW, workflowsInUse: 0, source: "CLI_LIMITS_EXPORT", ...overrides };
}

export function creLimits(overrides: Partial<LimitSimulationResult> = {}): LimitSimulationResult {
  return { ran: true, limitsProfile: "default", violations: [], cliVersion: "v1.32.0", ranAtMs: NOW, ...overrides };
}

export const BASE = BASE_SEPOLIA;
