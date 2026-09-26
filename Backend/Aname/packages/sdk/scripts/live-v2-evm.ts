/// Live Sepolia run of the Amane v2 EVM release: a CORE_VERSION 2 account swaps through the project
/// Uniswap v3 pool and repays a real Aave v3 variable debt of a pinned beneficiary, and the
/// corresponding attacks are rejected on-chain.
///
///   AMANE_DEMO_KEYS=<disposable key file>  AMANE_EVM_RELAYER_KEY=<funded gas key>  SEPOLIA_RPC_URL=<rpc>
///   npx tsx scripts/live-v2-evm.ts
///
/// The relayer key also acts as the demo borrower: it supplies faucet DAI to Aave and borrows USDC,
/// so the account has a real debt to repay on its behalf.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { ActionKind, AuthMode, PriceMode, ZERO32, actionMask, addressToBytes32, evmAssetId, type ActionIntent, type AgentLease, type RootPolicy } from '@amane/core';
import { AmaneEvmEndpoint, amaneTestTokenAbi, signAmane, signThreshold, type AmaneOutcome } from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const m = JSON.parse(readFileSync(resolve(root, 'deployments/testnet.json'), 'utf8'));
const fail = (msg: string): never => {
  throw new Error(msg);
};
const keysPath = process.env.AMANE_DEMO_KEYS ?? fail('AMANE_DEMO_KEYS is required');
const keys = JSON.parse(readFileSync(keysPath, 'utf8')) as { evm: Record<string, Hex> };
const who = Object.fromEntries(Object.entries(keys.evm).map(([k, v]) => [k, privateKeyToAccount(v)])) as Record<'controllerA' | 'controllerB' | 'issuer' | 'agent' | 'attacker' | 'recovery', ReturnType<typeof privateKeyToAccount>>;

const rpc = process.env.SEPOLIA_RPC_URL ?? fail('SEPOLIA_RPC_URL is required');
const publicClient = createPublicClient({ chain: sepolia, transport: http(rpc) });
const relayer = createWalletClient({ chain: sepolia, transport: http(rpc), account: privateKeyToAccount((process.env.AMANE_EVM_RELAYER_KEY ?? fail('AMANE_EVM_RELAYER_KEY is required')) as Hex) });
const borrower = relayer.account.address;
const now = () => BigInt(Math.floor(Date.now() / 1000));
const evidence: { step: string; outcome: unknown }[] = [];
const wait = async (hash: Hex) => {
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') fail(`tx failed ${hash}`);
  return hash;
};

function record(step: string, outcome: AmaneOutcome | Record<string, unknown>, expect?: string) {
  evidence.push({ step, outcome });
  const o = outcome as AmaneOutcome;
  const got = o.kind === 'REJECTED_BY_AMANE' ? o.code : o.kind;
  const ok = !expect || got === expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step.padEnd(62)} ${got ?? ''}${'tx' in o && o.tx ? `  ${o.tx}` : ''}`);
  if (!ok) {
    flush();
    fail(`${step}: expected ${expect}, got ${got}${o.kind === 'OPERATIONAL_FAILURE' ? ` (${o.message})` : ''}`);
  }
}
function flush() {
  const out = resolve(dirname(keysPath), `../evidence/amane-v2-evm-${Date.now()}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ manifest: m.evm, evidence }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(`evidence: ${out}`);
}

const aave = m.evm.protocols.aaveV3;
const erc20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);
const poolAbi = parseAbi(['function getReservesList() view returns (address[])', 'function supply(address,uint256,address,uint16)', 'function borrow(address,uint256,uint256,uint16,address)', 'function getReserveData(address) view returns ((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))']);
const faucetAbi = parseAbi(['function mint(address,address,uint256) returns (uint256)']);
const USDC = (process.env.AMANE_AAVE_USDC ?? '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8') as Address;
const reserve = (await publicClient.readContract({ address: aave.pool, abi: poolAbi, functionName: 'getReserveData', args: [USDC] })) as readonly unknown[];
const vDebt = reserve[10] as Address; // variableDebtTokenAddress, read from the pool rather than pinned
record('read USDC variable debt token from the Aave pool', { vDebt });

