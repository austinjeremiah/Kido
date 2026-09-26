import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256 } from "viem";
import { ADAPTER_MANIFEST_VERSION, type ContextLockAdapterManifest } from "../../core/manifest.js";
import {
  invalid,
  valid,
  type AdapterExecutionContext,
  type AdapterSimulationFixture,
  type DataAdapter,
  type DataReadContext,
  type ExecutionAdapter,
  type ExecutionConstraints,
  type NormalizedAction,
  type ValidationProblem,
  type ValidationResult,
} from "../../core/contracts.js";
import type { DataObservation } from "../../core/observation.js";
import { morphoDeploymentFor, UnknownMorphoDeploymentError } from "./deployments.js";
import { WAD } from "../aave/units.js";

/**
 * Morpho Blue adapter.
 *
 * Morpho Blue is a singleton with isolated markets. A market is five parameters — loan token,
 * collateral token, oracle, interest-rate model, liquidation LTV — and every call names them in
 * full. That shape decides two things here:
 *
 *   - the position is read per market, and its health is LLTV over the position's own LTV, not a
 *     protocol-wide figure; the oracle price (1e36-scaled, loan per collateral) is a protocol read,
 *     DIRECT_CHAIN_DATA, never a market truth;
 *   - the market parameters in calldata are decoded and compared with the intent's market id. A
 *     repay against a different market is a repay of someone else's kind of debt.
 *
 * Same rule as the Aave adapter: this adapter can construct `withdrawCollateral` and `borrow`,
 * because it must be able to decode them. Declaring is not permitting.
 */

const SEPOLIA = 11155111;

export class MorphoError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "MorphoError";
  }
}

/* ────────────────────────────────── ABI ───────────────────────────────────── */

const MARKET_PARAMS = {
  name: "marketParams",
  type: "tuple",
  components: [
    { name: "loanToken", type: "address" },
    { name: "collateralToken", type: "address" },
    { name: "oracle", type: "address" },
    { name: "irm", type: "address" },
    { name: "lltv", type: "uint256" },
  ],
} as const;

export const MORPHO_ABI = [
  {
    type: "function", name: "position", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }, { name: "user", type: "address" }],
    outputs: [{ name: "supplyShares", type: "uint256" }, { name: "borrowShares", type: "uint128" }, { name: "collateral", type: "uint128" }],
  },
  {
    type: "function", name: "market", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "totalSupplyAssets", type: "uint128" }, { name: "totalSupplyShares", type: "uint128" },
      { name: "totalBorrowAssets", type: "uint128" }, { name: "totalBorrowShares", type: "uint128" },
      { name: "lastUpdate", type: "uint128" }, { name: "fee", type: "uint128" },
    ],
  },
  {
    type: "function", name: "idToMarketParams", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" },
      { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" },
    ],
  },
  {
    type: "function", name: "supplyCollateral", stateMutability: "nonpayable",
    inputs: [MARKET_PARAMS, { name: "assets", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "data", type: "bytes" }],
    outputs: [],
  },
  {
    type: "function", name: "repay", stateMutability: "nonpayable",
    inputs: [MARKET_PARAMS, { name: "assets", type: "uint256" }, { name: "shares", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "data", type: "bytes" }],
    outputs: [{ name: "", type: "uint256" }, { name: "", type: "uint256" }],
  },
  {
    type: "function", name: "withdrawCollateral", stateMutability: "nonpayable",
    // NOTE: `receiver` RECEIVES FUNDS.
    inputs: [MARKET_PARAMS, { name: "assets", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "receiver", type: "address" }],
    outputs: [],
  },
  {
    type: "function", name: "borrow", stateMutability: "nonpayable",
    inputs: [MARKET_PARAMS, { name: "assets", type: "uint256" }, { name: "shares", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "receiver", type: "address" }],
    outputs: [{ name: "", type: "uint256" }, { name: "", type: "uint256" }],
  },
] as const;

