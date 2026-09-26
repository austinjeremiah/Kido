import { z } from "zod";

/**
 * The typed unit system.
 *
 * Aave's `getUserAccountData` returns a WAD health factor beside a USD-at-8-decimals debt figure in
 * the same tuple (FND-V2-009). Comparing them is a fourteen-order-of-magnitude error that produces
 * a perfectly well-formed number, and no sanity check catches it — the value is plausible in its
 * own scale.
 *
 * So units are part of the type, and comparing two values of different units is a compile error in
 * the strategy rather than a runtime surprise. A conversion must be written down.
 */

export const UnitKind = {
  TOKEN_AMOUNT: "TOKEN_AMOUNT",
  USD_VALUE: "USD_VALUE",
  PRICE: "PRICE",
  PERCENT: "PERCENT",
  BASIS_POINTS: "BASIS_POINTS",
  HEALTH_FACTOR: "HEALTH_FACTOR",
  TIMESTAMP: "TIMESTAMP",
  BLOCK_NUMBER: "BLOCK_NUMBER",
  COUNT: "COUNT",
  BOOLEAN: "BOOLEAN",
} as const;
export type UnitKind = (typeof UnitKind)[keyof typeof UnitKind];

export const UnitKindSchema = z.enum([
  "TOKEN_AMOUNT", "USD_VALUE", "PRICE", "PERCENT", "BASIS_POINTS",
  "HEALTH_FACTOR", "TIMESTAMP", "BLOCK_NUMBER", "COUNT", "BOOLEAN",
]);

/**
 * A unit is a kind plus its scale and, where it matters, its subject.
 *
 * `TOKEN_AMOUNT` of USDC at 6 decimals and `TOKEN_AMOUNT` of WETH at 18 are both token amounts and
 * are not interchangeable — the asset is part of the unit, not a label beside it.
 */
export const UnitSchema = z.object({
  kind: UnitKindSchema,
  decimals: z.number().int().min(0).max(36),
  /** Token symbol for TOKEN_AMOUNT; quote currency for PRICE/USD_VALUE. */
  subject: z.string().optional(),
});
export type Unit = z.infer<typeof UnitSchema>;

export const unit = (kind: UnitKind, decimals: number, subject?: string): Unit =>
  subject === undefined ? { kind, decimals } : { kind, decimals, subject };

/** The units this project actually encounters, named once so they are not respelled per use. */
export const UNITS = {
  usd: unit("USD_VALUE", 8, "USD"),
  usdCents: unit("USD_VALUE", 2, "USD"),
  healthFactor: unit("HEALTH_FACTOR", 18),
  bps: unit("BASIS_POINTS", 4),
  percent: unit("PERCENT", 2),
  count: unit("COUNT", 0),
  timestamp: unit("TIMESTAMP", 0),
  blockNumber: unit("BLOCK_NUMBER", 0),
  token: (symbol: string, decimals: number) => unit("TOKEN_AMOUNT", decimals, symbol),
  price: (quote: string, decimals: number) => unit("PRICE", decimals, quote),
} as const;

export class UnitMismatchError extends Error {
  constructor(readonly code: string, readonly left: Unit, readonly right: Unit, detail: string) {
    super(`${code}: ${detail} (${describeUnit(left)} vs ${describeUnit(right)})`);
    this.name = "UnitMismatchError";
  }
}

export function describeUnit(u: Unit): string {
  return u.subject ? `${u.kind}<${u.subject}>@${u.decimals}dp` : `${u.kind}@${u.decimals}dp`;
}

export function unitsEqual(a: Unit, b: Unit): boolean {
  return a.kind === b.kind && a.decimals === b.decimals && (a.subject ?? "") === (b.subject ?? "");
}

/**
 * May these two units be compared directly?
 *
 * Same kind AND same subject AND same scale. Same kind at a different scale is deliberately NOT
 * comparable: `1.6` health factor is `1600000000000000000` in WAD and `16000` in bps, and letting
 * them compare "because they're both health factors" is precisely the bug.
 */
