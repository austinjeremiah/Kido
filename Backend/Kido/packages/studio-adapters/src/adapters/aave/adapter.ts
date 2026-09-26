import { decodeFunctionData, encodeFunctionData, getAddress } from "viem";
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
import { aaveDeploymentFor, UnknownAaveMarketError } from "./deployments.js";
import {
  BASE_DECIMALS,
  NO_DEBT_SENTINEL,
  compareHealthFactor,
  normalizeHealthFactor,
  type HealthFactor,
} from "./units.js";

/**
 * Aave v3 adapter.
 *
 * Two adapters registered from one implementation, because state and execution carry different
 * risk and the kernel keeps them apart deliberately: reading a position reports a number, and
 * repaying a debt moves money. Merging them would give a reporting agent an execution surface it
 * never asked for.
 *
 * The rule this adapter exists to demonstrate:
 *
 *     adapter capability  !=  agent authority
 *
 * This adapter can construct WITHDRAW and BORROW. That is not permission to execute them. Both are
 * declared high-risk, are absent from the default permitted set, and are refused by
 * `validateTransaction` unless the Blueprint's constraints explicitly allow them.
 */

const SEPOLIA = 11155111;

export class AaveError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "AaveError";
  }
}

/* ────────────────────────────────── ABI ───────────────────────────────────── */

export const AAVE_POOL_ABI = [
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "repay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      // NOTE: `to`, not `onBehalfOf`. This one RECEIVES FUNDS.
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "borrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setUserUseReserveAsCollateral",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "useAsCollateral", type: "bool" },
    ],
    outputs: [],
  },
] as const;

/** Stable-rate borrowing is deprecated across v3 markets; variable is the only mode constructed. */
export const INTEREST_RATE_MODE_VARIABLE = 2n;
export const INTEREST_RATE_MODE_STABLE = 1n;

/* ───────────────────────────── normalized position ────────────────────────── */

export interface RawAccountData {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  currentLiquidationThreshold: bigint;
  ltv: bigint;
  healthFactor: bigint;
  blockNumber: bigint;
  timestamp: number;
}

export interface AavePosition {
  chainId: number;
  account: string;
  protocolMajor: 3;
  market: string;
  /** USD, 8 decimals. Never mixed with the WAD health factor. */
  totalCollateralBase: string;
  totalDebtBase: string;
  availableBorrowsBase: string;
  baseCurrency: "USD";
  baseCurrencyDecimals: number;
  liquidationThresholdBps: number;
  ltvBps: number;
  healthFactor: HealthFactor;
  blockNumber: string;
  timestamp: number;
}

export function normalizeAccountData(raw: RawAccountData, account: string, chainId: number): AavePosition {
  const d = aaveDeploymentFor(chainId);
  /*
   * Every value is converted here and nowhere else. The tuple carries USD at 8 decimals, basis
   * points, and a WAD health factor simultaneously — a fourteen-order-of-magnitude difference
   * between two fields of the same return value (FND-V2-009).
   */
  return {
    chainId,
    account: getAddress(account),
    protocolMajor: 3,
    market: d.market,
    totalCollateralBase: raw.totalCollateralBase.toString(),
    totalDebtBase: raw.totalDebtBase.toString(),
    availableBorrowsBase: raw.availableBorrowsBase.toString(),
    baseCurrency: "USD",
    baseCurrencyDecimals: BASE_DECIMALS,
    liquidationThresholdBps: Number(raw.currentLiquidationThreshold),
    ltvBps: Number(raw.ltv),
    healthFactor: normalizeHealthFactor(raw.healthFactor),
    blockNumber: raw.blockNumber.toString(),
    timestamp: raw.timestamp,
  };
}

/* ─────────────────────────────── manifests ────────────────────────────────── */

const baseManifest = (over: Partial<ContextLockAdapterManifest>): ContextLockAdapterManifest =>
  ({
    schemaVersion: ADAPTER_MANIFEST_VERSION,
    version: "1.0.0",
    provider: "aave",
    supportedChains: [SEPOLIA],
    inputSchema: {},
    outputSchema: {},
    permissionsRequired: [],
    executionPlacement: "studio-backend",
    auth: { mode: "none", requiredSecretNames: [], placement: "never-client" },
    documentation: {
      officialDocs: ["https://aave.com/docs", "https://aave.com/docs/developers/smart-contracts/pool"],
      verifiedOn: "2026-09-08",
      notes:
        "Sepolia Pool 0x6Ae4…8951 verified on-chain (POOL_REVISION 1); siblings derived from its own addresses provider. Health factor is WAD; base values are USD at 8 decimals; no-debt returns 2**256-1. See FND-V2-009.",
    },
    ...over,
  }) as ContextLockAdapterManifest;

