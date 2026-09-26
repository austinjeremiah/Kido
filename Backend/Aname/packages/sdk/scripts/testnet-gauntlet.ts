/// Live Sepolia + Sui testnet run of the Amane security gauntlet.
///
///   AMANE_DEMO_KEYS=<path to disposable key file>  (created on first run, never commit it)
///   AMANE_EVM_RELAYER_KEY=<funded Sepolia gas key>  SEPOLIA_RPC_URL=<rpc>
///   npx tsx scripts/testnet-gauntlet.ts [--print-sui-relayer]
///
/// Every key in the demo key file is a freshly generated, disposable testnet key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import {
  ActionKind,
  AuthMode,
  PriceMode,
  ZERO32,
  actionMask,
  addressToBytes32,
  amaneStructHash,
  evmAssetId,
  normalizeSuiChainIdentifier,
  suiAdapterId,
  suiAssetId,
  suiObjectToBytes32,
  type ActionIntent,
  type AgentLease,
  type RootPolicy,
} from '@amane/core';
import { AmaneEvmEndpoint, AmaneSuiEndpoint, amaneTestTokenAbi, loadManifest, signAmane, signThreshold, type AmaneOutcome } from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = loadManifest(resolve(root, 'deployments/testnet.json'));
const keysPath = process.env.AMANE_DEMO_KEYS ?? fail('AMANE_DEMO_KEYS is required');

function fail(msg: string): never {
  throw new Error(msg);
}

interface DemoKeys {
  note: string;
  evm: Record<'controllerA' | 'controllerB' | 'issuer' | 'agent' | 'attacker' | 'merchant' | 'recovery', Hex>;
  suiRelayer: string;
  suiMerchant: string;
  suiRecovery: string;
}

function loadKeys(): DemoKeys {
  if (existsSync(keysPath)) return JSON.parse(readFileSync(keysPath, 'utf8'));
  const k: DemoKeys = {
    note: 'Disposable Amane testnet demo keys. Never use on mainnet. Never commit.',
    evm: {
      controllerA: generatePrivateKey(),
      controllerB: generatePrivateKey(),
      issuer: generatePrivateKey(),
      agent: generatePrivateKey(),
      attacker: generatePrivateKey(),
      merchant: generatePrivateKey(),
      recovery: generatePrivateKey(),
    },
    suiRelayer: Ed25519Keypair.generate().getSecretKey(),
    suiMerchant: Ed25519Keypair.generate().toSuiAddress(),
    suiRecovery: Ed25519Keypair.generate().toSuiAddress(),
  };
  mkdirSync(dirname(keysPath), { recursive: true });
  writeFileSync(keysPath, JSON.stringify(k, null, 2), { mode: 0o600 });
  return k;
}

const keys = loadKeys();
const suiRelayer = Ed25519Keypair.fromSecretKey(keys.suiRelayer);
if (process.argv.includes('--print-sui-relayer')) {
  console.log(suiRelayer.toSuiAddress());
  process.exit(0);
}

const who = Object.fromEntries(Object.entries(keys.evm).map(([k, v]) => [k, privateKeyToAccount(v)])) as {
  [K in keyof DemoKeys['evm']]: ReturnType<typeof privateKeyToAccount>;
};

const evidence: { step: string; outcome: AmaneOutcome | Record<string, unknown> }[] = [];
const now = () => BigInt(Math.floor(Date.now() / 1000));

function record(step: string, outcome: AmaneOutcome | Record<string, unknown>, expect?: 'EXECUTED' | string) {
  evidence.push({ step, outcome });
  const o = outcome as AmaneOutcome;
  const got = o.kind === 'REJECTED_BY_AMANE' ? o.code : o.kind;
  const ok = !expect || got === expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step.padEnd(58)} ${got}${'tx' in o && o.tx ? `  ${o.tx}` : ''}`);
  if (!ok) {
    flush();
    throw new Error(`${step}: expected ${expect}, got ${got}${o.kind === 'OPERATIONAL_FAILURE' ? ` (${o.message})` : ''}`);
  }
}

function flush() {
  const out = resolve(dirname(keysPath), `../evidence/testnet-gauntlet-${Date.now()}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ manifest: manifest.sourceCommit, evidence }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(`evidence: ${out}`);
}

// ---------------------------------------------------------------- clients + fingerprints

