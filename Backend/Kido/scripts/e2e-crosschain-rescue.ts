/**
 * Cross-chain position rescue, live on Sui testnet and Sepolia (BRIDGE mode, bible §47):
 *
 *   Aave health factor below the owner's target (Kido monitor, read from the Aave pool)
 *   → Sui: agent SWAP AMSUI → AMUSD through the pinned Cetus pool (Amane Sui, core v5)
 *   → Sui: agent BRIDGE AMUSD → Sepolia; the source intent commits to "SWAP on Uniswap" on arrival
 *   → Wormhole Token Bridge (Kido CrossChainEngine; VAA from the guardian network)
 *   → Sepolia: arrival reserved for that intent (PendingCrossChainAsset); the reserved SWAP turns
 *     wrapped AMUSD into Aave's listed test USDC (Aave accepts only its own listed assets)
 *   → Sepolia: separately bounded REPAY of the pinned beneficiary's Aave debt; the account measures
 *     the debt reduction
 *
 * Every step is its own agent-signed Amane action, checked on-chain. Attack variants run against
 * the live contracts as simulations (no gas) unless marked landed.
 *
 * Reuses the endpoints from Aname's live-bridge-roundtrip (KIDO_XCHAIN_STATE) and installs policy v2
 * on both. Env: KIDO_DEMO_KEYS, KIDO_XCHAIN_STATE, SEPOLIA_RPC_URL, FUNDER_PRIVATE_KEY (gas and the
 * demo borrower), KIDO_EVM_BALANCE_FLOOR (ETH), KIDO_RESCUE_TARGET_HF (owner's target health factor).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, parseAbi, parseEther, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  ActionKind,
  AmaneEvmEndpoint,
  AmaneSuiEndpoint,
  AuthMode,
  PriceMode,
  ZERO32,
  actionMask,
  addressToBytes32,
  amaneStructHash,
  destSpecHash,
  evmAssetId,
  loadAmaneManifest,
  signAmane,
  signThreshold,
  suiAdapterId,
  suiAssetId,
  suiObjectToBytes32,
  type ActionIntent,
  type AgentLease,
  type AmaneOutcome,
  type DestSpec,
  type RootPolicy,
} from "@kido/amane-bridge";
import { AmaneOnChainDestination, WormholeAmaneTransport, amaneIntentId, wormholeFacts, type AmaneBridgeAuthority } from "@kido/foundry";
import { ProviderRegistry, rpcUrl } from "@kido/registry";
import { CrossChainEngine, FileEventLog, readAavePosition, repayAmountFor, type CrossChainIntent } from "@kido/runtime";

const need = (k: string) => process.env[k] ?? (console.log(JSON.stringify({ status: "BLOCKED_ENV", missing: k })), process.exit(2));
const keysPath = need("KIDO_DEMO_KEYS");
const keys = JSON.parse(readFileSync(keysPath, "utf8")) as { evm: Record<string, Hex>; suiRelayer: string; suiMerchant: string; suiRecovery: string };
const who = Object.fromEntries(Object.entries(keys.evm).map(([k, v]) => [k, privateKeyToAccount(v)])) as Record<"controllerA" | "controllerB" | "agent" | "attacker" | "recovery", ReturnType<typeof privateKeyToAccount>>;
const X = JSON.parse(readFileSync(need("KIDO_XCHAIN_STATE"), "utf8"), (_k, v) => (v && typeof v === "object" && "$big" in v ? BigInt(v.$big) : v));
const targetHf = Number(need("KIDO_RESCUE_TARGET_HF"));
const manifest = loadAmaneManifest(resolve("../Aname/deployments/testnet.json"));
const m = manifest as unknown as { sui: any; evm: any };
const registry = new ProviderRegistry();
const sui = new SuiGrpcClient({ network: "testnet", baseUrl: rpcUrl("sui-testnet") });
const transport = http(rpcUrl("ethereum-sepolia"));
const publicClient = createPublicClient({ chain: sepolia, transport });
const borrower = privateKeyToAccount(need("FUNDER_PRIVATE_KEY") as Hex);
const wallet = createWalletClient({ chain: sepolia, transport, account: borrower });
const floor = parseEther(need("KIDO_EVM_BALANCE_FLOOR"));
const runDir = resolve(process.env.KIDO_EVIDENCE_DIR ?? "../.gauntlet/evidence", `e2e-crosschain-rescue-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
const statePath = resolve(dirname(keysPath), "../state/crosschain-rescue.json");
const S: Record<string, any> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8"), (_k, v) => (v && typeof v === "object" && "$big" in v ? BigInt(v.$big) : v)) : {};
const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { $big: x.toString() } : x));
const save = () => (mkdirSync(dirname(statePath), { recursive: true }), writeFileSync(statePath, ser(S)));
const log = new FileEventLog(join(runDir, "events.jsonl"));
const evidence: { step: string; ok: boolean; data: unknown }[] = [];
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
function step(name: string, ok: boolean, data: unknown = {}) {
  evidence.push({ step: name, ok, data: JSON.parse(show(data)) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(76)} ${show(data).slice(0, 200)}`);
  if (!ok) finish(1);
}
function finish(code: number): never {
  writeFileSync(join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`evidence: ${runDir}`);
  process.exit(code);
}
const outcome = (name: string, o: AmaneOutcome, expect: string | RegExp) => {
  const got = o.kind === "REJECTED_BY_AMANE" ? o.code : o.kind;
  const ok = typeof expect === "string" ? got === expect : expect.test(got);
  step(`${name}${expect !== "EXECUTED" ? (o.tx ? " [landed]" : " [live simulation]") : ""}`, ok, { got, tx: o.tx, ...(o.kind === "OPERATIONAL_FAILURE" ? { message: o.message } : {}) });
  return o;
};
async function guardEth() {
  const bal = await publicClient.getBalance({ address: borrower.address });
  if (bal < floor) step("EVM relayer above the approved spend floor", false, { balance: formatEther(bal), floor: formatEther(floor) });
}
const nowS = () => BigInt(Math.floor(Date.now() / 1000));
const ethStart = await publicClient.getBalance({ address: borrower.address });
await guardEth();

// ---------------------------------------------------------------- facts from the registry and manifests
const aave = registry.get("aave-v3")!.deployments["ethereum-sepolia"] as Record<string, Address>;
const usdc = (m.evm.assets.aaveUSDC ?? step("Aave USDC recorded in the Amane manifest", false)).address as Address;
const wAmusd = m.evm.assets.wAMUSD.address as Address;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const reserveAbi = parseAbi(["function getReserveData(address) view returns ((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))"]);
const vDebt = ((await publicClient.readContract({ address: aave.pool!, abi: reserveAbi, functionName: "getReserveData", args: [usdc] })) as readonly unknown[])[10] as Address;
const core5 = m.sui.releases.v5.packageId as string;
const whEvm = m.evm.adapters.find((a: { name: string }) => a.name === "Wormhole Bridge");
const uni = m.evm.adapters.find((a: { name: string }) => a.name === "Uniswap V3 Swap");
const rep = m.evm.adapters.find((a: { name: string }) => a.name === "Aave V3 Repay");
const whSui = m.sui.adapters.find((a: { name: string; core?: string }) => a.name === "Wormhole Bridge" && a.core === "v5");
const cetus = m.sui.adapters.find((a: { name: string; core?: string }) => a.name === "Cetus CLMM Pinned Swap" && a.core === "v5");
const pool = m.sui.pools.cetusAmusdAmsui;
const tok = m.sui.tokens;
const relayer = Ed25519Keypair.fromSecretKey(keys.suiRelayer);
const suiEp = new AmaneSuiEndpoint(sui, core5, X.suiAccount, relayer);
const evmEp = new AmaneEvmEndpoint(publicClient as never, wallet as never, X.evmAccount);
const endpoints = { sui: suiEp, evm: evmEp };
const facts = wormholeFacts(m, { suiBridge: whSui.instance.bridge, evmAdapterId: whEvm.adapterId, coinType: tok.AMUSD.coinType });
const suiAcct = suiEp.account32, evmAcct = evmEp.account32;
const [usdSui, amsui] = [suiAssetId(tok.AMUSD.coinType), suiAssetId(tok.AMSUI.coinType)];
const [wUsd, usdc32, debt32] = [evmAssetId(wAmusd), evmAssetId(usdc), evmAssetId(vDebt)];
const borrower32 = addressToBytes32(borrower.address);
const owner32 = suiObjectToBytes32(keys.suiMerchant);
const suiPay = suiAdapterId({ chainRef: m.sui.chainRef, actionKind: ActionKind.PAY, adapterVersion: 1, adapterName: "Transfer Pay", witnessType: `${core5}::account::TransferPayV1` });
const suiWh = suiAdapterId({ chainRef: m.sui.chainRef, actionKind: ActionKind.BRIDGE, adapterVersion: 1, adapterName: "Wormhole Bridge", witnessType: whSui.witnessType });
const suiCetus = suiAdapterId({ chainRef: m.sui.chainRef, actionKind: ActionKind.SWAP, adapterVersion: 1, adapterName: cetus.name, witnessType: cetus.witnessType });
const cap = (assetId: Hex, n: bigint) => ({ assetId, maxPerAction: n, maxPerEpoch: 2n * n, maxTotal: 6n * n });
const actions = actionMask(ActionKind.SWAP, ActionKind.PAY, ActionKind.REPAY, ActionKind.BRIDGE);
const accountId = X.accountId as Hex;
const OWNER_AAVE = "Owner Aave position";

// ---------------------------------------------------------------- 1. owner extends the account's authority (policy v2)
if (!S.policy) {
  const v1 = X.policy as RootPolicy;
  const policy: RootPolicy = {
    ...v1, policyVersion: 2n, parentPolicyHash: amaneStructHash("RootPolicy", v1), allowedActions: actions, activateBefore: nowS() + 1800n,
    endpoints: [
      {
        ...v1.endpoints[0]!,
        adapters: [...v1.endpoints[0]!.adapters, { adapterId: suiCetus, adapterName: cetus.name, adapterVersion: 1 }],
        assets: [cap(usdSui, 25_000000n), cap(amsui, 15_000_000000n)],
        // 1 AMSUI (1e9) must return at least 0.95 AMUSD (0.95e6): 95 / 100000 raw.
        swapFloors: [{ assetIn: amsui, assetOut: usdSui, minOutNumerator: 95n, minOutDenominator: 100_000n }],
      },
      {
        ...v1.endpoints[1]!,
        adapters: [...v1.endpoints[1]!.adapters, { adapterId: uni.adapterId, adapterName: uni.name, adapterVersion: 1 }, { adapterId: rep.adapterId, adapterName: rep.name, adapterVersion: 1 }],
        assets: [cap(wUsd, 25_000000n), cap(usdc32, 20_000000n)],
        beneficiaries: [{ recipientId: borrower32, label: OWNER_AAVE }],
        swapFloors: [{ assetIn: wUsd, assetOut: usdc32, minOutNumerator: 95n, minOutDenominator: 100n }, { assetIn: usdc32, assetOut: debt32, minOutNumerator: 9_999n, minOutDenominator: 10_000n }],
      },
    ],
  };
  const lease: AgentLease = {
    accountId, policyVersion: 2n, leaseId: keccak256(toHex(`lease.rescue.${accountId}.${Date.now()}`)), agent: who.agent.address, issuer: who.controllerA.address,
    validAfter: nowS() - 60n, expiresAt: nowS() + 3n * 3600n, activateBefore: nowS() + 1800n, allowedActions: actions, authMode: AuthMode.AGENT_SIGNED,
    endpoints: [
      { chainRef: m.sui.chainRef, account: suiAcct, adapters: [suiPay, suiWh, suiCetus], assets: [cap(usdSui, 20_000000n), cap(amsui, 12_000_000000n)], recipients: [evmAcct, owner32], beneficiaries: [] },
      { chainRef: m.evm.chainRef, account: evmAcct, adapters: [whEvm.adapterId, uni.adapterId, rep.adapterId], assets: [cap(wUsd, 20_000000n), cap(usdc32, 15_000000n)], recipients: [suiAcct], beneficiaries: [borrower32] },
    ],
  };
  Object.assign(S, { policy, lease });
  save();
}
const policy = S.policy as RootPolicy;
const lease = S.lease as AgentLease;
if (!S.suiV2) {
  outcome("Sui: owner 2-of-2 installs policy v2 (Cetus swap, AMSUI, owner floor)", await suiEp.installPolicy(policy, await signThreshold([who.controllerA, who.controllerB], "RootPolicy", policy)), "EXECUTED");
  outcome("Sui: rescue lease activated", await suiEp.activateLease(lease, await signAmane(who.controllerA, "AgentLease", lease)), "EXECUTED");
  outcome("Sui: 12 AMSUI deposited (testnet faucet)", await suiEp.depositFromFaucet(tok.packageId, "amsui", tok.AMSUI.coinType, tok.AMSUI.faucet, 12_000_000000n), "EXECUTED");
  S.suiV2 = true;
  save();
}
if (!S.evmV2) {
  await guardEth();
  outcome("Sepolia: owner 2-of-2 installs policy v2 (Uniswap swap, Aave repay, pinned beneficiary)", await evmEp.installPolicy(policy, await signThreshold([who.controllerA, who.controllerB], "RootPolicy", policy)), "EXECUTED");
  outcome("Sepolia: rescue lease activated", await evmEp.activateLease(lease, await signAmane(who.controllerA, "AgentLease", lease)), "EXECUTED");
  S.evmV2 = true;
  save();
}

// ---------------------------------------------------------------- 2. the monitor fires
const readPos = () => readAavePosition({ client: publicClient as never, pool: aave.pool!, oracle: aave.oracle!, user: borrower.address, asset: usdc });
const pos0 = (await readPos()).position;
const needed = repayAmountFor(pos0, targetHf);
step("MONITOR  Aave health factor below the owner's target → rescue", pos0.healthFactor < targetHf, { healthFactor: pos0.healthFactor, target: targetHf, repayToTarget: needed });

let nonce = BigInt(Date.now() % 1_000_000) * 10n;
const intent = (chain: "sui" | "evm", o: Partial<ActionIntent>): ActionIntent => ({
  accountId, chainRef: chain === "sui" ? m.sui.chainRef : m.evm.chainRef, account: chain === "sui" ? suiAcct : evmAcct, policyVersion: 2n, leaseId: lease.leaseId, nonce: ++nonce,
  actionKind: ActionKind.SWAP, adapterId: ZERO32, adapterName: "", adapterVersion: 1, assetIn: ZERO32, assetOut: ZERO32, amountIn: 0n, minAmountOut: 0n,
  recipient: ZERO32, recipientLabel: "", deadline: nowS() + 600n, planHash: keccak256(toHex(`rescue.${accountId}`)), planStep: 0, ...o,
});
const sign = (i: ActionIntent) => signAmane(who.agent, "ActionIntent", i);

// ---------------------------------------------------------------- 3. Sui: raise AMUSD from AMSUI through the pinned Cetus pool
const route = { adapterPackage: cetus.package, module: cetus.module, witnessType: cetus.witnessType, coinA: pool.coinA, coinB: pool.coinB, a2b: pool.coinA === tok.AMSUI.coinType, pool: pool.pool, globalConfig: m.sui.protocols.cetusClmm.globalConfig };
const swapSui = (o: Partial<ActionIntent>) => intent("sui", { adapterId: suiCetus, adapterName: cetus.name, assetIn: amsui, assetOut: usdSui, amountIn: 11_000_000000n, planStep: 1, ...o });
const greedy = swapSui({ minAmountOut: 12_000000n });
outcome("ATTACK   Sui: swap demanding more than the pool gives", await suiEp.swapCetus(route, greedy, await sign(greedy)), "AMANE_ACTION_BELOW_MIN_OUT");
const redirect = swapSui({ recipient: owner32 });
outcome("ATTACK   Sui: swap output redirected away from the account", await suiEp.swapCetus(route, redirect, await sign(redirect)), "AMANE_ACTION_RECIPIENT_NOT_ALLOWED");
const usdBefore = await suiEp.vaultBalance(tok.AMUSD.coinType);
const s1 = swapSui({});
outcome("STEP 1   Sui: agent SWAP 11 AMSUI → AMUSD (pinned Cetus pool, owner floor)", await suiEp.swapCetus(route, s1, await sign(s1)), "EXECUTED");
const raised = (await suiEp.vaultBalance(tok.AMUSD.coinType)) - usdBefore;
step("         AMUSD raised on Sui, at or above the owner floor", raised >= 10_450000n, { raised });

// ---------------------------------------------------------------- 4. bridge with the destination pinned to "swap into Aave USDC"
const amount = 10_000000n;
const dest: DestSpec = { actionKind: ActionKind.SWAP, adapterId: uni.adapterId, recipient: ZERO32, recipientLabel: "", asset: wUsd, minArrival: amount, deadline: nowS() + 1800n };
const src = intent("sui", { actionKind: ActionKind.BRIDGE, adapterId: suiWh, adapterName: "Wormhole Bridge", assetIn: usdSui, assetOut: wUsd, amountIn: amount, recipient: evmAcct, recipientLabel: "Amane Sepolia endpoint", planHash: destSpecHash(dest), planStep: 2 });
const auth: AmaneBridgeAuthority = { src, srcSig: await sign(src), dest };
const xIntent: CrossChainIntent = {
  intentId: amaneIntentId(auth),
  source: { chain: "sui-testnet", account: suiAcct, asset: usdSui, amount },
  destination: { chain: "ethereum-sepolia", account: evmAcct, asset: wUsd, action: "SWAP", adapterId: uni.adapterId, beneficiary: ZERO32, minAmount: amount },
  deadline: Number(dest.deadline) * 1000,
  transport: "wormhole",
  authority: auth,
};
let usdcOut = 0n;
const swapEvm = (o: Partial<ActionIntent>) => intent("evm", { adapterId: uni.adapterId, adapterName: uni.name, assetIn: wUsd, assetOut: usdc32, amountIn: amount, planHash: xIntent.intentId, planStep: 3, ...o });
const repayEvm = (o: Partial<ActionIntent>) => intent("evm", { actionKind: ActionKind.REPAY, adapterId: rep.adapterId, adapterName: rep.name, assetIn: usdc32, assetOut: debt32, recipient: borrower32, recipientLabel: OWNER_AAVE, planStep: 4, ...o });
const engine = new CrossChainEngine(new WormholeAmaneTransport(endpoints, facts), new AmaneOnChainDestination("ethereum-sepolia", evmAcct, endpoints, facts), {
  authorizeSource: async (i) => ((i.authority as AmaneBridgeAuthority).src.planHash === destSpecHash(dest) ? { ok: true, detail: "source commits to SWAP-on-arrival" } : { ok: false, detail: "commitment mismatch" }),
  executeDestination: async (i, r) => {
    await guardEth();
    // Attacks on the reservation before the committed action runs.
    const direct = repayEvm({ amountIn: r.amount, planHash: i.intentId });
    outcome("ATTACK   Sepolia: reserved arrival spent straight on REPAY (not its committed action)", await evmEp.executeReserved(i.intentId, direct, await sign(direct)), "AMANE_XCHAIN_RESERVATION_MISMATCH");
    const viaBridge = swapEvm({ adapterId: whEvm.adapterId });
    outcome("ATTACK   Sepolia: reserved swap routed through another adapter", await evmEp.executeReserved(i.intentId, viaBridge, await sign(viaBridge)), "AMANE_XCHAIN_RESERVATION_MISMATCH");
    const other = swapEvm({ amountIn: 1_000000n, planHash: keccak256(toHex("unrelated")) });
    outcome("ATTACK   Sepolia: same lease swaps reserved funds outside the reservation", await evmEp.executeAction(other, await sign(other)), "AMANE_XCHAIN_RESERVED_FUNDS");
    const before = (await publicClient.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [X.evmAccount] })) as bigint;
    const sw = swapEvm({ amountIn: r.amount });
    const o = outcome("STEP 3   Sepolia: reserved SWAP wAMUSD → Aave USDC (the committed action)", await evmEp.executeReserved(i.intentId, sw, await sign(sw)), "EXECUTED");
    usdcOut = ((await publicClient.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [X.evmAccount] })) as bigint) - before;
    return { ok: o.kind === "EXECUTED", detail: `swapped into ${usdcOut} USDC ${o.tx}` };
  },
  recover: async (_i, why) => ({ ok: false, detail: `recovery required: ${why}` }),
}, log, "kido:agent:rescue");
await guardEth();
const run = await engine.run(xIntent, { pollIntervalMs: 15_000, maxPolls: 80 });
step("STEP 2   Sui → Sepolia bridge leg reached COMPLETE with an on-chain reservation", run.state === "COMPLETE" && run.history.some((h) => h.state === "RESERVED" && h.detail?.includes("enforced on-chain")), { history: run.history.map((h) => `${h.state}${h.detail ? `: ${h.detail.slice(0, 90)}` : ""}`) });
step("         swap output at or above the owner floor (0.95)", usdcOut * 100n >= amount * 95n, { usdcOut });

// ---------------------------------------------------------------- 5. separately bounded REPAY for the pinned beneficiary
const repayAmt = usdcOut < needed || needed === 0n ? usdcOut : needed;
const toAttacker = repayEvm({ amountIn: repayAmt, recipient: addressToBytes32(who.attacker.address) });
outcome("ATTACK   Sepolia: REPAY someone else's debt", await evmEp.executeAction(toAttacker, await sign(toAttacker)), /RECIPIENT_NOT_ALLOWED|BENEFICIARY/);
const tooMuch = repayEvm({ amountIn: 15_000001n });
outcome("ATTACK   Sepolia: REPAY above the lease per-action cap", await evmEp.executeAction(tooMuch, await sign(tooMuch)), "AMANE_BUDGET_PER_ACTION");
const d0 = (await publicClient.readContract({ address: vDebt, abi: erc20, functionName: "balanceOf", args: [borrower.address] })) as bigint;
const r1 = repayEvm({ amountIn: repayAmt });
await guardEth();
outcome("STEP 4   Sepolia: agent REPAY of the pinned beneficiary's Aave USDC debt", await evmEp.executeAction(r1, await sign(r1)), "EXECUTED");
const d1 = (await publicClient.readContract({ address: vDebt, abi: erc20, functionName: "balanceOf", args: [borrower.address] })) as bigint;
const pos1 = (await readPos()).position;
step("         debt reduced by what was repaid (measured on-chain by the account)", d0 - d1 >= (repayAmt * 9_999n) / 10_000n, { repaid: repayAmt, debtBefore: d0, debtAfter: d1 });
step("         health factor improved", pos1.healthFactor > pos0.healthFactor, { before: pos0.healthFactor, after: pos1.healthFactor, target: targetHf, reachedTarget: pos1.healthFactor >= targetHf });
step("         nothing left reserved on Sepolia", (await evmEp.locked(wAmusd)).reserved === 0n);
step("gas", true, { eth: formatEther(ethStart - (await publicClient.getBalance({ address: borrower.address }))) });
finish(0);