export function assertComparable(a: Unit, b: Unit, context: string): void {
  if (a.kind !== b.kind) {
    throw new UnitMismatchError("STRAT-UNIT-KIND", a, b, `${context}: cannot compare different unit kinds`);
  }
  if ((a.subject ?? "") !== (b.subject ?? "")) {
    throw new UnitMismatchError("STRAT-UNIT-SUBJECT", a, b, `${context}: same kind, different subject`);
  }
  if (a.decimals !== b.decimals) {
    throw new UnitMismatchError("STRAT-UNIT-SCALE", a, b, `${context}: same unit at different scales; convert explicitly`);
  }
}

/** Arithmetic is narrower still: only a few combinations mean anything. */
export function assertAddable(a: Unit, b: Unit, context: string): void {
  assertComparable(a, b, context);
  if (a.kind === "HEALTH_FACTOR" || a.kind === "BLOCK_NUMBER" || a.kind === "BOOLEAN") {
    throw new UnitMismatchError("STRAT-UNIT-ADD", a, b, `${context}: ${a.kind} values are not additive`);
  }
}

export interface TypedValue {
  value: bigint;
  unit: Unit;
}

/** Rescale within the same kind and subject. The only sanctioned way to change decimals. */
export function rescale(v: TypedValue, decimals: number): TypedValue {
  const u = { ...v.unit, decimals };
  if (decimals === v.unit.decimals) return v;
  if (decimals > v.unit.decimals) {
    return { value: v.value * 10n ** BigInt(decimals - v.unit.decimals), unit: u };
  }
  // Truncates. For a spend measured against a cap that under-reports, which is the safe direction.
  return { value: v.value / 10n ** BigInt(v.unit.decimals - decimals), unit: u };
}

/**
 * Token amount × price → USD value.
 *
 * The one conversion a strategy genuinely needs, written out so it cannot happen by accident. Both
 * operands must be the units they claim, and the price's quote currency becomes the result's
 * subject — so a EUR-quoted price cannot silently produce a USD value.
 */
export function tokenToUsd(amount: TypedValue, price: TypedValue, outDecimals = 8): TypedValue {
  if (amount.unit.kind !== "TOKEN_AMOUNT") {
    throw new UnitMismatchError("STRAT-UNIT-CONVERT", amount.unit, price.unit, "tokenToUsd expects a TOKEN_AMOUNT");
  }
  if (price.unit.kind !== "PRICE") {
    throw new UnitMismatchError("STRAT-UNIT-CONVERT", amount.unit, price.unit, "tokenToUsd expects a PRICE");
  }
  const raw = (amount.value * price.value) / 10n ** BigInt(amount.unit.decimals);
  return rescale(
    { value: raw, unit: unit("USD_VALUE", price.unit.decimals, price.unit.subject ?? "USD") },
    outDecimals,
  );
}

/** part / whole → basis points. Both must be the same unit; a ratio of unlike things is nonsense. */
export function ratioToBps(part: TypedValue, whole: TypedValue): TypedValue {
  assertComparable(part.unit, whole.unit, "ratioToBps");
  if (whole.value === 0n) {
    throw new UnitMismatchError("STRAT-UNIT-DIVZERO", part.unit, whole.unit, "ratioToBps: denominator is zero");
  }
  return { value: (part.value * 10_000n) / whole.value, unit: UNITS.bps };
}

export function percentToBps(p: TypedValue): TypedValue {
  if (p.unit.kind !== "PERCENT") {
    throw new UnitMismatchError("STRAT-UNIT-CONVERT", p.unit, UNITS.bps, "percentToBps expects a PERCENT");
  }
  return { value: (p.value * 10_000n) / (100n * 10n ** BigInt(p.unit.decimals)), unit: UNITS.bps };
}
