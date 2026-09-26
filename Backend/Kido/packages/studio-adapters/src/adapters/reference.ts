import type { ContextLockAdapterManifest } from "../core/manifest.js";
import { ADAPTER_MANIFEST_VERSION } from "../core/manifest.js";
import type {
  AdapterExecutionContext,
  AdapterSimulationFixture,
  DataAdapter,
  DataReadContext,
  ExecutionAdapter,
  ExecutionConstraints,
  NormalizedAction,
  ValidationProblem,
  ValidationResult,
} from "../core/contracts.js";
import { invalid, valid } from "../core/contracts.js";
import type { DataObservation } from "../core/observation.js";

/**
 * Reference adapters.
 *
 * These are not stubs standing in for real providers — they are the kernel's own conformance
 * fixtures. They exercise every rule the registry, resolver and validator enforce, using fully
 * deterministic data, so the kernel can be proven correct without a network call or an API key.
 *
 * They also serve as the worked example a new adapter is written against. Everything a real
 * provider adapter must do, these do.
 */

const SEPOLIA = 11155111;

/* ───────────────────────── reference oracle (VERIFIED) ────────────────────── */

export const referenceOracleManifest: ContextLockAdapterManifest = {
  schemaVersion: ADAPTER_MANIFEST_VERSION,
  id: "reference-oracle",
  version: "1.0.0",
  adapterType: "VERIFIED_MARKET_DATA",
  name: "Reference Verified Oracle",
  description: "Deterministic verified-oracle fixture used to conformance-test the adapter kernel.",
  provider: "contextlock-reference",
  supportedChains: [SEPOLIA],
  capabilities: [
    {
      name: "PRICE_READ",
      description: "Read a USD reference price for an asset.",
      dataKind: "collateral_asset_usd_price",
      trustClass: "VERIFIED_ORACLE",
    },
    {
      name: "ETH_USD",
      description: "Read the ETH/USD reference price.",
      dataKind: "eth_usd_price",
      trustClass: "VERIFIED_ORACLE",
    },
  ],
  inputSchema: { asset: "string" },
  outputSchema: { value: "string", decimals: "number", updatedAt: "string" },
  trustClass: "VERIFIED_ORACLE",
  freshnessSemantics: { kind: "source-timestamp", typicalStalenessMs: 3_000, exposesBlockLag: false },
  auth: { mode: "none", requiredSecretNames: [], placement: "never-client" },
  permissionsRequired: [],
  executionPlacement: "studio-backend",
  safety: {
    decodesPreparedTransactions: false,
    supportsDryRun: true,
    allowsArbitraryTarget: false,
    allowsArbitraryRecipient: false,
    independentlyValidatesProviderOutput: true,
  },
  generatedModules: [
    { path: "src/adapters/reference-oracle/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/reference-oracle/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["REF-ORACLE-NORMAL", "REF-ORACLE-STALE"],
  securityAssertions: [
    { id: "AS-REFORACLE-1", statement: "Every observation carries a source timestamp.", provenBy: ["ADAPTER-008"] },
    { id: "AS-REFORACLE-2", statement: "Stale readings are rejected, not returned.", provenBy: ["ADAPTER-007"] },
  ],
  documentation: {
    officialDocs: ["https://docs.chain.link/data-feeds"],
    verifiedOn: "2026-09-08",
    notes: "Reference fixture. Not a live provider.",
  },
};

interface RefPriceQuery {
  asset: string;
  /** Injected so tests can drive staleness deterministically. */
  ageMs?: number;
}

export class ReferenceOracleAdapter implements DataAdapter<RefPriceQuery, { value: string; ageMs: number }> {
  manifest(): ContextLockAdapterManifest {
    return referenceOracleManifest;
  }

  validateQuery(query: unknown) {
    const q = query as RefPriceQuery;
    const problems: ValidationProblem[] = [];
    if (!q || typeof q.asset !== "string" || q.asset.length === 0) {
      problems.push({ code: "REF-Q1", severity: "HIGH", field: "asset", message: "asset is required" });
    }
    return problems.length > 0 ? ({ ok: false, problems } as const) : ({ ok: true, query: q } as const);
  }

  async fetch(query: RefPriceQuery): Promise<{ value: string; ageMs: number }> {
    return { value: "302144000000", ageMs: query.ageMs ?? 1_200 };
  }

  provenance(raw: { ageMs: number }, ctx: DataReadContext): DataObservation["provenance"] {
    return {
      provider: "contextlock-reference",
      adapterId: referenceOracleManifest.id,
      adapterVersion: referenceOracleManifest.version,
      trustClass: "VERIFIED_ORACLE",
      sourceTimestamp: new Date(ctx.nowMs - raw.ageMs).toISOString(),
      freshnessMs: raw.ageMs,
      chainId: ctx.chainId,
      feedId: "REF/USD",
      verification: { verified: true, mechanism: "reference-fixture" },
    };
  }

  normalize(raw: { value: string; ageMs: number }, query: RefPriceQuery, ctx: DataReadContext): DataObservation {
    return {
      observationId: `ref-oracle-${query.asset}-${ctx.nowMs}`,
      dataKind: "collateral_asset_usd_price",
      subject: query.asset,
      value: raw.value,
      unit: "USD",
      decimals: 8,
      observedAt: new Date(ctx.nowMs).toISOString(),
      provenance: this.provenance(raw, ctx),
    };
  }

  validate(observation: DataObservation): ValidationResult {
    if (observation.decimals !== 8) {
      return invalid([
        { code: "REF-V1", severity: "CRITICAL", field: "decimals", message: "expected 8 decimals" },
      ]);
    }
    if (!/^\d+$/.test(observation.value)) {
      return invalid([
        { code: "REF-V2", severity: "CRITICAL", field: "value", message: "value must be integer base units" },
      ]);
    }
    return valid();
  }

  createSimulationFixtures(): AdapterSimulationFixture[] {
    return [
      {
        scenarioId: "REF-ORACLE-NORMAL",
        description: "Fresh verified reading.",
        providerResponse: { value: "302144000000", ageMs: 1_200 },
        expected: { outcome: "ACCEPTED" },
      },
      {
        scenarioId: "REF-ORACLE-STALE",
        description: "Reading far outside the freshness bound.",
        providerResponse: { value: "302144000000", ageMs: 600_000 },
        expected: { outcome: "REJECTED", reasonCodeMatches: "STALE" },
      },
    ];
  }

  fixtureQuery(): RefPriceQuery {
    return { asset: "ETH" };
  }

  generateTemplateConfig() {
    return { adapterId: referenceOracleManifest.id, decimals: 8, unit: "USD" };
  }
}

/* ────────────────── reference chain reader (DIRECT_CHAIN_DATA) ────────────── */

export const referenceChainReaderManifest: ContextLockAdapterManifest = {
  ...referenceOracleManifest,
  id: "reference-chain-reader",
  adapterType: "STATE_DATA",
  name: "Reference Chain Reader",
  description: "Deterministic direct-chain-read fixture used to conformance-test the adapter kernel.",
  capabilities: [
    {
      name: "POSITION_READ",
      description: "Read a lending position's health factor.",
      dataKind: "aave_position_health_factor",
      trustClass: "DIRECT_CHAIN_DATA",
    },
  ],
  trustClass: "DIRECT_CHAIN_DATA",
  freshnessSemantics: { kind: "block-height", typicalStalenessMs: 12_000, exposesBlockLag: false },
  generatedModules: [
    { path: "src/adapters/reference-chain-reader/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/reference-chain-reader/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["REF-CHAIN-NORMAL"],
  securityAssertions: [
    { id: "AS-REFCHAIN-1", statement: "Chain reads are labelled DIRECT_CHAIN_DATA, never oracle-grade.", provenBy: ["ADAPTER-006"] },
  ],
};

export class ReferenceChainReaderAdapter implements DataAdapter<{ account: string; ageMs?: number }, { hf: string; ageMs: number }> {
  manifest(): ContextLockAdapterManifest {
    return referenceChainReaderManifest;
  }
  validateQuery(query: unknown) {
    const q = query as { account: string; ageMs?: number };
    if (!q || typeof q.account !== "string") {
      const problems: ValidationProblem[] = [
        { code: "REF-Q2", severity: "HIGH", field: "account", message: "account is required" },
      ];
      return { ok: false, problems } as const;
    }
    return { ok: true, query: q } as const;
  }
  async fetch(query: { account: string; ageMs?: number }) {
    return { hf: "18000", ageMs: query.ageMs ?? 8_000 };
  }
  provenance(raw: { ageMs: number }, ctx: DataReadContext): DataObservation["provenance"] {
    return {
      provider: "contextlock-reference",
      adapterId: referenceChainReaderManifest.id,
      adapterVersion: referenceChainReaderManifest.version,
      trustClass: "DIRECT_CHAIN_DATA",
      sourceTimestamp: new Date(ctx.nowMs - raw.ageMs).toISOString(),
      freshnessMs: raw.ageMs,
      chainId: ctx.chainId,
      blockNumber: "9000000",
      verification: { verified: false, mechanism: "single-rpc" },
    };
  }
  normalize(raw: { hf: string; ageMs: number }, query: { account: string }, ctx: DataReadContext): DataObservation {
    return {
      observationId: `ref-chain-${query.account}-${ctx.nowMs}`,
      dataKind: "aave_position_health_factor",
      subject: query.account,
      value: raw.hf,
      unit: "bps",
      decimals: 0,
      observedAt: new Date(ctx.nowMs).toISOString(),
      provenance: this.provenance(raw, ctx),
    };
  }
  validate(): ValidationResult {
    return valid();
  }
  createSimulationFixtures(): AdapterSimulationFixture[] {
    return [
      {
        scenarioId: "REF-CHAIN-NORMAL",
        description: "Healthy position read directly from a node.",
        providerResponse: { hf: "18000", ageMs: 8_000 },
        expected: { outcome: "ACCEPTED" },
      },
    ];
  }
  fixtureQuery() {
    return { account: "0x0000000000000000000000000000000000005e1f" };
  }

  generateTemplateConfig() {
    return { adapterId: referenceChainReaderManifest.id, unit: "bps" };
  }
}

/* ────────────────────── reference execution adapter ───────────────────────── */

export const referenceExecutionManifest: ContextLockAdapterManifest = {
  schemaVersion: ADAPTER_MANIFEST_VERSION,
  id: "reference-execution",
  version: "1.0.0",
  adapterType: "EXECUTION",
  name: "Reference Execution Adapter",
  description: "Deterministic execution fixture proving provider output is decoded before it is trusted.",
  provider: "contextlock-reference",
  supportedChains: [SEPOLIA],
  capabilities: [{ name: "TRANSFER", description: "Move an exact amount to an allowed recipient." }],
  inputSchema: { token: "string", amount: "string", recipient: "string" },
  outputSchema: { target: "string", calldata: "string" },
  trustClass: "USER_UNTRUSTED",
  freshnessSemantics: { kind: "request-time", typicalStalenessMs: 0, exposesBlockLag: false },
  auth: { mode: "none", requiredSecretNames: [], placement: "never-client" },
  permissionsRequired: [],
  executionPlacement: "studio-backend",
  safety: {
    decodesPreparedTransactions: true,
    supportsDryRun: true,
    allowsArbitraryTarget: false,
    allowsArbitraryRecipient: false,
    independentlyValidatesProviderOutput: true,
  },
  generatedModules: [
    { path: "src/adapters/reference-execution/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/reference-execution/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["REF-EXEC-NORMAL", "REF-EXEC-RECIPIENT-SWAP"],
  securityAssertions: [
    {
      id: "AS-REFEXEC-1",
      statement: "Provider-constructed calldata is decoded and compared to the intent before authorization.",
      provenBy: ["ADAPTER-014"],
    },
  ],
  documentation: { officialDocs: ["https://example.invalid/reference"], verifiedOn: "2026-09-08" },
};

export interface RefIntent {
  token: string;
  amount: string;
  recipient: string;
}
export interface RefPrepared {
  target: string;
  calldata: string;
  /** What the provider CLAIMS it built. Deliberately never read by decodeTransaction. */
  providerSummary: { recipient: string; amount: string };
}

/** `transfer(address,uint256)` — decoded from the bytes, not from the provider's summary. */
const SELECTOR = "0xa9059cbb";

export class ReferenceExecutionAdapter implements ExecutionAdapter<RefIntent, RefPrepared> {
  constructor(
    /** Test seam: lets a scenario make the provider return calldata that contradicts its summary. */
    private readonly build: (i: RefIntent) => RefPrepared = (i) => ({
      target: "0x00000000000000000000000000000000000000aa",
      calldata: `${SELECTOR}${i.recipient.slice(2).padStart(64, "0")}${BigInt(i.amount).toString(16).padStart(64, "0")}`,
      providerSummary: { recipient: i.recipient, amount: i.amount },
    }),
  ) {}

  manifest(): ContextLockAdapterManifest {
    return referenceExecutionManifest;
  }
  supportedActions(): string[] {
    return ["TRANSFER"];
  }
  normalizeIntent(intent: unknown) {
    const i = intent as RefIntent;
    const problems: ValidationProblem[] = [];
    if (!i || typeof i.recipient !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(i.recipient)) {
      problems.push({ code: "REF-I1", severity: "CRITICAL", field: "recipient", message: "recipient must be an address" });
    }
    if (!i || !/^\d+$/.test(String(i.amount))) {
      problems.push({ code: "REF-I2", severity: "CRITICAL", field: "amount", message: "amount must be integer base units" });
    }
    return problems.length > 0 ? ({ ok: false, problems } as const) : ({ ok: true, intent: i } as const);
  }

  async buildTransaction(intent: RefIntent, _ctx: AdapterExecutionContext): Promise<RefPrepared> {
    return this.build(intent);
  }

  /**
   * Decode from the CALLDATA.
   *
   * `providerSummary` is present on the prepared object and is deliberately never read here. A
   * provider that wanted to mislead would produce a benign summary beside hostile bytes, and
   * reading the summary would defeat the entire exercise.
   */
  async decodeTransaction(prepared: RefPrepared): Promise<NormalizedAction> {
    const data = prepared.calldata;
    const selector = data.slice(0, 10);
    if (selector !== SELECTOR) {
      throw new Error(`unrecognised selector ${selector}; refusing to guess what this calldata does`);
    }
    const recipient = `0x${data.slice(10 + 24, 10 + 64)}`;
    const amount = BigInt(`0x${data.slice(10 + 64, 10 + 128)}`).toString();
    return {
      chainId: SEPOLIA,
      target: prepared.target,
      calldata: data,
      value: "0",
      actionType: "TRANSFER",
      inputs: [{ token: "REF", amount, to: recipient }],
      outputs: [],
      recipient,
      allowanceChanges: [],
      minOutputs: [],
      providerMetadata: { summary: prepared.providerSummary },
    };
  }

  validateTransaction(n: NormalizedAction, intent: RefIntent, c: ExecutionConstraints): ValidationResult {
    const problems: ValidationProblem[] = [];
    if (n.chainId !== c.chainId) {
      problems.push({ code: "REF-X1", severity: "CRITICAL", field: "chainId", message: `chain ${n.chainId} != ${c.chainId}` });
    }
    if (!c.allowedTargets.map((t) => t.toLowerCase()).includes(n.target.toLowerCase())) {
      problems.push({ code: "REF-X2", severity: "CRITICAL", field: "target", message: `target ${n.target} not allow-listed` });
    }
    const wantRecipient = intent.recipient.toLowerCase();
    if ((n.recipient ?? "").toLowerCase() !== wantRecipient) {
      problems.push({
        code: "REF-X3",
        severity: "CRITICAL",
        field: "recipient",
        message: `decoded recipient ${n.recipient} does not match the intended ${intent.recipient}`,
      });
    }
    if (c.allowedRecipients === "self-only" && wantRecipient !== c.owner.toLowerCase()) {
      problems.push({ code: "REF-X4", severity: "CRITICAL", field: "recipient", message: "policy is self-only" });
    } else if (Array.isArray(c.allowedRecipients) && !c.allowedRecipients.map((r) => r.toLowerCase()).includes(wantRecipient)) {
      problems.push({ code: "REF-X4", severity: "CRITICAL", field: "recipient", message: "recipient not allow-listed" });
    }
    if (n.inputs[0]?.amount !== intent.amount) {
      problems.push({
        code: "REF-X5",
        severity: "CRITICAL",
        field: "amount",
        message: `decoded amount ${n.inputs[0]?.amount} does not match the intended ${intent.amount}`,
      });
    }
    return problems.length > 0 ? invalid(problems) : valid();
  }

  createSimulationFixtures(): AdapterSimulationFixture[] {
    return [
      {
        scenarioId: "REF-EXEC-NORMAL",
        description: "Provider builds exactly what was asked for.",
        providerResponse: null,
        expected: { outcome: "ACCEPTED" },
      },
      {
        scenarioId: "REF-EXEC-RECIPIENT-SWAP",
        description: "Provider returns a benign summary beside calldata paying an attacker.",
        providerResponse: null,
        expected: { outcome: "REJECTED", reasonCodeMatches: "REF-X3" },
      },
    ];
  }

  generateTemplateConfig() {
    return { adapterId: referenceExecutionManifest.id };
  }
}
