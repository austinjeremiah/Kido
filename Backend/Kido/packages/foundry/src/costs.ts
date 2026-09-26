import type { KidoAgentBlueprint } from "@kido/blueprint";
import type { PlannedBinding } from "@kido/identity";
import { CHAINS, MARKET, MEASURED_GAS, PRICING, evmGasUsd, type PriceSource, type ProviderRegistry } from "@kido/registry";
import { KIDO_DEFAULTS } from "@kido/design-interview";

/**
 * Monthly running cost of an agent on mainnet, per provider it uses and per piece of infrastructure
 * it needs, from the registry's published prices and Amane's measured gas. Usage comes from the
 * blueprint (routed actions, agents, monitors, names) and a few assumptions the owner can change.
 */
export interface CostAssumptions {
  /** How often each routed action runs, per month (per chain it is routed on). */
  actionsPerMonth: Record<string, number>;
  /** How often the agent's lease is renewed, per month (continuous operation renews every lifetime). */
  leaseRenewalsPerMonth: number;
  /** Model wake-ups per month across all specialists. */
  modelCallsPerMonth: number;
  /** Output tokens per model call. */
  outputTokensPerCall: number;
  /** Indexer queries per month (monitors and the portfolio view). */
  indexerQueriesPerMonth: number;
  /** RPC compute units per month. */
  rpcComputeUnitsPerMonth: number;
}

export interface CostItem {
  label: string;
  usd: number;
  recurring: boolean;
  basis: string;
}

export interface CostLine {
  id: string;
  name: string;
  category: "protocol" | "authority" | "transport" | "identity" | "privacy" | "infrastructure";
  model: string;
  paid: boolean;
  monthlyUsd: number;
  oneTimeUsd: number;
  items: CostItem[];
  summary: string;
  /** Why this line is here: the blueprint uses it, or production needs it. */
  reason: string;
  optional: boolean;
  sources: PriceSource[];
}

const fam = (chain: string) => CHAINS.find((c) => c.chainId === chain)?.family;
const round = (n: number) => Math.round(n * 100) / 100;

export function defaultCostAssumptions(bp: KidoAgentBlueprint): CostAssumptions {
  const leaseHours = Math.max(1, bp.authority.leaseLifetimeSeconds / 3600);
  return {
    // Swaps rebalance daily; payments go out twice a week; repay and bridge run only when a monitor
    // or a shortfall calls for them, about weekly.
    actionsPerMonth: Object.fromEntries(bp.authority.allowedActions.map((x) => [x, ({ SWAP: 30, PAY: 8, REPAY: 4, BRIDGE: 4 } as Record<string, number>)[x] ?? 4])),
    // Renewed once a day by default; continuous operation would need one renewal per lifetime.
    leaseRenewalsPerMonth: Math.min(30, Math.ceil(MARKET.hoursPerMonth / leaseHours)),
    // A specialist wakes about twice an hour at most (bounded by the blueprint's hourly cap).
    modelCallsPerMonth: Math.min(bp.reasoning?.maxModelCallsPerHour ?? KIDO_DEFAULTS.maxModelCallsPerHour, 2) * MARKET.hoursPerMonth,
    outputTokensPerCall: 800,
    // Each monitor reads its source once a minute, and the portfolio refreshes every 5 minutes.
    indexerQueriesPerMonth: bp.monitors.length * 43_200 + 8_640,
    rpcComputeUnitsPerMonth: (bp.monitors.length + bp.chains.length) * 43_200 * 104,
  };
}

