'use client';

/**
 * Projects home: every Kido project on this backend, newest first, with its lifecycle stage.
 * Opening a project lands where it needs attention: the Composer until it is built, the Overview
 * after. Duplicating starts a new project from the same objective (a fresh interview; nothing
 * signed or deployed is ever copied).
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, FolderOpen, Plus, RefreshCw, Search } from 'lucide-react';
import { Badge, BlockerBanner, StatusBadge, TimeAgo } from '@/components/studio/primitives';
import { WalletChip } from '@/components/studio/wallet/WalletChip';
import { PROJECT_TEMPLATES } from '@/lib/studio/content/templates';
import { useProjects } from '@/lib/kido/hooks';
import { kido } from '@/lib/kido/api';
import { chainLabel, STAGE_LABEL } from '@/lib/kido/format';
import type { ProjectRow } from '@/lib/kido/types';

const entryFor = (p: ProjectRow) => `/projects/${p.projectId}/${p.stage === 'BUILT' ? 'overview' : 'build'}`;

export default function ProjectsHome() {
  const router = useRouter();
  const list = useProjects();
  const [query, setQuery] = useState('');
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = list.data ?? [];
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.objective.toLowerCase().includes(q)) : rows;
  }, [query, list.data]);

  const duplicate = async (p: ProjectRow) => {
    setError(null);
    setDuplicating(p.projectId);
    try {
      const r = await kido.create(p.objective, `${p.name} (copy)`);
      router.push(`/projects/${r.projectId}/build`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDuplicating(null);
    }
  };

  return (
    <div className="cl-studio cl-dark" style={{ minHeight: '100vh', background: 'var(--cl-canvas)' }}>
      <header className="cl-row cl-chrome-bar" style={{ height: 56, padding: '0 22px', borderBottom: '1px solid var(--cl-line-chrome)', gap: 14 }}>
        <a href="/" className="cl-studio-mark" style={{ fontFamily: 'var(--serif)', fontSize: 18, letterSpacing: '-0.3px' }} title="Back to the landing page">
          Kido
        </a>
        <span className="cl-env-badge" title="Every project runs on testnets only.">
          <span>TESTNET</span>
        </span>
        <span className="cl-spacer" />
        <WalletChip />
        <div className="cl-cmd-field" style={{ width: 300 }}>
          <Search size={14} aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects" aria-label="Search projects" />
        </div>
        <button type="button" className="cl-btn cl-btn-invert" onClick={() => router.push('/new')}>
          <Plus size={13} aria-hidden />
          New Agent
        </button>
      </header>

      <main style={{ maxWidth: 1320, margin: '0 auto', padding: '30px 24px 64px' }}>
        <div className="cl-row" style={{ alignItems: 'flex-end', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--serif)', fontSize: 30, letterSpacing: '-0.6px', lineHeight: 1.15 }}>Your agents</h1>
            <p className="cl-page-sub" style={{ marginTop: 6 }}>Each agent has a blueprint, a security review, a simulation and, once deployed, Amane accounts whose limits your wallet signs.</p>
          </div>
          <span className="cl-spacer" />
          <button type="button" className="cl-btn" onClick={() => void list.refetch()} title="Re-read the project list">
            <RefreshCw size={13} aria-hidden />
            Refresh
          </button>
        </div>

        {list.isError ? (
          <BlockerBanner tone="deny" title="The Kido API is not reachable">
            {(list.error as Error).message}. Start it with <span className="cl-mono">npm run kido:api</span> in Backend/Kido and refresh.
          </BlockerBanner>
        ) : null}
        {error ? <BlockerBanner tone="deny" title="Could not duplicate">{error}</BlockerBanner> : null}
        {list.isLoading ? (
          <div className="cl-card"><div className="cl-card-body"><span className="cl-meta">Loading projects…</span></div></div>
        ) : null}

        {!list.isLoading && !list.isError && visible.length === 0 ? (
          <div className="cl-card">
            <div className="cl-card-body">
              <div className="cl-strong">{query ? 'No matching projects' : 'No agents yet'}</div>
              <p className="cl-meta" style={{ whiteSpace: 'normal', marginTop: 6 }}>Describe an agent to create the first one. Kido asks about anything that matters and never invents authority you did not give.</p>
              <button type="button" className="cl-btn cl-btn-primary" style={{ marginTop: 12 }} onClick={() => router.push('/new')}>
                <Plus size={13} aria-hidden />
                New Agent
              </button>
            </div>
          </div>
        ) : null}

        {visible.length ? (
          <section className="cl-section">
            <div className="cl-section-head">
              <span className="cl-label">Agents</span>
              <span className="cl-section-rule" />
              <span className="cl-meta">{visible.length} project{visible.length === 1 ? '' : 's'}</span>
            </div>
            <div className="cl-card">
              <div className="cl-table-scroll">
                <table className="cl-table" style={{ minWidth: 900 }}>
                  <thead>
                    <tr>
                      <th style={{ minWidth: 260 }}>Project</th>
                      <th style={{ width: 110 }}>Stage</th>
                      <th style={{ width: 86 }}>Revision</th>
                      <th style={{ width: 220 }}>Chains</th>
                      <th style={{ width: 100 }}>Created</th>
                      <th style={{ width: 200 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((p) => (
                      <tr key={p.projectId} data-clickable="true" onClick={() => router.push(entryFor(p))}>
                        <td>
                          <div className="cl-strong">{p.name}</div>
                          <div className="cl-meta" style={{ whiteSpace: 'normal', maxWidth: 420 }}>{p.objective.length > 160 ? `${p.objective.slice(0, 160)}…` : p.objective}</div>
                        </td>
                        <td><StatusBadge status={p.stage === 'BUILT' ? 'READY' : 'RUNNING'} label={STAGE_LABEL[p.stage]} /></td>
                        <td className="cl-mono">{p.revision === null ? '—' : `r${p.revision}`}</td>
                        <td>{p.chains.length ? p.chains.map((c) => <Badge key={c} tone="sim">{chainLabel(c)}</Badge>) : <span className="cl-meta">—</span>}</td>
                        <td className="cl-meta"><TimeAgo iso={new Date(p.createdAt).toISOString()} /></td>
                        <td>
                          <div className="cl-row" style={{ justifyContent: 'flex-end', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                            <button type="button" className="cl-btn cl-btn-sm" onClick={() => router.push(entryFor(p))}>
                              <FolderOpen size={12} aria-hidden />
                              Open
                            </button>
                            <button type="button" className="cl-btn cl-btn-sm" title="Starts a new project from the same objective. Nothing signed or deployed is copied." disabled={duplicating === p.projectId} onClick={() => void duplicate(p)}>
                              <Copy size={12} aria-hidden />
                              {duplicating === p.projectId ? 'Copying…' : 'Duplicate'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        ) : null}

        <section className="cl-section">
          <div className="cl-section-head">
            <span className="cl-label">Templates</span>
            <span className="cl-section-rule" />
          </div>
          <div className="cl-grid cl-grid-auto">
            {PROJECT_TEMPLATES.map((t) => (
              <button key={t.id} type="button" className="cl-card" style={{ textAlign: 'left', cursor: 'pointer', padding: 0 }} onClick={() => router.push(`/new?template=${encodeURIComponent(t.id)}`)}>
                <div className="cl-card-body">
                  <div className="cl-strong" style={{ fontSize: 13 }}>{t.name}</div>
                  <p className="cl-meta" style={{ margin: '6px 0 10px', whiteSpace: 'normal' }}>{t.description}</p>
                  <div className="cl-row cl-row-wrap" style={{ gap: 5 }}>
                    {t.protocols.length === 0 ? <Badge tone="neutral">No preset authority</Badge> : t.protocols.map((x) => <Badge key={x} tone="neutral">{x}</Badge>)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
