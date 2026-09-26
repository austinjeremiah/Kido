import { AMANE_TYPES } from '../src/index.js';

type Field = { name: string; type: string };
const TYPES = AMANE_TYPES as unknown as Record<string, readonly Field[]>;

export const snake = (s: string) => s.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase());
export const hexBytes = (h: string) => `x"${h.replace(/^0x/, '').toLowerCase()}"`;
export const utf8Hex = (s: string) => `x"${Buffer.from(s, 'utf8').toString('hex')}"`;

export function moveExpr(type: string, value: unknown): string {
  if (type.endsWith('[]')) {
    const inner = type.slice(0, -2);
    const arr = value as unknown[];
    const elemType = TYPES[inner] ? `eip712::${inner}` : 'vector<u8>';
    return `vector<${elemType}>[${arr.map((x) => moveExpr(inner, x)).join(', ')}]`;
  }
  const fields = TYPES[type];
  if (fields) return `eip712::${snake(type)}(${fields.map((f) => moveExpr(f.type, (value as Record<string, unknown>)[f.name])).join(', ')})`;
  if (type === 'string') return utf8Hex(value as string);
  if (type === 'bytes32' || type === 'address') return hexBytes(value as string);
  const suffix = type === 'uint8' ? 'u8' : type === 'uint32' ? 'u32' : type === 'uint64' ? 'u64' : 'u256';
  return `${(value as bigint | number).toString()}${suffix}`;
}

