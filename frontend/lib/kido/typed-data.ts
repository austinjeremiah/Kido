/**
 * The backend sends EIP-712 typed data with integers as decimal strings (JSON cannot carry
 * bigints). Wallets need them as bigints; this restores every uint/int field from `types`.
 */
import type { TypedDataWire } from './types';

export function reviveTypedData(td: TypedDataWire) {
  const revive = (type: string, v: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      td.types[type]!.map((f) => {
        const base = f.type.replace(/\[\]$/, '');
        const one = (x: unknown): unknown => (td.types[base] ? revive(base, x as Record<string, unknown>) : /^u?int\d*$/.test(base) ? BigInt(x as string) : x);
        const x = v[f.name];
        return [f.name, f.type.endsWith('[]') ? (x as unknown[]).map(one) : one(x)];
      }),
    );
  const { EIP712Domain: _drop, ...types } = td.types;
  return { domain: td.domain, types, primaryType: td.primaryType, message: revive(td.primaryType, td.message) };
}
