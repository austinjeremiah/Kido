import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toHex, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  ActionKind,
  AuthMode,
  PriceMode,
  ZERO32,
  actionMask,
  amaneStructHash,
  suiAdapterId,
  suiAssetId,
  suiChainRef,
  testAccounts,
  typedData,
  type ActionIntent,
  type AgentLease,
  type AmaneMessageMap,
  type AmanePrimaryType,
  type RootPolicy,
} from '../src/index.js';
import { hexBytes, moveExpr } from './move-emit.js';

// Object ID of the first object created by sender @0xA11CE in test_scenario (see probe_tests).
const ACCOUNT_OBJECT = '0x034401905bebdf8c04f3cd5f04f442a39372c8dc321c29edfb4f9cb30b23ab96' as Hex;
const OTHER_OBJECT = `0x${'ab'.repeat(32)}` as Hex;
const PKG = '0x0';
const T0 = 1_800_000_000n;

const chainRef = suiChainRef('4c78adac');
const accountId = keccak256(toHex('amane.sui.test.account'));
const usd = suiAssetId(`${PKG}::test_coins::USD`);
const sui2 = suiAssetId(`${PKG}::test_coins::SUI2`);
const payAdapter = suiAdapterId({ chainRef, actionKind: ActionKind.PAY, adapterVersion: 1, adapterName: 'Transfer Pay', witnessType: `${PKG}::account::TransferPayV1` });
const swapAdapter = suiAdapterId({ chainRef, actionKind: ActionKind.SWAP, adapterVersion: 1, adapterName: 'Fixture Swap', witnessType: `${PKG}::mock_swap::MockSwapV1` });
const evilAdapter = suiAdapterId({ chainRef, actionKind: ActionKind.SWAP, adapterVersion: 1, adapterName: 'Fixture Swap', witnessType: `${PKG}::mock_swap::EvilSwapV1` });
const merchant = `0x${'0'.repeat(62)}4d` as Hex;
const recovery = `0x${'0'.repeat(62)}5e` as Hex;
const leaseId = keccak256(toHex('sui.lease.ctrl'));
const issuerLeaseId = keccak256(toHex('sui.lease.issuer'));

const policyHashes = new Map<bigint, Hex>();

function policy(version: bigint, patch: (p: RootPolicy) => void = () => {}): RootPolicy {
  const p: RootPolicy = {
    accountId,
    policyVersion: version,
    parentPolicyHash: version === 1n ? ZERO32 : policyHashes.get(version - 1n)!,
    activateBefore: T0 + 600n,
    allowedActions: actionMask(ActionKind.SWAP, ActionKind.PAY),
    priceMode: PriceMode.TESTNET_FIXED,
    maxLeaseLifetime: 86_400n,
    endpoints: [
      {
        chainRef,
        account: ACCOUNT_OBJECT,
        epochSeconds: 3600n,
        adapters: [
          { adapterId: payAdapter, adapterName: 'Transfer Pay', adapterVersion: 1 },
          { adapterId: swapAdapter, adapterName: 'Fixture Swap', adapterVersion: 1 },
          { adapterId: evilAdapter, adapterName: 'Fixture Swap', adapterVersion: 1 },
        ],
        assets: [
          { assetId: usd, maxPerAction: 100_000000n, maxPerEpoch: 200_000000n, maxTotal: 500_000000n },
          { assetId: sui2, maxPerAction: 0n, maxPerEpoch: 0n, maxTotal: 0n },
        ],
        recipients: [{ recipientId: merchant, label: 'Merchant ✓ café' }],
        beneficiaries: [],
        swapFloors: [{ assetIn: usd, assetOut: sui2, minOutNumerator: 950n, minOutDenominator: 1n }],
        recoveryDestinations: [{ recipientId: recovery, label: 'Cold storage' }],
      },
    ],
    leaseIssuers: [
      {
        issuer: testAccounts.issuer.address,
        maxLeaseLifetime: 3600n,
        allowedAgents: [testAccounts.agent.address],
        limits: [{ chainRef, assetId: usd, maxPerAction: 50_000000n, maxPerEpoch: 100_000000n, maxTotal: 100_000000n }],
      },
    ],
  };
  patch(p);
  return p;
}

for (const v of [1n, 2n, 3n]) policyHashes.set(v, amaneStructHash('RootPolicy', policy(v)));

