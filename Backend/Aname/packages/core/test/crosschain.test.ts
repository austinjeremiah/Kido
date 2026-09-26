import { describe, expect, it } from 'vitest';
import { destSpecHash } from '../src/crosschain.js';

describe('destination spec commitment', () => {
  it('matches the Solidity DestSpecHash vector', () => {
    expect(destSpecHash({ actionKind: 2, adapterId: `0x${'11'.repeat(32)}`, recipient: `0x${'22'.repeat(32)}`, recipientLabel: 'owner position', asset: `0x${'33'.repeat(32)}`, minArrival: 99_000000n, deadline: 1_800_003_600n })).toBe('0xb00f7df4a08766849859c3597c0968709501383280002db39d66ad734075e5af');
  });
});
