import {
  assertRpcMethodAllowed, assertReadSourceAllowed, assertNoSignerCredential,
  RpcFenceError, RPC_FENCE_REASONS,
  type BlockRef, type Hex, type ReadOnlyChainProvider, type ReadSourceEndpoint, type RpcBlock, type RpcLog,
} from "./rpc.js";
import { lookupNetwork } from "@contextlock/studio-network";

/**
 * The JSON-RPC transport, fenced.
 *
 * One function puts bytes on the wire, and it calls `assertRpcMethodAllowed` before it does. That
 * is the whole design: not "the read client happens to only call read methods", but "no method
 * leaves this process without passing the fence", so a caller reaching past the typed interface
 * still hits it.
 */

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
}

export interface TransportDeps {
  fetchFn?: FetchLike;
  nowMs?: () => number;
  /** Called with every method that reaches the wire. The audit trail for REALITY-004/005. */
  onRequest?: (method: string, params: unknown[]) => void;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

const hexToBigInt = (v: unknown): bigint => {
  if (typeof v === "string") return BigInt(v);
  if (typeof v === "number") return BigInt(v);
  throw new Error(`expected a quantity, got ${typeof v}`);
};

const blockParam = (ref: BlockRef | undefined): string =>
  ref === undefined ? "latest" : typeof ref === "bigint" ? `0x${ref.toString(16)}` : ref;

/**
 * A read-only JSON-RPC client.
 *
 * Implements `ReadOnlyChainProvider` — which has no write members — and additionally refuses write
 * methods at `request()`. Both guards are exercised independently: `REALITY-007` enumerates the
 * instance's own members, `REALITY-005` puts a write method through `request()` directly.
 */
export class FencedJsonRpcProvider implements ReadOnlyChainProvider {
  readonly chainId: number;
  readonly canonicalName: string;
  readonly providerId: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private id = 0;

  constructor(private readonly endpoint: ReadSourceEndpoint, private readonly deps: TransportDeps = {}) {
    // The endpoint is checked for credentials before anything is kept from it, so a config object
    // carrying a key is rejected rather than partially adopted.
    assertNoSignerCredential(endpoint, `read source ${endpoint.providerId}`);
    assertReadSourceAllowed(endpoint.chainId, `read source ${endpoint.providerId}`);

    this.chainId = endpoint.chainId;
    this.providerId = endpoint.providerId;
    this.canonicalName = lookupNetwork(endpoint.chainId)?.canonicalName ?? `chain-${endpoint.chainId}`;
    this.url = endpoint.url;
    this.timeoutMs = endpoint.timeoutMs;
  }

  /**
   * The single exit point.
   *
   * Public on purpose: a caller that wants to issue a method this client does not wrap can, and
   * gets the fence. Making it private would push such callers to build their own transport, which
   * is how a boundary acquires a way around it.
   */
  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    assertRpcMethodAllowed(method);
    this.deps.onRequest?.(method, params);

    const fetchFn = this.deps.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const res = await fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res.ok) throw new Error(`${this.providerId} returned HTTP ${res.status} for ${method}`);
      const body = (await res.json()) as JsonRpcResponse;
      if (body.error) throw new Error(`${this.providerId} rejected ${method}: ${body.error.message} (${body.error.code})`);
      return body.result as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getBlockNumber(): Promise<bigint> {
    return hexToBigInt(await this.request<string>("eth_blockNumber"));
  }

  async getBlock(ref: BlockRef): Promise<RpcBlock> {
    const raw = await this.request<Record<string, unknown> | null>("eth_getBlockByNumber", [blockParam(ref), false]);
    if (!raw) throw new Error(`${this.providerId}: block ${String(ref)} not found`);
    return {
      number: hexToBigInt(raw["number"]),
      hash: raw["hash"] as Hex,
      parentHash: raw["parentHash"] as Hex,
      timestamp: hexToBigInt(raw["timestamp"]),
      baseFeePerGas: raw["baseFeePerGas"] ? hexToBigInt(raw["baseFeePerGas"]) : null,
      gasUsed: hexToBigInt(raw["gasUsed"]),
      gasLimit: hexToBigInt(raw["gasLimit"]),
    };
  }

