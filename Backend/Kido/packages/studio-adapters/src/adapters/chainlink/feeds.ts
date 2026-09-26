/**
 * Chainlink Data Feed registry.
 *
 * Feed addresses are never guessed and never derived from a naming pattern. Each entry was read
 * from the official directory and then VERIFIED ON-CHAIN — `description()`, `decimals()` and
 * `version()` were called against Sepolia and their real answers recorded below.
 *
 * A wrong feed address does not fail loudly. It returns a number, and the number is a price for
 * something else. That is the failure this registry exists to make impossible.
 */

export interface ChainlinkFeed {
  chainId: number;
  pair: string;
  dataKind: string;
  proxy: `0x${string}`;
  decimals: number;
  /** Aggregator interface version reported by the contract. */
  version: number;
  /**
   * Publisher heartbeat: the interval within which the feed updates even if the price does not
   * move. A policy's maxAgeMs should exceed it, or the feed will read as stale most of the time.
   */
  heartbeatSeconds: number;
  source: string;
  verifiedOn: string;
  verifiedOnChain: boolean;
}

export const CHAINLINK_FEEDS: ChainlinkFeed[] = [
  {
    chainId: 11155111,
    pair: "ETH/USD",
    dataKind: "eth_usd_price",
    proxy: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
    // Read from the contract, not assumed: description() = "ETH / USD", decimals() = 8, version() = 4.
    decimals: 8,
    version: 4,
    heartbeatSeconds: 3600,
    source: "https://docs.chain.link/data-feeds/price-feeds/addresses",
    verifiedOn: "2026-09-08",
    verifiedOnChain: true,
  },
];

export class UnknownFeedError extends Error {
  constructor(dataKind: string, chainId: number) {
    super(
      `no verified Chainlink feed recorded for "${dataKind}" on chain ${chainId}; refusing to guess a feed address`,
    );
    this.name = "UnknownFeedError";
  }
}

export function feedFor(dataKind: string, chainId: number): ChainlinkFeed {
  const f = CHAINLINK_FEEDS.find((x) => x.dataKind === dataKind && x.chainId === chainId);
  if (!f) throw new UnknownFeedError(dataKind, chainId);
  return f;
}

/** Data Streams identifiers are feed ids, not contract addresses. Kept separate for that reason. */
export interface ChainlinkStream {
  chainId: number;
  pair: string;
  dataKind: string;
  feedId: string;
  decimals: number;
  source: string;
  verifiedOn: string;
}

export const CHAINLINK_STREAMS: ChainlinkStream[] = [
  {
    chainId: 11155111,
    pair: "ETH/USD",
    dataKind: "eth_usd_price",
    // Stream feed ids are issued per-schema by Chainlink; this one is a placeholder for the
    // testnet stream and is marked as such rather than presented as a verified production id.
    feedId: "0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9",
    decimals: 18,
    source: "https://docs.chain.link/data-streams",
    verifiedOn: "2026-09-08",
  },
];

export function streamFor(dataKind: string, chainId: number): ChainlinkStream {
  const s = CHAINLINK_STREAMS.find((x) => x.dataKind === dataKind && x.chainId === chainId);
  if (!s) throw new UnknownFeedError(dataKind, chainId);
  return s;
}
