import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { actionMask, assertActionIsSubset } from '../src/subset.js';
import { FIXTURE, fixtureAction, fixtureLease, fixturePolicy } from '../src/fixtures.js';
import { ActionKind } from '../src/types.js';

const borrower = keccak256(toHex('amane.fixture.beneficiary.borrower'));
const debtToken = keccak256(toHex('amane.fixture.asset.variable-debt-usd'));
const ctx = { now: 1_800_000_100n, chainRef: FIXTURE.suiChainRef, account: FIXTURE.suiAccount };

const policy = fixturePolicy();
for (const e of policy.endpoints) {
  e.beneficiaries = [{ recipientId: borrower, label: 'owner position' }];
  e.swapFloors = [...e.swapFloors, { assetIn: FIXTURE.usd, assetOut: debtToken, minOutNumerator: 1n, minOutDenominator: 1n }];
}
policy.allowedActions = actionMask(ActionKind.SWAP, ActionKind.PAY, ActionKind.REPAY);
const lease = fixtureLease();
lease.allowedActions = actionMask(ActionKind.SWAP, ActionKind.PAY, ActionKind.REPAY);
for (const e of lease.endpoints) e.beneficiaries = [borrower];

const repay = (o: Parameters<typeof fixtureAction>[0] = {}) =>
  fixtureAction({ actionKind: ActionKind.REPAY, assetOut: debtToken, recipient: borrower, recipientLabel: 'owner position', ...o });

describe('REPAY preflight (EVM account v2 rule)', () => {
  const v2 = { ...ctx, repay: true };
  it('pinned beneficiary and pinned debt token pair pass', () => expect(assertActionIsSubset(policy, lease, repay(), v2)).toBe(0n));
  it('endpoints without REPAY support refuse it', () => expect(() => assertActionIsSubset(policy, lease, repay(), ctx)).toThrow('AMANE_ACTION_KIND_NOT_ALLOWED'));
  it('unpinned beneficiary', () => expect(() => assertActionIsSubset(policy, lease, repay({ recipient: FIXTURE.merchant }), v2)).toThrow('AMANE_ACTION_RECIPIENT_NOT_ALLOWED'));
  it('label mismatch', () => expect(() => assertActionIsSubset(policy, lease, repay({ recipientLabel: 'x' }), v2)).toThrow('AMANE_ACTION_RECIPIENT_NOT_ALLOWED'));
  it('a spend asset named as debt token', () => expect(() => assertActionIsSubset(policy, lease, repay({ assetOut: FIXTURE.sui }), v2)).toThrow('AMANE_ACTION_ASSET_NOT_ALLOWED'));
  it('unpinned debt token', () => expect(() => assertActionIsSubset(policy, lease, repay({ assetOut: FIXTURE.planHash }), v2)).toThrow('AMANE_ACTION_NO_PRICE_FLOOR'));
});
