/**
 * Attack Lab helpers: unit conversion against the blueprint's recorded decimals, the layer
 * explanations, and presets derived from the blueprint's own limits, payees and lease.
 */
import type { Blueprint, ChainId, LabLayer, LabVerdict, WhatIf } from '@/lib/kido/types';

export interface AssetRow { symbol: string; chain: ChainId; decimals: number | null; ref: string | null }

export function assetsOf(bp: Blueprint): AssetRow[] {
  return bp.assets
    .filter((a) => typeof a.symbol === 'string')
    .map((a) => ({
      symbol: a.symbol as string,
      chain: (a.chain as ChainId) ?? bp.chains[0] ?? '',
      decimals: typeof a.decimals === 'number' ? a.decimals : null,
      ref: typeof a.ref === 'string' ? a.ref : null,
    }));
}

/** Asset symbols the form may pick on a chain: the blueprint's assets plus any symbol a limit names. */
export function assetChoices(bp: Blueprint, chain: ChainId): string[] {
  const s = new Set<string>();
  for (const a of assetsOf(bp)) if (a.chain === chain) s.add(a.symbol);
  for (const l of bp.authority.limits) if (l.chain === chain) s.add(l.asset);
  for (const f of bp.authority.swapFloors) if (f.chain === chain) { s.add(f.assetIn); s.add(f.assetOut); }
  return [...s];
}

export function decimalsOf(bp: Blueprint, symbol: string, chain: ChainId): number | null {
  const all = assetsOf(bp);
  return (all.find((a) => a.symbol === symbol && a.chain === chain) ?? all.find((a) => a.symbol === symbol))?.decimals ?? null;
}

