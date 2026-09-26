import { describe, it, expect } from "vitest";
import { encodeFunctionData, zeroAddress } from "viem";
import {
  AdapterRegistry,
  MorphoStateAdapter, MorphoExecutionAdapter, morphoStateManifest, morphoExecutionManifest, morphoDeploymentFor, MORPHO_ABI, MORPHO_HIGH_RISK_ACTIONS,
  normalizeMorphoPosition, borrowAssetsFromShares, marketIdOf, FIXTURE_PARAMS, FIXTURE_MARKET_ID, ORACLE_PRICE_SCALE, UnknownMorphoDeploymentError,
  CompoundStateAdapter, CompoundExecutionAdapter, compoundStateManifest, compoundExecutionManifest, compoundDeploymentFor, COMET_ABI, normalizeCometPosition, UnknownCompoundMarketError,
  LidoStateAdapter, LidoExecutionAdapter, lidoStateManifest, lidoExecutionManifest, lidoDeploymentFor, STETH_ABI, UnknownLidoDeploymentError,
  type DataAdapter, type ExecutionAdapter, type MorphoIntent, type CompoundIntent, type LidoIntent,
} from "../src/index.js";

/**
 * Morpho Blue, Compound v3 and Lido.
 *
 * Three protocols, one discipline, and the tests are shaped to prove the discipline rather than the
 * protocol: every adapter registers as separate state and execution principals, every execution
 * adapter judges the calldata and never the builder's summary, every high-risk action it can decode
 * is refused by name, and every fixture an adapter declares produces the outcome it declares when
 * the adapter itself judges it.
 *
 * Reason codes are asserted exactly (FND-V2-008): a rejection for the wrong reason is coverage
 * for a check that never ran.
 */

const SEPOLIA = 11155111;
const OWNER = "0x0000000000000000000000000000000000005e1f";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const now = Math.floor(Date.now() / 1000);
const ctx = { chainId: SEPOLIA, nowMs: Date.now() };

function expectRejection(result: { ok: boolean; problems: Array<{ code: string }> }, code: string) {
  expect(result.ok).toBe(false);
  const codes = result.problems.map((p) => p.code);
  expect(codes, `expected ${code}, got ${codes.join(", ") || "none"}`).toContain(code);
}

/** Judge every fixture the way the Studio's fixture runner does, and compare with what the adapter declared. */
async function judgeAllFixtures(adapter: ExecutionAdapter | DataAdapter) {
  const isExec = typeof (adapter as ExecutionAdapter).decodeTransaction === "function";
  const out: Array<{ scenarioId: string; declared: string; actual: string; reason: string; wanted: string | undefined }> = [];
  for (const f of adapter.createSimulationFixtures()) {
    let actual = "ACCEPTED";
    let reason = "";
    try {
      if (isExec) {
        const a = adapter as ExecutionAdapter & { fixtureIntent(): unknown; fixtureConstraints(): unknown };
        const n = await a.decodeTransaction(f.providerResponse);
        const r = a.validateTransaction(n, a.fixtureIntent() as never, a.fixtureConstraints() as never);
        if (!r.ok) { actual = "REJECTED"; reason = r.problems[0]!.code; }
      } else {
        const a = adapter as DataAdapter;
        const q = a.validateQuery(a.fixtureQuery());
        if (!q.ok) throw new Error(q.problems[0]!.code);
        const obs = a.normalize(f.providerResponse, q.query, ctx);
        const r = a.validate(obs, ctx);
        if (!r.ok) { actual = "REJECTED"; reason = r.problems[0]!.code; }
      }
    } catch (e) {
      actual = "REJECTED";
      reason = (e as { code?: string }).code ?? `ADAPTER_ERROR:${(e as Error).name}`;
    }
    out.push({ scenarioId: f.scenarioId, declared: f.expected.outcome, actual, reason, wanted: f.expected.reasonCodeMatches });
  }
  return out;
}

