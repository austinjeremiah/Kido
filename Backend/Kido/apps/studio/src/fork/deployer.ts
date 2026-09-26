import { createHash, randomUUID } from "node:crypto";
import { encodeFunctionData, keccak256, toHex, zeroAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";
import { policyFromBlueprint } from "@contextlock/studio-lab";
import { AnvilForkProvider, sealSnapshot, type ForkDescriptor, type MarketObservation, type MarketSnapshot, type SnapshotSource } from "@contextlock/studio-reality";
import { assertExecutionAllowed, lookupNetwork } from "@contextlock/studio-network";
import {
  AAVE_BASE_DECIMALS, AAVE_POOL_ABI, APPROVAL_REGISTRY_ABI, CHAINLINK_FEED_ABI, CORE_CONTRACTS, ERC20_ABI, IDENTITY_ABI, MAINNET, POLICY_REGISTRY_ABI, VARIABLE_RATE,
  compiledContract, forkPublicClient, forkWalletClient, upstreamClient, waitForRpc,
  type CoreContract, type ForkKeyring,
} from "./chain.js";
import { initialPhases, type ForkDeploymentRecord, type ForkDeployPhaseKey, type ForkPolicy, type ForkScenario, type SetupTransaction } from "./record.js";
import { driversFor, readEthUsd, type DriverContext, type DriverObservation } from "./drivers.js";

/**
 * Deploying an agent to a local mainnet fork.
 *
 * The same shape as the P23 testnet deployment, on a chain nobody else can see: verify the network,
 * deploy the core, deploy the agent-specific consumer, register the policy DISABLED, verify by
 * reading back. Two things are specific to the fork and both are stated as such — the position the
 * agent will guard is opened here, because a guardian with nothing to guard demonstrates nothing,
 * and the vault it repays from is funded here, because on a fork there is no user wallet to fund it.
 *
 * Every write goes to chain 31337 through `assertExecutionAllowed`. The role is LOCAL_FORK, which
 * the network registry marks write-capable and not publicly writable; a mainnet chain id cannot
 * reach any of these functions.
 */

export const ACTION_KINDS = {
  repay: "AAVE_REPAY",
  approve: "ERC20_APPROVE",
} as const;

export const actionKindHash = (kind: string): Hex => keccak256(toHex(kind));

export const POSITION = {
  /**
   * Max ETH the executor may forward with a call. A Lido stake carries its ETH as value, so the
   * cap is what the vault could stake in one action; every other action carries none.
   */
  maxValueHardCapWei: 5n * 10n ** 18n,
} as const;

export interface PhaseSink {
  (key: ForkDeployPhaseKey, status: "RUNNING" | "DONE" | "FAILED", detail?: string): void;
}

export interface DeployerDeps {
  /** This deployment's fresh keys. Funded on the fork here; never persisted. */
  keyring: ForkKeyring;
  upstreamRpcUrl: string;
  upstreamProviderId: string;
  /** Where `contracts/out` lives. The repository root in a normal run. */
  repoRoot: string;
  port: number;
  forks: AnvilForkProvider;
  nowMs: () => number;
  onPhase: PhaseSink;
  onTransaction: (tx: SetupTransaction) => void;
  /** How many blocks behind the upstream head to pin. Enough that the block is not reorged under us. */
  headLagBlocks?: bigint;
  /**
   * Indexed history for the snapshot, when the backend holds a Graph key: a subgraph read pinned
   * at the fork block. Absent, the snapshot carries no THE_GRAPH source — and says nothing in its place.
   */
  indexed?: IndexedReader | null;
}

/** A read of indexed (Graph) data at the fork block, already normalized and validated by its adapter. */
export interface IndexedReader {
  sourceId: string;
  adapterId: string;
  adapterVersion: string;
  subgraphId: string;
  /** Read the pool's liquidity at `block`; returns the adapter's observation or the reason it refused. */
  readAt: (block: number) => Promise<{ ok: true; value: string; indexedBlock: string; lagBlocks: number | null; sourceTimestampMs: number | null; deployment: string | null } | { ok: false; reason: string }>;
}

/* ───────────────────────────── preparing the record ───────────────────────────── */

const canonical = (v: unknown): string => JSON.stringify(v, Object.keys(v as Record<string, unknown>).sort());

/**
 * The policy the fork enforces, derived from the Blueprint the same way the Attack Lab derives it.
 *
 * The targets are the contracts the Blueprint's actions resolve to on the fork — each driver's
 * protocol plus the tokens its approvals name — and nothing else. An action kind the fork lab has
 * no driver for gets no target, so the executor could not call anything for it even if asked.
 */
export function forkPolicyFor(bp: ContextLockAgentBlueprint): ForkPolicy {
  const p = policyFromBlueprint(bp);
  const { drivers } = driversFor(bp.actions.map((a) => a.kind));
  return {
    policyId: p.policyId,
    policyVersion: p.policyVersion,
    autoLimit: p.autoLimit.toString(),
    escalationLimit: p.escalationLimit.toString(),
    minHealthFactorBps: p.minHealthFactorBps,
    targetHealthFactorBps: p.targetHealthFactorBps,
    restoreHealthFactorBps: p.targetHealthFactorBps + 500,
    // The Blueprint's action kinds, plus the bounded approval its `approvals` field declares.
    allowedActionKinds: [...new Set([...bp.actions.map((a) => a.kind), ACTION_KINDS.approve])],
    allowedTargets: [...new Set(drivers.flatMap((d) => d.targets))],
    maxValueHardCapWei: POSITION.maxValueHardCapWei.toString(),
  };
}

/** The public policy hash: a commitment to the fork policy's public configuration. */
export function policyHashOf(policy: ForkPolicy): Hex {
  return keccak256(toHex(canonical(policy)));
}

export function newDeploymentId(): string {
  return `dfk_${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 8)}`;
}

export function prepareRecord(args: {
  bp: ContextLockAgentBlueprint;
  projectId: string;
  buildId: string | null;
  upstreamProviderId: string;
  keyring: ForkKeyring;
}): ForkDeploymentRecord {
  const policy = forkPolicyFor(args.bp);
  const roles = args.keyring.addresses();
  if (forkPolicyFor(args.bp).allowedTargets.length === 0) {
    throw new Error(`the fork lab has no scenario for this agent's actions (${args.bp.actions.map((a) => a.kind).join(", ") || "none"})`);
  }
  return {
    deploymentId: newDeploymentId(),
    projectId: args.projectId,
    buildId: args.buildId,
    blueprintRevision: args.bp.revision,
    agentId: args.bp.identity.agentId,
    ensName: args.bp.identity.ensName,
    agentIdentityHash: keccak256(toHex(args.bp.identity.agentId)),
    ensNode: keccak256(toHex(args.bp.identity.ensName)),
    policyHash: policyHashOf(policy),
    upstream: { providerId: args.upstreamProviderId, headBlock: null, forkBlock: null },
    fork: null,
    contracts: null,
    roles,
    approverMode: "STAND_IN",
    policy,
    position: null,
    snapshot: null,
    phases: initialPhases(),
    setupTransactions: [],
    failure: null,
    stoppedReason: null,
  };
}

/* ───────────────────────────── running it ───────────────────────────── */

const FORK_NETWORK = { chainId: 31337, role: "LOCAL_FORK", forkedFrom: 1 } as const;

async function sendAndRecord(
  pub: PublicClient,
  label: string,
  send: () => Promise<Hex>,
  deps: Pick<DeployerDeps, "onTransaction">,
): Promise<{ hash: Hex; blockNumber: bigint; contractAddress: Address | null }> {
  // The fence, before every write. A fork deployment that skipped it once would be a deployment
  // whose safety depended on nobody ever pointing `endpoint` somewhere else.
  assertExecutionAllowed({ ...FORK_NETWORK, forkBlock: null }, "LOCAL_WRITE", `fork deployment: ${label}`);
  let hash: Hex;
  try {
    hash = await send();
  } catch (e) {
    // viem's simulation reports the revert; the step's name is what a reader needs to act on it.
    throw new Error(`${label}: ${(e as Error).message.split("\n")[0]}`);
  }
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const tx: SetupTransaction = {
    label, hash, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(),
    status: receipt.status, network: "LOCAL FORK TRANSACTION",
  };
  deps.onTransaction(tx);
  if (receipt.status !== "success") throw new Error(`${label} reverted on the fork (tx ${hash})`);
  return { hash, blockNumber: receipt.blockNumber, contractAddress: receipt.contractAddress ?? null };
}

async function deployOne(pub: PublicClient, wallet: WalletClient, name: CoreContract, args: unknown[], deps: DeployerDeps): Promise<Address> {
  const c = compiledContract(name, deps.repoRoot);
  const r = await sendAndRecord(pub, `deploy ${name}`, () =>
    wallet.deployContract({ abi: c.abi as never, bytecode: c.bytecode, args: args as never, account: wallet.account!, chain: wallet.chain }), deps);
  if (!r.contractAddress) throw new Error(`${name} deployed but the receipt carries no address`);
  return r.contractAddress;
}

/**
 * Run the deployment from FORKING_MAINNET through VERIFYING_CONTRACTS.
 *
 * Returns the completed record. Throws — after marking the running phase FAILED — on the first
 * thing that does not verify; the caller owns what happens to the fork afterwards.
 */
export async function runForkDeployment(record: ForkDeploymentRecord, deps: DeployerDeps): Promise<ForkDeploymentRecord> {
  const rec: ForkDeploymentRecord = { ...record, setupTransactions: [...record.setupTransactions] };
  const txDeps = { onTransaction: (tx: SetupTransaction) => { rec.setupTransactions.push(tx); deps.onTransaction(tx); } };
  let phase: ForkDeployPhaseKey = "FORKING_MAINNET";
  const start = (k: ForkDeployPhaseKey, detail?: string) => { phase = k; deps.onPhase(k, "RUNNING", detail); };
  const done = (detail: string) => deps.onPhase(phase, "DONE", detail);

  try {
    /* ── fork ─────────────────────────────────────────────────────────── */
    start("FORKING_MAINNET");
    const upstream = upstreamClient(deps.upstreamRpcUrl);
    const net = lookupNetwork(1);
    if (!net || net.role !== "READ_ONLY_SOURCE") throw new Error("chain 1 is not registered as a read-only source");
    const head = await upstream.getBlockNumber();
    const forkBlock = head - (deps.headLagBlocks ?? 10n);
    const upstreamBlock = await upstream.getBlock({ blockNumber: forkBlock });
    rec.upstream = { providerId: deps.upstreamProviderId, headBlock: head.toString(), forkBlock: forkBlock.toString() };

    let fork: ForkDescriptor = await deps.forks.create({
      sourceChainId: 1, forkBlock: forkBlock.toString(), upstreamRpcUrl: deps.upstreamRpcUrl,
      sourceProviderId: deps.upstreamProviderId, expectedBlockHash: upstreamBlock.hash, port: deps.port,
    });
    rec.fork = fork;
    await waitForRpc(fork.endpoint);
    done(`Anvil forked ${net.canonicalName} at block ${forkBlock} on ${fork.endpoint} (chain 31337)`);

    /* ── anchor ───────────────────────────────────────────────────────── */
    start("VERIFYING_ANCHOR");
    fork = await deps.forks.verifyAnchor(fork.forkId, upstreamBlock.hash);
    rec.fork = fork;
    if (fork.state !== "READY") throw new Error(`the fork is ${fork.state}; its block hash did not match the upstream read`);
    done(`block hash ${fork.forkBlockHash} matches an independent upstream read; anvil ${fork.anvilVersion}`);

    const pub = forkPublicClient(fork.endpoint);
    const chainId = await pub.getChainId();
    if (chainId !== 31337) throw new Error(`the fork reports chain ${chainId}, not 31337`);
    // Fresh keys have no balance anywhere. On the fork, and only there, they are given one.
    await deps.keyring.fund(fork.endpoint);
    const deployer = forkWalletClient(fork.endpoint, deps.keyring.account("deployer"));
    const user = forkWalletClient(fork.endpoint, deps.keyring.account("user"));

    /* ── contracts ────────────────────────────────────────────────────── */
    start("DEPLOYING_CONTRACTS");
    const policyRegistry = await deployOne(pub, deployer, "ContextLockPolicyRegistry", [], { ...deps, ...txDeps });
    const authRegistry = await deployOne(pub, deployer, "ContextLockAuthorizationRegistry", [rec.roles.deployer, rec.roles.authorizer], { ...deps, ...txDeps });
    const identity = await deployOne(pub, deployer, "LocalAgentIdentityVerifier", [rec.roles.deployer], { ...deps, ...txDeps });
    // The approval registry is what makes ESCALATE executable: a human's signature, recorded on
    // chain and consumed once. Its approver is the stand-in for the Ledger device (BLK-002).
    const approvals = await deployOne(pub, deployer, "ContextLockApprovalRegistry", [rec.roles.deployer, rec.roles.approver], { ...deps, ...txDeps });
    const executor = await deployOne(pub, deployer, "ContextLockExecutor", [rec.roles.issuer, policyRegistry, authRegistry, identity, approvals], { ...deps, ...txDeps });
    await sendAndRecord(pub, "approvals: bind the executor", () =>
      deployer.writeContract({ address: approvals, abi: APPROVAL_REGISTRY_ABI, functionName: "setExecutor", args: [executor], account: deployer.account!, chain: deployer.chain }), txDeps);
    // Forwarder zero: the consumer accepts no reports, which is the truthful state without a DON.
    const consumer = await deployOne(pub, deployer, "ContextLockCreConsumer", [rec.roles.deployer, zeroAddress, authRegistry], { ...deps, ...txDeps });
    rec.contracts = {
      ContextLockPolicyRegistry: policyRegistry, ContextLockAuthorizationRegistry: authRegistry,
      LocalAgentIdentityVerifier: identity, ContextLockApprovalRegistry: approvals, ContextLockExecutor: executor, ContextLockCreConsumer: consumer,
    };
    done(`${CORE_CONTRACTS.length} contracts deployed; executor ${executor}, approvals ${approvals}`);

    /* ── policy, DISABLED ─────────────────────────────────────────────── */
    start("CONFIGURING_POLICY_DISABLED");
    const aih = rec.agentIdentityHash as Hex;
    const ph = rec.policyHash as Hex;
    const write = (label: string, fn: string, args: unknown[]) =>
      sendAndRecord(pub, label, () => deployer.writeContract({ address: policyRegistry, abi: POLICY_REGISTRY_ABI, functionName: fn as never, args: args as never, account: deployer.account!, chain: deployer.chain }), txDeps);
    await write("policy: claim administration", "setPolicyAdmin", [aih, rec.roles.deployer]);
    await write("policy: register DISABLED", "setPolicy", [aih, ph, false, BigInt(rec.policy.maxValueHardCapWei)]);
    for (const t of rec.policy.allowedTargets) await write(`policy: allow target ${t}`, "setTargetAllowed", [aih, ph, t, true]);
    for (const k of rec.policy.allowedActionKinds) await write(`policy: allow action ${k}`, "setActionAllowed", [aih, ph, actionKindHash(k), true]);
    // The agent's identity resolves to the position owner: the Blueprint's recipient policy is
    // self-only, and "self" is the account whose debt the agent repays.
    await sendAndRecord(pub, "identity: bind agent", () =>
      deployer.writeContract({ address: identity, abi: IDENTITY_ABI, functionName: "bind", args: [aih, rec.roles.user], account: deployer.account!, chain: deployer.chain }), txDeps);
    done("policy registered with enabled = false; targets, actions and identity bound");

    /* ── the positions ────────────────────────────────────────────────── */
    start("OPENING_POSITION");
    const { drivers, unexercised } = driversFor(rec.policy.allowedActionKinds.filter((k) => k !== ACTION_KINDS.approve));
    const ctx: DriverContext = {
      pub, vault: executor, user: rec.roles.user, userWallet: user, policy: rec.policy, relayer: rec.roles.relayer,
      ethBaseline: { wei: await pub.getBalance({ address: rec.roles.relayer }) },
      ethUsd: () => readEthUsd(pub),
    };
    const scenarios: ForkScenario[] = [];
    for (const d of drivers) {
      const detail = await d.setup(ctx, async (label, tx) => { await sendAndRecord(pub, label, tx, txDeps); });
      scenarios.push({ driverId: d.id, protocol: d.protocol, actionKind: d.actionKind, detail });
    }
    rec.position = { user: rec.roles.user, vault: executor, ethBaselineWei: ctx.ethBaseline.wei.toString(), scenarios, unexercisedActionKinds: unexercised };
    done(`${scenarios.length} scenario(s) opened: ${scenarios.map((x) => `${x.protocol} — ${x.detail}`).join("; ")}${unexercised.length ? `; no fork scenario for ${unexercised.join(", ")}` : ""}`);

    /* ── the snapshot ─────────────────────────────────────────────────── */
    start("TAKING_SNAPSHOT");
    const observed: DriverObservation[] = [];
    for (const d of drivers) observed.push(await d.observe(ctx));
    rec.snapshot = await takeForkSnapshot(pub, fork, rec, deps.nowMs(), observed, deps.indexed ?? null);
    done(`snapshot ${rec.snapshot.snapshotId} sealed at fork block ${rec.snapshot.anchorBlock}; ${rec.snapshot.observations.length} observations`);

    /* ── verify by reading back ───────────────────────────────────────── */
    start("VERIFYING_CONTRACTS");
    for (const [name, addr] of Object.entries(rec.contracts)) {
      const code = await pub.getCode({ address: addr as Address });
      if (!code || code === "0x") throw new Error(`no code at ${addr} for ${name}`);
    }
    const enabled = await pub.readContract({ address: policyRegistry, abi: POLICY_REGISTRY_ABI, functionName: "isPolicyEnabled", args: [aih, ph] });
    if (enabled) throw new Error("the policy reads back ENABLED after a deployment that registered it disabled");
    const admin = await pub.readContract({ address: policyRegistry, abi: POLICY_REGISTRY_ABI, functionName: "policyAdmin", args: [aih] });
    if (admin.toLowerCase() !== rec.roles.deployer.toLowerCase()) throw new Error(`policy admin is ${admin}, expected the deployer`);
    const bound = await pub.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "isIdentityCurrent", args: [aih, rec.roles.user] });
    if (!bound) throw new Error("the agent identity does not read back as bound");
    done("every contract has code; policy reads back DISABLED with the deployer as admin; identity bound");

    return rec;
  } catch (e) {
    const message = (e as Error).message;
    deps.onPhase(phase, "FAILED", message);
    rec.failure = `${phase}: ${message}`;
    throw Object.assign(new Error(rec.failure), { record: rec });
  }
}