// ---------------------------------------------------------------- the borrower's real Aave position
const debtBefore = (await publicClient.readContract({ address: vDebt, abi: erc20, functionName: 'balanceOf', args: [borrower] })) as bigint;
if (debtBefore < 30_000000n) {
  // Collateral: the first reserve of the pool (other than USDC) that still accepts a supply.
  // Testnet supply caps fill up, so nothing is pinned here.
  const reserves = (await publicClient.readContract({ address: aave.pool, abi: poolAbi, functionName: 'getReservesList' })) as Address[];
  let supplied = false;
  for (const asset of reserves.filter((r) => r.toLowerCase() !== USDC.toLowerCase())) {
    const dec = Number(await publicClient.readContract({ address: asset, abi: erc20, functionName: 'decimals' }));
    const amount = 100n * 10n ** BigInt(dec);
    try {
      await wait(await relayer.writeContract({ address: aave.faucet, abi: faucetAbi, functionName: 'mint', args: [asset, borrower, amount] }));
      await wait(await relayer.writeContract({ address: asset, abi: erc20, functionName: 'approve', args: [aave.pool, amount] }));
      await publicClient.simulateContract({ account: relayer.account, address: aave.pool, abi: poolAbi, functionName: 'supply', args: [asset, amount, borrower, 0] });
      await wait(await relayer.writeContract({ address: aave.pool, abi: poolAbi, functionName: 'supply', args: [asset, amount, borrower, 0] }));
      await publicClient.simulateContract({ account: relayer.account, address: aave.pool, abi: poolAbi, functionName: 'borrow', args: [USDC, 50_000000n, 2n, 0, borrower] });
      await wait(await relayer.writeContract({ address: aave.pool, abi: poolAbi, functionName: 'borrow', args: [USDC, 50_000000n, 2n, 0, borrower] }));
      record('borrower supplies collateral and borrows 50 USDC', { collateral: asset });
      supplied = true;
      break;
    } catch (err) {
      console.log(`      collateral ${asset} unusable: ${(err as { shortMessage?: string }).shortMessage?.split('\n').pop() ?? err}`);
    }
  }
  if (!supplied) fail('BLOCKED_ENV: no Aave Sepolia reserve accepts collateral right now');
}
record('borrower has a variable USDC debt on Aave', { debt: await publicClient.readContract({ address: vDebt, abi: erc20, functionName: 'balanceOf', args: [borrower] }) });

// ---------------------------------------------------------------- v2 account
const accountId = keccak256(toHex(`amane.v2.${who.controllerA.address}.${Date.now()}`));
const { endpoint: evm, tx } = await AmaneEvmEndpoint.deploy({ publicClient, relayer, accountId, controllers: [who.controllerA.address, who.controllerB.address], threshold: 2, registry: m.evm.adapterRegistry });
record('deploy CORE_VERSION 2 account', { kind: 'EXECUTED', tx, address: evm.address, coreVersion: await evm.coreVersion() });
if ((await evm.coreVersion()) !== 2) fail('account is not core v2');

const AMUSD = m.evm.assets.AMUSD.address as Address, AMDAI = m.evm.assets.AMDAI.address as Address;
await wait(await relayer.writeContract({ address: AMUSD, abi: amaneTestTokenAbi, functionName: 'mint', args: [evm.address, 1_000_000000n] }));
await wait(await relayer.writeContract({ address: aave.faucet, abi: faucetAbi, functionName: 'mint', args: [USDC, evm.address, 200_000000n] }));
record('fund account: 1000 AMUSD, 200 Aave USDC (testnet faucets)', { kind: 'EXECUTED' });

const uni = m.evm.adapters.find((a: { name: string }) => a.name === 'Uniswap V3 Swap');
const rep = m.evm.adapters.find((a: { name: string }) => a.name === 'Aave V3 Repay');
const [usd, dai, usdc, debt] = [evmAssetId(AMUSD), evmAssetId(AMDAI), evmAssetId(USDC), evmAssetId(vDebt)];
const cap = (assetId: Hex, n: bigint) => ({ assetId, maxPerAction: n, maxPerEpoch: 2n * n, maxTotal: 6n * n });
const owner32 = addressToBytes32(borrower);
const policy: RootPolicy = {
  accountId, policyVersion: 1n, parentPolicyHash: ZERO32,
  allowedActions: actionMask(ActionKind.SWAP, ActionKind.REPAY),
  priceMode: PriceMode.TESTNET_FIXED, maxLeaseLifetime: 86_400n, activateBefore: now() + 900n,
  endpoints: [{
    chainRef: m.evm.chainRef, account: evm.account32, epochSeconds: 3600n,
    adapters: [{ adapterId: uni.adapterId, adapterName: uni.name, adapterVersion: 1 }, { adapterId: rep.adapterId, adapterName: rep.name, adapterVersion: 1 }],
    assets: [cap(usd, 50_000000n), { assetId: dai, maxPerAction: 0n, maxPerEpoch: 0n, maxTotal: 0n }, cap(usdc, 50_000000n)],
    recipients: [],
    beneficiaries: [{ recipientId: owner32, label: 'Owner Aave position' }],
    // 1 AMUSD (1e6) must return at least 0.95 AMDAI (0.95e18); repaid debt must match spend within 0.01%.
    swapFloors: [{ assetIn: usd, assetOut: dai, minOutNumerator: 95n * 10n ** 10n, minOutDenominator: 1n }, { assetIn: usdc, assetOut: debt, minOutNumerator: 9_999n, minOutDenominator: 10_000n }],
    recoveryDestinations: [{ recipientId: addressToBytes32(who.recovery.address), label: 'Owner recovery' }],
  }],
  leaseIssuers: [{ issuer: who.issuer.address, maxLeaseLifetime: 3600n, allowedAgents: [who.agent.address], limits: [{ chainRef: m.evm.chainRef, ...cap(usd, 25_000000n) }, { chainRef: m.evm.chainRef, ...cap(usdc, 25_000000n) }] }],
};
record('install root policy (2-of-2)', await evm.installPolicy(policy, await signThreshold([who.controllerA, who.controllerB], 'RootPolicy', policy)), 'EXECUTED');
const lease: AgentLease = {
  accountId, policyVersion: 1n, leaseId: keccak256(toHex(`lease.v2.${accountId}`)), agent: who.agent.address, issuer: who.issuer.address,
  validAfter: now() - 60n, expiresAt: now() + 3000n, activateBefore: now() + 900n, allowedActions: actionMask(ActionKind.SWAP, ActionKind.REPAY), authMode: AuthMode.AGENT_SIGNED,
  endpoints: [{ chainRef: m.evm.chainRef, account: evm.account32, adapters: [uni.adapterId, rep.adapterId], assets: [cap(usd, 20_000000n), { assetId: dai, maxPerAction: 0n, maxPerEpoch: 0n, maxTotal: 0n }, cap(usdc, 20_000000n)], recipients: [], beneficiaries: [owner32] }],
};
record('activate issuer-signed lease', await evm.activateLease(lease, await signAmane(who.issuer, 'AgentLease', lease)), 'EXECUTED');

