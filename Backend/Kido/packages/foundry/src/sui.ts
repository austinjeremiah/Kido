import { keccak256, toHex, type Address } from "viem";
import type { KidoAgentBlueprint } from "@kido/blueprint";
import { AmaneSuiEndpoint, signAmane, suiObjectToBytes32, type AgentLease, type AmaneDeploymentManifest, type AmaneOutcome, type Bytes32, type RootPolicy, type TypedDataSigner } from "@kido/amane-bridge";
import type { ProviderRegistry } from "@kido/registry";
import { AgentRuntime, MonitorEngine, allocationMonitor, compileAmaneAuthority, rebalanceResponder, type ActionExecutor, type AuthorityResult, type CompileContext, type EventLog, type MonitorSpec, type RebalanceWorld, type RecoveryPolicy, type Specialist, type SuiSwapRoute } from "@kido/runtime";
import { authorityEndpoints } from "./endpoints.js";

type SuiClient = ConstructorParameters<typeof AmaneSuiEndpoint>[0];
type SuiSigner = Parameters<typeof AmaneSuiEndpoint.create>[0]["relayer"];
type Manifest = AmaneDeploymentManifest & { sui: { tokens: Record<string, unknown>; pools?: Record<string, { pool: string; coinA: string; coinB: string }>; protocols?: { cetusClmm?: { globalConfig: string } }; adapters: { name: string; actionKind: string; package?: string; module?: string; witnessType: string }[] } };

export interface SuiDeployment {
  accountId: Bytes32;
  endpoint: AmaneSuiEndpoint;
  createTx: string;
  authority: Extract<AuthorityResult, { ok: true }>;
}

/** Creates the Amane Sui account for a built blueprint and compiles its authority against it. */
export async function deploySuiAuthority(a: {
  bp: KidoAgentBlueprint;
  manifest: AmaneDeploymentManifest;
  registry: ProviderRegistry;
  client: SuiClient;
  relayer: SuiSigner;
  controllers: Address[];
  threshold: number;
  issuer: Address;
  agent: Address;
  ownerRecovery: string;
  now: bigint;
}): Promise<SuiDeployment> {
  const chain = "sui-testnet" as const;
  const accountId = keccak256(toHex(`kido:${a.bp.kidoAgentId}:r${a.bp.revision}:${a.now}`));
  const { endpoint, tx } = await AmaneSuiEndpoint.create({ client: a.client, packageId: a.manifest.sui.packageId, relayer: a.relayer, accountId, chainRef: a.manifest.sui.chainRef as Bytes32, controllers: a.controllers, threshold: a.threshold });
  const endpoints = authorityEndpoints(a.bp, a.manifest, a.registry, { [chain]: endpoint.account32 }, undefined, { [chain]: suiObjectToBytes32(a.ownerRecovery) }).filter((e) => e.chain === chain);
  const authority = compileAmaneAuthority({ ...a.bp, chains: [chain] }, endpoints, { controllers: a.controllers, issuer: a.issuer, agent: a.agent, now: a.now, accountId });
  if (!authority.ok) throw new Error(`authority does not compile: ${authority.blockers.join("; ")}`);
  return { accountId, endpoint, createTx: tx, authority };
}

export async function activateSuiAuthority(d: SuiDeployment, ownerSigs: `0x${string}`[], issuer: TypedDataSigner, leaseId: Bytes32, now: bigint): Promise<{ policy: RootPolicy; lease: AgentLease; install: AmaneOutcome; activate: AmaneOutcome }> {
  const policy = d.authority.policy;
  const install = await d.endpoint.installPolicy(policy, ownerSigs);
  const lease = d.authority.lease(leaseId, now);
  if (install.kind !== "EXECUTED") return { policy, lease, install, activate: install };
  const activate = await d.endpoint.activateLease(lease, await signAmane(issuer, "AgentLease", lease));
  return { policy, lease, install, activate };
}

/** Sui coin types by asset symbol, and swap routes through the adapter the authority binds. */
export function suiExecutionConfig(manifest: AmaneDeploymentManifest, registry: ProviderRegistry, adapterName: string): { coinTypes: Record<string, string>; routes: SuiSwapRoute[] } {
  const m = manifest as Manifest;
  const coinTypes = Object.fromEntries(registry.assetsOn("sui-testnet").map((a) => [a.symbol, a.ref]));
  const ad = (m.sui.adapters as { name: string; package?: string; module?: string; witnessType: string }[]).find((x) => x.name === adapterName);
  const cfg = m.sui.protocols?.cetusClmm?.globalConfig;
  const routes = ad?.package && cfg ? Object.values(m.sui.pools ?? {}).map((p) => ({ adapterPackage: ad.package!, module: ad.module ?? "cetus_swap", witnessType: ad.witnessType, coinA: p.coinA, coinB: p.coinB, pool: p.pool, globalConfig: cfg })) : [];
  return { coinTypes, routes };
}