/** "12.5" with 6 decimals → "12500000". Null when the text is not a non-negative decimal or has too many places. */
export function toBaseUnits(human: string, decimals: number | null): string | null {
  const t = human.trim().replace(/,/g, '');
  if (decimals === null) return /^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, '') : null;
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  return `${m[1] || '0'}${frac.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
}

/** Base units → plain decimal text (no grouping), the inverse of toBaseUnits. */
export function fromBaseUnits(base: string, decimals: number | null): string {
  if (decimals === null || decimals === 0 || !/^\d+$/.test(base)) return base;
  const s = base.padStart(decimals + 1, '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return `${s.slice(0, s.length - decimals)}${frac ? `.${frac}` : ''}`;
}

export const addBase = (a: string, b: bigint) => (BigInt(a) + b).toString();

/** A random address in the chain's shape (EVM: 20 bytes, Sui: 32 bytes); nobody the owner pinned. */
export function strangerAddress(chain: ChainId): string {
  const bytes = new Uint8Array(chain.startsWith('sui') ? 32 : 20);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export const LAYER_LABEL: Record<LabLayer, string> = {
  KIDO_VALIDATOR: 'Kido plan validator',
  KIDO_COMPILER: 'Kido compiler',
  AMANE_RULES: 'Amane rules (on-chain)',
  NONE: 'No layer refused it',
};

export function layerExplanation(v: LabVerdict): string {
  switch (v.layer) {
    case 'KIDO_VALIDATOR':
      return 'Kido’s plan validator refused the proposal before it was compiled: the shape, the specialist, the chain or the asset is not one this agent may propose. Nothing would reach a chain.';
    case 'KIDO_COMPILER':
      return 'Kido’s compiler could not turn this into an Amane intent — there is no adapter for the action on this chain, the asset is not in the blueprint, or the action has no enforcement rule. The runtime never has anything to sign.';
    case 'AMANE_RULES':
      return 'Kido compiled the intent, but the Amane subset rules refused it. These are the same rules the deployed account enforces on-chain, so even a compromised Kido runtime could not get this executed.';
    case 'NONE':
      return v.verdict === 'ALLOW'
        ? 'Every layer accepted it: it is inside the lease, the limits and the pinned payees. Amane would execute it.'
        : 'The blueprint grants no on-chain authority, so there is no account that could act at all.';
  }
}

export interface Preset { id: string; label: string; why: string; form: Partial<WhatIfForm> | null; disabledReason?: string }

export interface WhatIfForm {
  chain: ChainId;
  action: string;
  customAction: string;
  asset: string;
  assetOut: string;
  amount: string;
  recipientMode: 'label' | 'address' | 'none';
  recipientLabel: string;
  recipientAddress: string;
  timing: 'now' | 'afterLease' | 'custom';
  customSeconds: string;
}

export function defaultForm(bp: Blueprint): WhatIfForm {
  const chain = bp.chains[0] ?? '';
  const limit = bp.authority.limits.find((l) => l.chain === chain);
  const asset = limit?.asset ?? assetChoices(bp, chain)[0] ?? '';
  const payee = pinned(bp).find((p) => p.chain === chain);
  return {
    chain,
    action: bp.authority.allowedActions[0] ?? bp.authority.forbiddenActions[0] ?? '__custom',
    customAction: '',
    asset,
    assetOut: '',
    amount: limit ? fromBaseUnits(limit.perAction, decimalsOf(bp, asset, chain)) : '',
    recipientMode: payee ? 'label' : 'address',
    recipientLabel: payee?.label ?? '',
    recipientAddress: '',
    timing: 'now',
    customSeconds: '',
  };
}

export const pinned = (bp: Blueprint) => [
  ...bp.authority.payees.map((p) => ({ ...p, kind: 'payee' as const })),
  ...bp.authority.beneficiaries.map((p) => ({ ...p, kind: 'beneficiary' as const })),
];

/**
 * Attacks that fill the form, each built from the blueprint's own numbers. A preset that cannot
 * apply to this blueprint is shown disabled with the reason instead of inventing a value.
 */
export function presets(bp: Blueprint, unlistedAssets: { chain: ChainId; symbol: string }[]): Preset[] {
  const a = bp.authority;
  const chain = bp.chains[0] ?? '';
  const limit = a.limits.find((l) => l.chain === chain) ?? a.limits[0];
  const payee = pinned(bp).find((p) => p.chain === (limit?.chain ?? chain)) ?? pinned(bp)[0];
  const act = a.allowedActions[0];
  const dec = limit ? decimalsOf(bp, limit.asset, limit.chain) : null;
  const human = (base: string) => fromBaseUnits(base, dec);
  const toPayee: Partial<WhatIfForm> = payee ? { recipientMode: 'label', recipientLabel: payee.label } : { recipientMode: 'none' };
  const base: Partial<WhatIfForm> | null = limit && act ? { chain: limit.chain, action: act, asset: limit.asset, assetOut: '', timing: 'now', ...toPayee } : null;
  const noLimit = 'The blueprint sets no spending limit, so there is no in-policy action to vary.';
  const out: Preset[] = [];

  out.push(base && limit
    ? { id: 'at-cap', label: 'Exactly at the per-action cap', why: `${human(limit.perAction)} ${limit.asset} to ${payee?.label ?? 'no one'}: the boundary, which should be allowed.`, form: { ...base, amount: human(limit.perAction) } }
    : { id: 'at-cap', label: 'Exactly at the per-action cap', why: '', form: null, disabledReason: noLimit });
  out.push(base && limit
    ? { id: 'over-cap', label: 'One unit over the per-action limit', why: `${human(addBase(limit.perAction, 1n))} ${limit.asset}: one base unit above the cap.`, form: { ...base, amount: human(addBase(limit.perAction, 1n)) } }
    : { id: 'over-cap', label: 'One unit over the per-action limit', why: '', form: null, disabledReason: noLimit });
  out.push(base && limit
    ? { id: 'over-window', label: 'More than the whole window allows', why: `${human(addBase(limit.perWindow, 1n))} ${limit.asset} in one action, above the rolling-window budget.`, form: { ...base, amount: human(addBase(limit.perWindow, 1n)) } }
    : { id: 'over-window', label: 'More than the whole window allows', why: '', form: null, disabledReason: noLimit });
  out.push(base && limit
    ? { id: 'stranger', label: 'Pay a stranger', why: 'A fresh random address nobody pinned, for an in-policy amount.', form: { ...base, amount: human(limit.perAction), recipientMode: 'address', recipientAddress: strangerAddress(limit.chain) } }
    : { id: 'stranger', label: 'Pay a stranger', why: '', form: null, disabledReason: noLimit });
  out.push(a.forbiddenActions.length && limit
    ? { id: 'forbidden', label: `Forbidden action: ${a.forbiddenActions[0]}`, why: `The owner forbade ${a.forbiddenActions.join(', ')}.`, form: { chain: limit.chain, action: a.forbiddenActions[0]!, asset: limit.asset, amount: human(limit.perAction), timing: 'now', ...toPayee } }
    : { id: 'forbidden', label: 'Forbidden action', why: '', form: null, disabledReason: 'The blueprint forbids no action explicitly.' });
  out.push(base && limit
    ? { id: 'expired', label: 'After the lease expires', why: `Evaluated ${a.leaseLifetimeSeconds + 60} s from now: the lease lives ${a.leaseLifetimeSeconds} s.`, form: { ...base, amount: human(limit.perAction), timing: 'afterLease' } }
    : { id: 'expired', label: 'After the lease expires', why: '', form: null, disabledReason: noLimit });

  // An asset the blueprint records for one chain, submitted on another of its chains.
  const assets = assetsOf(bp);
  const cross = bp.chains.flatMap((c) => assets.filter((x) => x.chain !== c && !assets.some((y) => y.symbol === x.symbol && y.chain === c)).map((x) => ({ chain: c, asset: x })))[0];
  out.push(cross && act
    ? { id: 'wrong-chain', label: 'Asset on the wrong chain', why: `${cross.asset.symbol} is recorded on ${cross.asset.chain}, submitted on ${cross.chain}.`, form: { chain: cross.chain, action: act, asset: cross.asset.symbol, amount: '1', timing: 'now', ...toPayee } }
    : { id: 'wrong-chain', label: 'Asset on the wrong chain', why: '', form: null, disabledReason: 'Every blueprint asset is on every blueprint chain (or it has one chain), so there is no other chain’s asset to cross.' });
  const unlisted = unlistedAssets.find((u) => bp.chains.includes(u.chain));
  out.push(unlisted && act
    ? { id: 'unlisted', label: `Unlisted asset: ${unlisted.symbol}`, why: `${unlisted.symbol} exists in the Amane deployment on ${unlisted.chain} but is not in this blueprint.`, form: { chain: unlisted.chain, action: act, asset: unlisted.symbol, amount: '1', timing: 'now', ...toPayee } }
    : { id: 'unlisted', label: 'Unlisted asset', why: '', form: null, disabledReason: 'No deployed asset outside the blueprint found on its chains.' });
  return out;
}

export function buildRequest(bp: Blueprint, f: WhatIfForm): { req: WhatIf; baseUnits: string } | { error: string } {
  const action = f.action === '__custom' ? f.customAction.trim().toUpperCase() : f.action;
  if (!action) return { error: 'Choose or type an action.' };
  if (!f.asset.trim()) return { error: 'Choose an asset.' };
  const dec = decimalsOf(bp, f.asset, f.chain);
  const baseUnits = toBaseUnits(f.amount, dec);
  if (baseUnits === null) return { error: dec === null ? 'This asset has no recorded decimals: enter whole base units.' : `Enter a non-negative amount with at most ${dec} decimal places.` };
  const recipient = f.recipientMode === 'label' ? f.recipientLabel || null : f.recipientMode === 'address' ? f.recipientAddress.trim() || null : null;
  let at: number | undefined;
  if (f.timing === 'afterLease') at = bp.authority.leaseLifetimeSeconds + 60;
  else if (f.timing === 'custom') {
    if (!/^-?\d+$/.test(f.customSeconds.trim())) return { error: 'Time offset must be whole seconds.' };
    at = Number(f.customSeconds.trim());
  }
  return {
    baseUnits,
    req: { chain: f.chain, action, asset: f.asset.trim(), assetOut: action === 'SWAP' ? f.assetOut || null : null, amount: baseUnits, recipient, ...(at !== undefined ? { atSecondsFromNow: at } : {}) },
  };
}
