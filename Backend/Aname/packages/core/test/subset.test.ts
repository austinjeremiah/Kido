import { describe, expect, it } from 'vitest';
import {
  ActionKind,
  actionMask,
  assertActionIsSubset,
  assertLeaseIsSubset,
  assertPolicyWellFormed,
  fixtureAction,
  fixtureLease,
  fixturePolicy,
  testAccounts,
  FIXTURE,
  ZERO32,
  type AgentLease,
} from '../src/index.js';

const ctx = {
  now: 1_800_000_100n,
  controllers: [testAccounts.controllerA.address, testAccounts.controllerB.address],
  chainRef: FIXTURE.suiChainRef,
  account: FIXTURE.suiAccount,
};

const withEndpoint = (lease: AgentLease, patch: Partial<AgentLease['endpoints'][number]>): AgentLease => ({
  ...lease,
  endpoints: lease.endpoints.map((e) => ({ ...e, ...patch })),
});

describe('policy well-formedness', () => {
  const c = { controllers: ctx.controllers, chainRef: ctx.chainRef, account: ctx.account };
  it('fixture policy is well formed', () => expect(() => assertPolicyWellFormed(fixturePolicy(), c)).not.toThrow());
  it('issuer may not be a controller', () => {
    const p = fixturePolicy();
    p.leaseIssuers[0]!.issuer = testAccounts.controllerA.address;
    expect(() => assertPolicyWellFormed(p, c)).toThrow('AMANE_POLICY_ISSUER_IS_CONTROLLER');
  });
  it('duplicate asset rejected', () => {
    const p = fixturePolicy();
    p.endpoints[1]!.assets.push(p.endpoints[1]!.assets[0]!);
    expect(() => assertPolicyWellFormed(p, c)).toThrow('AMANE_POLICY_DUPLICATE_ENTRY');
  });
});

describe('lease ⊆ root policy', () => {
  const policy = fixturePolicy();
  const lease = fixtureLease();
  const check = (l: AgentLease, c = ctx) => () => assertLeaseIsSubset(policy, l, c);

  it('AM-LEASE-001 strict subset is accepted', () => expect(check(lease)).not.toThrow());
  it('AM-LEASE-002 action outside root', () =>
    expect(check({ ...lease, allowedActions: actionMask(ActionKind.SWAP, ActionKind.BORROW) })).toThrow('AMANE_LEASE_ACTION_NOT_IN_ROOT'));
  it('AM-LEASE-003 adapter outside root', () =>
    expect(check(withEndpoint(lease, { adapters: [FIXTURE.planHash] }))).toThrow('AMANE_LEASE_ADAPTER_NOT_IN_ROOT'));
  it('AM-LEASE-004 asset outside root', () =>
    expect(check(withEndpoint(lease, { assets: [{ assetId: FIXTURE.planHash, maxPerAction: 1n, maxPerEpoch: 1n, maxTotal: 1n }] }))).toThrow(
      'AMANE_LEASE_ASSET_NOT_IN_ROOT',
    ));
  for (const [id, field] of [
    ['AM-LEASE-005', 'maxPerAction'],
    ['AM-LEASE-006', 'maxPerEpoch'],
    ['AM-LEASE-007', 'maxTotal'],
  ] as const) {
    it(`${id} ${field} above root`, () => {
      const assets = lease.endpoints[0]!.assets.map((a, i) => (i === 0 ? { ...a, [field]: 500_000001n } : a));
      expect(check(withEndpoint(lease, { assets }))).toThrow('AMANE_LEASE_CAP_EXCEEDS_ROOT');
    });
  }
  it('AM-LEASE-008 lifetime beyond root bound', () =>
    expect(check({ ...lease, expiresAt: lease.validAfter + 86_401n })).toThrow('AMANE_LEASE_LIFETIME_EXCEEDED'));
  it('activation after activateBefore is rejected', () => expect(check(lease, { ...ctx, now: lease.activateBefore + 1n })).toThrow('AMANE_LEASE_ACTIVATION_EXPIRED'));
  it('AM-LEASE-011 signer not controller and not listed issuer', () =>
    expect(check({ ...lease, issuer: testAccounts.attacker.address })).toThrow('AMANE_LEASE_ISSUER_NOT_AUTHORIZED'));
  it('AM-LEASE-012 issuer lease exceeding issuer caps', () => {
    const l = { ...lease, issuer: testAccounts.issuer.address, expiresAt: lease.validAfter + 1800n };
    expect(check(l)).not.toThrow();
    const assets = l.endpoints[0]!.assets.map((a, i) => (i === 0 ? { ...a, maxTotal: 100_000001n } : a));
    expect(check(withEndpoint(l, { assets }))).toThrow('AMANE_LEASE_CAP_EXCEEDS_');
    expect(check({ ...l, expiresAt: l.validAfter + 3601n })).toThrow('AMANE_LEASE_LIFETIME_EXCEEDED');
    expect(check({ ...l, agent: testAccounts.attacker.address })).toThrow('AMANE_LEASE_AGENT_NOT_ALLOWED');
  });
  it('AM-LEASE-013 agent key cannot sign its own lease', () =>
    expect(check({ ...lease, issuer: testAccounts.agent.address })).toThrow('AMANE_LEASE_AGENT_IS_ISSUER'));
  it('duplicate entries are rejected', () =>
    expect(check(withEndpoint(lease, { recipients: [FIXTURE.merchant, FIXTURE.merchant] }))).toThrow('AMANE_LEASE_DUPLICATE_ENTRY'));
  it('lease without an entry for this endpoint is rejected', () =>
    expect(check(lease, { ...ctx, account: FIXTURE.evmAccount })).toThrow('AMANE_LEASE_WRONG_ENDPOINT'));
});