const rpc = process.env.SEPOLIA_RPC_URL ?? fail('SEPOLIA_RPC_URL is required');
const publicClient = createPublicClient({ chain: sepolia, transport: http(rpc) });
const relayer = createWalletClient({
  chain: sepolia,
  transport: http(rpc),
  account: privateKeyToAccount((process.env.AMANE_EVM_RELAYER_KEY ?? fail('AMANE_EVM_RELAYER_KEY is required')) as Hex),
});
const sui = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://fullnode.testnet.sui.io:443' });

const evmChainId = await publicClient.getChainId();
if (evmChainId !== manifest.evm.chainId) fail(`wrong EVM chain ${evmChainId}`);
const suiChain = normalizeSuiChainIdentifier((await sui.getChainIdentifier()).chainIdentifier);
if (suiChain !== manifest.sui.chainIdentifier) fail(`Sui chain identifier drifted: ${suiChain} (testnet reset?)`);
record('fingerprint sepolia + sui testnet', { evmChainId, suiChain });

// ---------------------------------------------------------------- endpoints

const accountId = keccak256(toHex(`amane.demo.${who.controllerA.address}.${Date.now()}`));
const controllers = [who.controllerA.address, who.controllerB.address];
const amusdEvm = manifest.evm.assets.AMUSD!.address;
const amusdSui = (manifest.sui.tokens.AMUSD as { coinType: string; faucet: string }).coinType;
const amusdFaucet = (manifest.sui.tokens.AMUSD as { coinType: string; faucet: string }).faucet;
const payEvm = manifest.evm.adapters.find((a) => a.name === 'Transfer Pay')!;
const suiPayWitness = manifest.sui.adapters.find((a) => a.name === 'Transfer Pay')!.witnessType;

const { endpoint: evm, tx: evmDeployTx } = await AmaneEvmEndpoint.deploy({
  publicClient,
  relayer,
  accountId,
  controllers,
  threshold: 2,
  registry: manifest.evm.adapterRegistry,
});
record('deploy EVM account endpoint', { kind: 'EXECUTED', chain: 'ethereum-sepolia', tx: evmDeployTx, address: evm.address });

const { endpoint: suiEp, tx: suiCreateTx } = await AmaneSuiEndpoint.create({
  client: sui,
  packageId: manifest.sui.packageId,
  relayer: suiRelayer,
  accountId,
  chainRef: manifest.sui.chainRef,
  controllers,
  threshold: 2,
});
record('create Sui account endpoint', { kind: 'EXECUTED', chain: 'sui-testnet', tx: suiCreateTx, object: suiEp.objectId });

const mintTx = await relayer.writeContract({ address: amusdEvm, abi: amaneTestTokenAbi, functionName: 'mint', args: [evm.address, 1_000_000000n] });
await publicClient.waitForTransactionReceipt({ hash: mintTx });
record('fund EVM endpoint with 1000 AMUSD (testnet faucet)', { kind: 'EXECUTED', chain: 'ethereum-sepolia', tx: mintTx });
record(
  'fund Sui endpoint with 1000 AMUSD (testnet faucet)',
  await suiEp.depositFromFaucet(manifest.sui.tokens.packageId, 'amusd', amusdSui, amusdFaucet, 1_000_000000n),
  'EXECUTED',
);

// ---------------------------------------------------------------- one root policy, both endpoints

const evmMerchant = addressToBytes32(who.merchant.address);
const suiMerchant = suiObjectToBytes32(keys.suiMerchant);
const suiPayId = suiAdapterId({ chainRef: manifest.sui.chainRef, actionKind: ActionKind.PAY, adapterVersion: 1, adapterName: 'Transfer Pay', witnessType: suiPayWitness });
const evmAsset = evmAssetId(amusdEvm);
const suiAsset = suiAssetId(amusdSui);
const limits = (asset: Hex) => ({ assetId: asset, maxPerAction: 50_000000n, maxPerEpoch: 100_000000n, maxTotal: 300_000000n });

