import type { Address, Hex } from 'viem';
import { typedData, type AmaneMessageMap, type AmanePrimaryType } from '@amane/core';

export interface TypedDataSigner {
  address: Address;
  signTypedData(args: never): Promise<Hex>;
}

export function signAmane<P extends AmanePrimaryType>(signer: TypedDataSigner, primaryType: P, message: AmaneMessageMap[P]): Promise<Hex> {
  return signer.signTypedData(typedData(primaryType, message) as never);
}

/// Controller signatures ordered by ascending signer address, as both cores require.
export async function signThreshold<P extends AmanePrimaryType>(signers: TypedDataSigner[], primaryType: P, message: AmaneMessageMap[P]): Promise<Hex[]> {
  const sorted = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  return Promise.all(sorted.map((s) => signAmane(s, primaryType, message)));
}