describe('action ⊆ lease', () => {
  const policy = fixturePolicy();
  const lease = fixtureLease();
  const act = (o: Parameters<typeof fixtureAction>[0] = {}) => () => assertActionIsSubset(policy, lease, fixtureAction(o), ctx);
  const swap = { actionKind: ActionKind.SWAP, adapterId: FIXTURE.swapAdapter, adapterName: 'Fixture Swap', assetOut: FIXTURE.sui, recipient: ZERO32, recipientLabel: '' };

  it('AM-ACT-001 exact PAY to pinned member is accepted', () => expect(act()).not.toThrow());
  it('AM-ACT-002 kind outside lease', () => expect(act({ actionKind: ActionKind.BORROW })).toThrow('AMANE_ACTION_KIND_NOT_ALLOWED'));
  it('AM-ACT-003 wrong adapter', () => expect(act({ adapterId: FIXTURE.planHash })).toThrow('AMANE_ACTION_ADAPTER_NOT_ALLOWED'));
  it('AM-ACT-004 wrong input asset', () => expect(act({ assetIn: FIXTURE.planHash })).toThrow('AMANE_ACTION_ASSET_NOT_ALLOWED'));
  it('AM-ACT-005 wrong output asset', () => expect(act({ ...swap, assetOut: FIXTURE.planHash })).toThrow('AMANE_ACTION_ASSET_NOT_ALLOWED'));
  it('AM-ACT-006 above per-action cap', () => expect(act({ amountIn: 25_000001n })).toThrow('AMANE_BUDGET_PER_ACTION'));
  it('AM-ACT-009 after deadline', () => expect(act({ deadline: ctx.now - 1n })).toThrow('AMANE_ACTION_EXPIRED'));
  it('AM-RECIP-003 arbitrary PAY recipient', () => expect(act({ recipient: FIXTURE.recovery })).toThrow('AMANE_ACTION_RECIPIENT_NOT_ALLOWED'));
  it('recipient label must match the root policy label', () => expect(act({ recipientLabel: 'Merchant' })).toThrow('AMANE_ACTION_RECIPIENT_NOT_ALLOWED'));
  it('AM-NAME-001 adapter name/version inconsistent with id', () => {
    expect(act({ adapterName: 'Fixture Swap' })).toThrow('AMANE_ACTION_ADAPTER_NAME_MISMATCH');
    expect(act({ adapterVersion: 2 })).toThrow('AMANE_ACTION_ADAPTER_NAME_MISMATCH');
  });
  it('AM-RECIP-002 swap output cannot be redirected', () => expect(act({ ...swap, recipient: FIXTURE.merchant })).toThrow('AMANE_ACTION_RECIPIENT_NOT_ALLOWED'));
  it('AM-PRICE-004 owner floor enforced when agent minOut = 0', () => {
    expect(assertActionIsSubset(policy, lease, fixtureAction({ ...swap, amountIn: 10_000000n, minAmountOut: 0n }), ctx)).toBe(9_500_000000n);
  });
  it('AM-PRICE-001 agent may demand a better price than the floor', () => {
    expect(assertActionIsSubset(policy, lease, fixtureAction({ ...swap, amountIn: 10_000000n, minAmountOut: 9_900_000000n }), ctx)).toBe(9_900_000000n);
  });
  it('swap without an owner floor fails closed', () =>
    expect(() => assertActionIsSubset(policy, lease, fixtureAction({ ...swap, assetIn: FIXTURE.sui, assetOut: FIXTURE.usd }), ctx)).toThrow(
      /AMANE_(BUDGET_PER_ACTION|ACTION_NO_PRICE_FLOOR)/,
    ));
  it('AM-ACT-013 wrong lease id', () => expect(act({ leaseId: FIXTURE.planHash })).toThrow('AMANE_ACTION_WRONG_LEASE'));
});

