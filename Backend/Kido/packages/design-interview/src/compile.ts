import {
  nextRevision,
  type Action,
  type ChainId,
  type KidoAgentBlueprint,
  type LimitSpec,
  type MonitorSpec,
  type PrivateValueSpec,
} from "@kido/blueprint";
import { ProviderRegistry } from "@kido/registry";
import { UNSERVED_PROVIDER } from "@kido/blueprint";
import { byKey, type Ctx, type ObjectiveKind } from "./catalog.js";
import { KIDO_DEFAULTS } from "./defaults.js";
import { amountFor, spendAssets, type AmountValue } from "./parse.js";

const SPECIALIST_FOR: Partial<Record<Action, string>> = { REPAY: "RepayDebtAgent", SWAP: "SwapAgent", PAY: "PaymentAgent", BRIDGE: "BridgeAgent", SUPPLY: "LiquidityAgent" };

/**
 * Requirements compiler: resolved interview answers → canonical blueprint fields. It never adds a
 * permission that is not in `ctx`; missing grants stay empty and the buildability gate reports them.
 */
export function compileBlueprint(base: KidoAgentBlueprint, reg: ProviderRegistry = new ProviderRegistry()): KidoAgentBlueprint {
  const ctx: Ctx = Object.fromEntries(base.requirements.filter((r) => r.status === "RESOLVED").map((r) => [r.key, r.value]));
  const chains = (ctx["chains"] as ChainId[] | undefined) ?? [];
  const protocols = (ctx["protocols"] as string[] | undefined) ?? [];
  const kind = (ctx["objective.kind"] as ObjectiveKind | undefined) ?? "OTHER";
  let mode = (ctx["authority.mode"] as KidoAgentBlueprint["authority"]["mode"]) ?? null;
  const autonomy = (ctx["authority.autonomy"] as KidoAgentBlueprint["authority"]["autonomy"]) ?? null;
  if (mode === "BOUNDED_AUTONOMOUS_FINANCE" && autonomy === "OWNER_APPROVAL") mode = "APPROVAL_REQUIRED";
  const financial = mode === "BOUNDED_AUTONOMOUS_FINANCE" || mode === "APPROVAL_REQUIRED";
  const allowed = financial || mode === "PROPOSE_ONLY" ? ((ctx["actions.allowed"] as Action[] | undefined) ?? []).filter((a) => a !== "BORROW" && a !== "WITHDRAW") : [];
  const spend = spendAssets(ctx);

  // Providers that execute each allowed action on each chain: the selected protocols, or the
  // registry's executors for actions no protocol is chosen for (payments). (BREAK F-0522)
  const executorsFor = (a: Action, c: ChainId) => {
    const all = reg.executors(a, c).map((p) => p.providerId);
    const chosen = all.filter((id) => protocols.includes(id));
    return chosen.length ? chosen : all.filter((id) => reg.get(id)?.kind !== "protocol");
  };
  const bindings = allowed.flatMap((a) => chains.flatMap((c) => executorsFor(a, c).map((providerId) => ({ action: a, chain: c, providerId }))));

  // Budgets exist only in assets the user chose, on chains where the providers acting there accept
  // them. (BREAK F-0521)
  const limits: LimitSpec[] = [];
  const assets: KidoAgentBlueprint["assets"] = [];
  const floor = ctx["limits.swap_floor"] as { minOutPerIn: string; assetIn: string; assetOut: string } | undefined;
  if (financial) {
    const held = new Set([...spend, ...(allowed.includes("SWAP") && floor ? [floor.assetIn, floor.assetOut] : [])]);
    const w = ctx["limits.window"] as AmountValue | undefined, t = ctx["limits.total"] as AmountValue | undefined;
    const pa = (ctx["limits.per_action"] as AmountValue | undefined) ?? w;
    for (const c of chains) {
      for (const entry of reg.assetsOn(c).filter((a) => held.has(a.symbol))) assets.push({ symbol: entry.symbol, chain: c, ref: entry.ref, decimals: entry.decimals, testnetOnly: entry.testnetOnly });
      if (mode !== "BOUNDED_AUTONOMOUS_FINANCE") continue;
      const actingHere = [...new Set(bindings.filter((b) => b.chain === c).map((b) => b.providerId))];
      for (const sym of spend) {
        if (!reg.assetsOn(c).some((a) => a.symbol === sym)) continue;
        if (actingHere.length && !actingHere.some((p) => reg.assetsFor(p, c).some((a) => a.symbol === sym))) continue;
        const [a1, a2, a3] = [amountFor(pa, sym), amountFor(w, sym), amountFor(t, sym)];
        if (a1 && a2 && a3) limits.push({ chain: c, asset: sym, perAction: a1, perWindow: a2, windowSeconds: KIDO_DEFAULTS.limitWindowSeconds, total: a3 });
      }
    }
  }

  const payees = financial ? ((ctx["payees"] as { label: string; chain: ChainId; address: string }[] | undefined) ?? []).filter((p) => chains.includes(p.chain)) : [];
  // The one wallet whose debt REPAY may reduce, only on a chain where REPAY is executed.
  const ben = ctx["beneficiary"] as { label: string; chain: ChainId; address: string } | undefined;
  const beneficiaries = financial && allowed.includes("REPAY") && ben && bindings.some((b) => b.action === "REPAY" && b.chain === ben.chain) ? [ben] : [];

  const privateValues: PrivateValueSpec[] = ctx["privacy.required"] === true
    ? ((ctx["privacy.values"] as { id: string; kind: PrivateValueSpec["kind"]; description: string }[] | undefined) ?? []).map((v) => ({
        id: v.id,
        description: v.description,
        kind: v.kind,
        hiddenFrom: (ctx["privacy.hidden_from"] as PrivateValueSpec["hiddenFrom"] | undefined) ?? ["PUBLIC_CHAIN"],
        plaintextBoundary: (ctx["privacy.plaintext"] as PrivateValueSpec["plaintextBoundary"] | undefined) ?? "KIDO_SECRET_STORE",
        allowedDisclosure: (ctx["privacy.disclosure"] as PrivateValueSpec["allowedDisclosure"] | undefined) ?? "DECISION_ONLY",
        failurePolicy: "FAIL_CLOSED",
      }))
    : [];
  const privateThreshold = privateValues.find((v) => v.kind === "PRIVATE_POLICY");

  const monitors: MonitorSpec[] = [];
  const dataSources: KidoAgentBlueprint["dataSources"] = [];
  const cond = ctx["monitor.condition"] as { metric: string; op: MonitorSpec["op"]; threshold: string } | undefined;
  const onUnavailable = ctx["data.oracle_failure"] === "FAIL_CLOSED" || ctx["data.oracle_failure"] === undefined ? "FAIL_CLOSED" : "NOTIFY_OWNER";
  if (cond) {
    const src = protocols[0] ?? "chain-rpc";
    const chain = (protocols[0] ? reg.chainsFor(protocols[0]).find((c) => chains.includes(c)) : undefined) ?? chains[0] ?? null;
    dataSources.push({ id: `${src}-state`, providerId: src, chain, kind: cond.metric, minTrust: "RPC_DIRECT", maxAgeMs: KIDO_DEFAULTS.dataMaxAgeMs, onUnavailable, privateValueRef: null });
    const action: Action | null = kind === "LENDING_PROTECTION" && allowed.includes("REPAY") ? "REPAY" : (kind === "REBALANCE" || kind === "TRADING") && allowed.includes("SWAP") ? "SWAP" : null;
    monitors.push({
      id: `${cond.metric.toLowerCase()}-watch`,
      dataSource: `${src}-state`,
      metric: cond.metric,
      op: cond.op,
      threshold: privateThreshold ? null : cond.threshold,
      thresholdPrivateRef: privateThreshold ? privateThreshold.id : null,
      response: mode === "BOUNDED_AUTONOMOUS_FINANCE" && autonomy !== "OWNER_APPROVAL" && action ? "DETERMINISTIC_ACTION" : mode === "READ_ONLY" ? "NOTIFY" : "WAKE_SPECIALIST",
      action: mode === "READ_ONLY" ? null : action,
      target: cond.metric === "ALLOCATION_DRIFT" ? ((ctx["rebalance.target"] as { asset: string; share: string } | undefined) ?? null) : null,
    });
  }

  const specialists = [...new Set(allowed.map((a) => SPECIALIST_FOR[a]).filter(Boolean))] as string[];
  const recoveryMode = (ctx["recovery.partial"] as KidoAgentBlueprint["recovery"]["onPartialExecution"]) ?? null;
  if (recoveryMode === "WAKE_RECOVERY_AGENT") specialists.push("RecoveryAgent");
  const authorityProvider = mode === "BOUNDED_AUTONOMOUS_FINANCE" ? reg.providers.find((p) => p.kind === "authority") : undefined;
  const transports = reg.providers.filter((p) => p.kind === "transport" && KIDO_DEFAULTS.transportStatuses.includes(p.status) && chains.every((c) => p.chains.includes(c)));
  // Each specialist gets the packs of the providers that execute its own actions. (BREAK F-0533)
  const packsFor = (role: string, owns: Action[]): string[] => {
    const providers = role === "BridgeAgent" ? transports.map((t) => t.providerId) : [...new Set(bindings.filter((b) => owns.includes(b.action)).map((b) => b.providerId))];
    const packs = providers.map((id) => reg.get(id)?.knowledgePack).filter(Boolean) as string[];
    return [...new Set([...KIDO_DEFAULTS.basePacks, ...(authorityProvider ? [authorityProvider.knowledgePack] : []), ...packs])];
  };

  const bridgeAllowed = financial ? ((ctx["authority.bridge"] as boolean | undefined) ?? (chains.length <= 1 ? false : null)) : false;
  const isPublic = (ctx["identity.public"] as boolean | undefined) ?? null;
  const name = ctx["identity.name"] as string | undefined;

  const patch: Partial<KidoAgentBlueprint> = {
    objective: { statement: base.objective.statement, summary: kind },
    chains,
    identity: {
      public: isPublic,
      organization: name ? (name.split(/[.-]/).filter(Boolean).slice(-1)[0] ?? null) : null,
      bindings: isPublic
        ? chains.flatMap((c) => reg.find("identity", c, "RESOLVE").map((p) => ({ provider: p.providerId as "ens" | "suins", chain: c, name: null, status: "PLANNED" as const })))
        : [],
      advertisedCapabilities: isPublic ? allowed.map((a) => `kido:${a.toLowerCase()}`) : [],
      endpoints: {},
    },
    protocols: protocols.map((p) => {
      const m = reg.get(p)!;
      return { providerId: p, chain: m.chains.find((c) => chains.includes(c)) ?? m.chains[0]!, capabilities: m.capabilities, version: m.version };
    }),
    assets,
    dataSources,
    privacy: { required: (ctx["privacy.required"] as boolean | undefined) ?? null, values: privateValues, providers: [] },
    authority: {
      mode,
      provider: mode === "BOUNDED_AUTONOMOUS_FINANCE" ? "AMANE" : mode === "APPROVAL_REQUIRED" ? "OWNER_WALLET" : null,
      autonomy,
      allowedActions: allowed,
      forbiddenActions: ["BORROW", "WITHDRAW"],
      limits,
      payees,
      beneficiaries,
      bridgeAllowed,
      leaseLifetimeSeconds: Number(ctx["authority.lease_lifetime"] ?? byKey("authority.lease_lifetime")?.safeDefault?.(ctx) ?? KIDO_DEFAULTS.leaseLifetimeSeconds),
      swapFloors: (() => {
        const f = floor;
        if (!f || !allowed.includes("SWAP")) return [];
        return chains.filter((c) => reg.assetsOn(c).some((a) => a.symbol === f.assetIn) && reg.assetsOn(c).some((a) => a.symbol === f.assetOut)).map((c) => ({ chain: c, ...f }));
      })(),
    },
    monitors,
    triggers: monitors.map((m) => ({ id: `${m.id}-trigger`, kind: "MONITOR", monitor: m.id })),
    actions: allowed.flatMap((a) => {
      const deterministic = monitors.some((m) => m.action === a && m.response === "DETERMINISTIC_ACTION");
      const bs = bindings.filter((b) => b.action === a);
      return bs.length ? bs.map((b) => ({ ...b, deterministic })) : chains.map((chain) => ({ action: a, chain, providerId: UNSERVED_PROVIDER, deterministic }));
    }),
    reasoning: {
      model: "env",
      wakeConditions: ["EXPECTED_STATE_DIVERGED", "RESOURCE_SHORTFALL", "MULTIPLE_COMPLIANT_PATHS", "CONSTRAINT_CONFLICT", "PARTIAL_EXECUTION", "PROTOCOL_UNAVAILABLE", "NO_DETERMINISTIC_PLAN"],
      maxModelCallsPerHour: KIDO_DEFAULTS.maxModelCallsPerHour,
    },
    agents: specialists.map((role) => ({
      role,
      owns: allowed.filter((a) => SPECIALIST_FOR[a] === role).concat(role === "RecoveryAgent" ? allowed : []),
      mayRequest: bridgeAllowed ? ["BRIDGE"] : [],
      knowledgePacks: packsFor(role, role === "RecoveryAgent" ? allowed : allowed.filter((a) => SPECIALIST_FOR[a] === role)),
    })),
    recovery: { onPartialExecution: recoveryMode, allowedRecoveryActions: recoveryMode === "WAKE_RECOVERY_AGENT" ? allowed : [], maxRecoveryAttempts: KIDO_DEFAULTS.maxRecoveryAttempts, onOracleUnavailable: onUnavailable === "FAIL_CLOSED" ? "FAIL_CLOSED" : "NOTIFY_OWNER" },
    crossChain: bridgeAllowed ? { allowed: true, transports: transports.map((t) => t.providerId), maxAmountPerIntent: limits.map((l) => ({ asset: l.asset, amount: l.perAction })), recoveryDeadlineSeconds: KIDO_DEFAULTS.crossChainRecoveryDeadlineSeconds } : undefined,
    amane: authorityProvider ? { manifestRef: authorityProvider.deploymentManifestRef ?? "", accountId: null, endpoints: chains.map((c) => ({ chain: c, account: null })), policyHash: null } : undefined,
    simulationScenarios: scenarioList(mode, allowed, bridgeAllowed === true, privateValues.length > 0, isPublic === true),
    securityAssertions: [
      { id: "no-arbitrary-target", statement: "the agent never authorizes a raw target or calldata" },
      { id: "no-arbitrary-recipient", statement: "payments go only to pinned payees; swap output returns to the account" },
      { id: "no-borrow-withdraw", statement: "BORROW and WITHDRAW are never granted to the agent" },
      { id: "identity-not-authority", statement: "identity records never grant financial authority" },
      ...(privateValues.length ? [{ id: "no-secret-leak", statement: "private values never reach logs, events, identity records or model context" }] : []),
    ],
    generatedModules: [
      { id: "monitors", kind: "monitor-engine", from: ["monitors", "dataSources"] },
      { id: "runtime", kind: "kido-runtime", from: ["reasoning", "agents", "recovery"] },
      ...(mode === "BOUNDED_AUTONOMOUS_FINANCE" ? [{ id: "authority", kind: "amane-policy", from: ["authority", "assets", "protocols"] }] : []),
    ],
    deployment: { environment: "testnet", chains },
  };
  return nextRevision(base, patch);
}