export const aaveStateManifest = baseManifest({
  id: "aave-v3-state",
  adapterType: "STATE_DATA",
  name: "Aave v3 Position State",
  description: "Reads a normalized Aave v3 lending position: collateral, debt, borrowing power and health factor.",
  capabilities: [
    { name: "ACCOUNT_POSITION", description: "Full normalized lending position.", dataKind: "aave_account_position", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "HEALTH_FACTOR", description: "Normalized health factor.", dataKind: "aave_position_health_factor", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "TOTAL_COLLATERAL", description: "Total collateral in USD base units.", dataKind: "aave_total_collateral_usd", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "TOTAL_DEBT", description: "Total debt in USD base units.", dataKind: "aave_total_debt_usd", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "AVAILABLE_BORROW", description: "Remaining borrowing power in USD base units.", dataKind: "aave_available_borrows_usd", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "RESERVE_STATE", description: "Market-level reserve configuration.", dataKind: "aave_reserve_state", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "USER_RESERVE_STATE", description: "Per-user reserve position.", dataKind: "aave_user_reserve_state", trustClass: "DIRECT_CHAIN_DATA" },
  ],
  /*
   * DIRECT_CHAIN_DATA, not VERIFIED_ORACLE.
   *
   * Aave answers "what is my position". It does NOT answer "what is ETH worth right now" — the
   * `*Base` values are denominated using Aave's own oracle at read time, and routing a market price
   * through whichever provider happens to expose a number is exactly the smuggling P16.5 forbids.
   */
  trustClass: "DIRECT_CHAIN_DATA",
  freshnessSemantics: { kind: "block-height", typicalStalenessMs: 12_000, exposesBlockLag: false },
  safety: {
    decodesPreparedTransactions: false,
    supportsDryRun: true,
    allowsArbitraryTarget: false,
    allowsArbitraryRecipient: false,
    independentlyValidatesProviderOutput: true,
  },
  generatedModules: [
    { path: "src/adapters/aave-v3-state/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/aave-v3-state/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["AAVE-HEALTHY", "AAVE-HF-DROP", "AAVE-STALE-POSITION", "AAVE-NO-DEBT", "AAVE-RPC-FAILURE"],
  securityAssertions: [
    { id: "AS-AAVE-1", statement: "Health factor is normalized from WAD; raw protocol integers never reach a comparison.", provenBy: ["AAVE-003"] },
    { id: "AS-AAVE-2", statement: "The no-debt sentinel is a named state, not a large number.", provenBy: ["AAVE-003"] },
    { id: "AS-AAVE-3", statement: "Aave position data is DIRECT_CHAIN_DATA and cannot satisfy a verified-oracle price requirement.", provenBy: ["AAVE-016"] },
  ],
});

export const aaveExecutionManifest = baseManifest({
  id: "aave-v3-execution",
  adapterType: "EXECUTION",
  name: "Aave v3 Execution",
  description: "Constructs and independently validates Aave v3 supply, repay, withdraw and borrow actions.",
  capabilities: [
    { name: "SUPPLY", description: "Supply an asset as collateral." },
    { name: "REPAY", description: "Repay outstanding debt." },
    // Declared so the adapter can DECODE them — including in a transaction it did not build.
    // Declaring is not permitting; see HIGH_RISK_ACTIONS below.
    { name: "WITHDRAW", description: "Withdraw supplied collateral. HIGH RISK — never permitted by default." },
    { name: "BORROW", description: "Borrow against collateral. HIGH RISK — never permitted by default." },
    { name: "SET_COLLATERAL", description: "Toggle an asset's collateral use. HIGH RISK — never permitted by default." },
  ],
  trustClass: "USER_UNTRUSTED",
  freshnessSemantics: { kind: "request-time", typicalStalenessMs: 0, exposesBlockLag: false },
  safety: {
    decodesPreparedTransactions: true,
    supportsDryRun: true,
    allowsArbitraryTarget: false,
    allowsArbitraryRecipient: false,
    independentlyValidatesProviderOutput: true,
  },
  generatedModules: [
    { path: "src/adapters/aave-v3-execution/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/aave-v3-execution/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: [
    "AAVE-AUTO-REPAY",
    "AAVE-BENEFICIARY-MUTATION",
    "AAVE-AMOUNT-MUTATION",
    "AAVE-WITHDRAW-FORBIDDEN",
    "AAVE-BORROW-FORBIDDEN",
    "AAVE-APPROVAL-MUTATION",
    "AAVE-WRONG-ASSET",
    "AAVE-STABLE-RATE-MODE",
  ],
  securityAssertions: [
    { id: "AS-AAVEX-1", statement: "A substituted onBehalfOf is rejected exactly like a swap recipient substitution.", provenBy: ["AAVE-010"] },
    { id: "AS-AAVEX-2", statement: "Adapter capability is not agent authority: withdraw and borrow are refused unless explicitly permitted.", provenBy: ["AAVE-011", "AAVE-012", "AAVE-017"] },
    { id: "AS-AAVEX-3", statement: "Calldata is decoded independently; the caller's description is never read.", provenBy: ["AAVE-007"] },
  ],
});

/**
 * Actions that move value OUT of the user's position.
 *
 * Kept as data rather than as branches so the rule is one comparison in one place. Supporting an
 * action and permitting it are different things, and this list is what keeps them different.
 */
export const HIGH_RISK_ACTIONS = new Set(["WITHDRAW", "BORROW", "SET_COLLATERAL"]);

/* ─────────────────────────────── state adapter ────────────────────────────── */

export interface AaveStateQuery {
  account: string;
  dataKind?: string;
}

export class AaveStateAdapter implements DataAdapter<AaveStateQuery, RawAccountData> {
  constructor(
    private readonly reader?: (account: string) => Promise<RawAccountData>,
    /** Positions older than this are refused; a lending position moves with every block. */
    private readonly maxAgeMs = 120_000,
  ) {}

  manifest(): ContextLockAdapterManifest {
    return aaveStateManifest;
  }

  validateQuery(query: unknown) {
    const q = query as AaveStateQuery;
    const problems: ValidationProblem[] = [];
    if (!q || typeof q.account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(q.account)) {
      problems.push({ code: "AAVE-QUERY-ACCOUNT", severity: "CRITICAL", field: "account", message: "account must be an address" });
    }
    return problems.length > 0 ? ({ ok: false, problems } as const) : ({ ok: true, query: q } as const);
  }

  async fetch(query: AaveStateQuery): Promise<RawAccountData> {
    if (!this.reader) {
      throw new AaveError("AAVE-NO-READER", "no chain reader configured; refusing to fabricate a position");
    }
    return this.reader(query.account);
  }

  provenance(raw: RawAccountData, ctx: DataReadContext): DataObservation["provenance"] {
    const d = aaveDeploymentFor(ctx.chainId);
    return {
      provider: "aave",
      adapterId: aaveStateManifest.id,
      adapterVersion: aaveStateManifest.version,
      trustClass: "DIRECT_CHAIN_DATA",
      sourceTimestamp: new Date(raw.timestamp * 1000).toISOString(),
      freshnessMs: Math.max(0, ctx.nowMs - raw.timestamp * 1000),
      chainId: ctx.chainId,
      blockNumber: raw.blockNumber.toString(),
      feedId: d.pool,
      verification: { verified: false, mechanism: "direct-pool-read" },
    };
  }

  normalize(raw: RawAccountData, query: AaveStateQuery, ctx: DataReadContext): DataObservation {
    const position = normalizeAccountData(raw, query.account, ctx.chainId);
    const kind = query.dataKind ?? "aave_position_health_factor";

    /*
     * The value depends on which capability was asked for, and each carries its OWN unit. Returning
     * a health factor labelled with a USD unit — or the reverse — is the fourteen-order-of-magnitude
     * error FND-V2-009 describes, expressed as a labelling mistake instead of an arithmetic one.
     */
    const { value, unit, decimals } = ((): { value: string; unit: string; decimals: number } => {
      switch (kind) {
        case "aave_position_health_factor":
          return position.healthFactor.state === "NO_DEBT"
            ? { value: NO_DEBT_SENTINEL.toString(), unit: "wad-no-debt", decimals: 18 }
            : { value: position.healthFactor.wad.toString(), unit: "wad", decimals: 18 };
        case "aave_total_collateral_usd":
          return { value: position.totalCollateralBase, unit: "USD", decimals: BASE_DECIMALS };
        case "aave_total_debt_usd":
          return { value: position.totalDebtBase, unit: "USD", decimals: BASE_DECIMALS };
        case "aave_available_borrows_usd":
          return { value: position.availableBorrowsBase, unit: "USD", decimals: BASE_DECIMALS };
        case "aave_account_position":
          return { value: position.totalDebtBase, unit: "USD", decimals: BASE_DECIMALS };
        default:
          throw new AaveError("AAVE-UNKNOWN-DATAKIND", `this adapter does not provide "${kind}"`);
      }
    })();

    return {
      observationId: `aave-${kind}-${position.account}-${position.blockNumber}`,
      dataKind: kind,
      subject: position.account,
      value,
      unit,
      decimals,
      observedAt: new Date(ctx.nowMs).toISOString(),
      provenance: this.provenance(raw, ctx),
    };
  }

  validate(observation: DataObservation): ValidationResult {
    const problems: ValidationProblem[] = [];
    const age = observation.provenance.freshnessMs;
    if (age === undefined || age > this.maxAgeMs) {
      problems.push({
        code: "AAVE-STALE-POSITION",
        severity: "CRITICAL",
        field: "timestamp",
        message:
          age === undefined
            ? "position carries no timestamp"
            : `position is ${Math.round(age / 1000)}s old, limit is ${Math.round(this.maxAgeMs / 1000)}s; a lending position moves every block`,
      });
    }
    if (!/^\d+$/.test(observation.value)) {
      problems.push({ code: "AAVE-VALUE-SHAPE", severity: "CRITICAL", field: "value", message: "value must be integer base units" });
    }
    return problems.length > 0 ? invalid(problems) : valid();
  }

  fixtureQuery(): AaveStateQuery {
    return { account: "0x0000000000000000000000000000000000005e1f", dataKind: "aave_position_health_factor" };
  }

  createSimulationFixtures(): AdapterSimulationFixture[] {
    const now = Math.floor(Date.now() / 1000);
    const base = (over: Partial<RawAccountData> = {}): RawAccountData => ({
      totalCollateralBase: 500_000_000_000n,
      totalDebtBase: 200_000_000_000n,
      availableBorrowsBase: 100_000_000_000n,
      currentLiquidationThreshold: 8_250n,
      ltv: 8_000n,
      healthFactor: 2_060_000_000_000_000_000n,
      blockNumber: 9_000_000n,
      timestamp: now - 10,
      ...over,
    });
    return [
      { scenarioId: "AAVE-HEALTHY", description: "Position comfortably above the floor.", providerResponse: base(), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "AAVE-HF-DROP", description: "Health factor drops below the floor but the reading is valid.", providerResponse: base({ healthFactor: 1_300_000_000_000_000_000n }), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "AAVE-NO-DEBT", description: "No debt: the protocol returns 2**256-1.", providerResponse: base({ totalDebtBase: 0n, healthFactor: NO_DEBT_SENTINEL }), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "AAVE-STALE-POSITION", description: "Position read is far older than the freshness bound.", providerResponse: base({ timestamp: now - 3_600 }), expected: { outcome: "REJECTED", reasonCodeMatches: "AAVE-STALE-POSITION" } },
      { scenarioId: "AAVE-RPC-FAILURE", description: "Pool read fails.", providerResponse: null, expected: { outcome: "REJECTED", reasonCodeMatches: "AAVE-" } },
    ];
  }

  generateTemplateConfig() {
    const d = aaveDeploymentFor(SEPOLIA);
    return {
      adapterId: aaveStateManifest.id,
      pool: d.pool,
      protocolMajor: d.protocolMajor,
      market: d.market,
      baseCurrency: d.baseCurrency,
      baseCurrencyDecimals: d.baseCurrencyDecimals,
      healthFactorDecimals: 18,
      maxPositionAgeMs: this.maxAgeMs,
    };
  }
}

/* ───────────────────────────── execution adapter ──────────────────────────── */

export type AaveActionKind = "SUPPLY" | "REPAY" | "WITHDRAW" | "BORROW" | "SET_COLLATERAL";

export interface AaveIntent {
  action: AaveActionKind;
  chainId: number;
  /** The position owner. For supply/repay this is `onBehalfOf`; for withdraw it is `to`. */
  account: string;
  asset: string;
  amount: string;
  interestRateMode?: 1 | 2;
}

export interface AavePrepared {
  to: string;
  data: string;
  value: string;
  chainId: number;
  /** What the builder CLAIMS. Present because a real integration has it; never read by decode. */
  summary: { action: string; account: string; amount: string };
}

/** Aave-specific constraints, layered on the generic execution constraints. */
export interface AaveConstraints extends ExecutionConstraints {
  /** Actions the BLUEPRINT permits. Absent from this set means refused, whatever the adapter can do. */
  permittedActions: AaveActionKind[];
}

export class AaveExecutionAdapter implements ExecutionAdapter<AaveIntent, AavePrepared> {
  constructor(private readonly builder?: (i: AaveIntent) => AavePrepared) {}

  manifest(): ContextLockAdapterManifest {
    return aaveExecutionManifest;
  }

  supportedActions(): string[] {
    return ["SUPPLY", "REPAY", "WITHDRAW", "BORROW", "SET_COLLATERAL"];
  }

  normalizeIntent(intent: unknown) {
    const i = intent as AaveIntent;
    const problems: ValidationProblem[] = [];
    const addr = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

    if (!i || !this.supportedActions().includes(i.action)) {
      problems.push({ code: "AAVE-I0", severity: "CRITICAL", field: "action", message: `unsupported action "${i?.action}"` });
    }
    if (!addr(i?.account)) problems.push({ code: "AAVE-I1", severity: "CRITICAL", field: "account", message: "account must be an address" });
    if (!addr(i?.asset)) problems.push({ code: "AAVE-I2", severity: "CRITICAL", field: "asset", message: "asset must be an address" });
    if (!/^\d+$/.test(String(i?.amount))) {
      problems.push({ code: "AAVE-I3", severity: "CRITICAL", field: "amount", message: "amount must be integer base units" });
    } else if (BigInt(i.amount) === 0n) {
      problems.push({ code: "AAVE-I4", severity: "HIGH", field: "amount", message: "amount must be positive" });
    }
    if (i?.interestRateMode === 1) {
      // Stable-rate borrowing is deprecated across v3 markets. Passing it through would build a
      // transaction that reverts, or worse, succeeds on a market where it still exists.
      problems.push({ code: "AAVE-I5", severity: "HIGH", field: "interestRateMode", message: "stable rate mode is deprecated; use variable (2)" });
    }
    return problems.length > 0 ? ({ ok: false, problems } as const) : ({ ok: true, intent: i } as const);
  }

  async buildTransaction(intent: AaveIntent, ctx: AdapterExecutionContext): Promise<AavePrepared> {
    if (this.builder) return this.builder(intent);
    const d = aaveDeploymentFor(intent.chainId);
    const mode = BigInt(intent.interestRateMode ?? 2);
    const asset = getAddress(intent.asset);
    const account = getAddress(intent.account);
    const amount = BigInt(intent.amount);

    const data = ((): string => {
      switch (intent.action) {
        case "SUPPLY":
          return encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "supply", args: [asset, amount, account, 0] });
        case "REPAY":
          return encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "repay", args: [asset, amount, mode, account] });
        case "WITHDRAW":
          return encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "withdraw", args: [asset, amount, account] });
        case "BORROW":
          return encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "borrow", args: [asset, amount, mode, 0, account] });
        case "SET_COLLATERAL":
          return encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "setUserUseReserveAsCollateral", args: [asset, true] });
      }
    })();

    void ctx;
    return {
      to: d.pool,
      data,
      value: "0",
      chainId: intent.chainId,
      summary: { action: intent.action, account: intent.account, amount: intent.amount },
    };
  }

  /**
   * Decode from the calldata.
   *
   * `summary` is in scope and never read — the same discipline as the Uniswap adapter, for the same
   * reason: the party that built the transaction is the party describing it.
   *
   * The `to` / `onBehalfOf` asymmetry is handled explicitly. `withdraw(asset, amount, to)` sends
   * funds to `to`; `supply`/`repay` credit `onBehalfOf`. They sit in different argument positions
   * and mean different things, and conflating them is how a supply-on-behalf becomes a withdrawal
   * elsewhere.
   */
  async decodeTransaction(prepared: AavePrepared): Promise<NormalizedAction> {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: AAVE_POOL_ABI, data: prepared.data as `0x${string}` });
    } catch (e) {
      throw new AaveError("AAVE-NOT-POOL-CALL", `calldata is not an Aave Pool call: ${(e as Error).message}`);
    }

    const args = decoded.args as readonly unknown[];
    const fn = decoded.functionName;

    let actionType: AaveActionKind;
    let asset: string;
    let amount: bigint;
    let beneficiary: string | undefined;
    let receivesFunds = false;
    let interestRateMode: bigint | undefined;

    switch (fn) {
      case "supply":
        actionType = "SUPPLY";
        [asset, amount, beneficiary] = [getAddress(args[0] as string), args[1] as bigint, getAddress(args[2] as string)];
        break;
      case "repay":
        actionType = "REPAY";
        [asset, amount, interestRateMode, beneficiary] = [
          getAddress(args[0] as string), args[1] as bigint, args[2] as bigint, getAddress(args[3] as string),
        ];
        break;
      case "withdraw":
        actionType = "WITHDRAW";
        [asset, amount, beneficiary] = [getAddress(args[0] as string), args[1] as bigint, getAddress(args[2] as string)];
        // `to` RECEIVES the funds. This flag is what makes the recipient check apply.
        receivesFunds = true;
        break;
      case "borrow":
        actionType = "BORROW";
        [asset, amount, interestRateMode, beneficiary] = [
          getAddress(args[0] as string), args[1] as bigint, args[2] as bigint, getAddress(args[4] as string),
        ];
        receivesFunds = true;
        break;
      case "setUserUseReserveAsCollateral":
        actionType = "SET_COLLATERAL";
        asset = getAddress(args[0] as string);
        amount = 0n;
        break;
      default:
        throw new AaveError("AAVE-UNSUPPORTED-FUNCTION", `Pool function "${fn}" is not decoded by this adapter; refusing to authorize a call it cannot fully read`);
    }

    return {
      chainId: prepared.chainId,
      target: getAddress(prepared.to),
      calldata: prepared.data,
      value: prepared.value,
      actionType,
      inputs: receivesFunds ? [] : [{ token: asset, amount: amount.toString(), ...(beneficiary ? { to: beneficiary } : {}) }],
      outputs: receivesFunds ? [{ token: asset, amount: amount.toString(), ...(beneficiary ? { to: beneficiary } : {}) }] : [],
      ...(beneficiary ? { recipient: beneficiary } : {}),
      allowanceChanges: [],
      minOutputs: [],
      providerMetadata: {
        function: fn,
        summary: prepared.summary,
        receivesFunds,
        ...(interestRateMode !== undefined ? { interestRateMode: interestRateMode.toString() } : {}),
      },
    };
  }

  validateTransaction(n: NormalizedAction, intent: AaveIntent, c: ExecutionConstraints): ValidationResult {
    const problems: ValidationProblem[] = [];
    const P = (code: string, field: string, message: string, severity: ValidationProblem["severity"] = "CRITICAL") =>
      problems.push({ code, severity, field, message });

    const permitted = (c as AaveConstraints).permittedActions ?? ["SUPPLY", "REPAY"];

    /*
     * The invariant this adapter exists to demonstrate.
     *
     * The adapter can construct and decode WITHDRAW and BORROW. That is a decoding capability, not a
     * grant. If the Blueprint does not name the action, it is refused — and refused HERE, on the
     * DECODED action, so a transaction that arrived claiming to be a repay is judged on what it
     * actually is.
     */
    if (!permitted.includes(n.actionType as AaveActionKind)) {
      P(
        HIGH_RISK_ACTIONS.has(n.actionType) ? "AAVE-V-HIGH-RISK-ACTION" : "AAVE-V-ACTION-NOT-PERMITTED",
        "actionType",
        `decoded action ${n.actionType} is not in the Blueprint's permitted set (${permitted.join(", ")}); adapter capability is not agent authority`,
      );
    }

    if (n.actionType !== intent.action) {
      P("AAVE-V-ACTION-MISMATCH", "actionType", `decoded ${n.actionType} but the intent was ${intent.action}`);
    }
    if (n.chainId !== c.chainId) {
      P("AAVE-V-CHAIN", "chainId", `decoded chain ${n.chainId} != policy chain ${c.chainId}`);
    }
    if (!c.allowedTargets.map((t) => t.toLowerCase()).includes(n.target.toLowerCase())) {
      P("AAVE-V-POOL", "target", `target ${n.target} is not the allow-listed Pool`);
    }

    const flow = n.inputs[0] ?? n.outputs[0];
    if (!flow) {
      if (n.actionType !== "SET_COLLATERAL") P("AAVE-V-NO-FLOW", "inputs", "no asset flow could be decoded");
    } else {
      if (flow.token.toLowerCase() !== intent.asset.toLowerCase()) {
        P("AAVE-V-ASSET", "asset", `decoded asset ${flow.token} does not match the intended ${intent.asset}`);
      }
      if (flow.amount !== intent.amount) {
        P("AAVE-V-AMOUNT", "amount", `decoded amount ${flow.amount} does not match the intended ${intent.amount}`);
      }
    }

    /*
     * Beneficiary. The Aave equivalent of a swap recipient substitution, and just as damaging: a
     * repay credited to someone else's position pays their debt with the user's funds.
     */
    const decodedBeneficiary = (n.recipient ?? "").toLowerCase();
    if (n.actionType !== "SET_COLLATERAL") {
      if (!decodedBeneficiary) {
        P("AAVE-V-NO-BENEFICIARY", "recipient", "no beneficiary could be decoded");
      } else {
        if (decodedBeneficiary !== intent.account.toLowerCase()) {
          P("AAVE-V-BENEFICIARY", "recipient", `decoded beneficiary ${n.recipient} does not match the intended ${intent.account}`);
        }
        if (c.allowedRecipients === "self-only" && decodedBeneficiary !== c.owner.toLowerCase()) {
          P("AAVE-V-BENEFICIARY-SELF", "recipient", `policy is self-only; decoded ${n.recipient}`);
        } else if (Array.isArray(c.allowedRecipients) && !c.allowedRecipients.map((r) => r.toLowerCase()).includes(decodedBeneficiary)) {
          P("AAVE-V-BENEFICIARY-ALLOW", "recipient", `decoded beneficiary ${n.recipient} is not allow-listed`);
        }
      }
    }

    const mode = (n.providerMetadata as { interestRateMode?: string }).interestRateMode;
    if (mode !== undefined && mode !== INTEREST_RATE_MODE_VARIABLE.toString()) {
      P("AAVE-V-RATE-MODE", "interestRateMode", `decoded interest rate mode ${mode}; only variable (2) is constructed`, "HIGH");
    }

    for (const a of n.allowanceChanges) {
      if (a.unlimited && !c.allowUnlimitedApprovals) {
        P("AAVE-V-UNLIMITED-APPROVAL", "allowanceChanges", `unlimited approval to ${a.spender} is not permitted`);
      }
      if (c.maxApprovalAmount && BigInt(a.amount) > BigInt(c.maxApprovalAmount)) {
        P("AAVE-V-APPROVAL-SIZE", "allowanceChanges", `approval ${a.amount} exceeds the cap ${c.maxApprovalAmount}`);
      }
      if (a.spender.toLowerCase() !== n.target.toLowerCase()) {
        P("AAVE-V-APPROVAL-SPENDER", "allowanceChanges", `approval spender ${a.spender} is not the Pool`);
      }
    }

    return problems.length > 0 ? invalid(problems) : valid();
  }

  /** Constraints the fixtures are judged under: repay and supply only. */
  fixtureConstraints(): AaveConstraints {
    const d = aaveDeploymentFor(SEPOLIA);
    return {
      chainId: SEPOLIA,
      allowedTargets: [d.pool],
      allowedRecipients: "self-only",
      owner: "0x0000000000000000000000000000000000005e1f",
      allowUnlimitedApprovals: false,
      maxQuoteAgeMs: 60_000,
      permittedActions: ["SUPPLY", "REPAY"],
    };
  }

  fixtureIntent(): AaveIntent {
    return {
      action: "REPAY",
      chainId: SEPOLIA,
      account: "0x0000000000000000000000000000000000005e1f",
      asset: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      amount: "500000000",
      interestRateMode: 2,
    };
  }

  createSimulationFixtures(): AdapterSimulationFixture[] {
    const d = aaveDeploymentFor(SEPOLIA);
    const owner = "0x0000000000000000000000000000000000005e1f";
    const attacker = "0x000000000000000000000000000000000000dEaD";
    const asset = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
    const other = "0x00000000000000000000000000000000000000bb";
    const amount = 500_000_000n;

    const mk = (data: string, to = d.pool): AavePrepared => ({
      to,
      data,
      value: "0",
      chainId: SEPOLIA,
      // Always the honest summary. If any validation read it, every attack fixture would pass.
      summary: { action: "REPAY", account: owner, amount: amount.toString() },
    });
    const enc = (fn: "supply" | "repay" | "withdraw" | "borrow", args: readonly unknown[]) =>
      encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: fn, args: args as never });

    return [
      { scenarioId: "AAVE-AUTO-REPAY", description: "A repay that decodes to exactly the intent.", providerResponse: mk(enc("repay", [asset, amount, 2n, owner])), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "AAVE-BENEFICIARY-MUTATION", description: "Repay credited to an attacker's position instead.", providerResponse: mk(enc("repay", [asset, amount, 2n, attacker])), expected: { outcome: "REJECTED", reasonCodeMatches: "AAVE-V-BENEFICIARY" } },
      { scenarioId: "AAVE-AMOUNT-MUTATION", description: "Repay amount inflated in the calldata.", providerResponse: mk(enc("repay", [asset, 9_999_999_999n, 2n, owner])), expected: { outcome: "REJECTED", reasonCodeMatches: "AAVE-V-AMOUNT" } },
      { scenarioId: "AAVE-WRONG-ASSET", description: "Repay constructed against a different asset.", providerResponse: mk(enc("repay", [other, amount, 2n, owner])), expected: { outcome: "REJECTED", reasonCodeMatches: "AAVE-V-ASSET" } },
      { scenarioId: "AAVE-WITHDRAW-FORBIDDEN", description: "A withdrawal the adapter can build and the Blueprint never permitted.", providerResponse: mk(enc("withdraw", [asset, amount, owner])), expected: { outcome: "REJECTED", reasonCodeMatches: "AAVE-V-HIGH-RISK-ACTION" } },
      { scenarioId: "AAVE-BORROW-FORBIDDEN", description: "A borrow the adapter can build and the Blueprint never permitted.", providerResponse: mk(enc("borrow", [asset, amount, 2n, 0, owner])), expected: { outcome: "REJECTED", reasonCodeMatches: "AAVE-V-HIGH-RISK-ACTION" } },
      { scenarioId: "AAVE-STABLE-RATE-MODE", description: "Repay built with the deprecated stable rate mode.", providerResponse: mk(enc("repay", [asset, amount, 1n, owner])), expected: { outcome: "REJECTED", reasonCodeMatches: "AAVE-V-RATE-MODE" } },
      { scenarioId: "AAVE-APPROVAL-MUTATION", description: "Transaction targets a contract other than the verified Pool.", providerResponse: mk(enc("repay", [asset, amount, 2n, owner]), attacker), expected: { outcome: "REJECTED", reasonCodeMatches: "AAVE-V-POOL" } },
    ];
  }

  generateTemplateConfig() {
    const d = aaveDeploymentFor(SEPOLIA);
    return {
      adapterId: aaveExecutionManifest.id,
      pool: d.pool,
      protocolMajor: d.protocolMajor,
      market: d.market,
      interestRateMode: Number(INTEREST_RATE_MODE_VARIABLE),
      // Recorded so a reader of the generated project can see what was NOT granted.
      highRiskActions: [...HIGH_RISK_ACTIONS],
      defaultPermittedActions: ["SUPPLY", "REPAY"],
    };
  }
}

export { UnknownAaveMarketError };
