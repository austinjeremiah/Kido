'use client';

/**
 * Portfolio & runtime: where the agent's money is, read live from the chains. Every Amane account's
 * holdings (with funds reserved for a cross-chain arrival or quarantined for owner recovery), the
 * owner's wallet, the lending position the agent protects, how much of the lease budget is spent,
 * and the money movements the agents made. USD appears only where a price exists: Aave's oracle for
 * the position, and nominal 1:1 for USD-stable test tokens (labelled); other tokens show units.
 * The owner's pause / revoke controls stay at the bottom.
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, Landmark, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, Card, EmptyState, Section, Skeleton, TimeAgo } from '@/components/studio/primitives';
import { WithProject } from '@/components/studio/kido';
import { useOwnerWallet } from '@/components/studio/kido-wallet';
import { useWalletSession } from '@/lib/studio/wallet-session';
import { kido } from '@/lib/kido/api';
import { keys, useActivity, usePortfolio, useRuntime } from '@/lib/kido/hooks';
import { LEASE_STATUS, chainLabel, explorerAccount, explorerTx } from '@/lib/kido/format';
import type { Holding, LendingPosition, Portfolio, ProjectEvent, ProjectSummary } from '@/lib/kido/types';

const units = (amount: string, decimals: number) => Number(amount) / 10 ** decimals;
const fmt = (n: number, max = 2) => n.toLocaleString(undefined, { maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 4 : max });
const usd = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** Stable colour per asset symbol, from the theme's tones. */
const TONES = ['var(--cl-data)', 'var(--cl-pass)', 'var(--cl-sim)', 'var(--cl-warn)', 'var(--cl-brand)', 'var(--cl-accent)', 'var(--cl-ink-2)'];
const toneOf = (() => {
  const seen = new Map<string, string>();
  return (sym: string) => seen.get(sym) ?? (seen.set(sym, TONES[seen.size % TONES.length]!), seen.get(sym)!);
})();

export default function RuntimePage() {
  const { activated, requestConnect } = useWalletSession();
  return (
    <StudioPage segment="runtime">
      <WithProject>{(s) => <Body s={s} activated={activated} requestConnect={requestConnect} />}</WithProject>
    </StudioPage>
  );
}

function Body({ s, activated, requestConnect }: { s: ProjectSummary; activated: boolean; requestConnect: () => void }) {
  const pf = usePortfolio(s.projectId);
  const rt = useRuntime(s.projectId);
  const act = useActivity(s.projectId);
  if (pf.isLoading) return <Skeleton height={220} />;
  if (pf.isError) return <EmptyState title="Portfolio unavailable" body={(pf.error as Error).message} />;
  const p = pf.data!;
  if (!p.deployed) return <EmptyState title="Not deployed" body="Deploy the built agent to create its Amane accounts; its holdings and positions appear here." />;

  return (
    <div className="cl-stack pf" style={{ gap: 4 }}>
      <Hero p={p} onRefresh={() => { void pf.refetch(); void rt.refetch(); }} refreshing={pf.isFetching} />
      <Section label="Where your money is" actions={<span className="cl-meta">read live · <TimeAgo iso={new Date(p.readAt).toISOString()} /></span>}>
        <div className="pf-grid">
          {p.chains.map((c) => (
            <Place
              key={c.chain}
              icon={<ShieldCheck size={15} aria-hidden />}
              title={`Agent account · ${chainLabel(c.chain)}`}
              sub="Amane account: only the lease can move it, within the owner policy"
              href={explorerAccount(c.chain, c.account)}
              addr={c.account}
              holdings={c.holdings}
              error={c.error}
              status={rt.data?.chains.find((x) => x.chain === c.chain)}
            />
          ))}
          {p.owner ? (
            <Place icon={<Wallet size={15} aria-hidden />} title={`Owner wallet · ${chainLabel(p.owner.chain)}`} sub="Your own wallet; the agent has no authority over it" href={explorerAccount(p.owner.chain, p.owner.address)} addr={p.owner.address} holdings={p.owner.holdings} native={p.owner.native} />
          ) : null}
        </div>
      </Section>
      {p.positions.length ? (
        <Section label="Positions" actions={<span className="cl-meta">lending positions the agent protects</span>}>
          <div className="pf-grid">{p.positions.map((x) => <Position key={`${x.protocol}:${x.address}`} x={x} />)}</div>
        </Section>
      ) : null}
      <Section label="Allocation" actions={<span className="cl-meta">USD-stable test tokens at nominal $1 · others in units</span>}>
        <Allocation p={p} />
      </Section>
      <Section label="Lease budget" actions={<span className="cl-meta">what the agent key has spent of what the owner allowed</span>}>
        <Budget p={p} s={s} />
      </Section>
      <Section label="Money movements" actions={<span className="cl-meta">every fund, payment, swap, repay and bridge</span>}>
        <Movements events={act.data ?? []} />
      </Section>
      <Section label="Owner controls">
        {activated ? <Controls id={s.projectId} /> : (
          <Card title="Owner controls">
            <button type="button" className="cl-btn cl-btn-primary" onClick={requestConnect}>Connect the owner wallet</button>
          </Card>
        )}
      </Section>
    </div>
  );
}

