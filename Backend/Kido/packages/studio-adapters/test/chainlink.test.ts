import { describe, it, expect } from "vitest";
import {
  AdapterRegistry,
  ChainlinkDataFeedsAdapter,
  ChainlinkDataStreamsAdapter,
  CreExternalApiAdapter,
  ChainlinkFunctionsAdapter,
  ChainlinkError,
  UnknownFeedError,
  chainlinkDataFeedsManifest,
  chainlinkDataStreamsManifest,
  creExternalApiManifest,
  chainlinkFunctionsManifest,
  thegraphSubgraphManifest,
  TheGraphSubgraphAdapter,
  CHAINLINK_FEEDS,
  feedFor,
  resolveDataRequirement,
  enforceRequirement,
  assertUsableObservation,
  type DataRequirement,
} from "../src/index.js";

const SEPOLIA = 11155111;
const ctx = { chainId: SEPOLIA, nowMs: Date.now() };
const now = Math.floor(Date.now() / 1000);

const round = (over: Partial<{ answer: string; updatedAt: number; decimals: number }> = {}) => ({
  roundId: "1",
  answer: over.answer ?? "249356368692",
  startedAt: over.updatedAt ?? now - 30,
  updatedAt: over.updatedAt ?? now - 30,
  answeredInRound: "1",
  decimals: over.decimals ?? 8,
});

const feeds = (r = round()) => new ChainlinkDataFeedsAdapter(async () => r);

function fullRegistry(): AdapterRegistry {
  const r = new AdapterRegistry();
  r.register({ kind: "data", manifest: chainlinkDataFeedsManifest, adapter: new ChainlinkDataFeedsAdapter() });
  r.register({ kind: "data", manifest: chainlinkDataStreamsManifest, adapter: new ChainlinkDataStreamsAdapter() });
  r.register({ kind: "data", manifest: creExternalApiManifest, adapter: new CreExternalApiAdapter() });
  r.register({ kind: "data", manifest: chainlinkFunctionsManifest, adapter: new ChainlinkFunctionsAdapter() });
  r.register({ kind: "data", manifest: thegraphSubgraphManifest, adapter: new TheGraphSubgraphAdapter() });
  return r;
}

const req = (over: Partial<DataRequirement> = {}): DataRequirement => ({
  key: "ethUsd",
  kind: "eth_usd_price",
  chainId: SEPOLIA,
  minimumTrustClass: "VERIFIED_ORACLE",
  maxAgeMs: 30_000,
  confidential: false,
  historical: false,
  ...over,
});

/* ─────────────────────────────── Data Feeds ───────────────────────────────── */

describe("CLDATA-001/003 Data Feed observations are normalized", () => {
  it("normalizes a live-shaped round with full provenance", async () => {
    const a = feeds();
    const q = a.validateQuery({ dataKind: "eth_usd_price" });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const obs = a.normalize(await a.fetch(q.query), q.query, ctx);
    expect(obs.value).toBe("249356368692");
    expect(obs.decimals).toBe(8);
    expect(obs.unit).toBe("USD");
    expect(obs.subject).toBe("ETH/USD");
    expect(obs.provenance.trustClass).toBe("VERIFIED_ORACLE");
    expect(obs.provenance.verification.verified).toBe(true);
    expect(a.validate(obs, ctx).ok).toBe(true);
    expect(() => assertUsableObservation(obs, "chainlink-data-feeds")).not.toThrow();
  });

  it("CLDATA-003 refuses a decimals mismatch against the verified registry", async () => {
    // Reading an 8-decimal price as 18-decimal understates it by ten orders of magnitude, and the
    // resulting number is perfectly well-formed.
    const a = feeds(round({ decimals: 18 }));
    const q = { dataKind: "eth_usd_price" };
    await expect(async () => a.normalize(await a.fetch(q), q, ctx)).rejects.toThrow(/CL-DECIMALS-MISMATCH/);
  });
});

describe("CLDATA-002 a stale feed is rejected", () => {
  it("refuses a reading beyond the publisher heartbeat", async () => {
    const a = feeds(round({ updatedAt: now - 86_400 }));
    const q = { dataKind: "eth_usd_price" };
    const obs = a.normalize(await a.fetch(q), q, ctx);
    const v = a.validate(obs, ctx);
    expect(v.ok).toBe(false);
    expect(v.problems[0]!.code).toBe("CL-STALE-FEED");
    expect(v.problems[0]!.severity).toBe("CRITICAL");
  });

  it("accepts a reading inside the heartbeat", async () => {
    const a = feeds(round({ updatedAt: now - 60 }));
    const q = { dataKind: "eth_usd_price" };
    expect(a.validate(a.normalize(await a.fetch(q), q, ctx), ctx).ok).toBe(true);
  });

  it("CLDATA-006 refuses a non-positive answer", async () => {
    const a = feeds(round({ answer: "0" }));
    const q = { dataKind: "eth_usd_price" };
    const v = a.validate(a.normalize(await a.fetch(q), q, ctx), ctx);
    expect(v.problems.map((p) => p.code)).toContain("CL-NON-POSITIVE");
  });
});

