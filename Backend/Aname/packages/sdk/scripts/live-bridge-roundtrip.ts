/// Live Sui testnet ⇄ Sepolia round trip through Amane on both chains, over the Wormhole Token
/// Bridge. One logical account (one root policy, one lease) has an endpoint on each chain:
///
///   L1  Sui → Sepolia   agent-signed BRIDGE; the arrival is reserved on Sepolia for that intent,
///                       whose DestSpec commits to a BRIDGE back to the Sui endpoint
///   L2  Sepolia → Sui   reserved BRIDGE back; the arrival is reserved on Sui and paid to the
///                       owner's pinned wallet
///   L3  Sepolia → Sui   reserved BRIDGE back with a short deadline that expires in flight; the
///                       arrival is quarantined and moved only by a root-threshold withdrawal
///   rest                the unspent Sepolia reservation expires into quarantine and is recovered
///
/// Attacks run against the live contracts: rejections are landed on-chain where marked, the rest
/// are live simulations (eth_call / Sui simulation against current state, no gas).
///
///   AMANE_DEMO_KEYS=<disposable key file>  AMANE_EVM_RELAYER_KEY=<funded gas key>
///   SEPOLIA_RPC_URL=<rpc>  AMANE_EVM_BALANCE_FLOOR=<ETH; stop before the relayer drops below>
///   npx tsx scripts/live-bridge-roundtrip.ts
///
/// Progress is kept in <keys dir>/../state/bridge-roundtrip.json, so a stalled VAA wait resumes
/// without redeploying.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatEther,
  getContractAddress,
  hexToBytes,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import {
  ActionKind,
  AuthMode,
  PriceMode,
  ZERO32,
  actionMask,
  addressToBytes32,
  amaneDigest,
  destSpecHash,
  evmAssetId,
  suiAdapterId,
  suiAssetId,
  suiObjectToBytes32,
  type ActionIntent,
  type AgentLease,
  type Bytes32,
  type DestSpec,
  type RootPolicy,
  type Withdraw,
} from '@amane/core';
import {
  AmaneEvmEndpoint,
  AmaneSuiEndpoint,
  adapterRegistryAbi,
  amaneAccountExtAbi,
  amaneAccountExtBytecode,
  signAmane,
  signThreshold,
  wormholeBridgeAdapterAbi,
  wormholeBridgeAdapterBytecode,
  type AmaneOutcome,
  type WormholeSuiRoute,
} from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const m = JSON.parse(readFileSync(resolve(root, 'deployments/testnet.json'), 'utf8'));
const fail = (msg: string): never => {
  throw new Error(msg);
};
const keysPath = process.env.AMANE_DEMO_KEYS ?? fail('AMANE_DEMO_KEYS is required');
const keys = JSON.parse(readFileSync(keysPath, 'utf8')) as { evm: Record<string, Hex>; suiRelayer: string; suiMerchant: string; suiRecovery: string };
const who = Object.fromEntries(Object.entries(keys.evm).map(([k, v]) => [k, privateKeyToAccount(v)])) as Record<
  'controllerA' | 'controllerB' | 'issuer' | 'agent' | 'attacker' | 'recovery',
  ReturnType<typeof privateKeyToAccount>