/** Totals: agent accounts (nominal USD-stable), the protected position's net value, health, lease. */
function Hero({ p, onRefresh, refreshing }: { p: Portfolio; onRefresh: () => void; refreshing: boolean }) {
  const agentUsd = p.chains.flatMap((c) => c.holdings).reduce((n, h) => n + (h.usdNominal ?? 0), 0);
  const other = aggregate(p.chains.flatMap((c) => c.holdings)).filter((h) => h.usd === null && h.amount > 0);
  const pos = p.positions.find((x) => x.healthFactor !== undefined);
  const net = pos?.collateralUsd !== undefined && pos.debtUsd !== undefined ? pos.collateralUsd - pos.debtUsd : null;
  const leaseLeft = p.leaseExpiresAt ? p.leaseExpiresAt - Date.now() : null;
  return (
    <>
    <div className="cl-row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
      <button type="button" className="cl-btn cl-btn-sm" onClick={onRefresh} disabled={refreshing} title="Re-read every chain">
        <RefreshCw size={12} aria-hidden /> {refreshing ? 'Reading…' : 'Refresh'}
      </button>
    </div>
    <div className="pf-hero">
      <div className="pf-hero-main">
        <span className="cl-label">In the agent&apos;s accounts</span>
        <span className="pf-big">{usd(agentUsd)}</span>
        <span className="cl-meta">
          across {p.chains.length} chain{p.chains.length === 1 ? '' : 's'} (USD-stable, nominal)
          {other.length ? ` + ${other.map((h) => `${fmt(h.amount)} ${h.symbol}`).join(' + ')}` : ''}
        </span>
      </div>
      {net !== null ? (
        <div className="pf-hero-cell">
          <span className="cl-label">Protected position, net</span>
          <span className="pf-mid">{usd(net)}</span>
          <span className="cl-meta">{usd(pos!.collateralUsd!)} collateral − {usd(pos!.debtUsd!)} debt</span>
        </div>
      ) : null}
      {pos?.healthFactor !== undefined ? (
        <div className="pf-hero-cell">
          <span className="cl-label">Health factor</span>
          <span className="pf-mid" style={{ color: hfTone(pos.healthFactor ?? Infinity) }}>{pos.healthFactor === null ? '∞' : pos.healthFactor.toFixed(3)}</span>
          <span className="cl-meta">liquidation below 1.000</span>
        </div>
      ) : null}
      <div className="pf-hero-cell">
        <span className="cl-label">Agent lease</span>
        <span className="pf-mid">{p.status === 'ACTIVE' && leaseLeft !== null ? (leaseLeft > 0 ? `${Math.floor(leaseLeft / 60000)} min` : 'expired') : (p.status ?? '—')}</span>
        <span className="cl-meta">{leaseLeft !== null && leaseLeft > 0 ? 'left before the agent key stops' : 'the agent cannot act until a new lease'}</span>
      </div>
    </div>
    </>
  );
}

const hfTone = (hf: number) => (hf < 1.1 ? 'var(--cl-deny)' : hf < 1.5 ? 'var(--cl-warn)' : 'var(--cl-pass)');

