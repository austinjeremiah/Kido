import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import { hexBytes, moveExpr, snake } from './move-emit.js';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  AMANE_TYPES,
  ActionKind,
  FIXTURE,
  ZERO32,
  amaneDigest,
  amaneStructHash,
  domainSeparator,
  encodeType,
  fixtureAction,
  fixtureLease,
  fixturePolicy,
  highSTwin,
  testAccounts,
  typeHash,
  typedData,
  type AmaneMessageMap,
  type AmanePrimaryType,
} from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

type Field = { name: string; type: string };
const TYPES = AMANE_TYPES as unknown as Record<string, readonly Field[]>;

interface Vector {
  name: string;
  primaryType: AmanePrimaryType;
  message: unknown;
  encodeType: string;
  typeHash: Hex;
  structHash: Hex;
  digest: Hex;
  signatures: { signer: Hex; signature: Hex }[];
}

interface NegativeSignature {
  name: string;
  vector: string;
  signature: Hex;
  expect: 'REJECT_HIGH_S' | 'REJECT_BAD_V' | 'REJECT_LENGTH' | 'WRONG_SIGNER';
  wouldRecover?: Hex;
}

async function sign(pt: AmanePrimaryType, msg: unknown, who: PrivateKeyAccount) {
  return who.signTypedData(typedData(pt, msg as never) as never);
}

async function vector<P extends AmanePrimaryType>(name: string, pt: P, msg: AmaneMessageMap[P], signers: PrivateKeyAccount[]): Promise<Vector> {
  const sorted = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  return {
    name,
    primaryType: pt,
    message: msg,
    encodeType: encodeType(pt),
    typeHash: typeHash(pt),
    structHash: amaneStructHash(pt, msg),
    digest: amaneDigest(pt, msg),
    signatures: await Promise.all(sorted.map(async (s) => ({ signer: s.address as Hex, signature: await sign(pt, msg, s) }))),
  };
}

const swapAction = fixtureAction({
  chainRef: FIXTURE.sepoliaChainRef,
  account: FIXTURE.evmAccount,
  nonce: 7n,
  actionKind: ActionKind.SWAP,
  adapterId: FIXTURE.swapAdapter,
  adapterName: 'Fixture Swap',
  assetOut: FIXTURE.sui,
  amountIn: 20_000000n,
  minAmountOut: 1n,
  recipient: ZERO32,
  recipientLabel: '',
  planStep: 3,
});

const issuerLease = { ...fixtureLease(), issuer: testAccounts.issuer.address, leaseId: FIXTURE.planHash, expiresAt: fixtureLease().validAfter + 1800n };

const vectors: Vector[] = [
  await vector('root_policy', 'RootPolicy', fixturePolicy(), [testAccounts.controllerA, testAccounts.controllerB]),
  await vector('lease_by_controller', 'AgentLease', fixtureLease(), [testAccounts.controllerA]),
  await vector('lease_by_issuer', 'AgentLease', issuerLease, [testAccounts.issuer]),
  await vector('action_pay_sui', 'ActionIntent', fixtureAction(), [testAccounts.agent]),
  await vector('action_swap_sepolia', 'ActionIntent', swapAction, [testAccounts.agent]),
  await vector('pause', 'PauseAccount', { accountId: FIXTURE.accountId, pauseEpoch: 0n, pauseId: FIXTURE.planHash, deadline: 1_800_000_900n }, [testAccounts.controllerB]),
  await vector('unpause', 'UnpauseAccount', { accountId: FIXTURE.accountId, chainRef: FIXTURE.suiChainRef, account: FIXTURE.suiAccount, pauseEpoch: 0n, pauseId: FIXTURE.planHash, deadline: 1_800_000_900n }, [
    testAccounts.controllerA,
    testAccounts.controllerB,
  ]),
  await vector('revoke', 'RevokeLease', { accountId: FIXTURE.accountId, leaseId: fixtureLease().leaseId }, [testAccounts.controllerA]),
  await vector(
    'withdraw',
    'Withdraw',
    {
      accountId: FIXTURE.accountId,
      chainRef: FIXTURE.suiChainRef,
      account: FIXTURE.suiAccount,
      assetId: FIXTURE.usd,
      amount: 5_000000n,
      destination: FIXTURE.recovery,
      opNonce: 0n,
      deadline: 1_800_000_900n,
    },
    [testAccounts.controllerA, testAccounts.controllerB],
  ),
];

