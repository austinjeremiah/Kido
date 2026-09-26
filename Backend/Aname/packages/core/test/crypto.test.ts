import { describe, expect, it } from 'vitest';
import { hashDomain, hashTypedData, keccak256, recoverAddress, toHex, type Hex } from 'viem';
import {
  AMANE_TYPES,
  amaneDigest,
  assertCanonicalSignature,
  domainSeparator,
  encodeType,
  fixtureAction,
  fixtureLease,
  fixturePolicy,
  highSTwin,
  recoverAmaneSigner,
  testAccounts,
  typedData,
  FIXTURE,
} from '../src/index.js';

const sign = (primaryType: Parameters<typeof typedData>[0], message: never, who = testAccounts.controllerA) =>
  who.signTypedData(typedData(primaryType, message) as never);

describe('canonical encoding', () => {
  it('CRYPTO-ORDER-001 encodeType sorts dependencies alphabetically', () => {
    expect(encodeType('RootPolicy')).toBe(
      'RootPolicy(bytes32 accountId,uint64 policyVersion,uint32 allowedActions,uint8 priceMode,uint64 maxLeaseLifetime,PolicyEndpoint[] endpoints,LeaseIssuer[] leaseIssuers)' +
        'AdapterRef(bytes32 adapterId,string adapterName,uint32 adapterVersion)' +
        'AssetLimit(bytes32 assetId,uint256 maxPerAction,uint256 maxPerEpoch,uint256 maxTotal)' +
        'IssuerLimit(bytes32 chainRef,bytes32 assetId,uint256 maxPerAction,uint256 maxPerEpoch,uint256 maxTotal)' +
        'LeaseIssuer(address issuer,uint64 maxLeaseLifetime,address[] allowedAgents,IssuerLimit[] limits)' +
        'PolicyEndpoint(bytes32 chainRef,bytes32 account,uint64 epochSeconds,AdapterRef[] adapters,AssetLimit[] assets,Recipient[] recipients,Recipient[] beneficiaries,SwapFloor[] swapFloors,Recipient[] recoveryDestinations)' +
        'Recipient(bytes32 recipientId,string label)' +
        'SwapFloor(bytes32 assetIn,bytes32 assetOut,uint256 minOutNumerator,uint256 minOutDenominator)',
    );
  });

  it('our digest equals viem hashTypedData for every primary type', () => {
    const cases = [
      ['RootPolicy', fixturePolicy()],
      ['AgentLease', fixtureLease()],
      ['ActionIntent', fixtureAction()],
    ] as const;
    for (const [pt, msg] of cases) {
      expect(amaneDigest(pt, msg as never)).toBe(hashTypedData(typedData(pt, msg as never) as never));
    }
  });

  it('domain separator is the Sepolia domain without verifyingContract', () => {
    expect(domainSeparator()).toBe(
      hashDomain({
        domain: { name: 'Amane', version: '1', chainId: 11155111 },
        types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }] },
      }),
    );
  });

  it('CRYPTO-DOMAIN-001 distinct purposes produce distinct digests over identical field values', () => {
    const revoke = amaneDigest('RevokeLease', { accountId: FIXTURE.accountId, leaseId: FIXTURE.planHash });
    const pause = amaneDigest('PauseAccount', { accountId: FIXTURE.accountId, pauseNonce: 1n });
    expect(new Set([revoke, pause]).size).toBe(2);
    expect(Object.keys(AMANE_TYPES)).toContain('Withdraw');
  });

  it('CRYPTO-FIELD-001 flipping one bit in any scalar field changes the digest', () => {
    const base = fixtureAction();
    const d0 = amaneDigest('ActionIntent', base);
    const flipped: Partial<Record<keyof typeof base, unknown>> = {
      nonce: base.nonce ^ 1n,
      amountIn: base.amountIn ^ 1n,
      minAmountOut: 1n,
      deadline: base.deadline ^ 1n,
      actionKind: base.actionKind ^ 1,
      adapterVersion: 2,
      planStep: 1,
      recipientLabel: 'Merchant ✓ cafe',
      adapterName: 'Transfer Pay ',
      recipient: (`0x${'00'.repeat(31)}01`) as Hex,
    };
    for (const [k, v] of Object.entries(flipped)) {
      expect(amaneDigest('ActionIntent', { ...base, [k]: v }), k).not.toBe(d0);
    }
  });

  it('CRYPTO-REPLAY-001 a different account endpoint changes the authorization', () => {
    const a = amaneDigest('ActionIntent', fixtureAction());
    const b = amaneDigest('ActionIntent', fixtureAction({ account: FIXTURE.evmAccount }));
    expect(a).not.toBe(b);
  });

  it('CRYPTO-REPLAY-002 a different chainRef or domain chainId changes the authorization', () => {
    const msg = fixtureAction();
    expect(amaneDigest('ActionIntent', { ...msg, chainRef: FIXTURE.sepoliaChainRef })).not.toBe(amaneDigest('ActionIntent', msg));
    const otherDomain = hashTypedData({ ...typedData('ActionIntent', msg), domain: { name: 'Amane', version: '1', chainId: 1 } } as never);
    expect(otherDomain).not.toBe(amaneDigest('ActionIntent', msg));
  });
});

describe('signatures', () => {
  it('CRYPTO-SIGN-001 valid secp256k1 signature is accepted and recovers the signer', async () => {
    const msg = fixtureLease();
    const sig = await sign('AgentLease', msg as never);
    expect(await recoverAmaneSigner(amaneDigest('AgentLease', msg), sig)).toBe(testAccounts.controllerA.address);
  });

  it('CRYPTO-SIGN-002 signature from a different key recovers a different signer', async () => {
    const msg = fixtureLease();
    const sig = await sign('AgentLease', msg as never, testAccounts.attacker);
    expect(await recoverAmaneSigner(amaneDigest('AgentLease', msg), sig)).not.toBe(testAccounts.controllerA.address);
  });

  it('CRYPTO-SIGN-003 / AM-CRYPTO-002 the high-s twin is rejected even though raw ecrecover accepts it', async () => {
    const msg = fixtureAction();
    const digest = amaneDigest('ActionIntent', msg);
    const sig = await sign('ActionIntent', msg as never, testAccounts.agent);
    const twin = highSTwin(sig);
    expect(await recoverAddress({ hash: digest, signature: twin })).toBe(testAccounts.agent.address);
    expect(() => assertCanonicalSignature(twin)).toThrow('AMANE_CONTROLLER_HIGH_S');
  });

  it('CRYPTO-SIGN-004 / AM-CRYPTO-003 / AM-CRYPTO-004 malformed signatures and non-27/28 v are rejected', async () => {
    const sig = await sign('ActionIntent', fixtureAction() as never, testAccounts.agent);
    expect(() => assertCanonicalSignature(sig.slice(0, -2) as Hex)).toThrow('AMANE_CONTROLLER_BAD_SIGNATURE_LENGTH');
    for (const v of ['00', '01', '1d', 'ff']) expect(() => assertCanonicalSignature(`${sig.slice(0, -2)}${v}` as Hex)).toThrow('AMANE_CONTROLLER_BAD_V');
    expect(() => assertCanonicalSignature(`0x${'00'.repeat(32)}${sig.slice(66)}` as Hex)).toThrow('AMANE_CONTROLLER_ZERO_RS');
  });

  it('non-ASCII labels hash as UTF-8', () => {
    expect(keccak256(toHex('Merchant ✓ café'))).toBe(keccak256(new TextEncoder().encode('Merchant ✓ café')));
  });
});
