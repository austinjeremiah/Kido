import { bindVariables, templateById } from "./queries.js";
import { GATEWAY_ROUTES, THEGRAPH_GATEWAY, TheGraphError, type SubgraphQuery, type SubgraphResponse } from "./adapter.js";

/**
 * The gateway transport: the one place a Graph API key is used.
 *
 * It runs on the Studio backend (the manifest says `placement: "studio-backend"`), takes a
 * template and typed variables, and issues the request. The key goes into one header and nowhere
 * else — not into the query, not into an error, not into the observation. A caller that wants to
 * know why a request failed gets the gateway's own error text and the HTTP status, never the
 * request it sent.
 *
 * The chain head comes from the caller's OWN RPC rather than from the gateway: indexer lag is only
 * measurable against a head the indexer did not report.
 */
export interface GatewayTransportOptions {
  /**
   * The gateway key, or a resolver that produces it for one request. A resolver lets the key live
   * behind a protected source (a Ledger Key Ring decrypt) and be fetched only when a request is
   * actually made; a rejected resolver is a failed request, never a request without a key.
   */
  apiKey: string | (() => Promise<string>);
  /** Defaults to the decentralised gateway. */
  gateway?: string;
  /** Test seam; `globalThis.fetch` otherwise. */
  fetchImpl?: typeof fetch;
  /** The current head of the chain the subgraph indexes, from the caller's RPC. */
  chainHead?: () => Promise<number>;
  /**
   * The header of a block, for templates that query AT a block. A subgraph answers `_meta(block:)`
   * with the number only; the hash and timestamp come from the caller's RPC so the observation still
   * carries a source timestamp.
   */
  blockAt?: (blockNumber: number) => Promise<{ hash: string; timestamp: number }>;
  timeoutMs?: number;
}

const HEX32 = /^(0x)?[0-9a-fA-F]{32,}$/;

export function gatewayTransport(opts: GatewayTransportOptions): (q: SubgraphQuery) => Promise<SubgraphResponse> {
  if (!opts.apiKey) throw new TheGraphError("GRAPH-NO-KEY", "a gateway transport needs an API key");
  const resolveKey = typeof opts.apiKey === "function" ? opts.apiKey : async () => opts.apiKey as string;
  const gateway = (opts.gateway ?? THEGRAPH_GATEWAY).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return async (q) => {
    const t = templateById(q.templateId);
    const variables = bindVariables(t, q.variables ?? {});
    const route = q.deploymentId ? GATEWAY_ROUTES.byDeploymentId(q.deploymentId) : q.subgraphId ? GATEWAY_ROUTES.bySubgraphId(q.subgraphId) : null;
    if (!route) throw new TheGraphError("GRAPH-NO-TARGET", "a subgraph id or a pinned deployment id is required");

    let apiKey: string;
    try {
      apiKey = await resolveKey();
    } catch (e) {
      // The protected source refused (ring locked, network down, password absent). Its message is
      // a fixed typed string by construction, so it can be reported.
      return { errors: [{ message: `credential unavailable: ${(e as Error).message}` }] };
    }
    if (!apiKey) return { errors: [{ message: "credential unavailable: empty key" }] };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${gateway}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query: t.document, variables }),
        signal: controller.signal,
      });
    } catch (e) {
      // The message is the network's, never ours: it cannot contain the header we sent.
      return { errors: [{ message: `gateway unreachable: ${scrub((e as Error).message, apiKey)}` }] };
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = scrub(await res.text().catch(() => ""), apiKey);
      return { errors: [{ message: `gateway HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` }] };
    }
    const body = (await res.json().catch(() => null)) as SubgraphResponse | null;
    if (!body || typeof body !== "object") return { errors: [{ message: "gateway returned a non-JSON body" }] };

    const out: SubgraphResponse = { ...body };
    if (opts.chainHead) out.chainHead = await opts.chainHead();

    // A block-pinned `_meta` has a number and nothing else. Fill the header in from the RPC so the
    // observation's source timestamp is the block's, which is what "true at block N" means.
    const meta = out.data?._meta;
    if (meta && (meta.block.hash === null || meta.block.timestamp === null) && opts.blockAt) {
      const header = await opts.blockAt(meta.block.number);
      out.data = { ...out.data, _meta: { ...meta, block: { number: meta.block.number, hash: header.hash, timestamp: header.timestamp } } };
    }
    return out;
  };
}

/** Belt and braces: no text that leaves this module may carry the key. */
function scrub(text: string, apiKey: string): string {
  if (!text) return text;
  const withoutKey = text.split(apiKey).join("[redacted]");
  return HEX32.test(withoutKey.trim()) ? "[redacted]" : withoutKey;
}
