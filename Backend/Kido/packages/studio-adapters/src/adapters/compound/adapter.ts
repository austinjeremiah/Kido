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
import { compoundDeploymentFor, UnknownCompoundMarketError } from "./deployments.js";

/**
 * Compound v3 (Comet) adapter.
 *
 * Comet has one base asset per market and everything else is collateral. Its calling convention is
 * the trap this adapter exists to handle: there is no `repay`. Supplying the base asset repays the
 * account's borrow; withdrawing the base asset when there is no balance IS a borrow. So a single
 * `supply` selector means two different things, and this adapter names them apart by the asset:
 *
 *   COMPOUND_REPAY   = supplyTo(account, baseToken, amount)
 *   COMPOUND_SUPPLY  = supplyTo(account, collateralAsset, amount)
 *   COMPOUND_WITHDRAW = withdrawTo(...)  — HIGH RISK, decoded so it can be refused; a withdraw of
 *                      the base asset is a borrow, and a withdraw of collateral removes it.
 *
 * `supplyTo` and `withdrawTo` are constructed rather than `supply`/`withdraw` so the beneficiary
 * is in the calldata and can be checked; the shorter forms credit `msg.sender`, which for a
 * ContextLock deployment is the executor, not the user.
 */

const SEPOLIA = 11155111;

export class CompoundError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "CompoundError";
  }
}