describe("CLDATA-004 an unknown feed is rejected, never guessed", () => {
  it("refuses a data kind with no registry entry", () => {
    const a = feeds();
    const r = a.validateQuery({ dataKind: "doge_usd_price" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]!.code).toBe("CL-UNKNOWN-FEED");
    expect(() => feedFor("doge_usd_price", SEPOLIA)).toThrow(UnknownFeedError);
  });

  it("the registry records on-chain verification, not just a doc reference", () => {
    const eth = CHAINLINK_FEEDS.find((f) => f.dataKind === "eth_usd_price" && f.chainId === SEPOLIA)!;
    expect(eth.proxy).toBe("0x694AA1769357215DE4FAC081bf1f309aDC325306");
    expect(eth.decimals).toBe(8);
    expect(eth.version).toBe(4);
    expect(eth.verifiedOnChain).toBe(true);
    expect(eth.source).toContain("docs.chain.link");
  });

  it("refuses to fabricate a price with no reader configured", async () => {
    await expect(new ChainlinkDataFeedsAdapter().fetch({ dataKind: "eth_usd_price" })).rejects.toThrow(
      /refusing to fabricate a price/,
    );
  });
});

/* ────────────────────────────── Data Streams ──────────────────────────────── */

describe("CLDATA-005 a Data Streams report is verified before use", () => {
  const report = (over: Partial<{ verified: boolean; observationsTimestamp: number }> = {}) => ({
    feedId: "0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9",
    validFromTimestamp: over.observationsTimestamp ?? now - 1,
    observationsTimestamp: over.observationsTimestamp ?? now - 1,
    price: "2493563686920000000000",
    verified: over.verified ?? true,
    reportCommitment: "0xabc",
  });

  it("normalizes a verified report", async () => {
    const a = new ChainlinkDataStreamsAdapter(async () => report());
    const q = { dataKind: "eth_usd_price" };
    const obs = a.normalize(await a.fetch(q), q, ctx);
    expect(obs.provenance.trustClass).toBe("VERIFIED_ORACLE");
    expect(obs.provenance.rawCommitment).toBe("0xabc");
    expect(a.validate(obs, ctx).ok).toBe(true);
  });

  it("CLDATA-006 refuses an unverified report outright rather than downgrading it", async () => {
    // Downgrading its trust class would let an unauthenticated number satisfy a weaker requirement.
    const a = new ChainlinkDataStreamsAdapter(async () => report({ verified: false }));
    const q = { dataKind: "eth_usd_price" };
    await expect(async () => a.normalize(await a.fetch(q), q, ctx)).rejects.toThrow(/CL-UNVERIFIED-REPORT/);
  });

  it("refuses a verified report that is far too old for a low-latency feed", async () => {
    const a = new ChainlinkDataStreamsAdapter(async () => report({ observationsTimestamp: now - 600 }));
    const q = { dataKind: "eth_usd_price" };
    const v = a.validate(a.normalize(await a.fetch(q), q, ctx), ctx);
    expect(v.problems.map((p) => p.code)).toContain("CL-STREAM-STALE");
  });
});

/* ────────────────────────── source selection ──────────────────────────────── */

