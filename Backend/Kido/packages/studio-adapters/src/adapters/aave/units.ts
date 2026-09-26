/**
 * Aave unit normalization.
 *
 * `getUserAccountData` returns four different unit systems in one tuple, and the documentation
 * states none of them (FND-V2-009). Every conversion lives here, is exercised in both directions,
 * and nothing outside this module touches a raw protocol integer.
 */

/** Health factor is WAD — 18 decimals. 1.6 is 1600000000000000000. */
export const WAD = 10n ** 18n;

/** `totalCollateralBase` / `totalDebtBase` / `availableBorrowsBase` are USD at 8 decimals. */
export const BASE_DECIMALS = 8;
export const BASE_UNIT = 10n ** BigInt(BASE_DECIMALS);

/**
 * What Aave returns when a user has no debt: `type(uint256).max`.
 *
 * Not infinity, not zero, and emphatically not something to convert to a JS number — `Number()`
 * gives 1.157e77, which is still bigger than any threshold, so a naive comparison *appears* to work
 * and the bug survives testing. Arithmetic on it produces garbage, and the garbage is an amount.
 */
export const NO_DEBT_SENTINEL = (1n << 256n) - 1n;

/**
 * A health factor, as a state rather than a number.
 *
 * `NO_DEBT` is a distinct case so a caller must handle it explicitly. Representing it as a very
 * large number would let "this position has no debt" and "this position is extremely healthy" be
 * confused — they are both true, but only one of them means there is anything to repay.
 */
export type HealthFactor =
  | { state: "NO_DEBT" }
  | { state: "KNOWN"; wad: bigint; bps: number };

export function normalizeHealthFactor(raw: bigint): HealthFactor {
  if (raw >= NO_DEBT_SENTINEL) return { state: "NO_DEBT" };
  return { state: "KNOWN", wad: raw, bps: Number((raw * 10_000n) / WAD) };
}

/** Express a human threshold ("1.6") in WAD, without floating point anywhere near it. */
export function healthFactorFromDecimalString(s: string): bigint {
  const trimmed = s.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`AAVE-HF-MALFORMED: "${s}" is not a decimal health factor`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole!) * WAD + BigInt(padded || "0");
}

export type HealthComparison = "BELOW" | "EQUAL" | "ABOVE" | "NO_DEBT";

/**
 * Compare a health factor against a WAD threshold.
 *
 * `NO_DEBT` is returned rather than `ABOVE`. A position with no debt is not "healthier than the
 * threshold" in any actionable sense — there is nothing to repay — and collapsing the two would let
 * a guardian conclude it should act.
 */
export function compareHealthFactor(hf: HealthFactor, thresholdWad: bigint): HealthComparison {
  if (hf.state === "NO_DEBT") return "NO_DEBT";
  if (hf.wad < thresholdWad) return "BELOW";
  if (hf.wad === thresholdWad) return "EQUAL";
  return "ABOVE";
}

/** USD base value → integer cents, for policy limits expressed in cents. */
export function baseToUsdCents(base: bigint): bigint {
  // 8 decimals → 2 decimals. Integer division truncates, which under-reports rather than
  // over-reports a spend against a cap — the safe direction.
  return base / (BASE_UNIT / 100n);
}

export function usdCentsToBase(cents: bigint): bigint {
  return cents * (BASE_UNIT / 100n);
}

/** Token base units → USD base units, given a price already in USD base units per whole token. */
export function tokenAmountToBase(amount: bigint, tokenDecimals: number, priceBase: bigint): bigint {
  return (amount * priceBase) / 10n ** BigInt(tokenDecimals);
}

/**
 * Repayment needed to lift a health factor to a target.
 *
 * HF = (collateral × liquidationThreshold) / debt, so the debt that yields the target is
 * `collateral × threshold / targetHF`, and the repayment is the difference.
 *
 * Returns null for a position with no debt rather than a number — the same reason
 * `compareHealthFactor` does. A caller must decide what "repay nothing" means; it is not this
 * function's place to return 0 and let the caller proceed as though it had computed something.
 */
export function repaymentToReachHealthFactor(args: {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  liquidationThresholdBps: number;
  targetHealthFactorWad: bigint;
}): bigint | null {
  const { totalCollateralBase, totalDebtBase, liquidationThresholdBps, targetHealthFactorWad } = args;
  if (totalDebtBase === 0n) return null;
  if (targetHealthFactorWad === 0n) throw new Error("AAVE-HF-ZERO-TARGET: target health factor must be positive");

  const weightedCollateral = (totalCollateralBase * BigInt(liquidationThresholdBps)) / 10_000n;
  const targetDebt = (weightedCollateral * WAD) / targetHealthFactorWad;
  if (targetDebt >= totalDebtBase) return 0n;
  return totalDebtBase - targetDebt;
}
