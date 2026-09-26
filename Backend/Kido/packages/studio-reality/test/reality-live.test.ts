import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { MarketSnapshotSchema, verifySnapshotHash, computeSnapshotHash, type MarketSnapshot } from "../src/index.js";

/**
 * The recorded live evidence, asserted.
 *
 * The evidence files are what the P27 report cites. Asserting them here means a file that goes
 * missing, gets truncated, or is edited to claim something it did not show is a test failure rather
 * than a discrepancy nobody notices.
 *
 * These do not hit the network. `CONTEXTLOCK_LIVE_MAINNET=1 npx tsx scripts/p27-live-mirror.ts` and
 * `scripts/p27-fork.ts` are what produce the files.
 */

const ev = (name: string): string => new URL(`../../../reports/phase-27/evidence/${name}`, import.meta.url).pathname;

describe("REALITY-LIVE the mainnet mirror evidence", () => {
  it("REALITY-LIVE-001 the recorded snapshot is a valid, self-consistent MarketSnapshot", () => {
    const path = ev("p27-market-snapshot.json");
    expect(existsSync(path), `${path} is missing — the P27 report cites it`).toBe(true);
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as MarketSnapshot;

    expect(MarketSnapshotSchema.safeParse(snapshot).success).toBe(true);
    // Recomputed from the file's own contents: the hash is checkable, not decorative.
    expect(() => verifySnapshotHash(snapshot)).not.toThrow();
    const { snapshotHash, ...body } = snapshot;
    expect(computeSnapshotHash(body)).toBe(snapshotHash);
  });

  it("REALITY-LIVE-002 it is anchored on real mainnet, with a real block hash", () => {
    const snapshot = JSON.parse(readFileSync(ev("p27-market-snapshot.json"), "utf8")) as MarketSnapshot;
    expect(snapshot.mode).toBe("LIVE_MIRROR");
    expect(snapshot.anchorChainId).toBe(1);
    expect(Number(snapshot.anchorBlock)).toBeGreaterThan(20_000_000);
    expect(snapshot.anchorBlockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(snapshot.anchorBlockHash).not.toBe(`0x${"0".repeat(64)}`);
  });

  it("REALITY-LIVE-003 it carries a real verified-oracle reading with its own timestamp", () => {
    const snapshot = JSON.parse(readFileSync(ev("p27-market-snapshot.json"), "utf8")) as MarketSnapshot;
    const price = snapshot.observations.find((o) => o.metric === "weth/usd:price");
    expect(price?.trustClass).toBe("VERIFIED_ORACLE");
    expect(price?.decimals).toBe(8);
    expect(price?.provenance).toMatch(/0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419/);

    // A plausible ETH price, so a zero or a decimal mistake would fail rather than pass quietly.
    const usd = Number(BigInt(price!.value)) / 10 ** price!.decimals;
    expect(usd).toBeGreaterThan(100);
    expect(usd).toBeLessThan(100_000);

    // The source's own `updatedAt`, distinct from when we fetched it. That difference is freshness.
    expect(price?.sourceTimestampMs).toBeTypeOf("number");
    expect(price?.sourceTimestampMs).not.toBe(price?.retrievedAtMs);
  });

  it("REALITY-LIVE-004 nothing synthetic is in a live-mirror snapshot", () => {
    const snapshot = JSON.parse(readFileSync(ev("p27-market-snapshot.json"), "utf8")) as MarketSnapshot;
    for (const o of snapshot.observations) {
      expect(o.derivedFrom, `${o.metric} is derived, in a LIVE_MIRROR snapshot`).toBeNull();
      expect(o.trustClass, o.metric).not.toBe("USER_UNTRUSTED");
    }
  });

  it("REALITY-LIVE-005 the run demonstrated every write method being refused", () => {
    const text = readFileSync(ev("p27-live-mirror.txt"), "utf8");
    for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_accounts", "wallet_switchEthereumChain"]) {
      expect(text, m).toMatch(new RegExp(`${m}\\s+REFUSED`));
    }
    expect(text).toMatch(/some_unknown_method\s+REFUSED\s+RPC_METHOD_NOT_ON_READ_ALLOWLIST/);
    expect(text, "no method may be reported as allowed").not.toMatch(/ALLOWED\s+←/);
  });

  it("REALITY-LIVE-006 the anchor was corroborated by two independent providers", () => {
    const text = readFileSync(ev("p27-live-mirror.txt"), "utf8");
    expect(text).toMatch(/agreed anchor\s+: \d+/);
    expect(text).toMatch(/provider skew\s+: \d+ block/);
  });

  it("REALITY-LIVE-007 The Graph is recorded as unavailable rather than substituted", () => {
    const text = readFileSync(ev("p27-live-mirror.txt"), "utf8");
    expect(text).toMatch(/thegraph-uniswap-v3-mainnet: UNAVAILABLE/);
    expect(text).toMatch(/NOT included in this snapshot/);
    const snapshot = JSON.parse(readFileSync(ev("p27-market-snapshot.json"), "utf8")) as MarketSnapshot;
    expect(snapshot.sources.some((s) => s.kind === "THE_GRAPH")).toBe(false);
  });
});

