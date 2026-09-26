import { describe, expect, it } from "vitest";
import {
  runShadowDecision, shadowExecutionRef, assertShadowTargetAllowed, compileForNetwork,
  assertNoChainIdRewrite, submitToPublicMainnet, REQUIRED_FOR_MAINNET_WRITE,
  SemanticActionSchema, ShadowDecisionSchema, FORBIDDEN_SEMANTIC_FIELDS, SHADOW_REASONS,
  SHADOW_TARGETS, ShadowError,
  sealSnapshot, applyOverlay, computeScenarioHash, assertBaseUnchanged, FLASH_CRASH, STALE_ORACLE,
  OverlayError, OVERLAY_REASONS, SYNTHETIC_TRUST_CLASS, simulatedTrustLabel, SIMULATED_TRUST_PREFIX,
  ScenarioOverlaySchema, OVERLAY_SCHEMA_VERSION,
  compareReadings, assertFallbackAuthorized, SOURCE_REASONS,
  type ForkDescriptor, type SemanticAction, type MarketSnapshot,
} from "../src/index.js";
import { isProductionChain } from "@contextlock/studio-network";
import { snapshotInput, richSnapshotInput, priceObservation, rateObservation, feedSource, rpcSource, REAL_ANCHOR, USDC_MAINNET, USDC_SEPOLIA, WETH_MAINNET } from "./fixtures.js";

/**
 * The Shadow Agent.
 *
 * It observes mainnet and executes on a fork or a testnet. The tests that matter are the ones about
 * what happens to a decision made under mainnet conditions on its way to a different network —
 * §P27.33's "never mutate only chainId" is where this goes wrong in practice.
 */

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};

const FORK: ForkDescriptor = {
  forkId: "fork-aaaaaaaaaaaa",
  sourceChainId: 1,
  chainId: 31337,
  forkBlock: REAL_ANCHOR.number.toString(),
  forkBlockHash: REAL_ANCHOR.hash,
  sourceProviderId: "publicnode",
  anvilVersion: "anvil/v1.2.3",
  endpoint: "http://127.0.0.1:8747",
  createdAtMs: 1789057607000,
  expiresAtMs: 1789059607000,
  state: "READY",
};

const SUPPLY: SemanticAction = {
  kind: "SUPPLY",
  assetId: "usdc",
  counterAssetId: null,
  amount: "1000000000",
  decimals: 6,
  protocol: "aave-v3",
  rationale: "yield above the policy floor with the health factor intact",
};