const paySig = vectors.find((v) => v.name === 'action_pay_sui')!.signatures[0]!.signature;
const wrongDomainSig = await testAccounts.agent.signTypedData({
  ...typedData('ActionIntent', fixtureAction()),
  domain: { name: 'Amane', version: '1', chainId: 1 },
} as never);

const negatives: NegativeSignature[] = [
  { name: 'high_s_twin', vector: 'action_pay_sui', signature: highSTwin(paySig), expect: 'REJECT_HIGH_S', wouldRecover: testAccounts.agent.address },
  { name: 'v_zero', vector: 'action_pay_sui', signature: `${paySig.slice(0, -2)}00` as Hex, expect: 'REJECT_BAD_V' },
  { name: 'v_one', vector: 'action_pay_sui', signature: `${paySig.slice(0, -2)}01` as Hex, expect: 'REJECT_BAD_V' },
  { name: 'v_29', vector: 'action_pay_sui', signature: `${paySig.slice(0, -2)}1d` as Hex, expect: 'REJECT_BAD_V' },
  { name: 'short', vector: 'action_pay_sui', signature: paySig.slice(0, -2) as Hex, expect: 'REJECT_LENGTH' },
  { name: 'wrong_domain_chain', vector: 'action_pay_sui', signature: wrongDomainSig, expect: 'WRONG_SIGNER' },
  { name: 'attacker', vector: 'action_pay_sui', signature: await sign('ActionIntent', fixtureAction(), testAccounts.attacker), expect: 'WRONG_SIGNER' },
];