function aggregate(hs: Holding[]) {
  const m = new Map<string, { symbol: string; amount: number; usd: number | null }>();
  for (const h of hs) {
    const cur = m.get(h.symbol) ?? { symbol: h.symbol, amount: 0, usd: h.usdNominal === null ? null : 0 };
    cur.amount += units(h.amount, h.decimals);
    if (cur.usd !== null && h.usdNominal !== null) cur.usd += h.usdNominal;
    m.set(h.symbol, cur);
  }
  return [...m.values()];
}

function Place({ icon, title, sub, href, addr, holdings, native, error, status }: { icon: React.ReactNode; title: string; sub: string; href: string; addr: string; holdings: Holding[]; native?: { symbol: string; amount: string; decimals: number } | null; error?: string | null; status?: { paused: boolean | null; leaseStatus: number | null; policyVersion: number | null } }) {
  const rows = holdings.filter((h) => h.amount !== '0' || h.reserved !== '0' || h.quarantined !== '0');
  const total = rows.reduce((n, h) => n + (h.usdNominal ?? 0), 0);
  const max = Math.max(1, ...rows.map((h) => h.usdNominal ?? units(h.amount, h.decimals)));
  return (
    <div className="pf-place">
      <div className="pf-place-head">
        <span className="pf-place-icon">{icon}</span>
        <div style={{ minWidth: 0 }}>
          <div className="cl-strong">{title}</div>
          <div className="cl-meta" style={{ whiteSpace: 'normal' }}>{sub}</div>
        </div>
        <span className="cl-spacer" />
        {status ? (status.paused ? <Badge tone="warn">paused</Badge> : <Badge tone={status.leaseStatus === 1 ? 'pass' : 'blocked'}>{status.leaseStatus === 1 ? 'lease active' : `lease ${LEASE_STATUS[status.leaseStatus ?? 0] ?? '—'}`}</Badge>) : null}
      </div>
      <a className="cl-mono pf-addr" href={href} target="_blank" rel="noreferrer">{short(addr)} ↗</a>
      {error ? <p className="cl-meta" style={{ color: 'var(--cl-deny)' }}>Could not read: {error}</p> : null}
      <div className="pf-place-total">
        <span className="pf-mid">{usd(total)}</span>
        <span className="cl-meta">USD-stable, nominal{status?.policyVersion ? ` · policy v${status.policyVersion}` : ''}</span>
      </div>
      <div className="pf-rows">
        {native ? (
          <div className="pf-row">
            <span className="pf-sym"><span className="pf-dot" style={{ background: 'var(--cl-ink-3)' }} />{native.symbol}</span>
            <span className="pf-bar"><span style={{ width: '0%' }} /></span>
            <span className="cl-num">{fmt(units(native.amount, native.decimals), 4)}</span>
            <span className="cl-meta pf-usd">gas</span>
          </div>
        ) : null}
        {rows.length ? rows.map((h) => {
          const v = h.usdNominal ?? units(h.amount, h.decimals);
          return (
            <div key={h.symbol} className="pf-row">
              <span className="pf-sym"><span className="pf-dot" style={{ background: toneOf(h.symbol) }} />{h.symbol}</span>
              <span className="pf-bar"><span style={{ width: `${Math.max(2, (v / max) * 100)}%`, background: toneOf(h.symbol) }} /></span>
              <span className="cl-num">{fmt(units(h.amount, h.decimals))}</span>
              <span className="cl-meta pf-usd">{h.usdNominal !== null ? usd(h.usdNominal) : 'units'}</span>
              {h.reserved !== '0' ? <Badge tone="data">{fmt(units(h.reserved, h.decimals))} reserved for an arrival</Badge> : null}
              {h.quarantined !== '0' ? <Badge tone="warn">{fmt(units(h.quarantined, h.decimals))} quarantined</Badge> : null}
            </div>
          );
        }) : <span className="cl-meta">Empty.</span>}
      </div>
    </div>
  );
}

