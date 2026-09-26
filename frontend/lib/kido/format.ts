/** Display helpers for Kido values. */
import type { ChainId, ProjectStage } from './types';

export const CHAIN_LABEL: Record<string, string> = { 'ethereum-sepolia': 'Ethereum Sepolia', 'sui-testnet': 'Sui Testnet' };
export const chainLabel = (c: ChainId) => CHAIN_LABEL[c] ?? c;

export const STAGE_LABEL: Record<ProjectStage, string> = {
  INTERVIEW: 'Interview',
  BLUEPRINT: 'Blueprint',
  REVIEWED: 'Reviewed',
  SIMULATED: 'Simulated',
  BUILT: 'Built',
};

/** Seconds as a short human window ("1 h", "1 day"). */
export function windowLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** Requirement values are stored as JSON; render them as text. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(valueText).join(', ');
  return JSON.stringify(v);
}

export const labelOfKey = (key: string) => key.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Base units → "25 AMUSD", using the decimals the blueprint records for the asset on that chain. */
export function amount(baseUnits: string, symbol: string, chain: ChainId, assets: Array<Record<string, unknown>>): string {
  const a = assets.find((x) => x.symbol === symbol && x.chain === chain) ?? assets.find((x) => x.symbol === symbol);
  const decimals = typeof a?.decimals === 'number' ? a.decimals : null;
  if (decimals === null || !/^\d+$/.test(baseUnits)) return `${baseUnits} ${symbol}`;
  const s = baseUnits.padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return `${whole}${frac ? `.${frac}` : ''} ${symbol}`;
}

/** Block explorer links for a chain's transactions and accounts. */
export function explorerTx(chain: ChainId, tx: string): string {
  return chain === 'sui-testnet' ? `https://suiscan.xyz/testnet/tx/${tx}` : `https://sepolia.etherscan.io/tx/${tx}`;
}
export function explorerAccount(chain: ChainId, account: string): string {
  return chain === 'sui-testnet' ? `https://suiscan.xyz/testnet/object/${account}` : `https://sepolia.etherscan.io/address/${account}`;
}
export const LEASE_STATUS: Record<number, string> = { 0: 'none', 1: 'active', 2: 'revoked' };
