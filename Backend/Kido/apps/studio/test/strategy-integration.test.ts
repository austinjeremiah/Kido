import { describe, it, expect } from "vitest";
import { buildRegistry, resolveBlueprintAdapters, resolveExecutionCapability, adapterCatalogue } from "../src/adapters.js";
import { compileProposal, proposalToStrategy, strategyDataRequirements, strategyExecutionCapabilities } from "../src/strategy.js";
import { compileStrategy } from "@contextlock/studio-strategy";
import type { StrategyProposal } from "../src/agents/roles.js";

/**
 * P17 integration: the compiler as the Studio actually uses it.
 *
 * The unit and graph rules are tested in `packages/studio-strategy`. These check the seams — the
 * proposal translation supplies no defaults, adapter resolution stays generic, and a strategy that
 * needs more than one transaction says so instead of improvising.
 */

const proposal = (over: Partial<StrategyProposal> = {}): StrategyProposal => ({
  planId: "treasury",
  triggers: [{ id: "drift", kind: "threshold", description: "allocation drift" }],
  inputs: [
    { id: "eth-price", requirementKey: "ethUsd", dataKind: "eth_usd_price", unitKind: "PRICE", unitDecimals: 8, unitSubject: "USD", minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 30_000, description: "verified price" },
    { id: "portfolio", requirementKey: "portfolioUsd", dataKind: "aave_total_collateral_usd", unitKind: "USD_VALUE", unitDecimals: 8, unitSubject: "USD", minimumTrustClass: "DIRECT_CHAIN_DATA", maxAgeMs: 120_000, description: "portfolio value" },
    { id: "eth-bal", requirementKey: "ethBalance", dataKind: "indexed_token_balance", unitKind: "TOKEN_AMOUNT", unitDecimals: 18, unitSubject: "ETH", minimumTrustClass: "INDEXED_CHAIN_DATA", maxAgeMs: 120_000, description: "eth balance" },
  ],
  transforms: [
    { id: "eth-usd", op: "TOKEN_TO_USD", inputs: ["eth-bal", "eth-price"], toDecimals: null, description: "eth in usd" },
    { id: "alloc-bps", op: "RATIO_TO_BPS", inputs: ["eth-usd", "portfolio"], toDecimals: null, description: "allocation" },
  ],
  decisions: [
    {
      id: "rebalance", compareOp: "LT",
      left: { type: "ref", id: "alloc-bps" },
      right: { type: "literal", value: "4000", unitKind: "BASIS_POINTS", unitDecimals: 4, unitSubject: null },
      actionRef: "swap", autonomousMaxUsdCents: 50_000, escalationMaxUsdCents: 200_000, description: "buy eth when low",
    },
  ],
  actions: [{ id: "swap", capability: "TOKEN_SWAP", actionKind: "TOKEN_SWAP", spendsAsset: "USDC", recipientPolicy: "self-only", description: "swap usdc to eth" }],
  unknowns: [],
  needsMultiStepPlan: false,
  rationale: "test",
  ...over,
});

function expectProblem(r: { problems: Array<{ code: string }> }, code: string) {
  const codes = r.problems.map((p) => p.code);
  expect(codes, `expected ${code}, got ${codes.join(", ") || "none"}`).toContain(code);
}

describe("STRAT-001 a model proposal compiles into a valid IR", () => {
  it("translates and compiles cleanly", () => {
    const { compiled, strategy } = compileProposal(proposal(), 1);
    expect(compiled.problems.filter((p) => p.severity === "CRITICAL" || p.severity === "HIGH")).toEqual([]);
    expect(compiled.buildable).toBe(true);
    expect(strategy.schemaVersion).toBe("contextlock.strategy/v1");
  });

  it("the translation supplies no defaults", () => {
    // A null limit stays null and becomes an unknown; it is never quietly filled in.
    const s = proposalToStrategy(proposal({
      decisions: [{ ...proposal().decisions[0]!, autonomousMaxUsdCents: null, escalationMaxUsdCents: null }],
      unknowns: [{ field: "autonomousMaxUsdCents", reason: "not stated", requiredBefore: "BUILD" }],
    }), 1);
    expect(s.decisions[0]!.autonomousMaxUsdCents).toBeNull();
    expect(s.decisions[0]!.escalationMaxUsdCents).toBeNull();
  });

  it("aboveCeiling is not a field the model can set", () => {
    const s = proposalToStrategy(proposal(), 1);
    expect(s.decisions[0]!.aboveCeiling).toBe("DENY");
    expect(Object.keys(proposal().decisions[0]!)).not.toContain("aboveCeiling");
  });
});