describe("CLDATA-012/013 the resolver picks by trust and freshness, not by name", () => {
  it("a sub-3s requirement selects Streams over Feeds", () => {
    const out = resolveDataRequirement(fullRegistry(), req({ maxAgeMs: 3_000 }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.selection.adapterId).toBe("chainlink-data-streams");
  });

  it("both Chainlink oracles qualify for a looser bound, and the fresher one is preferred", () => {
    const out = resolveDataRequirement(fullRegistry(), req({ maxAgeMs: 60_000 }));
    expect(out.ok).toBe(true);
    // Equal trust, so the tie is broken on typical staleness — deterministic and explainable.
    if (out.ok) expect(out.selection.adapterId).toBe("chainlink-data-streams");
  });

  it("CLDATA-013 The Graph is rejected for a verified-oracle requirement even when registered", () => {
    const out = resolveDataRequirement(fullRegistry(), req({ kind: "historical_swap_volume" }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejected.some((x) => /offers INDEXED_CHAIN_DATA/.test(x.reason))).toBe(true);
  });

  it("CLDATA-014 a Functions result cannot masquerade as a verified oracle", () => {
    // The distinction the Bible warns against flattening: the DON attests that the code ran, not
    // that the answer is a market truth.
    expect(chainlinkFunctionsManifest.trustClass).toBe("EXTERNAL_API");
    const out = resolveDataRequirement(fullRegistry(), req({ kind: "external_api_value" }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejected.some((x) => /offers EXTERNAL_API/.test(x.reason))).toBe(true);
  });

  it("an EXTERNAL_API requirement does accept Functions", () => {
    const out = resolveDataRequirement(
      fullRegistry(),
      req({ kind: "external_api_value", minimumTrustClass: "EXTERNAL_API", maxAgeMs: 60_000 }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.selection.adapterId).toBe("chainlink-functions");
  });

  it("a confidential requirement selects only a confidential-placement adapter", () => {
    const out = resolveDataRequirement(
      fullRegistry(),
      req({ kind: "confidential_risk_score", minimumTrustClass: "CONFIDENTIAL_VERIFIED_COMPUTE", maxAgeMs: 30_000, confidential: true }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.selection.adapterId).toBe("cre-external-api");
  });
});

/* ─────────────────────── CLDATA-008 declared fallbacks ────────────────────── */

describe("CLDATA-007/008 declared fallbacks, and no silent downgrade", () => {
  it("a declared Feeds fallback for a Streams primary is accepted", () => {
    const out = resolveDataRequirement(
      fullRegistry(),
      req({
        maxAgeMs: 3_000,
        fallback: { adapterId: "chainlink-data-feeds", adapterVersion: "1.0.0", allowedTrust: "VERIFIED_ORACLE", maxAgeMs: 30_000 },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.selection.fallback?.adapterId).toBe("chainlink-data-feeds");
  });

  it("a Graph fallback for an oracle requirement is refused", () => {
    // The forbidden behaviour, stated in the Bible: Streams fails, so something weaker gets used
    // and is still labelled VERIFIED_ORACLE.
    const out = resolveDataRequirement(
      fullRegistry(),
      req({
        maxAgeMs: 3_000,
        fallback: { adapterId: "thegraph-subgraph", adapterVersion: "1.0.0", allowedTrust: "VERIFIED_ORACLE", maxAgeMs: 60_000 },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.selection.fallback).toBeUndefined();
      expect(out.rejected.some((x) => /declared fallback offers/.test(x.reason))).toBe(true);
    }
  });

  it("a fallback that is itself too stale fails closed at use time", () => {
    const r = req({
      maxAgeMs: 3_000,
      fallback: { adapterId: "chainlink-data-feeds", adapterVersion: "1.0.0", allowedTrust: "VERIFIED_ORACLE", maxAgeMs: 30_000 },
    });
    const stale = { provenance: { trustClass: "VERIFIED_ORACLE" as const, freshnessMs: 120_000 } };
    expect(enforceRequirement(r, stale, true).ok).toBe(false);
  });
});

/* ─────────────────── CLDATA-009/010 confidential boundary ─────────────────── */

describe("CLDATA-009/010 the confidential boundary holds", () => {
  const result = (over: Partial<{ inputCommitment: string }> = {}) => ({
    band: "LOW" as const,
    score: 12,
    computedAtUnix: now - 1,
    inputCommitment: over.inputCommitment ?? "0xc0mm1t",
  });

  it("returns a coarse band and a commitment, never the credential or raw inputs", async () => {
    const SECRET = "super-secret-risk-api-token-value";
    const a = new CreExternalApiAdapter(async () => {
      // The handler HAS the secret and does not return it. That is the property.
      void SECRET;
      return result();
    });
    const q = { subject: "0xabc" };
    const obs = a.normalize(await a.fetch(q), q, ctx);
    expect(obs.provenance.trustClass).toBe("CONFIDENTIAL_VERIFIED_COMPUTE");
    expect(obs.provenance.rawCommitment).toBe("0xc0mm1t");
    expect(JSON.stringify(obs)).not.toContain(SECRET);
    expect(a.validate(obs, ctx).ok).toBe(true);
  });

  it("refuses a result with no input commitment", async () => {
    const a = new CreExternalApiAdapter(async () => result({ inputCommitment: "" }));
    const q = { subject: "0xabc" };
    const v = a.validate(a.normalize(await a.fetch(q), q, ctx), ctx);
    expect(v.problems.map((p) => p.code)).toContain("CRE-NO-COMMITMENT");
  });

  it("declares its secret by NAME and keeps execution inside the confidential boundary", () => {
    expect(creExternalApiManifest.auth.requiredSecretNames).toEqual(["CONTEXTLOCK_RISK_API_TOKEN"]);
    expect(creExternalApiManifest.auth.placement).toBe("cre-confidential");
    expect(creExternalApiManifest.executionPlacement).toBe("cre-confidential");
    // The generated config carries names only.
    const cfg = new CreExternalApiAdapter().generateTemplateConfig() as { secretNames: string[] };
    expect(cfg.secretNames).toEqual(["CONTEXTLOCK_RISK_API_TOKEN"]);
  });

  it("refuses to fabricate a verdict when no handler is configured", async () => {
    await expect(new CreExternalApiAdapter().fetch({ subject: "x" })).rejects.toThrow(/refusing to fabricate a verdict/);
  });
});

/* ────────────────────────── CLDATA-011/012 Functions ──────────────────────── */

describe("CLDATA-011/012 Functions is separate from CRE and schema-validated", () => {
  it("is a distinct adapter with distinct properties", () => {
    expect(chainlinkFunctionsManifest.id).not.toBe(creExternalApiManifest.id);
    expect(chainlinkFunctionsManifest.trustClass).toBe("EXTERNAL_API");
    expect(creExternalApiManifest.trustClass).toBe("CONFIDENTIAL_VERIFIED_COMPUTE");
    expect(chainlinkFunctionsManifest.executionPlacement).toBe("chainlink-functions");
    expect(creExternalApiManifest.executionPlacement).toBe("cre-confidential");
  });

  it("validates the response schema", async () => {
    const a = new ChainlinkFunctionsAdapter(async () => ({ value: "not-a-number", decimals: 0, computedAtUnix: now, requestId: "0xr" }));
    const q = { subject: "x" };
    await expect(async () => a.normalize(await a.fetch(q), q, ctx)).rejects.toThrow(/CL-FN-SCHEMA/);
  });

  it("accepts a well-formed result and keeps it EXTERNAL_API", async () => {
    const a = new ChainlinkFunctionsAdapter(async () => ({ value: "42", decimals: 0, computedAtUnix: now - 1, requestId: "0xr" }));
    const q = { subject: "x" };
    const obs = a.normalize(await a.fetch(q), q, ctx);
    expect(obs.provenance.trustClass).toBe("EXTERNAL_API");
    expect(a.validate(obs, ctx).ok).toBe(true);
  });
});

/* ────────────────────────────── registration ──────────────────────────────── */

describe("CLDATA-015 registration and credential placement", () => {
  it("all four register separately, with distinct trust classes", () => {
    const r = fullRegistry();
    const cl = r.list().filter((m) => m.provider.startsWith("chainlink"));
    expect(cl.map((m) => `${m.id}:${m.trustClass}`).sort()).toEqual([
      "chainlink-data-feeds:VERIFIED_ORACLE",
      "chainlink-data-streams:VERIFIED_ORACLE",
      "chainlink-functions:EXTERNAL_API",
      "cre-external-api:CONFIDENTIAL_VERIFIED_COMPUTE",
    ]);
  });

  it("no credential-bearing adapter runs in the generated agent", () => {
    for (const m of [chainlinkDataStreamsManifest, creExternalApiManifest, chainlinkFunctionsManifest]) {
      expect(m.auth.requiredSecretNames.length).toBeGreaterThan(0);
      expect(m.executionPlacement).not.toBe("generated-agent");
    }
  });

  it("Data Feeds needs no credential at all", () => {
    expect(chainlinkDataFeedsManifest.auth.mode).toBe("none");
  });
});

describe("adapter fixtures behave as declared", () => {
  it("every Chainlink fixture produces the outcome it claims", async () => {
    const cases: Array<[string, () => { adapter: any; query: unknown }]> = [
      ["feeds", () => ({ adapter: new ChainlinkDataFeedsAdapter(), query: { dataKind: "eth_usd_price" } })],
      ["streams", () => ({ adapter: new ChainlinkDataStreamsAdapter(), query: { dataKind: "eth_usd_price" } })],
      ["cre", () => ({ adapter: new CreExternalApiAdapter(), query: { subject: "0xabc" } })],
      ["functions", () => ({ adapter: new ChainlinkFunctionsAdapter(), query: { subject: "x" } })],
    ];
    for (const [name, make] of cases) {
      const { adapter, query } = make();
      for (const f of adapter.createSimulationFixtures()) {
        if (f.providerResponse === null) continue; // upstream-failure fixtures have no response
        let rejected = false;
        try {
          const obs = adapter.normalize(f.providerResponse, query, ctx);
          rejected = !adapter.validate(obs, ctx).ok;
        } catch {
          rejected = true;
        }
        expect(rejected, `${name}/${f.scenarioId}`).toBe(f.expected.outcome === "REJECTED");
      }
    }
  });
});
