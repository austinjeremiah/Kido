import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import type { spawn } from "node:child_process";
import type { MarketObservation, SnapshotSource, SnapshotInput } from "../src/snapshot.js";
import type { ReadOnlyChainProvider, RpcBlock, Hex, BlockRef } from "../src/rpc.js";

/** A mainnet block that really exists, read live during P27. */
export const REAL_ANCHOR = {
  chainId: 1,
  number: 25948176n,
  hash: "0x681b99ef550b9a9b141cd47f92c4c3ba40a08c037eecabeea58c1e19c9e67bbd" as Hex,
  timestamp: 1789057607n,
} as const;

export const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
export const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";

export const priceObservation = (over: Partial<MarketObservation> = {}): MarketObservation => ({
  observationId: "obs-eth-usd-price",
  metric: "weth/usd:price",
  // The real reading taken during the P27 live mirror run.
  value: "243442066354",
  decimals: 8,
  unit: "USD",
  dataType: "PRICE",
  canonicalAssetId: "weth",
  sourceId: "chainlink-feed-eth-usd-mainnet",
  sourceChainId: 1,
  blockNumber: REAL_ANCHOR.number.toString(),
  sourceTimestampMs: 1789057583000,
  retrievedAtMs: 1789057607000,
  trustClass: "VERIFIED_ORACLE",
  adapterId: "chainlink-data-feeds",
  adapterVersion: "1.0.0",
  derivedFrom: null,
  provenance: `Chainlink ETH/USD aggregator ${CHAINLINK_ETH_USD} latestRoundData()`,
  ...over,
});

export const rateObservation = (over: Partial<MarketObservation> = {}): MarketObservation => ({
  observationId: "obs-aave-weth-rate",
  metric: "aave-v3:weth:liquidityRate",
  value: "14475277820505137424935615",
  decimals: 27,
  unit: "ray",
  dataType: "RATE",
  canonicalAssetId: "weth",
  sourceId: "aave-v3-mainnet-reserves",
  sourceChainId: 1,
  blockNumber: REAL_ANCHOR.number.toString(),
  sourceTimestampMs: Number(REAL_ANCHOR.timestamp) * 1000,
  retrievedAtMs: 1789057607000,
  trustClass: "DIRECT_CHAIN_DATA",
  adapterId: "aave-v3-state",
  adapterVersion: "1.4.0",
  derivedFrom: null,
  provenance: "Aave v3 Pool getReserveData(WETH)",
  ...over,
});

export const feedSource = (over: Partial<SnapshotSource> = {}): SnapshotSource => ({
  sourceId: "chainlink-feed-eth-usd-mainnet",
  kind: "CHAINLINK_DATA_FEED",
  adapterId: "chainlink-data-feeds",
  adapterVersion: "1.0.0",
  trustClass: "VERIFIED_ORACLE",
  sourceChainId: 1,
  timeSupport: "BLOCK_SCOPED",
  observedBlock: REAL_ANCHOR.number.toString(),
  lagBlocks: 0,
  healthy: true,
  detail: `aggregator ${CHAINLINK_ETH_USD}`,
  ...over,
});

export const rpcSource = (over: Partial<SnapshotSource> = {}): SnapshotSource => ({
  sourceId: "aave-v3-mainnet-reserves",
  kind: "READ_ONLY_RPC",
  adapterId: "aave-v3-state",
  adapterVersion: "1.4.0",
  trustClass: "DIRECT_CHAIN_DATA",
  sourceChainId: 1,
  timeSupport: "BLOCK_SCOPED",
  observedBlock: REAL_ANCHOR.number.toString(),
  lagBlocks: 0,
  healthy: true,
  detail: "Aave v3 Pool",
  ...over,
});

export const snapshotInput = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  snapshotId: "snap-test-1",
  mode: "LIVE_MIRROR",
  observedAtMs: 1789057607000,
  anchorChainId: 1,
  anchorBlock: REAL_ANCHOR.number.toString(),
  anchorBlockHash: REAL_ANCHOR.hash,
  anchorBlockTimestampMs: Number(REAL_ANCHOR.timestamp) * 1000,
  sources: [feedSource(), rpcSource()],
  observations: [priceObservation(), rateObservation()],
  provenance: ["test fixture built from the real P27 live-mirror readings"],
  nowMs: 1789057607000,
  maxTimeSkewMs: 5_400_000,
  maxSourceAgeMs: 5_400_000,
  ...over,
});

