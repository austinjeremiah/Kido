import { describe, it, expect } from "vitest";
import { encodeFunctionData } from "viem";
import {
  AdapterRegistry,
  AaveStateAdapter,
  AaveExecutionAdapter,
  AaveError,
  UnknownAaveMarketError,
  aaveStateManifest,
  aaveExecutionManifest,
  aaveDeploymentFor,
  AAVE_POOL_ABI,
  AAVE_DEPLOYMENTS,
  HIGH_RISK_ACTIONS,
  normalizeAccountData,
  normalizeHealthFactor,
  compareHealthFactor,
  healthFactorFromDecimalString,
  repaymentToReachHealthFactor,
  baseToUsdCents,
  tokenAmountToBase,
  NO_DEBT_SENTINEL,
  WAD,
  BASE_DECIMALS,
  chainlinkDataFeedsManifest,
  ChainlinkDataFeedsAdapter,
  thegraphSubgraphManifest,
  TheGraphSubgraphAdapter,
  resolveDataRequirement,
  assertUsableObservation,
  type AaveConstraints,
  type AaveIntent,
  type AavePrepared,
  type RawAccountData,
} from "../src/index.js";

const SEPOLIA = 11155111;
const D = aaveDeploymentFor(SEPOLIA);
const OWNER = "0x0000000000000000000000000000000000005e1f";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const OTHER = "0x00000000000000000000000000000000000000bb";
const now = Math.floor(Date.now() / 1000);
const ctx = { chainId: SEPOLIA, nowMs: Date.now() };

/**
 * Every negative test asserts the EXACT reason code.
 *
 * "expected a rejection, got a rejection, PASS" is how FND-V2-008 hid a whole suite of vacuous
 * coverage: scenarios were rejected by the wrong control and reported green. `expectRejection`
 * makes the intended code part of the assertion.
 */
function expectRejection(result: { ok: boolean; problems: Array<{ code: string }> }, code: string) {
  expect(result.ok).toBe(false);
  const codes = result.problems.map((p) => p.code);
  expect(codes, `expected ${code}, got ${codes.join(", ") || "none"}`).toContain(code);
}

const raw = (over: Partial<RawAccountData> = {}): RawAccountData => ({
  totalCollateralBase: 500_000_000_000n,     // $5,000.00 at 8dp
  totalDebtBase: 200_000_000_000n,           // $2,000.00
  availableBorrowsBase: 100_000_000_000n,
  currentLiquidationThreshold: 8_250n,
  ltv: 8_000n,
  healthFactor: 2_060_000_000_000_000_000n,  // 2.06 WAD
  blockNumber: 9_000_000n,
  timestamp: now - 10,
  ...over,
});

const intent = (over: Partial<AaveIntent> = {}): AaveIntent => ({
  action: "REPAY", chainId: SEPOLIA, account: OWNER, asset: USDC, amount: "500000000", interestRateMode: 2, ...over,
});

const constraints = (over: Partial<AaveConstraints> = {}): AaveConstraints => ({
  chainId: SEPOLIA, allowedTargets: [D.pool], allowedRecipients: "self-only", owner: OWNER,
  allowUnlimitedApprovals: false, maxQuoteAgeMs: 60_000, permittedActions: ["SUPPLY", "REPAY"], ...over,
});

const enc = (fn: "supply" | "repay" | "withdraw" | "borrow", args: readonly unknown[]) =>
  encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: fn, args: args as never });

const prep = (data: string, to = D.pool): AavePrepared => ({
  to, data, value: "0", chainId: SEPOLIA,
  // Always the honest summary in every fixture below. If any check read it, every attack passes.
  summary: { action: "REPAY", account: OWNER, amount: "500000000" },
});

const exec = new AaveExecutionAdapter();
async function judge(data: string, i = intent(), c = constraints(), to = D.pool) {
  const n = await exec.decodeTransaction(prep(data, to));
  return { n, result: exec.validateTransaction(n, i, c) };
}

/* ───────────────────────────── AAVE-001 registry ──────────────────────────── */

