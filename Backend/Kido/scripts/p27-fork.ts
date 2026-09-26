/**
 * P27 live evidence: the mainnet fork.
 *
 * Starts Anvil pinned to an exact mainnet block through the shipped `AnvilForkProvider`, verifies
 * the anchor against an independently-read block hash, exercises real mainnet protocol contracts,
 * performs real local transactions, and then demonstrates that the same actions aimed at public
 * mainnet are refused.
 *
 * Every transaction here is local. None of them exists outside this machine.
 */
import { writeFileSync } from "node:fs";
import {
  AnvilForkProvider, assertLocalForkEndpoint, explorerUrlFor, forkNetworkRef,
  LOCAL_FORK_TX_LABEL, ANVIL_DEV_ACCOUNTS, assertDevKeyStoreAllowed, ForkError,
  FencedJsonRpcProvider, ReadSourceEndpointSchema, assertRpcMethodAllowed, RpcFenceError,
  assertEnvironmentBinding, submitToPublicMainnet, ShadowError,
  type ForkDescriptor,
} from "../packages/studio-reality/src/index.js";
import { fenceWriteByChain, NetworkGuardError } from "../packages/studio-network/src/index.js";

const OUT = "reports/phase-27/evidence";
const UPSTREAM = process.env["MAINNET_RPC_URL"] ?? "https://ethereum-rpc.publicnode.com";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" as const;
const UNISWAP_ROUTER02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as const;

const lines: string[] = [];
const say = (s: string): void => { lines.push(s); console.log(s); };

const pad32 = (h: string): string => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const addrArg = (a: string): string => pad32(a);
const uintArg = (n: bigint): string => pad32(n.toString(16));

async function rpc(endpoint: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const call = async (endpoint: string, to: string, data: string): Promise<string> =>
  (await rpc(endpoint, "eth_call", [{ to, data }, "latest"])) as string;

/**
 * Wait for the receipt rather than assuming one.
 *
 * Anvil auto-mines, so a receipt is available almost immediately — almost. Reading it in the same
 * tick as the send returns null, which is the same mistake DEP-004b caught in Group E against a
 * real chain: a send is not done when the call returns, it is done when the world says so.
 */
async function waitReceipt(endpoint: string, hash: string, tries = 40): Promise<{ status: string; gasUsed: string; blockNumber: string }> {
  for (let i = 0; i < tries; i++) {
    const r = (await rpc(endpoint, "eth_getTransactionReceipt", [hash])) as { status: string; gasUsed: string; blockNumber: string } | null;
    if (r) return r;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`no receipt for ${hash} after ${tries} attempts`);
}

async function waitReady(endpoint: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await rpc(endpoint, "eth_chainId");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`anvil did not become ready at ${endpoint}`);
}