/**
 * A market snapshot read from the fork at its pinned block.
 *
 * LOCAL_FORK mode, and every observation says so in its provenance. The values are mainnet's —
 * the Chainlink answer and the Aave reserve are the real contracts' state at `forkBlock` — but the
 * reader is the fork, and a snapshot that claimed LIVE_MIRROR would be claiming a source it did not use.
 */
export async function takeForkSnapshot(pub: PublicClient, fork: ForkDescriptor, rec: ForkDeploymentRecord, nowMs: number, observed: DriverObservation[], indexed: IndexedReader | null = null): Promise<MarketSnapshot> {
  const [, answer, , updatedAt] = await pub.readContract({ address: MAINNET.chainlinkEthUsd, abi: CHAINLINK_FEED_ABI, functionName: "latestRoundData" });
  const feedDecimals = await pub.readContract({ address: MAINNET.chainlinkEthUsd, abi: CHAINLINK_FEED_ABI, functionName: "decimals" });
  const anchor = await pub.getBlock({ blockNumber: BigInt(fork.forkBlock) });
  const retrievedAtMs = nowMs;
  const block = fork.forkBlock;
  const ts = Number(anchor.timestamp) * 1000;

  // One source per protocol the agent acts on, each a direct read of that protocol on the fork.
  const sources: SnapshotSource[] = [
    { sourceId: "chainlink-feed-eth-usd-mainnet", kind: "CHAINLINK_DATA_FEED", adapterId: "chainlink-data-feeds", adapterVersion: "1.0.0", trustClass: "VERIFIED_ORACLE", sourceChainId: 1, timeSupport: "BLOCK_SCOPED", observedBlock: block, lagBlocks: 0, healthy: true, detail: `aggregator ${MAINNET.chainlinkEthUsd}, read on the fork` },
    ...observed.map((o): SnapshotSource => ({ sourceId: `${o.protocol}-mainnet-position`, kind: "LOCAL_FORK_RPC", adapterId: `${o.protocol}-state`, adapterVersion: "1.0.0", trustClass: "DIRECT_CHAIN_DATA", sourceChainId: 1, timeSupport: "BLOCK_SCOPED", observedBlock: block, lagBlocks: 0, healthy: true, detail: `${o.label}, position ${rec.roles.user}: ${o.detail}` })),
  ];
  const direct = (o: DriverObservation, id: string, metric: string, value: string, decimals: number, unit: string, dataType: MarketObservation["dataType"]): MarketObservation => ({
    observationId: id, metric, value, decimals, unit, dataType, canonicalAssetId: null, sourceId: `${o.protocol}-mainnet-position`, sourceChainId: 1, blockNumber: block,
    sourceTimestampMs: ts, retrievedAtMs, trustClass: "DIRECT_CHAIN_DATA", adapterId: `${o.protocol}-state`, adapterVersion: "1.0.0", derivedFrom: null, provenance: `${o.label} position read on fork ${fork.forkId}`,
  });
  const observations: MarketObservation[] = [
    { observationId: "obs-price", metric: "weth/usd:price", value: answer.toString(), decimals: feedDecimals, unit: "USD", dataType: "PRICE", canonicalAssetId: "weth", sourceId: "chainlink-feed-eth-usd-mainnet", sourceChainId: 1, blockNumber: block, sourceTimestampMs: Number(updatedAt) * 1000, retrievedAtMs, trustClass: "VERIFIED_ORACLE", adapterId: "chainlink-data-feeds", adapterVersion: "1.0.0", derivedFrom: null, provenance: `Chainlink ETH/USD ${MAINNET.chainlinkEthUsd} latestRoundData() on fork ${fork.forkId} at block ${block}` },
    ...observed.flatMap((o) => [
      ...(o.healthBps !== null ? [direct(o, `obs-${o.protocol}-health`, `${o.protocol}:position:healthFactor`, String(o.healthBps), 4, "ratio", "HEALTH_FACTOR")] : []),
      ...Object.entries(o.metrics)
        .filter(([k, v]) => k !== "healthFactorBps" && Number.isFinite(v) && v >= 0)
        .map(([k, v]) => direct(o, `obs-${o.protocol}-${k}`, `${o.protocol}:position:${k}`, String(Math.round(v * 1e6)), 6, /usd/i.test(k) ? "USD" : /bps/i.test(k) ? "bps" : "units", /bps/i.test(k) ? "BPS" : "AMOUNT")),
    ]),
  ];
  /*
   * Indexed history, when there is a key for it. The subgraph is asked for the pool AT the fork
   * block, so the reading describes the same moment as everything else here; the indexer's lag
   * behind the head is recorded on the source. A refused read (lag over the bound, no `_meta`,
   * gateway error) is recorded as an unhealthy source with the adapter's reason — never dropped
   * silently, never replaced by anything of lower trust.
   */
  if (indexed) {
    const r = await indexed.readAt(Number(block));
    const base = { sourceId: indexed.sourceId, kind: "THE_GRAPH" as const, adapterId: indexed.adapterId, adapterVersion: indexed.adapterVersion, trustClass: "INDEXED_CHAIN_DATA" as const, sourceChainId: 1, timeSupport: "BLOCK_SCOPED" as const };
    if (r.ok) {
      sources.push({ ...base, observedBlock: r.indexedBlock, lagBlocks: r.lagBlocks, healthy: true, detail: `Uniswap v3 subgraph ${indexed.subgraphId}${r.deployment ? ` (deployment ${r.deployment})` : ""}, USDC/WETH 0.05% pool liquidity at block ${r.indexedBlock}` });
      observations.push({
        observationId: "obs-uniswap-v3-pool-liquidity", metric: "uniswap-v3:pool:usdc-weth-500:liquidity", value: r.value, decimals: 0, unit: "base-units", dataType: "AMOUNT", canonicalAssetId: null,
        sourceId: indexed.sourceId, sourceChainId: 1, blockNumber: r.indexedBlock, sourceTimestampMs: r.sourceTimestampMs ?? ts, retrievedAtMs, trustClass: "INDEXED_CHAIN_DATA", adapterId: indexed.adapterId, adapterVersion: indexed.adapterVersion, derivedFrom: null,
        provenance: `The Graph gateway, subgraph ${indexed.subgraphId}, pool(id, block:{number:${r.indexedBlock}}) — indexed, not oracle-grade`,
      });
    } else {
      sources.push({ ...base, observedBlock: null, lagBlocks: null, healthy: false, detail: `Uniswap v3 subgraph read refused: ${r.reason}` });
    }
  }

  return sealSnapshot({
    snapshotId: `snap-${rec.deploymentId}`,
    mode: "LOCAL_FORK",
    observedAtMs: retrievedAtMs,
    anchorChainId: 1,
    anchorBlock: block,
    anchorBlockHash: fork.forkBlockHash,
    anchorBlockTimestampMs: Number(anchor.timestamp) * 1000,
    sources,
    observations,
    provenance: [`fork ${fork.forkId} of Ethereum mainnet at block ${block}, upstream ${rec.upstream.providerId}`],
    // The feed's heartbeat is an hour; the fork block itself may be minutes old by the time it is read.
    maxSourceAgeMs: 3_600_000,
    nowMs: retrievedAtMs,
  });
}

/** The exact Aave call the agent will ask the executor to make. Exported so the runtime and tests agree on it. */
export function repayCalldata(amountUsdc: bigint, onBehalfOf: Address): Hex {
  return encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "repay", args: [MAINNET.usdc, amountUsdc, VARIABLE_RATE, onBehalfOf] });
}

export function approveCalldata(amountUsdc: bigint): Hex {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [MAINNET.aavePool, amountUsdc] });
}