describe("AAVE-001 the adapter registers as two separate principals", () => {
  it("state and execution register independently with different trust classes", () => {
    const r = new AdapterRegistry();
    r.register({ kind: "data", manifest: aaveStateManifest, adapter: new AaveStateAdapter() });
    r.register({ kind: "execution", manifest: aaveExecutionManifest, adapter: new AaveExecutionAdapter() });
    expect(r.list().map((m) => `${m.id}:${m.adapterType}:${m.trustClass}`)).toEqual([
      "aave-v3-execution:EXECUTION:USER_UNTRUSTED",
      "aave-v3-state:STATE_DATA:DIRECT_CHAIN_DATA",
    ]);
  });

  it("declares the protocol version and market rather than hiding them", () => {
    expect(D.protocolMajor).toBe(3);
    expect(D.market).toBe("AaveV3Sepolia");
    expect(D.verifiedOnChain).toBe(true);
    expect(D.pool).toBe("0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951");
    expect(D.baseCurrencyDecimals).toBe(8);
  });

  it("refuses to guess a Pool address for an unrecorded chain", () => {
    expect(() => aaveDeploymentFor(1)).toThrow(UnknownAaveMarketError);
    expect(AAVE_DEPLOYMENTS.every((d) => d.verifiedOnChain)).toBe(true);
  });
});

/* ─────────────────── AAVE-002/003 normalization and units ─────────────────── */

describe("AAVE-002 account data is normalized", () => {
  it("keeps USD and WAD in separate, labelled scales", () => {
    const p = normalizeAccountData(raw(), OWNER, SEPOLIA);
    expect(p.totalCollateralBase).toBe("500000000000");
    expect(p.baseCurrencyDecimals).toBe(BASE_DECIMALS);
    expect(p.baseCurrency).toBe("USD");
    expect(p.liquidationThresholdBps).toBe(8250);
    expect(p.healthFactor).toEqual({ state: "KNOWN", wad: 2_060_000_000_000_000_000n, bps: 20600 });
    // The two live in the same tuple and differ by ten orders of magnitude.
    expect(p.baseCurrencyDecimals).not.toBe(18);
  });

  it("converts USD base to cents by truncation, which under-reports a spend", () => {
    // The safe direction: truncation can only make a spend look smaller against a cap.
    expect(baseToUsdCents(200_000_000_000n)).toBe(200_000n);
    expect(baseToUsdCents(199_999_999n)).toBe(199n); // $1.99999999 → 199c, the remainder is dropped
  });

  it("converts a token amount to USD base with the token's own decimals", () => {
    // 1.5 WETH (18dp) at $2,493.56 (8dp) → 3740.34 USD at 8dp
    const usd = tokenAmountToBase(1_500_000_000_000_000_000n, 18, 249_356_368_692n);
    expect(usd).toBe(374_034_553_038n);
  });
});

describe("AAVE-003 health factor normalization is exact", () => {
  it("parses a decimal threshold without floating point", () => {
    expect(healthFactorFromDecimalString("1.6")).toBe(1_600_000_000_000_000_000n);
    expect(healthFactorFromDecimalString("1.35")).toBe(1_350_000_000_000_000_000n);
    expect(healthFactorFromDecimalString("2")).toBe(2n * WAD);
    // 0.1 + 0.2 territory: this must be exact, not 1.0999999999999999
    expect(healthFactorFromDecimalString("1.1")).toBe(1_100_000_000_000_000_000n);
    expect(() => healthFactorFromDecimalString("one point six")).toThrow(/AAVE-HF-MALFORMED/);
  });

  it("maps the zero-debt sentinel to a NAMED state, not a large number", () => {
    // Verified on Sepolia: an account with no position returns 2**256-1.
    const hf = normalizeHealthFactor(NO_DEBT_SENTINEL);
    expect(hf).toEqual({ state: "NO_DEBT" });
    // The dangerous handling, demonstrated: Number() still beats any threshold, so a naive
    // comparison appears to work and the bug survives testing.
    expect(Number(NO_DEBT_SENTINEL)).toBeGreaterThan(Number(healthFactorFromDecimalString("1.6")));
    // Ours refuses to be treated as a number at all.
    expect("wad" in hf).toBe(false);
  });

  it("NO_DEBT is not ABOVE — there is nothing to repay", () => {
    const t = healthFactorFromDecimalString("1.6");
    expect(compareHealthFactor(normalizeHealthFactor(NO_DEBT_SENTINEL), t)).toBe("NO_DEBT");
    expect(compareHealthFactor(normalizeHealthFactor(3n * WAD), t)).toBe("ABOVE");
  });
});