async function main(): Promise<void> {
  say("=== P27 LOCAL MAINNET FORK ===");
  say(`date     : ${new Date().toISOString()}`);
  say(`upstream : ${new URL(UPSTREAM).host} (read-only; Anvil lazily fetches state from it)`);
  say("");

  /* ── 1. pick an exact block, and read its hash independently ───────────── */
  say("--- 1. the anchor block, chosen exactly and read independently ---");
  const reader = new FencedJsonRpcProvider(ReadSourceEndpointSchema.parse({ chainId: 1, providerId: "publicnode", url: UPSTREAM }));
  const head = await reader.getBlockNumber();
  // A few blocks behind the head, so the fork target is settled rather than racing reorgs.
  const forkBlock = head - 10n;
  const upstreamBlock = await reader.getBlock(forkBlock);
  say(`  mainnet head    : ${head}`);
  say(`  fork block      : ${forkBlock}  (exact — "latest" is refused for evidence, §P27.23)`);
  say(`  upstream hash   : ${upstreamBlock.hash}`);
  say(`  upstream ts     : ${upstreamBlock.timestamp} (${new Date(Number(upstreamBlock.timestamp) * 1000).toISOString()})`);
  say("");

  /* ── 2. start the fork ─────────────────────────────────────────────────── */
  say("--- 2. Anvil, pinned ---");
  const provider = new AnvilForkProvider({
    rpc: (endpoint, method, params) => rpc(endpoint, method, params),
    readUpstreamBlockHash: async (_chainId, block) => (await reader.getBlock(BigInt(block))).hash,
  });

  let fork: ForkDescriptor = await provider.create({
    sourceChainId: 1,
    forkBlock: forkBlock.toString(),
    upstreamRpcUrl: UPSTREAM,
    sourceProviderId: "publicnode",
    port: 8747,
  });
  say(`  forkId   : ${fork.forkId}`);
  say(`  endpoint : ${fork.endpoint}`);
  assertLocalForkEndpoint(fork.endpoint, "evidence run");
  say("  endpoint is local: verified before anything was spawned");

  await waitReady(fork.endpoint);

  /* ── 3. verify the anchor ──────────────────────────────────────────────── */
  say("");
  say("--- 3. anchor verification ---");
  fork = await provider.verifyAnchor(fork.forkId);
  say(`  state          : ${fork.state}`);
  say(`  anvil version  : ${fork.anvilVersion}`);
  say(`  fork chainId   : ${fork.chainId}  (NOT 1 — a fork keeping its source chain id could be replayed)`);
  say(`  forkedFrom     : ${fork.sourceChainId}`);
  say(`  fork block     : ${fork.forkBlock}`);
  say(`  fork blockHash : ${fork.forkBlockHash}`);
  say(`  matches upstream: ${fork.forkBlockHash === upstreamBlock.hash.toLowerCase()}`);
  if (fork.forkBlockHash !== upstreamBlock.hash.toLowerCase()) throw new Error("anchor mismatch survived verification");
  say("");

  /* ── 4. real mainnet protocol state, through the fork ──────────────────── */
  say("--- 4. real mainnet protocol state, read through the fork (§P27.28) ---");
  const reserve = await call(fork.endpoint, AAVE_POOL, `0x35ea6a75${addrArg(WETH)}`);
  const rd = reserve.slice(2);
  const liquidityIndex = BigInt(`0x${rd.slice(64, 128)}`);
  const aToken = `0x${rd.slice(8 * 64 + 24, 9 * 64)}`;
  say(`  Aave v3 Pool ${AAVE_POOL}`);
  say(`    WETH liquidityIndex : ${liquidityIndex}`);
  say(`    aWETH               : ${aToken}`);
  say(`  This is mainnet state. An empty Anvil would return 0x here.`);

  const wethSymbolRaw = await call(fork.endpoint, WETH, "0x95d89b41");
  const symLen = Number(BigInt(`0x${wethSymbolRaw.slice(2).slice(64, 128)}`));
  const wethSymbol = Buffer.from(wethSymbolRaw.slice(2).slice(128, 128 + symLen * 2), "hex").toString("utf8");
  const usdcSupply = BigInt(await call(fork.endpoint, USDC, "0x18160ddd"));
  say(`  WETH9 ${WETH} symbol()  : ${wethSymbol}`);
  say(`  USDC totalSupply()      : ${usdcSupply} (${Number(usdcSupply) / 1e6} USDC)`);
  say("");

  /* ── 5. a real local transaction against a real mainnet contract ───────── */
  say("--- 5. real protocol transaction, locally (§P27.29) ---");
  const dev = ANVIL_DEV_ACCOUNTS[0];
  say(`  sender : ${dev.address} (Anvil development account, label ${dev.label})`);
  try {
    assertDevKeyStoreAllowed("user-wallet-store", "evidence run");
    say("  FAILURE: a development key was accepted into the user wallet store");
    process.exitCode = 1;
  } catch (e) {
    say(`  storing it in a real key store is refused: ${(e as ForkError).reason}`);
  }

  const wethBefore = BigInt(await call(fork.endpoint, WETH, `0x70a08231${addrArg(dev.address)}`));
  const usdcBefore = BigInt(await call(fork.endpoint, USDC, `0x70a08231${addrArg(dev.address)}`));
  say(`  pre-state  : WETH ${wethBefore}  USDC ${usdcBefore}`);

  // (a) WETH9.deposit() — a real mainnet contract, a real state change.
  const depositAmount = 5n * 10n ** 18n;
  const depositHash = (await rpc(fork.endpoint, "eth_sendTransaction", [{
    from: dev.address, to: WETH, data: "0xd0e30db0", value: `0x${depositAmount.toString(16)}`,
  }])) as string;
  const depositReceipt = await waitReceipt(fork.endpoint, depositHash);
  const wethAfterDeposit = BigInt(await call(fork.endpoint, WETH, `0x70a08231${addrArg(dev.address)}`));
  say(`  WETH9.deposit(5 ETH) : ${depositHash}`);
  say(`    status ${depositReceipt.status === "0x1" ? "success" : "reverted"}, gas ${BigInt(depositReceipt.gasUsed)}, WETH ${wethBefore} → ${wethAfterDeposit}`);

  // (b) approve + Uniswap v3 exactInputSingle WETH → USDC, through the real router.
  const approveHash = (await rpc(fork.endpoint, "eth_sendTransaction", [{
    from: dev.address, to: WETH, data: `0x095ea7b3${addrArg(UNISWAP_ROUTER02)}${uintArg(depositAmount)}`,
  }])) as string;
  await waitReceipt(fork.endpoint, approveHash);
  say(`  WETH.approve(router) : ${approveHash}`);

  const swapAmount = 1n * 10n ** 18n;
  // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) on SwapRouter02
  const swapData = `0x04e45aaf${addrArg(WETH)}${addrArg(USDC)}${pad32("bb8")}${addrArg(dev.address)}${uintArg(swapAmount)}${uintArg(0n)}${uintArg(0n)}`;
  let swapHash: string | null = null;
  let swapStatus = "not attempted";
  let usdcAfter = usdcBefore;
  try {
    swapHash = (await rpc(fork.endpoint, "eth_sendTransaction", [{ from: dev.address, to: UNISWAP_ROUTER02, data: swapData, gas: "0x7a120" }])) as string;
    const r = await waitReceipt(fork.endpoint, swapHash);
    swapStatus = r.status === "0x1" ? "success" : "reverted";
    usdcAfter = BigInt(await call(fork.endpoint, USDC, `0x70a08231${addrArg(dev.address)}`));
    say(`  Uniswap v3 swap 1 WETH → USDC : ${swapHash}`);
    say(`    router ${UNISWAP_ROUTER02} (0.05% pool)`);
    say(`    status ${swapStatus}, gas ${BigInt(r.gasUsed)}`);
    say(`    USDC ${usdcBefore} → ${usdcAfter}  (+${Number(usdcAfter - usdcBefore) / 1e6} USDC)`);
  } catch (e) {
    swapStatus = `failed: ${(e as Error).message}`;
    say(`  Uniswap v3 swap : ${swapStatus}`);
  }

  const forkBlockAfter = BigInt((await rpc(fork.endpoint, "eth_blockNumber")) as string);
  say(`  post-state : WETH ${wethAfterDeposit}  USDC ${usdcAfter}  (fork advanced to block ${forkBlockAfter})`);
  say("");

  /* ── 6. labelling ──────────────────────────────────────────────────────── */
  say("--- 6. how these transactions are labelled (§P27.30) ---");
  for (const [name, hash] of [["deposit", depositHash], ["approve", approveHash], ["swap", swapHash ?? "n/a"]] as const) {
    if (hash === "n/a") continue;
    const url = explorerUrlFor({ chainId: 31337, hash });
    say(`  ${name.padEnd(8)} ${hash}`);
    say(`           label: ${LOCAL_FORK_TX_LABEL}`);
    say(`           explorer URL: ${url === null ? "none — refused for a local fork" : `${url}  ← FAILURE`}`);
    if (url !== null) process.exitCode = 1;
  }
  say("  A local hash is 32 bytes and looks exactly like a mainnet hash. The label, not the hash,");
  say("  is what says where it happened.");
  say("");

  /* ── 7. impersonation ──────────────────────────────────────────────────── */
  say("--- 7. impersonation, local only (§P27.27) ---");
  const whale = "0x28C6c06298d514Db089934071355E5743bf21d60";
  const actor = await provider.impersonate(fork.forkId, whale as `0x${string}`, "simulate a large USDC holder");
  const whaleUsdc = BigInt(await call(fork.endpoint, USDC, `0x70a08231${addrArg(whale)}`));
  say(`  impersonated ${actor.address}`);
  say(`  metadata     ${actor.metadata}`);
  say(`  its USDC     ${whaleUsdc} (${Number(whaleUsdc) / 1e6})`);
  say("  This demonstrates Anvil accepts the request. It is not evidence of ownership, control or");
  say("  authorization, and the metadata says so.");
  try {
    const { assertImpersonationAllowed } = await import("../packages/studio-reality/src/fork.js");
    assertImpersonationAllowed({ chainId: 11155111, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null }, "evidence run");
    say("  FAILURE: impersonation was allowed on a public testnet");
    process.exitCode = 1;
  } catch (e) {
    say(`  the same request on Sepolia: ${(e as ForkError).reason}`);
  }
  say("");

  /* ── 8. the same action, aimed at mainnet ──────────────────────────────── */
  say("--- 8. the same semantic action aimed at public mainnet ---");
  try {
    fenceWriteByChain("RELAYER", 1);
    say("  FAILURE: a mainnet write passed the fence");
    process.exitCode = 1;
  } catch (e) {
    say(`  fence RELAYER chain 1        : ${(e as NetworkGuardError).reason}`);
  }
  try {
    fenceWriteByChain("AGENT_RUNTIME", 1);
  } catch (e) {
    say(`  fence AGENT_RUNTIME chain 1  : ${(e as NetworkGuardError).reason}`);
  }
  try {
    submitToPublicMainnet({ to: WETH, data: "0xd0e30db0" });
    say("  FAILURE: a mainnet submission path exists");
    process.exitCode = 1;
  } catch (e) {
    say(`  submitToPublicMainnet(...)   : ${(e as ShadowError).reason}`);
  }
  say("");

  /* ── 9. raw write through the Reality Engine ───────────────────────────── */
  say("--- 9. eth_sendRawTransaction through the Reality Engine ---");
  for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_signTransaction"]) {
    try {
      assertRpcMethodAllowed(m);
      say(`  ${m} ALLOWED ← FAILURE`);
      process.exitCode = 1;
    } catch (e) {
      say(`  ${m.padEnd(24)} : ${(e as RpcFenceError).reason}`);
    }
  }
  say("  Note: the FORK provider does send eth_sendTransaction — to 127.0.0.1. That is a different");
  say("  transport with a different permission, which is why the capability is a property of the");
  say("  endpoint rather than a global switch.");
  say("");

  /* ── 10. environment binding ───────────────────────────────────────────── */
  say("--- 10. a fork capability is bound to this fork (§P27.35) ---");
  const binding = { executionEnvironment: "LOCAL_FORK" as const, environmentId: fork.forkId, chainId: 31337, forkedFrom: 1, forkBlock: fork.forkBlock };
  assertEnvironmentBinding(binding, binding, "same fork");
  say(`  same fork (${fork.forkId}) : accepted`);
  for (const [label, other] of [
    ["a different fork", { ...binding, environmentId: "fork-000000000000" }],
    ["a testnet", { executionEnvironment: "TESTNET" as const, environmentId: "testnet-11155111", chainId: 11155111, forkedFrom: null, forkBlock: null }],
  ] as const) {
    try {
      assertEnvironmentBinding(binding, other, "cross-environment");
      say(`  ${label}: ACCEPTED ← FAILURE`);
      process.exitCode = 1;
    } catch (e) {
      say(`  ${label.padEnd(18)} : ${(e as ForkError).reason}`);
    }
  }
  say("");

  /* ── 11. teardown ──────────────────────────────────────────────────────── */
  say("--- 11. destroy and verify cleanup ---");
  await provider.destroy(fork.forkId);
  say(`  state after destroy : ${provider.get(fork.forkId)?.state}`);
  await new Promise((r) => setTimeout(r, 1500));
  let reachable = true;
  try {
    await rpc(fork.endpoint, "eth_chainId");
  } catch {
    reachable = false;
  }
  say(`  endpoint reachable  : ${reachable}${reachable ? "  ← FAILURE" : "  (the process is gone)"}`);
  if (reachable) process.exitCode = 1;

  const summary = {
    forkId: fork.forkId,
    anvilVersion: fork.anvilVersion,
    sourceChainId: fork.sourceChainId,
    forkChainId: fork.chainId,
    forkBlock: fork.forkBlock,
    forkBlockHash: fork.forkBlockHash,
    upstreamBlockHash: upstreamBlock.hash,
    anchorVerified: fork.forkBlockHash === upstreamBlock.hash.toLowerCase(),
    aaveLiquidityIndex: liquidityIndex.toString(),
    transactions: [
      { name: "weth9-deposit", hash: depositHash, label: LOCAL_FORK_TX_LABEL, explorerUrl: null },
      { name: "weth-approve-router", hash: approveHash, label: LOCAL_FORK_TX_LABEL, explorerUrl: null },
      ...(swapHash ? [{ name: "uniswap-v3-swap", hash: swapHash, label: LOCAL_FORK_TX_LABEL, explorerUrl: null, status: swapStatus }] : []),
    ],
    balances: { wethBefore: wethBefore.toString(), wethAfter: wethAfterDeposit.toString(), usdcBefore: usdcBefore.toString(), usdcAfter: usdcAfter.toString() },
    publicMainnetWrite: "PRODUCTION_NETWORK_WRITE_PROHIBITED",
    destroyed: !reachable,
  };
  writeFileSync(`${OUT}/p27-fork.txt`, lines.join("\n") + "\n");
  writeFileSync(`${OUT}/p27-fork.json`, JSON.stringify(summary, null, 2) + "\n");
  console.log(`\nwritten: ${OUT}/p27-fork.txt and p27-fork.json`);
}

main().catch(async (e) => { console.error(e); process.exit(1); });
