'use client';

/**
 * The agent's identity as ENSv2 holds it, read back from Sepolia: the published name tree with its
 * records and multichain addresses, a verification of the agent from its name alone (records →
 * Amane accounts read on their own chains), and the live name whose records Kido's gateway serves
 * through CCIP-read and the resolver verifies on-chain. Plain fetches, so it works on public pages.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, CircleHelp, ExternalLink, Loader, RefreshCw, X } from 'lucide-react';
import { kido } from '@/lib/kido/api';
import type { EnsLive, IdentityLive, VerifyResult } from '@/lib/kido/types';

const etherscan = (x: string) => `https://sepolia.etherscan.io/${x.length === 66 ? 'tx' : 'address'}/${x}`;
const suiscan = (x: string) => `https://suiscan.xyz/testnet/object/${x}`;
const short = (x: string) => `${x.slice(0, 8)}…${x.slice(-6)}`;

export function VerifyPanel({ name, auto = true }: { name: string; auto?: boolean }) {
  const [r, setR] = useState<{ loading: boolean; data?: VerifyResult; error?: string }>({ loading: false });
  const run = useCallback(() => {
    setR({ loading: true });
    kido.verify(name).then((data) => setR({ loading: false, data })).catch((e: Error) => setR({ loading: false, error: e.message }));
  }, [name]);
  useEffect(() => {
    if (auto) run();
  }, [auto, run]);
  return (
    <div className="ens-card">
      <div className="ens-card__head">
        <div>
          <div className="ens-card__title">Verify {name}</div>
          <p className="ens-meta">From the ENS name alone: its records, then each account it resolves to, read on its own chain.</p>
        </div>
        <button type="button" className="cl-btn cl-btn-sm" onClick={run} disabled={r.loading}>{r.loading ? <Loader size={12} className="kc-spin" /> : <RefreshCw size={12} />} Verify</button>
      </div>
      {r.error ? <p className="ens-meta" style={{ color: 'var(--cl-deny)' }}>{r.error}</p> : null}
      {r.data ? (
        <>
          <div className="ens-verdict" data-ok={r.data.verified ? '' : undefined}>
            {r.data.verified ? <Check size={16} /> : <X size={16} />} {r.data.verified ? 'Verified: this name is the agent it claims to be' : 'Not verified'}
            <span className="ens-meta"> · {r.data.checks.filter((c) => c.ok).length}/{r.data.checks.length} checks</span>
          </div>
          <ul className="ens-checks">
            {r.data.checks.map((c) => (
              <li key={c.id} data-ok={c.ok === true ? '' : undefined} data-bad={c.ok === false ? '' : undefined}>
                <span className="ens-check__icon">{c.ok === true ? <Check size={12} /> : c.ok === false ? <X size={12} /> : <CircleHelp size={12} />}</span>
                <span className="ens-check__label">{c.label}</span>
                <span className="ens-mono ens-meta">{c.detail}</span>
              </li>
            ))}
          </ul>
          {r.data.specialists?.length ? (
            <div className="ens-chips">
              {r.data.specialists.map((s) => <span key={s.name} className="ens-chip"><span className="ens-mono">{s.name.split('.')[0]}.</span> {s.role}</span>)}
            </div>
          ) : null}
        </>
      ) : r.loading ? <p className="ens-meta">Reading ENSv2 and both chains…</p> : null}
    </div>
  );
}

export function LivePanel({ name }: { name: string }) {
  const [r, setR] = useState<{ loading: boolean; data?: EnsLive; error?: string }>({ loading: false });
  const run = useCallback(() => {
    setR((x) => ({ ...x, loading: true }));
    kido.ensLive(name).then((data) => setR({ loading: false, data })).catch((e: Error) => setR({ loading: false, error: e.message }));
  }, [name]);
  useEffect(() => run(), [run]);
  const rec = r.data?.records ?? {};
  const holdings = (() => {
    try {
      return JSON.parse(rec['kido.holdings'] ?? '{}') as Record<string, Record<string, number>>;
    } catch {
      return {};
    }
  })();
  const status = rec['kido.status'];
  return (
    <div className="ens-card ens-live">
      <div className="ens-card__head">
        <div>
          <div className="ens-card__title"><span className="ens-pulse" data-status={status} /> {name}</div>
          <p className="ens-meta">Resolved through ENSv2 like any ENS client: the resolver defers to Kido&apos;s gateway (CCIP-read, ERC-3668) and checks the gateway&apos;s signature on-chain before answering.</p>
        </div>
        <button type="button" className="cl-btn cl-btn-sm" onClick={run} disabled={r.loading}>{r.loading ? <Loader size={12} className="kc-spin" /> : <RefreshCw size={12} />} Resolve</button>
      </div>
      {r.error ? <p className="ens-meta" style={{ color: 'var(--cl-deny)' }}>{r.error}</p> : null}
      {r.data ? (
        <>
          <div className="ens-kpis">
            <div><span className="ens-label">kido.status</span><span className="ens-kpi" data-status={status}>{status || '—'}</span></div>
            <div><span className="ens-label">kido.health-factor</span><span className="ens-kpi">{rec['kido.health-factor'] || '—'}</span></div>
            <div><span className="ens-label">kido.lease-expires</span><span className="ens-kpi ens-kpi--sm">{rec['kido.lease-expires'] ? new Date(rec['kido.lease-expires']).toLocaleString() : '—'}</span></div>
          </div>
          <div className="ens-label">kido.holdings</div>
          <div className="ens-chips">
            {Object.entries(holdings).flatMap(([chain, h]) => Object.entries(h).map(([sym, v]) => <span key={chain + sym} className="ens-chip">{v.toLocaleString(undefined, { maximumFractionDigits: 2 })} {sym} <span className="ens-meta">· {chain}</span></span>))}
          </div>
          <div className="ens-addrs">
            {r.data.address ? <a href={etherscan(r.data.address)} target="_blank" rel="noreferrer">addr(60) {short(r.data.address)} <ExternalLink size={10} /></a> : null}
            {r.data.sui ? <a href={suiscan(r.data.sui)} target="_blank" rel="noreferrer">addr(784 · Sui) {short(r.data.sui)} <ExternalLink size={10} /></a> : null}
          </div>
          <p className="ens-meta">{r.data.via} · {r.data.ms} ms · updated {rec['kido.updated'] ? new Date(rec['kido.updated']).toLocaleTimeString() : '—'}</p>
        </>
      ) : r.loading ? <p className="ens-meta">Resolving through CCIP-read…</p> : null}
    </div>
  );
}

export function NameTree({ live }: { live: IdentityLive }) {
  const root = live.names.find((n) => !n.role);
  const kids = live.names.filter((n) => n.role);
  if (!root) return null;
  const Name = ({ n }: { n: IdentityLive['names'][number] }) => (
    <div className="ens-name" data-published={n.published ? '' : undefined}>
      <div className="ens-name__head">
        <span className="ens-mono ens-name__label">{n.name}</span>
        <span className="ens-chip" data-tone={n.published ? 'pass' : 'warn'}>{n.published ? 'on ENSv2' : 'planned'}</span>
      </div>
      {n.role ? <span className="ens-meta">{n.role}</span> : null}
      <div className="ens-addrs">
        {Object.entries(n.addresses).filter(([, v]) => v).map(([k, v]) => (
          <a key={k} href={k === 'sui' ? suiscan(v!) : etherscan(v!)} target="_blank" rel="noreferrer">{k === 'eth' ? 'ETH' : k === 'sui' ? 'Sui' : k.replace('evm:', 'chain ')} {short(v!)} <ExternalLink size={10} /></a>
        ))}
      </div>
      {n.receipt?.txs.length ? (
        <div className="ens-addrs">
          {n.receipt.txs.slice(-3).map((t) => <a key={t} href={etherscan(t)} target="_blank" rel="noreferrer">tx {short(t)} <ExternalLink size={10} /></a>)}
          {n.receipt.resolver ? <a href={etherscan(n.receipt.resolver)} target="_blank" rel="noreferrer">resolver {short(n.receipt.resolver)} <ExternalLink size={10} /></a> : null}
        </div>
      ) : null}
    </div>
  );
  return (
    <div className="ens-card">
      <div className="ens-card__head">
        <div>
          <div className="ens-card__title">Published on {live.network}</div>
          <p className="ens-meta">Each name has its own resolver; the agent&apos;s name has its own registry for its specialists. Every name resolves to the agent&apos;s accounts on both chains (ENSIP-9/11 coin types).</p>
        </div>
      </div>
      <Name n={root} />
      <div className="ens-tree">{kids.map((k) => <Name key={k.name} n={k} />)}</div>
    </div>
  );
}

export function useIdentityLive(projectId: string) {
  const [r, setR] = useState<{ loading: boolean; data?: IdentityLive; error?: string }>({ loading: true });
  useEffect(() => {
    kido.identityLive(projectId).then((data) => setR({ loading: false, data })).catch((e: Error) => setR({ loading: false, error: e.message }));
  }, [projectId]);
  return r;
}