describe("AAVE-004/005 health factor boundaries", () => {
  const t = healthFactorFromDecimalString("1.6");

  it("exact threshold is EQUAL, not BELOW and not ABOVE", () => {
    expect(compareHealthFactor(normalizeHealthFactor(t), t)).toBe("EQUAL");
  });

  it("one wei below is BELOW", () => {
    expect(compareHealthFactor(normalizeHealthFactor(t - 1n), t)).toBe("BELOW");
  });

  it("one wei above is ABOVE", () => {
    expect(compareHealthFactor(normalizeHealthFactor(t + 1n), t)).toBe("ABOVE");
  });

  it("a very large but finite health factor is still KNOWN", () => {
    const big = NO_DEBT_SENTINEL - 1n;
    expect(normalizeHealthFactor(big).state).toBe("KNOWN");
    expect(compareHealthFactor(normalizeHealthFactor(big), t)).toBe("ABOVE");
  });

  it("zero health factor is BELOW, not NO_DEBT", () => {
    expect(compareHealthFactor(normalizeHealthFactor(0n), t)).toBe("BELOW");
  });
});

describe("repayment sizing", () => {
  it("computes the repayment that restores a target health factor", () => {
    // collateral 5000, threshold 82.5%, debt 2000 → HF 2.0625. Target 2.5 → debt 1650 → repay 350.
    const r = repaymentToReachHealthFactor({
      totalCollateralBase: 500_000_000_000n,
      totalDebtBase: 200_000_000_000n,
      liquidationThresholdBps: 8_250,
      targetHealthFactorWad: healthFactorFromDecimalString("2.5"),
    });
    expect(r).toBe(35_000_000_000n);
  });

  it("returns 0 when the position already meets the target", () => {
    expect(repaymentToReachHealthFactor({
      totalCollateralBase: 500_000_000_000n, totalDebtBase: 200_000_000_000n,
      liquidationThresholdBps: 8_250, targetHealthFactorWad: healthFactorFromDecimalString("1.2"),
    })).toBe(0n);
  });

  it("returns null for a position with no debt rather than a number", () => {
    // Returning 0 would let a caller proceed as though it had computed something.
    expect(repaymentToReachHealthFactor({
      totalCollateralBase: 500_000_000_000n, totalDebtBase: 0n,
      liquidationThresholdBps: 8_250, targetHealthFactorWad: WAD,
    })).toBeNull();
  });
});

/* ──────────────────── AAVE-006/007 build and decode ───────────────────────── */

