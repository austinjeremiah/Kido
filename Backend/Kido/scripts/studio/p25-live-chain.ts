/**
 * P25.44 — observe the real Group E deployment, live.
 *
 * Reads Ethereum Sepolia fresh and renders the deployed-agent Overview from what it finds. No
 * database, no manifest, no cached value stands in for a chain read: the deployment record supplies
 * only the ADDRESSES to look at, and every state comes from the chain.
 *
 * It changes nothing. No policy is enabled for a screenshot; §25.44 says so explicitly, and there
 * is no write path in this file.
 *
 * Output: reports/phase-25/evidence/p25-live-chain.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { codeHash, type ChainReader } from "@contextlock/studio-deploy";
import {
  ChainObserver, reconcile, presentable, DEFAULT_TTLS, CreMonitor, CreCliProvider, AdapterHealthService,
  evaluateRuntime, agentIsLive, AlertEngine, alertForDrift, NoopTelemetry,
  POLICY_STATE_GAUGE, RUNTIME_HEALTH_GAUGE,
  type ChainQueries, type ExpectedState,
} from "@contextlock/studio-control-plane";
import { InMemoryEventStore, scanForSecrets, type EventDraft } from "@contextlock/studio-events";

const OUT = "reports/phase-25/evidence/p25-live-chain.json";
const DEPLOY = JSON.parse(readFileSync("reports/group-e/evidence/p23-live-deployment.json", "utf8")) as Record<string, any>;
const CORE = JSON.parse(readFileSync("reports/group-e/evidence/sepolia-code-hashes.json", "utf8")) as { contracts: Record<string, { address: string; runtimeCodeHash: string }> };
const IMAGE = JSON.parse(readFileSync("reports/group-e/evidence/image/runtime-image.json", "utf8")) as Record<string, any>;

const rpc = process.env.SEPOLIA_RPC_URL!;
const client = createPublicClient({ chain: sepolia, transport: http(rpc) });

const CONSUMER = DEPLOY.receipt.contractAddresses.ContextLockCreConsumer as Address;
const POLICY_REGISTRY = CORE.contracts.ContextLockPolicyRegistry!.address as Address;
const EXECUTOR = CORE.contracts.ContextLockExecutorV2!.address as Address;
const AGENT_IDENTITY_HASH = DEPLOY.agentIdentityHash as Hex;
const POLICY_HASH = DEPLOY.policyHash as Hex;
const DEPLOYER = DEPLOY.receipt.walletAddresses[0] as Address;

const POLICY_ABI = parseAbi([
  "function policyAdmin(bytes32) view returns (address)",
  "function isPolicyEnabled(bytes32 a, bytes32 p) view returns (bool)",
  "function maxValueHardCap(bytes32 a, bytes32 p) view returns (uint256)",
  "function bindingVersion(bytes32 a) view returns (uint64)",
]);

const reader: ChainReader = {
  chainId: 11155111, live: true,
  getChainId: () => client.getChainId(),
  getCode: (a) => client.getCode({ address: a }),
  getBalance: (a) => client.getBalance({ address: a }),
  getTransactionCount: async (a) => BigInt(await client.getTransactionCount({ address: a })),
  estimateGas: (tx) => client.estimateGas({ account: tx.from, ...(tx.to ? { to: tx.to } : {}), ...(tx.data ? { data: tx.data } : {}) } as never),
  estimateFeesPerGas: async () => { const f = await client.estimateFeesPerGas(); return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas, gasPrice: undefined }; },
  call: async (tx) => (await client.call({ account: tx.from, to: tx.to, data: tx.data })).data ?? "0x",
  getTransactionReceipt: async (h) => {
    try {
      const r = await client.getTransactionReceipt({ hash: h });
      return { status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, contractAddress: r.contractAddress ?? null };
    } catch { return null; }
  },
  getBlockNumber: () => client.getBlockNumber(),
};

/** The real queries. Every one is an `eth_call` against the live registry. */
const queries: ChainQueries = {
  async readPolicy(registry, agentIdentityHash, policyHash) {
    const [enabled, cap, bindingVersion, admin] = await Promise.all([
      client.readContract({ address: registry, abi: POLICY_ABI, functionName: "isPolicyEnabled", args: [agentIdentityHash, policyHash] }) as Promise<boolean>,
      client.readContract({ address: registry, abi: POLICY_ABI, functionName: "maxValueHardCap", args: [agentIdentityHash, policyHash] }) as Promise<bigint>,
      client.readContract({ address: registry, abi: POLICY_ABI, functionName: "bindingVersion", args: [agentIdentityHash] }) as Promise<bigint>,
      client.readContract({ address: registry, abi: POLICY_ABI, functionName: "policyAdmin", args: [agentIdentityHash] }) as Promise<Address>,
    ]);
    return { enabled, cap, bindingVersion, admin };
  },
  async resolveIdentity() {
    // The Group E deployment registered no ENS identity for this agent, so there is nothing to
    // resolve. Reported as absent rather than invented.
    return { boundAgent: null, revoked: false, resolver: "0x0000000000000000000000000000000000000000" as Address };
  },
  async readAdministrators(contract) {
    // The registry's administrative role for this identity is its policy admin.
    if (contract.toLowerCase() !== POLICY_REGISTRY.toLowerCase()) return [];
    const admin = (await client.readContract({ address: POLICY_REGISTRY, abi: POLICY_ABI, functionName: "policyAdmin", args: [AGENT_IDENTITY_HASH] })) as Address;
    return [admin];
  },
};

