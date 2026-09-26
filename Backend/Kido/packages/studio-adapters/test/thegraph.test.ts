import { describe, it, expect } from "vitest";
import {
  AdapterRegistry,
  TheGraphSubgraphAdapter,
  TheGraphTokenApiAdapter,
  TheGraphSubstreamsAdapter,
  TheGraphError,
  QueryTemplateError,
  thegraphSubgraphManifest,
  thegraphTokenApiManifest,
  thegraphSubstreamsManifest,
  referenceOracleManifest,
  ReferenceOracleAdapter,
  templateById,
  bindVariables,
  QUERY_TEMPLATES,
  GATEWAY_ROUTES,
  resolveDataRequirement,
  assertUsableObservation,
  enforceRequirement,
  type SubgraphQuery,
  type SubgraphResponse,
  type DataRequirement,
} from "../src/index.js";

const SEPOLIA = 11155111;
const ACCOUNT = "0xA263b2cA150B5A1cA7bf08adF966B847c487F50f";
const nowSec = Math.floor(Date.now() / 1000);
const ctx = { chainId: SEPOLIA, nowMs: Date.now() };

const meta = (block: number, ts: number, errors = false) => ({
  deployment: "QmTestDeployment",
  block: { number: block, hash: `0x${block.toString(16).padStart(64, "0")}`, timestamp: ts },
  hasIndexingErrors: errors,
});

const query: SubgraphQuery = {
  templateId: "pool-liquidity",
  variables: { pool: "0x00000000000000000000000000000000000000aa" },
  subgraphId: "QmSubgraph",
};

const okResponse = (block = 9_000_000, head = 9_000_002): SubgraphResponse => ({
  data: { _meta: meta(block, nowSec - 10), pool: { id: "0x1", liquidity: "9000000000000" } },
  chainHead: head,
});

const adapter = (resp: SubgraphResponse, maxLag = 25) =>
  new TheGraphSubgraphAdapter(async () => resp, maxLag);

function registryWithGraph(): AdapterRegistry {
  const r = new AdapterRegistry();
  r.register({ kind: "data", manifest: thegraphSubgraphManifest, adapter: new TheGraphSubgraphAdapter() });
  r.register({ kind: "data", manifest: thegraphTokenApiManifest, adapter: new TheGraphTokenApiAdapter() });
  r.register({ kind: "data", manifest: thegraphSubstreamsManifest, adapter: new TheGraphSubstreamsAdapter() });
  return r;
}

/* ────────────────────────────── GRAPH-001/002/003 ─────────────────────────── */

describe("GRAPH-001 a query returns a typed observation", () => {
  it("normalizes a subgraph response", async () => {
    const a = adapter(okResponse());
    const q = a.validateQuery(query);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const obs = a.normalize(await a.fetch(q.query), q.query, ctx);
    expect(obs.dataKind).toBe("indexed_pool_liquidity");
    expect(obs.value).toBe("9000000000000");
    expect(obs.unit).toBe("base-units");
    expect(a.validate(obs, ctx).ok).toBe(true);
  });

  it("aggregates an array template into a single scalar", async () => {
    const a = new TheGraphSubgraphAdapter(async () => ({
      data: { _meta: meta(9_000_000, nowSec - 5), transfers: [{ id: "1", value: "10" }, { id: "2", value: "20" }] },
      chainHead: 9_000_000,
    }));
    const q = { templateId: "historical-portfolio-activity", variables: { account: ACCOUNT, since: nowSec - 86_400 }, subgraphId: "Q" };
    const obs = a.normalize(await a.fetch(q), q, ctx);
    expect(obs.value).toBe("30");
    expect(obs.dataKind).toBe("historical_portfolio_activity");
  });
});