const json = JSON.stringify(
  {
    schemaVersion: 'amane.golden-vectors/v1',
    domain: { name: 'Amane', version: '1', chainId: 11155111, separator: domainSeparator() },
    accounts: Object.fromEntries(Object.entries(testAccounts).map(([k, a]) => [k, a.address])),
    typeHashes: Object.fromEntries(Object.keys(AMANE_TYPES).map((t) => [t, typeHash(t as keyof typeof AMANE_TYPES)])),
    vectors,
    negatives,
  },
  (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  2,
);
writeFileSync(resolve(root, 'vectors/golden.json'), `${json}\n`);

// ---------------------------------------------------------------- Solidity emitter

const solScalar = (type: string, v: unknown): string => {
  if (type === 'string') return `unicode${JSON.stringify(v)}`;
  if (type === 'bytes32') return `bytes32(${v as string})`;
  if (type === 'address') return `address(${v as string})`;
  return (v as bigint | number).toString();
};

function solAssign(target: string, type: string, value: unknown, out: string[]) {
  if (type.endsWith('[]')) {
    const inner = type.slice(0, -2);
    const arr = value as unknown[];
    out.push(`${target} = new ${inner}[](${arr.length});`);
    arr.forEach((x, i) => solAssign(`${target}[${i}]`, inner, x, out));
    return;
  }
  const fields = TYPES[type];
  if (!fields) {
    out.push(`${target} = ${solScalar(type, value)};`);
    return;
  }
  for (const f of fields) solAssign(`${target}.${f.name}`, f.type, (value as Record<string, unknown>)[f.name], out);
}

const solFns = vectors.map((v) => {
  const body: string[] = [];
  solAssign('m', v.primaryType, v.message, body);
  return `    function ${v.name}() internal pure returns (${v.primaryType} memory m) {\n        ${body.join('\n        ')}\n    }`;
});

const solExpect = vectors
  .map(
    (v) =>
      `    bytes32 internal constant ${v.name.toUpperCase()}_DIGEST = ${v.digest};\n` +
      `    bytes32 internal constant ${v.name.toUpperCase()}_STRUCT = ${v.structHash};\n` +
      v.signatures
        .map((s, i) => `    bytes internal constant ${v.name.toUpperCase()}_SIG_${i} = hex"${s.signature.slice(2)}";\n    address internal constant ${v.name.toUpperCase()}_SIGNER_${i} = ${s.signer};`)
        .join('\n'),
  )
  .join('\n');

const solTypeHashes = Object.keys(AMANE_TYPES)
  .map((t) => `    bytes32 internal constant TH_${t} = ${typeHash(t as keyof typeof AMANE_TYPES)};`)
  .join('\n');

const solNeg = negatives
  .map((n, i) => `    bytes internal constant NEG_${i}_SIG = hex"${n.signature.slice(2)}"; // ${n.name}: ${n.expect}`)
  .join('\n');

const sol = `// SPDX-License-Identifier: MIT
// Generated by packages/core/scripts/generate-vectors.ts. Do not edit.
pragma solidity 0.8.28;

import "../../src/AmaneTypes.sol";

library Golden {
    bytes32 internal constant DOMAIN_SEPARATOR = ${domainSeparator()};
${solTypeHashes}
${solExpect}
${solNeg}

${solFns.join('\n\n')}
}
`;
mkdirSync(resolve(root, 'evm/test/generated'), { recursive: true });
writeFileSync(resolve(root, 'evm/test/generated/Golden.sol'), sol);

// ---------------------------------------------------------------- Move emitter

const moveCases = vectors
  .map((v) => {
    const sigChecks = v.signatures
      .map((s) => `        assert!(eip712::recover_signer(eip712::hash_${snake(v.primaryType)}(&m), &${hexBytes(s.signature)}) == ${hexBytes(s.signer)}, 1);`)
      .join('\n');
    return `    #[test]
    fun golden_${v.name}() {
        let m = ${moveExpr(v.primaryType, v.message)};
        assert!(eip712::hash_${snake(v.primaryType)}(&m) == ${hexBytes(v.structHash)}, 0);
        let d = eip712::digest(eip712::hash_${snake(v.primaryType)}(&m));
        assert!(d == ${hexBytes(v.digest)}, 0);
${sigChecks}
    }`;
  })
  .join('\n\n');

const payStruct = vectors.find((v) => v.name === 'action_pay_sui')!.structHash;
const moveNeg = negatives
  .map((n) => {
    const fn = `golden_negative_${n.name}`;
    if (n.expect === 'WRONG_SIGNER')
      return `    #[test]\n    fun ${fn}() {\n        assert!(eip712::recover_signer(${hexBytes(payStruct)}, &${hexBytes(n.signature)}) != ${hexBytes(testAccounts.agent.address)}, 0);\n    }`;
    const code = n.expect === 'REJECT_HIGH_S' ? 'EHighS' : n.expect === 'REJECT_BAD_V' ? 'EBadV' : 'EBadLength';
    return `    #[test, expected_failure(abort_code = crypto::${code})]\n    fun ${fn}() {\n        eip712::recover_signer(${hexBytes(payStruct)}, &${hexBytes(n.signature)});\n    }`;
  })
  .join('\n\n');

const moveTypeHashes = Object.keys(AMANE_TYPES)
  .filter((t) => ['RootPolicy', 'AgentLease', 'ActionIntent', 'PauseAccount', 'UnpauseAccount', 'RevokeLease', 'Withdraw'].includes(t))
  .map((t) => `        assert!(eip712::type_hash_${snake(t)}() == ${hexBytes(typeHash(t as keyof typeof AMANE_TYPES))}, 0);`)
  .join('\n');

const move = `// Generated by packages/core/scripts/generate-vectors.ts. Do not edit.
#[test_only]
module amane::golden_tests;

use amane::crypto;
use amane::eip712;

#[test]
fun golden_domain_and_type_hashes() {
    assert!(eip712::domain_separator() == ${hexBytes(domainSeparator())}, 0);
${moveTypeHashes.replace(/^ {8}/gm, '    ')}
}

${moveCases.replace(/^ {4}/gm, '')}

${moveNeg.replace(/^ {4}/gm, '')}
`;
mkdirSync(resolve(root, 'sui/amane/tests'), { recursive: true });
writeFileSync(resolve(root, 'sui/amane/tests/golden_tests.move'), move);

console.log(`wrote ${vectors.length} vectors, ${negatives.length} negative signatures`);
