/**
 * Kido-driven live cross-chain round trip: Kido's CrossChainEngine runs both legs through the
 * Wormhole transport, and the destination Amane account on each chain is the reservation
 * authority (the chain re-verifies the signed source intent and its DestSpec on arrival).
 *
 *   leg A  Sui → Sepolia   agent BRIDGE; arrival reserved on Sepolia; its committed destination
 *                          action is leg B
 *   leg B  Sepolia → Sui   reserved BRIDGE back; arrival reserved on Sui; destination action is a
 *                          PAY to the owner's pinned wallet
 *
 * Reuses the Amane endpoints, policy and lease deployed by Aname's live-bridge-roundtrip script.
 *
 * Env: KIDO_DEMO_KEYS (disposable keys; never printed), KIDO_XCHAIN_STATE (that script's state
 * file), SEPOLIA_RPC_URL, FUNDER_PRIVATE_KEY (gas only), KIDO_EVM_BALANCE_FLOOR (ETH).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, parseEther, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  ActionKind,
  AmaneEvmEndpoint,
  AmaneSuiEndpoint,
  ZERO32,
  destSpecHash,
  evmAssetId,
  loadAmaneManifest,
  signAmane,
  suiAdapterId,
  suiAssetId,
  suiObjectToBytes32,
  type ActionIntent,
  type DestSpec,
} from "@kido/amane-bridge";
import { AmaneOnChainDestination, WormholeAmaneTransport, amaneIntentId, wormholeFacts, type AmaneBridgeAuthority } from "@kido/foundry";
import { rpcUrl } from "@kido/registry";
import { CrossChainEngine, FileEventLog, type CrossChainIntent, type CrossChainRun } from "@kido/runtime";

const need = (k: string) => process.env[k] ?? (console.log(JSON.stringify({ status: "BLOCKED_ENV", missing: k })), process.exit(2));
const keys = JSON.parse(readFileSync(need("KIDO_DEMO_KEYS"), "utf8")) as { evm: Record<string, Hex>; suiRelayer: string; suiMerchant: string };
const S = JSON.parse(readFileSync(need("KIDO_XCHAIN_STATE"), "utf8"));
const agent = privateKeyToAccount(keys.evm.agent!);
const attacker = privateKeyToAccount(keys.evm.attacker!);
const manifest = loadAmaneManifest(resolve("../Aname/deployments/testnet.json"));
const m = manifest as unknown as { sui: any; evm: any };
const sui = new SuiGrpcClient({ network: "testnet", baseUrl: rpcUrl("sui-testnet") });
const transport = http(rpcUrl("ethereum-sepolia"));
const publicClient = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account: privateKeyToAccount(need("FUNDER_PRIVATE_KEY") as Hex) });
const floor = parseEther(need("KIDO_EVM_BALANCE_FLOOR"));
const runDir = resolve(process.env.KIDO_EVIDENCE_DIR ?? "../.gauntlet/evidence", `e2e-crosschain-kido-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
const log = new FileEventLog(join(runDir, "events.jsonl"));
const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const evidence: { step: string; ok: boolean; data: unknown }[] = [];
function step(name: string, ok: boolean, data: unknown = {}) {
  evidence.push({ step: name, ok, data: JSON.parse(ser(data)) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(74)} ${ser(data).slice(0, 200)}`);
  if (!ok) finish(1);
}
function finish(code: number): never {
  writeFileSync(join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`evidence: ${runDir}`);
  process.exit(code);
}
const nowS = () => BigInt(Math.floor(Date.now() / 1000));
const ethStart = await publicClient.getBalance({ address: wallet.account.address });
if (ethStart < floor) step("EVM relayer above the approved spend floor", false, { balance: formatEther(ethStart) });

// ---------------------------------------------------------------- deployed endpoints and facts
const relayer = Ed25519Keypair.fromSecretKey(keys.suiRelayer);
const core5 = m.sui.releases.v5.packageId as string;
const suiEp = new AmaneSuiEndpoint(sui, core5, S.suiAccount, relayer);
const evmEp = new AmaneEvmEndpoint(publicClient as never, wallet as never, S.evmAccount);
const whEvm = m.evm.adapters.find((a: { name: string }) => a.name === "Wormhole Bridge");
const whSui = m.sui.adapters.find((a: { name: string; core?: string }) => a.name === "Wormhole Bridge" && a.core === "v5");
const AMUSD = m.sui.tokens.AMUSD as { coinType: string };
const facts = wormholeFacts(m, { suiBridge: whSui.instance.bridge, evmAdapterId: whEvm.adapterId, coinType: AMUSD.coinType });
const endpoints = { sui: suiEp, evm: evmEp };
const lease = S.lease as { leaseId: Hex; expiresAt: { $big: string } };
const leaseExpiry = BigInt(lease.expiresAt.$big);
step("reusing the deployed Amane endpoints and the active cross-chain lease", nowS() < leaseExpiry - 3600n, { sui: S.suiAccount, evm: S.evmAccount, leaseSecondsLeft: Number(leaseExpiry - nowS()) });

const suiAcct = suiEp.account32;
const evmAcct = evmEp.account32;
const usdSui = suiAssetId(AMUSD.coinType);
const wUsd = evmAssetId(m.evm.assets.wAMUSD.address);
const owner32 = suiObjectToBytes32(keys.suiMerchant);
const suiPay = suiAdapterId({ chainRef: m.sui.chainRef, actionKind: ActionKind.PAY, adapterVersion: 1, adapterName: "Transfer Pay", witnessType: `${core5}::account::TransferPayV1` });
const suiWh = suiAdapterId({ chainRef: m.sui.chainRef, actionKind: ActionKind.BRIDGE, adapterVersion: 1, adapterName: "Wormhole Bridge", witnessType: whSui.witnessType });
const accountId = S.accountId as Hex;
const base = (chain: "sui" | "evm", nonce: bigint): ActionIntent => ({
  accountId, chainRef: chain === "sui" ? m.sui.chainRef : m.evm.chainRef, account: chain === "sui" ? suiAcct : evmAcct, policyVersion: 1n, leaseId: lease.leaseId, nonce,
  actionKind: ActionKind.BRIDGE, adapterId: chain === "sui" ? suiWh : whEvm.adapterId, adapterName: "Wormhole Bridge", adapterVersion: 1,
  assetIn: chain === "sui" ? usdSui : wUsd, assetOut: chain === "sui" ? wUsd : usdSui, amountIn: 6_000000n, minAmountOut: 0n,
  recipient: chain === "sui" ? evmAcct : suiAcct, recipientLabel: chain === "sui" ? "Amane Sepolia endpoint" : "Amane Sui endpoint",
  deadline: nowS() + 600n, planHash: ZERO32, planStep: 0,
});
const nonceBase = BigInt(Date.now() % 1_000_000) * 10n;

// ---------------------------------------------------------------- the two legs as Kido intents
const destB: DestSpec = { actionKind: ActionKind.PAY, adapterId: suiPay, recipient: owner32, recipientLabel: "Owner wallet (Sui)", asset: usdSui, minArrival: 6_000000n, deadline: nowS() + 7200n };
const destA: DestSpec = { actionKind: ActionKind.BRIDGE, adapterId: whEvm.adapterId, recipient: suiAcct, recipientLabel: "Amane Sui endpoint", asset: wUsd, minArrival: 6_000000n, deadline: nowS() + 1800n };
const srcA: ActionIntent = { ...base("sui", nonceBase + 1n), planHash: destSpecHash(destA), planStep: 1 };
const authA: AmaneBridgeAuthority = { src: srcA, srcSig: await signAmane(agent, "ActionIntent", srcA), dest: destA };
const intentA: CrossChainIntent = {
  intentId: amaneIntentId(authA),
  source: { chain: "sui-testnet", account: suiAcct, asset: usdSui, amount: 6_000000n },
  destination: { chain: "ethereum-sepolia", account: evmAcct, asset: wUsd, action: "BRIDGE", adapterId: destA.adapterId, beneficiary: destA.recipient, minAmount: destA.minArrival },
  deadline: Number(destA.deadline) * 1000,
  transport: "wormhole",
  authority: authA,
};
const srcB: ActionIntent = { ...base("evm", nonceBase + 2n), planHash: destSpecHash(destB), planStep: 2 };
const authB: AmaneBridgeAuthority = { src: srcB, srcSig: await signAmane(agent, "ActionIntent", srcB), dest: destB, reservedFor: intentA.intentId };
const intentB: CrossChainIntent = {
  intentId: amaneIntentId(authB),
  source: { chain: "ethereum-sepolia", account: evmAcct, asset: wUsd, amount: 6_000000n },
  destination: { chain: "sui-testnet", account: suiAcct, asset: usdSui, action: "PAY", adapterId: suiPay, beneficiary: owner32, minAmount: destB.minArrival },
  deadline: Number(destB.deadline) * 1000,
  transport: "wormhole",
  authority: authB,
};

const wormholeT = new WormholeAmaneTransport(endpoints, facts);
const ownerBal = async () => BigInt((await sui.getBalance({ owner: keys.suiMerchant, coinType: AMUSD.coinType })).balance.balance);
const ownerBefore = await ownerBal();
const preflight = async (i: CrossChainIntent) => {
  // Defence in depth only: the chain is the boundary. The source intent must commit to its DestSpec.
  const a = i.authority as AmaneBridgeAuthority;
  return a.src.planHash === destSpecHash(a.dest) && i.intentId === amaneIntentId(a) ? { ok: true, detail: "source commits to the pinned destination" } : { ok: false, detail: "commitment mismatch" };
};

let runB: CrossChainRun | undefined;
const engineB = new CrossChainEngine(wormholeT, new AmaneOnChainDestination("sui-testnet", suiAcct, endpoints, facts), {
  authorizeSource: preflight,
  executeDestination: async (i, r) => {
    const pay: ActionIntent = { ...base("sui", nonceBase + 3n), actionKind: ActionKind.PAY, adapterId: suiPay, adapterName: "Transfer Pay", assetIn: usdSui, assetOut: usdSui, amountIn: r.amount, recipient: owner32, recipientLabel: "Owner wallet (Sui)", planHash: i.intentId, planStep: 3 };
    const out = await suiEp.payReserved(AMUSD.coinType, i.intentId, pay, await signAmane(agent, "ActionIntent", pay));
    return { ok: out.kind === "EXECUTED", detail: out.kind === "EXECUTED" ? `reserved PAY to the owner ${out.tx}` : ser(out) };
  },
  recover: async (_i, why) => ({ ok: false, detail: `recovery required: ${why}` }),
}, log, "kido:agent:crosschain");

const engineA = new CrossChainEngine(wormholeT, new AmaneOnChainDestination("ethereum-sepolia", evmAcct, endpoints, facts), {
  authorizeSource: preflight,
  // Leg A's committed destination action is the reserved BRIDGE back: leg B.
  executeDestination: async () => {
    runB = await engineB.run(intentB, { pollIntervalMs: 20_000, maxPolls: 180 });
    return { ok: runB.state === "COMPLETE", detail: `leg B ${runB.state}${runB.rejection ? ` (${runB.rejection})` : ""}` };
  },
  recover: async (_i, why) => ({ ok: false, detail: `recovery required: ${why}` }),
}, log, "kido:agent:crosschain");

// ---------------------------------------------------------------- a refused source commits nothing
{
  const bad: ActionIntent = { ...base("sui", nonceBase + 9n), recipient: suiObjectToBytes32(`0x${"ee".repeat(32)}`), planHash: destSpecHash(destA) };
  const auth: AmaneBridgeAuthority = { src: bad, srcSig: await signAmane(agent, "ActionIntent", bad), dest: destA };
  const run = await engineA.run({ ...intentA, intentId: amaneIntentId(auth), authority: auth }, { pollIntervalMs: 0, maxPolls: 0 });
  step("ATTACK   engine: BRIDGE to an unpinned endpoint is refused by the Sui account", run.state === "SOURCE_AUTHORIZED" && /RECIPIENT_NOT_ALLOWED/.test(run.rejection ?? ""), { state: run.state, rejection: run.rejection });
  const forged: AmaneBridgeAuthority = { src: srcA, srcSig: await signAmane(attacker, "ActionIntent", srcA), dest: destA };
  const run2 = await engineA.run({ ...intentA, authority: forged }, { pollIntervalMs: 0, maxPolls: 0 });
  step("ATTACK   engine: attacker-signed BRIDGE is refused by the Sui account", run2.state === "SOURCE_AUTHORIZED" && /WRONG_AGENT/.test(run2.rejection ?? ""), { state: run2.state, rejection: run2.rejection });
}

// ---------------------------------------------------------------- the round trip
const runA = await engineA.run(intentA, { pollIntervalMs: 15_000, maxPolls: 80 });
step("leg A (Sui → Sepolia) reached COMPLETE", runA.state === "COMPLETE", { history: runA.history.map((h) => `${h.state}${h.detail ? `: ${h.detail}` : ""}`) });
step("leg B (Sepolia → Sui) reached COMPLETE", runB?.state === "COMPLETE", { history: runB?.history.map((h) => `${h.state}${h.detail ? `: ${h.detail}` : ""}`) });
step("both reservations were made on-chain, not by a local mirror", [runA, runB].every((r) => r?.history.some((h) => h.state === "RESERVED" && h.detail?.includes("enforced on-chain"))));
const received = (await ownerBal()) - ownerBefore;
step("owner's Sui wallet received the round-tripped 6 AMUSD", received === 6_000000n, { received });
step("nothing left reserved on either chain", (await suiEp.reservedOf(AMUSD.coinType)) === 0n && (await evmEp.locked(m.evm.assets.wAMUSD.address)).reserved === 0n);
step("gas", true, { eth: formatEther(ethStart - (await publicClient.getBalance({ address: wallet.account.address }))) });
finish(0);