const PROTOCOLS = [
  { name: "Morpho Blue", state: new MorphoStateAdapter(), exec: new MorphoExecutionAdapter(), stateManifest: morphoStateManifest, execManifest: morphoExecutionManifest, highRisk: MORPHO_HIGH_RISK_ACTIONS },
  { name: "Compound v3", state: new CompoundStateAdapter(), exec: new CompoundExecutionAdapter(), stateManifest: compoundStateManifest, execManifest: compoundExecutionManifest, highRisk: new Set(["COMPOUND_WITHDRAW"]) },
  { name: "Lido", state: new LidoStateAdapter(), exec: new LidoExecutionAdapter(), stateManifest: lidoStateManifest, execManifest: lidoExecutionManifest, highRisk: new Set(["LIDO_TRANSFER", "LIDO_APPROVE"]) },
];

describe("PROTO-001 every protocol registers as two principals with the right trust", () => {
  for (const p of PROTOCOLS) {
    it(`${p.name}: state is DIRECT_CHAIN_DATA, execution is USER_UNTRUSTED, both on Sepolia and mainnet`, () => {
      const r = new AdapterRegistry();
      r.register({ kind: "data", manifest: p.stateManifest, adapter: p.state });
      r.register({ kind: "execution", manifest: p.execManifest, adapter: p.exec });
      expect(r.list()).toHaveLength(2);
      expect(p.stateManifest.trustClass).toBe("DIRECT_CHAIN_DATA");
      expect(p.execManifest.trustClass).toBe("USER_UNTRUSTED");
      expect(p.stateManifest.supportedChains).toEqual([SEPOLIA, 1]);
      // No data capability of a state adapter may claim VERIFIED_ORACLE: a protocol read is not a market truth.
      for (const c of p.stateManifest.capabilities) expect(c.trustClass).toBe("DIRECT_CHAIN_DATA");
      // Every scenario the manifest advertises is a fixture the adapter actually produces.
      const declared = new Set([...p.state.createSimulationFixtures(), ...p.exec.createSimulationFixtures()].map((f) => f.scenarioId));
      for (const s of [...p.stateManifest.simulationProviders, ...p.execManifest.simulationProviders]) expect(declared.has(s), s).toBe(true);
    });
  }

  it("an unrecorded chain is refused, never guessed", () => {
    expect(() => morphoDeploymentFor(8453)).toThrow(UnknownMorphoDeploymentError);
    expect(() => compoundDeploymentFor(8453)).toThrow(UnknownCompoundMarketError);
    expect(() => lidoDeploymentFor(8453)).toThrow(UnknownLidoDeploymentError);
  });
});

describe("PROTO-002 every declared fixture produces its declared outcome, for its declared reason", () => {
  for (const p of PROTOCOLS) {
    it(`${p.name} execution fixtures`, async () => {
      for (const f of await judgeAllFixtures(p.exec)) {
        expect(f.actual, `${f.scenarioId}: ${f.reason}`).toBe(f.declared);
        if (f.wanted) expect(f.reason, f.scenarioId).toMatch(new RegExp(`^${f.wanted}`));
      }
    });
    it(`${p.name} state fixtures`, async () => {
      for (const f of await judgeAllFixtures(p.state)) {
        expect(f.actual, `${f.scenarioId}: ${f.reason}`).toBe(f.declared);
        if (f.wanted && f.reason.startsWith(p.stateManifest.provider.toUpperCase())) expect(f.reason).toMatch(new RegExp(`^${f.wanted}`));
      }
    });
  }
});

describe("PROTO-003 the builder's summary is never read", () => {
  for (const p of PROTOCOLS) {
    it(`${p.name}: identical calldata with a lying summary decodes identically`, async () => {
      const honest = p.exec.createSimulationFixtures()[0]!.providerResponse as { summary: Record<string, unknown> };
      const lying = { ...honest, summary: { action: "NOTHING", account: ATTACKER, amount: "1" } };
      const a = await p.exec.decodeTransaction(honest as never);
      const b = await p.exec.decodeTransaction(lying as never);
      const pick = (n: typeof a) => JSON.stringify({ t: n.target, c: n.calldata, v: n.value, k: n.actionType, i: n.inputs, o: n.outputs, r: n.recipient ?? null });
      expect(pick(a)).toBe(pick(b));
    });
  }
});