function Position({ x }: { x: LendingPosition }) {
  if (x.error) return <BlockerBanner tone="warn" title={`${x.protocol} position unreadable`}>{x.error}</BlockerBanner>;
  const c = x.collateralUsd ?? 0, d = x.debtUsd ?? 0, hf = x.healthFactor ?? Infinity;
  const borrowLimit = (c * (x.liquidationThresholdPct ?? 0)) / 100;
  const scale = (v: number) => Math.min(100, Math.max(0, ((v - 0.8) / (2.5 - 0.8)) * 100));
  return (
    <div className="pf-place">
      <div className="pf-place-head">
        <span className="pf-place-icon"><Landmark size={15} aria-hidden /></span>
        <div style={{ minWidth: 0 }}>
          <div className="cl-strong">Aave v3 · {chainLabel(x.chain)}</div>
          <div className="cl-meta" style={{ whiteSpace: 'normal' }}>{x.label} — the RepayDebtAgent repays {x.debtAsset} debt here, and only here</div>
        </div>
        <span className="cl-spacer" />
        <Badge tone={hf < 1.5 ? 'warn' : 'pass'}>HF {Number.isFinite(hf) ? hf.toFixed(3) : '∞'}</Badge>
      </div>
      <a className="cl-mono pf-addr" href={explorerAccount(x.chain, x.address)} target="_blank" rel="noreferrer">{short(x.address)} ↗</a>
      <div className="pf-kv">
        <div><span className="cl-label">Collateral</span><span className="pf-mid">{usd(c)}</span></div>
        <div><span className="cl-label">Debt</span><span className="pf-mid" style={{ color: 'var(--cl-warn)' }}>{usd(d)}</span></div>
        <div><span className="cl-label">Liquidates at</span><span className="pf-mid">{usd(borrowLimit)}</span><span className="cl-meta">debt ({x.liquidationThresholdPct}% of collateral)</span></div>
      </div>
      <div className="cl-label" style={{ marginTop: 10 }}>Debt vs liquidation limit</div>
      <div className="pf-stack"><span style={{ width: `${Math.min(100, (d / Math.max(borrowLimit, 1)) * 100)}%`, background: 'var(--cl-warn)' }} /></div>
      <div className="cl-meta">{fmt((d / Math.max(borrowLimit, 1)) * 100, 1)}% of the limit used</div>
      <div className="cl-label" style={{ marginTop: 10 }}>Health factor</div>
      <div className="pf-gauge">
        <span className="pf-gauge-fill" style={{ width: `${scale(hf)}%`, background: hfTone(hf) }} />
        <span className="pf-gauge-mark" style={{ left: `${scale(1)}%` }} title="liquidation" />
      </div>
      <div className="pf-gauge-scale cl-meta"><span>0.8</span><span>1.0 liquidation</span><span>2.5+</span></div>
      {x.monitor ? (
        <p className="cl-meta" style={{ whiteSpace: 'normal', marginBottom: 0 }}>
          Monitor <span className="cl-mono">{x.monitor.id}</span>: repays when {x.monitor.metric.replace('_', ' ').toLowerCase()} {x.monitor.op === 'LT' ? 'drops below' : 'crosses'} {x.monitor.private ? 'your private threshold (never stored in plaintext or shown here)' : x.monitor.threshold}.
        </p>
      ) : null}
    </div>
  );
}