describe("GRAPH-002/003 block freshness is captured and enforced", () => {
  it("records the indexed block, the head and the lag", async () => {
    const a = adapter(okResponse(9_000_000, 9_000_007));
    const obs = a.normalize(await a.fetch(query), query, ctx);
    expect(obs.provenance.indexedBlock).toBe("9000000");
    expect(obs.provenance.chainHeadBlock).toBe("9000007");
    expect(obs.provenance.blockLag).toBe(7);
    expect(obs.provenance.freshnessMs).toBeGreaterThan(0);
  });

  it("rejects an indexer that is too far behind the head", async () => {
    const a = adapter(okResponse(8_999_000, 9_000_002));
    const obs = a.normalize(await a.fetch(query), query, ctx);
    const v = a.validate(obs, ctx);
    expect(v.ok).toBe(false);
    expect(v.problems[0]!.code).toBe("GRAPH-INDEX-LAG");
  });

  it("refuses a response with no _meta, because freshness would be unknowable", async () => {
    const a = new TheGraphSubgraphAdapter(async () => ({ data: { pool: { id: "0x1", liquidity: "1" } } }));
    await expect(async () => a.normalize(await a.fetch(query), query, ctx)).rejects.toThrow(/GRAPH-NO-META/);
  });

  it("refuses a subgraph reporting past indexing errors", async () => {
    const a = new TheGraphSubgraphAdapter(async () => ({
      data: { _meta: meta(9_000_000, nowSec - 10, true), pool: { id: "0x1", liquidity: "1" } },
      chainHead: 9_000_000,
    }));
    await expect(async () => a.normalize(await a.fetch(query), query, ctx)).rejects.toThrow(/GRAPH-INDEXING-ERRORS/);
  });
});

/* ───────────────────────── GRAPH-005/010/011 trust ────────────────────────── */

