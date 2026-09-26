'use client';

/**
 * What-if tester: a hand-built action evaluated by the backend with the same compiler and Amane
 * subset rules the chain enforces. Presets fill the form from the blueprint's own limits, payees and
 * lease. Nothing is signed or sent; the session history lives only in this page.
 */
import { useMemo, useState } from 'react';
import { FlaskConical, Play, RotateCcw } from 'lucide-react';
import { Badge, BlockerBanner, Card, KeyValue } from '@/components/studio/primitives';
import { kido } from '@/lib/kido/api';
import { amount as fmtAmount, chainLabel } from '@/lib/kido/format';
import type { Blueprint, LabVerdict, WhatIf } from '@/lib/kido/types';
import { LAYER_LABEL, assetChoices, buildRequest, decimalsOf, defaultForm, layerExplanation, pinned, presets, type WhatIfForm } from './lab';

export interface Attempt { at: number; label: string; req: WhatIf; verdict: LabVerdict | null; error: string | null }

export function VerdictView({ v, bp, chain, asset }: { v: LabVerdict; bp: Blueprint; chain: string; asset: string }) {
  const allow = v.verdict === 'ALLOW';
  return (
    <div className="cl-stack" style={{ gap: 12 }}>
      <div className="cl-row cl-row-wrap" style={{ gap: 8 }}>
        <Badge tone={allow ? 'pass' : 'deny'} large chip>{v.verdict}</Badge>
        <Badge tone={v.layer === 'NONE' ? (allow ? 'pass' : 'blocked') : v.layer === 'AMANE_RULES' ? 'deny' : 'warn'} large>Decided by: {LAYER_LABEL[v.layer]}</Badge>
        {v.code ? <span className="cl-mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{v.code}</span> : null}
      </div>
      <p className="cl-body" style={{ margin: 0 }}>{layerExplanation(v)}</p>
      <p className="cl-meta" style={{ margin: 0 }}>Detail from the rules: <span className="cl-mono">{v.detail}</span></p>
      {allow && v.intent ? (
        <div>
          <div className="cl-label" style={{ marginBottom: 6 }}>Compiled Amane intent</div>
          <KeyValue
            rows={Object.entries(v.intent).map(([k, val]) => ({
              label: k,
              mono: true,
              value:
                (k === 'amountIn' || k === 'minAmountOut') && typeof val === 'string'
                  ? `${val} (${fmtAmount(val, asset, chain, bp.assets)})`
                  : k === 'deadline'
                    ? `${val} (${new Date(Number(val) * 1000).toISOString().replace('T', ' ').slice(0, 19)}Z)`
                    : String(val),
            }))}
          />
        </div>
      ) : null}
    </div>
  );
}

export function WhatIfTester({ bp, id, unlisted }: { bp: Blueprint; id: string; unlisted: { chain: string; symbol: string }[] }) {
  const a = bp.authority;
  const [form, setForm] = useState<WhatIfForm>(() => defaultForm(bp));
  const [label, setLabel] = useState('Custom');
  const [pending, setPending] = useState(false);
  const [history, setHistory] = useState<Attempt[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const set = (p: Partial<WhatIfForm>) => { setForm((f) => ({ ...f, ...p })); setLabel('Custom'); };

  const allPresets = useMemo(() => presets(bp, unlisted), [bp, unlisted]);
  const actions = [...new Set([...a.allowedActions, ...a.forbiddenActions])];
  const assets = assetChoices(bp, form.chain);
  const payees = pinned(bp);
  const dec = decimalsOf(bp, form.asset, form.chain);
  const built = buildRequest(bp, form);
  const limit = a.limits.find((l) => l.chain === form.chain && l.asset === form.asset);
  const pinnedMatch = form.recipientMode === 'address' ? payees.find((p) => p.address.toLowerCase() === form.recipientAddress.trim().toLowerCase()) : undefined;
  const latest = history[0] ?? null;

  const run = async () => {
    setFormError(null);
    if ('error' in built) { setFormError(built.error); return; }
    setPending(true);
    const entry: Attempt = { at: Date.now(), label, req: built.req, verdict: null, error: null };
    try {
      entry.verdict = await kido.whatIf(id, built.req);
    } catch (e) {
      entry.error = (e as Error).message;
    }
    setHistory((h) => [entry, ...h]);
    setPending(false);
  };

  return (
    <div className="cl-stack" style={{ gap: 14 }}>
      <Card title="Preset attacks" actions={<span className="cl-meta">Built from this blueprint’s limits, payees and lease</span>}>
        <div className="cl-grid cl-grid-auto" style={{ gap: 8 }}>
          {allPresets.map((p) => (
            <button
              key={p.id}
              type="button"
              className="cl-card"
              disabled={!p.form}
              title={p.disabledReason}
              onClick={() => { if (p.form) { setForm((f) => ({ ...f, ...p.form })); setLabel(p.label); setFormError(null); } }}
              style={{ textAlign: 'left', padding: '10px 12px', cursor: p.form ? 'pointer' : 'not-allowed', opacity: p.form ? 1 : 0.55, borderColor: label === p.label ? 'var(--cl-ink)' : undefined }}
            >
              <div className="cl-strong" style={{ fontSize: 13 }}>{p.label}</div>
              <div className="cl-meta" style={{ whiteSpace: 'normal', marginTop: 3 }}>{p.form ? p.why : p.disabledReason}</div>
            </button>
          ))}
        </div>
      </Card>

      <div className="cl-grid cl-grid-2" style={{ alignItems: 'start' }}>
        <Card title={<span>Action <span className="cl-meta">· {label}</span></span>} actions={<button type="button" className="cl-btn cl-btn-sm" onClick={() => { setForm(defaultForm(bp)); setLabel('Custom'); setFormError(null); }}><RotateCcw size={11} aria-hidden /> Reset</button>}>
          <div className="cl-grid cl-grid-2" style={{ gap: '0 12px' }}>
            <label className="cl-field">
              <span className="cl-field-label">Chain</span>
              <select className="cl-select" value={form.chain} onChange={(e) => set({ chain: e.target.value, asset: assetChoices(bp, e.target.value)[0] ?? '' })}>
                {bp.chains.map((c) => <option key={c} value={c}>{chainLabel(c)}</option>)}
              </select>
            </label>
            <label className="cl-field">
              <span className="cl-field-label">Action</span>
              <select className="cl-select" value={form.action} onChange={(e) => set({ action: e.target.value })}>
                {actions.map((x) => <option key={x} value={x}>{x}{a.forbiddenActions.includes(x) ? ' (forbidden)' : ''}</option>)}
                <option value="__custom">Other…</option>
              </select>
            </label>
            {form.action === '__custom' ? (
              <label className="cl-field" style={{ gridColumn: '1 / -1' }}>
                <span className="cl-field-label">Action name</span>
                <input className="cl-input" value={form.customAction} placeholder="e.g. an action the blueprint never mentions" onChange={(e) => set({ customAction: e.target.value })} />
              </label>
            ) : null}
            <label className="cl-field">
              <span className="cl-field-label">Asset</span>
              <input className="cl-input" list="whatif-assets" value={form.asset} onChange={(e) => set({ asset: e.target.value })} />
              <datalist id="whatif-assets">{assets.map((x) => <option key={x} value={x} />)}</datalist>
            </label>
            {(form.action === '__custom' ? form.customAction.toUpperCase() : form.action) === 'SWAP' ? (
              <label className="cl-field">
                <span className="cl-field-label">Asset out</span>
                <input className="cl-input" list="whatif-assets" value={form.assetOut} onChange={(e) => set({ assetOut: e.target.value })} />
              </label>
            ) : null}
            <label className="cl-field">
              <span className="cl-field-label">Amount {form.asset ? `(${form.asset})` : ''}</span>
              <input className="cl-input cl-mono" value={form.amount} inputMode="decimal" onChange={(e) => set({ amount: e.target.value })} />
              <span className="cl-field-hint">
                {'error' in built ? (dec === null ? 'whole base units (no decimals recorded)' : `up to ${dec} decimals`) : `${built.baseUnits} base units`}
                {limit ? ` · cap ${fmtAmount(limit.perAction, limit.asset, limit.chain, bp.assets)} per action` : ''}
              </span>
            </label>
          </div>

          <div className="cl-field">
            <span className="cl-field-label">Recipient</span>
            <div className="cl-row cl-row-wrap" style={{ gap: 6 }}>
              {(['label', 'address', 'none'] as const).map((m) => (
                <button key={m} type="button" className={`cl-btn cl-btn-sm${form.recipientMode === m ? ' cl-btn-primary' : ''}`} onClick={() => set({ recipientMode: m })} disabled={m === 'label' && payees.length === 0}>
                  {m === 'label' ? 'Pinned payee' : m === 'address' ? 'Raw address' : 'None'}
                </button>
              ))}
            </div>
            {form.recipientMode === 'label' ? (
              <select className="cl-select" value={form.recipientLabel} onChange={(e) => set({ recipientLabel: e.target.value })}>
                {payees.map((p) => <option key={`${p.kind}${p.label}${p.chain}`} value={p.label}>{p.label} · {p.kind} · {chainLabel(p.chain)}</option>)}
              </select>
            ) : form.recipientMode === 'address' ? (
              <input className="cl-input cl-mono" value={form.recipientAddress} placeholder="0x…" onChange={(e) => set({ recipientAddress: e.target.value })} />
            ) : null}
            {pinnedMatch ? (
              <span className="cl-field-hint">This is {pinnedMatch.label}’s address. Amane pins recipients by label, so a raw address is refused even when it matches — pick the label to pay them.</span>
            ) : null}
          </div>

          <div className="cl-field">
            <span className="cl-field-label">When</span>
            <div className="cl-row cl-row-wrap" style={{ gap: 6 }}>
              <button type="button" className={`cl-btn cl-btn-sm${form.timing === 'now' ? ' cl-btn-primary' : ''}`} onClick={() => set({ timing: 'now' })}>Now</button>
              <button type="button" className={`cl-btn cl-btn-sm${form.timing === 'afterLease' ? ' cl-btn-primary' : ''}`} onClick={() => set({ timing: 'afterLease' })}>After lease expiry (+{a.leaseLifetimeSeconds + 60} s)</button>
              <button type="button" className={`cl-btn cl-btn-sm${form.timing === 'custom' ? ' cl-btn-primary' : ''}`} onClick={() => set({ timing: 'custom' })}>Custom offset</button>
            </div>
            {form.timing === 'custom' ? <input className="cl-input cl-mono" value={form.customSeconds} placeholder="seconds from now" onChange={(e) => set({ customSeconds: e.target.value })} /> : null}
          </div>

          {formError ? <p className="cl-meta" style={{ color: 'var(--cl-deny)' }}>{formError}</p> : null}
          <div className="cl-row" style={{ gap: 8 }}>
            <button type="button" className="cl-btn cl-btn-primary" onClick={() => void run()} disabled={pending}>
              <Play size={12} aria-hidden /> {pending ? 'Evaluating…' : 'Evaluate'}
            </button>
            <span className="cl-meta">Nothing is signed or sent.</span>
          </div>
        </Card>

        <Card title="Verdict">
          {!latest ? (
            <div className="cl-stack" style={{ gap: 8 }}>
              <FlaskConical size={20} aria-hidden />
              <p className="cl-meta" style={{ whiteSpace: 'normal' }}>Pick a preset or build an action, then evaluate it. The verdict names the layer that decided: Kido’s plan validator, Kido’s compiler, or the Amane rules the chain enforces.</p>
            </div>
          ) : latest.error ? (
            <BlockerBanner tone="deny" title="The Kido API could not evaluate this">{latest.error}</BlockerBanner>
          ) : latest.verdict ? (
            <VerdictView v={latest.verdict} bp={bp} chain={latest.req.chain} asset={latest.req.asset} />
          ) : null}
        </Card>
      </div>

      <Card flush title={`Session history · ${history.length} attempt${history.length === 1 ? '' : 's'}`} actions={history.length ? <button type="button" className="cl-btn cl-btn-sm" onClick={() => setHistory([])}>Clear</button> : null}>
        {history.length === 0 ? (
          <p className="cl-meta" style={{ padding: 14 }}>No attempts yet in this session.</p>
        ) : (
          <div className="cl-table-scroll">
            <table className="cl-table" style={{ minWidth: 900 }}>
              <thead>
                <tr><th style={{ width: 80 }}>Time</th><th>Attempt</th><th>Action</th><th>Amount</th><th>Recipient</th><th style={{ width: 90 }}>Verdict</th><th>Layer</th><th>Reason code</th></tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.at}>
                    <td className="cl-mono">{new Date(h.at).toLocaleTimeString()}</td>
                    <td>{h.label}</td>
                    <td className="cl-mono">{h.req.action} · {chainLabel(h.req.chain)}{h.req.atSecondsFromNow ? ` · +${h.req.atSecondsFromNow}s` : ''}</td>
                    <td className="cl-mono">{fmtAmount(h.req.amount, h.req.asset, h.req.chain, bp.assets)}</td>
                    <td className="cl-mono" title={h.req.recipient ?? undefined}>{h.req.recipient ? (h.req.recipient.length > 18 ? `${h.req.recipient.slice(0, 8)}…${h.req.recipient.slice(-6)}` : h.req.recipient) : '—'}</td>
                    <td>{h.verdict ? <Badge tone={h.verdict.verdict === 'ALLOW' ? 'pass' : 'deny'}>{h.verdict.verdict}</Badge> : <Badge tone="blocked">ERROR</Badge>}</td>
                    <td>{h.verdict ? LAYER_LABEL[h.verdict.layer] : '—'}</td>
                    <td className="cl-mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{h.verdict?.code ?? h.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