function lease(issuer: PrivateKeyAccount, id: Hex, patch: (l: AgentLease) => void = () => {}): AgentLease {
  const l: AgentLease = {
    accountId,
    policyVersion: 1n,
    leaseId: id,
    agent: testAccounts.agent.address,
    issuer: issuer.address,
    validAfter: T0,
    expiresAt: T0 + 3600n,
    activateBefore: T0 + 600n,
    allowedActions: actionMask(ActionKind.SWAP, ActionKind.PAY),
    authMode: AuthMode.AGENT_SIGNED,
    endpoints: [
      {
        chainRef,
        account: ACCOUNT_OBJECT,
        adapters: [payAdapter, swapAdapter, evilAdapter],
        assets: [
          { assetId: usd, maxPerAction: 25_000000n, maxPerEpoch: 50_000000n, maxTotal: 100_000000n },
          { assetId: sui2, maxPerAction: 0n, maxPerEpoch: 0n, maxTotal: 0n },
        ],
        recipients: [merchant],
        beneficiaries: [],
      },
    ],
  };
  patch(l);
  return l;
}

function pay(nonce: bigint, amount: bigint, patch: Partial<ActionIntent> = {}): ActionIntent {
  return {
    accountId,
    chainRef,
    account: ACCOUNT_OBJECT,
    policyVersion: 1n,
    leaseId,
    nonce,
    actionKind: ActionKind.PAY,
    adapterId: payAdapter,
    adapterName: 'Transfer Pay',
    adapterVersion: 1,
    assetIn: usd,
    assetOut: usd,
    amountIn: amount,
    minAmountOut: 0n,
    recipient: merchant,
    recipientLabel: 'Merchant ✓ café',
    deadline: T0 + 300n,
    planHash: keccak256(toHex('plan')),
    planStep: 0,
    ...patch,
  };
}

function swap(nonce: bigint, amount: bigint, minOut: bigint, patch: Partial<ActionIntent> = {}): ActionIntent {
  return pay(nonce, amount, {
    actionKind: ActionKind.SWAP,
    adapterId: swapAdapter,
    adapterName: 'Fixture Swap',
    assetOut: sui2,
    minAmountOut: minOut,
    recipient: ZERO32,
    recipientLabel: '',
    ...patch,
  });
}

const sortedSigners = (xs: PrivateKeyAccount[]) => [...xs].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
const { controllerA, controllerB, issuer, agent, attacker } = testAccounts;
const both = sortedSigners([controllerA, controllerB]);

interface Entry {
  name: string;
  pt: AmanePrimaryType;
  msg: unknown;
  signers: PrivateKeyAccount[];
}
const entries: Entry[] = [];
const add = <P extends AmanePrimaryType>(name: string, pt: P, msg: AmaneMessageMap[P], signers: PrivateKeyAccount[]) =>
  entries.push({ name, pt, msg, signers });

add('policy_v1', 'RootPolicy', policy(1n), both);
add('policy_v1_one_sig', 'RootPolicy', policy(1n), [controllerA]);
add('policy_v1_attacker', 'RootPolicy', policy(1n), sortedSigners([controllerA, attacker]));
add('policy_v1_wrong_endpoint', 'RootPolicy', policy(1n, (p) => (p.endpoints[0]!.account = OTHER_OBJECT)), both);
add('policy_v1_issuer_is_controller', 'RootPolicy', policy(1n, (p) => (p.leaseIssuers[0]!.issuer = controllerA.address)), both);
add('policy_v2', 'RootPolicy', policy(2n), both);
add('policy_v3', 'RootPolicy', policy(3n), both);

add('lease_ctrl', 'AgentLease', lease(controllerA, leaseId), [controllerA]);
add('lease_issuer', 'AgentLease', lease(issuer, issuerLeaseId), [issuer]);
add('lease_issuer_over_cap', 'AgentLease', lease(issuer, issuerLeaseId, (l) => (l.endpoints[0]!.assets[0]!.maxTotal = 100_000001n)), [issuer]);
add('lease_issuer_long', 'AgentLease', lease(issuer, issuerLeaseId, (l) => (l.expiresAt = T0 + 3601n)), [issuer]);
add('lease_issuer_wrong_agent', 'AgentLease', lease(issuer, issuerLeaseId, (l) => (l.agent = attacker.address)), [issuer]);
add('lease_by_agent', 'AgentLease', lease(agent, leaseId), [agent]);
add('lease_unlisted', 'AgentLease', lease(attacker, leaseId), [attacker]);
add('lease_forged_issuer_field', 'AgentLease', lease(controllerA, leaseId), [attacker]);
add('lease_borrow', 'AgentLease', lease(controllerA, leaseId, (l) => (l.allowedActions |= 1 << ActionKind.BORROW)), [controllerA]);
add('lease_cap_over_root', 'AgentLease', lease(controllerA, leaseId, (l) => (l.endpoints[0]!.assets[0]!.maxPerEpoch = 200_000001n)), [controllerA]);
add('lease_unknown_adapter', 'AgentLease', lease(controllerA, leaseId, (l) => (l.endpoints[0]!.adapters = [keccak256(toHex('ghost'))])), [controllerA]);
add('lease_wrong_endpoint', 'AgentLease', lease(controllerA, leaseId, (l) => (l.endpoints[0]!.account = OTHER_OBJECT)), [controllerA]);
add('lease_too_long', 'AgentLease', lease(controllerA, leaseId, (l) => (l.expiresAt = T0 + 86_401n)), [controllerA]);
add('lease_v2', 'AgentLease', lease(controllerA, keccak256(toHex('sui.lease.v2')), (l) => (l.policyVersion = 2n)), [controllerA]);