export function estimateCosts(bp: KidoAgentBlueprint, identity: PlannedBinding[], build: { agents: { contextChars: number }[] } | null, reg: ProviderRegistry, overrides: Partial<CostAssumptions> = {}) {
  const d = defaultCostAssumptions(bp);
  const a: CostAssumptions = { ...d, ...overrides, actionsPerMonth: { ...d.actionsPerMonth, ...(overrides.actionsPerMonth ?? {}) } };
  const times = (action: string) => a.actionsPerMonth[action] ?? 0;
  const lines: CostLine[] = [];
  const evmChains = bp.chains.filter((c) => fam(c) === "evm");
  const suiChains = bp.chains.filter((c) => fam(c) === "sui");
  const gasItem = (label: string, gas: number, times: number, recurring: boolean): CostItem => ({ label, usd: evmGasUsd(gas) * times, recurring, basis: `${times} × ${gas.toLocaleString()} gas at ${MARKET.ethGasGwei} gwei, ETH $${MARKET.ethUsd.toLocaleString()}` });
  const suiItem = (label: string, times: number, recurring: boolean): CostItem => ({ label, usd: MARKET.suiTxUsd * times, recurring, basis: `${times} × ~$${MARKET.suiTxUsd} per Sui transaction` });
  const push = (l: Omit<CostLine, "monthlyUsd" | "oneTimeUsd" | "paid"> & { paid?: boolean }) => {
    const monthlyUsd = round(l.items.filter((i) => i.recurring).reduce((n, i) => n + i.usd, 0));
    const oneTimeUsd = round(l.items.filter((i) => !i.recurring).reduce((n, i) => n + i.usd, 0));
    lines.push({ ...l, items: l.items.map((i) => ({ ...i, usd: round(i.usd) })), monthlyUsd, oneTimeUsd, paid: l.paid ?? PRICING[l.id]?.model !== "FREE" });
  };
  const routed = (providerId: string) => bp.actions.filter((x) => x.providerId === providerId && bp.authority.allowedActions.includes(x.action));

  // Authority: the Amane accounts, the lease, and the payments it executes itself.
  if (bp.authority.provider === "AMANE") {
    const items: CostItem[] = [];
    for (const c of evmChains) {
      items.push(gasItem(`Deploy the Amane account · ${c}`, MEASURED_GAS.evm.accountDeploy, 1, false), gasItem(`Install the owner policy · ${c}`, MEASURED_GAS.evm.policyInstall, 1, false));
      items.push({ ...gasItem(`Lease renewals · ${c}`, MEASURED_GAS.evm.leaseActivate, a.leaseRenewalsPerMonth, true), basis: `${a.leaseRenewalsPerMonth} × ${MEASURED_GAS.evm.leaseActivate.toLocaleString()} gas (${(evmGasUsd(MEASURED_GAS.evm.leaseActivate)).toFixed(2)} USD each) at ${MARKET.ethGasGwei} gwei — the lease lives ${Math.round(bp.authority.leaseLifetimeSeconds / 3600)} h; a longer lease needs fewer renewals` });
    }
    for (const c of suiChains) items.push(suiItem(`Create account and install policy · ${c}`, 3, false), suiItem(`Lease renewals · ${c}`, a.leaseRenewalsPerMonth, true));
    for (const x of routed("amane")) {
      const gas = MEASURED_GAS.evm.action[x.action];
      items.push(fam(x.chain) === "evm" && gas ? gasItem(`${x.action} · ${x.chain}`, gas, times(x.action), true) : suiItem(`${x.action} · ${x.chain}`, times(x.action), true));
    }
    push({ id: "amane", name: PRICING.amane!.name, category: "authority", model: "FREE", items, summary: PRICING.amane!.summary, reason: "Shared Amane contracts are already deployed; this is the agent's own account (one-time) and Ethereum gas for lease renewals and payments", optional: false, sources: PRICING.amane!.sources, paid: false });
  }

  // Protocols: free to use, gas per action.
  for (const p of bp.protocols) {
    const pr = PRICING[p.providerId];
    const items = routed(p.providerId).map((x) => {
      const gas = MEASURED_GAS.evm.action[x.action];
      return fam(x.chain) === "evm" && gas ? gasItem(`${x.action} gas · ${x.chain}`, gas, times(x.action), true) : suiItem(`${x.action} gas · ${x.chain}`, times(x.action), true);
    });
    push({ id: p.providerId, name: pr?.name ?? reg.get(p.providerId)?.displayName ?? p.providerId, category: "protocol", model: pr?.model ?? "FREE", items, summary: pr?.summary ?? "No subscription; you pay gas", reason: `Executes ${[...new Set(routed(p.providerId).map((x) => x.action))].join(", ") || "reads"} on ${p.chain}`, optional: false, sources: pr?.sources ?? [], paid: false });
  }

  // Cross-chain transport: no bridge fee, gas on both ends.
  for (const t of (bp.crossChain?.transports ?? []).filter((t) => PRICING[t])) {
    const bridges = times("BRIDGE");
    const items: CostItem[] = [
      ...(suiChains.length ? [suiItem("Bridge out from Sui", bridges, true)] : []),
      ...(evmChains.length ? [gasItem("Arrival redeem on Ethereum", MEASURED_GAS.evm.action.BRIDGE!, bridges, true), gasItem("Reserved destination action on Ethereum", MEASURED_GAS.evm.reservedAction, bridges, true)] : []),
    ];
    push({ id: t, name: PRICING[t]!.name, category: "transport", model: PRICING[t]!.model, items, summary: PRICING[t]!.summary, reason: `Moves funds between ${bp.chains.join(" and ")}`, optional: false, sources: PRICING[t]!.sources, paid: false });
  }

  // Identity: the agent's name (registered yearly) and a subname per specialist.
  for (const providerId of [...new Set(identity.map((b) => b.providerId))]) {
    const pr = PRICING[providerId];
    if (!pr) continue;
    const own = identity.filter((b) => b.providerId === providerId);
    const subs = own.filter((b) => b.role).length;
    const items: CostItem[] = [{ label: `${own.find((b) => !b.role)?.parent ?? "agent name"} registration`, usd: (pr.namePerYearUsd ?? 0) / 12, recurring: true, basis: `$${pr.namePerYearUsd}/year ÷ 12` }];
    if (pr.family === "evm") items.push(gasItem("Register the name", MEASURED_GAS.evm.ensRegister, 1, false), gasItem(`Agent name + ${subs} specialist subnames with records`, MEASURED_GAS.evm.ensSubname, subs + 1, false));
    else items.push(suiItem(`Agent name + ${subs} specialist subnames`, subs + 2, false));
    push({ id: providerId, name: pr.name, category: "identity", model: pr.model, items, summary: pr.summary, reason: `${own.length} names: ${own.map((b) => b.name).slice(0, 3).join(", ")}${own.length > 3 ? "…" : ""}`, optional: false, sources: pr.sources });
  }

  // Privacy providers the blueprint binds.
  for (const providerId of [...new Set(bp.privacy.providers.map((p) => p.providerId))]) {
    const pr = PRICING[providerId];
    if (!pr) continue;
    const items: CostItem[] = pr.hostPerHourUsd ? [{ label: pr.hostKind ?? "enclave host", usd: pr.hostPerHourUsd * MARKET.hoursPerMonth, recurring: true, basis: `$${pr.hostPerHourUsd}/hour × ${MARKET.hoursPerMonth} hours` }] : [];
    push({ id: providerId, name: pr.name, category: "privacy", model: pr.model, items, summary: pr.summary, reason: "Holds the agent's private values", optional: false, sources: pr.sources });
  }

  // Production infrastructure every running agent needs.
  const graph = PRICING["the-graph"]!;
  const over = Math.max(0, a.indexerQueriesPerMonth - graph.freeUnitsPerMonth!);
  push({ id: graph.id, name: graph.name, category: "infrastructure", model: graph.model, items: [{ label: `${a.indexerQueriesPerMonth.toLocaleString()} queries/month`, usd: Math.ceil(over / graph.unitBlock!) * graph.usdPerBlock!, recurring: true, basis: `${graph.freeUnitsPerMonth!.toLocaleString()} free, then $${graph.usdPerBlock} per ${graph.unitBlock!.toLocaleString()}` }], summary: graph.summary, reason: "Indexed position and pool history for the monitors and the portfolio (production; Kido reads RPC directly today)", optional: false, sources: graph.sources });
  const model = PRICING["openai-model"]!;
  const avgContext = build?.agents.length ? build.agents.reduce((n, x) => n + x.contextChars, 0) / build.agents.length / 4 : 4_000;
  const inTok = a.modelCallsPerMonth * avgContext, outTok = a.modelCallsPerMonth * a.outputTokensPerCall;
  push({ id: model.id, name: model.name, category: "infrastructure", model: model.model, items: [{ label: `${a.modelCallsPerMonth.toLocaleString()} wake-ups × ~${Math.round(avgContext).toLocaleString()} input tokens`, usd: (inTok / 1e6) * model.usdPerMInput!, recurring: true, basis: `$${model.usdPerMInput} per 1M input tokens (context size from the build)` }, { label: `${a.outputTokensPerCall} output tokens per wake-up`, usd: (outTok / 1e6) * model.usdPerMOutput!, recurring: true, basis: `$${model.usdPerMOutput} per 1M output tokens` }], summary: model.summary, reason: `${bp.agents.length} specialists reason only when a deterministic plan is not enough`, optional: false, sources: model.sources });
  const rpc = PRICING["alchemy-rpc"]!;
  const rpcOver = Math.max(0, a.rpcComputeUnitsPerMonth - rpc.freeUnitsPerMonth!);
  push({ id: rpc.id, name: rpc.name, category: "infrastructure", model: rpc.model, items: [{ label: `${(a.rpcComputeUnitsPerMonth / 1e6).toFixed(1)}M compute units/month`, usd: (rpcOver / rpc.unitBlock!) * rpc.usdPerBlock!, recurring: true, basis: `${(rpc.freeUnitsPerMonth! / 1e6).toFixed(0)}M free, then $${rpc.usdPerBlock} per 1M` }], summary: rpc.summary, reason: "Chain reads for monitors, runtime and portfolio", optional: false, sources: rpc.sources });

  // Recommended: an attested enclave for private values on mainnet, when privacy is required and none is bound.
  const naut = PRICING.nautilus!;
  if (bp.privacy.required && !bp.privacy.providers.some((p) => p.providerId === "nautilus")) {
    push({ id: naut.id, name: naut.name, category: "privacy", model: naut.model, items: [{ label: naut.hostKind!, usd: naut.hostPerHourUsd! * MARKET.hoursPerMonth, recurring: true, basis: `$${naut.hostPerHourUsd}/hour × ${MARKET.hoursPerMonth} hours` }], summary: naut.summary, reason: "Recommended for mainnet: evaluates the private threshold inside an attested enclave (today Kido's secret store holds it; Nautilus is local-only here)", optional: true, sources: naut.sources });
  }

  const required = lines.filter((l) => !l.optional);
  return {
    market: { ethUsd: MARKET.ethUsd, ethGasGwei: MARKET.ethGasGwei, suiTxUsd: MARKET.suiTxUsd, asOf: MARKET.asOf, sources: MARKET.sources },
    assumptions: a,
    lines,
    totals: {
      monthlyUsd: round(required.reduce((n, l) => n + l.monthlyUsd, 0)),
      oneTimeUsd: round(required.reduce((n, l) => n + l.oneTimeUsd, 0)),
      optionalMonthlyUsd: round(lines.filter((l) => l.optional).reduce((n, l) => n + l.monthlyUsd, 0)),
    },
    note: "Mainnet estimate. This testnet agent costs nothing real to run; the figures are what the same agent would cost in production at today's prices.",
    measured: MEASURED_GAS.source,
  };
}
