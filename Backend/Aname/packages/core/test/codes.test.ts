import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AMANE_CODES } from '../src/index.js';

const move = ['account.move', 'crypto.move', 'eip712.move']
  .map((f) => readFileSync(resolve(__dirname, '../../../sui/amane/sources', f), 'utf8'))
  .join('\n');
const sol = readFileSync(resolve(__dirname, '../../../evm/src/AmaneCodes.sol'), 'utf8');

describe('shared rejection codes', () => {
  it('every Sui abort code has a name in the shared table', () => {
    const numbers = new Set<number>(Object.values(AMANE_CODES));
    for (const m of move.matchAll(/const E\w+: u64 = (\d+);/g)) expect(numbers.has(Number(m[1])), m[0]).toBe(true);
  });

  it('generated Solidity codes match the table', () => {
    for (const [name, n] of Object.entries(AMANE_CODES)) expect(sol).toContain(`${name.replace(/^AMANE_/, '')} = ${n};`);
  });

  it('codes are unique', () => {
    const vals = Object.values(AMANE_CODES);
    expect(new Set(vals).size).toBe(vals.length);
  });
});