describe("AAVE-006/007 a repay is constructed and decoded independently", () => {
  it("builds a repay against the verified Pool", async () => {
    const p = await exec.buildTransaction(intent(), { chainId: SEPOLIA, owner: OWNER, nowMs: Date.now() });
    expect(p.to).toBe(D.pool);
    expect(p.chainId).toBe(SEPOLIA);
    const n = await exec.decodeTransaction(p);
    expect(n.actionType).toBe("REPAY");
    expect(n.recipient?.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(n.inputs[0]?.amount).toBe("500000000");
    expect(exec.validateTransaction(n, intent(), constraints()).ok).toBe(true);
  });

  it("decodes from the calldata and never reads the builder's summary", async () => {
    const honest = prep(enc("repay", [USDC, 500_000_000n, 2n, ATTACKER]));
    const lying = { ...honest, summary: { action: "REPAY", account: OWNER, amount: "500000000" } };
    const a = await exec.decodeTransaction(honest);
    const b = await exec.decodeTransaction(lying);
    expect({ ...a, providerMetadata: null }).toEqual({ ...b, providerMetadata: null });
    expect(a.recipient?.toLowerCase()).toBe(ATTACKER.toLowerCase());
  });

  it("distinguishes withdraw's `to` from supply/repay's `onBehalfOf`", async () => {
    // Different argument positions, opposite meanings. Conflating them turns a supply-on-behalf
    // into a withdrawal somewhere else.
    const supply = await exec.decodeTransaction(prep(enc("supply", [USDC, 100n, OWNER, 0])));
    const withdraw = await exec.decodeTransaction(prep(enc("withdraw", [USDC, 100n, OWNER])));
    expect(supply.inputs).toHaveLength(1);
    expect(supply.outputs).toHaveLength(0);
    expect(withdraw.outputs).toHaveLength(1);
    expect(withdraw.inputs).toHaveLength(0);
    expect((withdraw.providerMetadata as { receivesFunds: boolean }).receivesFunds).toBe(true);
  });

  it("refuses a Pool function it cannot fully decode", async () => {
    const data = encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "setUserUseReserveAsCollateral", args: [USDC, true] });
    const n = await exec.decodeTransaction(prep(data));
    expect(n.actionType).toBe("SET_COLLATERAL");
    // It decodes, and is then refused by policy — not silently skipped.
    expectRejection(exec.validateTransaction(n, intent({ action: "SET_COLLATERAL" }), constraints()), "AAVE-V-HIGH-RISK-ACTION");
  });

  it("refuses calldata that is not a Pool call at all", async () => {
    await expect(exec.decodeTransaction(prep("0xdeadbeef"))).rejects.toThrow(/AAVE-NOT-POOL-CALL/);
  });
});

/* ──────────────── AAVE-008/009/010 mutation rejection, by code ────────────── */

describe("AAVE-008 amount mutation is rejected", () => {
  it("fails with AAVE-V-AMOUNT specifically", async () => {
    const { result } = await judge(enc("repay", [USDC, 9_999_999_999n, 2n, OWNER]));
    expectRejection(result, "AAVE-V-AMOUNT");
  });
});

describe("AAVE-009 wrong asset is rejected", () => {
  it("fails with AAVE-V-ASSET specifically", async () => {
    const { result } = await judge(enc("repay", [OTHER, 500_000_000n, 2n, OWNER]));
    expectRejection(result, "AAVE-V-ASSET");
  });
});

describe("AAVE-010 wrong beneficiary is rejected", () => {
  it("fails with AAVE-V-BENEFICIARY, exactly like a swap recipient substitution", async () => {
    const { n, result } = await judge(enc("repay", [USDC, 500_000_000n, 2n, ATTACKER]));
    expect(n.recipient?.toLowerCase()).toBe(ATTACKER.toLowerCase());
    expectRejection(result, "AAVE-V-BENEFICIARY");
    expectRejection(result, "AAVE-V-BENEFICIARY-SELF");
  });

  it("a withdrawal to an attacker is caught on the `to` argument", async () => {
    const { result } = await judge(
      enc("withdraw", [USDC, 500_000_000n, ATTACKER]),
      intent({ action: "WITHDRAW", account: ATTACKER }),
      constraints({ permittedActions: ["WITHDRAW"] }),
    );
    expectRejection(result, "AAVE-V-BENEFICIARY-SELF");
  });
});

/* ───────────── AAVE-011/012/017 capability is not authority ───────────────── */

