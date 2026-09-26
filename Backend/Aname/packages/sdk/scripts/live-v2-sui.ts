/// Live Sui testnet run of the Amane Cetus SWAP adapter: an account on the frozen v4 core swaps
/// AMUSD for AMSUI through the project Cetus pool, and the corresponding attacks are rejected.
///
///   AMANE_DEMO_KEYS=<disposable key file>  npx tsx scripts/live-v2-sui.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ActionKind, AuthMode, PriceMode, ZERO32, actionMask, suiAdapterId, suiAssetId, suiObjectToBytes32, type ActionIntent, type AgentLease, type RootPolicy } from '@amane/core';
import { AmaneSuiEndpoint, signAmane, signThreshold, type AmaneOutcome } from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const m = JSON.parse(readFileSync(resolve(root, 'deployments/testnet.json'), 'utf8'));
const fail = (msg: string): never => {
  throw new Error(msg);
};
const keysPath = process.env.AMANE_DEMO_KEYS ?? fail('AMANE_DEMO_KEYS is required');
const keys = JSON.parse(readFileSync(keysPath, 'utf8')) as { evm: Record<string, Hex>; suiRelayer: string; suiRecovery: string };
const who = Object.fromEntries(Object.entries(keys.evm).map(([k, v]) => [k, privateKeyToAccount(v)])) as Record<'controllerA' | 'controllerB' | 'issuer' | 'agent' | 'attacker', ReturnType<typeof privateKeyToAccount>>;
const relayer = Ed25519Keypair.fromSecretKey(keys.suiRelayer);
const sui = new SuiGrpcClient({ network: 'testnet', baseUrl: process.env.SUI_GRPC_URL ?? 'https://fullnode.testnet.sui.io:443' });
const now = () => BigInt(Math.floor(Date.now() / 1000));
const evidence: { step: string; outcome: unknown }[] = [];

function record(step: string, outcome: AmaneOutcome | Record<string, unknown>, expect?: string) {
  evidence.push({ step, outcome });
  const o = outcome as AmaneOutcome;
  const got = o.kind === 'REJECTED_BY_AMANE' ? o.code : o.kind;
  const ok = !expect || got === expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step.padEnd(58)} ${got ?? ''}${'tx' in o && o.tx ? `  ${o.tx}` : ''}`);
  if (!ok) {
    flush();
    fail(`${step}: expected ${expect}, got ${got}${o.kind === 'OPERATIONAL_FAILURE' ? ` (${o.message})` : ''}`);
  }
}
function flush() {
  const out = resolve(dirname(keysPath), `../evidence/amane-v2-sui-${Date.now()}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ sui: { packageId: m.sui.packageId, adapters: m.sui.adapters, pools: m.sui.pools }, evidence }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(`evidence: ${out}`);
}

const cetus = m.sui.adapters.find((a: { name: string }) => a.name === 'Cetus CLMM Swap') ?? fail('Cetus adapter missing from manifest');
const poolInfo = m.sui.pools.cetusAmusdAmsui;
const tok = m.sui.tokens;
const route = { adapterPackage: cetus.package, coinA: poolInfo.coinA, coinB: poolInfo.coinB, pool: poolInfo.pool, globalConfig: m.sui.protocols.cetusClmm.globalConfig };
const accountId = keccak256(toHex(`amane.cetus.${who.controllerA.address}.${Date.now()}`));
const { endpoint: ep, tx } = await AmaneSuiEndpoint.create({ client: sui, packageId: m.sui.packageId, relayer, accountId, chainRef: m.sui.chainRef, controllers: [who.controllerA.address, who.controllerB.address], threshold: 2 });
record('create Sui account endpoint (frozen v4 core)', { kind: 'EXECUTED', tx, object: ep.objectId });
record('fund with 1000 AMUSD (testnet faucet)', await ep.depositFromFaucet(tok.packageId, 'amusd', tok.AMUSD.coinType, tok.AMUSD.faucet, 1_000_000000n), 'EXECUTED');

