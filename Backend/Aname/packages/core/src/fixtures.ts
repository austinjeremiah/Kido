import { keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ActionKind, AuthMode, PriceMode, type ActionIntent, type AgentLease, type RootPolicy } from './types.js';
import { actionMask } from './subset.js';
import { addressToBytes32, evmChainRef, suiChainRef, suiObjectToBytes32, ZERO32 } from './ids.js';

export const TEST_ONLY_KEY = (label: string): Hex => keccak256(toHex(`amane.test-only.${label}`));

export const testKeys = {
  controllerA: TEST_ONLY_KEY('controller.a'),
  controllerB: TEST_ONLY_KEY('controller.b'),
  issuer: TEST_ONLY_KEY('issuer'),
  agent: TEST_ONLY_KEY('agent'),
  attacker: TEST_ONLY_KEY('attacker'),
} as const;

export const testAccounts = Object.fromEntries(
  Object.entries(testKeys).map(([k, v]) => [k, privateKeyToAccount(v)]),
) as { [K in keyof typeof testKeys]: ReturnType<typeof privateKeyToAccount> };

export const FIXTURE = {
  accountId: keccak256(toHex('amane.fixture.account')),
  sepoliaChainRef: evmChainRef(11155111),
  suiChainRef: suiChainRef('4c78adac'),
  evmAccount: addressToBytes32('0x00000000000000000000000000000000000A3A7E'),
  suiAccount: suiObjectToBytes32('0x5a1'),
  usd: keccak256(toHex('amane.fixture.asset.usd')),
  sui: keccak256(toHex('amane.fixture.asset.sui')),
  swapAdapter: keccak256(toHex('amane.fixture.adapter.swap')),
  payAdapter: keccak256(toHex('amane.fixture.adapter.pay')),
  merchant: keccak256(toHex('amane.fixture.recipient.merchant')),
  recovery: keccak256(toHex('amane.fixture.recipient.recovery')),
  planHash: keccak256(toHex('amane.fixture.plan')),
} as const;

export function fixturePolicy(): RootPolicy {
  const endpoint = (chainRef: Hex, account: Hex) => ({
    chainRef,
    account,
    epochSeconds: 3600n,
    adapters: [
      { adapterId: FIXTURE.swapAdapter, adapterName: 'Fixture Swap', adapterVersion: 1 },
      { adapterId: FIXTURE.payAdapter, adapterName: 'Transfer Pay', adapterVersion: 1 },
    ],
    assets: [
      { assetId: FIXTURE.usd, maxPerAction: 100_000000n, maxPerEpoch: 200_000000n, maxTotal: 500_000000n },
      { assetId: FIXTURE.sui, maxPerAction: 100_000000000n, maxPerEpoch: 200_000000000n, maxTotal: 500_000000000n },
    ],
    recipients: [{ recipientId: FIXTURE.merchant, label: 'Merchant ✓ café' }],
    beneficiaries: [],
    swapFloors: [{ assetIn: FIXTURE.usd, assetOut: FIXTURE.sui, minOutNumerator: 950n, minOutDenominator: 1n }],
    recoveryDestinations: [{ recipientId: FIXTURE.recovery, label: 'Cold storage' }],
  });
  return {
    accountId: FIXTURE.accountId,
    policyVersion: 1n,
    allowedActions: actionMask(ActionKind.SWAP, ActionKind.PAY),
    priceMode: PriceMode.TESTNET_FIXED,
    maxLeaseLifetime: 86_400n,
    endpoints: [endpoint(FIXTURE.sepoliaChainRef, FIXTURE.evmAccount), endpoint(FIXTURE.suiChainRef, FIXTURE.suiAccount)],
    leaseIssuers: [
      {
        issuer: testAccounts.issuer.address,
        maxLeaseLifetime: 3600n,
        allowedAgents: [testAccounts.agent.address],
        limits: [
          { chainRef: FIXTURE.sepoliaChainRef, assetId: FIXTURE.usd, maxPerAction: 50_000000n, maxPerEpoch: 100_000000n, maxTotal: 100_000000n },
          { chainRef: FIXTURE.suiChainRef, assetId: FIXTURE.usd, maxPerAction: 50_000000n, maxPerEpoch: 100_000000n, maxTotal: 100_000000n },
        ],
      },
    ],
  };
}

export function fixtureLease(): AgentLease {
  const endpoint = (chainRef: Hex, account: Hex) => ({
    chainRef,
    account,
    adapters: [FIXTURE.swapAdapter, FIXTURE.payAdapter],
    assets: [
      { assetId: FIXTURE.usd, maxPerAction: 25_000000n, maxPerEpoch: 50_000000n, maxTotal: 100_000000n },
      { assetId: FIXTURE.sui, maxPerAction: 0n, maxPerEpoch: 0n, maxTotal: 0n },
    ],
    recipients: [FIXTURE.merchant],
    beneficiaries: [],
  });
  return {
    accountId: FIXTURE.accountId,
    policyVersion: 1n,
    leaseId: keccak256(toHex('amane.fixture.lease.1')),
    agent: testAccounts.agent.address,
    issuer: testAccounts.controllerA.address,
    validAfter: 1_800_000_000n,
    expiresAt: 1_800_003_600n,
    activateBefore: 1_800_000_600n,
    allowedActions: actionMask(ActionKind.SWAP, ActionKind.PAY),
    authMode: AuthMode.AGENT_SIGNED,
    endpoints: [endpoint(FIXTURE.sepoliaChainRef, FIXTURE.evmAccount), endpoint(FIXTURE.suiChainRef, FIXTURE.suiAccount)],
  };
}

export function fixtureAction(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    accountId: FIXTURE.accountId,
    chainRef: FIXTURE.suiChainRef,
    account: FIXTURE.suiAccount,
    policyVersion: 1n,
    leaseId: keccak256(toHex('amane.fixture.lease.1')),
    nonce: 1n,
    actionKind: ActionKind.PAY,
    adapterId: FIXTURE.payAdapter,
    adapterName: 'Transfer Pay',
    adapterVersion: 1,
    assetIn: FIXTURE.usd,
    assetOut: FIXTURE.usd,
    amountIn: 10_000000n,
    minAmountOut: 0n,
    recipient: FIXTURE.merchant,
    recipientLabel: 'Merchant ✓ café',
    deadline: 1_800_000_300n,
    planHash: FIXTURE.planHash,
    planStep: 0,
    ...overrides,
  };
}

export { ZERO32 };