describe("AAVE-011/012/017 adapter capability is not agent authority", () => {
  it("the adapter DECLARES withdraw and borrow", () => {
    expect(exec.supportedActions()).toContain("WITHDRAW");
    expect(exec.supportedActions()).toContain("BORROW");
    expect(HIGH_RISK_ACTIONS.has("WITHDRAW")).toBe(true);
    expect(HIGH_RISK_ACTIONS.has("BORROW")).toBe(true);
  });

  it("AAVE-011 withdraw is refused with AAVE-V-HIGH-RISK-ACTION when the Blueprint denies it", async () => {
    const { result } = await judge(enc("withdraw", [USDC, 500_000_000n, OWNER]), intent({ action: "WITHDRAW" }));
    expectRejection(result, "AAVE-V-HIGH-RISK-ACTION");
  });

  it("AAVE-012 borrow is refused with AAVE-V-HIGH-RISK-ACTION when the Blueprint denies it", async () => {
    const { result } = await judge(enc("borrow", [USDC, 500_000_000n, 2n, 0, OWNER]), intent({ action: "BORROW" }));
    expectRejection(result, "AAVE-V-HIGH-RISK-ACTION");
  });

  it("the default permitted set is supply and repay only", () => {
    expect(exec.fixtureConstraints().permittedActions).toEqual(["SUPPLY", "REPAY"]);
    const cfg = exec.generateTemplateConfig() as { defaultPermittedActions: string[]; highRiskActions: string[] };
    expect(cfg.defaultPermittedActions).toEqual(["SUPPLY", "REPAY"]);
    expect(cfg.highRiskActions.sort()).toEqual(["BORROW", "SET_COLLATERAL", "WITHDRAW"]);
  });

  it("an explicitly permitted withdraw to the owner IS allowed — the gate is the Blueprint, not the adapter", async () => {
    const { result } = await judge(
      enc("withdraw", [USDC, 500_000_000n, OWNER]),
      intent({ action: "WITHDRAW" }),
      constraints({ permittedActions: ["WITHDRAW"] }),
    );
    expect(result.ok).toBe(true);
  });

  it("a transaction claiming to be a repay is judged on what it DECODES to", async () => {
    // The summary says REPAY; the calldata is a withdrawal.
    const { n, result } = await judge(enc("withdraw", [USDC, 500_000_000n, OWNER]), intent({ action: "REPAY" }));
    expect(n.actionType).toBe("WITHDRAW");
    expectRejection(result, "AAVE-V-HIGH-RISK-ACTION");
    expectRejection(result, "AAVE-V-ACTION-MISMATCH");
  });
});

/* ─────────────────── AAVE-013 approvals, AAVE-019 failure ─────────────────── */

describe("AAVE-013 approval bounds", () => {
  it("rejects an unlimited approval with AAVE-V-UNLIMITED-APPROVAL", async () => {
    const n = await exec.decodeTransaction(prep(enc("repay", [USDC, 500_000_000n, 2n, OWNER])));
    n.allowanceChanges = [{ token: USDC, spender: D.pool, amount: ((1n << 256n) - 1n).toString(), unlimited: true }];
    expectRejection(exec.validateTransaction(n, intent(), constraints()), "AAVE-V-UNLIMITED-APPROVAL");
  });

  it("rejects an approval above the cap with AAVE-V-APPROVAL-SIZE", async () => {
    const n = await exec.decodeTransaction(prep(enc("repay", [USDC, 500_000_000n, 2n, OWNER])));
    n.allowanceChanges = [{ token: USDC, spender: D.pool, amount: "999999999", unlimited: false }];
    expectRejection(exec.validateTransaction(n, intent(), constraints({ maxApprovalAmount: "1000" })), "AAVE-V-APPROVAL-SIZE");
  });

  it("rejects an approval to anything other than the Pool", async () => {
    const n = await exec.decodeTransaction(prep(enc("repay", [USDC, 500_000_000n, 2n, OWNER])));
    n.allowanceChanges = [{ token: USDC, spender: ATTACKER, amount: "500000000", unlimited: false }];
    expectRejection(exec.validateTransaction(n, intent(), constraints()), "AAVE-V-APPROVAL-SPENDER");
  });

  it("accepts a bounded approval to the Pool", async () => {
    const n = await exec.decodeTransaction(prep(enc("repay", [USDC, 500_000_000n, 2n, OWNER])));
    n.allowanceChanges = [{ token: USDC, spender: D.pool, amount: "500000000", unlimited: false }];
    expect(exec.validateTransaction(n, intent(), constraints()).ok).toBe(true);
  });
});