  async getBalance(address: Hex, ref?: BlockRef): Promise<bigint> {
    return hexToBigInt(await this.request<string>("eth_getBalance", [address, blockParam(ref)]));
  }

  async call(tx: { to: Hex; data: Hex; from?: Hex }, ref?: BlockRef): Promise<Hex> {
    // `from` is passed as `from` because this is raw JSON-RPC, where that is the field's name.
    // FND-V2-E-004 was the opposite translation going wrong; the lesson is to be explicit either way.
    const payload: Record<string, string> = { to: tx.to, data: tx.data };
    if (tx.from) payload["from"] = tx.from;
    return this.request<Hex>("eth_call", [payload, blockParam(ref)]);
  }

  async getLogs(filter: { address?: Hex | Hex[]; topics?: (Hex | Hex[] | null)[]; fromBlock: BlockRef; toBlock: BlockRef }): Promise<RpcLog[]> {
    const raw = await this.request<Array<Record<string, unknown>>>("eth_getLogs", [{
      ...(filter.address ? { address: filter.address } : {}),
      ...(filter.topics ? { topics: filter.topics } : {}),
      fromBlock: blockParam(filter.fromBlock),
      toBlock: blockParam(filter.toBlock),
    }]);
    return raw.map((l) => ({
      address: l["address"] as Hex,
      topics: l["topics"] as Hex[],
      data: l["data"] as Hex,
      blockNumber: hexToBigInt(l["blockNumber"]),
      transactionHash: l["transactionHash"] as Hex,
      logIndex: Number(hexToBigInt(l["logIndex"])),
    }));
  }

  async getCode(address: Hex, ref?: BlockRef): Promise<Hex> {
    return this.request<Hex>("eth_getCode", [address, blockParam(ref)]);
  }

  async getStorageAt(address: Hex, slot: Hex, ref?: BlockRef): Promise<Hex> {
    return this.request<Hex>("eth_getStorageAt", [address, slot, blockParam(ref)]);
  }

  async getTransactionReceipt(hash: Hex): Promise<{ blockNumber: bigint; status: "success" | "reverted" } | null> {
    const raw = await this.request<Record<string, unknown> | null>("eth_getTransactionReceipt", [hash]);
    if (!raw) return null;
    return { blockNumber: hexToBigInt(raw["blockNumber"]), status: raw["status"] === "0x1" ? "success" : "reverted" };
  }
}

/**
 * Two providers, one question, and the disagreement kept.
 *
 * Used for the anchor block. A single RPC endpoint is one party that can be wrong or lying, and the
 * cheapest available corroboration is a second independent provider. This does not average or vote
 * — §P27.44 forbids that — it returns both and the skew between them, and lets policy decide.
 */
export async function corroborateBlockNumber(
  providers: ReadonlyArray<ReadOnlyChainProvider>,
): Promise<{ readings: Array<{ providerId: string; blockNumber: bigint | null; error: string | null }>; agreed: bigint | null; maxSkew: bigint | null }> {
  const readings = await Promise.all(
    providers.map(async (p) => {
      try {
        return { providerId: p.providerId, blockNumber: await p.getBlockNumber(), error: null };
      } catch (e) {
        return { providerId: p.providerId, blockNumber: null, error: (e as Error).message };
      }
    }),
  );
  const ok = readings.filter((r): r is { providerId: string; blockNumber: bigint; error: null } => r.blockNumber !== null);
  if (ok.length === 0) return { readings, agreed: null, maxSkew: null };

  const numbers = ok.map((r) => r.blockNumber);
  const min = numbers.reduce((a, b) => (b < a ? b : a));
  const max = numbers.reduce((a, b) => (b > a ? b : a));
  // The LOWEST reading is the conservative anchor: every provider has at least that block.
  return { readings, agreed: min, maxSkew: max - min };
}

export { RpcFenceError, RPC_FENCE_REASONS };