>;
const suiRelayer = Ed25519Keypair.fromSecretKey(keys.suiRelayer);
const sui = new SuiGrpcClient({ network: 'testnet', baseUrl: process.env.SUI_GRPC_URL ?? 'https://fullnode.testnet.sui.io:443' });
const rpc = process.env.SEPOLIA_RPC_URL ?? fail('SEPOLIA_RPC_URL is required');
const publicClient = createPublicClient({ chain: sepolia, transport: http(rpc) });
const relayer = createWalletClient({ chain: sepolia, transport: http(rpc), account: privateKeyToAccount((process.env.AMANE_EVM_RELAYER_KEY ?? fail('AMANE_EVM_RELAYER_KEY is required')) as Hex) });
const floor = parseEther(process.env.AMANE_EVM_BALANCE_FLOOR ?? fail('AMANE_EVM_BALANCE_FLOOR is required (ETH)'));
const now = () => BigInt(Math.floor(Date.now() / 1000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- manifest facts
const W = m.sui.protocols.wormhole;
const WE = m.evm.protocols.wormhole;
const core5: string = m.sui.releases?.v5?.packageId ?? fail('Sui core v5 missing from manifest');
const whSui = m.sui.adapters.find((a: { name: string; core?: string }) => a.name === 'Wormhole Bridge' && a.core === 'v5') ?? fail('Sui Wormhole adapter missing');
const AMUSD = m.sui.tokens.AMUSD;
const ADAPTER_NAME = 'Wormhole Bridge';
const LABEL_EVM = 'Amane Sepolia endpoint';
const LABEL_SUI = 'Amane Sui endpoint';
const LABEL_OWNER = 'Owner wallet (Sui)';

// ---------------------------------------------------------------- state + evidence
const statePath = resolve(dirname(keysPath), '../state/bridge-roundtrip.json');
const big = (_: string, v: unknown) => (typeof v === 'bigint' ? { $big: v.toString() } : v);
const unbig = (_: string, v: unknown) => (v && typeof v === 'object' && '$big' in (v as object) ? BigInt((v as { $big: string }).$big) : v);
const S: Record<string, any> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8'), unbig) : {};
const save = () => {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(S, big, 2));
};
const evidence: { step: string; landed: boolean; outcome: unknown }[] = [];
const ethStart = await publicClient.getBalance({ address: relayer.account.address });
const suiStart = BigInt((await sui.getBalance({ owner: suiRelayer.toSuiAddress() })).balance.balance);

function record(step: string, outcome: AmaneOutcome | Record<string, unknown>, expect?: string) {
  const o = outcome as AmaneOutcome;
  const tx = 'tx' in o ? (o as { tx?: string }).tx : undefined;
  evidence.push({ step, landed: Boolean(tx), outcome });
  const got = o.kind === 'REJECTED_BY_AMANE' ? o.code : o.kind;
  const ok = !expect || got === expect;
  const how = expect && expect !== 'EXECUTED' ? (tx ? ' [landed]' : ' [live simulation]') : '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step.padEnd(70)} ${got ?? ''}${how}${tx ? `  ${tx}` : ''}`);
  if (!ok) {
    flush();
    fail(`${step}: expected ${expect}, got ${got}${o.kind === 'OPERATIONAL_FAILURE' ? ` (${o.message})` : ''}`);
  }
}
function flush() {
  const out = resolve(dirname(keysPath), `../evidence/bridge-roundtrip-${Date.now()}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ state: S, evidence }, big, 2));
  console.log(`evidence: ${out}`);
}
async function guardEth() {
  const bal = await publicClient.getBalance({ address: relayer.account.address });
  if (bal < floor) {
    flush();
    fail(`EVM relayer at ${formatEther(bal)} ETH, below the approved floor ${formatEther(floor)}; stopping to ask before spending more`);
  }
}
const waitOk = async (hash: Hex) => {
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') fail(`tx failed ${hash}`);
  return r;
};

/// Signed VAA from the guardian network, as indexed by Wormholescan.
async function fetchVaa(chain: number, emitter: string, sequence: bigint, maxMinutes: number): Promise<Uint8Array> {
  const url = `${WE.vaaApi}/${chain}/${emitter.replace(/^0x/, '').toLowerCase().padStart(64, '0')}/${sequence}`;
  const deadline = Date.now() + maxMinutes * 60_000;
  for (let i = 0; Date.now() < deadline; i++) {
    const res = await fetch(url).catch(() => undefined);
    if (res?.ok) {
      const body = (await res.json()) as { data?: { vaa?: string } };
      if (body.data?.vaa) return new Uint8Array(Buffer.from(body.data.vaa, 'base64'));
    }
    if (i % 4 === 0) console.log(`      waiting for guardian signatures on ${chain}/${sequence} ...`);
    await sleep(15_000);
  }
  flush();
  return fail(`no signed VAA for ${chain}/${sequence} within ${maxMinutes} min`);
}

const coreAbi = parseAbi(['event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)']);
const tbAbi = parseAbi(['function createWrapped(bytes encodedVm) returns (address token)', 'function wrappedAsset(uint16 tokenChainId, bytes32 tokenAddress) view returns (address)']);
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
async function evmSequence(tx: Hex): Promise<bigint> {
  const r = await publicClient.getTransactionReceipt({ hash: tx });
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== WE.core.toLowerCase()) continue;
    const e = decodeEventLog({ abi: coreAbi, data: log.data, topics: log.topics });
    if (e.args.sender.toLowerCase() === WE.tokenBridge.toLowerCase()) return e.args.sequence;
  }
  return fail(`no token bridge message in ${tx}`);
}
async function suiExec(tx: Transaction) {
  const res = await sui.signAndExecuteTransaction({ transaction: tx, signer: suiRelayer, include: { effects: true, events: true, objectTypes: true } });
  const done = res.Transaction ?? res.FailedTransaction!;
  if (!res.Transaction) fail(`Sui tx failed: ${JSON.stringify(done.status)} ${done.digest}`);
  await sui.waitForTransaction({ digest: done.digest });
  return done;
}
async function suiView<T>(target: string, args: (tx: Transaction) => any[], parse: (b: Uint8Array) => T): Promise<T> {
  const tx = new Transaction();
  tx.setSender(suiRelayer.toSuiAddress());
  tx.moveCall({ target, arguments: args(tx) });
  const res = await sui.simulateTransaction({ transaction: tx, include: { commandResults: true } });
  if (!res.Transaction) fail(`view ${target} failed`);
  return parse(res.commandResults![0]!.returnValues[0]!.bcs);
}

console.log(`EVM relayer ${relayer.account.address} ${formatEther(ethStart)} ETH (floor ${formatEther(floor)}); Sui relayer ${suiRelayer.toSuiAddress()} ${Number(suiStart) / 1e9} SUI`);
await guardEth();

// ================================================================ 1. transport pair
// The Sui bridge pins its peer (the EVM adapter address) at creation and the EVM adapter pins the
// Sui adapter's EmitterCap id, so the EVM address is fixed first from the relayer's next nonce.
if (!S.bridge) {
  const nonce = await publicClient.getTransactionCount({ address: relayer.account.address, blockTag: 'pending' });
  const predicted = getContractAddress({ from: relayer.account.address, nonce: BigInt(nonce) });
  const caps = await sui.listOwnedObjects({ owner: suiRelayer.toSuiAddress(), type: `${whSui.package}::wormhole_bridge::SetupCap` });
  const cap = caps.objects[0] ?? fail('SetupCap not owned by the Sui relayer');
  const tx = new Transaction();
  tx.moveCall({
    target: `${whSui.package}::wormhole_bridge::create`,
    arguments: [tx.object(cap.objectId), tx.object(W.coreState), tx.pure.u16(WE.chainId), tx.pure.vector('u8', Array.from(hexToBytes(addressToBytes32(predicted))))],
  });
  const done = await suiExec(tx);
  const bridge = done.effects!.changedObjects.find((o) => o.idOperation === 'Created' && /::wormhole_bridge::Bridge$/.test(done.objectTypes?.[o.objectId] ?? ''))?.objectId ?? fail('Bridge not created');
  const emitter = await suiView(`${whSui.package}::wormhole_bridge::emitter_id`, (t) => [t.object(bridge)], (b) => bcs.Address.parse(b));
  Object.assign(S, { bridge, emitter: suiObjectToBytes32(emitter), evmAdapterNonce: nonce, evmAdapterPredicted: predicted, bridgeTx: done.digest });
  save();
}
record('Sui Wormhole bridge created (peer = EVM adapter address, fixed once)', { kind: 'EXECUTED', tx: S.bridgeTx, bridge: S.bridge, emitter: S.emitter, peer: S.evmAdapterPredicted });

if (!S.evmAdapter) {
  await guardEth();
  const hash = await relayer.deployContract({ abi: wormholeBridgeAdapterAbi, bytecode: wormholeBridgeAdapterBytecode, args: [WE.tokenBridge, W.chainId, S.emitter, S.emitter], nonce: S.evmAdapterNonce });
  const r = await waitOk(hash);
  if (r.contractAddress?.toLowerCase() !== S.evmAdapterPredicted.toLowerCase()) fail(`EVM adapter landed at ${r.contractAddress}, Sui bridge pins ${S.evmAdapterPredicted}`);
  const { request, result } = await publicClient.simulateContract({ account: relayer.account, address: m.evm.adapterRegistry, abi: adapterRegistryAbi, functionName: 'register', args: [r.contractAddress!] } as never);
  await waitOk(await relayer.writeContract(request as never));
  Object.assign(S, { evmAdapter: r.contractAddress, evmAdapterId: result as Bytes32, evmAdapterTx: hash });
  save();
}
record('EVM Wormhole adapter deployed at the pinned address and registered', { kind: 'EXECUTED', tx: S.evmAdapterTx, adapter: S.evmAdapter, adapterId: S.evmAdapterId });

if (!S.ext) {
  await guardEth();
  const hash = await relayer.deployContract({ abi: amaneAccountExtAbi, bytecode: amaneAccountExtBytecode });
  S.ext = (await waitOk(hash)).contractAddress;
  S.extTx = hash;
  save();
}
record('AmaneAccountExt (core v3 extension) deployed', { kind: 'EXECUTED', tx: S.extTx, ext: S.ext });

// ================================================================ 2. AMUSD on Sepolia (Token Bridge attestation)
const metaId = (await sui.getCoinMetadata({ coinType: AMUSD.coinType })).coinMetadata?.id ?? fail("AMUSD metadata not found");
const amusdOrigin = suiObjectToBytes32(metaId);
let wAmusd = (await publicClient.readContract({ address: WE.tokenBridge, abi: tbAbi, functionName: 'wrappedAsset', args: [W.chainId, amusdOrigin] })) as Address;
if (BigInt(wAmusd) === 0n) {
  if (S.attestSeq === undefined) {
    const tx = new Transaction();
    const msg = tx.moveCall({ target: `${W.tokenBridgePackage}::attest_token::attest_token`, typeArguments: [AMUSD.coinType], arguments: [tx.object(W.tokenBridgeState), tx.object(metaId), tx.pure.u32(0)] });
    const [fee] = tx.splitCoins(tx.gas, [0n]);
    tx.moveCall({ target: `${W.corePackage}::publish_message::publish_message`, arguments: [tx.object(W.coreState), fee!, msg, tx.object('0x6')] });
    const done = await suiExec(tx);
    const ep = new AmaneSuiEndpoint(sui, core5, '0x0', suiRelayer);
    S.attestSeq = await ep.wormholeSequence(done.digest, W.tokenBridgeEmitter);
    S.attestTx = done.digest;
    save();
  }
  const vaa = await fetchVaa(W.chainId, W.tokenBridgeEmitter, S.attestSeq, 20);
  await guardEth();
  await waitOk(await relayer.writeContract({ address: WE.tokenBridge, abi: tbAbi, functionName: 'createWrapped', args: [toHex(vaa)] }));
  wAmusd = (await publicClient.readContract({ address: WE.tokenBridge, abi: tbAbi, functionName: 'wrappedAsset', args: [W.chainId, amusdOrigin] })) as Address;
}
S.wAmusd = wAmusd;
save();
record('AMUSD attested from Sui; Wormhole-wrapped AMUSD exists on Sepolia', { kind: 'EXECUTED', tx: S.attestTx, wrapped: wAmusd, origin: amusdOrigin });

// ================================================================ 3. one account, two endpoints
if (!S.accountId) {
  S.accountId = keccak256(toHex(`amane.xchain.${who.controllerA.address}.${Date.now()}`));
  save();
}
const accountId: Bytes32 = S.accountId;
const controllers = [who.controllerA.address, who.controllerB.address];
if (!S.suiAccount) {
  const { endpoint, tx } = await AmaneSuiEndpoint.create({ client: sui, packageId: core5, relayer: suiRelayer, accountId, chainRef: m.sui.chainRef, controllers, threshold: 2 });
  Object.assign(S, { suiAccount: endpoint.objectId, suiAccountTx: tx });
  save();
}
const suiEp = new AmaneSuiEndpoint(sui, core5, S.suiAccount, suiRelayer);
if (!S.evmAccount) {
  await guardEth();
  const { endpoint, tx } = await AmaneEvmEndpoint.deploy({ publicClient: publicClient as never, relayer: relayer as never, accountId, controllers, threshold: 2, registry: m.evm.adapterRegistry, ext: S.ext });
  Object.assign(S, { evmAccount: endpoint.address, evmAccountTx: tx });
  save();
}
const evmEp = new AmaneEvmEndpoint(publicClient as never, relayer as never, S.evmAccount);
record('Sui endpoint (core v5) and Sepolia endpoint (core v3) for one account id', { kind: 'EXECUTED', sui: S.suiAccount, evm: S.evmAccount, core: await evmEp.coreVersion() });

const suiAcct = suiEp.account32;
const evmAcct = evmEp.account32;
const usdSui = suiAssetId(AMUSD.coinType);
const wUsd = evmAssetId(wAmusd);
const owner32 = suiObjectToBytes32(keys.suiMerchant);
const suiPay = suiAdapterId({ chainRef: m.sui.chainRef, actionKind: ActionKind.PAY, adapterVersion: 1, adapterName: 'Transfer Pay', witnessType: `${core5}::account::TransferPayV1` });
const suiWh = suiAdapterId({ chainRef: m.sui.chainRef, actionKind: ActionKind.BRIDGE, adapterVersion: 1, adapterName: ADAPTER_NAME, witnessType: whSui.witnessType });
const cap = (assetId: Hex, n: bigint) => ({ assetId, maxPerAction: n, maxPerEpoch: 2n * n, maxTotal: 6n * n });
const actions = actionMask(ActionKind.PAY, ActionKind.BRIDGE);

if (!S.policy) {
  S.policy = {
    accountId, policyVersion: 1n, parentPolicyHash: ZERO32, allowedActions: actions, priceMode: PriceMode.TESTNET_FIXED, maxLeaseLifetime: 86_400n, activateBefore: now() + 1800n,
    endpoints: [
      {
        chainRef: m.sui.chainRef, account: suiAcct, epochSeconds: 3600n,
        adapters: [{ adapterId: suiPay, adapterName: 'Transfer Pay', adapterVersion: 1 }, { adapterId: suiWh, adapterName: ADAPTER_NAME, adapterVersion: 1 }],
        assets: [cap(usdSui, 25_000000n)],
        recipients: [{ recipientId: evmAcct, label: LABEL_EVM }, { recipientId: owner32, label: LABEL_OWNER }],
        beneficiaries: [], swapFloors: [],
        recoveryDestinations: [{ recipientId: suiObjectToBytes32(keys.suiRecovery), label: 'Owner recovery (Sui)' }],
      },
      {
        chainRef: m.evm.chainRef, account: evmAcct, epochSeconds: 3600n,
        adapters: [{ adapterId: S.evmAdapterId, adapterName: ADAPTER_NAME, adapterVersion: 1 }],
        assets: [cap(wUsd, 25_000000n)],
        recipients: [{ recipientId: suiAcct, label: LABEL_SUI }],
        beneficiaries: [], swapFloors: [],
        recoveryDestinations: [{ recipientId: addressToBytes32(who.recovery.address), label: 'Owner recovery (Sepolia)' }],
      },
    ],
    leaseIssuers: [],
  } satisfies RootPolicy;
  S.lease = {
    accountId, policyVersion: 1n, leaseId: keccak256(toHex(`lease.xchain.${accountId}`)), agent: who.agent.address, issuer: who.controllerA.address,
    validAfter: now() - 60n, expiresAt: now() + 4n * 3600n, activateBefore: now() + 1800n, allowedActions: actions, authMode: AuthMode.AGENT_SIGNED,
    endpoints: [
      { chainRef: m.sui.chainRef, account: suiAcct, adapters: [suiPay, suiWh], assets: [cap(usdSui, 20_000000n)], recipients: [evmAcct, owner32], beneficiaries: [] },
      { chainRef: m.evm.chainRef, account: evmAcct, adapters: [S.evmAdapterId], assets: [cap(wUsd, 20_000000n)], recipients: [suiAcct], beneficiaries: [] },
    ],
  } satisfies AgentLease;
  save();
}
const policy = S.policy as RootPolicy;
const lease = S.lease as AgentLease;
if (!S.suiReady) {
  const sigs = await signThreshold([who.controllerA, who.controllerB], 'RootPolicy', policy);
  record('Sui: install root policy (2-of-2)', await suiEp.installPolicy(policy, sigs), 'EXECUTED');
  record('Sui: activate lease', await suiEp.activateLease(lease, await signAmane(who.controllerA, 'AgentLease', lease)), 'EXECUTED');
  record('Sui: fund the endpoint with 50 AMUSD (testnet faucet)', await suiEp.depositFromFaucet(m.sui.tokens.packageId, 'amusd', AMUSD.coinType, AMUSD.faucet, 50_000000n), 'EXECUTED');
  S.suiReady = true;
  save();
}
if (!S.evmReady) {
  await guardEth();
  const sigs = await signThreshold([who.controllerA, who.controllerB], 'RootPolicy', policy);
  record('Sepolia: install the same root policy (2-of-2)', await evmEp.installPolicy(policy, sigs), 'EXECUTED');
  record('Sepolia: activate the same lease', await evmEp.activateLease(lease, await signAmane(who.controllerA, 'AgentLease', lease)), 'EXECUTED');
  S.evmReady = true;
  save();
}

const route: WormholeSuiRoute = {
  adapterPackage: whSui.package, bridge: S.bridge, coinType: AMUSD.coinType,
  tokenBridge: { package: W.tokenBridgePackage, state: W.tokenBridgeState }, wormhole: { package: W.corePackage, state: W.coreState },
};
const base = (chain: 'sui' | 'evm', nonce: bigint): ActionIntent => ({
  accountId, chainRef: chain === 'sui' ? m.sui.chainRef : m.evm.chainRef, account: chain === 'sui' ? suiAcct : evmAcct, policyVersion: 1n, leaseId: lease.leaseId, nonce,
  actionKind: ActionKind.BRIDGE, adapterId: chain === 'sui' ? suiWh : S.evmAdapterId, adapterName: ADAPTER_NAME, adapterVersion: 1,
  assetIn: chain === 'sui' ? usdSui : wUsd, assetOut: chain === 'sui' ? wUsd : usdSui, amountIn: 0n, minAmountOut: 0n,
  recipient: chain === 'sui' ? evmAcct : suiAcct, recipientLabel: chain === 'sui' ? LABEL_EVM : LABEL_SUI,
  deadline: now() + 600n, planHash: ZERO32, planStep: 0,
});
const agentSign = (i: ActionIntent) => signAmane(who.agent, 'ActionIntent', i);
const attackerSign = (i: ActionIntent) => signAmane(who.attacker, 'ActionIntent', i);
const attacker32 = suiObjectToBytes32(`0x${'ee'.repeat(32)}`);
const land = { submitRejected: true };

// ================================================================ L1: Sui → Sepolia
if (!S.l1) {
  const dest: DestSpec = { actionKind: ActionKind.BRIDGE, adapterId: S.evmAdapterId, recipient: suiAcct, recipientLabel: LABEL_SUI, asset: wUsd, minArrival: 20_000000n, deadline: now() + 1200n };
  const intent: ActionIntent = { ...base('sui', 1n), amountIn: 20_000000n, planHash: destSpecHash(dest), planStep: 1 };
  S.l1 = { dest, intent, sig: await agentSign(intent), digest: amaneDigest('ActionIntent', intent) };
  save();
}
if (!S.l1Tx) {
  const unpinned = { ...base('sui', 90n), amountIn: 1_000000n, recipient: attacker32 };
  record('ATTACK   Sui: BRIDGE to an endpoint not pinned in the lease', await suiEp.bridgeOutWormhole(route, unpinned, await agentSign(unpinned)), 'AMANE_ACTION_RECIPIENT_NOT_ALLOWED');
  const over = { ...base('sui', 91n), amountIn: 20_000001n };
  record('ATTACK   Sui: BRIDGE above the per-action cap', await suiEp.bridgeOutWormhole(route, over, await agentSign(over)), 'AMANE_BUDGET_PER_ACTION');
  const forged = { ...base('sui', 92n), amountIn: 1_000000n };
  record('ATTACK   Sui: BRIDGE signed by an attacker key', await suiEp.bridgeOutWormhole(route, forged, await attackerSign(forged), land), 'AMANE_ACTION_WRONG_AGENT');
  const out = await suiEp.bridgeOutWormhole(route, S.l1.intent, S.l1.sig);
  record('L1       Sui: agent BRIDGE 20 AMUSD → Sepolia endpoint (Wormhole transfer published)', out, 'EXECUTED');
  S.l1Tx = (out as { tx: string }).tx;
  S.l1Seq = await suiEp.wormholeSequence(S.l1Tx, W.tokenBridgeEmitter);
  save();
}
const vaa1 = toHex(await fetchVaa(W.chainId, W.tokenBridgeEmitter, S.l1Seq, 30));
record('L1       signed VAA fetched from the guardian network', { kind: 'EXECUTED', sequence: S.l1Seq });

if (!S.l1Received) {
  await guardEth();
  const swapped: DestSpec = { ...S.l1.dest, recipient: attacker32 };
  record('ATTACK   Sepolia: relayer substitutes the destination spec', await evmEp.receiveCrossChain(S.l1.intent, S.l1.sig, swapped, S.evmAdapterId, vaa1), 'AMANE_XCHAIN_SPEC_MISMATCH');
  record('ATTACK   Sepolia: source intent with a forged agent signature', await evmEp.receiveCrossChain(S.l1.intent, await attackerSign(S.l1.intent), S.l1.dest, S.evmAdapterId, vaa1), 'AMANE_ACTION_WRONG_AGENT');
  const other = { ...S.l1.intent, nonce: 93n };
  record('ATTACK   Sepolia: VAA presented for a different signed intent', await evmEp.receiveCrossChain(other, await agentSign(other), S.l1.dest, S.evmAdapterId, vaa1), 'AMANE_XCHAIN_PAYLOAD_MISMATCH');
  const got = await evmEp.receiveCrossChain(S.l1.intent, S.l1.sig, S.l1.dest, S.evmAdapterId, vaa1);
  record('L1       Sepolia: arrival redeemed and reserved for the source intent', got, 'EXECUTED');
  S.l1Received = (got as { tx: string }).tx;
  save();
}
const locked1 = await evmEp.locked(wAmusd);
record('         Sepolia: 20 wAMUSD reserved, none spendable by other actions', { ...locked1, balance: await publicClient.readContract({ address: wAmusd, abi: erc20, functionName: 'balanceOf', args: [S.evmAccount] }) });

// ================================================================ L2 + L3: Sepolia → Sui (reserved BRIDGE back)
if (!S.l2) {
  const d2: DestSpec = { actionKind: ActionKind.PAY, adapterId: suiPay, recipient: owner32, recipientLabel: LABEL_OWNER, asset: usdSui, minArrival: 12_000000n, deadline: now() + 3n * 3600n };
  const d3: DestSpec = { ...d2, minArrival: 5_000000n, deadline: now() + 180n };
  const b2: ActionIntent = { ...base('evm', 2n), amountIn: 12_000000n, planHash: destSpecHash(d2), planStep: 2 };
  const b3: ActionIntent = { ...base('evm', 3n), amountIn: 5_000000n, planHash: destSpecHash(d3), planStep: 3 };
  S.l2 = { dest: d2, intent: b2, sig: await agentSign(b2), digest: amaneDigest('ActionIntent', b2) };
  S.l3 = { dest: d3, intent: b3, sig: await agentSign(b3), digest: amaneDigest('ActionIntent', b3) };
  save();
}
if (!S.l2Tx) {
  await guardEth();
  record('ATTACK   Sepolia: replay the delivered VAA', await evmEp.receiveCrossChain(S.l1.intent, S.l1.sig, S.l1.dest, S.evmAdapterId, vaa1, land), 'AMANE_XCHAIN_INTENT_USED');
  const plain = { ...base('evm', 94n), amountIn: 1_000000n, planHash: keccak256(toHex('unrelated')) };
  record('ATTACK   Sepolia: same lease spends reserved funds outside the reservation', await evmEp.executeAction(plain, await agentSign(plain)), 'AMANE_XCHAIN_RESERVED_FUNDS');
  const elsewhere = { ...S.l2.intent, nonce: 95n, recipient: attacker32 };
  record('ATTACK   Sepolia: reserved funds bridged to an attacker endpoint', await evmEp.executeReserved(S.l1.digest, elsewhere, await agentSign(elsewhere)), 'AMANE_XCHAIN_RESERVATION_MISMATCH');
  const tooMuch = { ...S.l2.intent, nonce: 96n, amountIn: 20_000001n };
  record('ATTACK   Sepolia: reserved BRIDGE above what arrived', await evmEp.executeReserved(S.l1.digest, tooMuch, await agentSign(tooMuch)), 'AMANE_XCHAIN_RESERVATION_MISMATCH');
  const wrongKind = { ...S.l2.intent, nonce: 97n, actionKind: ActionKind.PAY };
  record('ATTACK   Sepolia: reserved funds used for a different action', await evmEp.executeReserved(S.l1.digest, wrongKind, await agentSign(wrongKind)), 'AMANE_XCHAIN_RESERVATION_MISMATCH');
  const o2 = await evmEp.executeReserved(S.l1.digest, S.l2.intent, S.l2.sig);
  record('L2       Sepolia: reserved BRIDGE 12 wAMUSD back → Sui endpoint (PAY owner on arrival)', o2, 'EXECUTED');
  S.l2Tx = (o2 as { tx: Hex }).tx;
  S.l2Seq = await evmSequence(S.l2Tx);
  save();
}
if (!S.l3Tx) {
  await guardEth();
  const o3 = await evmEp.executeReserved(S.l1.digest, S.l3.intent, S.l3.sig);
  record('L3       Sepolia: reserved BRIDGE 5 wAMUSD back with a 3-minute destination deadline', o3, 'EXECUTED');
  S.l3Tx = (o3 as { tx: Hex }).tx;
  S.l3Seq = await evmSequence(S.l3Tx);
  save();
}
record('         Sepolia: 3 wAMUSD still reserved for the L1 intent', { reservation: await evmEp.reservation(S.l1.digest) });

// Sepolia messages are signed after finality (~15 min).
const tbEmitterEvm = addressToBytes32(WE.tokenBridge);
const vaa2 = await fetchVaa(WE.chainId, tbEmitterEvm, S.l2Seq, 45);
record('L2       signed VAA fetched (Sepolia finality)', { kind: 'EXECUTED', sequence: S.l2Seq });
const vaa3 = await fetchVaa(WE.chainId, tbEmitterEvm, S.l3Seq, 45);
record('L3       signed VAA fetched (Sepolia finality)', { kind: 'EXECUTED', sequence: S.l3Seq });

// ================================================================ arrivals on Sui
if (!S.l2Received) {
  const swapped: DestSpec = { ...S.l2.dest, recipient: attacker32 };
  record('ATTACK   Sui: relayer substitutes the destination spec', await suiEp.redeemWormhole(route, vaa2, S.l2.intent, S.l2.sig, swapped), 'AMANE_XCHAIN_SPEC_MISMATCH');
  record('ATTACK   Sui: source intent with a forged agent signature', await suiEp.redeemWormhole(route, vaa2, S.l2.intent, await attackerSign(S.l2.intent), S.l2.dest, land), 'AMANE_ACTION_WRONG_AGENT');
  const other2 = { ...S.l2.intent, nonce: 100n };
  record('ATTACK   Sui: VAA presented for a different signed intent', await suiEp.redeemWormhole(route, vaa2, other2, await agentSign(other2), S.l2.dest), 'AMANE_XCHAIN_PAYLOAD_MISMATCH');
  record('ATTACK   Sui: recovery path while the destination is still deliverable', await suiEp.redeemWormhole(route, vaa2, S.l2.intent, S.l2.sig, S.l2.dest, { recovery: true }), 'AMANE_XCHAIN_NO_RESERVATION');
  const got = await suiEp.redeemWormhole(route, vaa2, S.l2.intent, S.l2.sig, S.l2.dest);
  record('L2       Sui: arrival redeemed and reserved for the Sepolia intent', got, 'EXECUTED');
  S.l2Received = (got as { tx: string }).tx;
  save();
}
record('         Sui: reserved for L2', { reserved: await suiEp.reservedOf(AMUSD.coinType), reservation: await suiEp.reservation(S.l2.digest) });

const ownerAddr = keys.suiMerchant;
const ownerBal = async () => BigInt((await sui.getBalance({ owner: ownerAddr, coinType: AMUSD.coinType })).balance.balance);
if (!S.l2Paid) {
  const payBase: ActionIntent = { ...base('sui', 4n), actionKind: ActionKind.PAY, adapterId: suiPay, adapterName: 'Transfer Pay', assetIn: usdSui, assetOut: usdSui, amountIn: 12_000000n, recipient: owner32, recipientLabel: LABEL_OWNER, planHash: S.l2.digest, planStep: 4 };
  const toAttacker = { ...payBase, nonce: 98n, recipient: attacker32 };
  record('ATTACK   Sui: reserved arrival paid to someone else', await suiEp.payReserved(AMUSD.coinType, S.l2.digest, toAttacker, await agentSign(toAttacker)), 'AMANE_XCHAIN_RESERVATION_MISMATCH');
  const before = await ownerBal();
  record('L2       Sui: reserved arrival paid to the owner\'s pinned wallet', await suiEp.payReserved(AMUSD.coinType, S.l2.digest, payBase, await agentSign(payBase)), 'EXECUTED');
  S.l2Paid = { received: (await ownerBal()) - before };
  const again = { ...payBase, nonce: 99n };
  record('ATTACK   Sui: spend the same reservation twice', await suiEp.payReserved(AMUSD.coinType, S.l2.digest, again, await agentSign(again)), 'AMANE_XCHAIN_NO_RESERVATION');
  save();
}
record('         owner wallet received on Sui', S.l2Paid);
if (S.l2Paid.received !== 12_000000n) fail('owner did not receive the full return leg');
const replay = await suiEp.redeemWormhole(route, vaa2, S.l2.intent, S.l2.sig, S.l2.dest);
record('ATTACK   Sui: replay the delivered VAA (Wormhole consumed it; Amane marks the intent used)', { ...replay, intentUsed: await suiEp.intentUsed(S.l2.digest) });
if (replay.kind === 'EXECUTED') fail('VAA replay succeeded');

// L3 arrives after its committed deadline: the reserved path is closed, recovery quarantines it.
if (!S.l3Recovered) {
  record('ATTACK   Sui: late arrival delivered to its expired destination', await suiEp.redeemWormhole(route, vaa3, S.l3.intent, S.l3.sig, S.l3.dest), 'AMANE_XCHAIN_EXPIRED');
  const got = await suiEp.redeemWormhole(route, vaa3, S.l3.intent, S.l3.sig, S.l3.dest, { recovery: true });
  record('L3       Sui: expired arrival redeemed into quarantine', got, 'EXECUTED');
  S.l3Recovered = (got as { tx: string }).tx;
  save();
}
record('         Sui: quarantined', { quarantined: await suiEp.quarantinedOf(AMUSD.coinType), reserved: await suiEp.reservedOf(AMUSD.coinType) });
if (!S.suiWithdrawn) {
  const w: Withdraw = { accountId, chainRef: m.sui.chainRef, account: suiAcct, assetId: usdSui, amount: 5_000000n, destination: suiObjectToBytes32(keys.suiRecovery), opNonce: 0n, deadline: now() + 600n };
  const agentTry = await suiEp.withdraw(AMUSD.coinType, w, [await signAmane(who.agent, 'Withdraw', w)]);
  record('ATTACK   Sui: agent key tries to withdraw the quarantined arrival', agentTry, 'AMANE_CONTROLLER_NOT_AUTHORIZED');
  record('RECOVER  Sui: root 2-of-2 withdraws the quarantined 5 AMUSD to the pinned recovery address', await suiEp.withdraw(AMUSD.coinType, w, await signThreshold([who.controllerA, who.controllerB], 'Withdraw', w)), 'EXECUTED');
  S.suiWithdrawn = true;
  save();
}

// The unspent 3 wAMUSD on Sepolia: its reservation expired while the return legs finalized.
if (!S.evmReleased) {
  const expiry = Number(S.l1.dest.deadline) + 30;
  while (Math.floor(Date.now() / 1000) < expiry) {
    console.log(`      waiting ${expiry - Math.floor(Date.now() / 1000)}s for the Sepolia reservation deadline ...`);
    await sleep(Math.min(60_000, (expiry - Math.floor(Date.now() / 1000)) * 1000 + 1000));
  }
  await guardEth();
  record('RELEASE  Sepolia: expired reservation moved into quarantine', await evmEp.releaseReservation(S.l1.digest), 'EXECUTED');
  const w: Withdraw = { accountId, chainRef: m.evm.chainRef, account: evmAcct, assetId: wUsd, amount: 3_000000n, destination: addressToBytes32(who.recovery.address), opNonce: 0n, deadline: now() + 600n };
  record('RECOVER  Sepolia: root 2-of-2 withdraws the quarantined 3 wAMUSD to the pinned recovery address', await evmEp.withdraw(w, await signThreshold([who.controllerA, who.controllerB], 'Withdraw', w)), 'EXECUTED');
  S.evmReleased = true;
  save();
}

// ================================================================ ledger
const ethEnd = await publicClient.getBalance({ address: relayer.account.address });
const suiEnd = BigInt((await sui.getBalance({ owner: suiRelayer.toSuiAddress() })).balance.balance);
record('LEDGER', {
  suiVault: await suiEp.vaultBalance(AMUSD.coinType),
  suiReserved: await suiEp.reservedOf(AMUSD.coinType),
  suiQuarantined: await suiEp.quarantinedOf(AMUSD.coinType),
  evmLocked: await evmEp.locked(wAmusd),
  evmBalance: await publicClient.readContract({ address: wAmusd, abi: erc20, functionName: 'balanceOf', args: [S.evmAccount] }),
  evmRecovery: await publicClient.readContract({ address: wAmusd, abi: erc20, functionName: 'balanceOf', args: [who.recovery.address] }),
  ethSpentThisRun: formatEther(ethStart - ethEnd),
  suiSpentThisRun: Number(suiStart - suiEnd) / 1e9,
});
flush();
