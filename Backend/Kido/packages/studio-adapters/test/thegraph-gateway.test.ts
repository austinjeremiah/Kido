import { describe, it, expect } from "vitest";
import { gatewayTransport, TheGraphSubgraphAdapter, TheGraphError, type SubgraphQuery } from "../src/index.js";

const KEY = "0123456789abcdef0123456789abcdef";
const ctx = { chainId: 1, nowMs: Date.now() };
const nowSec = Math.floor(Date.now() / 1000);

type Call = { url: string; init: RequestInit };
function fakeFetch(reply: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = reply({ url, init });
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const query: SubgraphQuery = { templateId: "pool-liquidity", variables: { pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640" }, subgraphId: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV" };
const meta = (block: number, hash: string | null = `0x${block.toString(16).padStart(64, "0")}`, timestamp: number | null = nowSec - 12) => ({ deployment: "QmDep", block: { number: block, hash, timestamp }, hasIndexingErrors: false });

describe("gatewayTransport — GRAPH-GW", () => {
  it("GW-001 posts the registered document with bound variables to the subgraph route, key only in the header", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { data: { _meta: meta(100), pool: { id: "0x1", liquidity: "42" } } } }));
    const send = gatewayTransport({ apiKey: KEY, fetchImpl: fetch, chainHead: async () => 103 });
    const r = await send(query);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gateway.thegraph.com/api/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.query).toContain("query PoolLiquidity");
    expect(body.variables).toEqual({ pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640" });
    expect(String(calls[0]!.init.body)).not.toContain(KEY);
    expect(r.chainHead).toBe(103);
    // The adapter accepts what the transport returned, with lag measured against OUR head.
    const obs = new TheGraphSubgraphAdapter(send).normalize(r, query, ctx);
    expect(obs.value).toBe("42");
    expect(obs.provenance.blockLag).toBe(3);
    expect(obs.provenance.trustClass).toBe("INDEXED_CHAIN_DATA");
  });

  it("GW-002 a pinned deployment id takes the deployments route", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { data: { _meta: meta(1), pool: { id: "0x1", liquidity: "1" } } } }));
    await gatewayTransport({ apiKey: KEY, fetchImpl: fetch })({ ...query, subgraphId: undefined, deploymentId: "QmPinned" });
    expect(calls[0]!.url).toBe("https://gateway.thegraph.com/api/deployments/id/QmPinned");
  });

  it("GW-003 a gateway error is returned as a GraphQL error the adapter rejects; the key never appears", async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, body: `auth error: bad key ${KEY}` }));
    const send = gatewayTransport({ apiKey: KEY, fetchImpl: fetch });
    const r = await send(query);
    expect(r.errors?.[0]?.message).toContain("gateway HTTP 401");
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(() => new TheGraphSubgraphAdapter(send).normalize(r, query, ctx)).toThrow(TheGraphError);
    expect(() => new TheGraphSubgraphAdapter(send).normalize(r, query, ctx)).toThrow(/GRAPH-QUERY-ERROR/);
  });

  it("GW-004 a network failure is an error, not fabricated data", async () => {
    const f = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const r = await gatewayTransport({ apiKey: KEY, fetchImpl: f })(query);
    expect(r.data).toBeUndefined();
    expect(r.errors?.[0]?.message).toMatch(/gateway unreachable: ECONNRESET/);
  });

  it("GW-005 a block-pinned query gets its block header from the RPC, so the observation is dated by its block", async () => {
    const pinned: SubgraphQuery = { templateId: "pool-liquidity-at-block", variables: { pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", block: 25963602 }, subgraphId: "S" };
    const { fetch, calls } = fakeFetch(() => ({ body: { data: { _meta: meta(25963602, null, null), pool: { id: "0x1", liquidity: "5476878705847506773" } } } }));
    const send = gatewayTransport({ apiKey: KEY, fetchImpl: fetch, chainHead: async () => 25963612, blockAt: async (n) => ({ hash: `0x${"ab".repeat(32)}`, timestamp: nowSec - 60 }) });
    const r = await send(pinned);
    expect(JSON.parse(String(calls[0]!.init.body)).variables).toEqual({ pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", block: 25963602 });
    const obs = new TheGraphSubgraphAdapter(send).normalize(r, pinned, ctx);
    expect(obs.provenance.indexedBlock).toBe("25963602");
    expect(obs.provenance.blockLag).toBe(10);
    expect(obs.provenance.sourceTimestamp).toBe(new Date((nowSec - 60) * 1000).toISOString());
  });

  it("GW-006 without a block header a pinned answer is refused: freshness cannot be established", async () => {
    const pinned: SubgraphQuery = { templateId: "pool-liquidity-at-block", variables: { pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", block: 5 }, subgraphId: "S" };
    const { fetch } = fakeFetch(() => ({ body: { data: { _meta: meta(5, null, null), pool: { id: "0x1", liquidity: "1" } } } }));
    const send = gatewayTransport({ apiKey: KEY, fetchImpl: fetch });
    const r = await send(pinned);
    expect(() => new TheGraphSubgraphAdapter(send).normalize(r, pinned, ctx)).toThrow(/GRAPH-NO-META/);
  });

  it("GW-007 invalid variables never reach the network", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    await expect(gatewayTransport({ apiKey: KEY, fetchImpl: fetch })({ ...query, variables: { pool: "not-an-address" } })).rejects.toThrow(/GRAPH-VAR/);
    expect(calls).toHaveLength(0);
  });

  it("GW-008 a transport needs a key", () => {
    expect(() => gatewayTransport({ apiKey: "" })).toThrow(/GRAPH-NO-KEY/);
  });
});
