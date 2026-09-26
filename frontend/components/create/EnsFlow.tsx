'use client';

/**
 * ENS-first pieces of the create flow.
 *
 * - TemplateSetup: a template's questions as a pre-filled form. Suppliers and the loan wallet can
 *   be ENS names; each is resolved live and the resolved address is what the policy pins (a name
 *   is how you find someone, never authority). Nothing is free text, so nothing can fail to parse.
 * - NameCheck: live ENS availability and ownership while you name the agent.
 * - EnsProfile: the agent as ENS will show it — the name tree (agent, one subname per specialist)
 *   and the text records each name publishes.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, CircleAlert, Loader, Plus, Trash2 } from 'lucide-react';
import { kido } from '@/lib/kido/api';
import { chainLabel } from '@/lib/kido/format';
import type { EnsLookup, InterviewTemplateInfo, PlannedBinding, TemplatePrefill } from '@/lib/kido/types';

const EVM = /^0x[0-9a-fA-F]{40}$/;
const SUI = /^0x[0-9a-fA-F]{64}$/;
const ENS = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Resolved = { state: 'idle' | 'checking' | 'ok' | 'error'; address?: string; note?: string };

/** Validates one address field; an ENS name (Ethereum chains only) is resolved live. */
function useAddress(value: string, chain: string): Resolved {
  const [r, setR] = useState<Resolved>({ state: 'idle' });
  useEffect(() => {
    const v = value.trim();
    const evm = !chain.startsWith('sui');
    if (!v) return setR({ state: 'error', note: 'required' });
    if (evm ? EVM.test(v) : SUI.test(v)) return setR({ state: 'ok', address: v });
    if (evm && ENS.test(v)) {
      setR({ state: 'checking' });
      const t = setTimeout(() => {
        kido.ens(v.toLowerCase())
          .then((x) => setR(x.address ? { state: 'ok', address: x.address, note: `${v} → ${short(x.address)}` } : { state: 'error', note: x.registered ? `${v} has no address record` : `${v} is not registered` }))
          .catch((e: Error) => setR({ state: 'error', note: e.message }));
      }, 450);
      return () => clearTimeout(t);
    }
    setR({ state: 'error', note: evm ? 'an 0x address or an ENS name' : 'a Sui address (0x + 64 hex)' });
  }, [value, chain]);
  return r;
}

function AddressField({ value, chain, onChange, onResolved }: { value: string; chain: string; onChange: (v: string) => void; onResolved: (r: Resolved) => void }) {
  const r = useAddress(value, chain);
  useEffect(() => onResolved(r), [r.state, r.address]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="kf-addr">
      <input className="cl-input kf-mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder={chain.startsWith('sui') ? '0x… (Sui address)' : '0x… or name.eth'} spellCheck={false} />
      <span className="kf-addr__state" data-state={r.state}>
        {r.state === 'checking' ? <Loader size={12} className="kc-spin" /> : r.state === 'ok' ? <Check size={12} /> : r.state === 'error' ? <CircleAlert size={12} /> : null}
        {r.note ?? (r.state === 'ok' ? 'valid' : '')}
      </span>
    </div>
  );
}

export interface SetupAnswers { payees: string; beneficiary: string; limits: string }