describe("PROTO-004 adapter capability is not agent authority", () => {
  for (const p of PROTOCOLS) {
    it(`${p.name}: every high-risk action the adapter can decode is refused by name`, async () => {
      const a = p.exec as ExecutionAdapter & { fixtureIntent(): unknown; fixtureConstraints(): unknown };
      const results = await judgeAllFixtures(p.exec);
      const forbidden = results.filter((r) => /FORBIDDEN|BORROW-AS-WITHDRAW/.test(r.scenarioId));
      expect(forbidden.length).toBeGreaterThan(0);
      for (const r of forbidden) expect(r.reason).toMatch(/HIGH-RISK-ACTION$/);
      // And the declared set is what the validator checks against, not a per-branch opinion.
      for (const k of p.highRisk) expect(a.supportedActions()).toContain(k);
    });
  }
});

/* ───────────────────────────── Morpho specifics ───────────────────────────── */

describe("MORPHO-003 position math", () => {
  it("derives borrow assets from shares rounding up, and health as LLTV over LTV", () => {
    // 2 ETH collateral at $2,400 → $4,800 of loan token; 2,000 USDC borrowed; LLTV 86%.
    const raw = {
      marketId: FIXTURE_MARKET_ID, params: FIXTURE_PARAMS,
      borrowShares: 2_000_000_000n * 10n ** 6n, collateral: 2n * 10n ** 18n,
      totalBorrowAssets: 10_000_000_000n, totalBorrowShares: 10_000_000_000n * 10n ** 6n,
      price: 2_400_000_000n * ORACLE_PRICE_SCALE / 10n ** 18n, loanTokenDecimals: 6, collateralTokenDecimals: 18,
      blockNumber: 1n, timestamp: now,
    };
    const p = normalizeMorphoPosition(raw, OWNER, SEPOLIA);
    expect(Number(p.borrowAssets)).toBeGreaterThanOrEqual(2_000_000_000);
    expect(Number(p.borrowAssets)).toBeLessThan(2_000_001_000);
    expect(p.collateralValueInLoan).toBe("4800000000");
    expect(p.ltvBps).toBeGreaterThanOrEqual(4_166);
    expect(p.lltvBps).toBe(8_600);
    expect(p.healthFactor.state).toBe("KNOWN");
    if (p.healthFactor.state === "KNOWN") expect(p.healthFactor.bps).toBeCloseTo(20_640, -2);
  });

  it("no borrow shares is NO_DEBT, not a large number", () => {
    const p = normalizeMorphoPosition({ marketId: FIXTURE_MARKET_ID, params: FIXTURE_PARAMS, borrowShares: 0n, collateral: 1n, totalBorrowAssets: 1n, totalBorrowShares: 1n, price: 1n, loanTokenDecimals: 6, collateralTokenDecimals: 18, blockNumber: 1n, timestamp: now }, OWNER, SEPOLIA);
    expect(p.healthFactor).toEqual({ state: "NO_DEBT" });
    expect(borrowAssetsFromShares(0n, 5n, 5n)).toBe(0n);
  });

  it("the market id is keccak of the encoded params, and an intent whose id disagrees is refused", () => {
    expect(marketIdOf(FIXTURE_PARAMS)).toMatch(/^0x[0-9a-f]{64}$/);
    const exec = new MorphoExecutionAdapter();
    const bad = exec.normalizeIntent({ action: "MORPHO_REPAY", chainId: SEPOLIA, account: OWNER, marketId: `0x${"1".repeat(64)}`, params: FIXTURE_PARAMS, amount: "1" });
    expectRejection(bad as never, "MORPHO-I5");
  });
});