const policy: RootPolicy = {
  accountId,
  policyVersion: 1n,
  parentPolicyHash: ZERO32,
  allowedActions: actionMask(ActionKind.PAY),
  priceMode: PriceMode.TESTNET_FIXED,
  maxLeaseLifetime: 86_400n,
  activateBefore: now() + 900n,
  endpoints: [
    {
      chainRef: manifest.evm.chainRef,
      account: evm.account32,
      epochSeconds: 3600n,
      adapters: [{ adapterId: payEvm.adapterId, adapterName: 'Transfer Pay', adapterVersion: 1 }],
      assets: [limits(evmAsset)],
      recipients: [{ recipientId: evmMerchant, label: 'Demo merchant (Sepolia)' }],
      beneficiaries: [],
      swapFloors: [],
      recoveryDestinations: [{ recipientId: addressToBytes32(who.recovery.address), label: 'Owner recovery (Sepolia)' }],
    },
    {
      chainRef: manifest.sui.chainRef,
      account: suiEp.account32,
      epochSeconds: 3600n,
      adapters: [{ adapterId: suiPayId, adapterName: 'Transfer Pay', adapterVersion: 1 }],
      assets: [limits(suiAsset)],
      recipients: [{ recipientId: suiMerchant, label: 'Demo merchant (Sui)' }],
      beneficiaries: [],
      swapFloors: [],
      recoveryDestinations: [{ recipientId: suiObjectToBytes32(keys.suiRecovery), label: 'Owner recovery (Sui)' }],
    },
  ],
  leaseIssuers: [
    {
      issuer: who.issuer.address,
      maxLeaseLifetime: 3600n,
      allowedAgents: [who.agent.address],
      limits: [
        { chainRef: manifest.evm.chainRef, assetId: evmAsset, maxPerAction: 25_000000n, maxPerEpoch: 50_000000n, maxTotal: 100_000000n },
        { chainRef: manifest.sui.chainRef, assetId: suiAsset, maxPerAction: 25_000000n, maxPerEpoch: 50_000000n, maxTotal: 100_000000n },
      ],
    },
  ],
};
const policySigs = await signThreshold([who.controllerA, who.controllerB], 'RootPolicy', policy);
record('install root policy on Sepolia (2-of-2 controllers)', await evm.installPolicy(policy, policySigs), 'EXECUTED');
record('install same signed root policy on Sui', await suiEp.installPolicy(policy, policySigs), 'EXECUTED');

const policyHash = amaneStructHash('RootPolicy', policy);
const evmState = await evm.state();
const suiHash = await suiEp.policyHash();
if (evmState.policyHash !== policyHash || suiHash !== policyHash) fail('policy hash mismatch across endpoints');
record('same canonical policy hash on both endpoints', { policyHash, evm: evmState.policyHash, sui: suiHash });

// ---------------------------------------------------------------- one issuer lease, both endpoints

const lease: AgentLease = {
  accountId,
  policyVersion: 1n,
  leaseId: keccak256(toHex(`lease.${accountId}`)),
  agent: who.agent.address,
  issuer: who.issuer.address,
  validAfter: now() - 60n,
  expiresAt: now() + 3000n,
  activateBefore: now() + 900n,
  allowedActions: actionMask(ActionKind.PAY),
  authMode: AuthMode.AGENT_SIGNED,
  endpoints: [
    { chainRef: manifest.evm.chainRef, account: evm.account32, adapters: [payEvm.adapterId], assets: [{ ...limits(evmAsset), maxPerAction: 20_000000n, maxPerEpoch: 40_000000n, maxTotal: 60_000000n }], recipients: [evmMerchant], beneficiaries: [] },
    { chainRef: manifest.sui.chainRef, account: suiEp.account32, adapters: [suiPayId], assets: [{ ...limits(suiAsset), maxPerAction: 20_000000n, maxPerEpoch: 40_000000n, maxTotal: 60_000000n }], recipients: [suiMerchant], beneficiaries: [] },
  ],
};
const leaseSig = await signAmane(who.issuer, 'AgentLease', lease);
record('activate issuer-signed lease on Sepolia', await evm.activateLease(lease, leaseSig), 'EXECUTED');
record('activate same lease signature on Sui', await suiEp.activateLease(lease, leaseSig), 'EXECUTED');

// ---------------------------------------------------------------- actions

let nonce = 0n;
const intent = (chain: 'evm' | 'sui', o: Partial<ActionIntent> = {}): ActionIntent => ({
  accountId,
  chainRef: chain === 'evm' ? manifest.evm.chainRef : manifest.sui.chainRef,
  account: chain === 'evm' ? evm.account32 : suiEp.account32,
  policyVersion: 1n,
  leaseId: lease.leaseId,
  nonce: ++nonce,
  actionKind: ActionKind.PAY,
  adapterId: chain === 'evm' ? payEvm.adapterId : suiPayId,
  adapterName: 'Transfer Pay',
  adapterVersion: 1,
  assetIn: chain === 'evm' ? evmAsset : suiAsset,
  assetOut: chain === 'evm' ? evmAsset : suiAsset,
  amountIn: 10_000000n,
  minAmountOut: 0n,
  recipient: chain === 'evm' ? evmMerchant : suiMerchant,
  recipientLabel: chain === 'evm' ? 'Demo merchant (Sepolia)' : 'Demo merchant (Sui)',
  deadline: now() + 600n,
  planHash: keccak256(toHex('amane.gauntlet.plan')),
  planStep: Number(nonce),
  ...o,
});
const agentSign = (i: ActionIntent) => signAmane(who.agent, 'ActionIntent', i);
const land = { submitRejected: true };