describe("AAVE-019 provider failure fails closed", () => {
  it("the state adapter refuses to fabricate a position", async () => {
    await expect(new AaveStateAdapter().fetch({ account: OWNER })).rejects.toThrow(/refusing to fabricate a position/);
  });

  it("a wrong Pool target is rejected with AAVE-V-POOL", async () => {
    const { result } = await judge(enc("repay", [USDC, 500_000_000n, 2n, OWNER]), intent(), constraints(), ATTACKER);
    expectRejection(result, "AAVE-V-POOL");
  });

  it("a chain mismatch is rejected with AAVE-V-CHAIN", async () => {
    const p = { ...prep(enc("repay", [USDC, 500_000_000n, 2n, OWNER])), chainId: 1 };
    const n = await exec.decodeTransaction(p);
    expectRejection(exec.validateTransaction(n, intent(), constraints()), "AAVE-V-CHAIN");
  });

  it("the deprecated stable rate mode is rejected at intent AND at validation", async () => {
    const r = exec.normalizeIntent({ ...intent(), interestRateMode: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.code)).toContain("AAVE-I5");
    const { result } = await judge(enc("repay", [USDC, 500_000_000n, 1n, OWNER]));
    expectRejection(result, "AAVE-V-RATE-MODE");
  });

  it("a zero or malformed amount is rejected before any transaction is built", () => {
    const zero = exec.normalizeIntent({ ...intent(), amount: "0" });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.problems.map((p) => p.code)).toContain("AAVE-I4");
    const bad = exec.normalizeIntent({ ...intent(), amount: "lots" });
    if (!bad.ok) expect(bad.problems.map((p) => p.code)).toContain("AAVE-I3");
  });
});

/* ─────────────── AAVE-014/015/016 state freshness and composition ─────────── */

describe("AAVE-014 stale account state is rejected", () => {
  it("fails with AAVE-STALE-POSITION specifically", async () => {
    const a = new AaveStateAdapter(async () => raw({ timestamp: now - 3_600 }));
    const q = a.fixtureQuery();
    const obs = a.normalize(await a.fetch(q), q, ctx);
    expectRejection(a.validate(obs, ctx), "AAVE-STALE-POSITION");
  });

  it("accepts a fresh position and produces usable provenance", async () => {
    const a = new AaveStateAdapter(async () => raw());
    const q = a.fixtureQuery();
    const obs = a.normalize(await a.fetch(q), q, ctx);
    expect(a.validate(obs, ctx).ok).toBe(true);
    expect(obs.unit).toBe("wad");
    expect(obs.decimals).toBe(18);
    expect(obs.provenance.trustClass).toBe("DIRECT_CHAIN_DATA");
    expect(obs.provenance.blockNumber).toBe("9000000");
    expect(() => assertUsableObservation(obs, "aave-v3-state")).not.toThrow();
  });

  it("labels each data kind with its OWN unit", async () => {
    const a = new AaveStateAdapter(async () => raw());
    const usd = a.normalize(await a.fetch({ account: OWNER }), { account: OWNER, dataKind: "aave_total_debt_usd" }, ctx);
    expect(usd.unit).toBe("USD");
    expect(usd.decimals).toBe(8);
    const hf = a.normalize(await a.fetch({ account: OWNER }), { account: OWNER, dataKind: "aave_position_health_factor" }, ctx);
    expect(hf.unit).toBe("wad");
    expect(hf.decimals).toBe(18);
    // Same tuple, same read, ten orders of magnitude apart.
    expect(usd.decimals).not.toBe(hf.decimals);
  });

  it("a no-debt position is labelled distinctly", async () => {
    const a = new AaveStateAdapter(async () => raw({ totalDebtBase: 0n, healthFactor: NO_DEBT_SENTINEL }));
    const q = a.fixtureQuery();
    const obs = a.normalize(await a.fetch(q), q, ctx);
    expect(obs.unit).toBe("wad-no-debt");
  });

  it("rejects an unknown data kind rather than returning something adjacent", async () => {
    const a = new AaveStateAdapter(async () => raw());
    await expect(async () => a.normalize(await a.fetch({ account: OWNER }), { account: OWNER, dataKind: "eth_usd_price" }, ctx)).rejects.toThrow(
      /AAVE-UNKNOWN-DATAKIND/,
    );
  });
});

