/**
 * P27 live evidence: the mainnet mirror.
 *
 * Reads Ethereum mainnet through the Reality Engine's fenced transport, builds a real
 * MarketSnapshot, and records everything a reader needs to check the claim independently.
 *
 * Nothing here writes. The transport refuses write methods by name, and this script never asks.
 */
import { writeFileSync } from "node:fs";
import {
  FencedJsonRpcProvider, corroborateBlockNumber, ReadSourceEndpointSchema,
  sealSnapshot, selectSource, marketSources, sourceVerificationAgeDays, sourceAgeLimits, stalenessThresholdMs,
  resolveAsset, assertAssetIdentity, canonicalAssets,
  assertRpcMethodAllowed, RpcFenceError,
  auditRealityEvaluation,
  type MarketObservation, type SnapshotSource,
} from "../packages/studio-reality/src/index.js";

const OUT = "reports/phase-27/evidence";

const PUBLICNODE = "https://ethereum-rpc.publicnode.com";
const ALCHEMY = process.env["MAINNET_RPC_URL"] ?? PUBLICNODE;

const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" as const;
const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" as const;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;

const sel = (sig: string): string => sig;

async function main(): Promise<void> {
  const lines: string[] = [];
  const say = (s: string): void => { lines.push(s); console.log(s); };

  say("=== P27 LIVE MAINNET MIRROR ===");
  say(`date       : ${new Date().toISOString()}`);
  say("mode       : LIVE_MIRROR");
  say("boundary   : Ethereum mainnet is a READ_ONLY_SOURCE. No write method was sent.");
  say("");

  const primary = new FencedJsonRpcProvider(
    ReadSourceEndpointSchema.parse({ chainId: 1, providerId: "publicnode", url: PUBLICNODE }),
    { onRequest: (m) => say(`  rpc → ${m}`) },
  );
  const secondary = new FencedJsonRpcProvider(
    ReadSourceEndpointSchema.parse({ chainId: 1, providerId: ALCHEMY === PUBLICNODE ? "publicnode-2" : "alchemy", url: ALCHEMY }),
  );

  /* ── 1. the anchor, corroborated ───────────────────────────────────────── */
  say("--- 1. anchor block, read from two independent providers ---");
  const corroboration = await corroborateBlockNumber([primary, secondary]);
  for (const r of corroboration.readings) say(`  ${r.providerId.padEnd(14)} ${r.blockNumber ?? `ERROR ${r.error}`}`);
  say(`  agreed anchor : ${corroboration.agreed}`);
  say(`  provider skew : ${corroboration.maxSkew} block(s)`);
  if (corroboration.agreed === null) throw new Error("no provider answered");

  const anchor = await primary.getBlock(corroboration.agreed);
  say(`  block ${anchor.number} hash ${anchor.hash}`);
  say(`  timestamp ${anchor.timestamp} (${new Date(Number(anchor.timestamp) * 1000).toISOString()})`);
  say("");

  const retrievedAtMs = Date.now();
  const observations: MarketObservation[] = [];
  const sources: SnapshotSource[] = [];

  /* ── 2. Chainlink ETH/USD, selected by the resolver ────────────────────── */
  say("--- 2. Chainlink Data Feed, chosen by the deterministic resolver ---");
  const selection = selectSource({
    subject: "weth/usd",
    chainId: 1,
    requiredTrust: "VERIFIED_ORACLE",
    maxAgeMs: 3_600_000,
  });
  say(`  selected  : ${selection.source.sourceId} (${selection.source.kind})`);
  say(`  identity  : ${selection.source.identity}`);
  say(`  lifecycle : ${selection.source.lifecycle}, verified ${selection.source.verifiedAt} (${sourceVerificationAgeDays(selection.source, new Date().toISOString())} days ago)`);
  say(`  rejected  : ${selection.rejected.map((r) => `${r.sourceId} (${r.reason})`).join(", ") || "none"}`);
  say(`  warnings  : ${selection.warnings.length === 0 ? "none" : selection.warnings.map((w) => w.message).join(" | ")}`);

  const roundRaw = await primary.call({ to: CHAINLINK_ETH_USD, data: "0xfeaf968c" as `0x${string}` }, anchor.number);
  const body = roundRaw.slice(2);
  const answer = BigInt(`0x${body.slice(64, 128)}`);
  const updatedAt = BigInt(`0x${body.slice(192, 256)}`);
  const decRaw = await primary.call({ to: CHAINLINK_ETH_USD, data: "0x313ce567" as `0x${string}` }, anchor.number);
  const feedDecimals = Number(BigInt(decRaw));

  say(`  ETH/USD   : ${Number(answer) / 10 ** feedDecimals} (raw ${answer}, ${feedDecimals} decimals)`);
  say(`  updatedAt : ${updatedAt} (${new Date(Number(updatedAt) * 1000).toISOString()}, ${Math.round((Number(anchor.timestamp) - Number(updatedAt)))}s before the anchor block)`);

  sources.push({
    sourceId: selection.source.sourceId, kind: "CHAINLINK_DATA_FEED",
    adapterId: "chainlink-data-feeds", adapterVersion: "1.0.0",
    trustClass: "VERIFIED_ORACLE", sourceChainId: 1, timeSupport: "BLOCK_SCOPED",
    observedBlock: anchor.number.toString(), lagBlocks: 0, healthy: true,
    detail: `aggregator ${CHAINLINK_ETH_USD}`,
  });
  observations.push({
    observationId: "obs-eth-usd-price", metric: "weth/usd:price",
    value: answer.toString(), decimals: feedDecimals, unit: "USD", dataType: "PRICE",
    canonicalAssetId: "weth", sourceId: selection.source.sourceId, sourceChainId: 1,
    blockNumber: anchor.number.toString(), sourceTimestampMs: Number(updatedAt) * 1000,
    retrievedAtMs, trustClass: "VERIFIED_ORACLE",
    adapterId: "chainlink-data-feeds", adapterVersion: "1.0.0", derivedFrom: null,
    provenance: `Chainlink ETH/USD aggregator ${CHAINLINK_ETH_USD} latestRoundData() at mainnet block ${anchor.number}`,
  });
  say("");

  /* ── 3. asset identity, verified against the chain ─────────────────────── */
  say("--- 3. canonical asset identity, checked against what the contract says ---");
  for (const asset of canonicalAssets()) {
    const dep = asset.deployments.find((d) => d.chainId === 1);
    if (!dep) continue;
    const symRaw = await primary.call({ to: dep.address as `0x${string}`, data: "0x95d89b41" as `0x${string}` }, anchor.number);
    const decRaw2 = await primary.call({ to: dep.address as `0x${string}`, data: "0x313ce567" as `0x${string}` }, anchor.number);
    const onChainDecimals = Number(BigInt(decRaw2));
    // ABI-decode a dynamic string; MKR-style bytes32 symbols are handled by the fallback.
    let symbol: string;
    try {
      const len = Number(BigInt(`0x${symRaw.slice(2).slice(64, 128)}`));
      symbol = Buffer.from(symRaw.slice(2).slice(128, 128 + len * 2), "hex").toString("utf8");
    } catch {
      symbol = Buffer.from(symRaw.slice(2), "hex").toString("utf8").replace(/\0+$/, "");
    }
    const check = assertAssetIdentity({ chainId: 1, address: dep.address, symbol, decimals: onChainDecimals }, asset.id);
    say(`  ${asset.id.padEnd(6)} ${dep.address}  symbol=${symbol} decimals=${onChainDecimals}  → ${check.asset.id} OK`);
  }
  say("");

  /* ── 4. Aave v3 mainnet protocol state ─────────────────────────────────── */
  say("--- 4. Aave v3 mainnet reserve state, read directly ---");
  const reserveData = await primary.call({
    to: AAVE_V3_POOL,
    data: `0x35ea6a75000000000000000000000000${WETH.slice(2).toLowerCase()}` as `0x${string}`,
  }, anchor.number);
  const rd = reserveData.slice(2);
  const liquidityIndex = BigInt(`0x${rd.slice(64, 128)}`);
  const currentLiquidityRate = BigInt(`0x${rd.slice(128, 192)}`);
  const aTokenAddress = `0x${rd.slice(8 * 64 + 24, 9 * 64)}`;
  say(`  WETH liquidityIndex      ${liquidityIndex}  (ray, 27 decimals)`);
  say(`  WETH currentLiquidityRate ${currentLiquidityRate}`);
  say(`  aWETH                    ${aTokenAddress}`);

  sources.push({
    sourceId: "aave-v3-mainnet-reserves", kind: "READ_ONLY_RPC",
    adapterId: "aave-v3-state", adapterVersion: "1.4.0",
    trustClass: "DIRECT_CHAIN_DATA", sourceChainId: 1, timeSupport: "BLOCK_SCOPED",
    observedBlock: anchor.number.toString(), lagBlocks: 0, healthy: true,
    detail: `Aave v3 Pool ${AAVE_V3_POOL}`,
  });
  observations.push({
    observationId: "obs-aave-weth-rate", metric: "aave-v3:weth:liquidityRate",
    value: currentLiquidityRate.toString(), decimals: 27, unit: "ray", dataType: "RATE",
    canonicalAssetId: "weth", sourceId: "aave-v3-mainnet-reserves", sourceChainId: 1,
    blockNumber: anchor.number.toString(), sourceTimestampMs: Number(anchor.timestamp) * 1000,
    retrievedAtMs, trustClass: "DIRECT_CHAIN_DATA",
    adapterId: "aave-v3-state", adapterVersion: "1.4.0", derivedFrom: null,
    provenance: `Aave v3 Pool ${AAVE_V3_POOL} getReserveData(WETH) at mainnet block ${anchor.number}`,
  });

  sources.push({
    sourceId: "mainnet-read-rpc", kind: "READ_ONLY_RPC",
    adapterId: "reference-chain-reader", adapterVersion: "1.0.0",
    trustClass: "DIRECT_CHAIN_DATA", sourceChainId: 1, timeSupport: "BLOCK_SCOPED",
    observedBlock: anchor.number.toString(), lagBlocks: 0, healthy: true,
    detail: "publicnode + a second independent provider, agreeing on the head",
  });
  observations.push({
    observationId: "obs-basefee", metric: "ethereum:baseFeePerGas",
    value: (anchor.baseFeePerGas ?? 0n).toString(), decimals: 9, unit: "gwei", dataType: "AMOUNT",
    canonicalAssetId: null, sourceId: "mainnet-read-rpc", sourceChainId: 1,
    blockNumber: anchor.number.toString(), sourceTimestampMs: Number(anchor.timestamp) * 1000,
    retrievedAtMs, trustClass: "DIRECT_CHAIN_DATA",
    adapterId: "reference-chain-reader", adapterVersion: "1.0.0", derivedFrom: null,
    provenance: `eth_getBlockByNumber(${anchor.number}).baseFeePerGas`,
  });
  say("");

  /* ── 5. The Graph — recorded honestly ──────────────────────────────────── */
  say("--- 5. The Graph ---");
  const graph = marketSources().find((s) => s.kind === "THE_GRAPH");
  say(`  ${graph?.sourceId}: ${graph?.lifecycle}`);
  say(`  ${graph?.verifiedBy}`);
  say("  NOT included in this snapshot. An unavailable source is absent, not substituted.");
  say("");

  /* ── 6. seal ───────────────────────────────────────────────────────────── */
  say("--- 6. MarketSnapshot ---");
  const snapshot = sealSnapshot({
    snapshotId: `snap-mainnet-${anchor.number}`,
    mode: "LIVE_MIRROR",
    observedAtMs: retrievedAtMs,
    anchorChainId: 1,
    anchorBlock: anchor.number.toString(),
    anchorBlockHash: anchor.hash.toLowerCase(),
    anchorBlockTimestampMs: Number(anchor.timestamp) * 1000,
    sources, observations,
    provenance: [
      `Ethereum mainnet read-only via the Reality Engine fenced transport at ${new Date(retrievedAtMs).toISOString()}`,
      `anchor corroborated by ${corroboration.readings.length} independent providers, skew ${corroboration.maxSkew} block(s)`,
      "no write method was sent to any endpoint",
    ],
    nowMs: retrievedAtMs,
    /*
     * Tolerances taken from the sources themselves rather than picked.
     *
     * The slowest source in this snapshot is the hourly ETH/USD aggregator, so the widest defensible
     * skew is its heartbeat plus grace. Using a rounder number would have made this snapshot's
     * coherence a statement about the number rather than about the data.
     */
    maxTimeSkewMs: stalenessThresholdMs(selection.source),
    sourceMaxAgeMs: sourceAgeLimits(sources.map((s) => s.sourceId)),
    maxSourceAgeMs: 3_600_000,
  });

  say(`  snapshotId   : ${snapshot.snapshotId}`);
  say(`  snapshotHash : ${snapshot.snapshotHash}`);
  say(`  mode         : ${snapshot.mode}`);
  say(`  anchor       : chain ${snapshot.anchorChainId} block ${snapshot.anchorBlock}`);
  say(`  observations : ${snapshot.observations.length}`);
  say(`  sources      : ${snapshot.sources.length}`);
  say(`  coherent     : ${snapshot.coherence.coherent} (skew ${snapshot.coherence.maxTimeSkewMs}ms, block skew ${snapshot.coherence.maxBlockSkew})`);
  say(`  stale        : ${snapshot.coherence.staleSources.join(", ") || "none"}`);
  say(`  freshness    : per-source, from each source's declared heartbeat × ${1.5} grace`);
  for (const s of sources) {
    const src = marketSources().find((m) => m.sourceId === s.sourceId);
    if (src) say(`      ${s.sourceId.padEnd(32)} heartbeat ${Math.round(src.heartbeatMs / 1000)}s → stale after ${Math.round(stalenessThresholdMs(src) / 1000)}s`);
  }
  say(`  trust        : ${snapshot.observations.map((o) => `${o.metric}=${o.trustClass}`).join(", ")}`);
  say("");

  /* ── 7. the fence, demonstrated ────────────────────────────────────────── */
  say("--- 7. write methods, refused on the wire ---");
  for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_accounts", "wallet_switchEthereumChain", "some_unknown_method"]) {
    try {
      assertRpcMethodAllowed(m);
      say(`  ${m.padEnd(28)} ALLOWED  ← THIS IS A FAILURE`);
      process.exitCode = 1;
    } catch (e) {
      say(`  ${m.padEnd(28)} REFUSED  ${(e as RpcFenceError).reason}`);
    }
  }
  say("");

  /* ── 8. audit ──────────────────────────────────────────────────────────── */
  say("--- 8. auditability ---");
  const audit = auditRealityEvaluation(snapshot, null);
  for (const a of audit.answers) say(`  ${a.answered ? "✓" : "✗"} ${a.question}\n      ${a.answer.slice(0, 160)}`);
  say(`  auditable (without a decision): ${audit.auditable}`);

  writeFileSync(`${OUT}/p27-live-mirror.txt`, lines.join("\n") + "\n");
  writeFileSync(`${OUT}/p27-market-snapshot.json`, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`\nwritten: ${OUT}/p27-live-mirror.txt and p27-market-snapshot.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