describe("STRAT-002 a missing limit blocks the build rather than being invented", () => {
  it("is CRITICAL and unbuildable", () => {
    const { compiled } = compileProposal(proposal({
      decisions: [{ ...proposal().decisions[0]!, escalationMaxUsdCents: null }],
      unknowns: [{ field: "escalationMaxUsdCents", reason: "the prompt states when to escalate but never a hard deny ceiling", requiredBefore: "BUILD" }],
    }), 1);
    expectProblem(compiled, "STRAT-UNKNOWN-LIMIT");
    expect(compiled.buildable).toBe(false);
  });
});

describe("STRAT-006 the correct adapter is chosen by capability", () => {
  it("resolves every strategy input through the generic resolver", () => {
    const registry = buildRegistry();
    const { strategy } = compileProposal(proposal(), 1);
    const report = resolveBlueprintAdapters(registry, { dataRequirements: strategyDataRequirements(strategy) } as never);
    expect(report.unresolved).toEqual([]);
    const byKey = Object.fromEntries(report.bindings.map((b) => [b.configRef, b.adapterId]));
    expect(byKey.ethUsd).toBe("chainlink-data-streams");
    expect(byKey.portfolioUsd).toBe("aave-v3-state");
    expect(byKey.ethBalance).toBe("thegraph-token-api");
  });

  it("resolves the execution capability without naming a provider", () => {
    const registry = buildRegistry();
    const { strategy } = compileProposal(proposal(), 1);
    const caps = strategyExecutionCapabilities(strategy);
    expect(caps).toEqual(["TOKEN_SWAP"]);
    const r = resolveExecutionCapability(registry, caps[0]!, 11155111);
    expect("unresolved" in r).toBe(false);
    if (!("unresolved" in r)) expect(r.adapterId).toBe("uniswap-universal-router");
  });

  it("the strategy names no provider anywhere", () => {
    const json = JSON.stringify(compileProposal(proposal(), 1).strategy).toLowerCase();
    for (const p of ["uniswap", "chainlink", "thegraph", "aave-v3-state"]) {
      expect(json, `strategy names ${p}`).not.toContain(p);
    }
  });
});

describe("STRAT-007 an incompatible requirement is rejected, not downgraded", () => {
  it("a verified-price requirement no adapter can meet is reported unresolved", () => {
    const registry = buildRegistry();
    const s = proposalToStrategy(proposal({
      inputs: [{ ...proposal().inputs[0]!, dataKind: "historical_swap_volume", minimumTrustClass: "VERIFIED_ORACLE" }],
      transforms: [], decisions: [{ ...proposal().decisions[0]!, left: { type: "ref", id: "eth-price" }, right: { type: "literal", value: "1", unitKind: "PRICE", unitDecimals: 8, unitSubject: "USD" } }],
    }), 1);
    const report = resolveBlueprintAdapters(registry, { dataRequirements: strategyDataRequirements(s) } as never);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]!.rejected.some((r) => /offers INDEXED_CHAIN_DATA/.test(r.reason))).toBe(true);
  });

  it("the catalogue tells the model what is achievable, so it does not ask for the impossible", () => {
    const cat = adapterCatalogue(buildRegistry(), 11155111);
    const hf = cat.dataKinds.find((k) => k.kind === "aave_position_health_factor")!;
    expect(hf.minAchievableMaxAgeMs).toBe(12_000);
    const price = cat.dataKinds.find((k) => k.kind === "eth_usd_price")!;
    expect(price.minAchievableMaxAgeMs).toBe(1_000);
    expect(cat.executionCapabilities).toContain("TOKEN_SWAP");
    expect(cat.executionCapabilities).toContain("REPAY");
  });
});

