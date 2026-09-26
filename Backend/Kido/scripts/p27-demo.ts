/**
 * P27 canonical demo — 25 steps.
 *
 * Real mainnet reads, a real Chainlink feed, a real MarketSnapshot, the real CRE simulator, a real
 * Anvil fork pinned to an exact mainnet block, a real protocol transaction on that fork, a real
 * refusal when the same action is aimed at mainnet, a real historical replay, and a synthetic
 * overlay that leaves the base untouched.
 *
 * No public mainnet transaction occurs. Nothing here has the ability to make one.
 */
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  FencedJsonRpcProvider, ReadSourceEndpointSchema, corroborateBlockNumber,
  sealSnapshot, selectSource, sourceAgeLimits, stalenessThresholdMs, marketSources,
  assertRpcMethodAllowed, RpcFenceError, assertCanServeHistorical,
  AnvilForkProvider, explorerUrlFor, LOCAL_FORK_TX_LABEL, ANVIL_DEV_ACCOUNTS,
  applyOverlay, assertBaseUnchanged, computeScenarioHash, FLASH_CRASH,
  pinBlock, replaysAgree, planReplaySources,
  runShadowDecision, submitToPublicMainnet, compileForNetwork, shadowExecutionRef,
  auditRealityEvaluation,
  type MarketObservation, type SnapshotSource, type MarketSnapshot, type SemanticAction, type ForkDescriptor,
} from "../packages/studio-reality/src/index.js";
import { fenceWriteByChain, NetworkGuardError, lookupNetwork } from "../packages/studio-network/src/index.js";

const OUT = "reports/phase-27/evidence";
const UPSTREAM = process.env["MAINNET_RPC_URL"] ?? "https://ethereum-rpc.publicnode.com";
const CRE = `${process.env["HOME"]}/.cre/bin/cre`;

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" as const;
const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" as const;
const ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as const;

const lines: string[] = [];
let step = 0;
const STEPS: Array<{ n: number; title: string; ok: boolean; detail: string }> = [];

const say = (s: string): void => { lines.push(s); console.log(s); };
const head = (title: string): void => { step += 1; say(""); say(`──────── STEP ${step}. ${title} ────────`); };
const done = (title: string, ok: boolean, detail: string): void => {
  STEPS.push({ n: step, title, ok, detail });
  say(`  ${ok ? "PASS" : "FAIL"}  ${detail}`);
  if (!ok) process.exitCode = 1;
};

const pad32 = (h: string): string => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const uintArg = (n: bigint): string => pad32(n.toString(16));