/* ───────────────────────────── fakes ───────────────────────────── */

/** A read-only provider backed by a fixed block sequence. Timestamps are 12s apart, like mainnet. */
export class FakeChainProvider implements ReadOnlyChainProvider {
  readonly chainId: number;
  readonly canonicalName = "fake";
  readonly providerId: string;
  readonly calls: string[] = [];

  constructor(opts: { chainId?: number; providerId?: string; head?: bigint; genesisMs?: number } = {}) {
    this.chainId = opts.chainId ?? 1;
    this.providerId = opts.providerId ?? "fake";
    this.head = opts.head ?? 1_000_000n;
    this.genesisMs = opts.genesisMs ?? 1_500_000_000_000;
  }
  private readonly head: bigint;
  private readonly genesisMs: number;

  private blockAt(n: bigint): RpcBlock {
    return {
      number: n,
      hash: `0x${n.toString(16).padStart(64, "0")}` as Hex,
      parentHash: `0x${(n - 1n).toString(16).padStart(64, "0")}` as Hex,
      timestamp: BigInt(Math.floor(this.genesisMs / 1000) + Number(n) * 12),
      baseFeePerGas: 1_000_000_000n,
      gasUsed: 15_000_000n,
      gasLimit: 30_000_000n,
    };
  }

  async getBlockNumber(): Promise<bigint> {
    this.calls.push("eth_blockNumber");
    return this.head;
  }
  async getBlock(ref: BlockRef): Promise<RpcBlock> {
    this.calls.push("eth_getBlockByNumber");
    return this.blockAt(typeof ref === "bigint" ? ref : this.head);
  }
  async getBalance(): Promise<bigint> { this.calls.push("eth_getBalance"); return 0n; }
  async call(): Promise<Hex> { this.calls.push("eth_call"); return "0x" as Hex; }
  async getLogs(): Promise<never[]> { this.calls.push("eth_getLogs"); return []; }
  async getCode(): Promise<Hex> { this.calls.push("eth_getCode"); return "0x" as Hex; }
  async getStorageAt(): Promise<Hex> { this.calls.push("eth_getStorageAt"); return "0x" as Hex; }
  async getTransactionReceipt(): Promise<null> { this.calls.push("eth_getTransactionReceipt"); return null; }
}

export class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];
  kill(signal?: string): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
}

export interface AnvilRecorder {
  spawnFn: typeof spawn;
  calls: Array<{ bin: string; args: string[] }>;
  children: FakeChild[];
}

export const anvilRecorder = (): AnvilRecorder => {
  const calls: AnvilRecorder["calls"] = [];
  const children: FakeChild[] = [];
  const spawnFn = ((bin: string, args: string[]) => {
    const c = new FakeChild();
    children.push(c);
    calls.push({ bin, args });
    return c;
  }) as unknown as typeof spawn;
  return { spawnFn, calls, children };
};

/**
 * A scripted Anvil JSON-RPC.
 *
 * `overrides` lets one test change one answer, so an anchor-mismatch fixture differs from a healthy
 * one in exactly one way rather than in several.
 */
export const fakeAnvilRpc = (opts: {
  chainId?: string;
  blockNumber?: bigint;
  blockHash?: string;
  version?: string;
  onSend?: (method: string, params: unknown[]) => void;
} = {}) => {
  const seen: Array<{ method: string; params: unknown[] }> = [];
  const fn = async (_endpoint: string, method: string, params: unknown[] = []): Promise<unknown> => {
    seen.push({ method, params });
    opts.onSend?.(method, params);
    switch (method) {
      case "eth_chainId": return opts.chainId ?? "0x7a69";
      case "web3_clientVersion": return opts.version ?? "anvil/v1.2.3";
      case "eth_getBlockByNumber": {
        const n = opts.blockNumber ?? 25948176n;
        return { number: `0x${n.toString(16)}`, hash: opts.blockHash ?? `0x${"ab".repeat(32)}` };
      }
      case "eth_blockNumber": return `0x${(opts.blockNumber ?? 25948176n).toString(16)}`;
      case "evm_snapshot": return "0x1";
      case "evm_revert": return true;
      case "anvil_reset": return null;
      case "anvil_impersonateAccount": return null;
      case "eth_sendTransaction": return `0x${"cd".repeat(32)}`;
      case "eth_getTransactionReceipt":
        return { blockNumber: `0x${((opts.blockNumber ?? 25948176n) + 1n).toString(16)}`, status: "0x1", gasUsed: "0xafc8", to: null };
      default: return null;
    }
  };
  return { fn, seen };
};

