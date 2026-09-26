import { parseAbi, type Address, type PublicClient } from "viem";
import type { KidoAgentBlueprint } from "@kido/blueprint";
import type { AgentLease, RootPolicy } from "@kido/amane-bridge";
import type { ProviderRegistry } from "@kido/registry";
import { AgentRuntime, MonitorEngine, aaveHealthMonitor, repayResponder, type ActionExecutor, type AuthorityResult, type CompileContext, type EventLog, type MonitorSpec, type RecoveryPolicy, type RepayWorld, type Specialist } from "@kido/runtime";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export interface RuntimeBuild {
  runtime: AgentRuntime<RepayWorld>;
  monitors: MonitorSpec[];
  blockers: string[];
}

/**
 * Turns a built blueprint plus its live authority into a running agent: monitors from the
 * blueprint's monitor specs, deterministic responders for their actions, world state read from the
 * chain, and the compile context bound to the active policy and lease.
 */
export function buildEvmRuntime(a: {
  bp: KidoAgentBlueprint;
  registry: ProviderRegistry;
  authority: Extract<AuthorityResult, { ok: true }>;
  policy: RootPolicy;
  lease: AgentLease;
  account: Address;
  publicClient: PublicClient;
  executor: ActionExecutor;
  log: EventLog;
  /** Repay target = trigger threshold × this margin. */
  targetMargin: number;
  ttlSeconds: bigint;
  specialist?: Specialist;
  clock?: () => number;
}): RuntimeBuild {
  const chain = "ethereum-sepolia" as const;
  const blockers: string[] = [];
  const monitors: MonitorSpec[] = [];
  const responders: ReturnType<typeof repayResponder>[] = [];
  const aave = a.registry.get("aave-v3")?.deployments[chain] as Record<string, Address> | undefined;
  const binding = a.authority.bindings[chain]!;
  const repayAsset = Object.keys(binding.debtTokens)[0];
  const assetRef = repayAsset ? (a.registry.assetsOn(chain).find((x) => x.symbol === repayAsset)?.ref as Address | undefined) : undefined;
  const beneficiary = a.bp.authority.beneficiaries.find((b) => b.chain === chain);

  for (const m of a.bp.monitors) {
    const src = a.bp.dataSources.find((d) => d.id === m.dataSource);
    if (m.metric !== "HEALTH_FACTOR" || src?.providerId !== "aave-v3") {
      blockers.push(`monitor ${m.id}: no live monitor for ${m.metric} from ${src?.providerId}`);
      continue;
    }
    if (m.threshold === null) {
      blockers.push(`monitor ${m.id}: private threshold needs a confidential decision provider`);
      continue;
    }
    if (!aave?.pool || !aave.oracle || !beneficiary || !assetRef || !repayAsset) {
      blockers.push(`monitor ${m.id}: missing pool, oracle, beneficiary or repay asset`);
      continue;
    }
    const threshold = Number(m.threshold);
    monitors.push(aaveHealthMonitor({ id: m.id, client: a.publicClient, pool: aave.pool, oracle: aave.oracle, user: beneficiary.address as Address, asset: assetRef, op: m.op === "GT" ? "GT" : "LT", threshold, maxAgeMs: src.maxAgeMs, chain }));
    if (m.response === "DETERMINISTIC_ACTION" && m.action === "REPAY") responders.push(repayResponder({ chain, asset: repayAsset, beneficiaryLabel: beneficiary.label, targetHealthFactor: threshold * a.targetMargin }));
  }

  const leaseCap = a.lease.endpoints.find((e) => e.account === binding.account)?.assets.find((x) => x.assetId === binding.assets[repayAsset ?? ""])?.maxPerAction ?? 0n;
  let counter = 0n;
  const base = BigInt((a.clock ?? Date.now)()) * 1000n;
  const compile = (): CompileContext => ({
    accountId: a.policy.accountId,
    policy: a.policy,
    lease: a.lease,
    bindings: a.authority.bindings as CompileContext["bindings"],
    nextNonce: () => base + ++counter,
    now: () => BigInt(Math.floor((a.clock ?? Date.now)() / 1000)),
    ttlSeconds: a.ttlSeconds,
  });
  const runtime = new AgentRuntime<RepayWorld>({
    agentId: a.bp.kidoAgentId,
    monitors: new MonitorEngine(monitors, a.clock),
    responders,
    world: async () => ({
      available: assetRef ? await a.publicClient.readContract({ address: assetRef, abi: ERC20, functionName: "balanceOf", args: [a.account] }) : 0n,
      perActionCap: leaseCap,
    }),
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