const PROTOCOLS: Record<string, Record<number, string>> = {
  "aave-v3": { 1: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", 11155111: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951" },
  "uniswap-v3": { 1: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" },
};
const protocolAddressFor = (p: string, chainId: number): string | null => PROTOCOLS[p]?.[chainId] ?? null;

const freshSnapshot = (over = {}): MarketSnapshot => sealSnapshot(snapshotInput(over));

const evaluateAllow = () => ({ verdict: "ALLOW" as const, reasonCode: "ALLOW_POLICY_MATCH", action: SUPPLY });

/* ═════════════════════════ SHADOW-001 … 002 ═════════════════════════ */

describe("SHADOW-001 the shadow agent observes mainnet", () => {
  it("SHADOW-001 a decision cites the mainnet snapshot it was made against, by hash", async () => {
    const snapshot = freshSnapshot();
    const d = await runShadowDecision({
      decisionId: "d1", snapshot, strategyRevision: 3, blueprintRevision: 2,
      maxContextAgeMs: 600_000, nowMs: snapshot.observedAtMs,
      target: "LOCAL_FORK", fork: FORK,
      evaluate: evaluateAllow, protocolAddressFor,
    });
    expect(d.marketSnapshotHash).toBe(snapshot.snapshotHash);
    expect(snapshot.anchorChainId).toBe(1);
    expect(d.verdict).toBe("ALLOW");
    expect(ShadowDecisionSchema.safeParse(d).success).toBe(true);
  });

  it("SHADOW-001b the decision records the revisions that produced it", async () => {
    const snapshot = freshSnapshot();
    const d = await runShadowDecision({
      decisionId: "d1", snapshot, strategyRevision: 7, blueprintRevision: 4,
      creSimulationId: "cre-sim://contextlock/session/0189a1c4-4f2e-47b7-9c58-2b1d3e5f7a90",
      maxContextAgeMs: 600_000, nowMs: snapshot.observedAtMs,
      target: "LOCAL_FORK", fork: FORK, evaluate: evaluateAllow, protocolAddressFor,
    });
    expect(d.strategyRevision).toBe(7);
    expect(d.blueprintRevision).toBe(4);
    // A simulation id, not a workflow id — the P26 distinction survives into P27's records.
    expect(d.creSimulationId).toMatch(/^cre-sim:\/\//);
  });
});

describe("SHADOW-002 the shadow agent cannot execute on mainnet", () => {
  it("SHADOW-002 the target union has two members and neither is mainnet", () => {
    expect([...SHADOW_TARGETS]).toEqual(["LOCAL_FORK", "TESTNET"]);
    // `chainId` is not an input to target selection, so "chain 1" is not something a caller can say.
    expect(shadowExecutionRef("LOCAL_FORK", { fork: FORK }).chainId).toBe(31337);
    expect(shadowExecutionRef("TESTNET", {}).chainId).toBe(11155111);
  });

  it("SHADOW-002b a hand-built mainnet reference is refused", () => {
    /*
     * Reached only by constructing a NetworkRef directly. Checked anyway: "unreachable" is a claim
     * about today's call graph, and this is the mandatory mutation "let Shadow Agent pick chainId=1".
     */
    expect(reasonOf(() => assertShadowTargetAllowed({ chainId: 1, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null }, "t")))
      .toBe(SHADOW_REASONS.CANNOT_EXECUTE_MAINNET);
    expect(reasonOf(() => assertShadowTargetAllowed({ chainId: 1, role: "READ_ONLY_SOURCE", forkedFrom: null, forkBlock: null }, "t")))
      .toBe(SHADOW_REASONS.CANNOT_EXECUTE_MAINNET);
  });

  it("SHADOW-002c every production chain is refused, not only chain 1", () => {
    for (const chainId of [1, 137, 42161, 10, 8453, 56]) {
      expect(isProductionChain(chainId), `${chainId}`).toBe(true);
      expect(() => assertShadowTargetAllowed({ chainId, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null }, "t"), `${chainId}`).toThrow(ShadowError);
    }
  });

  it("SHADOW-002d asking for a testnet that is not approved is refused", () => {
    expect(reasonOf(() => shadowExecutionRef("TESTNET", { testnetChainId: 5 }))).toBe(SHADOW_REASONS.NO_TARGET);
    // 31337 is a fork, not a testnet — asking for it as a TESTNET target is refused too.
    expect(reasonOf(() => shadowExecutionRef("TESTNET", { testnetChainId: 31337 }))).toBe(SHADOW_REASONS.NO_TARGET);
  });

  it("SHADOW-002e there is no public mainnet submission path, and no component for one", () => {
    expect(reasonOf(() => submitToPublicMainnet({ to: "0x", data: "0x" }))).toBe(SHADOW_REASONS.NO_PUBLIC_MAINNET_PATH);
    try { submitToPublicMainnet({}); } catch (e) {
      expect((e as Error).message).toMatch(/no mainnet relayer/);
      expect((e as Error).message).toMatch(/Possessing an intent, calldata, a capability or a key does not create one/);
    }
    expect([...REQUIRED_FOR_MAINNET_WRITE]).toContain("mainnet-relayer");
    expect([...REQUIRED_FOR_MAINNET_WRITE]).toContain("mainnet-signer");
  });

  it("SHADOW-002f holding every artifact an attacker could want still does not produce a mainnet write", () => {
    /*
     * §P27.36 literally: shadow intent, fork calldata, a local capability and an Anvil key. All four
     * are supplied here. The submission path still does not exist, because the thing that would use
     * them is not implemented anywhere.
     */
    const attacker = {
      shadowIntent: SUPPLY,
      forkCalldata: "0xd0e30db0",
      localCapability: { executionEnvironment: "LOCAL_FORK", environmentId: FORK.forkId, chainId: 31337 },
      anvilKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    };
    expect(() => submitToPublicMainnet(attacker)).toThrow(ShadowError);
    // And the fence refuses chain 1 regardless of what is presented to it.
    expect(() => assertShadowTargetAllowed({ chainId: 1, role: "LOCAL_FORK", forkedFrom: null, forkBlock: null }, "attacker")).toThrow();
  });
});

/* ═════════════════════════ SHADOW-003 … 005 : recompilation ═════════════════════════ */

describe("SHADOW-003 a mainnet semantic intent is recompiled for the testnet", () => {
  it("SHADOW-003 compiling for Sepolia resolves Sepolia's own addresses", () => {
    const intent = compileForNetwork(SUPPLY, shadowExecutionRef("TESTNET", {}), { protocolAddressFor });
    expect(intent.assetAddress).toBe(USDC_SEPOLIA);
    expect(intent.assetAddress).not.toBe(USDC_MAINNET);
    expect(intent.network.chainId).toBe(11155111);
    expect(intent.environmentBinding.executionEnvironment).toBe("TESTNET");
    expect(intent.compiledFrom).toMatch(/recompiled against chain 11155111 registry/);
  });

  it("SHADOW-003b an asset with no Sepolia deployment stops the compile rather than substituting", () => {
    const dai: SemanticAction = { ...SUPPLY, assetId: "dai" };
    expect(reasonOf(() => compileForNetwork(dai, shadowExecutionRef("TESTNET", {}), { protocolAddressFor })))
      .toBe("ASSET_HAS_NO_DEPLOYMENT_ON_CHAIN");
  });

  it("SHADOW-003c a protocol with no deployment on the target is refused", () => {
    const uni: SemanticAction = { ...SUPPLY, protocol: "uniswap-v3" };
    expect(reasonOf(() => compileForNetwork(uni, shadowExecutionRef("TESTNET", {}), { protocolAddressFor })))
      .toBe(SHADOW_REASONS.NOT_RECOMPILED);
  });

  it("SHADOW-003d the semantic action has nothing executable in it", () => {
    /*
     * §P27.32: `proposedMainnetSemanticAction` is not executable calldata. The schema is the
     * guarantee — every field that would make it executable is absent, and the schema strips them.
     */
    const keys = Object.keys(SemanticActionSchema.shape);
    for (const forbidden of FORBIDDEN_SEMANTIC_FIELDS) {
      expect(keys, `a semantic action must not carry "${forbidden}"`).not.toContain(forbidden);
    }
    expect(keys).toContain("assetId");
    // Assets are canonical ids, so there is no address in it to copy anywhere.
    const parsed = SemanticActionSchema.parse({ ...SUPPLY, to: WETH_MAINNET, data: "0xdeadbeef", chainId: 1 } as never);
    expect(parsed).not.toHaveProperty("to");
    expect(parsed).not.toHaveProperty("data");
    expect(parsed).not.toHaveProperty("chainId");
  });
});

describe("SHADOW-004 a chain-id-only calldata rewrite is refused", () => {
  it("SHADOW-004 retargeting an encoded intent by changing the chain id is refused", () => {
    expect(reasonOf(() => assertNoChainIdRewrite({ chainId: 1, to: USDC_MAINNET, data: "0xa9059cbb" }, 11155111, "shadow")))
      .toBe(SHADOW_REASONS.CALLDATA_REWRITE);
  });

  it("SHADOW-004b the refusal explains what the addresses would point at", () => {
    try { assertNoChainIdRewrite({ chainId: 1, to: USDC_MAINNET, data: "0x" }, 11155111, "shadow"); } catch (e) {
      expect((e as Error).message).toMatch(/encode addresses from chain 1/);
      expect((e as Error).message).toMatch(/a different contract or none at all/);
      expect((e as Error).message).toMatch(/Recompile the semantic action/);
    }
  });

  it("SHADOW-004c an intent already built for the target passes", () => {
    expect(() => assertNoChainIdRewrite({ chainId: 11155111, to: USDC_SEPOLIA }, 11155111, "shadow")).not.toThrow();
  });

  it("SHADOW-004d a mainnet address never reaches a compiled Sepolia intent", () => {
    /*
     * The mandatory mutation "copy mainnet token address to Sepolia intent". Recompilation resolves
     * from the target registry, and the address guard refuses a foreign one on top of that.
     */
    const intent = compileForNetwork(SUPPLY, shadowExecutionRef("TESTNET", {}), { protocolAddressFor });
    expect(intent.assetAddress.toLowerCase()).not.toBe(USDC_MAINNET.toLowerCase());
    expect(intent.assetAddress).toBe(USDC_SEPOLIA);
  });
});

describe("SHADOW-005 local fork execution works, and stays bound to the fork", () => {
  it("SHADOW-005 a fork intent legitimately uses mainnet addresses", () => {
    /*
     * The subtle case. A mainnet fork holds mainnet state, so the mainnet USDC address IS correct
     * there. What keeps it from being a mainnet authorization is the binding, not the address.
     */
    const intent = compileForNetwork(SUPPLY, shadowExecutionRef("LOCAL_FORK", { fork: FORK }), { fork: FORK, protocolAddressFor });
    expect(intent.assetAddress).toBe(USDC_MAINNET);
    expect(intent.environmentBinding.executionEnvironment).toBe("LOCAL_FORK");
    expect(intent.environmentBinding.environmentId).toBe(FORK.forkId);
    expect(intent.environmentBinding.chainId).toBe(31337);
    expect(intent.environmentBinding.forkedFrom).toBe(1);
    expect(intent.environmentBinding.forkBlock).toBe(REAL_ANCHOR.number.toString());
  });

  it("SHADOW-005b the decision records where it actually ran", async () => {
    const snapshot = freshSnapshot();
    const d = await runShadowDecision({
      decisionId: "d1", snapshot, strategyRevision: 1, blueprintRevision: 1,
      maxContextAgeMs: 600_000, nowMs: snapshot.observedAtMs,
      target: "LOCAL_FORK", fork: FORK, evaluate: evaluateAllow, protocolAddressFor,
      executeOnTarget: async () => ({ txHash: `0x${"ab".repeat(32)}`, label: "LOCAL FORK TRANSACTION" }),
    });
    expect(d.executionEnvironment).toBe("LOCAL_FORK");
    expect(d.environmentId).toBe(FORK.forkId);
    expect(d.executionChainId).toBe(31337);
    expect(d.simulatedExecutionResult.executed).toBe(true);
    expect(d.simulatedExecutionResult.label).toBe("LOCAL FORK TRANSACTION");
  });

  it("SHADOW-005c a non-ALLOW verdict executes nothing, anywhere", async () => {
    const snapshot = freshSnapshot();
    let executed = false;
    const d = await runShadowDecision({
      decisionId: "d1", snapshot, strategyRevision: 1, blueprintRevision: 1,
      maxContextAgeMs: 600_000, nowMs: snapshot.observedAtMs,
      target: "LOCAL_FORK", fork: FORK,
      evaluate: () => ({ verdict: "DENY", reasonCode: "DENY_AMOUNT_TOO_HIGH", action: SUPPLY }),
      protocolAddressFor,
      executeOnTarget: async () => { executed = true; return { txHash: "0x", label: "x" }; },
    });
    expect(d.verdict).toBe("DENY");
    expect(d.executionEnvironment).toBe("NONE");
    expect(executed).toBe(false);
    // The proposed action is still recorded, so the audit shows what it wanted to do.
    expect(d.proposedMainnetSemanticAction.kind).toBe("SUPPLY");
  });
});

/* ═════════════════════════ SHADOW-006 … 008 ═════════════════════════ */

describe("SHADOW-006 a stale snapshot blocks a new action", () => {
  it("SHADOW-006 a stale snapshot produces NO_VALID_CONTEXT and executes nothing", async () => {
    const snapshot = freshSnapshot();
    let executed = false;
    const d = await runShadowDecision({
      decisionId: "d1", snapshot, strategyRevision: 1, blueprintRevision: 1,
      maxContextAgeMs: 60_000,
      nowMs: snapshot.observedAtMs + 600_000,
      target: "LOCAL_FORK", fork: FORK, evaluate: evaluateAllow, protocolAddressFor,
      executeOnTarget: async () => { executed = true; return { txHash: "0x", label: "x" }; },
    });
    expect(d.verdict).toBe("NO_VALID_CONTEXT");
    expect(executed).toBe(false);
    expect(d.executionEnvironment).toBe("NONE");
  });

  it("SHADOW-006b freshness is checked BEFORE the policy runs", async () => {
    // A verdict computed against a world that has moved is not a verdict worth having.
    const snapshot = freshSnapshot();
    let evaluated = false;
    await runShadowDecision({
      decisionId: "d1", snapshot, strategyRevision: 1, blueprintRevision: 1,
      maxContextAgeMs: 60_000, nowMs: snapshot.observedAtMs + 600_000,
      target: "LOCAL_FORK", fork: FORK,
      evaluate: () => { evaluated = true; return evaluateAllow(); },
      protocolAddressFor,
    });
    expect(evaluated).toBe(false);
  });

  it("SHADOW-006c a fresh snapshot proceeds, so the check is not simply always-refuse", async () => {
    const snapshot = freshSnapshot();
    const d = await runShadowDecision({
      decisionId: "d1", snapshot, strategyRevision: 1, blueprintRevision: 1,
      maxContextAgeMs: 600_000, nowMs: snapshot.observedAtMs,
      target: "LOCAL_FORK", fork: FORK, evaluate: evaluateAllow, protocolAddressFor,
    });
    expect(d.verdict).toBe("ALLOW");
  });
});

describe("SHADOW-007 a source failure respects the fallback policy", () => {
  it("SHADOW-007 a lower-trust substitute is refused when the policy required an oracle", () => {
    expect(reasonOf(() => assertFallbackAuthorized("VERIFIED_ORACLE", "INDEXED_CHAIN_DATA", false, "price")))
      .toBe(SOURCE_REASONS.TRUST_NOT_MET);
  });

  it("SHADOW-007b an explicitly authorized fallback is permitted", () => {
    expect(() => assertFallbackAuthorized("VERIFIED_ORACLE", "INDEXED_CHAIN_DATA", true, "price")).not.toThrow();
  });

  it("SHADOW-007c the refusal explains that trust classes are not degraded versions of each other", () => {
    try { assertFallbackAuthorized("VERIFIED_ORACLE", "EXTERNAL_API", false, "price"); } catch (e) {
      expect((e as Error).message).toMatch(/answers a different question/);
      expect((e as Error).message).toMatch(/fail closed/);
    }
  });
});

describe("SHADOW-008 source disagreement is preserved", () => {
  it("SHADOW-008 both readings survive and neither is averaged away", () => {
    const d = compareReadings("weth/usd:price", [
      { sourceId: "chainlink", value: "243442066354", decimals: 8, trustClass: "VERIFIED_ORACLE" },
      { sourceId: "thegraph", value: "230000000000", decimals: 8, trustClass: "INDEXED_CHAIN_DATA" },
    ], 50);
    expect(d.disagrees).toBe(true);
    expect(d.readings.map((r) => r.sourceId).sort()).toEqual(["chainlink", "thegraph"]);
    expect(d.authoritative.trustClass).toBe("VERIFIED_ORACLE");
  });

  it("SHADOW-008b the mandatory mutation \"average disagreeing providers\" has nothing to mutate", () => {
    /*
     * There is no mean in the result. An average of a verified oracle reading and an indexer's
     * reading is a number no source stands behind, with the trust class of neither.
     */
    const d = compareReadings("x", [
      { sourceId: "a", value: "1000", decimals: 0, trustClass: "VERIFIED_ORACLE" },
      { sourceId: "b", value: "2000", decimals: 0, trustClass: "INDEXED_CHAIN_DATA" },
    ], 100_000);
    const emitted = [d.authoritative.value, ...d.readings.map((r) => r.value)];
    expect(emitted).not.toContain("1500");
    expect(d.authoritative.value).toBe("1000");
  });

  it("SHADOW-008c agreement within tolerance is not reported as a disagreement", () => {
    const d = compareReadings("x", [
      { sourceId: "a", value: "1000", decimals: 0, trustClass: "VERIFIED_ORACLE" },
      { sourceId: "b", value: "1001", decimals: 0, trustClass: "INDEXED_CHAIN_DATA" },
    ], 100);
    expect(d.spreadBps).toBe(10);
    expect(d.disagrees).toBe(false);
  });
});

/* ═════════════════════════ SHADOW-009 … 010 : overlays ═════════════════════════ */

describe("SHADOW-009 an overlay leaves the base snapshot untouched", () => {
  it("SHADOW-009 the base hash is identical before and after", () => {
    // A snapshot carrying every metric FLASH_CRASH touches, so the overlay actually applies here.
    const base = sealSnapshot(richSnapshotInput());
    const before = base.snapshotHash;
    const result = applyOverlay(base, FLASH_CRASH, { snapshotId: "snap-scenario-1" });
    assertBaseUnchanged(base, before);
    expect(base.snapshotHash).toBe(before);
    expect(result.snapshot.snapshotHash).not.toBe(before);
    expect(result.baseSnapshotHash).toBe(before);
  });

  it("SHADOW-009b the mandatory mutation \"let an overlay mutate the base\" is refused by the freeze", () => {
    const base = freshSnapshot();
    // The snapshot is deeply frozen, so an in-place edit throws rather than silently succeeding.
    expect(() => { (base.observations[0] as { value: string }).value = "1"; }).toThrow(TypeError);
    expect(() => { (base as { snapshotHash: string }).snapshotHash = "x"; }).toThrow(TypeError);
  });

  it("SHADOW-009c the scenario hash binds the base AND the overlay", () => {
    const base = freshSnapshot();
    const other = sealSnapshot(snapshotInput({ snapshotId: "snap-other", anchorBlock: "25948177" }));
    const h1 = computeScenarioHash(base.snapshotHash, FLASH_CRASH);
    const h2 = computeScenarioHash(other.snapshotHash, FLASH_CRASH);
    const h3 = computeScenarioHash(base.snapshotHash, STALE_ORACLE);
    // Same overlay, different base → different scenario. Same base, different overlay → likewise.
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
    expect(computeScenarioHash(base.snapshotHash, FLASH_CRASH)).toBe(h1);
  });

  it("SHADOW-009d the overlay applies the change it claims to", () => {
    const base = freshSnapshot();
    const result = applyOverlay(base, {
      schemaVersion: OVERLAY_SCHEMA_VERSION, overlayId: "drop-20", name: "drop", description: "a 20% fall",
      mutations: [{ metric: "weth/usd:price", op: "PERCENT", operand: -20, note: "price falls 20%" }],
    }, { snapshotId: "snap-s" });
    const before = BigInt(base.observations.find((o) => o.metric === "weth/usd:price")!.value);
    const after = BigInt(result.snapshot.observations.find((o) => o.metric === "weth/usd:price")!.value);
    expect(after).toBe((before * 80n) / 100n);
    expect(result.mutatedMetrics).toEqual(["weth/usd:price"]);
  });

  it("SHADOW-009e an overlay naming a metric the snapshot does not have is refused", () => {
    // The plain fixture has no volatility observation, which is what FLASH_CRASH reaches for.
    const base = freshSnapshot();
    expect(reasonOf(() => applyOverlay(base, FLASH_CRASH, { snapshotId: "s" }))).toBe(OVERLAY_REASONS.UNKNOWN_METRIC);
  });

  it("SHADOW-009f an impossible result is refused, not clamped", () => {
    /*
     * §P27.38. Checked on the RESULT rather than the operand: -20% is a reasonable instruction that
     * produces a negative price when applied to a small enough number.
     */
    const base = sealSnapshot(snapshotInput({ observations: [priceObservation({ value: "100" }), rateObservation()] }));
    expect(reasonOf(() => applyOverlay(base, {
      schemaVersion: OVERLAY_SCHEMA_VERSION, overlayId: "neg", name: "negative", description: "a negative price",
      mutations: [{ metric: "weth/usd:price", op: "SET", operand: -5, note: "negative" }],
    }, { snapshotId: "s" }))).toBe(OVERLAY_REASONS.IMPOSSIBLE_VALUE);
  });

  it("SHADOW-009g an operation meaningless for the data type is refused", () => {
    const base = freshSnapshot();
    expect(reasonOf(() => applyOverlay(base, {
      schemaVersion: OVERLAY_SCHEMA_VERSION, overlayId: "bps-on-price", name: "bps", description: "bps on a price",
      mutations: [{ metric: "weth/usd:price", op: "ADD_BPS", operand: 100, note: "bps added to a price" }],
    }, { snapshotId: "s" }))).toBe(OVERLAY_REASONS.WRONG_OP);
  });

  it("SHADOW-009h an overlay with no mutations does not validate", () => {
    expect(ScenarioOverlaySchema.safeParse({
      schemaVersion: OVERLAY_SCHEMA_VERSION, overlayId: "x", name: "x", description: "x", mutations: [],
    }).success).toBe(false);
  });
});

describe("SHADOW-010 trust does not improve through an overlay", () => {
  /*
   * Built per-test rather than in the describe body.
   *
   * A fixture constructed at collection time turns any failure inside it into a file-level crash
   * with no test name attached — which is exactly what happened when the "overlay mutates the base"
   * mutation was first run: the guard fired correctly and the result was reported as "no tests"
   * rather than as a named failure. Evidence that cannot say which assertion caught something is
   * weaker evidence.
   */
  const dropOverlay = {
    schemaVersion: OVERLAY_SCHEMA_VERSION, overlayId: "drop", name: "drop", description: "a fall",
    mutations: [{ metric: "weth/usd:price", op: "PERCENT" as const, operand: -20, note: "price falls" }],
  };
  const drop = () => applyOverlay(freshSnapshot(), dropOverlay, { snapshotId: "snap-s" });

  it("SHADOW-010 a synthetic value does not keep the trust class of its source", () => {
    const synthetic = drop().snapshot.observations.find((o) => o.metric === "weth/usd:price");
    // Not VERIFIED_ORACLE — no oracle attested to this number. It was chosen by whoever wrote the
    // overlay, which is the same provenance as a value supplied by an agent.
    expect(synthetic?.trustClass).toBe(SYNTHETIC_TRUST_CLASS);
    expect(synthetic?.trustClass).not.toBe("VERIFIED_ORACLE");
  });

  it("SHADOW-010b the provenance records what it was derived FROM", () => {
    const synthetic = drop().snapshot.observations.find((o) => o.metric === "weth/usd:price");
    expect(synthetic?.derivedFrom).toMatch(new RegExp(`${SIMULATED_TRUST_PREFIX}VERIFIED_ORACLE`));
    expect(synthetic?.provenance).toMatch(/SIMULATED_FROM_VERIFIED_ORACLE/);
    expect(simulatedTrustLabel("VERIFIED_ORACLE")).toBe("SIMULATED_FROM_VERIFIED_ORACLE");
  });

  it("SHADOW-010c an untouched observation keeps its real trust class", () => {
    // Only the mutated metric is downgraded; the rest of the picture is still measured.
    const untouched = drop().snapshot.observations.find((o) => o.metric === "aave-v3:weth:liquidityRate");
    expect(untouched?.trustClass).toBe("DIRECT_CHAIN_DATA");
    expect(untouched?.derivedFrom).toBeNull();
  });

  it("SHADOW-010d an overlay on indexed data does not become a verified oracle reading", () => {
    const indexedBase = sealSnapshot(snapshotInput({
      observations: [priceObservation({ trustClass: "INDEXED_CHAIN_DATA" }), rateObservation()],
      sources: [feedSource({ trustClass: "INDEXED_CHAIN_DATA" }), rpcSource()],
    }));
    const out = applyOverlay(indexedBase, {
      schemaVersion: OVERLAY_SCHEMA_VERSION, overlayId: "d", name: "d", description: "d",
      mutations: [{ metric: "weth/usd:price", op: "PERCENT", operand: -10, note: "fall" }],
    }, { snapshotId: "s2" });
    const o = out.snapshot.observations.find((x) => x.metric === "weth/usd:price");
    expect(o?.trustClass).toBe(SYNTHETIC_TRUST_CLASS);
    expect(o?.provenance).toMatch(/SIMULATED_FROM_INDEXED_CHAIN_DATA/);
  });

  it("SHADOW-010e a strategy requiring a verified oracle refuses to act on a scenario value", () => {
    // The consequence of the downgrade, at a real seam: a shock test cannot grant new authority.
    const synthetic = drop().snapshot.observations.find((o) => o.metric === "weth/usd:price")!;
    expect(reasonOf(() => assertFallbackAuthorized("VERIFIED_ORACLE", synthetic.trustClass, false, "scenario")))
      .toBe(SOURCE_REASONS.TRUST_NOT_MET);
  });

  it("SHADOW-010f the overlay itself is recorded as a source", () => {
    const dropped = drop();
    const overlaySource = dropped.snapshot.sources.find((s) => s.sourceId.startsWith("overlay:"));
    expect(overlaySource?.trustClass).toBe(SYNTHETIC_TRUST_CLASS);
    expect(overlaySource?.timeSupport).toBe("NON_HISTORICAL_SOURCE");
    expect(dropped.snapshot.provenance.join(" ")).toMatch(/scenario overlay/);
  });
});
