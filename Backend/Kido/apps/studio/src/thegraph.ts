import { gatewayTransport, TheGraphSubgraphAdapter, type SubgraphQuery, type SubgraphResponse } from "@contextlock/studio-adapters";
import { createPublicClient, http } from "viem";
import type { IndexedReader } from "./fork/deployer.js";
import { studioSecret } from "./secrets.js";
import { mainnet } from "viem/chains";

/**
 * The Graph, as this Studio runs it.
 *
 * One credential, `THEGRAPH_API_KEY`, held by the Studio backend — under the Ledger Key Ring when
 * the operator has put it there (see ./secrets.ts), otherwise in the environment — and never read
 * from a request. When it is held the subgraph adapter gets a real gateway transport and the
 * reality layer's Graph source counts as available; when it is not, the adapter has no transport,
 * refuses to fabricate, and every screen says the source is unavailable and why (BLK-V2-GRAPH-KEY).
 *
 * The Token API and Substreams adapters stay modelled: they take a Graph Market JWT rather than a
 * gateway key, and this build has none. Their manifests say so; nothing is substituted.
 */
export const THEGRAPH_SECRET_NAME = "THEGRAPH_API_KEY";

/** The Uniswap v3 mainnet subgraph on the decentralised network. Verified live 2026-09-12. */
export const UNISWAP_V3_MAINNET_SUBGRAPH_ID = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";
/** USDC/WETH 0.05%, the deepest pool on that subgraph: what the market snapshot reads. */
export const USDC_WETH_500_POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";

/** Whether the backend holds the credential at all (env or Key Ring). Never the value. */
export function thegraphConfigured(): boolean {
  return studioSecret(THEGRAPH_SECRET_NAME).source !== "absent";
}

/**
 * The secret names this backend can actually use right now. Values never leave the process.
 * A credential under the Key Ring counts only while the ring on this machine answers: a
 * ciphertext nobody can decrypt is not an available credential, and the screens must not say it is.
 */
export async function availableSecretNames(): Promise<Set<string>> {
  const s = studioSecret(THEGRAPH_SECRET_NAME);
  if (s.source === "absent") return new Set();
  if (s.source === "ledger-key-ring") {
    const v = await s.view();
    return new Set(v.ring?.status === "READY" ? [THEGRAPH_SECRET_NAME] : []);
  }
  return new Set([THEGRAPH_SECRET_NAME]);
}

/**
 * A subgraph adapter with the gateway behind it, or one with no transport when there is no key.
 * `upstreamRpcUrl` is where the chain head and block headers come from: OUR view of mainnet,
 * so the indexer's lag is measured against something the indexer did not report.
 */
export function subgraphAdapter(upstreamRpcUrl: string): TheGraphSubgraphAdapter {
  const secret = studioSecret(THEGRAPH_SECRET_NAME);
  if (secret.source === "absent") return new TheGraphSubgraphAdapter();
  const pub = createPublicClient({ chain: mainnet, transport: http(upstreamRpcUrl) });
  return new TheGraphSubgraphAdapter(gatewayTransport({
    // Resolved per request through the protected source; a Key Ring that cannot decrypt is a
    // refused request with its reason, never a request without a key and never a plaintext copy.
    apiKey: () => secret.withValue(async (v) => v),
    chainHead: async () => Number(await pub.getBlockNumber()),
    blockAt: async (n) => {
      const b = await pub.getBlock({ blockNumber: BigInt(n) });
      return { hash: b.hash, timestamp: Number(b.timestamp) };
    },
  }));
}

/**
 * The fork snapshot's indexed reader: the pool at the fork block, through the adapter's own
 * normalize/validate so a lagging indexer or a malformed answer is refused with its reason code.
 * Null when there is no key — the snapshot then has no THE_GRAPH source at all.
 */
export function indexedReader(upstreamRpcUrl: string): IndexedReader | null {
  if (!thegraphConfigured()) return null;
  const adapter = subgraphAdapter(upstreamRpcUrl);
  const manifest = adapter.manifest();
  return {
    sourceId: "thegraph-uniswap-v3-mainnet",
    adapterId: manifest.id,
    adapterVersion: manifest.version,
    subgraphId: UNISWAP_V3_MAINNET_SUBGRAPH_ID,
    readAt: async (block) => {
      const query: SubgraphQuery = { templateId: "pool-liquidity-at-block", variables: { pool: USDC_WETH_500_POOL, block }, subgraphId: UNISWAP_V3_MAINNET_SUBGRAPH_ID };
      try {
        const raw = await adapter.fetch(query);
        const obs = adapter.normalize(raw, query, { chainId: 1, nowMs: Date.now() });
        const v = adapter.validate(obs);
        if (!v.ok) return { ok: false, reason: v.problems.map((p) => `${p.code}: ${p.message}`).join("; ") };
        return {
          ok: true,
          value: obs.value,
          indexedBlock: obs.provenance.indexedBlock ?? String(block),
          lagBlocks: obs.provenance.blockLag ?? null,
          sourceTimestampMs: obs.provenance.sourceTimestamp ? Date.parse(obs.provenance.sourceTimestamp) : null,
          deployment: obs.provenance.subgraphId ?? null,
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
  };
}

export type { SubgraphQuery, SubgraphResponse };
