import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem';
import type { Bytes32 } from './types.js';

/** What a cross-chain transfer may be used for at the destination (mirrors DestSpec in AmaneTypes.sol). */
export interface DestSpec {
  actionKind: number;
  adapterId: Bytes32;
  recipient: Bytes32;
  recipientLabel: string;
  asset: Bytes32;
  minArrival: bigint;
  deadline: bigint;
}

export const DEST_SPEC_TAG = keccak256(toHex('AMANE_DEST_SPEC_V1'));

/** The source BRIDGE ActionIntent commits to its destination use through planHash = destSpecHash(spec). */
export function destSpecHash(d: DestSpec): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }],
      [DEST_SPEC_TAG, d.actionKind, d.adapterId, d.recipient, keccak256(toHex(d.recipientLabel)), d.asset, d.minArrival, d.deadline],
    ),
  );
}