function scenarioList(mode: string | null, allowed: Action[], bridge: boolean, privacy: boolean, identity: boolean) {
  const s = [{ id: "happy-path", family: "happy", description: "normal condition handled as specified" }];
  if (mode === "BOUNDED_AUTONOMOUS_FINANCE") {
    s.push(
      { id: "overspend", family: "authority", description: "an action above the per-action/window/total cap is refused" },
      { id: "wrong-recipient", family: "authority", description: "a payment or output to an unpinned address is refused" },
      { id: "expired-authority", family: "authority", description: "an expired lease cannot act" },
      { id: "revoked-authority", family: "authority", description: "a revoked lease cannot act while the runtime keeps running" },
      { id: "prompt-injection", family: "adversarial", description: "instructions inside external data never expand authority" },
      { id: "partial-execution", family: "recovery", description: "a failed middle step enters RECOVERY_REQUIRED" },
    );
    if (allowed.includes("REPAY")) s.push({ id: "wrong-beneficiary", family: "authority", description: "repaying someone else's debt is refused" });
  }
  s.push({ id: "stale-oracle", family: "data", description: "stale or missing data fails closed" }, { id: "protocol-unavailable", family: "data", description: "an unavailable protocol produces no action" });
  if (bridge) s.push({ id: "bridge-timeout", family: "cross-chain", description: "a bridge timeout leaves funds in a recovery state" });
  if (privacy) s.push({ id: "private-provider-unavailable", family: "privacy", description: "private computation unavailable follows the failure policy" });
  if (identity) s.push({ id: "identity-resolution-failure", family: "identity", description: "identity lookup failure never affects financial authority" });
  return s;
}