describe("GRAPH-005/010/011 The Graph is never oracle-grade", () => {
  it("tags every observation INDEXED_CHAIN_DATA", async () => {
    const a = adapter(okResponse());
    const obs = a.normalize(await a.fetch(query), query, ctx);
    expect(obs.provenance.trustClass).toBe("INDEXED_CHAIN_DATA");
    expect(obs.provenance.verification.verified).toBe(false);
  });

  it("a VERIFIED_ORACLE requirement finds NO compatible adapter when only Graph is registered", () => {
    // The single most important test in this phase. A price requirement that quietly accepted
    // indexed data would return a number that looks entirely normal.
    const r = registryWithGraph();
    const req: DataRequirement = {
      key: "ethUsd",
      kind: "historical_swap_volume",
      chainId: SEPOLIA,
      minimumTrustClass: "VERIFIED_ORACLE",
      maxAgeMs: 30_000,
      confidential: false,
      historical: false,
    };
    const out = resolveDataRequirement(r, req);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("NO_COMPATIBLE_ADAPTER");
      expect(out.rejected.some((x) => /offers INDEXED_CHAIN_DATA/.test(x.reason))).toBe(true);
    }
  });

  it("GRAPH-006 an INDEXED requirement DOES accept Graph — trust-aware, not blanket rejection", () => {
    const r = registryWithGraph();
    const out = resolveDataRequirement(r, {
      key: "history",
      kind: "historical_portfolio_activity",
      chainId: SEPOLIA,
      minimumTrustClass: "INDEXED_CHAIN_DATA",
      maxAgeMs: 120_000,
      confidential: false,
      historical: true,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.selection.trustClass).toBe("INDEXED_CHAIN_DATA");
  });

  it("an oracle outranks Graph when both can serve a weak requirement", () => {
    const r = registryWithGraph();
    r.register({ kind: "data", manifest: referenceOracleManifest, adapter: new ReferenceOracleAdapter() });
    const out = resolveDataRequirement(r, {
      key: "price",
      kind: "collateral_asset_usd_price",
      chainId: SEPOLIA,
      minimumTrustClass: "EXTERNAL_API",
      maxAgeMs: 60_000,
      confidential: false,
      historical: false,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.selection.adapterId).toBe("reference-oracle");
  });

  it("a Graph observation cannot satisfy a verified-oracle policy at use time either", async () => {
    // Selection is design time; this is the runtime backstop.
    const a = adapter(okResponse());
    const obs = a.normalize(await a.fetch(query), query, ctx);
    const r = enforceRequirement(
      { key: "p", kind: "x", chainId: SEPOLIA, minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 60_000, confidential: false, historical: false },
      obs,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TRUST");
  });
});

/* ────────────────── GRAPH-006/009/010 query safety ────────────────────────── */

describe("GRAPH-009/010 the agent cannot supply arbitrary GraphQL", () => {
  it("refuses an unregistered template id", () => {
    const a = adapter(okResponse());
    const r = a.validateQuery({ templateId: "whatever-i-want", variables: {}, subgraphId: "Q" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]!.code).toBe("GRAPH-TEMPLATE-UNKNOWN");
  });

  it("refuses a raw GraphQL document in place of a template id", () => {
    const a = adapter(okResponse());
    const r = a.validateQuery({ templateId: "{ pools { id } }", variables: {}, subgraphId: "Q" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]!.message).toMatch(/arbitrary GraphQL is not accepted/);
  });

  it("refuses a variable carrying GraphQL syntax", () => {
    // It is bound as a variable and cannot escape the document — but a caller sending braces
    // believes it is composing a query, and surfacing that beats silently searching for a brace.
    const t = templateById("historical-swap-volume");
    expect(() => bindVariables(t, { account: "0x} } malicious { ", since: 1 })).toThrow(QueryTemplateError);
  });

  it("refuses an unexpected variable rather than dropping it", () => {
    const t = templateById("pool-liquidity");
    expect(() => bindVariables(t, { pool: "0x00000000000000000000000000000000000000aa", extra: 1 })).toThrow(
      /GRAPH-VAR-UNEXPECTED/,
    );
  });

  it("enforces variable types", () => {
    const t = templateById("historical-swap-volume");
    expect(() => bindVariables(t, { account: "not-an-address", since: 1 })).toThrow(/GRAPH-VAR-TYPE/);
    expect(() => bindVariables(t, { account: ACCOUNT, since: "yesterday" })).toThrow(/GRAPH-VAR-TYPE/);
    expect(() => bindVariables(t, { account: ACCOUNT })).toThrow(/GRAPH-VAR-MISSING/);
  });

  it("lowercases addresses, because subgraphs index them lowercased", () => {
    // A checksummed address silently matches nothing, which reads as "no activity" rather than as
    // an error — the most misleading possible result.
    const t = templateById("historical-swap-volume");
    const bound = bindVariables(t, { account: ACCOUNT, since: 1 });
    expect(bound.account).toBe(ACCOUNT.toLowerCase());
  });

  it("every registered template requests _meta so freshness is always available", () => {
    for (const t of Object.values(QUERY_TEMPLATES)) {
      expect(t.document, t.id).toContain("_meta");
      expect(t.document, t.id).toContain("hasIndexingErrors");
    }
  });
});

/* ───────────────────────── GRAPH-007/008 failure modes ────────────────────── */

describe("GRAPH-007/008 malformed and failed responses fail closed", () => {
  it("surfaces GraphQL errors rather than returning a value", async () => {
    const a = new TheGraphSubgraphAdapter(async () => ({ errors: [{ message: "indexer unavailable" }] }));
    await expect(async () => a.normalize(await a.fetch(query), query, ctx)).rejects.toThrow(/GRAPH-QUERY-ERROR/);
  });

  it("distinguishes a missing field from a zero value", async () => {
    // Conflating them is how an empty response reads as a real reading of zero.
    const a = new TheGraphSubgraphAdapter(async () => ({
      data: { _meta: meta(9_000_000, nowSec - 5), pool: null },
      chainHead: 9_000_000,
    }));
    await expect(async () => a.normalize(await a.fetch(query), query, ctx)).rejects.toThrow(/GRAPH-SHAPE-MISMATCH/);
  });

  it("refuses a non-scalar value", async () => {
    const a = new TheGraphSubgraphAdapter(async () => ({
      data: { _meta: meta(9_000_000, nowSec - 5), pool: { id: "0x1", liquidity: { nested: true } } },
      chainHead: 9_000_000,
    }));
    await expect(async () => a.normalize(await a.fetch(query), query, ctx)).rejects.toThrow(/GRAPH-SHAPE-MISMATCH/);
  });

  it("refuses to fabricate data when no transport is configured", async () => {
    const a = new TheGraphSubgraphAdapter();
    await expect(a.fetch(query)).rejects.toThrow(/refusing to fabricate indexed data/);
  });

  it("produces observations that pass the shared provenance gate", async () => {
    const a = adapter(okResponse());
    const obs = a.normalize(await a.fetch(query), query, ctx);
    expect(() => assertUsableObservation(obs, "thegraph-subgraph")).not.toThrow();
  });
});

/* ──────────────────────── GRAPH-012/014/015 registry ──────────────────────── */

describe("GRAPH-014/015 pinning, credentials and x402", () => {
  it("all three adapters register and are separately pinned", () => {
    const r = registryWithGraph();
    expect(r.list().map((m) => `${m.id}@${m.version}`)).toEqual([
      "thegraph-subgraph@1.0.0",
      "thegraph-substreams@1.0.0",
      "thegraph-token-api@1.0.0",
    ]);
  });

  it("declares its credential requirement and keeps it off the client", () => {
    for (const m of [thegraphSubgraphManifest, thegraphTokenApiManifest, thegraphSubstreamsManifest]) {
      expect(m.auth.requiredSecretNames).toContain("THEGRAPH_API_KEY");
      expect(m.executionPlacement).toBe("studio-backend");
      expect(m.trustClass).toBe("INDEXED_CHAIN_DATA");
    }
  });

  it("supports pinning an exact deployment for reproducibility", () => {
    expect(GATEWAY_ROUTES.byDeploymentId("QmX")).toBe("/api/deployments/id/QmX");
    expect(GATEWAY_ROUTES.bySubgraphId("QmX")).toBe("/api/subgraphs/id/QmX");
  });

  it("models x402 without granting the agent payment authority", () => {
    // Modelled per the gateway docs and explicitly NOT enabled: pay-per-query means an agent that
    // can spend, and spending authority is exactly what ContextLock does not hand out by default.
    const cfg = new TheGraphSubgraphAdapter().generateTemplateConfig() as { x402: { supported: boolean; enabled: boolean; route: string } };
    expect(cfg.x402.supported).toBe(true);
    expect(cfg.x402.enabled).toBe(false);
    expect(cfg.x402.route).toBe("/api/x402/subgraphs/id/:id");
  });

  it("the generated config exposes template names, never a raw query surface", () => {
    const cfg = new TheGraphSubgraphAdapter().generateTemplateConfig() as { templates: string[] };
    expect(cfg.templates).toContain("pool-liquidity");
    expect(JSON.stringify(cfg)).not.toContain("query ");
  });
});

describe("adapter fixtures behave as declared", () => {
  it("the subgraph adapter's own fixtures produce the outcomes they claim", async () => {
    const a = new TheGraphSubgraphAdapter();
    for (const f of a.createSimulationFixtures()) {
      const resp = f.providerResponse as SubgraphResponse;
      const runner = new TheGraphSubgraphAdapter(async () => resp);
      const q = { templateId: "pool-liquidity", variables: { pool: "0x00000000000000000000000000000000000000aa" }, subgraphId: "Q" };
      if (f.expected.outcome === "ACCEPTED") {
        const obs = runner.normalize(await runner.fetch(q), q, ctx);
        expect(runner.validate(obs, ctx).ok, f.scenarioId).toBe(true);
      } else {
        let rejected = false;
        try {
          const obs = runner.normalize(await runner.fetch(q), q, ctx);
          rejected = !runner.validate(obs, ctx).ok;
        } catch {
          rejected = true;
        }
        expect(rejected, f.scenarioId).toBe(true);
      }
    }
  });
});