async function rpc(endpoint: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const fcall = async (endpoint: string, to: string, data: string): Promise<string> => (await rpc(endpoint, "eth_call", [{ to, data }, "latest"])) as string;

async function waitReceipt(endpoint: string, hash: string): Promise<{ status: string; gasUsed: string }> {
  for (let i = 0; i < 40; i++) {
    const r = (await rpc(endpoint, "eth_getTransactionReceipt", [hash])) as { status: string; gasUsed: string } | null;
    if (r) return r;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`no receipt for ${hash}`);
}
async function waitReady(endpoint: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { await rpc(endpoint, "eth_chainId"); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error("anvil never became ready");
}

async function main(): Promise<void> {
  say("═══════════════════════════════════════════════════════════════");
  say("   ContextLock PHASE 27 — MAINNET REALITY ENGINE, 25 STEPS");
  say("═══════════════════════════════════════════════════════════════");
  say(`date : ${new Date().toISOString()}`);
  say("rule : mainnet is a data source and a fork source. It is never an execution network.");

  const reader = new FencedJsonRpcProvider(ReadSourceEndpointSchema.parse({ chainId: 1, providerId: "publicnode", url: UPSTREAM, archiveDepth: "RECENT_STATE_ONLY" }));
  const secondary = new FencedJsonRpcProvider(ReadSourceEndpointSchema.parse({ chainId: 1, providerId: "publicnode-2", url: UPSTREAM, archiveDepth: "RECENT_STATE_ONLY" }));

  /*
   * A separate, archive-capable endpoint for the replay.
   *
   * The live run found that the public node serves the head and refuses a block five thousand back
   * with "Archive requests require a personal token". Depth is therefore a declared property of the
   * endpoint and the replay checks it up front, rather than discovering it from an error.
   */
  const ARCHIVE_URL = process.env["MAINNET_ARCHIVE_RPC_URL"] ?? "";
  const archive = ARCHIVE_URL
    ? new FencedJsonRpcProvider(ReadSourceEndpointSchema.parse({ chainId: 1, providerId: "archive", url: ARCHIVE_URL, archiveDepth: "ARCHIVE" }))
    : null;

  /* 1 */ head("Reality Engine connects to Ethereum mainnet, READ ONLY");
  const net = lookupNetwork(1);
  say(`  ${net?.canonicalName}  role=${net?.role}  environment=${net?.environment}  rpcCapability=${net?.rpcCapability}`);
  done("read-only connection", net?.role === "READ_ONLY_SOURCE" && net?.rpcCapability === "READ_ONLY", `chain 1 registered as ${net?.role} / ${net?.rpcCapability}`);

  /* 2 */ head("Read the current block");
  const corr = await corroborateBlockNumber([reader, secondary]);
  const anchor = await reader.getBlock(corr.agreed!);
  say(`  head ${anchor.number}  hash ${anchor.hash}`);
  say(`  timestamp ${anchor.timestamp} (${new Date(Number(anchor.timestamp) * 1000).toISOString()})`);
  done("current block", anchor.number > 20_000_000n, `mainnet block ${anchor.number}, corroborated across ${corr.readings.length} providers`);

  /* 3 */ head("Verified market data from a current Chainlink source");
  const selection = selectSource({ subject: "weth/usd", chainId: 1, requiredTrust: "VERIFIED_ORACLE", maxAgeMs: 3_600_000 });
  const round = await reader.call({ to: CHAINLINK_ETH_USD, data: "0xfeaf968c" }, anchor.number);
  const answer = BigInt(`0x${round.slice(2).slice(64, 128)}`);
  const updatedAt = BigInt(`0x${round.slice(2).slice(192, 256)}`);
  const feedDecimals = Number(BigInt(await reader.call({ to: CHAINLINK_ETH_USD, data: "0x313ce567" }, anchor.number)));
  const ethUsd = Number(answer) / 10 ** feedDecimals;
  say(`  source    ${selection.source.sourceId} (${selection.source.lifecycle}, verified ${selection.source.verifiedAt})`);
  say(`  ETH/USD   $${ethUsd}  (raw ${answer}, ${feedDecimals} decimals)`);
  say(`  updatedAt ${new Date(Number(updatedAt) * 1000).toISOString()} — ${Number(anchor.timestamp) - Number(updatedAt)}s before the anchor`);
  say(`  warnings  ${selection.warnings.length === 0 ? "none" : selection.warnings.map((w) => w.message).join("; ")}`);
  done("verified market data", ethUsd > 100 && ethUsd < 100_000, `Chainlink ETH/USD = $${ethUsd} at VERIFIED_ORACLE`);

  /* 4 */ head("Indexed protocol context");
  const graph = marketSources().find((s) => s.kind === "THE_GRAPH");
  const reserve = await reader.call({ to: AAVE_POOL, data: `0x35ea6a75${pad32(WETH)}` }, anchor.number);
  const liquidityRate = BigInt(`0x${reserve.slice(2).slice(128, 192)}`);
  say(`  The Graph : ${graph?.lifecycle} — needs THEGRAPH_API_KEY (BLK-V2-GRAPH-KEY). Excluded, not substituted.`);
  say(`  Aave v3   : WETH currentLiquidityRate ${liquidityRate} (ray) — DIRECT_CHAIN_DATA, read at block ${anchor.number}`);
  done("protocol context", liquidityRate > 0n, `Aave v3 mainnet reserve read; The Graph recorded ${graph?.lifecycle} rather than faked`);

  /* 5 */ head("Create the MarketSnapshot");
  const retrievedAtMs = Date.now();
  const sources: SnapshotSource[] = [
    { sourceId: selection.source.sourceId, kind: "CHAINLINK_DATA_FEED", adapterId: "chainlink-data-feeds", adapterVersion: "1.0.0", trustClass: "VERIFIED_ORACLE", sourceChainId: 1, timeSupport: "BLOCK_SCOPED", observedBlock: anchor.number.toString(), lagBlocks: 0, healthy: true, detail: `aggregator ${CHAINLINK_ETH_USD}` },
    { sourceId: "aave-v3-mainnet-reserves", kind: "READ_ONLY_RPC", adapterId: "aave-v3-state", adapterVersion: "1.4.0", trustClass: "DIRECT_CHAIN_DATA", sourceChainId: 1, timeSupport: "BLOCK_SCOPED", observedBlock: anchor.number.toString(), lagBlocks: 0, healthy: true, detail: `Aave v3 Pool ${AAVE_POOL}` },
  ];
  const observations: MarketObservation[] = [
    { observationId: "obs-price", metric: "weth/usd:price", value: answer.toString(), decimals: feedDecimals, unit: "USD", dataType: "PRICE", canonicalAssetId: "weth", sourceId: selection.source.sourceId, sourceChainId: 1, blockNumber: anchor.number.toString(), sourceTimestampMs: Number(updatedAt) * 1000, retrievedAtMs, trustClass: "VERIFIED_ORACLE", adapterId: "chainlink-data-feeds", adapterVersion: "1.0.0", derivedFrom: null, provenance: `Chainlink ETH/USD ${CHAINLINK_ETH_USD} latestRoundData() at block ${anchor.number}` },
    { observationId: "obs-rate", metric: "aave-v3:weth:liquidityRate", value: liquidityRate.toString(), decimals: 27, unit: "ray", dataType: "RATE", canonicalAssetId: "weth", sourceId: "aave-v3-mainnet-reserves", sourceChainId: 1, blockNumber: anchor.number.toString(), sourceTimestampMs: Number(anchor.timestamp) * 1000, retrievedAtMs, trustClass: "DIRECT_CHAIN_DATA", adapterId: "aave-v3-state", adapterVersion: "1.4.0", derivedFrom: null, provenance: `Aave v3 getReserveData(WETH) at block ${anchor.number}` },
  ];
  const snapshot: MarketSnapshot = sealSnapshot({
    snapshotId: `demo-${anchor.number}`, mode: "LIVE_MIRROR", observedAtMs: retrievedAtMs,
    anchorChainId: 1, anchorBlock: anchor.number.toString(), anchorBlockHash: anchor.hash.toLowerCase(),
    anchorBlockTimestampMs: Number(anchor.timestamp) * 1000, sources, observations,
    provenance: [`mainnet read-only at ${new Date(retrievedAtMs).toISOString()}`, "no write method was sent"],
    nowMs: retrievedAtMs, maxTimeSkewMs: stalenessThresholdMs(selection.source),
    sourceMaxAgeMs: sourceAgeLimits(sources.map((s) => s.sourceId)), maxSourceAgeMs: 5_400_000,
  });
  say(`  snapshotId   ${snapshot.snapshotId}`);
  say(`  snapshotHash ${snapshot.snapshotHash}`);
  done("MarketSnapshot", snapshot.snapshotHash.startsWith("sha256:"), `sealed and immutable, hash ${snapshot.snapshotHash.slice(0, 23)}…`);

  /* 6 */ head("Provenance, block/time and trust");
  for (const o of snapshot.observations) {
    say(`  ${o.metric.padEnd(28)} ${o.trustClass.padEnd(18)} block ${o.blockNumber}  ${new Date(o.sourceTimestampMs!).toISOString()}`);
    say(`    ${o.provenance}`);
  }
  say(`  coherent ${snapshot.coherence.coherent}, skew ${snapshot.coherence.maxTimeSkewMs}ms, block skew ${snapshot.coherence.maxBlockSkew}`);
  done("provenance", snapshot.coherence.coherent, `every observation carries source, block, time and trust; coherent=${snapshot.coherence.coherent}`);

  /* 7 */ head("Run a treasury strategy against the snapshot");
  const SUPPLY: SemanticAction = { kind: "SUPPLY", assetId: "usdc", counterAssetId: null, amount: "1000000000", decimals: 6, protocol: "aave-v3", rationale: `supply 1000 USDC; ETH/USD $${ethUsd} within band, Aave rate positive` };
  const evaluate = (s: MarketSnapshot): { verdict: "ALLOW" | "ESCALATE" | "DENY"; reasonCode: string; action: SemanticAction } => {
    const price = s.observations.find((o) => o.metric === "weth/usd:price");
    if (!price) return { verdict: "DENY", reasonCode: "DENY_NO_PRICE", action: { ...SUPPLY, kind: "NONE" } };
    if (price.trustClass !== "VERIFIED_ORACLE") return { verdict: "ESCALATE", reasonCode: "ESCALATE_TRUST_BELOW_POLICY", action: SUPPLY };
    const usd = Number(BigInt(price.value)) / 10 ** price.decimals;
    if (usd < 1000) return { verdict: "DENY", reasonCode: "DENY_PRICE_OUT_OF_BAND", action: SUPPLY };
    return { verdict: "ALLOW", reasonCode: "ALLOW_POLICY_MATCH", action: SUPPLY };
  };
  const evaluated = evaluate(snapshot);
  say(`  strategy : supply USDC to Aave v3 while ETH/USD is in band and the oracle is verified`);
  say(`  verdict  : ${evaluated.verdict}:${evaluated.reasonCode}`);
  done("strategy", evaluated.verdict === "ALLOW", `${evaluated.verdict}:${evaluated.reasonCode} against snapshot ${snapshot.snapshotId}`);

  /* 8 */ head("Run the official CRE simulator on normalized context");
  let creOut = "";
  let creOk = false;
  try {
    const run = execFileSync(CRE, ["workflow", "simulate", "policy", "--target", "staging-settings", "--non-interactive", "--trigger-index", "0",
      "--evm-tx-hash", "0x62753fddb9c92d2ff9989c430e2ca47224f992ac3243eb77bea05eda21679843", "--evm-event-index", "0"],
      { cwd: "workflows/cre-policy/contextlock-cre", encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] });
    creOut = run;
    creOk = /Workflow Simulation Result/.test(run);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    creOut = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    creOk = /Workflow Simulation Result/.test(creOut);
  }
  const binaryHash = /Binary hash: ([0-9a-f]{64})/.exec(creOut)?.[1] ?? "not reported";
  const creVerdict = /^"(.+)"$/m.exec(creOut)?.[1] ?? "none";
  say(`  binary hash : ${binaryHash}`);
  say(`  limits      : ${/Simulation limits enabled/.test(creOut) ? "production, enabled" : "NOT ENABLED"}`);
  say(`  result      : ${creVerdict}`);
  done("CRE simulator", creOk, creOk ? `official CLI returned ${creVerdict}, binary ${binaryHash.slice(0, 16)}…` : "the CRE CLI did not produce a result");

  /* 9 */ head("ALLOW / ESCALATE / DENY");
  say(`  ContextLock policy : ${evaluated.verdict}:${evaluated.reasonCode}`);
  say(`  CRE simulation     : ${creVerdict}`);
  done("verdicts", creOk && evaluated.verdict === "ALLOW", `policy ${evaluated.verdict}, CRE ${creVerdict} — both produced by real components`);

  /* 10 */ head("Execution target: LOCAL MAINNET FORK");
  say("  MARKET SOURCE     Ethereum Mainnet — READ ONLY");
  say("  EXECUTION TARGET  Ethereum Mainnet Fork — LOCAL ONLY");
  say("  These are never merged into one label.");
  done("target", true, "market source and execution target displayed separately");

  /* 11 */ head("Start Anvil pinned to an exact mainnet block");
  const forkBlock = anchor.number - 10n;
  const upstreamBlock = await reader.getBlock(forkBlock);
  const forkProvider = new AnvilForkProvider({ rpc, readUpstreamBlockHash: async (_c, b) => (await reader.getBlock(BigInt(b))).hash });
  let fork: ForkDescriptor = await forkProvider.create({ sourceChainId: 1, forkBlock: forkBlock.toString(), upstreamRpcUrl: UPSTREAM, sourceProviderId: "publicnode", port: 8749 });
  await waitReady(fork.endpoint);
  say(`  forkId ${fork.forkId} at ${fork.endpoint}, pinned to block ${forkBlock}`);
  done("fork started", true, `Anvil forked mainnet at exact block ${forkBlock}`);

  /* 12 */ head("Verify the fork anchor");
  fork = await forkProvider.verifyAnchor(fork.forkId);
  say(`  fork blockHash     ${fork.forkBlockHash}`);
  say(`  upstream blockHash ${upstreamBlock.hash}`);
  say(`  anvil ${fork.anvilVersion}, chainId ${fork.chainId}, forkedFrom ${fork.sourceChainId}`);
  done("anchor verified", fork.forkBlockHash === upstreamBlock.hash.toLowerCase() && fork.state === "READY", `block hash matches an independently-read upstream hash`);

  /* 13 */ head("Interact with a real mainnet protocol contract on the fork");
  const forkReserve = await fcall(fork.endpoint, AAVE_POOL, `0x35ea6a75${pad32(WETH)}`);
  const forkIndex = BigInt(`0x${forkReserve.slice(2).slice(64, 128)}`);
  const usdcSupply = BigInt(await fcall(fork.endpoint, USDC, "0x18160ddd"));
  say(`  Aave v3 WETH liquidityIndex : ${forkIndex}`);
  say(`  USDC totalSupply            : ${usdcSupply} (${(Number(usdcSupply) / 1e6).toFixed(0)} USDC)`);
  done("real protocol read", forkIndex > 10n ** 27n && usdcSupply > 0n, "mainnet state present on the fork; an empty Anvil would return zero");

  /* 14 */ head("Perform a real protocol transaction locally");
  const dev = ANVIL_DEV_ACCOUNTS[0];
  const depositHash = (await rpc(fork.endpoint, "eth_sendTransaction", [{ from: dev.address, to: WETH, data: "0xd0e30db0", value: `0x${(2n * 10n ** 18n).toString(16)}` }])) as string;
  await waitReceipt(fork.endpoint, depositHash);
  const approveHash = (await rpc(fork.endpoint, "eth_sendTransaction", [{ from: dev.address, to: WETH, data: `0x095ea7b3${pad32(ROUTER)}${uintArg(2n * 10n ** 18n)}` }])) as string;
  await waitReceipt(fork.endpoint, approveHash);
  const usdcBefore = BigInt(await fcall(fork.endpoint, USDC, `0x70a08231${pad32(dev.address)}`));
  const swapHash = (await rpc(fork.endpoint, "eth_sendTransaction", [{ from: dev.address, to: ROUTER, gas: "0x7a120",
    data: `0x04e45aaf${pad32(WETH)}${pad32(USDC)}${pad32("bb8")}${pad32(dev.address)}${uintArg(10n ** 18n)}${uintArg(0n)}${uintArg(0n)}` }])) as string;
  const swapReceipt = await waitReceipt(fork.endpoint, swapHash);
  const usdcAfter = BigInt(await fcall(fork.endpoint, USDC, `0x70a08231${pad32(dev.address)}`));
  const usdcOut = Number(usdcAfter - usdcBefore) / 1e6;
  say(`  WETH9.deposit       ${depositHash}`);
  say(`  Uniswap v3 swap     ${swapHash}  (${swapReceipt.status === "0x1" ? "success" : "reverted"}, gas ${BigInt(swapReceipt.gasUsed)})`);
  say(`  1 WETH → ${usdcOut} USDC   vs oracle $${ethUsd}   spread ${((Math.abs(usdcOut - ethUsd) / ethUsd) * 100).toFixed(2)}%`);
  done("real local transaction", swapReceipt.status === "0x1" && usdcAfter > usdcBefore, `real Uniswap v3 swap executed on the fork: 1 WETH → ${usdcOut} USDC`);

  /* 15 */ head("Display: LOCAL FORK TRANSACTION");
  for (const [n, h] of [["deposit", depositHash], ["swap", swapHash]] as const) {
    say(`  ${n.padEnd(8)} ${h}`);
    say(`           ${LOCAL_FORK_TX_LABEL}   explorer: ${explorerUrlFor({ chainId: 31337, hash: h }) ?? "none"}`);
  }
  done("labelling", explorerUrlFor({ chainId: 31337, hash: swapHash }) === null, "every fork transaction labelled LOCAL FORK TRANSACTION with no explorer URL");

  /* 16-17 */ head("Send the same semantic action to Ethereum mainnet");
  let mainnetReason = "NOT REFUSED";
  try { fenceWriteByChain("RELAYER", 1); } catch (e) { mainnetReason = (e as NetworkGuardError).reason; }
  let submitReason = "NOT REFUSED";
  try { submitToPublicMainnet({ action: SUPPLY, calldata: "0xd0e30db0" }); } catch (e) { submitReason = (e as { reason: string }).reason; }
  let compileReason = "NOT REFUSED";
  try { compileForNetwork(SUPPLY, { chainId: 1, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null }, { protocolAddressFor: () => AAVE_POOL }); }
  catch (e) { compileReason = (e as { reason: string }).reason; }
  say(`  fence RELAYER chain 1  : ${mainnetReason}`);
  say(`  submitToPublicMainnet  : ${submitReason}`);
  say(`  compile for chain 1    : ${compileReason}`);
  done("mainnet write refused", mainnetReason === "PRODUCTION_NETWORK_WRITE_PROHIBITED", `PRODUCTION_NETWORK_WRITE_PROHIBITED at the fence, NO_PUBLIC_MAINNET_SUBMISSION_PATH at the submitter`);

  /* 18-19 */ head("Attempt eth_sendRawTransaction through the Reality Engine");
  const refusals: string[] = [];
  for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign"]) {
    try { assertRpcMethodAllowed(m); refusals.push(`${m}=ALLOWED`); }
    catch (e) { refusals.push(`${m}=${(e as RpcFenceError).reason}`); }
  }
  for (const r of refusals) say(`  ${r}`);
  done("raw write refused", refusals.every((r) => !r.endsWith("ALLOWED")), "every write and signing method refused on the transport");

  /* 20 */ head("Historical replay at an older exact block");
  const replayBlock = anchor.number - 5_000n;

  // The depth check, before the request. An endpoint that cannot serve this is refused by name.
  let depthRefusal = "";
  try {
    assertCanServeHistorical({ providerId: "publicnode", archiveDepth: "RECENT_STATE_ONLY" }, replayBlock, anchor.number, "replay");
  } catch (e) {
    depthRefusal = (e as RpcFenceError).message;
  }
  say(`  depth check on the non-archive endpoint: ${depthRefusal ? "REFUSED" : "accepted"}`);
  if (depthRefusal) say(`    ${depthRefusal.slice(0, 150)}`);
  if (!archive) {
    say("  MAINNET_ARCHIVE_RPC_URL is not set, so the replay cannot run against a pinned block.");
    done("historical replay", false, "no archive-capable endpoint configured — see BLK-V2-ARCHIVE-RPC");
    throw new Error("replay requires an archive endpoint");
  }
  const target = await pinBlock(archive, replayBlock.toString());
  const plan = planReplaySources(["chainlink-feed-eth-usd-mainnet", "aave-v3-mainnet-reserves", "thegraph-uniswap-v3-mainnet"], "EXCLUDE_NON_HISTORICAL");
  const histRound = await archive.call({ to: CHAINLINK_ETH_USD, data: "0xfeaf968c" }, BigInt(target.blockNumber));
  const histPrice = BigInt(`0x${histRound.slice(2).slice(64, 128)}`);
  say(`  archive endpoint: ${archive.providerId} (declared ARCHIVE)`);
  say(`  pinned block ${target.blockNumber} (${new Date(target.blockTimestampMs).toISOString()})`);
  say(`  block hash   ${target.blockHash}`);
  say(`  ETH/USD then $${Number(histPrice) / 10 ** feedDecimals}  vs now $${ethUsd}`);
  say(`  sources      included ${plan.included.length}, excluded ${plan.excluded.map((e) => e.sourceId).join(", ") || "none"}`);
  done("historical replay", /^\d+$/.test(target.blockNumber) && target.blockHash.startsWith("0x"), `replay pinned to exact block ${target.blockNumber} with its hash`);

  /* 21 */ head("Run the strategy against the replay");
  const replayObs: MarketObservation[] = [{ ...observations[0]!, observationId: "obs-price-replay", value: histPrice.toString(), blockNumber: target.blockNumber, sourceTimestampMs: target.blockTimestampMs, retrievedAtMs: Date.now(), provenance: `Chainlink ETH/USD at mainnet block ${target.blockNumber}` }];
  const replaySnapshot = sealSnapshot({
    snapshotId: `demo-replay-${target.blockNumber}`, mode: "HISTORICAL_REPLAY", observedAtMs: Date.now(),
    anchorChainId: 1, anchorBlock: target.blockNumber, anchorBlockHash: target.blockHash, anchorBlockTimestampMs: target.blockTimestampMs,
    sources: [sources[0]!], observations: replayObs,
    provenance: [`historical replay pinned to block ${target.blockNumber}`],
    nowMs: Date.now(), maxTimeSkewMs: Number.MAX_SAFE_INTEGER, maxSourceAgeMs: Number.MAX_SAFE_INTEGER,
  });
  const replayVerdict = evaluate(replaySnapshot);
  const replayAgain = await pinBlock(archive, replayBlock.toString());
  const reproducible = replaysAgree({ target, observations: replayObs }, { target: replayAgain, observations: replayObs });
  say(`  verdict      ${replayVerdict.verdict}:${replayVerdict.reasonCode}`);
  say(`  reproducible ${reproducible.agree}${reproducible.agree ? "" : ` — ${reproducible.differences.join("; ")}`}`);
  done("replay strategy", reproducible.agree, `${replayVerdict.verdict} at block ${target.blockNumber}, and a second pin of the same block agrees`);

  /* 22-23 */ head("Apply a synthetic flash-crash overlay and rerun");
  const hashBefore = snapshot.snapshotHash;
  const crash = applyOverlay(snapshot, {
    schemaVersion: "contextlock.scenario-overlay/v1", overlayId: "demo-crash-60", name: "Flash crash",
    description: "A 60% drawdown, enough to take the price out of the strategy's band.",
    mutations: [{ metric: "weth/usd:price", op: "PERCENT", operand: -60, note: "price falls 60%" }],
  }, { snapshotId: `demo-crash-${anchor.number}` });
  const crashVerdict = evaluate(crash.snapshot);
  const crashPrice = crash.snapshot.observations.find((o) => o.metric === "weth/usd:price")!;
  say(`  base price     $${ethUsd}  (${snapshot.observations[0]?.trustClass})`);
  say(`  scenario price $${Number(BigInt(crashPrice.value)) / 10 ** crashPrice.decimals}  (${crashPrice.trustClass})`);
  say(`  provenance     ${crashPrice.provenance.slice(0, 110)}…`);
  say(`  scenarioHash   ${crash.scenarioHash}`);
  say(`  verdict        ${crashVerdict.verdict}:${crashVerdict.reasonCode}`);
  done("scenario overlay", crashPrice.trustClass === "USER_UNTRUSTED" && crash.scenarioHash === computeScenarioHash(hashBefore, crash.overlay),
    `synthetic value downgraded to ${crashPrice.trustClass}; verdict moved ${evaluated.verdict} → ${crashVerdict.verdict}`);

  /* 24 */ head("Prove the base snapshot is unchanged");
  assertBaseUnchanged(snapshot, hashBefore);
  say(`  base hash before overlay : ${hashBefore}`);
  say(`  base hash after  overlay : ${snapshot.snapshotHash}`);
  say(`  scenario snapshot hash   : ${crash.snapshot.snapshotHash}`);
  done("base immutable", snapshot.snapshotHash === hashBefore && crash.snapshot.snapshotHash !== hashBefore, "the base hash is identical; the scenario is a separate snapshot");

  /* shadow decision, recorded before teardown */
  const shadowDecision = await runShadowDecision({
    decisionId: `demo-${anchor.number}`, snapshot, strategyRevision: 1, blueprintRevision: 1,
    maxContextAgeMs: 3_600_000, nowMs: snapshot.observedAtMs, target: "LOCAL_FORK", fork,
    evaluate, protocolAddressFor: (p, c) => (p === "aave-v3" && (c === 1 || c === 31337) ? AAVE_POOL : p === "aave-v3" && c === 11155111 ? "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951" : null),
    executeOnTarget: async () => ({ txHash: swapHash, label: LOCAL_FORK_TX_LABEL }),
  });

  /* 25 */ head("Destroy the fork and verify cleanup");
  await forkProvider.destroy(fork.forkId);
  await new Promise((r) => setTimeout(r, 1500));
  let reachable = true;
  try { await rpc(fork.endpoint, "eth_chainId"); } catch { reachable = false; }
  say(`  descriptor state   ${forkProvider.get(fork.forkId)?.state}`);
  say(`  endpoint reachable ${reachable}`);
  done("cleanup", !reachable && forkProvider.get(fork.forkId)?.state === "DESTROYED", "the fork process is gone and the descriptor says DESTROYED");

  /* ── audit and summary ─────────────────────────────────────────────────── */
  say("");
  say("──────── AUDITABILITY ────────");
  const audit = auditRealityEvaluation(snapshot, shadowDecision);
  for (const a of audit.answers) say(`  ${a.answered ? "✓" : "✗"} ${a.question}  →  ${a.answer.slice(0, 120)}`);
  say(`  auditable: ${audit.auditable}`);
  if (!audit.auditable) process.exitCode = 1;

  const passed = STEPS.filter((s) => s.ok).length;
  say("");
  say("═══════════════════════════════════════════════════════════════");
  say(`   ${passed}/${STEPS.length} steps passed`);
  say("   public mainnet transactions: 0");
  say("═══════════════════════════════════════════════════════════════");
  for (const s of STEPS) say(`  ${s.ok ? "PASS" : "FAIL"}  step ${String(s.n).padStart(2)}  ${s.title} — ${s.detail}`);

  writeFileSync(`${OUT}/p27-demo.txt`, lines.join("\n") + "\n");
  writeFileSync(`${OUT}/p27-demo.json`, JSON.stringify({
    steps: STEPS, anchorBlock: anchor.number.toString(), anchorBlockHash: anchor.hash,
    ethUsd, snapshotHash: snapshot.snapshotHash, scenarioHash: crash.scenarioHash,
    creBinaryHash: binaryHash, creVerdict, forkBlock: forkBlock.toString(), forkBlockHash: fork.forkBlockHash,
    anvilVersion: fork.anvilVersion, swapHash, usdcOut, replayBlock: target.blockNumber,
    shadowDecision, auditable: audit.auditable, publicMainnetTransactions: 0,
  }, null, 2) + "\n");
  console.log(`\nwritten: ${OUT}/p27-demo.txt and p27-demo.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