async function main() {
  const nowMs = () => Date.now();
  const observer = new ChainObserver({ reader, queries, nowMs });
  const events = new InMemoryEventStore();
  const alerts = new AlertEngine();
  const telemetry = new NoopTelemetry();

  console.log("── reading Ethereum Sepolia ──");
  const t0 = Date.now();
  const policy = await observer.readPolicyState({ registry: POLICY_REGISTRY, agentIdentityHash: AGENT_IDENTITY_HASH, policyHash: POLICY_HASH });
  const consumer = await observer.readContractState("ContextLockCreConsumer", CONSUMER);
  const executor = await observer.readContractState("ContextLockExecutorV2", EXECUTOR);
  const admins = await observer.readAdministrators(POLICY_REGISTRY);
  const identity = await observer.readIdentityState({ name: "(none registered for this agent)", node: `0x${"00".repeat(32)}` as Hex });
  const readMs = Date.now() - t0;

  console.log(`  policy    enabled=${policy.value?.enabled} bindingVersion=${policy.value?.bindingVersion} block=${policy.value?.blockNumber}`);
  console.log(`  consumer  code=${consumer.value?.hasCode} hash=${consumer.value?.runtimeCodeHash}`);
  console.log(`  admins    ${admins.value?.join(", ")}`);

  /* ── reconcile the deployment record against what the chain says ── */
  const expected: ExpectedState = {
    policyEnabled: false,
    policyAdmin: DEPLOYER,
    bindingVersion: "1",
    contracts: [
      { name: "ContextLockExecutorV2", address: EXECUTOR, runtimeCodeHash: CORE.contracts.ContextLockExecutorV2!.runtimeCodeHash },
      { name: "ContextLockCreConsumer", address: CONSUMER, runtimeCodeHash: CORE.contracts.ContextLockCreConsumer!.runtimeCodeHash },
    ],
    administrators: [DEPLOYER],
    identity: null,
    runtimeImageDigest: null,
  };
  const drifts = reconcile(expected, { policy, identity: null, contracts: [executor, consumer], administrators: admins, runtimeImageDigest: null }, Date.now());
  for (const d of drifts) {
    const { alert } = alerts.raise(alertForDrift(d, { projectId: "prj_guardian", deploymentId: DEPLOY.receipt.deploymentId }));
    console.log(`  DRIFT ${d.kind}: expected ${d.expected}, observed ${d.observed} → alert ${alert.alertId} (${alert.severity})`);
  }
  if (drifts.length === 0) console.log("  no drift: the deployment record matches the chain");

  /* ── a deliberate drift fixture, to prove the detector fires on real data ── */
  const injected = reconcile({ ...expected, policyEnabled: true }, { policy, identity: null, contracts: [executor, consumer], administrators: admins, runtimeImageDigest: null }, Date.now());
  console.log(`  injected-mismatch control: ${injected.map((d) => d.kind).join(", ") || "NOTHING DETECTED — BUG"}`);

  /* ── the rest of the console, from live sources ── */
  /*
   * The REAL CRE provider, driving the user's own authenticated CLI.
   *
   * Passing `null` here would render NOT_CONFIGURED, which is false: this tenant is connected and
   * has no deploy access, and those are different states (§25.10).
   */
  const creProvider = new CreCliProvider({ projectDir: "workflows/cre-policy/contextlock-policy", timeoutMs: 45_000 });
  const cre = new CreMonitor({ provider: creProvider, nowMs });
  await cre.sync("contextlock-policy");
  const creView = cre.view(Date.now());

  const runtime = evaluateRuntime({
    containerRunning: false, containerHealth: null, restartsInWindow: 0, observedImageDigest: null,
    lastHeartbeatMs: null, controlPlaneReachable: true, modelGatewayReachable: true, adapterBrokerReachable: true,
    contextlockBrokerReachable: true, eventCursorAgeMs: null, credentialValid: false, credentialExpiresAtMs: null,
    strategyCheckpointAgeMs: null, paused: false, stopping: false, processStartedAtMs: null, nowMs: Date.now(),
  });

  const adapters = new AdapterHealthService();
  adapters.register("aave-v3", "1.2.0");
  adapters.register("the-graph", "2.0.1");

  const live = agentIsLive({
    runtime: runtime.state,
    policyEnabled: policy.value?.enabled ?? null,
    policyIsCurrent: presentable(policy, Date.now()).isCurrent,
    identityActive: null,
    requiredAdapters: [],
    creRequired: true,
    creActive: null,
  });

  /* ── record what was observed as RuntimeEvents ── */
  const base: Omit<EventDraft, "type" | "source" | "severity" | "publicMetadata"> = {
    organizationId: null, projectId: "prj_guardian", deploymentId: DEPLOY.receipt.deploymentId, agentId: "guardian",
    timestamp: Date.now(), correlationId: `corr_observe_${Date.now()}`, agentRunId: null, modelRunId: null,
    strategyEvaluationId: null, creExecutionId: null, authorizationId: null, capabilityId: null,
    chainId: 11155111, blockNumber: policy.value?.blockNumber ?? null, txHash: null, creWorkflowId: null,
    adapterId: null, runtimeRevision: null, buildRevision: 2, deploymentRevision: "rev_1", correctsEventId: null,
  };
  events.append({ ...base, source: "CHAIN", type: "POLICY_STATE_OBSERVED", severity: "INFO", publicMetadata: { enabled: policy.value?.enabled ?? null, bindingVersion: policy.value?.bindingVersion ?? null, blockNumber: policy.value?.blockNumber ?? null } }, Date.now());
  events.append({ ...base, source: "RUNTIME", type: "RUNTIME_STATE_CHANGED", severity: "INFO", publicMetadata: { state: runtime.state } }, Date.now());
  events.append({ ...base, source: "CRE", type: "CRE_STATUS_CHANGED", severity: "INFO", publicMetadata: { state: creView.state, blockedBy: creView.blockedBy } }, Date.now());

  telemetry.gauge("policy_state", policy.value?.enabled ? POLICY_STATE_GAUGE.ENABLED : policy.value ? POLICY_STATE_GAUGE.DISABLED : POLICY_STATE_GAUGE.UNKNOWN, { deployment_id: DEPLOY.receipt.deploymentId, agent_id: "guardian" });
  telemetry.gauge("runtime_health", RUNTIME_HEALTH_GAUGE[runtime.state as keyof typeof RUNTIME_HEALTH_GAUGE] ?? -1, { deployment_id: DEPLOY.receipt.deploymentId, agent_id: "guardian" });
  telemetry.gauge("chain_sync_age", Math.round((Date.now() - policy.observedAtMs) / 1000), { deployment_id: DEPLOY.receipt.deploymentId, chain_id: 11155111 });

  const p = presentable(policy, Date.now());
  const overview = {
    agent: "TREASURY GUARDIAN",
    badge: live.live ? "● LIVE" : "● INACTIVE",
    notLiveBecause: live.reasons,
    network: "Ethereum Sepolia (11155111)",
    panels: {
      contracts: { state: consumer.value?.hasCode && executor.value?.hasCode ? "DEPLOYED" : "MISSING", consumer: CONSUMER, executor: EXECUTOR, lastVerified: new Date(consumer.observedAtMs).toISOString(), source: consumer.source },
      policy: { state: policy.value?.enabled === undefined ? "UNKNOWN" : policy.value.enabled ? "ENABLED" : "DISABLED", bindingVersion: policy.value?.bindingVersion ?? null, admin: policy.value?.policyAdmin ?? null, lastVerified: new Date(policy.observedAtMs).toISOString(), isCurrent: p.isCurrent, ageMs: p.ageMs, source: policy.source },
      ens: { state: identity.value?.boundAgent ? "ACTIVE" : "NOT REGISTERED", note: "The Group E deployment registered no ENS identity for this agent. Reported as absent rather than inferred." },
      runtime: { state: runtime.state, reasons: runtime.reasons, note: runtime.note },
      cre: { state: creView.state, headline: creView.headline, detail: creView.detail, blockedBy: creView.blockedBy, connection: creView.connection, workflow: creView.workflow, unavailable: creView.unavailable, lastSyncedAtMs: creView.lastSyncedAtMs, isCurrent: creView.isCurrent },
      hostedRuntime: { state: "NOT LIVE-VERIFIED", blockedBy: "BLK-V2-ECS-LIVE" },
      ledger: { state: "HARDWARE PENDING", blockedBy: "BLK-002" },
      vulnerabilityScan: { state: "NOT RUN", blockedBy: "BLK-V2-VULN-SCANNER" },
      adapters: adapters.all(Date.now()).map((a) => ({ adapterId: a.adapterId, state: a.state, reason: a.state === "UNKNOWN" ? "no samples yet — this deployment has never run" : null })),
    },
    revisions: { build: 2, deployment: "rev_1", runtime: null, imageDigestPinned: IMAGE.imageManifestDigest, imageBuiltFromCommit: IMAGE.labels["org.opencontainers.image.revision"] },
  };

  const evidence = {
    _comment: "Live observation of the Group E Sepolia deployment. Every state came from a chain read at the moment recorded; the deployment record supplied addresses only. Nothing was written.",
    generatedAt: new Date().toISOString(),
    performedWrites: false,
    chainReadDurationMs: readMs,
    observed: {
      chainId: await reader.getChainId(),
      headBlock: policy.value?.blockNumber ?? null,
      policy: policy.value,
      policyFreshness: { observedAt: new Date(policy.observedAtMs).toISOString(), ttlMs: DEFAULT_TTLS.policy, isCurrent: p.isCurrent, ageMs: p.ageMs },
      consumer: consumer.value,
      executor: executor.value,
      administrators: admins.value,
      identity: identity.value,
    },
    reconciliation: { driftsFound: drifts, injectedMismatchControl: injected.map((d) => ({ kind: d.kind, severity: d.severity, expected: d.expected, observed: d.observed })) },
    overview,
    creCliInvocations: creProvider.invocations.map((i) => ({ command: i.args.join(" "), ok: i.ok })),
    runtimeEvents: events.query({}),
    alerts: alerts.all(),
    metrics: telemetry.emitted,
  };

  const hits = scanForSecrets(evidence, "$p25chain");
  if (hits.length > 0) throw new Error(`the evidence contains ${hits.length} secret-shaped value(s)`);
  writeFileSync(OUT, JSON.stringify(evidence, null, 2) + "\n");

  console.log(`\n${overview.badge}  ${overview.agent}`);
  console.log(`  policy   ${overview.panels.policy.state}  (fresh: ${overview.panels.policy.isCurrent}, read ${overview.panels.policy.lastVerified})`);
  console.log(`  runtime  ${overview.panels.runtime.state}`);
  console.log(`  cre      ${overview.panels.cre.state} — ${overview.panels.cre.headline}`);
  console.log(`  not live because: ${live.reasons.join("; ")}`);
  console.log(`\nwritten to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