const usd = suiAssetId(tok.AMUSD.coinType), sui32 = suiAssetId(tok.AMSUI.coinType);
const adapterId = suiAdapterId({ chainRef: m.sui.chainRef, actionKind: ActionKind.SWAP, adapterVersion: 1, adapterName: cetus.name, witnessType: cetus.witnessType });
const cap = (assetId: Hex, n: bigint) => ({ assetId, maxPerAction: n, maxPerEpoch: 2n * n, maxTotal: 6n * n });
const zero = (assetId: Hex) => ({ assetId, maxPerAction: 0n, maxPerEpoch: 0n, maxTotal: 0n });
const policy: RootPolicy = {
  accountId, policyVersion: 1n, parentPolicyHash: ZERO32, allowedActions: actionMask(ActionKind.SWAP), priceMode: PriceMode.TESTNET_FIXED, maxLeaseLifetime: 86_400n, activateBefore: now() + 900n,
  endpoints: [{
    chainRef: m.sui.chainRef, account: ep.account32, epochSeconds: 3600n,
    adapters: [{ adapterId, adapterName: cetus.name, adapterVersion: 1 }],
    assets: [cap(usd, 50_000000n), zero(sui32)], recipients: [], beneficiaries: [],
    // 1 AMUSD (1e6) must return at least 0.95 AMSUI (0.95e9): 950 raw AMSUI per raw AMUSD.
    swapFloors: [{ assetIn: usd, assetOut: sui32, minOutNumerator: 950n, minOutDenominator: 1n }],
    recoveryDestinations: [{ recipientId: suiObjectToBytes32(keys.suiRecovery), label: 'Owner recovery (Sui)' }],
  }],
  leaseIssuers: [{ issuer: who.issuer.address, maxLeaseLifetime: 3600n, allowedAgents: [who.agent.address], limits: [{ chainRef: m.sui.chainRef, ...cap(usd, 25_000000n) }] }],
};
record('install root policy (2-of-2)', await ep.installPolicy(policy, await signThreshold([who.controllerA, who.controllerB], 'RootPolicy', policy)), 'EXECUTED');
const lease: AgentLease = {
  accountId, policyVersion: 1n, leaseId: keccak256(toHex(`lease.cetus.${accountId}`)), agent: who.agent.address, issuer: who.issuer.address,
  validAfter: now() - 60n, expiresAt: now() + 3000n, activateBefore: now() + 900n, allowedActions: actionMask(ActionKind.SWAP), authMode: AuthMode.AGENT_SIGNED,
  endpoints: [{ chainRef: m.sui.chainRef, account: ep.account32, adapters: [adapterId], assets: [cap(usd, 20_000000n), zero(sui32)], recipients: [], beneficiaries: [] }],
};
record('activate issuer-signed lease', await ep.activateLease(lease, await signAmane(who.issuer, 'AgentLease', lease)), 'EXECUTED');

let nonce = 0n;
const intent = (o: Partial<ActionIntent> = {}): ActionIntent => ({
  accountId, chainRef: m.sui.chainRef, account: ep.account32, policyVersion: 1n, leaseId: lease.leaseId, nonce: ++nonce,
  actionKind: ActionKind.SWAP, adapterId, adapterName: cetus.name, adapterVersion: 1, assetIn: usd, assetOut: sui32,
  amountIn: 10_000000n, minAmountOut: 0n, recipient: ZERO32, recipientLabel: '', deadline: now() + 600n,
  planHash: keccak256(toHex('amane.cetus.plan')), planStep: Number(nonce), ...o,
});
const sign = (i: ActionIntent) => signAmane(who.agent, 'ActionIntent', i);
const land = { submitRejected: true };

const before = await ep.vaultBalance(tok.AMSUI.coinType);
const s1 = intent();
record('ALLOWED  swap 10 AMUSD -> AMSUI via Cetus CLMM', await ep.swapCetus({ ...route, a2b: true }, s1, await sign(s1)), 'EXECUTED');
const after = await ep.vaultBalance(tok.AMSUI.coinType);
record('         AMSUI settled into the vault', { received: after - before });
if (after - before < 9_500_000000n) fail('output below the owner floor');

const greedy = intent({ minAmountOut: 11_000_000000n });
record('ATTACK   agent minimum above what the pool gives', await ep.swapCetus({ ...route, a2b: true }, greedy, await sign(greedy), land), 'AMANE_ACTION_BELOW_MIN_OUT');
const over = intent({ amountIn: 20_000001n });
record('ATTACK   swap above per-action cap', await ep.swapCetus({ ...route, a2b: true }, over, await sign(over), land), 'AMANE_BUDGET_PER_ACTION');
const redirect = intent({ recipient: suiObjectToBytes32(relayer.toSuiAddress()) });
record('ATTACK   swap output redirected', await ep.swapCetus({ ...route, a2b: true }, redirect, await sign(redirect), land), 'AMANE_ACTION_RECIPIENT_NOT_ALLOWED');
const forged = intent();
record('ATTACK   attacker key signs swap', await ep.swapCetus({ ...route, a2b: true }, forged, await signAmane(who.attacker, 'ActionIntent', forged), land), 'AMANE_ACTION_WRONG_AGENT');

const revoke = { accountId, leaseId: lease.leaseId };
record('REVOKE   lease', await ep.revokeLease(revoke, await signAmane(who.controllerA, 'RevokeLease', revoke)), 'EXECUTED');
const late = intent();
record('ATTACK   swap after revoke', await ep.swapCetus({ ...route, a2b: true }, late, await sign(late), land), 'AMANE_LEASE_NOT_ACTIVE');
flush();