function Allocation({ p }: { p: Portfolio }) {
  const parts = p.chains.flatMap((c) => c.holdings.filter((h) => h.usdNominal).map((h) => ({ key: `${c.chain}:${h.symbol}`, label: `${h.symbol} · ${chainLabel(c.chain)}`, v: h.usdNominal!, tone: toneOf(h.symbol) })));
  const unitParts = p.chains.flatMap((c) => c.holdings.filter((h) => h.usdNominal === null && h.amount !== '0').map((h) => ({ key: `${c.chain}:${h.symbol}`, label: `${h.symbol} · ${chainLabel(c.chain)}`, amount: units(h.amount, h.decimals) })));
  const total = parts.reduce((n, x) => n + x.v, 0);
  const byChain = p.chains.map((c) => ({ chain: c.chain, v: c.holdings.reduce((n, h) => n + (h.usdNominal ?? 0), 0) }));
  if (!total && !unitParts.length) return <p className="cl-meta">Nothing held yet.</p>;
  return (
    <div className="cl-card">
      <div className="cl-card-body cl-stack" style={{ gap: 12 }}>
        <div className="pf-stack pf-stack-lg">
          {parts.map((x) => <span key={x.key} title={`${x.label}: ${usd(x.v)}`} style={{ width: `${(x.v / total) * 100}%`, background: x.tone }} />)}
        </div>
        <div className="pf-legend">
          {parts.map((x) => (
            <span key={x.key}><span className="pf-dot" style={{ background: x.tone }} />{x.label} <span className="cl-num">{usd(x.v)}</span> <span className="cl-meta">{fmt((x.v / total) * 100, 1)}%</span></span>
          ))}
          {unitParts.map((x) => <span key={x.key}><span className="pf-dot" style={{ background: toneOf(x.label.split(' ')[0]!) }} />{x.label} <span className="cl-num">{fmt(x.amount)}</span> <span className="cl-meta">units</span></span>)}
        </div>
        <div className="pf-legend">
          {byChain.map((c) => <span key={c.chain}><strong>{chainLabel(c.chain)}</strong> <span className="cl-num">{usd(c.v)}</span> <span className="cl-meta">{total ? fmt((c.v / total) * 100, 1) : 0}%</span></span>)}
        </div>
      </div>
    </div>
  );
}

function Budget({ p, s }: { p: Portfolio; s: ProjectSummary }) {
  const rows = p.chains.flatMap((c) => c.budget.map((b) => ({ chain: c.chain, ...b })));
  const unreported = p.chains.filter((c) => !c.budget.length).map((c) => c.chain);
  return (
    <div className="cl-card">
      <div className="cl-card-body cl-stack" style={{ gap: 10 }}>
        {rows.map((b) => {
          const spent = units(b.spent, b.decimals), total = units(b.total, b.decimals);
          const pct = total ? (spent / total) * 100 : 0;
          return (
            <div key={`${b.chain}:${b.symbol}`} className="pf-budget">
              <span className="pf-sym"><span className="pf-dot" style={{ background: toneOf(b.symbol) }} />{b.symbol} <span className="cl-meta">· {chainLabel(b.chain)}</span></span>
              <span className="pf-bar"><span style={{ width: `${Math.max(pct ? 1 : 0, pct)}%`, background: pct > 80 ? 'var(--cl-deny)' : toneOf(b.symbol) }} /></span>
              <span className="cl-num">{fmt(spent)} / {fmt(total)}</span>
              <span className="cl-meta">max {fmt(units(b.perAction, b.decimals))} per action</span>
            </div>
          );
        })}
        {unreported.length ? (
          <p className="cl-meta" style={{ margin: 0, whiteSpace: 'normal' }}>
            {unreported.map(chainLabel).join(', ')}: the account enforces the same per-action, per-window and total caps on-chain ({s.blueprint?.authority.limits.filter((l) => unreported.includes(l.chain)).map((l) => `${l.asset} ${fmt(Number(l.total) / 10 ** (s.blueprint?.assets.find((a) => a.chain === l.chain && a.symbol === l.asset)?.decimals as number ?? 0))} total`).join(', ')}) but does not expose spend counters to read.
          </p>
        ) : null}
        <p className="cl-meta" style={{ margin: 0 }}>A bridged arrival is spent from its on-chain reservation, not from the lease budget.</p>
      </div>
    </div>
  );
}

const MOVE_TYPES: Record<string, { icon: React.ReactNode; tone: 'pass' | 'warn' | 'deny' | 'data' | 'sim' }> = {
  fund: { icon: <ArrowDownRight size={13} aria-hidden />, tone: 'data' },
  'action.executed': { icon: <ArrowUpRight size={13} aria-hidden />, tone: 'pass' },
  'action.refused': { icon: <ShieldCheck size={13} aria-hidden />, tone: 'warn' },
  'action.error': { icon: <ShieldCheck size={13} aria-hidden />, tone: 'deny' },
  'bridge.started': { icon: <ArrowLeftRight size={13} aria-hidden />, tone: 'sim' },
  'bridge.source': { icon: <ArrowLeftRight size={13} aria-hidden />, tone: 'sim' },
  'bridge.complete': { icon: <ArrowLeftRight size={13} aria-hidden />, tone: 'pass' },
  'bridge.failed': { icon: <ArrowLeftRight size={13} aria-hidden />, tone: 'deny' },
};

