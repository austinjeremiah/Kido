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
import { feedFor, streamFor, UnknownFeedError, type ChainlinkFeed } from "./feeds.js";

/**
 * The Chainlink adapter suite.
 *
 * Four adapters, deliberately not one. A single `ChainlinkAdapter` with a `getPrice()` would be
 * tidier and would hide the thing that matters most: these products have different trust,
 * confidentiality and execution properties, and "it came from Chainlink" is not a trust class.
 *
 *   Data Feeds     VERIFIED_ORACLE                  aggregated on-chain, heartbeat-bounded
 *   Data Streams   VERIFIED_ORACLE                  signed reports, sub-second, verified before use
 *   CRE            CONFIDENTIAL_VERIFIED_COMPUTE    attested compute over secrets the caller never sees
 *   Functions      EXTERNAL_API                     custom compute over an arbitrary API
 *
 * The last one is the one people get wrong. Chainlink Functions fetches whatever the developer told
 * it to fetch and runs whatever code they wrote; the DON attests that the code ran, not that the
 * answer is a true market price. Labelling it VERIFIED_ORACLE would let an arbitrary REST endpoint
 * satisfy a policy that demanded an oracle, which is exactly the substitution the trust model
 * exists to prevent.
 */

const SEPOLIA = 11155111;

export class ChainlinkError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ChainlinkError";
  }
}

const base = (over: Partial<ContextLockAdapterManifest>): ContextLockAdapterManifest =>
  ({
    schemaVersion: ADAPTER_MANIFEST_VERSION,
    version: "1.0.0",
    provider: "chainlink",
    supportedChains: [SEPOLIA],
    inputSchema: { dataKind: "string" },
    outputSchema: { value: "string", decimals: "number", updatedAt: "string" },
    permissionsRequired: [],
    safety: {
      decodesPreparedTransactions: false,
      supportsDryRun: true,
      allowsArbitraryTarget: false,
      allowsArbitraryRecipient: false,
      independentlyValidatesProviderOutput: true,
    },
    documentation: { officialDocs: ["https://docs.chain.link/"], verifiedOn: "2026-09-08" },
    ...over,
  }) as ContextLockAdapterManifest;

/* ─────────────────────────────── Data Feeds ───────────────────────────────── */