describe("REALITY-LIVE the fork evidence", () => {
  const forkJson = (): {
    forkId: string; anvilVersion: string; sourceChainId: number; forkChainId: number;
    forkBlock: string; forkBlockHash: string; upstreamBlockHash: string; anchorVerified: boolean;
    aaveLiquidityIndex: string;
    transactions: Array<{ name: string; hash: string; label: string; explorerUrl: string | null; status?: string }>;
    balances: Record<string, string>;
    publicMainnetWrite: string;
    destroyed: boolean;
  } => JSON.parse(readFileSync(ev("p27-fork.json"), "utf8"));

  it("FORK-LIVE-001 a real Anvil forked mainnet at an exact block, verified against upstream", () => {
    const f = forkJson();
    expect(f.anvilVersion).toMatch(/^anvil\/v\d+\.\d+\.\d+/);
    expect(f.forkBlock).toMatch(/^\d+$/);
    expect(f.forkBlockHash).toMatch(/^0x[0-9a-f]{64}$/);
    // The anchor was checked against a hash read from a different client, not asserted.
    expect(f.forkBlockHash).toBe(f.upstreamBlockHash.toLowerCase());
    expect(f.anchorVerified).toBe(true);
  });

  it("FORK-LIVE-002 the fork's chain id is 31337 and its source is 1", () => {
    const f = forkJson();
    expect(f.forkChainId).toBe(31337);
    expect(f.sourceChainId).toBe(1);
  });

  it("FORK-LIVE-003 real mainnet protocol state was present, so it is not an empty Anvil", () => {
    const f = forkJson();
    // Aave's WETH liquidity index is a ray above 1e27 on a real mainnet fork, and 0 on an empty node.
    expect(BigInt(f.aaveLiquidityIndex)).toBeGreaterThan(10n ** 27n);
  });

  it("FORK-LIVE-004 real transactions ran, and every one is labelled local with no explorer link", () => {
    const f = forkJson();
    expect(f.transactions.length).toBeGreaterThanOrEqual(2);
    for (const tx of f.transactions) {
      expect(tx.hash, tx.name).toMatch(/^0x[0-9a-f]{64}$/);
      expect(tx.label, tx.name).toBe("LOCAL FORK TRANSACTION");
      expect(tx.explorerUrl, tx.name).toBeNull();
    }
  });

  it("FORK-LIVE-005 a real Uniswap v3 swap moved real balances", () => {
    const f = forkJson();
    const swap = f.transactions.find((t) => t.name === "uniswap-v3-swap");
    expect(swap?.status).toBe("success");
    // WETH was wrapped and USDC arrived: state actually changed on the fork.
    expect(BigInt(f.balances["wethAfter"] ?? "0")).toBeGreaterThan(BigInt(f.balances["wethBefore"] ?? "0"));
    expect(BigInt(f.balances["usdcAfter"] ?? "0")).toBeGreaterThan(BigInt(f.balances["usdcBefore"] ?? "0"));
  });

  it("FORK-LIVE-006 the swap price agrees with the oracle within a plausible spread", () => {
    /*
     * A cross-check the two evidence files make possible: the fork executed a real swap and the
     * mirror recorded a verified oracle price. They should differ by the pool fee plus impact and
     * nothing like an order of magnitude — which is what a decimals mistake would look like.
     */
    const f = forkJson();
    const snapshot = JSON.parse(readFileSync(ev("p27-market-snapshot.json"), "utf8")) as MarketSnapshot;
    const price = snapshot.observations.find((o) => o.metric === "weth/usd:price")!;
    const oracleUsd = Number(BigInt(price.value)) / 10 ** price.decimals;

    const usdcOut = Number(BigInt(f.balances["usdcAfter"] ?? "0") - BigInt(f.balances["usdcBefore"] ?? "0")) / 1e6;
    // One WETH was swapped in the evidence run.
    const spreadPct = Math.abs(usdcOut - oracleUsd) / oracleUsd * 100;
    expect(spreadPct, `swap ${usdcOut} vs oracle ${oracleUsd}`).toBeLessThan(3);
  });

  it("FORK-LIVE-007 the same action aimed at mainnet was refused, and the fork was destroyed", () => {
    const f = forkJson();
    expect(f.publicMainnetWrite).toBe("PRODUCTION_NETWORK_WRITE_PROHIBITED");
    expect(f.destroyed).toBe(true);

    const text = readFileSync(ev("p27-fork.txt"), "utf8");
    expect(text).toMatch(/fence RELAYER chain 1\s+: PRODUCTION_NETWORK_WRITE_PROHIBITED/);
    expect(text).toMatch(/fence AGENT_RUNTIME chain 1\s+: PRODUCTION_NETWORK_WRITE_PROHIBITED/);
    expect(text).toMatch(/submitToPublicMainnet\(\.\.\.\)\s+: NO_PUBLIC_MAINNET_SUBMISSION_PATH/);
    expect(text).toMatch(/endpoint reachable\s+: false/);
    expect(text, "nothing may be reported as a failure").not.toMatch(/← FAILURE/);
  });

  it("FORK-LIVE-008 no mainnet explorer URL appears anywhere in the fork evidence", () => {
    const text = readFileSync(ev("p27-fork.txt"), "utf8");
    expect(text).not.toMatch(/\/\/etherscan\.io/);
    expect(text).toMatch(/explorer URL: none — refused for a local fork/);
  });
});