export const COMET_ABI = [
  { type: "function", name: "baseToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "borrowBalanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "collateralBalanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }, { name: "asset", type: "address" }], outputs: [{ type: "uint128" }] },
  { type: "function", name: "isLiquidatable", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "isBorrowCollateralized", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "supplyTo", stateMutability: "nonpayable", inputs: [{ name: "dst", type: "address" }, { name: "asset", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "supply", stateMutability: "nonpayable", inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  // NOTE: `to` RECEIVES FUNDS. Withdrawing the base asset past the balance is a borrow.
  { type: "function", name: "withdrawTo", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "asset", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;

/* ───────────────────────────── normalized position ────────────────────────── */

export interface RawCometPosition {
  /** Base-asset debt, in base token units (0 when the account is a supplier). */
  borrowBalance: bigint;
  /** Per-collateral balances, in each asset's own units. */
  collateral: Array<{ asset: string; balance: bigint; decimals: number }>;
  /** Collateral value in base-token units, from Comet's own price feeds (computed by the reader). */
  collateralValueBase: bigint;
  /** Weighted liquidation threshold across the collateral, bps. */
  liquidationThresholdBps: number;
  isLiquidatable: boolean;
  isBorrowCollateralized: boolean;
  blockNumber: bigint;
  timestamp: number;
}

export interface CometPosition {
  chainId: number;
  account: string;
  market: string;
  baseToken: string;
  borrowBalance: string;
  collateralValueBase: string;
  liquidationThresholdBps: number;
  isLiquidatable: boolean;
  isBorrowCollateralized: boolean;
  /** (collateralValue × LT) / borrow, WAD. NO_DEBT when there is no borrow. */
  healthFactor: { state: "NO_DEBT" } | { state: "KNOWN"; wad: bigint; bps: number };
  blockNumber: string;
  timestamp: number;
}

const WAD = 10n ** 18n;

export function normalizeCometPosition(raw: RawCometPosition, account: string, chainId: number): CometPosition {
  const d = compoundDeploymentFor(chainId);
  let healthFactor: CometPosition["healthFactor"] = { state: "NO_DEBT" };
  if (raw.borrowBalance > 0n) {
    const weighted = (raw.collateralValueBase * BigInt(raw.liquidationThresholdBps)) / 10_000n;
    const wad = (weighted * WAD) / raw.borrowBalance;
    healthFactor = { state: "KNOWN", wad, bps: Number((wad * 10_000n) / WAD) };
  }
  return {
    chainId, account: getAddress(account), market: d.market, baseToken: d.baseToken,
    borrowBalance: raw.borrowBalance.toString(), collateralValueBase: raw.collateralValueBase.toString(),
    liquidationThresholdBps: raw.liquidationThresholdBps, isLiquidatable: raw.isLiquidatable, isBorrowCollateralized: raw.isBorrowCollateralized,
    healthFactor, blockNumber: raw.blockNumber.toString(), timestamp: raw.timestamp,
  };
}

/* ─────────────────────────────── manifests ────────────────────────────────── */

const baseManifest = (over: Partial<ContextLockAdapterManifest>): ContextLockAdapterManifest =>
  ({
    schemaVersion: ADAPTER_MANIFEST_VERSION,
    version: "1.0.0",
    provider: "compound",
    supportedChains: [SEPOLIA, 1],
    inputSchema: {},
    outputSchema: {},
    permissionsRequired: [],
    executionPlacement: "studio-backend",
    auth: { mode: "none", requiredSecretNames: [], placement: "never-client" },
    documentation: {
      officialDocs: ["https://docs.compound.finance/", "https://docs.compound.finance/#networks"],
      verifiedOn: "2026-09-11",
      notes: "cUSDCv3 verified on Sepolia (0xAec1…0b6e) and mainnet (0xc3d6…cdc3) by baseToken(). Supplying the base asset repays; withdrawing it borrows. Only supplyTo/withdrawTo are constructed, so the beneficiary is in calldata.",
    },
    ...over,
  }) as ContextLockAdapterManifest;

export const compoundStateManifest = baseManifest({
  id: "compound-v3-state",
  adapterType: "STATE_DATA",
  name: "Compound v3 Position State",
  description: "Reads a normalized Compound v3 (Comet) position: base-asset debt, collateral value, and whether it is liquidatable.",
  capabilities: [
    { name: "ACCOUNT_POSITION", description: "Full normalized position in the market.", dataKind: "compound_account_position", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "HEALTH_FACTOR", description: "Weighted collateral over base debt, WAD.", dataKind: "compound_position_health_factor", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "BORROW_BALANCE", description: "Base-asset debt in base token units.", dataKind: "compound_borrow_balance", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "IS_LIQUIDATABLE", description: "Comet's own liquidatable flag (1 or 0).", dataKind: "compound_is_liquidatable", trustClass: "DIRECT_CHAIN_DATA" },
  ],
  trustClass: "DIRECT_CHAIN_DATA",
  freshnessSemantics: { kind: "block-height", typicalStalenessMs: 12_000, exposesBlockLag: false },
  safety: { decodesPreparedTransactions: false, supportsDryRun: true, allowsArbitraryTarget: false, allowsArbitraryRecipient: false, independentlyValidatesProviderOutput: true },
  generatedModules: [
    { path: "src/adapters/compound-v3-state/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/compound-v3-state/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["COMPOUND-HEALTHY", "COMPOUND-NEAR-LIQUIDATION", "COMPOUND-NO-DEBT", "COMPOUND-STALE-POSITION", "COMPOUND-RPC-FAILURE"],
  securityAssertions: [
    { id: "AS-COMPOUND-1", statement: "Health is computed from Comet's own balances and liquidation thresholds; raw integers never reach a comparison.", provenBy: ["COMPOUND-003"] },
    { id: "AS-COMPOUND-2", statement: "Compound position data is DIRECT_CHAIN_DATA and cannot satisfy a verified-oracle price requirement.", provenBy: ["COMPOUND-016"] },
  ],
});

export const compoundExecutionManifest = baseManifest({
  id: "compound-v3-execution",
  adapterType: "EXECUTION",
  name: "Compound v3 Execution",
  description: "Constructs and independently validates Compound v3 supplyTo for repay (base asset) and collateral; decodes withdrawTo to refuse it.",
  capabilities: [
    { name: "COMPOUND_REPAY", description: "Repay base-asset debt by supplying the base asset to the account." },
    { name: "COMPOUND_SUPPLY", description: "Add a collateral asset to the account." },
    { name: "COMPOUND_WITHDRAW", description: "Withdraw base or collateral. HIGH RISK — a base-asset withdraw is a borrow. Never permitted by default." },
  ],
  trustClass: "USER_UNTRUSTED",
  freshnessSemantics: { kind: "request-time", typicalStalenessMs: 0, exposesBlockLag: false },
  safety: { decodesPreparedTransactions: true, supportsDryRun: true, allowsArbitraryTarget: false, allowsArbitraryRecipient: false, independentlyValidatesProviderOutput: true },
  generatedModules: [
    { path: "src/adapters/compound-v3-execution/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/compound-v3-execution/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: [
    "COMPOUND-AUTO-REPAY", "COMPOUND-BENEFICIARY-MUTATION", "COMPOUND-AMOUNT-MUTATION", "COMPOUND-WRONG-ASSET",
    "COMPOUND-WITHDRAW-FORBIDDEN", "COMPOUND-BORROW-AS-WITHDRAW", "COMPOUND-WRONG-TARGET", "COMPOUND-SENDER-CREDITED",
  ],
  securityAssertions: [
    { id: "AS-COMPOUNDX-1", statement: "A substituted dst is rejected exactly like a swap recipient substitution.", provenBy: ["COMPOUND-010"] },
    { id: "AS-COMPOUNDX-2", statement: "Adapter capability is not agent authority: withdrawTo is refused unless explicitly permitted, and a base-asset withdraw is named as a borrow.", provenBy: ["COMPOUND-011"] },
    { id: "AS-COMPOUNDX-3", statement: "The two-argument supply/withdraw forms credit msg.sender and are refused: the beneficiary must be in calldata.", provenBy: ["COMPOUND-013"] },
  ],
});

export const COMPOUND_HIGH_RISK_ACTIONS = new Set(["COMPOUND_WITHDRAW"]);

/* ─────────────────────────────── state adapter ────────────────────────────── */

export interface CompoundStateQuery {
  account: string;
  dataKind?: string;
}

export class CompoundStateAdapter implements DataAdapter<CompoundStateQuery, RawCometPosition> {
  constructor(private readonly reader?: (account: string) => Promise<RawCometPosition>, private readonly maxAgeMs = 120_000) {}

  manifest(): ContextLockAdapterManifest {
    return compoundStateManifest;
  }

  validateQuery(query: unknown) {
    const q = query as CompoundStateQuery;
    const problems: ValidationProblem[] = [];
    if (!q || typeof q.account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(q.account)) {
      problems.push({ code: "COMPOUND-QUERY-ACCOUNT", severity: "CRITICAL", field: "account", message: "account must be an address" });
    }
    return problems.length > 0 ? ({ ok: false, problems } as const) : ({ ok: true, query: q } as const);
  }

  async fetch(query: CompoundStateQuery): Promise<RawCometPosition> {
    if (!this.reader) throw new CompoundError("COMPOUND-NO-READER", "no chain reader configured; refusing to fabricate a position");
    return this.reader(query.account);
  }

  provenance(raw: RawCometPosition, ctx: DataReadContext): DataObservation["provenance"] {
    const d = compoundDeploymentFor(ctx.chainId);
    return {
      provider: "compound", adapterId: compoundStateManifest.id, adapterVersion: compoundStateManifest.version, trustClass: "DIRECT_CHAIN_DATA",
      sourceTimestamp: new Date(raw.timestamp * 1000).toISOString(), freshnessMs: Math.max(0, ctx.nowMs - raw.timestamp * 1000),
      chainId: ctx.chainId, blockNumber: raw.blockNumber.toString(), feedId: d.comet, verification: { verified: false, mechanism: "direct-comet-read" },
    };
  }

  normalize(raw: RawCometPosition, query: CompoundStateQuery, ctx: DataReadContext): DataObservation {
    const p = normalizeCometPosition(raw, query.account, ctx.chainId);
    const d = compoundDeploymentFor(ctx.chainId);
    const kind = query.dataKind ?? "compound_position_health_factor";
    const { value, unit, decimals } = ((): { value: string; unit: string; decimals: number } => {
      switch (kind) {
        case "compound_position_health_factor":
          return p.healthFactor.state === "NO_DEBT" ? { value: ((1n << 256n) - 1n).toString(), unit: "wad-no-debt", decimals: 18 } : { value: p.healthFactor.wad.toString(), unit: "wad", decimals: 18 };
        case "compound_borrow_balance":
        case "compound_account_position":
          return { value: p.borrowBalance, unit: d.baseTokenSymbol, decimals: d.baseTokenDecimals };
        case "compound_is_liquidatable":
          return { value: p.isLiquidatable ? "1" : "0", unit: "bool", decimals: 0 };
        default:
          throw new CompoundError("COMPOUND-UNKNOWN-DATAKIND", `this adapter does not provide "${kind}"`);
      }
    })();
    return { observationId: `compound-${kind}-${p.account}-${p.blockNumber}`, dataKind: kind, subject: p.account, value, unit, decimals, observedAt: new Date(ctx.nowMs).toISOString(), provenance: this.provenance(raw, ctx) };
  }

  validate(observation: DataObservation): ValidationResult {
    const problems: ValidationProblem[] = [];
    const age = observation.provenance.freshnessMs;
    if (age === undefined || age > this.maxAgeMs) {
      problems.push({ code: "COMPOUND-STALE-POSITION", severity: "CRITICAL", field: "timestamp", message: age === undefined ? "position carries no timestamp" : `position is ${Math.round(age / 1000)}s old, limit is ${Math.round(this.maxAgeMs / 1000)}s` });
    }
    if (!/^\d+$/.test(observation.value)) problems.push({ code: "COMPOUND-VALUE-SHAPE", severity: "CRITICAL", field: "value", message: "value must be integer base units" });
    return problems.length > 0 ? invalid(problems) : valid();
  }

  fixtureQuery(): CompoundStateQuery {
    return { account: "0x0000000000000000000000000000000000005e1f", dataKind: "compound_position_health_factor" };
  }

  createSimulationFixtures(): AdapterSimulationFixture[] {
    const now = Math.floor(Date.now() / 1000);
    const base = (over: Partial<RawCometPosition> = {}): RawCometPosition => ({
      borrowBalance: 2_000_000_000n,
      collateral: [{ asset: "0x00000000000000000000000000000000000000c0", balance: 2n * 10n ** 18n, decimals: 18 }],
      collateralValueBase: 4_800_000_000n,
      liquidationThresholdBps: 8_500,
      isLiquidatable: false,
      isBorrowCollateralized: true,
      blockNumber: 9_000_000n,
      timestamp: now - 10,
      ...over,
    });
    return [
      { scenarioId: "COMPOUND-HEALTHY", description: "Collateral comfortably covers the borrow.", providerResponse: base(), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "COMPOUND-NEAR-LIQUIDATION", description: "Borrow close to the liquidation threshold but the reading is valid.", providerResponse: base({ borrowBalance: 3_900_000_000n }), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "COMPOUND-NO-DEBT", description: "No borrow: health is NO_DEBT, not a number.", providerResponse: base({ borrowBalance: 0n }), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "COMPOUND-STALE-POSITION", description: "Position read is older than the freshness bound.", providerResponse: base({ timestamp: now - 3_600 }), expected: { outcome: "REJECTED", reasonCodeMatches: "COMPOUND-STALE-POSITION" } },
      { scenarioId: "COMPOUND-RPC-FAILURE", description: "Comet read fails.", providerResponse: null, expected: { outcome: "REJECTED", reasonCodeMatches: "COMPOUND-" } },
    ];
  }

  generateTemplateConfig() {
    const d = compoundDeploymentFor(SEPOLIA);
    return { adapterId: compoundStateManifest.id, comet: d.comet, market: d.market, baseToken: d.baseToken, baseTokenDecimals: d.baseTokenDecimals, healthFactorDecimals: 18, maxPositionAgeMs: this.maxAgeMs };
  }
}

/* ───────────────────────────── execution adapter ──────────────────────────── */

export type CompoundActionKind = "COMPOUND_REPAY" | "COMPOUND_SUPPLY" | "COMPOUND_WITHDRAW";

export interface CompoundIntent {
  action: CompoundActionKind;
  chainId: number;
  /** The position owner: `dst` for a supply, `to` for a withdraw. */
  account: string;
  asset: string;
  amount: string;
}

export interface CompoundPrepared {
  to: string;
  data: string;
  value: string;
  chainId: number;
  summary: { action: string; account: string; amount: string };
}

export interface CompoundConstraints extends ExecutionConstraints {
  permittedActions: CompoundActionKind[];
}

export class CompoundExecutionAdapter implements ExecutionAdapter<CompoundIntent, CompoundPrepared> {
  constructor(private readonly builder?: (i: CompoundIntent) => CompoundPrepared) {}

  manifest(): ContextLockAdapterManifest {
    return compoundExecutionManifest;
  }

  supportedActions(): string[] {
    return ["COMPOUND_REPAY", "COMPOUND_SUPPLY", "COMPOUND_WITHDRAW"];
  }

  normalizeIntent(intent: unknown) {
    const i = intent as CompoundIntent;
    const problems: ValidationProblem[] = [];
    const addr = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
    if (!i || !this.supportedActions().includes(i.action)) problems.push({ code: "COMPOUND-I0", severity: "CRITICAL", field: "action", message: `unsupported action "${i?.action}"` });
    if (!addr(i?.account)) problems.push({ code: "COMPOUND-I1", severity: "CRITICAL", field: "account", message: "account must be an address" });
    if (!addr(i?.asset)) problems.push({ code: "COMPOUND-I2", severity: "CRITICAL", field: "asset", message: "asset must be an address" });
    if (!/^\d+$/.test(String(i?.amount))) problems.push({ code: "COMPOUND-I3", severity: "CRITICAL", field: "amount", message: "amount must be integer base units" });
    else if (BigInt(i.amount) === 0n) problems.push({ code: "COMPOUND-I4", severity: "HIGH", field: "amount", message: "amount must be positive" });
    if (i?.action === "COMPOUND_REPAY" && addr(i.asset)) {
      try {
        const d = compoundDeploymentFor(i.chainId);
        if (i.asset.toLowerCase() !== d.baseToken.toLowerCase()) problems.push({ code: "COMPOUND-I5", severity: "CRITICAL", field: "asset", message: `a repay supplies the market's base asset ${d.baseToken}; ${i.asset} is not it` });
      } catch { /* the chain problem is reported by buildTransaction */ }
    }
    return problems.length > 0 ? ({ ok: false, problems } as const) : ({ ok: true, intent: i } as const);
  }

  async buildTransaction(intent: CompoundIntent, ctx: AdapterExecutionContext): Promise<CompoundPrepared> {
    if (this.builder) return this.builder(intent);
    const d = compoundDeploymentFor(intent.chainId);
    const account = getAddress(intent.account);
    const asset = getAddress(intent.asset);
    const amount = BigInt(intent.amount);
    const data = intent.action === "COMPOUND_WITHDRAW"
      ? encodeFunctionData({ abi: COMET_ABI, functionName: "withdrawTo", args: [account, asset, amount] })
      : encodeFunctionData({ abi: COMET_ABI, functionName: "supplyTo", args: [account, asset, amount] });
    void ctx;
    return { to: d.comet, data, value: "0", chainId: intent.chainId, summary: { action: intent.action, account: intent.account, amount: intent.amount } };
  }

  async decodeTransaction(prepared: CompoundPrepared): Promise<NormalizedAction> {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: COMET_ABI, data: prepared.data as `0x${string}` });
    } catch (e) {
      throw new CompoundError("COMPOUND-NOT-COMET-CALL", `calldata is not a Comet call: ${(e as Error).message}`);
    }
    const args = decoded.args as readonly unknown[];
    const fn = decoded.functionName;
    let base: string | null = null;
    try { base = compoundDeploymentFor(prepared.chainId).baseToken.toLowerCase(); } catch { base = null; }

    let actionType: CompoundActionKind;
    let beneficiary: string | undefined;
    let asset: string;
    let amount: bigint;
    let receivesFunds = false;
    let creditsSender = false;
    switch (fn) {
      case "supplyTo":
        beneficiary = getAddress(args[0] as string); asset = getAddress(args[1] as string); amount = args[2] as bigint;
        actionType = base !== null && asset.toLowerCase() === base ? "COMPOUND_REPAY" : "COMPOUND_SUPPLY";
        break;
      case "supply":
        // Credits msg.sender — the executor — never the user. Decoded so it is refused by name.
        asset = getAddress(args[0] as string); amount = args[1] as bigint; creditsSender = true;
        actionType = base !== null && asset.toLowerCase() === base ? "COMPOUND_REPAY" : "COMPOUND_SUPPLY";
        break;
      case "withdrawTo":
        beneficiary = getAddress(args[0] as string); asset = getAddress(args[1] as string); amount = args[2] as bigint; receivesFunds = true; actionType = "COMPOUND_WITHDRAW";
        break;
      case "withdraw":
        asset = getAddress(args[0] as string); amount = args[1] as bigint; receivesFunds = true; creditsSender = true; actionType = "COMPOUND_WITHDRAW";
        break;
      default:
        throw new CompoundError("COMPOUND-UNSUPPORTED-FUNCTION", `Comet function "${fn}" is not decoded by this adapter; refusing to authorize a call it cannot fully read`);
    }
    const flow = { token: asset, amount: amount.toString(), ...(beneficiary ? { to: beneficiary } : {}) };
    return {
      chainId: prepared.chainId, target: getAddress(prepared.to), calldata: prepared.data, value: prepared.value, actionType,
      inputs: receivesFunds ? [] : [flow], outputs: receivesFunds ? [flow] : [],
      ...(beneficiary ? { recipient: beneficiary } : {}),
      allowanceChanges: [], minOutputs: [],
      providerMetadata: { function: fn, summary: prepared.summary, receivesFunds, creditsSender, isBaseAsset: base !== null && asset.toLowerCase() === base },
    };
  }

  validateTransaction(n: NormalizedAction, intent: CompoundIntent, c: ExecutionConstraints): ValidationResult {
    const problems: ValidationProblem[] = [];
    const P = (code: string, field: string, message: string, severity: ValidationProblem["severity"] = "CRITICAL") => problems.push({ code, severity, field, message });
    const permitted = (c as CompoundConstraints).permittedActions ?? ["COMPOUND_REPAY", "COMPOUND_SUPPLY"];
    const meta = n.providerMetadata as { creditsSender?: boolean; isBaseAsset?: boolean };

    if (!permitted.includes(n.actionType as CompoundActionKind)) {
      const isBorrow = n.actionType === "COMPOUND_WITHDRAW" && meta.isBaseAsset;
      P(COMPOUND_HIGH_RISK_ACTIONS.has(n.actionType) ? "COMPOUND-V-HIGH-RISK-ACTION" : "COMPOUND-V-ACTION-NOT-PERMITTED", "actionType", `decoded action ${n.actionType}${isBorrow ? " (a base-asset withdraw is a BORROW)" : ""} is not in the Blueprint's permitted set (${permitted.join(", ")}); adapter capability is not agent authority`);
    }
    if (n.actionType !== intent.action) P("COMPOUND-V-ACTION-MISMATCH", "actionType", `decoded ${n.actionType} but the intent was ${intent.action}`);
    if (n.chainId !== c.chainId) P("COMPOUND-V-CHAIN", "chainId", `decoded chain ${n.chainId} != policy chain ${c.chainId}`);
    if (!c.allowedTargets.map((t) => t.toLowerCase()).includes(n.target.toLowerCase())) P("COMPOUND-V-TARGET", "target", `target ${n.target} is not the allow-listed Comet`);
    if (meta.creditsSender) P("COMPOUND-V-SENDER-CREDITED", "recipient", "the two-argument form credits msg.sender (the executor), not the user; only supplyTo/withdrawTo are accepted");

    const flow = n.inputs[0] ?? n.outputs[0];
    if (!flow) P("COMPOUND-V-NO-FLOW", "inputs", "no asset flow could be decoded");
    else {
      if (flow.token.toLowerCase() !== intent.asset.toLowerCase()) P("COMPOUND-V-ASSET", "asset", `decoded asset ${flow.token} does not match the intended ${intent.asset}`);
      if (flow.amount !== intent.amount) P("COMPOUND-V-AMOUNT", "amount", `decoded amount ${flow.amount} does not match the intended ${intent.amount}`);
    }
    const dst = (n.recipient ?? "").toLowerCase();
    if (!meta.creditsSender) {
      if (!dst) P("COMPOUND-V-NO-BENEFICIARY", "recipient", "no beneficiary could be decoded");
      else {
        if (dst !== intent.account.toLowerCase()) P("COMPOUND-V-BENEFICIARY", "recipient", `decoded beneficiary ${n.recipient} does not match the intended ${intent.account}`);
        if (c.allowedRecipients === "self-only" && dst !== c.owner.toLowerCase()) P("COMPOUND-V-BENEFICIARY-SELF", "recipient", `policy is self-only; decoded ${n.recipient}`);
      }
    }
    return problems.length > 0 ? invalid(problems) : valid();
  }

  fixtureConstraints(): CompoundConstraints {
    const d = compoundDeploymentFor(SEPOLIA);
    return { chainId: SEPOLIA, allowedTargets: [d.comet], allowedRecipients: "self-only", owner: "0x0000000000000000000000000000000000005e1f", allowUnlimitedApprovals: false, maxQuoteAgeMs: 60_000, permittedActions: ["COMPOUND_REPAY", "COMPOUND_SUPPLY"] };
  }

  fixtureIntent(): CompoundIntent {
    const d = compoundDeploymentFor(SEPOLIA);
    return { action: "COMPOUND_REPAY", chainId: SEPOLIA, account: "0x0000000000000000000000000000000000005e1f", asset: d.baseToken, amount: "500000000" };
  }

  createSimulationFixtures(): AdapterSimulationFixture[] {
    const d = compoundDeploymentFor(SEPOLIA);
    const owner = "0x0000000000000000000000000000000000005e1f";
    const attacker = "0x000000000000000000000000000000000000dEaD";
    const other = "0x00000000000000000000000000000000000000bb";
    const amount = 500_000_000n;
    const mk = (data: string, to = d.comet): CompoundPrepared => ({ to, data, value: "0", chainId: SEPOLIA, summary: { action: "COMPOUND_REPAY", account: owner, amount: amount.toString() } });
    const enc = (fn: "supplyTo" | "supply" | "withdrawTo" | "withdraw", args: readonly unknown[]) => encodeFunctionData({ abi: COMET_ABI, functionName: fn, args: args as never });
    return [
      { scenarioId: "COMPOUND-AUTO-REPAY", description: "A base-asset supplyTo that decodes to exactly the intent.", providerResponse: mk(enc("supplyTo", [owner, d.baseToken, amount])), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "COMPOUND-BENEFICIARY-MUTATION", description: "Repay credited to an attacker's account.", providerResponse: mk(enc("supplyTo", [attacker, d.baseToken, amount])), expected: { outcome: "REJECTED", reasonCodeMatches: "COMPOUND-V-BENEFICIARY" } },
      { scenarioId: "COMPOUND-AMOUNT-MUTATION", description: "Amount inflated in the calldata.", providerResponse: mk(enc("supplyTo", [owner, d.baseToken, 9_999_999_999n])), expected: { outcome: "REJECTED", reasonCodeMatches: "COMPOUND-V-AMOUNT" } },
      { scenarioId: "COMPOUND-WRONG-ASSET", description: "A repay intent constructed as a supply of another asset.", providerResponse: mk(enc("supplyTo", [owner, other, amount])), expected: { outcome: "REJECTED", reasonCodeMatches: "COMPOUND-V-A" } },
      { scenarioId: "COMPOUND-WITHDRAW-FORBIDDEN", description: "A collateral withdrawal the Blueprint never permitted.", providerResponse: mk(enc("withdrawTo", [owner, other, amount])), expected: { outcome: "REJECTED", reasonCodeMatches: "COMPOUND-V-HIGH-RISK-ACTION" } },
      { scenarioId: "COMPOUND-BORROW-AS-WITHDRAW", description: "A base-asset withdraw — which is a borrow — never permitted.", providerResponse: mk(enc("withdrawTo", [owner, d.baseToken, amount])), expected: { outcome: "REJECTED", reasonCodeMatches: "COMPOUND-V-HIGH-RISK-ACTION" } },
      { scenarioId: "COMPOUND-WRONG-TARGET", description: "Transaction targets a contract other than the verified Comet.", providerResponse: mk(enc("supplyTo", [owner, d.baseToken, amount]), attacker), expected: { outcome: "REJECTED", reasonCodeMatches: "COMPOUND-V-TARGET" } },
      { scenarioId: "COMPOUND-SENDER-CREDITED", description: "The two-argument supply, which credits the executor rather than the user.", providerResponse: mk(enc("supply", [d.baseToken, amount])), expected: { outcome: "REJECTED", reasonCodeMatches: "COMPOUND-V-SENDER-CREDITED" } },
    ];
  }

  generateTemplateConfig() {
    const d = compoundDeploymentFor(SEPOLIA);
    return { adapterId: compoundExecutionManifest.id, comet: d.comet, market: d.market, baseToken: d.baseToken, highRiskActions: [...COMPOUND_HIGH_RISK_ACTIONS], defaultPermittedActions: ["COMPOUND_REPAY", "COMPOUND_SUPPLY"] };
  }
}

export { UnknownCompoundMarketError };