const evmPay = intent('evm');
const evmPaySig = await agentSign(evmPay);
record('ALLOWED  pay 10 AMUSD to pinned merchant on Sepolia', await evm.executeAction(evmPay, evmPaySig), 'EXECUTED');
const suiPay = intent('sui');
const suiPaySig = await agentSign(suiPay);
record('ALLOWED  pay 10 AMUSD to pinned merchant on Sui', await suiEp.pay(amusdSui, suiPay, suiPaySig), 'EXECUTED');

const over = intent('evm', { amountIn: 20_000001n });
record('ATTACK   over per-action cap (Sepolia)', await evm.send('executeAction', [over, await agentSign(over)], land), 'AMANE_BUDGET_PER_ACTION');
const overSui = intent('sui', { amountIn: 20_000001n });
record('ATTACK   over per-action cap (Sui)', await suiEp.pay(amusdSui, overSui, await agentSign(overSui), land), 'AMANE_BUDGET_PER_ACTION');

const thief = intent('evm', { recipient: addressToBytes32(who.attacker.address) });
record('ATTACK   pay to attacker address (Sepolia)', await evm.send('executeAction', [thief, await agentSign(thief)], land), 'AMANE_ACTION_RECIPIENT_NOT_ALLOWED');
const thiefSui = intent('sui', { recipient: suiObjectToBytes32(suiRelayer.toSuiAddress()) });
record('ATTACK   pay to executor address (Sui)', await suiEp.pay(amusdSui, thiefSui, await agentSign(thiefSui), land), 'AMANE_ACTION_RECIPIENT_NOT_ALLOWED');

record('ATTACK   replay executed action (Sepolia)', await evm.send('executeAction', [evmPay, evmPaySig], land), 'NONCE_CONSUMED');
record('ATTACK   replay executed action (Sui)', await suiEp.pay(amusdSui, suiPay, suiPaySig, land), 'NONCE_CONSUMED');

record('ATTACK   Sui-signed action relayed to Sepolia', await evm.send('executeAction', [suiPay, suiPaySig], land), 'AMANE_ACTION_WRONG_ENDPOINT');
const freshEvm = intent('evm');
record('ATTACK   Sepolia-signed action relayed to Sui', await suiEp.pay(amusdSui, freshEvm, await agentSign(freshEvm), land), 'AMANE_ACTION_WRONG_ENDPOINT');

const signed = intent('evm');
const signedSig = await agentSign(signed);
record('ATTACK   executor mutates signed amount (Sepolia)', await evm.send('executeAction', [{ ...signed, amountIn: 19_000000n }, signedSig], land), 'AMANE_ACTION_WRONG_AGENT');
const signedSui = intent('sui');
const signedSuiSig = await agentSign(signedSui);
record('ATTACK   executor mutates signed plan step (Sui)', await suiEp.pay(amusdSui, { ...signedSui, planStep: 99 }, signedSuiSig, land), 'AMANE_ACTION_WRONG_AGENT');

const forged = intent('evm');
record('ATTACK   attacker key signs action (Sepolia)', await evm.send('executeAction', [forged, await signAmane(who.attacker, 'ActionIntent', forged)], land), 'AMANE_ACTION_WRONG_AGENT');

const badLease = { ...lease, leaseId: keccak256(toHex(`agent-self-lease.${accountId}`)), issuer: who.agent.address };
record('ATTACK   agent signs its own lease (Sepolia)', await evm.send('activateLease', [badLease, await signAmane(who.agent, 'AgentLease', badLease)], land), 'AMANE_LEASE_AGENT_IS_ISSUER');
const bigLease = { ...lease, leaseId: keccak256(toHex(`issuer-over-cap.${accountId}`)), endpoints: lease.endpoints.map((e) => ({ ...e, assets: e.assets.map((a) => ({ ...a, maxTotal: 100_000001n })) })) };
record('ATTACK   issuer exceeds its own caps (Sui)', await suiEp.activateLease(bigLease, await signAmane(who.issuer, 'AgentLease', bigLease)), 'AMANE_LEASE_CAP_EXCEEDS_ISSUER');