add('pay_1', 'ActionIntent', pay(1n, 10_000000n), [agent]);
add('pay_25_a', 'ActionIntent', pay(2n, 25_000000n), [agent]);
add('pay_25_b', 'ActionIntent', pay(3n, 25_000000n), [agent]);
add('pay_1_unit', 'ActionIntent', pay(4n, 1n), [agent]);
add('pay_over_action_cap', 'ActionIntent', pay(5n, 25_000001n), [agent]);
add('pay_attacker_recipient', 'ActionIntent', pay(6n, 1_000000n, { recipient: `0x${'0'.repeat(62)}ee` as Hex }), [agent]);
add('pay_wrong_label', 'ActionIntent', pay(7n, 1_000000n, { recipientLabel: 'Merchant' }), [agent]);
add('pay_signed_by_attacker', 'ActionIntent', pay(8n, 1_000000n), [attacker]);
add('pay_other_account', 'ActionIntent', pay(9n, 1_000000n, { account: OTHER_OBJECT }), [agent]);
add('pay_borrow_kind', 'ActionIntent', pay(10n, 1_000000n, { actionKind: ActionKind.BORROW }), [agent]);
add('pay_wrong_adapter_name', 'ActionIntent', pay(11n, 1_000000n, { adapterName: 'Transfer Pay v2' }), [agent]);
add('pay_via_swap_adapter', 'ActionIntent', pay(12n, 1_000000n, { adapterId: swapAdapter, adapterName: 'Fixture Swap' }), [agent]);
add('pay_issuer_lease_a', 'ActionIntent', pay(13n, 25_000000n, { leaseId: issuerLeaseId }), [agent]);
add('pay_v2_old_lease', 'ActionIntent', pay(14n, 1_000000n, { policyVersion: 2n }), [agent]);
add('pay_wrong_asset', 'ActionIntent', pay(15n, 1_000000n, { assetIn: sui2, assetOut: sui2 }), [agent]);
add('pay_late', 'ActionIntent', pay(30n, 1n, { deadline: T0 + 3700n }), [agent]);
add('pay_one_usd', 'ActionIntent', pay(31n, 1_000000n, { deadline: T0 + 3700n }), [agent]);
add('swap_1', 'ActionIntent', swap(20n, 1_000000n, 0n), [agent]);
add('swap_min_too_high', 'ActionIntent', swap(21n, 1_000000n, 1_000_000001n), [agent]);
add('swap_redirect', 'ActionIntent', swap(22n, 1_000000n, 0n, { recipient: merchant }), [agent]);
add('swap_evil', 'ActionIntent', swap(23n, 1_000000n, 0n, { adapterId: evilAdapter }), [agent]);
add('swap_wrong_out', 'ActionIntent', swap(24n, 1_000000n, 0n, { assetOut: keccak256(toHex('x')) }), [agent]);

