import { ADAPTER_MANIFEST_VERSION, type ContextLockAdapterManifest } from "../../core/manifest.js";
import {
  invalid,
  valid,
  type AdapterSimulationFixture,
  type DataAdapter,
  type DataReadContext,
  type ValidationProblem,
  type ValidationResult,
} from "../../core/contracts.js";
import type { DataObservation } from "../../core/observation.js";
import { bindVariables, templateById, QueryTemplateError, QUERY_TEMPLATES } from "./queries.js";

/**
 * The Graph adapter suite.
 *
 * Three adapters, not one, because their trust and freshness properties genuinely differ and
 * flattening them would hide that. All three are INDEXED_CHAIN_DATA: an indexer's answer is a true
 * statement about a block that has already happened, which is a different thing from an oracle's
 * attested reading of a price right now.
 *
 * That distinction is the whole reason this suite exists as its own trust class. The Graph is
 * excellent for history, positions and aggregates, and it is not a substitute for a verified oracle
 * — a policy that asks for VERIFIED_ORACLE will never be given Graph data, and the resolver enforces
 * that rather than relying on anyone remembering it.
 */

export const THEGRAPH_GATEWAY = "https://gateway.thegraph.com";
const SEPOLIA = 11155111;

/** Verified from the gateway documentation on 2026-09-08. */
export const GATEWAY_ROUTES = {
  bySubgraphId: (id: string) => `/api/subgraphs/id/${id}`,
  byDeploymentId: (id: string) => `/api/deployments/id/${id}`,
  /** Pay-per-query in USDC on Base, no API key. Modelled; not enabled by default. */
  x402BySubgraphId: (id: string) => `/api/x402/subgraphs/id/${id}`,
} as const;

export interface SubgraphQuery {
  templateId: string;
  variables: Record<string, unknown>;
  /** Pin an exact deployment for reproducibility, or resolve the latest synced one. */
  subgraphId?: string;
  deploymentId?: string;
}

/** The raw shape a gateway returns: the requested entities plus `_meta`. */
export interface SubgraphResponse {
  data?: Record<string, unknown> & {
    _meta?: {
      deployment: string;
      /** A block-pinned `_meta` carries the number only; the transport fills the rest in from an RPC. */
      block: { number: number; hash: string | null; timestamp: number | null };
      hasIndexingErrors: boolean;
    };
  };
  errors?: Array<{ message: string }>;
  /** Chain head at query time, supplied by the caller's own RPC so lag is measurable. */
  chainHead?: number;
}

function baseManifest(over: Partial<ContextLockAdapterManifest>): ContextLockAdapterManifest {
  return {
    schemaVersion: ADAPTER_MANIFEST_VERSION,
    id: "thegraph-subgraph",
    version: "1.0.0",
    adapterType: "STATE_DATA",
    name: "The Graph Subgraph",
    description: "Indexed protocol state and history via registered GraphQL query templates.",
    provider: "thegraph",
    supportedChains: [SEPOLIA],
    capabilities: [],
    inputSchema: { templateId: "string", variables: "object" },
    outputSchema: { value: "string", unit: "string", decimals: "number" },
    trustClass: "INDEXED_CHAIN_DATA",
    freshnessSemantics: { kind: "block-height", typicalStalenessMs: 30_000, exposesBlockLag: true },
    auth: { mode: "api-key", requiredSecretNames: ["THEGRAPH_API_KEY"], placement: "studio-backend" },
    permissionsRequired: [],
    executionPlacement: "studio-backend",
    safety: {
      decodesPreparedTransactions: false,
      supportsDryRun: true,
      allowsArbitraryTarget: false,
      allowsArbitraryRecipient: false,
      independentlyValidatesProviderOutput: true,
    },
    generatedModules: [],
    simulationProviders: [],
    securityAssertions: [],
    documentation: {
      officialDocs: [
        "https://thegraph.com/docs/en/subgraphs/querying/graphql-api/",
        "https://thegraph.com/docs/en/gateways/subgraphs/consumer-side/serving-queries/",
      ],
      verifiedOn: "2026-09-08",
    },
    ...over,
  } as ContextLockAdapterManifest;
}

