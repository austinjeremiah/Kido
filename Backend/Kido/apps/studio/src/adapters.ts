import {
  AdapterRegistry,
  ReferenceChainReaderAdapter,
  ReferenceExecutionAdapter,
  ReferenceOracleAdapter,
  UniswapExecutionAdapter,
  TheGraphTokenApiAdapter,
  TheGraphSubstreamsAdapter,
  ChainlinkDataFeedsAdapter,
  ChainlinkDataStreamsAdapter,
  CreExternalApiAdapter,
  ChainlinkFunctionsAdapter,
  AaveStateAdapter,
  AaveExecutionAdapter,
  ChainlinkCcipAdapter,
  ccipManifest,
  aaveStateManifest,
  aaveExecutionManifest,
  MorphoStateAdapter, MorphoExecutionAdapter, morphoStateManifest, morphoExecutionManifest,
  CompoundStateAdapter, CompoundExecutionAdapter, compoundStateManifest, compoundExecutionManifest,
  LidoStateAdapter, LidoExecutionAdapter, lidoStateManifest, lidoExecutionManifest,
  chainlinkDataFeedsManifest,
  chainlinkDataStreamsManifest,
  creExternalApiManifest,
  chainlinkFunctionsManifest,
  thegraphSubgraphManifest,
  thegraphTokenApiManifest,
  thegraphSubstreamsManifest,
  referenceChainReaderManifest,
  referenceExecutionManifest,
  referenceOracleManifest,
  uniswapTradingApiManifest,
  uniswapUniversalRouterManifest,
  resolveWithSuggestion,
  ModelOverrideRejectedError,
  type DataRequirement,
} from "@contextlock/studio-adapters";
import { subgraphAdapter } from "./thegraph.js";
import { DEFAULT_UPSTREAM_RPC } from "./fork/chain.js";
import type { BlueprintAdapterBinding, ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";

/**
 * The Studio's adapter registry.
 *
 * Every provider integration enters through here. There is deliberately no provider-specific code
 * anywhere above this module: the pipeline, the graph, the templates and the validator all read
 * manifests and bindings. Phases 13–15 add entries to this function and nothing else.
 */
export function buildRegistry(): AdapterRegistry {
  const r = new AdapterRegistry();
  r.register({ kind: "data", manifest: referenceOracleManifest, adapter: new ReferenceOracleAdapter() });
  r.register({ kind: "data", manifest: referenceChainReaderManifest, adapter: new ReferenceChainReaderAdapter() });
  r.register({ kind: "execution", manifest: referenceExecutionManifest, adapter: new ReferenceExecutionAdapter() });

  /* Phase 13 — Uniswap. Both modes; the hosted one declares its real (mainnet-only) chain list, so
   * the resolver structurally cannot select it for a Sepolia build. See FND-V2-007. */
  r.register({
    kind: "execution",
    manifest: uniswapUniversalRouterManifest,
    adapter: new UniswapExecutionAdapter("universal-router"),
  });
  r.register({
    kind: "execution",
    manifest: uniswapTradingApiManifest,
    adapter: new UniswapExecutionAdapter("trading-api"),
  });

  /* Phase 14 — The Graph. Three adapters, not one: their trust and freshness properties differ and
   * flattening them would hide that. All are INDEXED_CHAIN_DATA and can never satisfy a
   * verified-oracle requirement. */
  // The subgraph adapter is live when THEGRAPH_API_KEY is set (see ./thegraph.ts); the other two
  // take a different credential this build does not hold, so they keep no transport.
  r.register({ kind: "data", manifest: thegraphSubgraphManifest, adapter: subgraphAdapter(process.env.MAINNET_RPC_URL ?? DEFAULT_UPSTREAM_RPC) });
  r.register({ kind: "data", manifest: thegraphTokenApiManifest, adapter: new TheGraphTokenApiAdapter() });
  r.register({ kind: "data", manifest: thegraphSubstreamsManifest, adapter: new TheGraphSubstreamsAdapter() });

  /* Phase 15 — Chainlink. Four adapters, not one: Feeds and Streams are VERIFIED_ORACLE, CRE is
   * CONFIDENTIAL_VERIFIED_COMPUTE, and Functions is EXTERNAL_API because the DON attests that the
   * code ran, not that the answer is a market truth. A single ChainlinkAdapter would hide that. */
  r.register({ kind: "data", manifest: chainlinkDataFeedsManifest, adapter: new ChainlinkDataFeedsAdapter() });
  r.register({ kind: "data", manifest: chainlinkDataStreamsManifest, adapter: new ChainlinkDataStreamsAdapter() });
  r.register({ kind: "data", manifest: creExternalApiManifest, adapter: new CreExternalApiAdapter() });
  r.register({ kind: "data", manifest: chainlinkFunctionsManifest, adapter: new ChainlinkFunctionsAdapter() });

  /* Phase 16 — Aave v3. Two adapters from one protocol, because reading a position reports a number
   * and repaying a debt moves money. The execution adapter can construct WITHDRAW and BORROW; that
   * is a decoding capability, not a grant. */
  r.register({ kind: "data", manifest: aaveStateManifest, adapter: new AaveStateAdapter() });
  r.register({ kind: "execution", manifest: aaveExecutionManifest, adapter: new AaveExecutionAdapter() });

  /* Phase 19 — CCIP. Registers as CROSS_CHAIN, a type the kernel declared in P12 and left
   * unimplemented; nothing in the kernel changed to accept it. A send is an execution that names a
   * second chain, and it is validated the same way every other execution is. */
  r.register({ kind: "execution", manifest: ccipManifest, adapter: new ChainlinkCcipAdapter() });

  /* Phase 29 — Morpho Blue, Compound v3 and Lido. Each is two principals on the same terms as
   * Aave: a state adapter that reports a number and an execution adapter that moves money, kept
   * apart. Their execution capabilities carry the protocol's name (MORPHO_REPAY, COMPOUND_REPAY,
   * LIDO_STAKE) because a bare REPAY would resolve to whichever adapter sorted first. */
  r.register({ kind: "data", manifest: morphoStateManifest, adapter: new MorphoStateAdapter() });
  r.register({ kind: "execution", manifest: morphoExecutionManifest, adapter: new MorphoExecutionAdapter() });
  r.register({ kind: "data", manifest: compoundStateManifest, adapter: new CompoundStateAdapter() });
  r.register({ kind: "execution", manifest: compoundExecutionManifest, adapter: new CompoundExecutionAdapter() });
  r.register({ kind: "data", manifest: lidoStateManifest, adapter: new LidoStateAdapter() });
  r.register({ kind: "execution", manifest: lidoExecutionManifest, adapter: new LidoExecutionAdapter() });

  return r;
}

export interface ResolutionReport {
  bindings: BlueprintAdapterBinding[];
  unresolved: Array<{ key: string; kind: string; minimumTrustClass: string; maxAgeMs: number; rejected: Array<{ ref: string; reason: string }> }>;
  overridesRejected: Array<{ key: string; suggested: string; reason: string }>;
}

const ROLE_FOR: Record<string, BlueprintAdapterBinding["role"]> = {
  VERIFIED_MARKET_DATA: "VERIFIED_MARKET_DATA",
  STATE_DATA: "STATE_DATA",
  EXTERNAL_CONTEXT: "EXTERNAL_CONTEXT",
  EXECUTION: "EXECUTION",
  TRIGGER: "TRIGGER",
  CROSS_CHAIN: "CROSS_CHAIN",
};

/**
 * Resolve every data requirement in a Blueprint to a pinned adapter.
 *
 * Model suggestions are passed through `resolveWithSuggestion`, which accepts one only when the
 * deterministic rules would have accepted it anyway. An unresolvable requirement is reported, never
 * papered over with the closest available source — a price requirement that quietly falls back to
 * an indexer returns a number that looks completely normal, which is what makes it dangerous.
 */
export function resolveBlueprintAdapters(
  registry: AdapterRegistry,
  bp: Pick<ContextLockAgentBlueprint, "dataRequirements">,
  suggestions: Record<string, { adapterId: string; adapterVersion: string }> = {},
): ResolutionReport {
  const bindings: BlueprintAdapterBinding[] = [];
  const unresolved: ResolutionReport["unresolved"] = [];
  const overridesRejected: ResolutionReport["overridesRejected"] = [];

  for (const req of bp.dataRequirements) {
    const requirement = req as unknown as DataRequirement;
    const suggested = suggestions[req.key];
    let outcome;
    try {
      outcome = resolveWithSuggestion(registry, requirement, suggested);
    } catch (e) {
      if (e instanceof ModelOverrideRejectedError) {
        overridesRejected.push({
          key: req.key,
          suggested: e.suggested,
          reason: e.reason,
        });
        // Fall back to deterministic resolution WITHOUT the suggestion. The model's preference is
        // discarded; the requirement itself is still honoured if anything can satisfy it.
        outcome = resolveWithSuggestion(registry, requirement, undefined);
      } else {
        throw e;
      }
    }

    if (!outcome.ok) {
      unresolved.push({
        key: req.key,
        kind: req.kind,
        minimumTrustClass: req.minimumTrustClass,
        maxAgeMs: req.maxAgeMs,
        rejected: outcome.rejected,
      });
      continue;
    }

    const manifest = registry.resolve(outcome.selection.adapterId, outcome.selection.adapterVersion).manifest;
    bindings.push({
      adapterId: outcome.selection.adapterId,
      adapterVersion: outcome.selection.adapterVersion,
      role: ROLE_FOR[manifest.adapterType] ?? "STATE_DATA",
      configRef: req.key,
      rationale: outcome.selection.rationale,
    });
  }

  return { bindings, unresolved, overridesRejected };
}


/**
 * Resolve an execution capability to a pinned adapter.
 *
 * Capability-and-chain based, never provider based. On Sepolia this selects the direct Universal
 * Router mode because the hosted Trading API declares a mainnet-only chain list — the refusal is
 * structural rather than a rule someone has to remember (FND-V2-007).
 */
export function resolveExecutionCapability(
  registry: AdapterRegistry,
  capability: string,
  chainId: number,
): BlueprintAdapterBinding | { unresolved: { capability: string; chainId: number; rejected: string[] } } {
  const candidates = registry.findByCapability({ capability, adapterType: "EXECUTION", chainId });
  if (candidates.length === 0) {
    const named = registry
      .list()
      .filter((m) => m.adapterType === "EXECUTION" && m.capabilities.some((c) => c.name === capability))
      .map((m) => `${m.id}@${m.version} (chains ${m.supportedChains.join(",")})`);
    return { unresolved: { capability, chainId, rejected: named } };
  }
  const chosen = [...candidates].sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`))[0]!;
  return {
    adapterId: chosen.id,
    adapterVersion: chosen.version,
    role: "EXECUTION",
    configRef: capability,
    rationale: `${chosen.id}@${chosen.version} provides ${capability} on chain ${chainId}; ${candidates.length - 1} other candidate(s) available`,
  };
}


/**
 * The vocabulary the Architecture Agent may choose from.
 *
 * Without this the model invents plausible-sounding data kinds — `eth_price`, `usdc_balance` — that
 * no adapter declares, producing requirements nothing can satisfy. Constraining it to what the
 * registry actually offers turns an unresolvable build into a solvable design problem, and keeps
 * selection deterministic: the model picks a KIND, the resolver picks the adapter.
 */
export function adapterCatalogue(registry: AdapterRegistry, chainId: number) {
  const dataKinds = new Map<string, { trusts: Set<string>; bestStalenessMs: number }>();
  const executionCapabilities = new Set<string>();

  for (const m of registry.list()) {
    if (!m.supportedChains.includes(chainId)) continue;
    for (const c of m.capabilities) {
      if (m.adapterType === "EXECUTION") {
        executionCapabilities.add(c.name);
      } else if (c.dataKind) {
        const entry = dataKinds.get(c.dataKind) ?? { trusts: new Set<string>(), bestStalenessMs: Number.MAX_SAFE_INTEGER };
        entry.trusts.add(c.trustClass ?? m.trustClass);
        entry.bestStalenessMs = Math.min(entry.bestStalenessMs, m.freshnessSemantics.typicalStalenessMs ?? Number.MAX_SAFE_INTEGER);
        dataKinds.set(c.dataKind, entry);
      }
    }
  }

  return {
    chainId,
    dataKinds: [...dataKinds.entries()]
      .map(([kind, e]) => ({
        kind,
        availableTrustClasses: [...e.trusts].sort(),
        /*
         * The tightest freshness any registered adapter can actually meet for this kind.
         *
         * Without it the model asks for sub-second freshness on a chain read, no adapter qualifies,
         * and the requirement is unresolvable — a correct refusal for a design nobody could have
         * built. Telling it what is achievable turns that into a solvable choice. The resolver still
         * decides; this only stops the model asking for the impossible.
         */
        minAchievableMaxAgeMs: e.bestStalenessMs === Number.MAX_SAFE_INTEGER ? null : e.bestStalenessMs,
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),
    executionCapabilities: [...executionCapabilities].sort(),
  };
}