let nonce = 0n;
const intent = (o: Partial<ActionIntent>): ActionIntent => ({
  accountId, chainRef: m.evm.chainRef, account: evm.account32, policyVersion: 1n, leaseId: lease.leaseId, nonce: ++nonce,
  actionKind: ActionKind.SWAP, adapterId: uni.adapterId, adapterName: uni.name, adapterVersion: 1,
  assetIn: usd, assetOut: dai, amountIn: 10_000000n, minAmountOut: 0n, recipient: ZERO32, recipientLabel: '',
  deadline: now() + 600n, planHash: keccak256(toHex('amane.v2.plan')), planStep: Number(nonce), ...o,
});
const sign = (i: ActionIntent) => signAmane(who.agent, 'ActionIntent', i);
const land = { submitRejected: true };
const bal = (t: Address, a: Address) => publicClient.readContract({ address: t, abi: erc20, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;

const daiBefore = await bal(AMDAI, evm.address);
const swap = intent({});
record('ALLOWED  swap 10 AMUSD -> AMDAI via Uniswap v3', await evm.executeAction(swap, await sign(swap)), 'EXECUTED');
record('         AMDAI received by the account', { received: (await bal(AMDAI, evm.address)) - daiBefore });

const greedy = intent({ minAmountOut: 11n * 10n ** 18n });
record('ATTACK   swap demanding more than the pool gives', await evm.send('executeAction', [greedy, await sign(greedy)], land), 'OPERATIONAL_FAILURE');
const redirect = intent({ recipient: addressToBytes32(who.attacker.address) });
record('ATTACK   swap output redirected to attacker', await evm.send('executeAction', [redirect, await sign(redirect)], land), 'AMANE_ACTION_RECIPIENT_NOT_ALLOWED');

const repay = (o: Partial<ActionIntent> = {}) => intent({ actionKind: ActionKind.REPAY, adapterId: rep.adapterId, adapterName: rep.name, assetIn: usdc, assetOut: debt, recipient: owner32, recipientLabel: 'Owner Aave position', ...o });
const d0 = await bal(vDebt, borrower);
const r1 = repay({ amountIn: 10_000000n });
record('ALLOWED  repay 10 USDC of the pinned owner position on Aave', await evm.executeAction(r1, await sign(r1)), 'EXECUTED');
const d1 = await bal(vDebt, borrower);
record('         owner variable debt reduced', { before: d0, after: d1, reduced: d0 - d1 });
if (d0 - d1 < 9_999_000n) fail('debt did not fall by the repaid amount');

const r2 = repay({ recipient: addressToBytes32(who.attacker.address), recipientLabel: 'Owner Aave position' });
record('ATTACK   repay someone else\'s debt', await evm.send('executeAction', [r2, await sign(r2)], land), 'AMANE_ACTION_RECIPIENT_NOT_ALLOWED');
const r3 = repay({ assetOut: dai });
record('ATTACK   repay pair naming a spend asset', await evm.send('executeAction', [r3, await sign(r3)], land), 'AMANE_ACTION_ASSET_NOT_ALLOWED');
const r4 = repay({ amountIn: 20_000001n });
record('ATTACK   repay above per-action cap', await evm.send('executeAction', [r4, await sign(r4)], land), 'AMANE_BUDGET_PER_ACTION');

const revoke = { accountId, leaseId: lease.leaseId };
record('REVOKE   lease', await evm.revokeLease(revoke, await signAmane(who.controllerA, 'RevokeLease', revoke)), 'EXECUTED');
const r5 = repay({ amountIn: 1_000000n });
record('ATTACK   repay after revoke', await evm.send('executeAction', [r5, await sign(r5)], land), 'AMANE_LEASE_NOT_ACTIVE');
flush();