describe("AAVE-015/016 Aave answers position, never market price", () => {
  const registry = () => {
    const r = new AdapterRegistry();
    r.register({ kind: "data", manifest: aaveStateManifest, adapter: new AaveStateAdapter() });
    r.register({ kind: "data", manifest: thegraphSubgraphManifest, adapter: new TheGraphSubgraphAdapter() });
    return r;
  };

  it("AAVE-016 a verified-price requirement finds nothing when only Aave and Graph are registered", () => {
    const out = resolveDataRequirement(registry(), {
      key: "ethUsd", kind: "eth_usd_price", chainId: SEPOLIA,
      minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 30_000, confidential: false, historical: false,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("NO_COMPATIBLE_ADAPTER");
  });

  it("Aave IS selected for the position it actually owns", () => {
    const out = resolveDataRequirement(registry(), {
      key: "hf", kind: "aave_position_health_factor", chainId: SEPOLIA,
      minimumTrustClass: "DIRECT_CHAIN_DATA", maxAgeMs: 60_000, confidential: false, historical: false,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.selection.adapterId).toBe("aave-v3-state");
  });

  it("Aave cannot be raised to oracle trust for its own data either", () => {
    const out = resolveDataRequirement(registry(), {
      key: "hf", kind: "aave_position_health_factor", chainId: SEPOLIA,
      minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 60_000, confidential: false, historical: false,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejected.some((x) => /offers DIRECT_CHAIN_DATA/.test(x.reason))).toBe(true);
  });

  it("a verified price is served by Chainlink alongside Aave position data", () => {
    const r = registry();
    r.register({ kind: "data", manifest: chainlinkDataFeedsManifest, adapter: new ChainlinkDataFeedsAdapter() });
    const price = resolveDataRequirement(r, {
      key: "ethUsd", kind: "eth_usd_price", chainId: SEPOLIA,
      minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 30_000, confidential: false, historical: false,
    });
    expect(price.ok).toBe(true);
    if (price.ok) expect(price.selection.adapterId).toBe("chainlink-data-feeds");
  });
});

/* ─────────────────────── AAVE-020 fixtures behave ─────────────────────────── */

describe("AAVE-020 every fixture is rejected by its INTENDED control", () => {
  it("execution fixtures produce exactly their declared reason code", async () => {
    for (const f of exec.createSimulationFixtures()) {
      const p = f.providerResponse as AavePrepared;
      if (f.expected.outcome === "ACCEPTED") {
        const n = await exec.decodeTransaction(p);
        const r = exec.validateTransaction(n, exec.fixtureIntent(), exec.fixtureConstraints());
        expect(r.ok, `${f.scenarioId}: ${r.problems.map((x) => x.code).join(", ")}`).toBe(true);
      } else {
        const want = f.expected.reasonCodeMatches;
        let codes: string[] = [];
        try {
          const n = await exec.decodeTransaction(p);
          codes = exec.validateTransaction(n, exec.fixtureIntent(), exec.fixtureConstraints()).problems.map((x) => x.code);
        } catch (e) {
          codes = [e instanceof AaveError ? e.code : "UNKNOWN"];
        }
        // The Group C rule: not "some rejection", the RIGHT rejection.
        expect(codes.some((c) => c.startsWith(want)), `${f.scenarioId}: expected ${want}, got ${codes.join(", ")}`).toBe(true);
      }
    }
  });

  it("state fixtures produce exactly their declared reason code", async () => {
    const state = new AaveStateAdapter();
    for (const f of state.createSimulationFixtures()) {
      if (f.providerResponse === null) continue;
      const runner = new AaveStateAdapter(async () => f.providerResponse as RawAccountData);
      const q = runner.fixtureQuery();
      const obs = runner.normalize(await runner.fetch(q), q, ctx);
      const r = runner.validate(obs, ctx);
      if (f.expected.outcome === "ACCEPTED") {
        expect(r.ok, f.scenarioId).toBe(true);
      } else {
        expectRejection(r, f.expected.reasonCodeMatches);
      }
    }
  });
});