/** The template's three questions as a form, starting from the template's suggestions. */
export function TemplateSetup({ template, onReady }: { template: InterviewTemplateInfo; onReady: (a: SetupAnswers | null) => void }) {
  const chains = useMemo(() => [...new Set([...template.prefill.payees.map((p) => p.chain), template.prefill.beneficiary.chain])], [template]);
  const [f, setF] = useState<TemplatePrefill>(() => structuredClone(template.prefill));
  const [res, setRes] = useState<Record<string, Resolved>>({});
  const mark = (k: string) => (r: Resolved) => setRes((x) => (x[k]?.state === r.state && x[k]?.address === r.address ? x : { ...x, [k]: r }));

  useEffect(() => {
    const keys = [...f.payees.map((_, i) => `p${i}`), 'b'];
    const allOk = keys.every((k) => res[k]?.state === 'ok') && f.payees.every((p) => p.label.trim()) && Number(f.limits.perHour) > 0 && Number(f.limits.total) >= Number(f.limits.perHour);
    if (!allOk) return onReady(null);
    const addr = (k: string) => res[k]!.address!;
    onReady({
      payees: f.payees.map((p, i) => `${p.label.trim()} on ${chainLabel(p.chain)}: ${addr(`p${i}`)}`).join('; '),
      beneficiary: `${addr('b')} on ${chainLabel(f.beneficiary.chain)}`,
      limits: `${f.limits.perHour} per hour, ${f.limits.total} total`,
    });
  }, [f, res]); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = (key: string) => template.asks.find((a) => a.key === key)?.text ?? key;
  return (
    <div className="kf-stack">
      <p className="kc-boxes__count">Pre-filled from the template · edit anything</p>

      <div className="kf-card">
        <div className="kf-card__head"><span className="kf-card__title">Suppliers it may pay</span><span className="kf-chip" data-tone="data">ENS names accepted</span></div>
        <p className="kf-meta">{ask('payees')}</p>
        {f.payees.map((p, i) => (
          <div key={i} className="kf-payee">
            <input className="cl-input" value={p.label} onChange={(e) => setF({ ...f, payees: f.payees.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} placeholder="name" />
            <select className="cl-select" value={p.chain} onChange={(e) => setF({ ...f, payees: f.payees.map((x, j) => (j === i ? { ...x, chain: e.target.value } : x)) })}>
              {chains.map((c) => <option key={c} value={c}>{chainLabel(c)}</option>)}
            </select>
            <AddressField value={p.address} chain={p.chain} onChange={(v) => setF({ ...f, payees: f.payees.map((x, j) => (j === i ? { ...x, address: v } : x)) })} onResolved={mark(`p${i}`)} />
            <button type="button" className="cl-btn cl-btn-sm" aria-label="Remove supplier" disabled={f.payees.length <= 1} onClick={() => { setF({ ...f, payees: f.payees.filter((_, j) => j !== i) }); setRes({}); }}><Trash2 size={12} /></button>
          </div>
        ))}
        <button type="button" className="cl-btn cl-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setF({ ...f, payees: [...f.payees, { label: '', chain: chains[0]!, address: '' }] })}><Plus size={12} /> Add a supplier</button>
      </div>

      <div className="kf-card">
        <div className="kf-card__head"><span className="kf-card__title">The loan it protects</span><span className="kf-chip">{chainLabel(f.beneficiary.chain)}</span></div>
        <p className="kf-meta">{ask('beneficiary')}</p>
        <AddressField value={f.beneficiary.address} chain={f.beneficiary.chain} onChange={(v) => setF({ ...f, beneficiary: { ...f.beneficiary, address: v } })} onResolved={mark('b')} />
      </div>

      <div className="kf-card">
        <div className="kf-card__head"><span className="kf-card__title">How much it may spend</span></div>
        <p className="kf-meta">Of each token it holds. The chain enforces both limits; you can lower them any time.</p>
        <div className="kf-limits">
          <label><span className="kf-label">Per hour</span><input className="cl-input" type="number" min={1} value={f.limits.perHour} onChange={(e) => setF({ ...f, limits: { ...f.limits, perHour: e.target.value } })} /></label>
          <label><span className="kf-label">In total, before you re-approve</span><input className="cl-input" type="number" min={1} value={f.limits.total} onChange={(e) => setF({ ...f, limits: { ...f.limits, total: e.target.value } })} /></label>
        </div>
        {Number(f.limits.total) < Number(f.limits.perHour) ? <p className="kf-meta" style={{ color: 'var(--cl-deny)' }}>The total cannot be less than one hour&apos;s limit.</p> : null}
      </div>
    </div>
  );
}

/* ── identity: live ENS check ── */
export function useEnsLookup(name: string | null) {
  const [r, setR] = useState<{ loading: boolean; data?: EnsLookup; error?: string }>({ loading: false });
  useEffect(() => {
    if (!name || !ENS.test(name)) return setR({ loading: false });
    setR({ loading: true });
    const t = setTimeout(() => {
      kido.ens(name).then((data) => setR({ loading: false, data })).catch((e: Error) => setR({ loading: false, error: e.message }));
    }, 500);
    return () => clearTimeout(t);
  }, [name]);
  return r;
}

export function NameCheck({ parent, full }: { parent: string | null; full: string | null }) {
  const p = useEnsLookup(parent);
  const f = useEnsLookup(full);
  const expiry = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : '—');
  return (
    <div className="kf-card kf-ens">
      <div className="kf-card__head"><span className="kf-card__title">On ENS right now</span><span className="kf-chip" data-tone="data">Sepolia · live</span></div>
      <div className="kf-ens__row">
        <span className="kf-mono">{parent ?? '—'}</span>
        {p.loading ? <Loader size={12} className="kc-spin" /> : p.data ? (
          p.data.owner ? <span className="kf-body">owned by <span className="kf-mono">{short(p.data.owner)}</span> · renews {expiry(p.data.expiresAt)}<span className="kf-meta"> — to create the specialists&apos; subnames the deploying wallet must own it</span></span>
          : <span className="kf-body" data-tone="pass">available · $5/year on mainnet</span>
        ) : p.error ? <span className="kf-meta">{p.error}</span> : null}
      </div>
      <div className="kf-ens__row">
        <span className="kf-mono">{full ?? '—'}</span>
        {f.loading ? <Loader size={12} className="kc-spin" /> : f.data ? (
          f.data.registered ? <span className="kf-body">already exists{f.data.records['kido-agent-id'] ? ` — agent ${f.data.records['kido-agent-id']}` : ''}{f.data.address ? ` → ${short(f.data.address)}` : ''}</span>
          : <span className="kf-body" data-tone="pass">free to create as a subname</span>
        ) : null}
      </div>
    </div>
  );
}

/* ── identity: the ENS profile the agent will publish ── */
export function EnsProfile({ plan }: { plan: PlannedBinding[] }) {
  const ens = plan.filter((b) => b.providerId === 'ens');
  const root = ens.find((b) => !b.role);
  const subs = ens.filter((b) => b.role);
  const sui = plan.filter((b) => b.providerId === 'suins');
  const [open, setOpen] = useState<string | null>(root?.name ?? null);
  if (!root) return null;
  const sel = ens.find((b) => b.name === open) ?? root;
  const manifest = (() => {
    try {
      return sel.records?.['agent-context'] ? (JSON.parse(sel.records['agent-context']) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  })();
  return (
    <div className="kf-card kf-profile">
      <div className="kf-profile__head">
        <div className="kf-avatar" aria-hidden>{root.name.slice(0, 1).toUpperCase()}</div>
        <div style={{ minWidth: 0 }}>
          <div className="kf-profile__name">{root.name}</div>
          <p className="kf-meta">{String(manifest?.description ?? 'Kido agent')} · {sui.find((b) => !b.role)?.name ?? ''}</p>
        </div>
      </div>
      <div className="kf-tree">
        <button type="button" className="kf-tree__node" data-selected={sel.name === root.name ? '' : undefined} onClick={() => setOpen(root.name)}>{root.name}</button>
        <div className="kf-tree__children">
          {subs.map((b) => (
            <button key={b.name} type="button" className="kf-tree__node" data-selected={sel.name === b.name ? '' : undefined} onClick={() => setOpen(b.name)}>
              <span className="kf-mono">{b.label}.</span><span className="kf-meta">{b.role}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="kf-label">Text records on {sel.name}</div>
      <table className="kf-table">
        <tbody>
          {Object.entries(sel.records ?? {}).map(([k, v]) => (
            <tr key={k}>
              <td className="kf-mono" style={{ whiteSpace: 'nowrap' }}>{k}</td>
              <td className="kf-mono" style={{ wordBreak: 'break-all' }}>{k === 'agent-context' && manifest ? <RecordJson v={manifest} /> : v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="kf-meta">Anyone can resolve these to verify which agent they are talking to and what it may do. The authority note is part of the record: a name never grants authority.</p>
    </div>
  );
}

function RecordJson({ v }: { v: Record<string, unknown> }) {
  const keep = ['kidoAgentId', 'supportedChains', 'publicCapabilities', 'blueprintCommitment', 'authorityNote'];
  return (
    <span className="kf-json">
      {keep.filter((k) => v[k] !== undefined).map((k) => (
        <span key={k}><span className="kf-meta">{k}</span> {Array.isArray(v[k]) ? (v[k] as unknown[]).join(', ') : String(v[k]).length > 66 ? `${String(v[k]).slice(0, 66)}…` : String(v[k])}</span>
      ))}
    </span>
  );
}