function Movements({ events }: { events: ProjectEvent[] }) {
  const [chain, setChain] = useState<string>('all');
  const moves = useMemo(() => events.filter((e) => MOVE_TYPES[e.type]).filter((e) => chain === 'all' || e.chain === chain).slice().reverse(), [events, chain]);
  const chains = [...new Set(events.filter((e) => MOVE_TYPES[e.type] && e.chain).map((e) => e.chain!))];
  if (!events.some((e) => MOVE_TYPES[e.type])) return <p className="cl-meta">No money has moved yet.</p>;
  return (
    <div className="cl-card">
      <div className="cl-card-body">
        <div className="cl-row" style={{ gap: 6, marginBottom: 10 }}>
          {['all', ...chains].map((c) => <button key={c} type="button" className={`cl-btn cl-btn-sm${chain === c ? ' cl-btn-invert' : ''}`} onClick={() => setChain(c)}>{c === 'all' ? 'All chains' : chainLabel(c)}</button>)}
        </div>
        <ol className="pf-moves">
          {moves.map((e) => {
            const t = MOVE_TYPES[e.type]!;
            const [who, what] = e.detail.includes(' · ') ? [e.detail.split(' · ')[0], e.detail.split(' · ').slice(1).join(' · ')] : [null, e.detail];
            return (
              <li key={`${e.at}:${e.detail}`}>
                <span className="pf-move-icon" data-tone={t.tone}>{t.icon}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="cl-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {who ? <Badge tone="neutral">{who}</Badge> : null}
                    <span className="cl-body" style={{ whiteSpace: 'normal' }}>{what}</span>
                  </div>
                  <div className="cl-meta">
                    {e.chain ? `${chainLabel(e.chain)} · ` : ''}<TimeAgo iso={new Date(e.at).toISOString()} />
                    {e.tx && e.chain ? <> · <a href={explorerTx(e.chain, e.tx)} target="_blank" rel="noreferrer" className="cl-mono">{e.tx.slice(0, 10)}… ↗</a></> : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function Controls({ id }: { id: string }) {
  const qc = useQueryClient();
  const w = useOwnerWallet();
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (op: 'pause' | 'revoke') => {
    setMsg(null);
    try {
      const prep = await kido.controlPrepare(id, op);
      const signed = [];
      for (const m of prep.messages) signed.push({ chain: m.chain, message: m.message, signature: await w.sign(m.typedData) });
      const r = await kido.controlSubmit(id, op, signed);
      if (r.transactions.length) await w.send(r.transactions, (tx, hash) => kido.recordTx(id, 'ethereum-sepolia', tx.label, hash).then(() => undefined));
      setMsg(op === 'pause' ? 'Paused.' : 'Lease revoked; the agent key can no longer act.');
    } catch (e) {
      setMsg((e as Error).message.split('\n')[0] ?? 'failed');
    } finally {
      void qc.invalidateQueries({ queryKey: keys.runtime(id) });
      void qc.invalidateQueries({ queryKey: keys.portfolio(id) });
      void qc.invalidateQueries({ queryKey: keys.activity(id) });
    }
  };
  return (
    <Card title="Owner controls">
      <div className="cl-row" style={{ gap: 8 }}>
        <button type="button" className="cl-btn" onClick={() => run('pause')} disabled={!w.ready}>Pause the agent</button>
        <button type="button" className="cl-btn" onClick={() => run('revoke')} disabled={!w.ready}>Revoke its lease</button>
      </div>
      {msg ? <p className="cl-meta">{msg}</p> : null}
      <p className="cl-meta">Pausing stops every action until the owner signs an unpause. Revoking the lease removes the agent key&apos;s authority for good; a new lease is needed to resume.</p>
    </Card>
  );
}