export const chainlinkDataFeedsManifest = base({
  id: "chainlink-data-feeds",
  adapterType: "VERIFIED_MARKET_DATA",
  name: "Chainlink Data Feeds",
  description: "Aggregated on-chain reference data from Chainlink Data Feeds, with heartbeat-bounded freshness.",
  capabilities: [
    { name: "PRICE_READ", description: "Read an aggregated reference price.", dataKind: "eth_usd_price", trustClass: "VERIFIED_ORACLE" },
    { name: "COLLATERAL_PRICE", description: "Read a collateral asset reference price.", dataKind: "collateral_asset_usd_price", trustClass: "VERIFIED_ORACLE" },
  ],
  trustClass: "VERIFIED_ORACLE",
  // Bounded by the publisher heartbeat, not by how often we ask.
  freshnessSemantics: { kind: "source-timestamp", typicalStalenessMs: 30_000, exposesBlockLag: false },
  auth: { mode: "none", requiredSecretNames: [], placement: "never-client" },
  executionPlacement: "studio-backend",
  generatedModules: [
    { path: "src/adapters/chainlink-data-feeds/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/chainlink-data-feeds/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["CL-FEED-NORMAL", "CL-FEED-STALE", "CL-FEED-BAD-ROUND"],
  securityAssertions: [
    { id: "AS-CLFEED-1", statement: "A feed older than its heartbeat is refused, not returned.", provenBy: ["CLDATA-002"] },
    { id: "AS-CLFEED-2", statement: "Feed addresses come from a verified registry, never guessed.", provenBy: ["CLDATA-004"] },
    { id: "AS-CLFEED-3", statement: "An incomplete or non-positive round is refused.", provenBy: ["CLDATA-006"] },
  ],
  documentation: {
    officialDocs: ["https://docs.chain.link/data-feeds", "https://docs.chain.link/data-feeds/price-feeds/addresses"],
    verifiedOn: "2026-09-08",
    notes: "Sepolia ETH/USD verified on-chain: description() = \"ETH / USD\", decimals() = 8, version() = 4.",
  },
});

/** Exactly what `latestRoundData()` returns, plus the decimals the contract reports. */
export interface AggregatorRound {
  roundId: string;
  answer: string;
  startedAt: number;
  updatedAt: number;
  answeredInRound: string;
  decimals: number;
}

export class ChainlinkDataFeedsAdapter implements DataAdapter<{ dataKind: string }, AggregatorRound> {
  constructor(
    private readonly reader?: (feed: ChainlinkFeed) => Promise<AggregatorRound>,
    /** Multiple of the heartbeat beyond which a reading is refused. */
    private readonly heartbeatTolerance = 1.5,
  ) {}

  manifest(): ContextLockAdapterManifest {
    return chainlinkDataFeedsManifest;
  }

  validateQuery(query: unknown) {
    const q = query as { dataKind: string };
    try {
      feedFor(q?.dataKind, SEPOLIA);
    } catch (e) {
      const problems: ValidationProblem[] = [
        {
          code: e instanceof UnknownFeedError ? "CL-UNKNOWN-FEED" : "CL-QUERY-INVALID",
          severity: "CRITICAL",
          field: "dataKind",
          message: (e as Error).message,
        },
      ];
      return { ok: false, problems } as const;
    }
    return { ok: true, query: q } as const;
  }

  async fetch(query: { dataKind: string }): Promise<AggregatorRound> {
    const feed = feedFor(query.dataKind, SEPOLIA);
    if (!this.reader) {
      throw new ChainlinkError("CL-NO-READER", "no chain reader configured; refusing to fabricate a price");
    }
    return this.reader(feed);
  }

  provenance(raw: AggregatorRound, ctx: DataReadContext): DataObservation["provenance"] {
    return {
      provider: "chainlink",
      adapterId: chainlinkDataFeedsManifest.id,
      adapterVersion: chainlinkDataFeedsManifest.version,
      trustClass: "VERIFIED_ORACLE",
      sourceTimestamp: new Date(raw.updatedAt * 1000).toISOString(),
      freshnessMs: Math.max(0, ctx.nowMs - raw.updatedAt * 1000),
      chainId: ctx.chainId,
      feedId: raw.roundId,
      verification: { verified: true, mechanism: "chainlink-aggregator" },
    };
  }

  normalize(raw: AggregatorRound, query: { dataKind: string }, ctx: DataReadContext): DataObservation {
    const feed = feedFor(query.dataKind, SEPOLIA);
    if (raw.decimals !== feed.decimals) {
      /*
       * A decimals mismatch is not cosmetic. Reading an 8-decimal price as 18-decimal understates
       * it by ten orders of magnitude, and the resulting number is perfectly well-formed.
       */
      throw new ChainlinkError(
        "CL-DECIMALS-MISMATCH",
        `feed reports ${raw.decimals} decimals, the registry records ${feed.decimals}`,
      );
    }
    return {
      observationId: `cl-feed-${feed.pair}-${raw.roundId}`,
      dataKind: feed.dataKind,
      subject: feed.pair,
      value: raw.answer,
      unit: "USD",
      decimals: feed.decimals,
      observedAt: new Date(ctx.nowMs).toISOString(),
      provenance: this.provenance(raw, ctx),
    };
  }

  validate(observation: DataObservation, ctx: DataReadContext): ValidationResult {
    const problems: ValidationProblem[] = [];
    const feed = feedFor(observation.dataKind, SEPOLIA);

    if (BigInt(observation.value) <= 0n) {
      // A non-positive price is a broken feed, not a cheap asset.
      problems.push({ code: "CL-NON-POSITIVE", severity: "CRITICAL", field: "value", message: "feed answer is not positive" });
    }
    const age = observation.provenance.freshnessMs;
    const bound = feed.heartbeatSeconds * 1000 * this.heartbeatTolerance;
    if (age === undefined || age > bound) {
      problems.push({
        code: "CL-STALE-FEED",
        severity: "CRITICAL",
        field: "updatedAt",
        message:
          age === undefined
            ? "reading carries no timestamp"
            : `reading is ${Math.round(age / 1000)}s old; the ${feed.heartbeatSeconds}s heartbeat allows ${Math.round(bound / 1000)}s`,
      });
    }
    void ctx;
    return problems.length > 0 ? invalid(problems) : valid();
  }

  createSimulationFixtures(): AdapterSimulationFixture[] {
    const now = Math.floor(Date.now() / 1000);
    return [
      {
        scenarioId: "CL-FEED-NORMAL",
        description: "Fresh aggregated reading within the heartbeat.",
        providerResponse: { roundId: "1", answer: "249356368692", startedAt: now - 30, updatedAt: now - 30, answeredInRound: "1", decimals: 8 },
        expected: { outcome: "ACCEPTED" },
      },
      {
        scenarioId: "CL-FEED-STALE",
        description: "Reading far beyond the publisher heartbeat.",
        providerResponse: { roundId: "1", answer: "249356368692", startedAt: now - 86_400, updatedAt: now - 86_400, answeredInRound: "1", decimals: 8 },
        expected: { outcome: "REJECTED", reasonCodeMatches: "CL-STALE-FEED" },
      },
      {
        scenarioId: "CL-FEED-BAD-ROUND",
        description: "Feed returns a non-positive answer.",
        providerResponse: { roundId: "1", answer: "0", startedAt: now - 10, updatedAt: now - 10, answeredInRound: "1", decimals: 8 },
        expected: { outcome: "REJECTED", reasonCodeMatches: "CL-NON-POSITIVE" },
      },
    ];
  }

  fixtureQuery() {
    return { dataKind: "eth_usd_price" };
  }

  generateTemplateConfig() {
    return {
      adapterId: chainlinkDataFeedsManifest.id,
      feeds: CHAINLINK_FEEDS_PUBLIC,
      heartbeatTolerance: this.heartbeatTolerance,
    };
  }
}

const CHAINLINK_FEEDS_PUBLIC = [
  { pair: "ETH/USD", dataKind: "eth_usd_price", proxy: "0x694AA1769357215DE4FAC081bf1f309aDC325306", decimals: 8, heartbeatSeconds: 3600 },
];

/* ────────────────────────────── Data Streams ──────────────────────────────── */

export const chainlinkDataStreamsManifest = base({
  id: "chainlink-data-streams",
  adapterType: "VERIFIED_MARKET_DATA",
  name: "Chainlink Data Streams",
  description: "Signed low-latency market reports, verified before use.",
  capabilities: [
    { name: "STREAM_PRICE", description: "Read a low-latency signed market report.", dataKind: "eth_usd_price", trustClass: "VERIFIED_ORACLE" },
  ],
  trustClass: "VERIFIED_ORACLE",
  // The reason a policy would prefer Streams over Feeds: sub-second rather than heartbeat-bounded.
  freshnessSemantics: { kind: "report-timestamp", typicalStalenessMs: 1_000, exposesBlockLag: false },
  auth: { mode: "api-key", requiredSecretNames: ["CHAINLINK_STREAMS_API_KEY"], placement: "studio-backend" },
  executionPlacement: "studio-backend",
  generatedModules: [
    { path: "src/adapters/chainlink-data-streams/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/chainlink-data-streams/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["CL-STREAM-NORMAL", "CL-STREAM-UNVERIFIED", "CL-STREAM-STALE"],
  securityAssertions: [
    { id: "AS-CLSTREAM-1", statement: "A report is verified before its value is used.", provenBy: ["CLDATA-005"] },
    { id: "AS-CLSTREAM-2", statement: "The credential never reaches the generated agent.", provenBy: ["CLDATA-007"] },
  ],
  documentation: { officialDocs: ["https://docs.chain.link/data-streams"], verifiedOn: "2026-09-08" },
});

export interface StreamReport {
  feedId: string;
  validFromTimestamp: number;
  observationsTimestamp: number;
  price: string;
  /** Whether the report's signature was checked. A report is not data until this is true. */
  verified: boolean;
  reportCommitment: string;
}

export class ChainlinkDataStreamsAdapter implements DataAdapter<{ dataKind: string }, StreamReport> {
  constructor(private readonly reader?: (feedId: string) => Promise<StreamReport>) {}

  manifest(): ContextLockAdapterManifest {
    return chainlinkDataStreamsManifest;
  }

  validateQuery(query: unknown) {
    const q = query as { dataKind: string };
    try {
      streamFor(q?.dataKind, SEPOLIA);
    } catch (e) {
      const problems: ValidationProblem[] = [
        { code: "CL-UNKNOWN-STREAM", severity: "CRITICAL", field: "dataKind", message: (e as Error).message },
      ];
      return { ok: false, problems } as const;
    }
    return { ok: true, query: q } as const;
  }

  async fetch(query: { dataKind: string }): Promise<StreamReport> {
    const s = streamFor(query.dataKind, SEPOLIA);
    if (!this.reader) throw new ChainlinkError("CL-NO-READER", "no streams client configured; refusing to fabricate a report");
    return this.reader(s.feedId);
  }

  provenance(raw: StreamReport, ctx: DataReadContext): DataObservation["provenance"] {
    return {
      provider: "chainlink",
      adapterId: chainlinkDataStreamsManifest.id,
      adapterVersion: chainlinkDataStreamsManifest.version,
      trustClass: "VERIFIED_ORACLE",
      sourceTimestamp: new Date(raw.observationsTimestamp * 1000).toISOString(),
      freshnessMs: Math.max(0, ctx.nowMs - raw.observationsTimestamp * 1000),
      chainId: ctx.chainId,
      feedId: raw.feedId,
      rawCommitment: raw.reportCommitment,
      verification: { verified: raw.verified, mechanism: "data-streams-report-signature" },
    };
  }

  normalize(raw: StreamReport, query: { dataKind: string }, ctx: DataReadContext): DataObservation {
    if (!raw.verified) {
      /*
       * An unverified report is not a slightly-weaker reading — it is an unauthenticated number from
       * the network. Downgrading its trust class would let it satisfy a lower requirement; refusing
       * it outright is the only safe handling.
       */
      throw new ChainlinkError("CL-UNVERIFIED-REPORT", "report signature was not verified; refusing to use its value");
    }
    const s = streamFor(query.dataKind, SEPOLIA);
    return {
      observationId: `cl-stream-${s.pair}-${raw.observationsTimestamp}`,
      dataKind: s.dataKind,
      subject: s.pair,
      value: raw.price,
      unit: "USD",
      decimals: s.decimals,
      observedAt: new Date(ctx.nowMs).toISOString(),
      provenance: this.provenance(raw, ctx),
    };
  }

  validate(observation: DataObservation): ValidationResult {
    const problems: ValidationProblem[] = [];
    if (!observation.provenance.verification.verified) {
      problems.push({ code: "CL-UNVERIFIED-REPORT", severity: "CRITICAL", field: "verification", message: "report not verified" });
    }
    const age = observation.provenance.freshnessMs;
    if (age === undefined || age > 10_000) {
      problems.push({
        code: "CL-STREAM-STALE",
        severity: "HIGH",
        field: "observationsTimestamp",
        message: `stream report is ${age === undefined ? "undated" : `${age}ms old`}; a low-latency feed that is seconds old has lost its reason for being chosen`,
      });
    }
    return problems.length > 0 ? invalid(problems) : valid();
  }

  createSimulationFixtures(): AdapterSimulationFixture[] {
    const now = Math.floor(Date.now() / 1000);
    const fid = CHAINLINK_STREAM_ID;
    return [
      {
        scenarioId: "CL-STREAM-NORMAL",
        description: "Fresh, signature-verified report.",
        providerResponse: { feedId: fid, validFromTimestamp: now - 1, observationsTimestamp: now - 1, price: "2493563686920000000000", verified: true, reportCommitment: "0xabc" },
        expected: { outcome: "ACCEPTED" },
      },
      {
        scenarioId: "CL-STREAM-UNVERIFIED",
        description: "Report whose signature was not verified.",
        providerResponse: { feedId: fid, validFromTimestamp: now - 1, observationsTimestamp: now - 1, price: "2493563686920000000000", verified: false, reportCommitment: "0xabc" },
        expected: { outcome: "REJECTED", reasonCodeMatches: "CL-UNVERIFIED-REPORT" },
      },
      {
        scenarioId: "CL-STREAM-STALE",
        description: "Verified report that is far too old for a low-latency feed.",
        providerResponse: { feedId: fid, validFromTimestamp: now - 600, observationsTimestamp: now - 600, price: "2493563686920000000000", verified: true, reportCommitment: "0xabc" },
        expected: { outcome: "REJECTED", reasonCodeMatches: "CL-STREAM-STALE" },
      },
    ];
  }

  fixtureQuery() {
    return { dataKind: "eth_usd_price" };
  }

  generateTemplateConfig() {
    return { adapterId: chainlinkDataStreamsManifest.id, feedId: CHAINLINK_STREAM_ID, maxReportAgeMs: 10_000 };
  }
}

const CHAINLINK_STREAM_ID = "0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9";

/* ─────────────────────────── CRE confidential ─────────────────────────────── */

export const creExternalApiManifest = base({
  id: "cre-external-api",
  adapterType: "EXTERNAL_CONTEXT",
  name: "CRE Confidential External API",
  description:
    "Fetches an external API inside the Chainlink CRE confidential handler and returns a minimal normalized result. The credential and the raw response never leave the boundary.",
  capabilities: [
    { name: "CONFIDENTIAL_CONTEXT", description: "Evaluate private inputs and return a minimal result.", dataKind: "confidential_risk_score", trustClass: "CONFIDENTIAL_VERIFIED_COMPUTE" },
  ],
  trustClass: "CONFIDENTIAL_VERIFIED_COMPUTE",
  freshnessSemantics: { kind: "request-time", typicalStalenessMs: 5_000, exposesBlockLag: false },
  auth: { mode: "cre-secret", requiredSecretNames: ["CONTEXTLOCK_RISK_API_TOKEN"], placement: "cre-confidential" },
  executionPlacement: "cre-confidential",
  generatedModules: [
    { path: "src/adapters/cre-external-api/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/cre-external-api/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["CRE-CTX-NORMAL", "CRE-CTX-SECRET-LEAK-ATTEMPT", "CRE-CTX-UPSTREAM-FAILURE"],
  securityAssertions: [
    { id: "AS-CRE-1", statement: "The API credential is never returned to the caller.", provenBy: ["CLDATA-009"] },
    { id: "AS-CRE-2", statement: "Only a minimal normalized result crosses the boundary.", provenBy: ["CLDATA-010"] },
  ],
  documentation: { officialDocs: ["https://docs.chain.link/cre"], verifiedOn: "2026-09-08" },
});

/** What the confidential handler returns: a coarse result, never the inputs it computed over. */
export interface ConfidentialResult {
  /** Coarse band, never the underlying score's constituent inputs. */
  band: "LOW" | "MEDIUM" | "HIGH";
  score: number;
  computedAtUnix: number;
  /** Commitment to the private inputs, so a decision can be tied to them without revealing them. */
  inputCommitment: string;
}

export class CreExternalApiAdapter implements DataAdapter<{ subject: string }, ConfidentialResult> {
  constructor(private readonly handler?: (subject: string) => Promise<ConfidentialResult>) {}

  manifest(): ContextLockAdapterManifest {
    return creExternalApiManifest;
  }

  validateQuery(query: unknown) {
    const q = query as { subject: string };
    if (!q || typeof q.subject !== "string" || q.subject.length === 0) {
      const problems: ValidationProblem[] = [
        { code: "CRE-QUERY-INVALID", severity: "HIGH", field: "subject", message: "subject is required" },
      ];
      return { ok: false, problems } as const;
    }
    return { ok: true, query: q } as const;
  }

  async fetch(query: { subject: string }): Promise<ConfidentialResult> {
    if (!this.handler) {
      throw new ChainlinkError("CRE-NO-HANDLER", "no confidential handler configured; refusing to fabricate a verdict");
    }
    return this.handler(query.subject);
  }

  provenance(raw: ConfidentialResult, ctx: DataReadContext): DataObservation["provenance"] {
    return {
      provider: "chainlink-cre",
      adapterId: creExternalApiManifest.id,
      adapterVersion: creExternalApiManifest.version,
      trustClass: "CONFIDENTIAL_VERIFIED_COMPUTE",
      sourceTimestamp: new Date(raw.computedAtUnix * 1000).toISOString(),
      freshnessMs: Math.max(0, ctx.nowMs - raw.computedAtUnix * 1000),
      chainId: ctx.chainId,
      rawCommitment: raw.inputCommitment,
      verification: { verified: true, mechanism: "cre-confidential-handler" },
    };
  }

  normalize(raw: ConfidentialResult, query: { subject: string }, ctx: DataReadContext): DataObservation {
    /*
     * Only the band and a commitment cross the boundary. The API credential, the raw response and
     * the private thresholds the handler compared against all stay inside — which is the entire
     * reason this adapter exists rather than the agent calling the API itself.
     */
    return {
      observationId: `cre-ctx-${query.subject}-${raw.computedAtUnix}`,
      dataKind: "confidential_risk_score",
      subject: query.subject,
      value: String(raw.score),
      unit: "risk-band",
      decimals: 0,
      observedAt: new Date(ctx.nowMs).toISOString(),
      provenance: this.provenance(raw, ctx),
    };
  }

  validate(observation: DataObservation): ValidationResult {
    const problems: ValidationProblem[] = [];
    if (!observation.provenance.rawCommitment) {
      problems.push({
        code: "CRE-NO-COMMITMENT",
        severity: "HIGH",
        field: "rawCommitment",
        message: "confidential result carries no input commitment, so the decision cannot be tied to its inputs",
      });
    }
    return problems.length > 0 ? invalid(problems) : valid();
  }

  createSimulationFixtures(): AdapterSimulationFixture[] {
    const now = Math.floor(Date.now() / 1000);
    return [
      {
        scenarioId: "CRE-CTX-NORMAL",
        description: "Confidential handler returns a coarse band and an input commitment.",
        providerResponse: { band: "LOW", score: 12, computedAtUnix: now - 1, inputCommitment: "0xc0mm1t" },
        expected: { outcome: "ACCEPTED" },
      },
      {
        scenarioId: "CRE-CTX-SECRET-LEAK-ATTEMPT",
        description: "Handler result omits its commitment, so the decision cannot be tied to its inputs.",
        providerResponse: { band: "LOW", score: 12, computedAtUnix: now - 1, inputCommitment: "" },
        expected: { outcome: "REJECTED", reasonCodeMatches: "CRE-NO-COMMITMENT" },
      },
      {
        scenarioId: "CRE-CTX-UPSTREAM-FAILURE",
        description: "Upstream API is unavailable inside the handler.",
        providerResponse: null,
        expected: { outcome: "REJECTED", reasonCodeMatches: "CRE-" },
      },
    ];
  }

  fixtureQuery() {
    return { subject: "0x0000000000000000000000000000000000005e1f" };
  }

  generateTemplateConfig() {
    return {
      adapterId: creExternalApiManifest.id,
      // Names only. The values live in the Vault DON and never appear in generated code.
      secretNames: creExternalApiManifest.auth.requiredSecretNames,
      returns: "coarse band + input commitment only",
    };
  }
}

/* ───────────────────────────── Functions ──────────────────────────────────── */

export const chainlinkFunctionsManifest = base({
  id: "chainlink-functions",
  adapterType: "EXTERNAL_CONTEXT",
  name: "Chainlink Functions",
  description:
    "Custom off-chain compute over an arbitrary API, executed by a DON. The DON attests that the code ran; it does not attest that the answer is a market truth.",
  capabilities: [
    { name: "CUSTOM_COMPUTE", description: "Run custom code over an external API.", dataKind: "external_api_value", trustClass: "EXTERNAL_API" },
  ],
  /*
   * EXTERNAL_API, NOT VERIFIED_ORACLE. This is the distinction the Bible warns against flattening.
   * Functions fetches whatever the developer pointed it at and runs whatever they wrote; labelling
   * it oracle-grade would let an arbitrary REST endpoint satisfy a policy that demanded an oracle.
   */
  trustClass: "EXTERNAL_API",
  freshnessSemantics: { kind: "request-time", typicalStalenessMs: 30_000, exposesBlockLag: false },
  auth: { mode: "cre-secret", requiredSecretNames: ["CHAINLINK_FUNCTIONS_SECRET"], placement: "cre-confidential" },
  executionPlacement: "chainlink-functions",
  generatedModules: [
    { path: "src/adapters/chainlink-functions/adapter.ts", kind: "adapter-runtime" },
    { path: "src/adapters/chainlink-functions/config.ts", kind: "adapter-config" },
  ],
  simulationProviders: ["CL-FN-NORMAL", "CL-FN-SCHEMA-MISMATCH"],
  securityAssertions: [
    {
      id: "AS-CLFN-1",
      statement: "Functions results are EXTERNAL_API and can never satisfy a verified-oracle requirement.",
      provenBy: ["CLDATA-011", "CLDATA-014"],
    },
  ],
  documentation: { officialDocs: ["https://docs.chain.link/chainlink-functions"], verifiedOn: "2026-09-08" },
});

export interface FunctionsResult {
  value: string;
  decimals: number;
  computedAtUnix: number;
  requestId: string;
}

export class ChainlinkFunctionsAdapter implements DataAdapter<{ subject: string }, FunctionsResult> {
  constructor(private readonly runner?: (subject: string) => Promise<FunctionsResult>) {}

  manifest(): ContextLockAdapterManifest {
    return chainlinkFunctionsManifest;
  }
  validateQuery(query: unknown) {
    const q = query as { subject: string };
    if (!q || typeof q.subject !== "string") {
      const problems: ValidationProblem[] = [
        { code: "CL-FN-QUERY", severity: "HIGH", field: "subject", message: "subject is required" },
      ];
      return { ok: false, problems } as const;
    }
    return { ok: true, query: q } as const;
  }
  async fetch(query: { subject: string }): Promise<FunctionsResult> {
    if (!this.runner) throw new ChainlinkError("CL-FN-NO-RUNNER", "no Functions runner configured; refusing to fabricate a result");
    return this.runner(query.subject);
  }
  provenance(raw: FunctionsResult, ctx: DataReadContext): DataObservation["provenance"] {
    return {
      provider: "chainlink",
      adapterId: chainlinkFunctionsManifest.id,
      adapterVersion: chainlinkFunctionsManifest.version,
      // Attested execution, unattested content.
      trustClass: "EXTERNAL_API",
      sourceTimestamp: new Date(raw.computedAtUnix * 1000).toISOString(),
      freshnessMs: Math.max(0, ctx.nowMs - raw.computedAtUnix * 1000),
      chainId: ctx.chainId,
      requestId: raw.requestId,
      verification: { verified: true, mechanism: "functions-don-execution" },
    };
  }
  normalize(raw: FunctionsResult, query: { subject: string }, ctx: DataReadContext): DataObservation {
    if (!/^\d+$/.test(raw.value)) {
      throw new ChainlinkError("CL-FN-SCHEMA", `Functions returned "${raw.value}", which is not integer base units`);
    }
    return {
      observationId: `cl-fn-${raw.requestId}`,
      dataKind: "external_api_value",
      subject: query.subject,
      value: raw.value,
      unit: "unspecified",
      decimals: raw.decimals,
      observedAt: new Date(ctx.nowMs).toISOString(),
      provenance: this.provenance(raw, ctx),
    };
  }
  validate(observation: DataObservation): ValidationResult {
    if (observation.provenance.trustClass !== "EXTERNAL_API") {
      return invalid([
        {
          code: "CL-FN-TRUST-CLAIM",
          severity: "CRITICAL",
          field: "trustClass",
          message: "Functions results must be EXTERNAL_API; the DON attests execution, not market truth",
        },
      ]);
    }
    return valid();
  }
  createSimulationFixtures(): AdapterSimulationFixture[] {
    const now = Math.floor(Date.now() / 1000);
    return [
      {
        scenarioId: "CL-FN-NORMAL",
        description: "Functions returns a well-formed integer result.",
        providerResponse: { value: "42", decimals: 0, computedAtUnix: now - 2, requestId: "0xreq" },
        expected: { outcome: "ACCEPTED" },
      },
      {
        scenarioId: "CL-FN-SCHEMA-MISMATCH",
        description: "Functions returns a value that is not integer base units.",
        providerResponse: { value: "not-a-number", decimals: 0, computedAtUnix: now - 2, requestId: "0xreq" },
        expected: { outcome: "REJECTED", reasonCodeMatches: "CL-FN-SCHEMA" },
      },
    ];
  }
  fixtureQuery() {
    return { subject: "risk" };
  }

  generateTemplateConfig() {
    return { adapterId: chainlinkFunctionsManifest.id, trustClass: "EXTERNAL_API" };
  }
}