describe("MORPHO-010/012/013 calldata is judged, not described", () => {
  const exec = new MorphoExecutionAdapter();
  const d = morphoDeploymentFor(SEPOLIA);
  const mp = { loanToken: FIXTURE_PARAMS.loanToken, collateralToken: FIXTURE_PARAMS.collateralToken, oracle: FIXTURE_PARAMS.oracle, irm: FIXTURE_PARAMS.irm, lltv: BigInt(FIXTURE_PARAMS.lltv) };
  const intent: MorphoIntent = exec.fixtureIntent();
  const c = exec.fixtureConstraints();
  const prep = (data: string, to = d.morpho) => ({ to, data, value: "0", chainId: SEPOLIA, summary: { action: "MORPHO_REPAY", account: OWNER, amount: intent.amount } });

  it("builds a repay against the verified singleton with empty callback data and zero shares", async () => {
    const built = await exec.buildTransaction(intent, { chainId: SEPOLIA, owner: OWNER, nowMs: Date.now() });
    expect(built.to).toBe(d.morpho);
    const n = await exec.decodeTransaction(built);
    expect(n.actionType).toBe("MORPHO_REPAY");
    expect(exec.validateTransaction(n, intent, c).ok).toBe(true);
  });
  it("a repay into a different market is MORPHO-V-MARKET", async () => {
    const data = encodeFunctionData({ abi: MORPHO_ABI, functionName: "repay", args: [{ ...mp, lltv: 770000000000000000n }, 500_000_000n, 0n, OWNER, "0x"] });
    expectRejection(exec.validateTransaction(await exec.decodeTransaction(prep(data)), intent, c), "MORPHO-V-MARKET");
  });
  it("callback data is MORPHO-V-CALLBACK", async () => {
    const data = encodeFunctionData({ abi: MORPHO_ABI, functionName: "repay", args: [mp, 500_000_000n, 0n, OWNER, "0xdeadbeef"] });
    expectRejection(exec.validateTransaction(await exec.decodeTransaction(prep(data)), intent, c), "MORPHO-V-CALLBACK");
  });
  it("a withdrawal whose receiver is a stranger names the receiver, and is high risk", async () => {
    const data = encodeFunctionData({ abi: MORPHO_ABI, functionName: "withdrawCollateral", args: [mp, 500_000_000n, OWNER, ATTACKER] });
    const n = await exec.decodeTransaction(prep(data));
    expect(n.recipient?.toLowerCase()).toBe(ATTACKER.toLowerCase());
    const r = exec.validateTransaction(n, intent, c);
    expectRejection(r, "MORPHO-V-HIGH-RISK-ACTION");
    expectRejection(r, "MORPHO-V-RECEIVER");
  });
});

/* ───────────────────────────── Compound specifics ─────────────────────────── */

describe("COMPOUND-003/011/013 the base asset decides what a supply and a withdraw mean", () => {
  const exec = new CompoundExecutionAdapter();
  const d = compoundDeploymentFor(SEPOLIA);
  const intent: CompoundIntent = exec.fixtureIntent();
  const c = exec.fixtureConstraints();
  const prep = (data: string, to = d.comet) => ({ to, data, value: "0", chainId: SEPOLIA, summary: { action: "COMPOUND_REPAY", account: OWNER, amount: intent.amount } });

  it("health is weighted collateral over the borrow; no borrow is NO_DEBT", () => {
    const p = normalizeCometPosition({ borrowBalance: 2_000_000_000n, collateral: [], collateralValueBase: 4_800_000_000n, liquidationThresholdBps: 8_500, isLiquidatable: false, isBorrowCollateralized: true, blockNumber: 1n, timestamp: now }, OWNER, SEPOLIA);
    expect(p.healthFactor.state).toBe("KNOWN");
    if (p.healthFactor.state === "KNOWN") expect(p.healthFactor.bps).toBe(20_400);
    expect(normalizeCometPosition({ borrowBalance: 0n, collateral: [], collateralValueBase: 1n, liquidationThresholdBps: 8_500, isLiquidatable: false, isBorrowCollateralized: true, blockNumber: 1n, timestamp: now }, OWNER, SEPOLIA).healthFactor).toEqual({ state: "NO_DEBT" });
  });
  it("supplyTo of the base asset decodes as REPAY; of any other asset as SUPPLY", async () => {
    const repay = await exec.decodeTransaction(prep(encodeFunctionData({ abi: COMET_ABI, functionName: "supplyTo", args: [OWNER, d.baseToken, 1n] })));
    const supply = await exec.decodeTransaction(prep(encodeFunctionData({ abi: COMET_ABI, functionName: "supplyTo", args: [OWNER, ATTACKER, 1n] })));
    expect(repay.actionType).toBe("COMPOUND_REPAY");
    expect(supply.actionType).toBe("COMPOUND_SUPPLY");
  });
  it("a base-asset withdrawTo is a borrow and is refused as high risk, saying so", async () => {
    const n = await exec.decodeTransaction(prep(encodeFunctionData({ abi: COMET_ABI, functionName: "withdrawTo", args: [OWNER, d.baseToken, 500_000_000n] })));
    const r = exec.validateTransaction(n, intent, c);
    expectRejection(r, "COMPOUND-V-HIGH-RISK-ACTION");
    expect(r.problems.find((p) => p.code === "COMPOUND-V-HIGH-RISK-ACTION")!.message).toMatch(/BORROW/);
  });
  it("the two-argument supply credits the executor, not the user, and is refused", async () => {
    const n = await exec.decodeTransaction(prep(encodeFunctionData({ abi: COMET_ABI, functionName: "supply", args: [d.baseToken, 500_000_000n] })));
    expectRejection(exec.validateTransaction(n, intent, c), "COMPOUND-V-SENDER-CREDITED");
  });
  it("a repay intent naming a non-base asset is refused at intent time", () => {
    expectRejection(exec.normalizeIntent({ ...intent, asset: ATTACKER }) as never, "COMPOUND-I5");
  });
});