/* ───────────────────────────── source scanning ───────────────────────────── */

/**
 * The repository root, derived from this file rather than from `process.cwd()`.
 *
 * FND-V2-26-001: `process.cwd()` differs between a root run and a per-package run, so a scan keyed
 * on it searches a directory that does not exist and passes by finding nothing. Throwing when the
 * root is wrong makes that loud.
 */
export const repoRoot = (): string => {
  const root = new URL("../../../", import.meta.url).pathname;
  if (!existsSync(`${root}packages`) || !existsSync(`${root}apps`)) {
    throw new Error(`source scan resolved ${root}, which is not the repository root`);
  }
  return root;
};

export interface SourceLine { file: string; line: number; text: string }

export const sourceLines = (pattern: RegExp): SourceLine[] => {
  const out = execSync(
    `grep -rn --exclude-dir=node_modules --exclude-dir=dist ${JSON.stringify(pattern.source)} packages apps scripts 2>/dev/null || true`,
    { cwd: repoRoot(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const m = /^([^:]+):(\d+):(.*)$/.exec(l);
      return m ? { file: m[1] as string, line: Number(m[2]), text: m[3] as string } : null;
    })
    .filter((x): x is SourceLine => x !== null)
    .filter((x) => !x.file.includes("node_modules") && !x.file.includes("/test/") && !x.file.endsWith(".test.ts"));
};

export const isComment = (text: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(text);

/** Volatility and liquidity, so a flash-crash overlay has something to act on. */
export const volatilityObservation = (over: Partial<MarketObservation> = {}): MarketObservation => ({
  observationId: "obs-volatility",
  metric: "market:volatilityBps",
  value: "150",
  decimals: 0,
  unit: "bps",
  dataType: "BPS",
  canonicalAssetId: "weth",
  sourceId: "mainnet-read-rpc",
  sourceChainId: 1,
  blockNumber: REAL_ANCHOR.number.toString(),
  sourceTimestampMs: Number(REAL_ANCHOR.timestamp) * 1000,
  retrievedAtMs: 1789057607000,
  trustClass: "DIRECT_CHAIN_DATA",
  adapterId: "reference-chain-reader",
  adapterVersion: "1.0.0",
  derivedFrom: null,
  provenance: "realised volatility over the trailing window",
  ...over,
});

export const liquidityObservation = (over: Partial<MarketObservation> = {}): MarketObservation => ({
  observationId: "obs-liquidity",
  metric: "market:liquidity",
  value: "9000000000000",
  decimals: 0,
  unit: "USD",
  dataType: "AMOUNT",
  canonicalAssetId: "weth",
  sourceId: "mainnet-read-rpc",
  sourceChainId: 1,
  blockNumber: REAL_ANCHOR.number.toString(),
  sourceTimestampMs: Number(REAL_ANCHOR.timestamp) * 1000,
  retrievedAtMs: 1789057607000,
  trustClass: "DIRECT_CHAIN_DATA",
  adapterId: "pool-liquidity",
  adapterVersion: "1.0.0",
  derivedFrom: null,
  provenance: "Uniswap v3 USDC/WETH 0.05% pool depth",
  ...over,
});

/** A snapshot carrying every metric the stock scenarios touch. */
export const richSnapshotInput = (over: Partial<SnapshotInput> = {}): SnapshotInput => snapshotInput({
  observations: [priceObservation(), rateObservation(), volatilityObservation(), liquidityObservation()],
  sources: [feedSource(), rpcSource(), rpcSource({ sourceId: "mainnet-read-rpc", adapterId: "reference-chain-reader" })],
  ...over,
});