describe('BRIDGE ⊆ lease (mirrors AmaneAccount._validate BRIDGE)', () => {
  const bridgeAdapter = FIXTURE.planHash;
  const peer = { recipientId: FIXTURE.evmAccount, label: 'Amane Sepolia endpoint' };
  const policy = fixturePolicy();
  policy.allowedActions = actionMask(ActionKind.SWAP, ActionKind.PAY, ActionKind.BRIDGE);
  const pe = policy.endpoints.find((e) => e.chainRef === FIXTURE.suiChainRef && e.account === FIXTURE.suiAccount)!;
  pe.adapters.push({ adapterId: bridgeAdapter, adapterName: 'Wormhole Bridge', adapterVersion: 1 });
  pe.recipients.push(peer);
  const base = fixtureLease();
  const lease: AgentLease = {
    ...base,
    allowedActions: policy.allowedActions,
    endpoints: base.endpoints.map((e) => (e.chainRef === FIXTURE.suiChainRef ? { ...e, adapters: [...e.adapters, bridgeAdapter], recipients: [...e.recipients, peer.recipientId] } : e)),
  };
  const bridge = { actionKind: ActionKind.BRIDGE, adapterId: bridgeAdapter, adapterName: 'Wormhole Bridge', recipient: peer.recipientId, recipientLabel: peer.label, assetOut: FIXTURE.planHash };
  const act = (o: Parameters<typeof fixtureAction>[0] = {}) => () => assertActionIsSubset(policy, lease, fixtureAction({ ...bridge, ...o }), ctx);

  it('bridge to the pinned peer endpoint is accepted; the arrival asset is the destination\'s concern', () => expect(act()).not.toThrow());
  it('bridge to an unpinned recipient is refused', () => expect(act({ recipient: FIXTURE.recovery })).toThrow('AMANE_ACTION_RECIPIENT_NOT_ALLOWED'));
  it('bridge recipient label must match the root policy', () => expect(act({ recipientLabel: 'Amane Sepolia' })).toThrow('AMANE_ACTION_RECIPIENT_NOT_ALLOWED'));
  it('bridge is bounded by the per-action cap', () => expect(act({ amountIn: 25_000001n })).toThrow('AMANE_BUDGET_PER_ACTION'));
  it('bridge needs BRIDGE in the lease', () =>
    expect(() => assertActionIsSubset(policy, { ...lease, allowedActions: actionMask(ActionKind.SWAP, ActionKind.PAY) }, fixtureAction(bridge), ctx)).toThrow('AMANE_ACTION_KIND_NOT_ALLOWED'));
});