export const MORPHO_ORACLE_ABI = [
  { type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

/** Morpho oracles quote loan-token-per-collateral-token scaled by 1e36. */
export const ORACLE_PRICE_SCALE = 10n ** 36n;

export interface MorphoMarketParams {
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  /** WAD. 0.86e18 means 86%. */
  lltv: string;
}

/* ───────────────────────────── normalized position ────────────────────────── */

export interface RawMorphoPosition {
  marketId: string;
  params: MorphoMarketParams;
  /** The user's borrow shares and the market totals, so borrow assets are derived here. */
  borrowShares: bigint;
  collateral: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  /** Oracle price, 1e36-scaled. */
  price: bigint;
  loanTokenDecimals: number;
  collateralTokenDecimals: number;
  blockNumber: bigint;
  timestamp: number;
}

export interface MorphoPosition {
  chainId: number;
  account: string;
  marketId: string;
  params: MorphoMarketParams;
  /** In loan-token units. */
  borrowAssets: string;
  /** In collateral-token units. */
  collateral: string;
  /** The collateral's value in loan-token units, at the market oracle's price. */
  collateralValueInLoan: string;
  ltvBps: number;
  lltvBps: number;
  /** LLTV / LTV, WAD. The Morpho analogue of a health factor; NO_DEBT when there is no borrow. */
  healthFactor: { state: "NO_DEBT" } | { state: "KNOWN"; wad: bigint; bps: number };
  blockNumber: string;
  timestamp: number;
}

/** Borrow assets from shares, rounding UP — the direction the protocol itself rounds a debt. */
export function borrowAssetsFromShares(shares: bigint, totalBorrowAssets: bigint, totalBorrowShares: bigint): bigint {
  if (shares === 0n) return 0n;
  // Morpho's virtual shares/assets offsets, so an empty market still divides.
  const VIRTUAL_SHARES = 10n ** 6n;
  const VIRTUAL_ASSETS = 1n;
  const num = shares * (totalBorrowAssets + VIRTUAL_ASSETS);
  const den = totalBorrowShares + VIRTUAL_SHARES;
  return (num + den - 1n) / den;
}

export function normalizeMorphoPosition(raw: RawMorphoPosition, account: string, chainId: number): MorphoPosition {
  morphoDeploymentFor(chainId);
  const borrowAssets = borrowAssetsFromShares(raw.borrowShares, raw.totalBorrowAssets, raw.totalBorrowShares);
  // collateral (collateral decimals) × price (1e36, loan per collateral) → loan units.
  const collateralValueInLoan = (raw.collateral * raw.price) / ORACLE_PRICE_SCALE;
  const lltv = BigInt(raw.params.lltv);
  const lltvBps = Number(lltv / 10n ** 14n);
  let ltvBps = 0;
  let healthFactor: MorphoPosition["healthFactor"] = { state: "NO_DEBT" };
  if (borrowAssets > 0n) {
    ltvBps = collateralValueInLoan === 0n ? 1_000_000 : Number((borrowAssets * 10_000n) / collateralValueInLoan);
    // HF = (collateralValue × LLTV) / borrow, in WAD.
    const hfWad = borrowAssets === 0n ? 0n : (collateralValueInLoan * lltv) / borrowAssets;
    healthFactor = { state: "KNOWN", wad: hfWad, bps: Number((hfWad * 10_000n) / WAD) };
  }
  return {
    chainId,
    account: getAddress(account),
    marketId: raw.marketId,
    params: raw.params,
    borrowAssets: borrowAssets.toString(),
    collateral: raw.collateral.toString(),
    collateralValueInLoan: collateralValueInLoan.toString(),
    ltvBps,
    lltvBps,
    healthFactor,
    blockNumber: raw.blockNumber.toString(),
    timestamp: raw.timestamp,
  };
}

/* ─────────────────────────────── manifests ────────────────────────────────── */

const baseManifest = (over: Partial<ContextLockAdapterManifest>): ContextLockAdapterManifest =>
  ({
    schemaVersion: ADAPTER_MANIFEST_VERSION,
    version: "1.0.0",
    provider: "morpho",
    supportedChains: [SEPOLIA, 1],
    inputSchema: {},
    outputSchema: {},
    permissionsRequired: [],
    executionPlacement: "studio-backend",
    auth: { mode: "none", requiredSecretNames: [], placement: "never-client" },
    documentation: {
      officialDocs: ["https://docs.morpho.org/morpho/overview", "https://docs.morpho.org/get-started/resources/addresses"],
      verifiedOn: "2026-09-11",
      notes:
        "Morpho Blue singleton verified on Sepolia (0xd011…4A14) and mainnet (0xBBBB…FFCb) by owner() and bytecode size. Markets are bytes32 ids; health is LLTV/LTV from the market's own oracle (1e36-scaled).",
    },
    ...over,
  }) as ContextLockAdapterManifest;

export const morphoStateManifest = baseManifest({
  id: "morpho-blue-state",
  adapterType: "STATE_DATA",
  name: "Morpho Blue Position State",
  description: "Reads a normalized Morpho Blue position in one market: borrow, collateral, LTV against the market's LLTV.",
  capabilities: [
    { name: "ACCOUNT_POSITION", description: "Full normalized position in one market.", dataKind: "morpho_account_position", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "HEALTH_FACTOR", description: "LLTV over the position's LTV, WAD.", dataKind: "morpho_position_health_factor", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "LTV", description: "The position's loan-to-value in basis points.", dataKind: "morpho_position_ltv_bps", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "TOTAL_DEBT", description: "Borrow assets in loan-token units.", dataKind: "morpho_total_debt", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "COLLATERAL", description: "Collateral in collateral-token units.", dataKind: "morpho_collateral", trustClass: "DIRECT_CHAIN_DATA" },
  ],
  trustClass: "DIRECT_CHAIN_DATA",
  freshnessSemantics: { kind: "block-height", typicalStalenessMs: 12_000, exposesBlockLag: false },
  safety: { decodesPreparedTransactions: false, supportsDryRun: true, allowsArbitraryTarget: false, allowsArbitraryRecipient: false, independentlyValidatesProviderOutput: true },
  generatedModules: [
    { path: "src/adapters/morpho-blue-state/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/morpho-blue-state/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["MORPHO-HEALTHY", "MORPHO-LTV-RISE", "MORPHO-NO-DEBT", "MORPHO-STALE-POSITION", "MORPHO-RPC-FAILURE"],
  securityAssertions: [
    { id: "AS-MORPHO-1", statement: "Health is derived from the market's own LLTV and oracle; raw shares never reach a comparison.", provenBy: ["MORPHO-003"] },
    { id: "AS-MORPHO-2", statement: "Morpho position data is DIRECT_CHAIN_DATA and cannot satisfy a verified-oracle price requirement.", provenBy: ["MORPHO-016"] },
  ],
});

export const morphoExecutionManifest = baseManifest({
  id: "morpho-blue-execution",
  adapterType: "EXECUTION",
  name: "Morpho Blue Execution",
  description: "Constructs and independently validates Morpho Blue repay and supplyCollateral; decodes withdrawCollateral and borrow to refuse them.",
  capabilities: [
    { name: "MORPHO_SUPPLY_COLLATERAL", description: "Add collateral to the position in one market." },
    { name: "MORPHO_REPAY", description: "Repay loan-token debt in one market." },
    { name: "MORPHO_WITHDRAW_COLLATERAL", description: "Withdraw collateral. HIGH RISK — never permitted by default." },
    { name: "MORPHO_BORROW", description: "Borrow against collateral. HIGH RISK — never permitted by default." },
  ],
  trustClass: "USER_UNTRUSTED",
  freshnessSemantics: { kind: "request-time", typicalStalenessMs: 0, exposesBlockLag: false },
  safety: { decodesPreparedTransactions: true, supportsDryRun: true, allowsArbitraryTarget: false, allowsArbitraryRecipient: false, independentlyValidatesProviderOutput: true },
  generatedModules: [
    { path: "src/adapters/morpho-blue-execution/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/morpho-blue-execution/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: [
    "MORPHO-AUTO-REPAY", "MORPHO-BENEFICIARY-MUTATION", "MORPHO-AMOUNT-MUTATION", "MORPHO-MARKET-MUTATION",
    "MORPHO-WITHDRAW-FORBIDDEN", "MORPHO-BORROW-FORBIDDEN", "MORPHO-WRONG-TARGET", "MORPHO-CALLBACK-DATA",
  ],
  securityAssertions: [
    { id: "AS-MORPHOX-1", statement: "A substituted onBehalf is rejected exactly like a swap recipient substitution.", provenBy: ["MORPHO-010"] },
    { id: "AS-MORPHOX-2", statement: "Adapter capability is not agent authority: withdrawCollateral and borrow are refused unless explicitly permitted.", provenBy: ["MORPHO-011"] },
    { id: "AS-MORPHOX-3", statement: "The market in calldata must be the intended market; a repay into a different market is refused.", provenBy: ["MORPHO-012"] },
    { id: "AS-MORPHOX-4", statement: "Callback data is refused: a non-empty `data` re-enters the caller with control of the flow.", provenBy: ["MORPHO-013"] },
  ],
});

export const MORPHO_HIGH_RISK_ACTIONS = new Set(["MORPHO_WITHDRAW_COLLATERAL", "MORPHO_BORROW"]);

/* ─────────────────────────────── state adapter ────────────────────────────── */

export interface MorphoStateQuery {
  account: string;
  marketId: string;
  dataKind?: string;
}

export class MorphoStateAdapter implements DataAdapter<MorphoStateQuery, RawMorphoPosition> {
  constructor(
    private readonly reader?: (q: MorphoStateQuery) => Promise<RawMorphoPosition>,
    private readonly maxAgeMs = 120_000,
  ) {}

  manifest(): ContextLockAdapterManifest {
    return morphoStateManifest;
  }

  validateQuery(query: unknown) {
    const q = query as MorphoStateQuery;
    const problems: ValidationProblem[] = [];
    if (!q || typeof q.account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(q.account)) {
      problems.push({ code: "MORPHO-QUERY-ACCOUNT", severity: "CRITICAL", field: "account", message: "account must be an address" });
    }
    if (!q || typeof q.marketId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(q.marketId)) {
      problems.push({ code: "MORPHO-QUERY-MARKET", severity: "CRITICAL", field: "marketId", message: "marketId must be a bytes32 market id" });
    }
    return problems.length > 0 ? ({ ok: false, problems } as const) : ({ ok: true, query: q } as const);
  }

  async fetch(query: MorphoStateQuery): Promise<RawMorphoPosition> {
    if (!this.reader) throw new MorphoError("MORPHO-NO-READER", "no chain reader configured; refusing to fabricate a position");
    return this.reader(query);
  }

  provenance(raw: RawMorphoPosition, ctx: DataReadContext): DataObservation["provenance"] {
    const d = morphoDeploymentFor(ctx.chainId);
    return {
      provider: "morpho",
      adapterId: morphoStateManifest.id,
      adapterVersion: morphoStateManifest.version,
      trustClass: "DIRECT_CHAIN_DATA",
      sourceTimestamp: new Date(raw.timestamp * 1000).toISOString(),
      freshnessMs: Math.max(0, ctx.nowMs - raw.timestamp * 1000),
      chainId: ctx.chainId,
      blockNumber: raw.blockNumber.toString(),
      feedId: `${d.morpho}:${raw.marketId}`,
      verification: { verified: false, mechanism: "direct-singleton-read" },
    };
  }

  normalize(raw: RawMorphoPosition, query: MorphoStateQuery, ctx: DataReadContext): DataObservation {
    const p = normalizeMorphoPosition(raw, query.account, ctx.chainId);
    const kind = query.dataKind ?? "morpho_position_health_factor";
    const { value, unit, decimals } = ((): { value: string; unit: string; decimals: number } => {
      switch (kind) {
        case "morpho_position_health_factor":
          return p.healthFactor.state === "NO_DEBT" ? { value: ((1n << 256n) - 1n).toString(), unit: "wad-no-debt", decimals: 18 } : { value: p.healthFactor.wad.toString(), unit: "wad", decimals: 18 };
        case "morpho_position_ltv_bps":
          return { value: String(p.ltvBps), unit: "bps", decimals: 0 };
        case "morpho_total_debt":
        case "morpho_account_position":
          return { value: p.borrowAssets, unit: "loan-token", decimals: raw.loanTokenDecimals };
        case "morpho_collateral":
          return { value: p.collateral, unit: "collateral-token", decimals: raw.collateralTokenDecimals };
        default:
          throw new MorphoError("MORPHO-UNKNOWN-DATAKIND", `this adapter does not provide "${kind}"`);
      }
    })();
    return {
      observationId: `morpho-${kind}-${p.account}-${p.marketId.slice(0, 10)}-${p.blockNumber}`,
      dataKind: kind, subject: p.account, value, unit, decimals,
      observedAt: new Date(ctx.nowMs).toISOString(),
      provenance: this.provenance(raw, ctx),
    };
  }

  validate(observation: DataObservation): ValidationResult {
    const problems: ValidationProblem[] = [];
    const age = observation.provenance.freshnessMs;
    if (age === undefined || age > this.maxAgeMs) {
      problems.push({ code: "MORPHO-STALE-POSITION", severity: "CRITICAL", field: "timestamp", message: age === undefined ? "position carries no timestamp" : `position is ${Math.round(age / 1000)}s old, limit is ${Math.round(this.maxAgeMs / 1000)}s` });
    }
    if (!/^\d+$/.test(observation.value)) {
      problems.push({ code: "MORPHO-VALUE-SHAPE", severity: "CRITICAL", field: "value", message: "value must be integer base units" });
    }
    return problems.length > 0 ? invalid(problems) : valid();
  }

  fixtureQuery(): MorphoStateQuery {
    return { account: "0x0000000000000000000000000000000000005e1f", marketId: FIXTURE_MARKET_ID, dataKind: "morpho_position_health_factor" };
  }

  createSimulationFixtures(): AdapterSimulationFixture[] {
    const now = Math.floor(Date.now() / 1000);
    const base = (over: Partial<RawMorphoPosition> = {}): RawMorphoPosition => ({
      marketId: FIXTURE_MARKET_ID,
      params: FIXTURE_PARAMS,
      borrowShares: 2_000_000_000n * 10n ** 6n,
      collateral: 2n * 10n ** 18n,
      totalBorrowAssets: 10_000_000_000n,
      totalBorrowShares: 10_000_000_000n * 10n ** 6n,
      // 2 ETH at $2,400 = $4,800 of loan token (6dp): price = 2400e6 × 1e36 / 1e18
      price: 2_400_000_000n * ORACLE_PRICE_SCALE / 10n ** 18n,
      loanTokenDecimals: 6,
      collateralTokenDecimals: 18,
      blockNumber: 9_000_000n,
      timestamp: now - 10,
      ...over,
    });
    return [
      { scenarioId: "MORPHO-HEALTHY", description: "LTV well under the market's LLTV.", providerResponse: base(), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "MORPHO-LTV-RISE", description: "LTV rises close to LLTV but the reading is valid.", providerResponse: base({ borrowShares: 3_900_000_000n * 10n ** 6n }), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "MORPHO-NO-DEBT", description: "No borrow shares: health is NO_DEBT, not a number.", providerResponse: base({ borrowShares: 0n }), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "MORPHO-STALE-POSITION", description: "Position read is older than the freshness bound.", providerResponse: base({ timestamp: now - 3_600 }), expected: { outcome: "REJECTED", reasonCodeMatches: "MORPHO-STALE-POSITION" } },
      { scenarioId: "MORPHO-RPC-FAILURE", description: "Singleton read fails.", providerResponse: null, expected: { outcome: "REJECTED", reasonCodeMatches: "MORPHO-" } },
    ];
  }

  generateTemplateConfig() {
    const d = morphoDeploymentFor(SEPOLIA);
    return { adapterId: morphoStateManifest.id, morpho: d.morpho, oraclePriceScale: ORACLE_PRICE_SCALE.toString(), healthFactorDecimals: 18, maxPositionAgeMs: this.maxAgeMs };
  }
}

/* ───────────────────────────── execution adapter ──────────────────────────── */

export type MorphoActionKind = "MORPHO_SUPPLY_COLLATERAL" | "MORPHO_REPAY" | "MORPHO_WITHDRAW_COLLATERAL" | "MORPHO_BORROW";

export interface MorphoIntent {
  action: MorphoActionKind;
  chainId: number;
  /** The position owner: `onBehalf`. */
  account: string;
  marketId: string;
  params: MorphoMarketParams;
  /** Assets, in the token the action moves (loan token for repay, collateral token for supply). */
  amount: string;
}

export interface MorphoPrepared {
  to: string;
  data: string;
  value: string;
  chainId: number;
  summary: { action: string; account: string; amount: string };
}

export interface MorphoConstraints extends ExecutionConstraints {
  permittedActions: MorphoActionKind[];
}

/** keccak256(abi.encode(marketParams)) — the market id the singleton derives. */
export function marketIdOf(p: MorphoMarketParams): string {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
    [getAddress(p.loanToken), getAddress(p.collateralToken), getAddress(p.oracle), getAddress(p.irm), BigInt(p.lltv)],
  ));
}

export class MorphoExecutionAdapter implements ExecutionAdapter<MorphoIntent, MorphoPrepared> {
  constructor(private readonly builder?: (i: MorphoIntent) => MorphoPrepared) {}

  manifest(): ContextLockAdapterManifest {
    return morphoExecutionManifest;
  }

  supportedActions(): string[] {
    return ["MORPHO_SUPPLY_COLLATERAL", "MORPHO_REPAY", "MORPHO_WITHDRAW_COLLATERAL", "MORPHO_BORROW"];
  }

  normalizeIntent(intent: unknown) {
    const i = intent as MorphoIntent;
    const problems: ValidationProblem[] = [];
    const addr = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
    if (!i || !this.supportedActions().includes(i.action)) problems.push({ code: "MORPHO-I0", severity: "CRITICAL", field: "action", message: `unsupported action "${i?.action}"` });
    if (!addr(i?.account)) problems.push({ code: "MORPHO-I1", severity: "CRITICAL", field: "account", message: "account must be an address" });
    if (!i?.params || !addr(i.params.loanToken) || !addr(i.params.collateralToken) || !addr(i.params.oracle) || !addr(i.params.irm) || !/^\d+$/.test(String(i.params.lltv))) {
      problems.push({ code: "MORPHO-I2", severity: "CRITICAL", field: "params", message: "market params must name loanToken, collateralToken, oracle, irm and lltv" });
    } else if (typeof i.marketId === "string" && marketIdOf(i.params).toLowerCase() !== i.marketId.toLowerCase()) {
      problems.push({ code: "MORPHO-I5", severity: "CRITICAL", field: "marketId", message: "marketId does not hash from the given market params" });
    }
    if (!/^\d+$/.test(String(i?.amount))) problems.push({ code: "MORPHO-I3", severity: "CRITICAL", field: "amount", message: "amount must be integer base units" });
    else if (BigInt(i.amount) === 0n) problems.push({ code: "MORPHO-I4", severity: "HIGH", field: "amount", message: "amount must be positive" });
    return problems.length > 0 ? ({ ok: false, problems } as const) : ({ ok: true, intent: i } as const);
  }

  async buildTransaction(intent: MorphoIntent, ctx: AdapterExecutionContext): Promise<MorphoPrepared> {
    if (this.builder) return this.builder(intent);
    const d = morphoDeploymentFor(intent.chainId);
    const account = getAddress(intent.account);
    const amount = BigInt(intent.amount);
    const mp = tupleOf(intent.params);
    const data = ((): string => {
      switch (intent.action) {
        case "MORPHO_SUPPLY_COLLATERAL":
          return encodeFunctionData({ abi: MORPHO_ABI, functionName: "supplyCollateral", args: [mp, amount, account, "0x"] });
        case "MORPHO_REPAY":
          return encodeFunctionData({ abi: MORPHO_ABI, functionName: "repay", args: [mp, amount, 0n, account, "0x"] });
        case "MORPHO_WITHDRAW_COLLATERAL":
          return encodeFunctionData({ abi: MORPHO_ABI, functionName: "withdrawCollateral", args: [mp, amount, account, account] });
        case "MORPHO_BORROW":
          return encodeFunctionData({ abi: MORPHO_ABI, functionName: "borrow", args: [mp, amount, 0n, account, account] });
      }
    })();
    void ctx;
    return { to: d.morpho, data, value: "0", chainId: intent.chainId, summary: { action: intent.action, account: intent.account, amount: intent.amount } };
  }

  async decodeTransaction(prepared: MorphoPrepared): Promise<NormalizedAction> {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: MORPHO_ABI, data: prepared.data as `0x${string}` });
    } catch (e) {
      throw new MorphoError("MORPHO-NOT-SINGLETON-CALL", `calldata is not a Morpho Blue call: ${(e as Error).message}`);
    }
    const args = decoded.args as readonly unknown[];
    const fn = decoded.functionName;
    const mp = args[0] as { loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: bigint };
    const params: MorphoMarketParams = { loanToken: getAddress(mp.loanToken), collateralToken: getAddress(mp.collateralToken), oracle: getAddress(mp.oracle), irm: getAddress(mp.irm), lltv: mp.lltv.toString() };

    let actionType: MorphoActionKind;
    let token: string;
    let amount: bigint;
    let beneficiary: string;
    let receiver: string | undefined;
    let receivesFunds = false;
    let callbackData: string | undefined;
    let shares: bigint | undefined;

    switch (fn) {
      case "supplyCollateral":
        actionType = "MORPHO_SUPPLY_COLLATERAL"; token = params.collateralToken; amount = args[1] as bigint; beneficiary = getAddress(args[2] as string); callbackData = args[3] as string;
        break;
      case "repay":
        actionType = "MORPHO_REPAY"; token = params.loanToken; amount = args[1] as bigint; shares = args[2] as bigint; beneficiary = getAddress(args[3] as string); callbackData = args[4] as string;
        break;
      case "withdrawCollateral":
        actionType = "MORPHO_WITHDRAW_COLLATERAL"; token = params.collateralToken; amount = args[1] as bigint; beneficiary = getAddress(args[2] as string); receiver = getAddress(args[3] as string); receivesFunds = true;
        break;
      case "borrow":
        actionType = "MORPHO_BORROW"; token = params.loanToken; amount = args[1] as bigint; shares = args[2] as bigint; beneficiary = getAddress(args[3] as string); receiver = getAddress(args[4] as string); receivesFunds = true;
        break;
      default:
        throw new MorphoError("MORPHO-UNSUPPORTED-FUNCTION", `singleton function "${fn}" is not decoded by this adapter; refusing to authorize a call it cannot fully read`);
    }

    const flow = { token, amount: amount.toString(), to: receiver ?? beneficiary };
    return {
      chainId: prepared.chainId,
      target: getAddress(prepared.to),
      calldata: prepared.data,
      value: prepared.value,
      actionType,
      inputs: receivesFunds ? [] : [flow],
      outputs: receivesFunds ? [flow] : [],
      // For a withdraw/borrow the RECEIVER is who gets the funds; that is the recipient the policy checks.
      recipient: receiver ?? beneficiary,
      allowanceChanges: [],
      minOutputs: [],
      providerMetadata: {
        function: fn, summary: prepared.summary, receivesFunds, marketId: marketIdOf(params), params, onBehalf: beneficiary,
        ...(receiver ? { receiver } : {}), ...(callbackData !== undefined ? { callbackData } : {}), ...(shares !== undefined ? { shares: shares.toString() } : {}),
      },
    };
  }

  validateTransaction(n: NormalizedAction, intent: MorphoIntent, c: ExecutionConstraints): ValidationResult {
    const problems: ValidationProblem[] = [];
    const P = (code: string, field: string, message: string, severity: ValidationProblem["severity"] = "CRITICAL") => problems.push({ code, severity, field, message });
    const permitted = (c as MorphoConstraints).permittedActions ?? ["MORPHO_SUPPLY_COLLATERAL", "MORPHO_REPAY"];
    const meta = n.providerMetadata as { marketId?: string; onBehalf?: string; receiver?: string; callbackData?: string; shares?: string };

    if (!permitted.includes(n.actionType as MorphoActionKind)) {
      P(MORPHO_HIGH_RISK_ACTIONS.has(n.actionType) ? "MORPHO-V-HIGH-RISK-ACTION" : "MORPHO-V-ACTION-NOT-PERMITTED", "actionType", `decoded action ${n.actionType} is not in the Blueprint's permitted set (${permitted.join(", ")}); adapter capability is not agent authority`);
    }
    if (n.actionType !== intent.action) P("MORPHO-V-ACTION-MISMATCH", "actionType", `decoded ${n.actionType} but the intent was ${intent.action}`);
    if (n.chainId !== c.chainId) P("MORPHO-V-CHAIN", "chainId", `decoded chain ${n.chainId} != policy chain ${c.chainId}`);
    if (!c.allowedTargets.map((t) => t.toLowerCase()).includes(n.target.toLowerCase())) P("MORPHO-V-TARGET", "target", `target ${n.target} is not the allow-listed Morpho singleton`);
    if ((meta.marketId ?? "").toLowerCase() !== intent.marketId.toLowerCase()) P("MORPHO-V-MARKET", "marketId", `decoded market ${meta.marketId} is not the intended market ${intent.marketId}`);

    const flow = n.inputs[0] ?? n.outputs[0];
    if (!flow) P("MORPHO-V-NO-FLOW", "inputs", "no asset flow could be decoded");
    else if (flow.amount !== intent.amount) P("MORPHO-V-AMOUNT", "amount", `decoded amount ${flow.amount} does not match the intended ${intent.amount}`);
    if (meta.shares !== undefined && meta.shares !== "0") P("MORPHO-V-SHARES", "shares", "assets and shares must not both be given; shares must be 0 for an exact-assets action");
    if (meta.callbackData !== undefined && meta.callbackData !== "0x") P("MORPHO-V-CALLBACK", "data", "callback data must be empty; a callback re-enters the caller with control of the flow");

    const onBehalf = (meta.onBehalf ?? "").toLowerCase();
    if (!onBehalf) P("MORPHO-V-NO-BENEFICIARY", "recipient", "no beneficiary could be decoded");
    else {
      if (onBehalf !== intent.account.toLowerCase()) P("MORPHO-V-BENEFICIARY", "recipient", `decoded onBehalf ${meta.onBehalf} does not match the intended ${intent.account}`);
      if (c.allowedRecipients === "self-only" && onBehalf !== c.owner.toLowerCase()) P("MORPHO-V-BENEFICIARY-SELF", "recipient", `policy is self-only; decoded ${meta.onBehalf}`);
    }
    if (meta.receiver && c.allowedRecipients === "self-only" && meta.receiver.toLowerCase() !== c.owner.toLowerCase()) {
      P("MORPHO-V-RECEIVER", "recipient", `funds would go to ${meta.receiver}; policy is self-only`);
    }
    return problems.length > 0 ? invalid(problems) : valid();
  }

  fixtureConstraints(): MorphoConstraints {
    const d = morphoDeploymentFor(SEPOLIA);
    return { chainId: SEPOLIA, allowedTargets: [d.morpho], allowedRecipients: "self-only", owner: "0x0000000000000000000000000000000000005e1f", allowUnlimitedApprovals: false, maxQuoteAgeMs: 60_000, permittedActions: ["MORPHO_SUPPLY_COLLATERAL", "MORPHO_REPAY"] };
  }

  fixtureIntent(): MorphoIntent {
    return { action: "MORPHO_REPAY", chainId: SEPOLIA, account: "0x0000000000000000000000000000000000005e1f", marketId: FIXTURE_MARKET_ID, params: FIXTURE_PARAMS, amount: "500000000" };
  }

  createSimulationFixtures(): AdapterSimulationFixture[] {
    const d = morphoDeploymentFor(SEPOLIA);
    const owner = "0x0000000000000000000000000000000000005e1f";
    const attacker = "0x000000000000000000000000000000000000dEaD";
    const amount = 500_000_000n;
    const mp = tupleOf(FIXTURE_PARAMS);
    const other = tupleOf({ ...FIXTURE_PARAMS, lltv: "770000000000000000" });
    const mk = (data: string, to = d.morpho): MorphoPrepared => ({ to, data, value: "0", chainId: SEPOLIA, summary: { action: "MORPHO_REPAY", account: owner, amount: amount.toString() } });
    const enc = (fn: "supplyCollateral" | "repay" | "withdrawCollateral" | "borrow", args: readonly unknown[]) => encodeFunctionData({ abi: MORPHO_ABI, functionName: fn, args: args as never });
    return [
      { scenarioId: "MORPHO-AUTO-REPAY", description: "A repay that decodes to exactly the intent.", providerResponse: mk(enc("repay", [mp, amount, 0n, owner, "0x"])), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "MORPHO-BENEFICIARY-MUTATION", description: "Repay credited to an attacker's position.", providerResponse: mk(enc("repay", [mp, amount, 0n, attacker, "0x"])), expected: { outcome: "REJECTED", reasonCodeMatches: "MORPHO-V-BENEFICIARY" } },
      { scenarioId: "MORPHO-AMOUNT-MUTATION", description: "Repay amount inflated in the calldata.", providerResponse: mk(enc("repay", [mp, 9_999_999_999n, 0n, owner, "0x"])), expected: { outcome: "REJECTED", reasonCodeMatches: "MORPHO-V-AMOUNT" } },
      { scenarioId: "MORPHO-MARKET-MUTATION", description: "Repay constructed against a different market.", providerResponse: mk(enc("repay", [other, amount, 0n, owner, "0x"])), expected: { outcome: "REJECTED", reasonCodeMatches: "MORPHO-V-MARKET" } },
      { scenarioId: "MORPHO-WITHDRAW-FORBIDDEN", description: "A collateral withdrawal the Blueprint never permitted.", providerResponse: mk(enc("withdrawCollateral", [mp, amount, owner, owner])), expected: { outcome: "REJECTED", reasonCodeMatches: "MORPHO-V-HIGH-RISK-ACTION" } },
      { scenarioId: "MORPHO-BORROW-FORBIDDEN", description: "A borrow the Blueprint never permitted.", providerResponse: mk(enc("borrow", [mp, amount, 0n, owner, owner])), expected: { outcome: "REJECTED", reasonCodeMatches: "MORPHO-V-HIGH-RISK-ACTION" } },
      { scenarioId: "MORPHO-WRONG-TARGET", description: "Transaction targets a contract other than the verified singleton.", providerResponse: mk(enc("repay", [mp, amount, 0n, owner, "0x"]), attacker), expected: { outcome: "REJECTED", reasonCodeMatches: "MORPHO-V-TARGET" } },
      { scenarioId: "MORPHO-CALLBACK-DATA", description: "Repay with callback data that would re-enter the caller.", providerResponse: mk(enc("repay", [mp, amount, 0n, owner, "0xdeadbeef"])), expected: { outcome: "REJECTED", reasonCodeMatches: "MORPHO-V-CALLBACK" } },
    ];
  }

  generateTemplateConfig() {
    const d = morphoDeploymentFor(SEPOLIA);
    return { adapterId: morphoExecutionManifest.id, morpho: d.morpho, highRiskActions: [...MORPHO_HIGH_RISK_ACTIONS], defaultPermittedActions: ["MORPHO_SUPPLY_COLLATERAL", "MORPHO_REPAY"] };
  }
}

/* ───────────────────────────── fixtures / helpers ─────────────────────────── */

const tupleOf = (p: MorphoMarketParams) => ({
  loanToken: getAddress(p.loanToken), collateralToken: getAddress(p.collateralToken), oracle: getAddress(p.oracle), irm: getAddress(p.irm), lltv: BigInt(p.lltv),
});

/** A fixture market: Sepolia USDC loan token against a placeholder collateral, 86% LLTV. */
export const FIXTURE_PARAMS: MorphoMarketParams = {
  loanToken: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  collateralToken: "0x00000000000000000000000000000000000000c0",
  oracle: "0x000000000000000000000000000000000000000a",
  irm: "0x000000000000000000000000000000000000001a",
  lltv: "860000000000000000",
};

export const FIXTURE_MARKET_ID: string = marketIdOf(FIXTURE_PARAMS);

export { UnknownMorphoDeploymentError };