describe("STRAT-019 a multi-step need is deferred to P19, not improvised", () => {
  it("carries the capability marker through", () => {
    const { strategy, compiled } = compileProposal(proposal({ needsMultiStepPlan: true }), 1);
    expect(strategy.requiresCapability).toEqual(["REQUIRES_P19_CAPABILITY"]);
    expect(compiled.requiresCapability).toEqual(["REQUIRES_P19_CAPABILITY"]);
  });

  it("the Aave-then-swap case: the strategy says it needs a plan rather than inventing one", () => {
    // "If I have enough USDC repay Aave, otherwise escalate rather than swapping first."
    const p = proposal({
      planId: "guardian-with-funding",
      inputs: [
        { id: "hf", requirementKey: "hf", dataKind: "aave_position_health_factor", unitKind: "HEALTH_FACTOR", unitDecimals: 18, unitSubject: null, minimumTrustClass: "DIRECT_CHAIN_DATA", maxAgeMs: 60_000, description: "health factor" },
      ],
      transforms: [],
      decisions: [{
        id: "repay-when-unhealthy", compareOp: "LT",
        left: { type: "ref", id: "hf" },
        right: { type: "literal", value: "1350000000000000000", unitKind: "HEALTH_FACTOR", unitDecimals: 18, unitSubject: null },
        actionRef: "repay", autonomousMaxUsdCents: 100_000, escalationMaxUsdCents: 500_000, description: "repay below 1.35",
      }],
      actions: [{ id: "repay", capability: "REPAY", actionKind: "AAVE_REPAY", spendsAsset: "USDC", recipientPolicy: "self-only", description: "repay debt" }],
      needsMultiStepPlan: true,
    });
    const { strategy, compiled } = compileProposal(p, 1);
    expect(compiled.buildable).toBe(true);
    expect(strategy.requiresCapability).toContain("REQUIRES_P19_CAPABILITY");
    // Exactly one action. The swap-then-repay chain is NOT smuggled into it.
    expect(strategy.actions).toHaveLength(1);
  });
});

describe("STRAT-020 the compiled strategy corresponds to what is generated", () => {
  it("every strategy input maps to a resolvable data requirement", () => {
    const { strategy } = compileProposal(proposal(), 1);
    const reqs = strategyDataRequirements(strategy);
    expect(reqs.map((r) => r.key).sort()).toEqual(["ethBalance", "ethUsd", "portfolioUsd"]);
    for (const r of reqs) {
      const input = strategy.inputs.find((i) => i.requirementKey === r.key)!;
      expect(r.kind).toBe(input.dataKind);
      expect(r.minimumTrustClass).toBe(input.minimumTrustClass);
      expect(r.maxAgeMs).toBe(input.maxAgeMs);
    }
  });

  it("STRAT-018 an adapter version change invalidates a compiled strategy's evidence", () => {
    // The strategy is bound to a Blueprint revision; the Blueprint pins adapter versions. Bumping
    // one bumps the revision, which is what marks prior simulations stale (proven in ADAPTER-011).
    const a = compileProposal(proposal(), 1);
    const b = compileProposal(proposal(), 2);
    expect(a.strategy.revision).not.toBe(b.strategy.revision);
    expect(JSON.stringify(a.compiled.provenance)).toBe(JSON.stringify(b.compiled.provenance));
  });
});

describe("STRAT-013 unit errors in a model proposal are caught, not executed", () => {
  it("a health factor compared against basis points is rejected", () => {
    const { compiled } = compileProposal(proposal({
      inputs: [{ ...proposal().inputs[0]!, id: "hf", unitKind: "HEALTH_FACTOR", unitDecimals: 18, unitSubject: null, dataKind: "aave_position_health_factor", minimumTrustClass: "DIRECT_CHAIN_DATA" }],
      transforms: [],
      decisions: [{ ...proposal().decisions[0]!, left: { type: "ref", id: "hf" }, right: { type: "literal", value: "16000", unitKind: "BASIS_POINTS", unitDecimals: 4, unitSubject: null } }],
    }), 1);
    expectProblem(compiled, "STRAT-UNIT-KIND");
    expect(compiled.buildable).toBe(false);
  });

  it("a health factor at the wrong SCALE is rejected too", () => {
    // 1.6 as "16" at 1 decimal is the same kind and a different scale — the subtler mistake.
    const { compiled } = compileProposal(proposal({
      inputs: [{ ...proposal().inputs[0]!, id: "hf", unitKind: "HEALTH_FACTOR", unitDecimals: 18, unitSubject: null, dataKind: "aave_position_health_factor", minimumTrustClass: "DIRECT_CHAIN_DATA" }],
      transforms: [],
      decisions: [{ ...proposal().decisions[0]!, left: { type: "ref", id: "hf" }, right: { type: "literal", value: "16", unitKind: "HEALTH_FACTOR", unitDecimals: 1, unitSubject: null } }],
    }), 1);
    expectProblem(compiled, "STRAT-UNIT-SCALE");
  });
});