// ---------------------------------------------------------------- pause, revoke, recovery

const pauseId = keccak256(toHex(`incident.${accountId}`));
const pauseMsg = { accountId, pauseEpoch: 0n, pauseId, deadline: now() + 600n };
const pauseSig = await signAmane(who.controllerB, 'PauseAccount', pauseMsg);
record('PAUSE    one controller pauses Sepolia (relayed by anyone)', await evm.pause(pauseMsg, pauseSig), 'EXECUTED');
record('PAUSE    same pause signature on Sui', await suiEp.pause(pauseMsg, pauseSig), 'EXECUTED');
const whilePaused = intent('evm');
record('ATTACK   agent action while paused (Sepolia)', await evm.send('executeAction', [whilePaused, await agentSign(whilePaused)], land), 'AMANE_ACTION_ACCOUNT_PAUSED');
const whilePausedSui = intent('sui');
record('ATTACK   agent action while paused (Sui)', await suiEp.pay(amusdSui, whilePausedSui, await agentSign(whilePausedSui), land), 'AMANE_ACTION_ACCOUNT_PAUSED');
const unpauseEvm = { accountId, chainRef: manifest.evm.chainRef, account: evm.account32, pauseEpoch: 0n, pauseId, deadline: now() + 600n };
const unpauseSui = { ...unpauseEvm, chainRef: manifest.sui.chainRef, account: suiEp.account32 };
record('UNPAUSE  2-of-2 controllers (Sepolia)', await evm.unpause(unpauseEvm, await signThreshold([who.controllerA, who.controllerB], 'UnpauseAccount', unpauseEvm)), 'EXECUTED');
record('UNPAUSE  2-of-2 controllers (Sui)', await suiEp.unpause(unpauseSui, await signThreshold([who.controllerA, who.controllerB], 'UnpauseAccount', unpauseSui)), 'EXECUTED');

const revoke = { accountId, leaseId: lease.leaseId };
const revokeSig = await signAmane(who.controllerA, 'RevokeLease', revoke);
record('REVOKE   lease on Sepolia', await evm.revokeLease(revoke, revokeSig), 'EXECUTED');
record('REVOKE   same revoke signature on Sui', await suiEp.revokeLease(revoke, revokeSig), 'EXECUTED');
const afterRevoke = intent('evm');
record('ATTACK   agent keeps running after revoke (Sepolia)', await evm.send('executeAction', [afterRevoke, await agentSign(afterRevoke)], land), 'AMANE_LEASE_NOT_ACTIVE');
const afterRevokeSui = intent('sui');
record('ATTACK   agent keeps running after revoke (Sui)', await suiEp.pay(amusdSui, afterRevokeSui, await agentSign(afterRevokeSui), land), 'AMANE_LEASE_NOT_ACTIVE');

const wdEvm = { accountId, chainRef: manifest.evm.chainRef, account: evm.account32, assetId: evmAsset, amount: 5_000000n, destination: addressToBytes32(who.recovery.address), opNonce: 0n, deadline: now() + 600n };
record('OWNER    recovery withdrawal to pinned destination (Sepolia)', await evm.withdraw(wdEvm, await signThreshold([who.controllerA, who.controllerB], 'Withdraw', wdEvm)), 'EXECUTED');
const wdSui = { ...wdEvm, chainRef: manifest.sui.chainRef, account: suiEp.account32, assetId: suiAsset, destination: suiObjectToBytes32(keys.suiRecovery) };
record('OWNER    recovery withdrawal to pinned destination (Sui)', await suiEp.withdraw(amusdSui, wdSui, await signThreshold([who.controllerA, who.controllerB], 'Withdraw', wdSui)), 'EXECUTED');
const wdThief = { ...wdEvm, destination: addressToBytes32(who.attacker.address), opNonce: 1n };
record('ATTACK   withdrawal to unpinned destination (Sepolia)', await evm.send('withdraw', [wdThief, await signThreshold([who.controllerA, who.controllerB], 'Withdraw', wdThief)], land), 'AMANE_OWNER_DESTINATION_NOT_ALLOWED');

const merchantEvm = await publicClient.readContract({ address: amusdEvm, abi: amaneTestTokenAbi, functionName: 'balanceOf', args: [who.merchant.address] });
const vaultSui = await suiEp.vaultBalance(amusdSui);
record('final balances', { evmMerchantAMUSD: merchantEvm, suiVaultAMUSD: vaultSui, evmAccount: evm.address, suiAccount: suiEp.objectId });
flush();