export const thegraphSubgraphManifest = baseManifest({
  id: "thegraph-subgraph",
  capabilities: [
    { name: "INDEXED_STATE", description: "Read indexed protocol state.", dataKind: "indexed_pool_liquidity", trustClass: "INDEXED_CHAIN_DATA" },
    { name: "INDEXED_HISTORY", description: "Read historical protocol activity.", dataKind: "historical_swap_volume", trustClass: "INDEXED_CHAIN_DATA" },
    { name: "PORTFOLIO_HISTORY", description: "Read an account's historical activity.", dataKind: "historical_portfolio_activity", trustClass: "INDEXED_CHAIN_DATA" },
  ],
  generatedModules: [
    { path: "src/adapters/thegraph-subgraph/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/thegraph-subgraph/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["GRAPH-NORMAL", "GRAPH-INDEX-LAG", "GRAPH-MALFORMED-RESPONSE", "GRAPH-QUERY-FAILURE"],
  securityAssertions: [
    { id: "AS-GRAPH-1", statement: "Indexed data is never labelled VERIFIED_ORACLE.", provenBy: ["GRAPH-010", "GRAPH-011"] },
    { id: "AS-GRAPH-2", statement: "The runtime agent cannot supply arbitrary GraphQL.", provenBy: ["GRAPH-006", "GRAPH-010"] },
    { id: "AS-GRAPH-3", statement: "Every observation records the indexed block and its lag behind the head.", provenBy: ["GRAPH-002", "GRAPH-003"] },
  ],
});

export const thegraphTokenApiManifest = baseManifest({
  id: "thegraph-token-api",
  name: "The Graph Token API",
  description: "Normalized token balances, transfers and holder data from The Graph Token API.",
  capabilities: [
    { name: "TOKEN_BALANCE", description: "Current indexed token balance.", dataKind: "indexed_token_balance", trustClass: "INDEXED_CHAIN_DATA" },
    { name: "TOKEN_TRANSFERS", description: "Historical token transfers.", dataKind: "historical_portfolio_activity", trustClass: "INDEXED_CHAIN_DATA" },
  ],
  auth: { mode: "bearer", requiredSecretNames: ["THEGRAPH_API_KEY"], placement: "studio-backend" },
  generatedModules: [
    { path: "src/adapters/thegraph-token-api/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/thegraph-token-api/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["GRAPH-TOKEN-NORMAL", "GRAPH-TOKEN-MALFORMED"],
  securityAssertions: [
    { id: "AS-GRAPHTOK-1", statement: "Token API results carry indexed provenance and are not oracle-grade.", provenBy: ["GRAPH-008", "GRAPH-010"] },
  ],
});

export const thegraphSubstreamsManifest = baseManifest({
  id: "thegraph-substreams",
  name: "The Graph Substreams",
  description: "High-throughput indexed event streams, normalized into observations at the boundary.",
  capabilities: [
    { name: "EVENT_STREAM", description: "Streamed protocol events.", dataKind: "indexed_protocol_events", trustClass: "INDEXED_CHAIN_DATA" },
  ],
  // Deliberately coarser than the subgraph adapter: a stream is fresher in principle, but this
  // build has no hosted credentials, so no freshness claim beyond the block height is made.
  freshnessSemantics: { kind: "block-height", typicalStalenessMs: 15_000, exposesBlockLag: true },
  generatedModules: [
    { path: "src/adapters/thegraph-substreams/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/thegraph-substreams/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["GRAPH-SUBSTREAM-NORMAL"],
  securityAssertions: [
    { id: "AS-GRAPHSUB-1", statement: "Stream events are normalized into observations; the agent never receives a raw credential.", provenBy: ["GRAPH-009"] },
  ],
});

export class TheGraphError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "TheGraphError";
  }
}

/** Shared behaviour for all three Graph adapters. */
abstract class BaseGraphAdapter implements DataAdapter<SubgraphQuery, SubgraphResponse> {
  constructor(
    protected readonly manifestValue: ContextLockAdapterManifest,
    /** Test seam. In production this issues the gateway request. */
    protected readonly transport?: (q: SubgraphQuery) => Promise<SubgraphResponse>,
    /** Policy bound on how far behind the head an indexer may be. */
    protected readonly maxIndexedBlockLag = 25,
  ) {}

  manifest(): ContextLockAdapterManifest {
    return this.manifestValue;
  }

  validateQuery(query: unknown) {
    const q = query as SubgraphQuery;
    const problems: ValidationProblem[] = [];
    try {
      const t = templateById(q?.templateId);
      bindVariables(t, q.variables ?? {});
      if (!q.subgraphId && !q.deploymentId) {
        problems.push({
          code: "GRAPH-NO-TARGET",
          severity: "HIGH",
          field: "subgraphId",
          message: "a subgraph id or a pinned deployment id is required",
        });
      }
    } catch (e) {
      const code = e instanceof QueryTemplateError ? e.code : "GRAPH-QUERY-INVALID";
      problems.push({ code, severity: "CRITICAL", field: "templateId", message: (e as Error).message });
    }
    return problems.length > 0 ? ({ ok: false, problems } as const) : ({ ok: true, query: q } as const);
  }

  async fetch(query: SubgraphQuery): Promise<SubgraphResponse> {
    if (!this.transport) {
      throw new TheGraphError(
        "GRAPH-NO-TRANSPORT",
        "no gateway transport configured; refusing to fabricate indexed data",
      );
    }
    return this.transport(query);
  }

  provenance(raw: SubgraphResponse, ctx: DataReadContext): DataObservation["provenance"] {
    const meta = raw.data?._meta;
    const indexed = meta?.block.number;
    const head = raw.chainHead;
    const ts = meta?.block.timestamp ?? null;
    const sourceTimestamp = ts !== null ? new Date(ts * 1000).toISOString() : undefined;
    return {
      provider: "thegraph",
      adapterId: this.manifestValue.id,
      adapterVersion: this.manifestValue.version,
      // Never anything stronger. An indexer reports what a block contained, not what is true now.
      trustClass: "INDEXED_CHAIN_DATA",
      ...(sourceTimestamp ? { sourceTimestamp } : {}),
      ...(ts !== null ? { freshnessMs: Math.max(0, ctx.nowMs - ts * 1000) } : {}),
      chainId: ctx.chainId,
      ...(indexed !== undefined ? { indexedBlock: String(indexed) } : {}),
      ...(head !== undefined ? { chainHeadBlock: String(head) } : {}),
      ...(indexed !== undefined && head !== undefined ? { blockLag: Math.max(0, head - indexed) } : {}),
      ...(meta?.deployment ? { subgraphId: meta.deployment } : {}),
      verification: { verified: false, mechanism: "indexer-consensus" },
    };
  }

  normalize(raw: SubgraphResponse, query: SubgraphQuery, ctx: DataReadContext): DataObservation {
    if (raw.errors && raw.errors.length > 0) {
      throw new TheGraphError("GRAPH-QUERY-ERROR", raw.errors.map((e) => e.message).join("; "));
    }
    if (!raw.data) throw new TheGraphError("GRAPH-NO-DATA", "response contains no data block");
    if (!raw.data._meta) {
      // Without `_meta` there is no indexed block, so freshness is unknowable — and an observation
      // whose age cannot be checked must not enter a policy at all.
      throw new TheGraphError("GRAPH-NO-META", "response omits _meta; indexed freshness cannot be established");
    }
    if (raw.data._meta.block.timestamp === null) {
      throw new TheGraphError("GRAPH-NO-META", "the indexed block carries no timestamp; indexed freshness cannot be established");
    }
    if (raw.data._meta.hasIndexingErrors) {
      throw new TheGraphError("GRAPH-INDEXING-ERRORS", "the subgraph reports past indexing errors");
    }

    const t = templateById(query.templateId);
    const value = this.extract(raw.data, t.valuePath);
    return {
      observationId: `graph-${t.id}-${raw.data._meta.block.number}`,
      dataKind: t.dataKind,
      ...(typeof query.variables.account === "string" ? { subject: query.variables.account } : {}),
      value,
      unit: t.unit,
      decimals: t.decimals,
      observedAt: new Date(ctx.nowMs).toISOString(),
      provenance: this.provenance(raw, ctx),
    };
  }

  /**
   * Pull the value out of the response.
   *
   * An array is reduced to a count or a sum depending on the template's unit, and a missing path is
   * an error rather than a zero — "no such field" and "the value is zero" mean very different things
   * to a policy, and conflating them is how an empty response reads as a real reading.
   */
  private extract(data: Record<string, unknown>, path: string[]): string {
    let cur: unknown = data;
    for (const seg of path) {
      if (cur === null || cur === undefined) {
        throw new TheGraphError("GRAPH-SHAPE-MISMATCH", `response has no value at ${path.join(".")}`);
      }
      cur = Array.isArray(cur) ? cur[Number(seg)] : (cur as Record<string, unknown>)[seg];
    }
    if (Array.isArray(cur)) {
      const amounts = cur.map((row) => (row as Record<string, unknown>).amountUSD ?? (row as Record<string, unknown>).value);
      if (amounts.every((a) => a === undefined)) return String(cur.length);
      return amounts
        .reduce<bigint>((sum, a) => sum + BigInt(String(a ?? "0").split(".")[0] ?? "0"), 0n)
        .toString();
    }
    if (cur === null || cur === undefined) {
      throw new TheGraphError("GRAPH-SHAPE-MISMATCH", `response has no value at ${path.join(".")}`);
    }
    if (typeof cur !== "string" && typeof cur !== "number") {
      throw new TheGraphError("GRAPH-SHAPE-MISMATCH", `value at ${path.join(".")} is not a scalar`);
    }
    return String(cur);
  }

  validate(observation: DataObservation): ValidationResult {
    const problems: ValidationProblem[] = [];
    if (observation.provenance.trustClass !== "INDEXED_CHAIN_DATA") {
      problems.push({
        code: "GRAPH-TRUST-CLAIM",
        severity: "CRITICAL",
        field: "trustClass",
        message: `Graph data must be INDEXED_CHAIN_DATA, got ${observation.provenance.trustClass}`,
      });
    }
    const lag = observation.provenance.blockLag;
    if (lag !== undefined && lag > this.maxIndexedBlockLag) {
      problems.push({
        code: "GRAPH-INDEX-LAG",
        severity: "HIGH",
        field: "blockLag",
        message: `indexer is ${lag} blocks behind the head, limit is ${this.maxIndexedBlockLag}`,
      });
    }
    if (!/^\d+$/.test(observation.value)) {
      problems.push({
        code: "GRAPH-VALUE-SHAPE",
        severity: "CRITICAL",
        field: "value",
        message: "value must be integer base units",
      });
    }
    return problems.length > 0 ? invalid(problems) : valid();
  }

  abstract createSimulationFixtures(): AdapterSimulationFixture[];

  /** All Graph fixtures are shaped for the pool-liquidity template. */
  fixtureQuery(): SubgraphQuery {
    return { templateId: "pool-liquidity", variables: { pool: "0x00000000000000000000000000000000000000aa" }, subgraphId: "QmFixture" };
  }

  generateTemplateConfig() {
    return {
      adapterId: this.manifestValue.id,
      gateway: THEGRAPH_GATEWAY,
      routes: { bySubgraphId: GATEWAY_ROUTES.bySubgraphId(":id"), byDeploymentId: GATEWAY_ROUTES.byDeploymentId(":id") },
      templates: Object.keys(QUERY_TEMPLATES),
      maxIndexedBlockLag: this.maxIndexedBlockLag,
      // Modelled, not enabled. Payment authority is never handed to a generated agent.
      x402: { supported: true, enabled: false, route: GATEWAY_ROUTES.x402BySubgraphId(":id"), settlement: "USDC on Base" },
    };
  }
}

const meta = (block: number, ts: number, errors = false) => ({
  deployment: "QmRefDeployment",
  block: { number: block, hash: `0x${block.toString(16).padStart(64, "0")}`, timestamp: ts },
  hasIndexingErrors: errors,
});

export class TheGraphSubgraphAdapter extends BaseGraphAdapter {
  constructor(transport?: (q: SubgraphQuery) => Promise<SubgraphResponse>, maxLag = 25) {
    super(thegraphSubgraphManifest, transport, maxLag);
  }
  createSimulationFixtures(): AdapterSimulationFixture[] {
    const now = Math.floor(Date.now() / 1000);
    return [
      {
        scenarioId: "GRAPH-NORMAL",
        description: "Indexer is current; the observation carries block and lag.",
        providerResponse: { data: { _meta: meta(9_000_000, now - 10), pool: { id: "0x1", liquidity: "9000000000000" } }, chainHead: 9_000_002 },
        expected: { outcome: "ACCEPTED" },
      },
      {
        scenarioId: "GRAPH-INDEX-LAG",
        description: "Indexer is far behind the chain head.",
        providerResponse: { data: { _meta: meta(8_999_000, now - 3_600), pool: { id: "0x1", liquidity: "9000000000000" } }, chainHead: 9_000_002 },
        expected: { outcome: "REJECTED", reasonCodeMatches: "GRAPH-INDEX-LAG" },
      },
      {
        scenarioId: "GRAPH-MALFORMED-RESPONSE",
        description: "Response omits _meta, so indexed freshness cannot be established.",
        providerResponse: { data: { pool: { id: "0x1", liquidity: "1" } } },
        expected: { outcome: "REJECTED", reasonCodeMatches: "GRAPH-NO-META" },
      },
      {
        scenarioId: "GRAPH-QUERY-FAILURE",
        description: "Gateway returns GraphQL errors.",
        providerResponse: { errors: [{ message: "indexer unavailable" }] },
        expected: { outcome: "REJECTED", reasonCodeMatches: "GRAPH-QUERY-ERROR" },
      },
    ];
  }
}

export class TheGraphTokenApiAdapter extends BaseGraphAdapter {
  constructor(transport?: (q: SubgraphQuery) => Promise<SubgraphResponse>, maxLag = 25) {
    super(thegraphTokenApiManifest, transport, maxLag);
  }
  override fixtureQuery(): SubgraphQuery {
    return {
      templateId: "account-token-balance",
      variables: { account: "0x0000000000000000000000000000000000005e1f", token: "0x00000000000000000000000000000000000000aa" },
      subgraphId: "QmFixture",
    };
  }
  createSimulationFixtures(): AdapterSimulationFixture[] {
    const now = Math.floor(Date.now() / 1000);
    return [
      {
        scenarioId: "GRAPH-TOKEN-NORMAL",
        description: "Token balance read with current indexed provenance.",
        providerResponse: { data: { _meta: meta(9_000_000, now - 8), accountBalances: [{ id: "0x1", amount: "1500000000" }] }, chainHead: 9_000_001 },
        expected: { outcome: "ACCEPTED" },
      },
      {
        scenarioId: "GRAPH-TOKEN-MALFORMED",
        description: "Response shape does not match the template's contract.",
        providerResponse: { data: { _meta: meta(9_000_000, now - 8), accountBalances: [] } },
        expected: { outcome: "REJECTED", reasonCodeMatches: "GRAPH-SHAPE-MISMATCH" },
      },
    ];
  }
}

export class TheGraphSubstreamsAdapter extends BaseGraphAdapter {
  constructor(transport?: (q: SubgraphQuery) => Promise<SubgraphResponse>, maxLag = 25) {
    super(thegraphSubstreamsManifest, transport, maxLag);
  }
  override fixtureQuery(): SubgraphQuery {
    return {
      templateId: "historical-portfolio-activity",
      variables: { account: "0x0000000000000000000000000000000000005e1f", since: 1 },
      subgraphId: "QmFixture",
    };
  }
  createSimulationFixtures(): AdapterSimulationFixture[] {
    const now = Math.floor(Date.now() / 1000);
    return [
      {
        scenarioId: "GRAPH-SUBSTREAM-NORMAL",
        description: "Streamed events normalized into a single observation.",
        providerResponse: { data: { _meta: meta(9_000_000, now - 5), transfers: [{ id: "1", value: "10" }, { id: "2", value: "20" }] }, chainHead: 9_000_000 },
        expected: { outcome: "ACCEPTED" },
      },
    ];
  }
}
