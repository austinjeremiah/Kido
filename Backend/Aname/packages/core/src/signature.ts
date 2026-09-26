import { recoverAddress, type Address, type Hex } from 'viem';

export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const SECP256K1_HALF_N = SECP256K1_N >> 1n;

export class AmaneSignatureError extends Error {
  constructor(public readonly code: 'AMANE_CONTROLLER_BAD_SIGNATURE_LENGTH' | 'AMANE_CONTROLLER_BAD_V' | 'AMANE_CONTROLLER_HIGH_S' | 'AMANE_CONTROLLER_ZERO_RS') {
    super(code);
  }
}

// Both runtimes accept exactly r||s||v with v in {27,28} and s <= n/2. Sui's raw ecrecover
// accepts the high-s twin, so low-s is enforced by Amane itself on every chain.
export function assertCanonicalSignature(signature: Hex): { r: bigint; s: bigint; v: 27 | 28 } {
  const bytes = signature.slice(2);
  if (bytes.length !== 130) throw new AmaneSignatureError('AMANE_CONTROLLER_BAD_SIGNATURE_LENGTH');
  const r = BigInt(`0x${bytes.slice(0, 64)}`);
  const s = BigInt(`0x${bytes.slice(64, 128)}`);
  const v = parseInt(bytes.slice(128, 130), 16);
  if (v !== 27 && v !== 28) throw new AmaneSignatureError('AMANE_CONTROLLER_BAD_V');
  if (r === 0n || s === 0n) throw new AmaneSignatureError('AMANE_CONTROLLER_ZERO_RS');
  if (s > SECP256K1_HALF_N) throw new AmaneSignatureError('AMANE_CONTROLLER_HIGH_S');
  return { r, s, v };
}

export async function recoverAmaneSigner(digest: Hex, signature: Hex): Promise<Address> {
  assertCanonicalSignature(signature);
  return recoverAddress({ hash: digest, signature });
}

export function highSTwin(signature: Hex): Hex {
  const bytes = signature.slice(2);
  const s = BigInt(`0x${bytes.slice(64, 128)}`);
  const v = parseInt(bytes.slice(128, 130), 16);
  const twinS = (SECP256K1_N - s).toString(16).padStart(64, '0');
  const twinV = v === 27 ? 28 : 27;
  return `0x${bytes.slice(0, 64)}${twinS}${twinV.toString(16)}` as Hex;
}
