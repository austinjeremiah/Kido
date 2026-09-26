import { encodeAbiParameters, getAddress, keccak256, pad, toHex, type Address, type Hex } from 'viem';
import type { Bytes32 } from './types.js';

export const ADAPTER_TAG = keccak256(toHex('AMANE_ADAPTER_V1'));
export const ZERO32 = `0x${'00'.repeat(32)}` as Bytes32;

export function evmChainRef(chainId: number | bigint): Bytes32 {
  return keccak256(toHex(`eip155:${chainId}`));
}

export function suiChainRef(chainIdentifier: string): Bytes32 {
  if (!/^[0-9a-f]{8}$/.test(chainIdentifier)) throw new Error(`invalid Sui chain identifier: ${chainIdentifier}`);
  return keccak256(toHex(`sui:${chainIdentifier}`));
}

export function addressToBytes32(address: Address): Bytes32 {
  return pad(getAddress(address), { size: 32 }).toLowerCase() as Bytes32;
}

export function bytes32ToAddress(value: Bytes32): Address {
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) throw new Error(`not an EVM address word: ${value}`);
  return getAddress(`0x${value.slice(26)}`);
}

export function evmAssetId(token: Address): Bytes32 {
  return addressToBytes32(token);
}

export function suiObjectToBytes32(id: string): Bytes32 {
  const hex = id.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{1,64}$/.test(hex)) throw new Error(`invalid Sui id: ${id}`);
  return `0x${hex.padStart(64, '0')}` as Bytes32;
}

// Sui asset ids hash the canonical `std::type_name` string: 64 lowercase hex address digits,
// no 0x prefix, e.g. "0000…0002::sui::SUI". Any other spelling produces a different asset.
export function canonicalSuiTypeName(coinType: string): string {
  const m = /^(?:0x)?([0-9a-fA-F]{1,64})::([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)$/.exec(coinType);
  if (!m) throw new Error(`unsupported coin type: ${coinType}`);
  return `${m[1]!.toLowerCase().padStart(64, '0')}::${m[2]}::${m[3]}`;
}

export function suiAssetId(coinType: string): Bytes32 {
  return keccak256(toHex(canonicalSuiTypeName(coinType)));
}

export function evmAdapterId(args: {
  chainRef: Bytes32;
  actionKind: number;
  adapterVersion: number;
  adapterName: string;
  adapter: Address;
  codeHash: Hex;
}): Bytes32 {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'uint32' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bytes32' },
      ],
      [ADAPTER_TAG, args.chainRef, args.actionKind, args.adapterVersion, keccak256(toHex(args.adapterName)), args.adapter, args.codeHash],
    ),
  );
}

export function suiAdapterId(args: {
  chainRef: Bytes32;
  actionKind: number;
  adapterVersion: number;
  adapterName: string;
  witnessType: string;
}): Bytes32 {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint8' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [
        ADAPTER_TAG,
        args.chainRef,
        args.actionKind,
        args.adapterVersion,
        keccak256(toHex(args.adapterName)),
        keccak256(toHex(canonicalSuiTypeName(args.witnessType))),
      ],
    ),
  );
}