/**
 * Running Sui agent for an allocation-rebalancing blueprint: allocation monitor priced from the
 * permitted pool, deterministic rebalancer limited to directions with an owner floor, and the
 * compile context bound to the active policy and lease.
 */
export function buildSuiRuntime(a: {
  bp: KidoAgentBlueprint;
  authority: Extract<AuthorityResult, { ok: true }>;
  policy: RootPolicy;
  lease: AgentLease;
  endpoint: AmaneSuiEndpoint;
  coinTypes: Record<string, string>;
  route: SuiSwapRoute;
  /** sqrt price (Q64.64) of the permitted pool, read from chain. */
  poolSqrtPrice: () => Promise<bigint>;
  executor: ActionExecutor;
  log: EventLog;
  ttlSeconds: bigint;
  specialist?: Specialist;
  clock?: () => number;
}): { runtime: AgentRuntime<RebalanceWorld>; monitors: MonitorSpec[]; blockers: string[] } {
  const chain = "sui-testnet" as const;
  const blockers: string[] = [];
  const monitors: MonitorSpec[] = [];
  const responders: ReturnType<typeof rebalanceResponder>[] = [];
  const floors = a.bp.authority.swapFloors.filter((f) => f.chain === chain);
  for (const m of a.bp.monitors) {
    if (m.metric !== "ALLOCATION_DRIFT" || !m.target || m.threshold === null) {
      blockers.push(`monitor ${m.id}: needs an allocation target and a public drift threshold`);
      continue;
    }
    const quote = m.target.asset;
    const base = floors.find((f) => f.assetIn === quote)?.assetOut ?? floors.find((f) => f.assetOut === quote)?.assetIn;
    if (!base || !a.coinTypes[quote] || !a.coinTypes[base]) {
      blockers.push(`monitor ${m.id}: no floor pair or coin type for ${quote}`);
      continue;
    }
    // Pool<coinA, coinB>: sqrt² / 2^128 is raw coinB per raw coinA.
    const quoteIsA = a.route.coinA === a.coinTypes[quote];
    monitors.push(allocationMonitor({
      id: m.id, chain, quote, base, target: Number(m.target.share), driftPct: Number(m.threshold), maxAgeMs: 60_000,
      balance: (asset) => a.endpoint.vaultBalance(a.coinTypes[asset]!),
      price: async () => {
        const s = await a.poolSqrtPrice();
        const sq = s * s, q = 1n << 128n;
        return quoteIsA ? { num: sq, den: q } : { num: q, den: sq };
      },
      clock: a.clock,
    }));
    if (m.response === "DETERMINISTIC_ACTION") responders.push(rebalanceResponder({ chain, quote, base, floorDirections: floors.map((f) => [f.assetIn, f.assetOut]) }));
  }
  const binding = a.authority.bindings[chain]!;
  const leaseEp = a.lease.endpoints.find((e) => e.account === binding.account);
  const caps = Object.fromEntries(Object.entries(binding.assets).map(([sym, id]) => [sym, leaseEp?.assets.find((x) => x.assetId === id)?.maxPerAction ?? 0n]));
  let counter = 0n;
  const base = BigInt((a.clock ?? Date.now)()) * 1000n;
  const compile = (): CompileContext => ({ accountId: a.policy.accountId, policy: a.policy, lease: a.lease, bindings: a.authority.bindings as CompileContext["bindings"], nextNonce: () => base + ++counter, now: () => BigInt(Math.floor((a.clock ?? Date.now)() / 1000)), ttlSeconds: a.ttlSeconds });
  const runtime = new AgentRuntime<RebalanceWorld>({
    agentId: a.bp.kidoAgentId,
    monitors: new MonitorEngine(monitors, a.clock),
    responders,
    world: async () => ({ perActionCap: caps }),
    compile,
    executor: a.executor,
    log: a.log,
    recovery: (a.bp.recovery.onPartialExecution ?? "HALT_AND_NOTIFY") as RecoveryPolicy,
    maxRecoveryAttempts: a.bp.recovery.maxRecoveryAttempts,
    known: { chains: [chain], assets: Object.keys(binding.assets) },
    specialist: a.specialist,
  });
  return { runtime, monitors, blockers };
}
