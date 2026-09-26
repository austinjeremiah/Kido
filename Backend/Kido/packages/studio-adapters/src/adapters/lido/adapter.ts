import { decodeFunctionData, encodeFunctionData, getAddress, zeroAddress } from "viem";
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
import { lidoDeploymentFor, UnknownLidoDeploymentError } from "./deployments.js";

/**
 * Lido adapter.
 *
 * Staking is one payable call: `submit(referral)` on stETH, with the ETH as `msg.value`. That
 * makes it different from every other adapter here in two ways, and both are handled by name:
 *
 *   - the amount is the transaction VALUE, not a calldata argument. The decoder reads it from the
 *     prepared value and the validator refuses a value that disagrees with the intent;
 *   - the minted stETH goes to `msg.sender`. Under ContextLock the sender is the executor — the
 *     vault the user's funds sit in — so "self" means the vault. A transfer of stETH out of it is
 *     decoded (it is an ERC-20) precisely so it can be refused as a TRANSFER.
 *
 * Unstaking goes through Lido's withdrawal queue, a separate contract this adapter does not
 * construct against; it is out of scope rather than half-supported.
 */

const SEPOLIA = 11155111;

export class LidoError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "LidoError";
  }
}

export const STETH_ABI = [
  { type: "function", name: "submit", stateMutability: "payable", inputs: [{ name: "_referral", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "sharesOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getPooledEthByShares", stateMutability: "view", inputs: [{ name: "sharesAmount", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getTotalPooledEther", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isStakingPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  // ERC-20 moves, decoded so they can be refused.
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/* ───────────────────────────── normalized state ───────────────────────────── */

export interface RawLidoState {
  /** stETH balance of the account, wei. */
  balance: bigint;
  shares: bigint;
  /** ETH backing one full share (1e18 shares), wei. */
  pooledEthPerShare: bigint;
  stakingPaused: boolean;
  blockNumber: bigint;
  timestamp: number;
}

/* ─────────────────────────────── manifests ────────────────────────────────── */

const baseManifest = (over: Partial<ContextLockAdapterManifest>): ContextLockAdapterManifest =>
  ({
    schemaVersion: ADAPTER_MANIFEST_VERSION,
    version: "1.0.0",
    provider: "lido",
    supportedChains: [SEPOLIA, 1],
    inputSchema: {},
    outputSchema: {},
    permissionsRequired: [],
    executionPlacement: "studio-backend",
    auth: { mode: "none", requiredSecretNames: [], placement: "never-client" },
    documentation: {
      officialDocs: ["https://docs.lido.fi/", "https://docs.lido.fi/deployed-contracts/"],
      verifiedOn: "2026-09-11",
      notes: "stETH verified on Sepolia (0x3e3F…40Af) and mainnet (0xae7a…fE84) by name(). Staking is submit() with the ETH as value; stETH is minted to msg.sender, which under ContextLock is the executor vault.",
    },
    ...over,
  }) as ContextLockAdapterManifest;

export const lidoStateManifest = baseManifest({
  id: "lido-state",
  adapterType: "STATE_DATA",
  name: "Lido Staking State",
  description: "Reads an account's stETH balance and shares, the pool's ETH per share, and whether staking is paused.",
  capabilities: [
    { name: "STETH_BALANCE", description: "stETH balance, wei.", dataKind: "lido_steth_balance", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "SHARE_RATE", description: "ETH backing one full share, wei.", dataKind: "lido_share_rate", trustClass: "DIRECT_CHAIN_DATA" },
    { name: "STAKING_PAUSED", description: "Whether Lido's staking is paused (1 or 0).", dataKind: "lido_staking_paused", trustClass: "DIRECT_CHAIN_DATA" },
  ],
  trustClass: "DIRECT_CHAIN_DATA",
  freshnessSemantics: { kind: "block-height", typicalStalenessMs: 12_000, exposesBlockLag: false },
  safety: { decodesPreparedTransactions: false, supportsDryRun: true, allowsArbitraryTarget: false, allowsArbitraryRecipient: false, independentlyValidatesProviderOutput: true },
  generatedModules: [
    { path: "src/adapters/lido-state/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/lido-state/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["LIDO-HEALTHY", "LIDO-STAKING-PAUSED", "LIDO-STALE-STATE", "LIDO-RPC-FAILURE"],
  securityAssertions: [
    { id: "AS-LIDO-1", statement: "Lido state is DIRECT_CHAIN_DATA; the share rate is a protocol read, never a market price.", provenBy: ["LIDO-016"] },
  ],
});

export const lidoExecutionManifest = baseManifest({
  id: "lido-execution",
  adapterType: "EXECUTION",
  name: "Lido Staking Execution",
  description: "Constructs and independently validates a Lido stake (submit with value); decodes stETH transfer and approve to refuse them.",
  capabilities: [
    { name: "LIDO_STAKE", description: "Stake ETH for stETH, minted to the vault." },
    { name: "LIDO_TRANSFER", description: "Move stETH out of the vault. HIGH RISK — never permitted by default." },
  ],
  trustClass: "USER_UNTRUSTED",
  freshnessSemantics: { kind: "request-time", typicalStalenessMs: 0, exposesBlockLag: false },
  safety: { decodesPreparedTransactions: true, supportsDryRun: true, allowsArbitraryTarget: false, allowsArbitraryRecipient: false, independentlyValidatesProviderOutput: true },
  generatedModules: [
    { path: "src/adapters/lido-execution/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/lido-execution/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["LIDO-AUTO-STAKE", "LIDO-VALUE-MUTATION", "LIDO-REFERRAL-SET", "LIDO-TRANSFER-FORBIDDEN", "LIDO-APPROVE-FORBIDDEN", "LIDO-WRONG-TARGET"],
  securityAssertions: [
    { id: "AS-LIDOX-1", statement: "The staked amount is the transaction value and is checked against the intent; calldata carries no amount to lie about.", provenBy: ["LIDO-008"] },
    { id: "AS-LIDOX-2", statement: "Adapter capability is not agent authority: an stETH transfer or approve is decoded and refused.", provenBy: ["LIDO-011"] },
    { id: "AS-LIDOX-3", statement: "A non-zero referral is refused; nothing in a stake names a third party.", provenBy: ["LIDO-012"] },
  ],
});

export const LIDO_HIGH_RISK_ACTIONS = new Set(["LIDO_TRANSFER", "LIDO_APPROVE"]);

/* ─────────────────────────────── state adapter ────────────────────────────── */

export interface LidoStateQuery {
  account: string;
  dataKind?: string;
}

export class LidoStateAdapter implements DataAdapter<LidoStateQuery, RawLidoState> {
  constructor(private readonly reader?: (account: string) => Promise<RawLidoState>, private readonly maxAgeMs = 120_000) {}

  manifest(): ContextLockAdapterManifest {
    return lidoStateManifest;
  }

  validateQuery(query: unknown) {
    const q = query as LidoStateQuery;
    const problems: ValidationProblem[] = [];
    if (!q || typeof q.account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(q.account)) {
      problems.push({ code: "LIDO-QUERY-ACCOUNT", severity: "CRITICAL", field: "account", message: "account must be an address" });
    }
    return problems.length > 0 ? ({ ok: false, problems } as const) : ({ ok: true, query: q } as const);
  }

  async fetch(query: LidoStateQuery): Promise<RawLidoState> {
    if (!this.reader) throw new LidoError("LIDO-NO-READER", "no chain reader configured; refusing to fabricate a balance");
    return this.reader(query.account);
  }

  provenance(raw: RawLidoState, ctx: DataReadContext): DataObservation["provenance"] {
    const d = lidoDeploymentFor(ctx.chainId);
    return {
      provider: "lido", adapterId: lidoStateManifest.id, adapterVersion: lidoStateManifest.version, trustClass: "DIRECT_CHAIN_DATA",
      sourceTimestamp: new Date(raw.timestamp * 1000).toISOString(), freshnessMs: Math.max(0, ctx.nowMs - raw.timestamp * 1000),
      chainId: ctx.chainId, blockNumber: raw.blockNumber.toString(), feedId: d.steth, verification: { verified: false, mechanism: "direct-steth-read" },
    };
  }

  normalize(raw: RawLidoState, query: LidoStateQuery, ctx: DataReadContext): DataObservation {
    const kind = query.dataKind ?? "lido_steth_balance";
    const { value, unit, decimals } = ((): { value: string; unit: string; decimals: number } => {
      switch (kind) {
        case "lido_steth_balance": return { value: raw.balance.toString(), unit: "stETH", decimals: 18 };
        case "lido_share_rate": return { value: raw.pooledEthPerShare.toString(), unit: "ETH-per-share", decimals: 18 };
        case "lido_staking_paused": return { value: raw.stakingPaused ? "1" : "0", unit: "bool", decimals: 0 };
        default: throw new LidoError("LIDO-UNKNOWN-DATAKIND", `this adapter does not provide "${kind}"`);
      }
    })();
    return { observationId: `lido-${kind}-${getAddress(query.account)}-${raw.blockNumber}`, dataKind: kind, subject: getAddress(query.account), value, unit, decimals, observedAt: new Date(ctx.nowMs).toISOString(), provenance: this.provenance(raw, ctx) };
  }

  validate(observation: DataObservation): ValidationResult {
    const problems: ValidationProblem[] = [];
    const age = observation.provenance.freshnessMs;
    if (age === undefined || age > this.maxAgeMs) {
      problems.push({ code: "LIDO-STALE-STATE", severity: "CRITICAL", field: "timestamp", message: age === undefined ? "state carries no timestamp" : `state is ${Math.round(age / 1000)}s old, limit is ${Math.round(this.maxAgeMs / 1000)}s` });
    }
    if (!/^\d+$/.test(observation.value)) problems.push({ code: "LIDO-VALUE-SHAPE", severity: "CRITICAL", field: "value", message: "value must be integer base units" });
    return problems.length > 0 ? invalid(problems) : valid();
  }

  fixtureQuery(): LidoStateQuery {
    return { account: "0x0000000000000000000000000000000000005e1f", dataKind: "lido_steth_balance" };
  }

  createSimulationFixtures(): AdapterSimulationFixture[] {
    const now = Math.floor(Date.now() / 1000);
    const base = (over: Partial<RawLidoState> = {}): RawLidoState => ({
      balance: 3n * 10n ** 18n, shares: 25n * 10n ** 17n, pooledEthPerShare: 12n * 10n ** 17n, stakingPaused: false, blockNumber: 9_000_000n, timestamp: now - 10, ...over,
    });
    return [
      { scenarioId: "LIDO-HEALTHY", description: "A normal stETH balance and share rate.", providerResponse: base(), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "LIDO-STAKING-PAUSED", description: "Staking is paused; the reading is valid and says so.", providerResponse: base({ stakingPaused: true }), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "LIDO-STALE-STATE", description: "State read is older than the freshness bound.", providerResponse: base({ timestamp: now - 3_600 }), expected: { outcome: "REJECTED", reasonCodeMatches: "LIDO-STALE-STATE" } },
      { scenarioId: "LIDO-RPC-FAILURE", description: "stETH read fails.", providerResponse: null, expected: { outcome: "REJECTED", reasonCodeMatches: "LIDO-" } },
    ];
  }

  generateTemplateConfig() {
    const d = lidoDeploymentFor(SEPOLIA);
    return { adapterId: lidoStateManifest.id, steth: d.steth, maxStateAgeMs: this.maxAgeMs };
  }
}

/* ───────────────────────────── execution adapter ──────────────────────────── */

export type LidoActionKind = "LIDO_STAKE" | "LIDO_TRANSFER" | "LIDO_APPROVE";

export interface LidoIntent {
  action: LidoActionKind;
  chainId: number;
  /** The vault the stETH is minted to. Not in calldata: it is msg.sender. */
  account: string;
  /** Wei. */
  amount: string;
}

export interface LidoPrepared {
  to: string;
  data: string;
  value: string;
  chainId: number;
  summary: { action: string; account: string; amount: string };
}

export interface LidoConstraints extends ExecutionConstraints {
  permittedActions: LidoActionKind[];
}

export class LidoExecutionAdapter implements ExecutionAdapter<LidoIntent, LidoPrepared> {
  constructor(private readonly builder?: (i: LidoIntent) => LidoPrepared) {}

  manifest(): ContextLockAdapterManifest {
    return lidoExecutionManifest;
  }

  supportedActions(): string[] {
    return ["LIDO_STAKE", "LIDO_TRANSFER", "LIDO_APPROVE"];
  }

  normalizeIntent(intent: unknown) {
    const i = intent as LidoIntent;
    const problems: ValidationProblem[] = [];
    if (!i || !this.supportedActions().includes(i.action)) problems.push({ code: "LIDO-I0", severity: "CRITICAL", field: "action", message: `unsupported action "${i?.action}"` });
    if (typeof i?.account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(i.account)) problems.push({ code: "LIDO-I1", severity: "CRITICAL", field: "account", message: "account must be an address" });
    if (!/^\d+$/.test(String(i?.amount))) problems.push({ code: "LIDO-I3", severity: "CRITICAL", field: "amount", message: "amount must be integer wei" });
    else if (BigInt(i.amount) === 0n) problems.push({ code: "LIDO-I4", severity: "HIGH", field: "amount", message: "amount must be positive" });
    return problems.length > 0 ? ({ ok: false, problems } as const) : ({ ok: true, intent: i } as const);
  }

  async buildTransaction(intent: LidoIntent, ctx: AdapterExecutionContext): Promise<LidoPrepared> {
    if (this.builder) return this.builder(intent);
    const d = lidoDeploymentFor(intent.chainId);
    if (intent.action !== "LIDO_STAKE") throw new LidoError("LIDO-BUILD-FORBIDDEN", `${intent.action} is decoded so it can be refused; it is never constructed`);
    void ctx;
    return {
      to: d.steth,
      data: encodeFunctionData({ abi: STETH_ABI, functionName: "submit", args: [zeroAddress] }),
      value: intent.amount,
      chainId: intent.chainId,
      summary: { action: intent.action, account: intent.account, amount: intent.amount },
    };
  }

  async decodeTransaction(prepared: LidoPrepared): Promise<NormalizedAction> {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: STETH_ABI, data: prepared.data as `0x${string}` });
    } catch (e) {
      throw new LidoError("LIDO-NOT-STETH-CALL", `calldata is not an stETH call: ${(e as Error).message}`);
    }
    const args = decoded.args as readonly unknown[];
    const fn = decoded.functionName;
    const target = getAddress(prepared.to);
    switch (fn) {
      case "submit": {
        const referral = getAddress(args[0] as string);
        return {
          chainId: prepared.chainId, target, calldata: prepared.data, value: prepared.value, actionType: "LIDO_STAKE",
          // The ETH in is the transaction value; the stETH out is minted to the caller.
          inputs: [{ token: "ETH", amount: prepared.value }], outputs: [{ token: target, amount: prepared.value }],
          allowanceChanges: [], minOutputs: [],
          providerMetadata: { function: fn, summary: prepared.summary, referral, mintsTo: "msg.sender" },
        };
      }
      case "transfer": {
        const to = getAddress(args[0] as string);
        const amount = args[1] as bigint;
        return {
          chainId: prepared.chainId, target, calldata: prepared.data, value: prepared.value, actionType: "LIDO_TRANSFER",
          inputs: [], outputs: [{ token: target, amount: amount.toString(), to }], recipient: to,
          allowanceChanges: [], minOutputs: [], providerMetadata: { function: fn, summary: prepared.summary, receivesFunds: true },
        };
      }
      case "approve": {
        const spender = getAddress(args[0] as string);
        const amount = args[1] as bigint;
        return {
          chainId: prepared.chainId, target, calldata: prepared.data, value: prepared.value, actionType: "LIDO_APPROVE",
          inputs: [], outputs: [], spender,
          allowanceChanges: [{ token: target, spender, amount: amount.toString(), unlimited: amount >= (1n << 255n) }],
          minOutputs: [], providerMetadata: { function: fn, summary: prepared.summary },
        };
      }
      default:
        throw new LidoError("LIDO-UNSUPPORTED-FUNCTION", `stETH function "${fn}" is not decoded by this adapter; refusing to authorize a call it cannot fully read`);
    }
  }

  validateTransaction(n: NormalizedAction, intent: LidoIntent, c: ExecutionConstraints): ValidationResult {
    const problems: ValidationProblem[] = [];
    const P = (code: string, field: string, message: string, severity: ValidationProblem["severity"] = "CRITICAL") => problems.push({ code, severity, field, message });
    const permitted = (c as LidoConstraints).permittedActions ?? ["LIDO_STAKE"];
    const meta = n.providerMetadata as { referral?: string };

    if (!permitted.includes(n.actionType as LidoActionKind)) {
      P(LIDO_HIGH_RISK_ACTIONS.has(n.actionType) ? "LIDO-V-HIGH-RISK-ACTION" : "LIDO-V-ACTION-NOT-PERMITTED", "actionType", `decoded action ${n.actionType} is not in the Blueprint's permitted set (${permitted.join(", ")}); adapter capability is not agent authority`);
    }
    if (n.actionType !== intent.action) P("LIDO-V-ACTION-MISMATCH", "actionType", `decoded ${n.actionType} but the intent was ${intent.action}`);
    if (n.chainId !== c.chainId) P("LIDO-V-CHAIN", "chainId", `decoded chain ${n.chainId} != policy chain ${c.chainId}`);
    if (!c.allowedTargets.map((t) => t.toLowerCase()).includes(n.target.toLowerCase())) P("LIDO-V-TARGET", "target", `target ${n.target} is not the allow-listed stETH`);
    if (n.actionType === "LIDO_STAKE") {
      if (n.value !== intent.amount) P("LIDO-V-VALUE", "value", `transaction value ${n.value} does not match the intended stake ${intent.amount}`);
      if (meta.referral && meta.referral.toLowerCase() !== zeroAddress) P("LIDO-V-REFERRAL", "referral", `referral ${meta.referral} is set; a stake names no third party`);
      // stETH is minted to the caller, which is the vault. Self-only means the vault is the owner.
      if (c.allowedRecipients === "self-only" && intent.account.toLowerCase() !== c.owner.toLowerCase()) P("LIDO-V-BENEFICIARY-SELF", "recipient", `policy is self-only; the stake credits ${intent.account}, not ${c.owner}`);
    }
    for (const a of n.allowanceChanges) {
      if (a.unlimited && !c.allowUnlimitedApprovals) P("LIDO-V-UNLIMITED-APPROVAL", "allowanceChanges", `unlimited approval to ${a.spender} is not permitted`);
    }
    return problems.length > 0 ? invalid(problems) : valid();
  }

  fixtureConstraints(): LidoConstraints {
    const d = lidoDeploymentFor(SEPOLIA);
    return { chainId: SEPOLIA, allowedTargets: [d.steth], allowedRecipients: "self-only", owner: "0x0000000000000000000000000000000000005e1f", allowUnlimitedApprovals: false, maxQuoteAgeMs: 60_000, permittedActions: ["LIDO_STAKE"] };
  }

  fixtureIntent(): LidoIntent {
    return { action: "LIDO_STAKE", chainId: SEPOLIA, account: "0x0000000000000000000000000000000000005e1f", amount: (10n ** 18n).toString() };
  }

  createSimulationFixtures(): AdapterSimulationFixture[] {
    const d = lidoDeploymentFor(SEPOLIA);
    const owner = "0x0000000000000000000000000000000000005e1f";
    const attacker = "0x000000000000000000000000000000000000dEaD";
    const amount = 10n ** 18n;
    const mk = (data: string, value = amount, to = d.steth): LidoPrepared => ({ to, data, value: value.toString(), chainId: SEPOLIA, summary: { action: "LIDO_STAKE", account: owner, amount: amount.toString() } });
    const submit = (ref: string) => encodeFunctionData({ abi: STETH_ABI, functionName: "submit", args: [ref as `0x${string}`] });
    return [
      { scenarioId: "LIDO-AUTO-STAKE", description: "A stake whose value is exactly the intent.", providerResponse: mk(submit(zeroAddress)), expected: { outcome: "ACCEPTED" } },
      { scenarioId: "LIDO-VALUE-MUTATION", description: "The transaction value is inflated past the intended stake.", providerResponse: mk(submit(zeroAddress), 9n * 10n ** 18n), expected: { outcome: "REJECTED", reasonCodeMatches: "LIDO-V-VALUE" } },
      { scenarioId: "LIDO-REFERRAL-SET", description: "A referral address smuggled into the stake.", providerResponse: mk(submit(attacker)), expected: { outcome: "REJECTED", reasonCodeMatches: "LIDO-V-REFERRAL" } },
      { scenarioId: "LIDO-TRANSFER-FORBIDDEN", description: "stETH transferred out of the vault.", providerResponse: mk(encodeFunctionData({ abi: STETH_ABI, functionName: "transfer", args: [attacker, amount] }), 0n), expected: { outcome: "REJECTED", reasonCodeMatches: "LIDO-V-HIGH-RISK-ACTION" } },
      { scenarioId: "LIDO-APPROVE-FORBIDDEN", description: "An unlimited stETH approval.", providerResponse: mk(encodeFunctionData({ abi: STETH_ABI, functionName: "approve", args: [attacker, (1n << 256n) - 1n] }), 0n), expected: { outcome: "REJECTED", reasonCodeMatches: "LIDO-V-HIGH-RISK-ACTION" } },
      { scenarioId: "LIDO-WRONG-TARGET", description: "A submit sent to a contract other than the verified stETH.", providerResponse: mk(submit(zeroAddress), amount, attacker), expected: { outcome: "REJECTED", reasonCodeMatches: "LIDO-V-TARGET" } },
    ];
  }

  generateTemplateConfig() {
    const d = lidoDeploymentFor(SEPOLIA);
    return { adapterId: lidoExecutionManifest.id, steth: d.steth, highRiskActions: [...LIDO_HIGH_RISK_ACTIONS], defaultPermittedActions: ["LIDO_STAKE"] };
  }
}

export { UnknownLidoDeploymentError };