add('policy_v2_wrong_parent', 'RootPolicy', policy(2n, (p) => (p.parentPolicyHash = keccak256(toHex('abandoned')))), both);
add('policy_v1_zero_floor', 'RootPolicy', policy(1n, (p) => (p.endpoints[0]!.swapFloors[0]!.minOutNumerator = 0n)), both);
const incident1 = keccak256(toHex('incident-1'));
const incident2 = keccak256(toHex('incident-2'));
const pauseMsg = (epoch: bigint, id: Hex) => ({ accountId, pauseEpoch: epoch, pauseId: id, deadline: T0 + 900n });
const unpauseMsg = (epoch: bigint, id: Hex) => ({ accountId, chainRef, account: ACCOUNT_OBJECT, pauseEpoch: epoch, pauseId: id, deadline: T0 + 900n });
add('pause_b', 'PauseAccount', pauseMsg(0n, incident1), [controllerB]);
add('pause_a_incident2', 'PauseAccount', pauseMsg(0n, incident2), [controllerA]);
add('pause_attacker', 'PauseAccount', pauseMsg(0n, incident1), [attacker]);
add('pause_exhaust', 'PauseAccount', pauseMsg(18446744073709551615n, incident1), [controllerB]);
add('unpause_0', 'UnpauseAccount', unpauseMsg(0n, incident1), both);
add('unpause_0_one_sig', 'UnpauseAccount', unpauseMsg(0n, incident1), [controllerA]);
add('revoke_by_issuer', 'RevokeLease', { accountId, leaseId }, [issuer]);
add('revoke_ctrl', 'RevokeLease', { accountId, leaseId }, [controllerB]);
add('revoke_attacker', 'RevokeLease', { accountId, leaseId }, [attacker]);
const withdraw = (dest: Hex, nonce = 0n) => ({ accountId, chainRef, account: ACCOUNT_OBJECT, assetId: usd, amount: 7n, destination: dest, opNonce: nonce, deadline: T0 + 900n });
add('withdraw_recovery', 'Withdraw', withdraw(recovery), both);
add('withdraw_attacker_dest', 'Withdraw', withdraw(merchant), both);
add('withdraw_by_agent', 'Withdraw', withdraw(recovery), [agent]);

// ---------------------------------------------------------------- BREAK fixtures
const breakAdapter = suiAdapterId({ chainRef, actionKind: ActionKind.SWAP, adapterVersion: 1, adapterName: 'Break Swap', witnessType: `${PKG}::break_adapters::BreakSwapV1` });
const breakLeaseId = keccak256(toHex('sui.lease.break'));
add(
  'policy_v1_break',
  'RootPolicy',
  policy(1n, (p) => p.endpoints[0]!.adapters.push({ adapterId: breakAdapter, adapterName: 'Break Swap', adapterVersion: 1 })),
  both,
);
add('lease_break', 'AgentLease', lease(controllerA, breakLeaseId, (l) => (l.endpoints[0]!.adapters = [breakAdapter])), [controllerA]);
add('swap_break', 'ActionIntent', swap(40n, 1_000000n, 0n, { leaseId: breakLeaseId, adapterId: breakAdapter, adapterName: 'Break Swap' }), [agent]);
add(
  'policy_v1_huge_epoch',
  'RootPolicy',
  policy(1n, (p) => (p.endpoints[0]!.assets[0]!.maxPerEpoch = 2n ** 256n - 1n)),
  both,
);

const fns: string[] = [];
for (const e of entries) {
  const sigs = await Promise.all(e.signers.map((s) => s.signTypedData(typedData(e.pt, e.msg as never) as never)));
  fns.push(`public fun ${e.name}(): eip712::${e.pt} {\n    ${moveExpr(e.pt, e.msg)}\n}`);
  fns.push(`public fun ${e.name}_sigs(): vector<vector<u8>> {\n    vector[${sigs.map(hexBytes).join(', ')}]\n}`);
}

const controllers = both.map((a) => hexBytes(a.address)).join(', ');
const move = `// Generated by packages/core/scripts/generate-sui-scenarios.ts. Do not edit.
#[test_only]
module amane::scenario_fixtures;

use amane::eip712;

public fun t0(): u64 { ${T0} }
public fun account_object(): vector<u8> { ${hexBytes(ACCOUNT_OBJECT)} }
public fun account_id(): vector<u8> { ${hexBytes(accountId)} }
public fun chain_ref(): vector<u8> { ${hexBytes(chainRef)} }
public fun controllers(): vector<vector<u8>> { vector[${controllers}] }
public fun usd(): vector<u8> { ${hexBytes(usd)} }
public fun sui2(): vector<u8> { ${hexBytes(sui2)} }
public fun pay_adapter(): vector<u8> { ${hexBytes(payAdapter)} }
public fun swap_adapter(): vector<u8> { ${hexBytes(swapAdapter)} }
public fun lease_id(): vector<u8> { ${hexBytes(leaseId)} }
public fun issuer_lease_id(): vector<u8> { ${hexBytes(issuerLeaseId)} }
public fun break_lease_id(): vector<u8> { ${hexBytes(breakLeaseId)} }
public fun merchant(): address { @${merchant} }
public fun recovery(): address { @${recovery} }

${fns.join('\n\n')}
`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
writeFileSync(resolve(root, 'sui/amane/tests/scenario_fixtures.move'), move);
console.log(`wrote ${entries.length} signed Sui scenario fixtures`);
