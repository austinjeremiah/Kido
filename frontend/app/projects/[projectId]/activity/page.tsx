'use client';

/**
 * Activity: one timeline for the agent. Recorded events (deployment steps, owner controls and wallet
 * transactions, from GET /projects/:id/activity) are merged with lifecycle events read off the
 * project summary — creation, every interview turn, the blueprint revision and the security,
 * simulation and build runs. Filter by kind, chain and source, search, group by day, inspect one
 * event in the side panel, and export the filtered set as JSON or CSV.
 *
 * The backend records no time for interview turns or the blueprint compile; those rows say
 * "time not recorded" and are placed where they must have happened, never given a made-up time.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Download, ExternalLink, FileJson, Search, X } from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, CopyButton, EmptyState, KeyValue, Skeleton, useNow } from '@/components/studio/primitives';
import { WithProject, useKido } from '@/components/studio/kido';
import { useActivity } from '@/lib/kido/hooks';
import { chainLabel, explorerTx } from '@/lib/kido/format';
import type { ProjectSummary } from '@/lib/kido/types';
import { KIND_LABEL, download, relTime, timelineOf, type TimelineEvent, type TimelineKind, type TimelineSource } from '@/components/studio/operate/derive';

const SOURCE_LABEL: Record<TimelineSource, string> = { lifecycle: 'Lifecycle', 'on-chain': 'Deployment & on-chain' };

function dayKey(at: number) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayLabel(at: number, now: number) {
  const k = dayKey(at);
  if (now && k === dayKey(now)) return 'Today';
  if (now && k === dayKey(now - 86_400_000)) return 'Yesterday';
  return new Date(at).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
const absTime = (at: number) => new Date(at).toLocaleString();

function csvOf(events: TimelineEvent[]) {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['at_iso', 'time_recorded', 'source', 'kind', 'type', 'chain', 'title', 'detail', 'tx', 'explorer'];
  const rows = events.map((e) => [
    e.at !== null ? new Date(e.at).toISOString() : '', e.at !== null, e.source, e.kind, e.type, e.chain ?? '', e.title, e.detail, e.tx ?? '', e.tx && e.chain ? explorerTx(e.chain, e.tx) : '',
  ]);
  return [head, ...rows].map((r) => r.map(esc).join(',')).join('\n');
}

function TxLink({ chain, tx }: { chain: string; tx: string }) {
  return (
    <a className="cl-link cl-mono" href={explorerTx(chain, tx)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
      {tx.slice(0, 10)}…{tx.slice(-6)} <ExternalLink size={11} aria-hidden />
    </a>
  );
}

function When({ e, now }: { e: TimelineEvent; now: number }) {
  if (e.at === null) return <span className="cl-meta" title="The backend does not record a time for this step">time not recorded</span>;
  return (
    <span title={absTime(e.at)}>
      <span className="cl-mono" style={{ fontSize: 12 }}>{new Date(e.at).toLocaleTimeString()}</span>
      {now ? <span className="cl-meta" style={{ display: 'block' }}>{relTime(e.at, now)}</span> : null}
    </span>
  );
}

function Timeline({ s }: { s: ProjectSummary }) {
  const q = useActivity(s.projectId);
  const now = useNow(30_000);
  const all = useMemo(() => timelineOf(s, q.data ?? []), [s, q.data]);

  const [source, setSource] = useState<TimelineSource | 'all'>('all');
  const [kind, setKind] = useState<TimelineKind | 'all'>('all');
  const [chain, setChain] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const kinds = useMemo(() => [...new Set(all.map((e) => e.kind))], [all]);
  const chains = useMemo(() => [...new Set([...s.chains, ...all.map((e) => e.chain).filter((c): c is string => Boolean(c))])], [all, s.chains]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter((e) => {
      if (source !== 'all' && e.source !== source) return false;
      if (kind !== 'all' && e.kind !== kind) return false;
      if (chain !== 'all' && e.chain !== chain) return false;
      if (!needle) return true;
      return [e.type, e.title, e.detail, e.tx ?? '', e.chain ?? ''].some((v) => v.toLowerCase().includes(needle));
    });
  }, [all, source, kind, chain, query]);

  const groups = useMemo(() => {
    if (!grouped) return [{ key: 'all', label: '', events: filtered }];
    const m = new Map<string, TimelineEvent[]>();
    for (const e of filtered) {
      const k = dayKey(e.sortAt);
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return [...m.entries()].map(([key, events]) => ({ key, label: dayLabel(events[0]!.sortAt, now), events }));
  }, [filtered, grouped, now]);

  const selected = all.find((e) => e.id === selectedId) ?? null;
  const counts = { lifecycle: all.filter((e) => e.source === 'lifecycle').length, onchain: all.filter((e) => e.source === 'on-chain').length, tx: all.filter((e) => e.tx).length };
  const stamp = `${s.projectId}-${new Date().toISOString().slice(0, 10)}`;
  const filtersOn = source !== 'all' || kind !== 'all' || chain !== 'all' || query.trim() !== '';

  return (
    <>
      <div style={{ flex: '0 0 auto', padding: '14px 16px 12px', borderBottom: '1px solid var(--cl-line)' }}>
        <div className="cl-row cl-row-wrap" style={{ gap: 8, marginBottom: 10 }}>
          <span className="cl-page-title" style={{ fontSize: 22, marginRight: 8 }}>Activity</span>
          <Badge tone="neutral">{s.name}</Badge>
          <Badge tone="data">{filtered.length} of {all.length} events</Badge>
          <Badge tone="neutral">{counts.lifecycle} lifecycle</Badge>
          <Badge tone={counts.onchain ? 'pass' : 'neutral'}>{counts.onchain} recorded</Badge>
          <Badge tone="neutral">{counts.tx} transaction{counts.tx === 1 ? '' : 's'}</Badge>
          {q.isFetching ? <span className="cl-meta">refreshing…</span> : null}
          <span className="cl-spacer" />
          <button type="button" className="cl-btn cl-btn-sm" disabled={!filtered.length} onClick={() => download(`kido-activity-${stamp}.json`, JSON.stringify({ projectId: s.projectId, exportedAt: new Date().toISOString(), filters: { source, kind, chain, query }, events: filtered }, null, 2), 'application/json')}>
            <FileJson size={12} aria-hidden />Export JSON
          </button>
          <button type="button" className="cl-btn cl-btn-sm" disabled={!filtered.length} onClick={() => download(`kido-activity-${stamp}.csv`, csvOf(filtered), 'text/csv')}>
            <Download size={12} aria-hidden />Export CSV
          </button>
        </div>
        <div className="cl-row cl-row-wrap" style={{ gap: 6 }}>
          <select className="cl-select" style={{ width: 190 }} value={source} onChange={(e) => setSource(e.target.value as TimelineSource | 'all')} aria-label="Filter by source">
            <option value="all">All sources</option>
            {(Object.keys(SOURCE_LABEL) as TimelineSource[]).map((k) => <option key={k} value={k}>{SOURCE_LABEL[k]}</option>)}
          </select>
          <select className="cl-select" style={{ width: 170 }} value={kind} onChange={(e) => setKind(e.target.value as TimelineKind | 'all')} aria-label="Filter by type">
            <option value="all">All types</option>
            {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <select className="cl-select" style={{ width: 170 }} value={chain} onChange={(e) => setChain(e.target.value)} aria-label="Filter by chain">
            <option value="all">All chains</option>
            {chains.map((c) => <option key={c} value={c}>{chainLabel(c)}</option>)}
          </select>
          <span className="cl-row" style={{ gap: 4, position: 'relative' }}>
            <Search size={13} aria-hidden style={{ position: 'absolute', left: 9, opacity: 0.6 }} />
            <input className="cl-input" style={{ width: 260, paddingLeft: 28 }} placeholder="Type, detail, tx hash…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search events" />
          </span>
          <label className="cl-checkbox" style={{ marginLeft: 6 }}>
            <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> Group by day
          </label>
          {filtersOn ? (
            <button type="button" className="cl-btn cl-btn-ghost cl-btn-sm" onClick={() => { setSource('all'); setKind('all'); setChain('all'); setQuery(''); }}>
              Clear filters
            </button>
          ) : null}
        </div>
        {q.isError ? <p className="cl-meta" style={{ marginTop: 8, color: 'var(--cl-deny)' }}>Recorded events could not be loaded: {(q.error as Error).message}. Lifecycle events are still shown.</p> : null}
      </div>

      <div className="cl-split">
        <div className="cl-split-main" data-lenis-prevent>
          {q.isLoading ? (
            <div style={{ padding: 16 }}><Skeleton height={120} /></div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 16 }}>
              <EmptyState title="No events match" body={all.length ? 'Nothing matches these filters. Clear them to see the whole timeline.' : 'Nothing has happened on this project yet.'} />
            </div>
          ) : (
            <div className="cl-table-scroll">
              <table className="cl-table" style={{ minWidth: 720 }}>
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>When</th>
                    <th style={{ width: 150 }}>Type</th>
                    <th>Event</th>
                    <th style={{ width: 140 }}>Chain</th>
                    <th style={{ width: 170 }}>Transaction</th>
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.key}>
                    {grouped ? (
                      <tr>
                        <td colSpan={5} style={{ background: 'var(--cl-panel-2)' }}>
                          <span className="cl-label">{g.label}</span> <span className="cl-meta">· {g.events.length} event{g.events.length === 1 ? '' : 's'}</span>
                        </td>
                      </tr>
                    ) : null}
                    {g.events.map((e) => (
                      <tr key={e.id} data-clickable="true" data-selected={e.id === selectedId} onClick={() => setSelectedId(e.id === selectedId ? null : e.id)}>
                        <td><When e={e} now={now} /></td>
                        <td>
                          <Badge tone={e.tone}>{KIND_LABEL[e.kind]}</Badge>
                          <div className="cl-meta" style={{ marginTop: 3 }}>{e.source === 'lifecycle' ? 'lifecycle' : 'recorded'}</div>
                        </td>
                        <td>
                          <div className="cl-strong" style={{ fontSize: 13 }}>{e.title}</div>
                          <div className="cl-meta cl-truncate" style={{ maxWidth: 520 }}>{e.detail}</div>
                        </td>
                        <td>{e.chain ? chainLabel(e.chain) : <span className="cl-dim">—</span>}</td>
                        <td>{e.tx && e.chain ? <TxLink chain={e.chain} tx={e.tx} /> : <span className="cl-dim">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
          {!q.isLoading && counts.onchain === 0 ? (
            <p className="cl-meta" style={{ padding: '10px 16px' }}>
              No deployment steps or owner controls recorded yet. They appear here as they happen. <Link className="cl-link" href={`/projects/${s.projectId}/deploy`}>Open Deploy</Link>
            </p>
          ) : null}
        </div>

        {selected ? (
          <div className="cl-drawer" style={{ flex: '0 0 340px' }} data-lenis-prevent>
            <div className="cl-drawer-head">
              <span className="cl-label" style={{ flex: '1 1 auto' }}>Event detail</span>
              <button type="button" className="cl-btn cl-btn-ghost cl-btn-sm" onClick={() => setSelectedId(null)} aria-label="Close event detail"><X size={13} aria-hidden /></button>
            </div>
            <div className="cl-drawer-body">
              <div className="cl-h1" style={{ marginBottom: 6 }}>{selected.title}</div>
              <div className="cl-row cl-row-wrap" style={{ gap: 6, marginBottom: 12 }}>
                <Badge tone={selected.tone}>{KIND_LABEL[selected.kind]}</Badge>
                <Badge tone="neutral">{SOURCE_LABEL[selected.source]}</Badge>
              </div>
              <p className="cl-body" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: 14 }}>{selected.detail || '—'}</p>
              <KeyValue
                rows={[
                  { label: 'Type', value: selected.type, mono: true },
                  { label: 'Time', value: selected.at !== null ? `${absTime(selected.at)}${now ? ` (${relTime(selected.at, now)})` : ''}` : 'not recorded by the backend' },
                  ...(selected.at !== null ? [{ label: 'ISO', value: new Date(selected.at).toISOString(), mono: true }] : []),
                  { label: 'Chain', value: selected.chain ? chainLabel(selected.chain) : '—' },
                  ...(selected.tx ? [{ label: 'Transaction', value: <span style={{ wordBreak: 'break-all' }}>{selected.tx}</span>, mono: true }] : []),
                ]}
              />
              <div className="cl-col" style={{ gap: 6, marginTop: 16 }}>
                {selected.tx && selected.chain ? (
                  <a className="cl-btn cl-btn-block" href={explorerTx(selected.chain, selected.tx)} target="_blank" rel="noreferrer">
                    <ExternalLink size={12} aria-hidden />Open in explorer
                  </a>
                ) : null}
                {selected.tx ? <CopyButton value={selected.tx} label="Copy transaction hash" /> : null}
                {selected.segment ? (
                  <Link className="cl-btn cl-btn-block" href={`/projects/${s.projectId}/${selected.segment}`}>Open {KIND_LABEL[selected.kind]}</Link>
                ) : null}
                <button type="button" className="cl-btn cl-btn-block" onClick={() => download(`kido-event-${selected.id}.json`, JSON.stringify(selected, null, 2), 'application/json')}>
                  <FileJson size={12} aria-hidden />Export this event
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

export default function ActivityPage() {
  const { s } = useKido();
  return (
    <StudioPage segment="activity" bleed live>
      {s ? <Timeline s={s} /> : <div style={{ padding: 16 }}><WithProject>{() => null}</WithProject></div>}
    </StudioPage>
  );
}