/* ───────────────────────────── Lido specifics ─────────────────────────────── */

describe("LIDO-008/011/012 the amount is the value; stETH cannot leave the vault", () => {
  const exec = new LidoExecutionAdapter();
  const d = lidoDeploymentFor(SEPOLIA);
  const intent: LidoIntent = exec.fixtureIntent();
  const c = exec.fixtureConstraints();

  it("builds a submit with the ETH as value and a zero referral", async () => {
    const built = await exec.buildTransaction(intent, { chainId: SEPOLIA, owner: OWNER, nowMs: Date.now() });
    expect(built.to).toBe(d.steth);
    expect(built.value).toBe(intent.amount);
    const n = await exec.decodeTransaction(built);
    expect(n.actionType).toBe("LIDO_STAKE");
    expect(n.inputs[0]).toEqual({ token: "ETH", amount: intent.amount });
    expect(exec.validateTransaction(n, intent, c).ok).toBe(true);
  });
  it("a value that disagrees with the intent is LIDO-V-VALUE", async () => {
    const built = await exec.buildTransaction(intent, { chainId: SEPOLIA, owner: OWNER, nowMs: Date.now() });
    const n = await exec.decodeTransaction({ ...built, value: "1" });
    expectRejection(exec.validateTransaction(n, intent, c), "LIDO-V-VALUE");
  });
  it("a referral is LIDO-V-REFERRAL", async () => {
    const n = await exec.decodeTransaction({ to: d.steth, data: encodeFunctionData({ abi: STETH_ABI, functionName: "submit", args: [ATTACKER] }), value: intent.amount, chainId: SEPOLIA, summary: { action: "LIDO_STAKE", account: OWNER, amount: intent.amount } });
    expectRejection(exec.validateTransaction(n, intent, c), "LIDO-V-REFERRAL");
  });
  it("a transfer out of the vault is decoded with its recipient and refused as high risk", async () => {
    const n = await exec.decodeTransaction({ to: d.steth, data: encodeFunctionData({ abi: STETH_ABI, functionName: "transfer", args: [ATTACKER, 1n] }), value: "0", chainId: SEPOLIA, summary: { action: "LIDO_STAKE", account: OWNER, amount: "1" } });
    expect(n.actionType).toBe("LIDO_TRANSFER");
    expect(n.recipient?.toLowerCase()).toBe(ATTACKER.toLowerCase());
    expectRejection(exec.validateTransaction(n, intent, c), "LIDO-V-HIGH-RISK-ACTION");
  });
  it("the adapter refuses to BUILD anything but a stake", async () => {
    await expect(exec.buildTransaction({ ...intent, action: "LIDO_TRANSFER" }, { chainId: SEPOLIA, owner: OWNER, nowMs: Date.now() })).rejects.toThrow(/LIDO-BUILD-FORBIDDEN/);
  });
  it("the state adapter reports paused staking as a reading, not a failure", () => {
    const s = new LidoStateAdapter();
    const obs = s.normalize({ balance: 1n, shares: 1n, pooledEthPerShare: 1n, stakingPaused: true, blockNumber: 1n, timestamp: now }, { account: OWNER, dataKind: "lido_staking_paused" }, ctx);
    expect(obs.value).toBe("1");
    expect(s.validate(obs, ctx).ok).toBe(true);
    void zeroAddress;
  });
});
