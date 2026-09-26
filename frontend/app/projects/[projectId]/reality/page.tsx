'use client';

/**
 * Reality Lab: what the live testnets say, not what the manifests claim.
 *
 *  - Chain heads: each chain's RPC is reached and its head read.
 *  - Contract probes: every Amane contract, adapter, asset and upstream protocol address in the
 *    deployment manifests is looked up on its chain (EVM: code at the address; Sui: the object).
 *  - Refusal probes: calls a stranger would make against this project's deployed account, simulated
 *    against the real contract; each must be refused.
 *  - Live runtime: the deployed account's policy version, pause state, lease and balances.
 *
 * Every read is a view call or a simulation. Nothing is signed or sent.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, Card, CopyButton, EmptyState, KeyValue, Section, Skeleton, StatusBadge, shortHash } from '@/components/studio/primitives';
import { WithProject } from '@/components/studio/kido';
import { Tile } from '@/components/studio/attack-lab/Catalogue';
import { useReality, useRuntime } from '@/lib/kido/hooks';
import { LEASE_STATUS, chainLabel, explorerAccount } from '@/lib/kido/format';
import type { ProjectSummary, RealityProbe } from '@/lib/kido/types';

function formatUnits(v: string, d: number) {
  if (!d || !/^\d+$/.test(v)) return v;
  const s = v.padStart(d + 1, '0');
  const frac = s.slice(-d).replace(/0+$/, '');
  return `${s.slice(0, s.length - d).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
}

/** The manifest section a probe belongs to: "adapters[Transfer Pay].address" → "adapters". */
function probeGroup(label: string): string {
  return /^[a-zA-Z]+/.exec(label)?.[0] ?? 'other';
}

function Ref({ chain, value }: { chain: string; value: string }) {
  const isAddr = /^0x[0-9a-fA-F]+$/.test(value);
  return (
    <span className="cl-row" style={{ gap: 4, display: 'inline-flex' }}>
      <span className="cl-mono" title={value}>{shortHash(value, 8, 6)}</span>
      {isAddr ? (
        <a className="cl-ref-copy" href={explorerAccount(chain, value)} target="_blank" rel="noreferrer" title="Open in block explorer" aria-label="Open in block explorer">
          <ExternalLink size={12} aria-hidden />
        </a>
      ) : null}
    </span>
  );
}

export default function RealityLabPage() {
  return (
    <StudioPage segment="reality">
      <WithProject>{(s) => <Reality s={s} />}</WithProject>
    </StudioPage>
  );
}

function Reality({ s }: { s: ProjectSummary }) {
  const reality = useReality(s.projectId);
  const runtime = useRuntime(s.projectId);
  const [chainFilter, setChainFilter] = useState<string>('all');
  const [onlyFailing, setOnlyFailing] = useState(false);
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [query, setQuery] = useState('');

  const data = reality.data;
  const probes = data?.probes ?? [];
  const chains = useMemo(() => [...new Set([...(data?.heads.map((h) => h.chain) ?? []), ...probes.map((p) => p.chain)])], [data, probes]);
  const groups = useMemo(() => [...new Set(probes.map((p) => probeGroup(p.label)))], [probes]);
  const visible = probes.filter(
    (p: RealityProbe) =>
      (chainFilter === 'all' || p.chain === chainFilter) &&
      (groupFilter === 'all' || probeGroup(p.label) === groupFilter) &&
      (!onlyFailing || !p.ok) &&
      (!query.trim() || `${p.label} ${p.ref} ${p.detail}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const failing = probes.filter((p) => !p.ok);
  const refusals = data?.refusals ?? [];
  const refused = refusals.filter((r) => r.refused).length;
  const headsOk = data?.heads.filter((h) => !h.error).length ?? 0;
  const refreshing = reality.isFetching || runtime.isFetching;

  const refresh = () => {
    void reality.refetch();
    void runtime.refetch();
  };

  return (
    <div className="cl-stack" style={{ gap: 4 }}>
      <BlockerBanner
        tone="sim"
        title="Read-only against the live testnets"
        actions={
          <button type="button" className="cl-btn cl-btn-sm cl-btn-primary" onClick={refresh} disabled={refreshing}>
            <RefreshCw size={11} aria-hidden /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      >
        Every row below is a fresh read from the chain (code at an address, an object lookup, a view call) or a simulated call that must revert. Nothing is signed, nothing is sent, and no gas is spent.
        {reality.dataUpdatedAt ? <> Last read {new Date(reality.dataUpdatedAt).toLocaleTimeString()}.</> : null}
      </BlockerBanner>

      {reality.isLoading ? (
        <div className="cl-stack" style={{ gap: 10, marginTop: 12 }}><Skeleton height={80} /><Skeleton height={240} /></div>
      ) : reality.isError ? (
        <BlockerBanner tone="deny" title="The Kido API could not probe the chains">{(reality.error as Error).message}</BlockerBanner>
      ) : data ? (
        <>
          <Section label="Summary">
            <div className="cl-grid cl-grid-tiles">
              <Tile label="Chains reachable" value={`${headsOk} / ${data.heads.length}`} tone={headsOk === data.heads.length ? 'pass' : 'deny'} note={data.heads.map((h) => chainLabel(h.chain)).join(' · ')} />
              <Tile label="Contracts live" value={`${probes.length - failing.length} / ${probes.length}`} tone={failing.length ? 'warn' : 'pass'} note={failing.length ? `${failing.length} not found on-chain` : 'every manifest address checked'} />
              <Tile label="Refusal probes" value={data.deployed ? `${refused} / ${refusals.length}` : '—'} tone={!data.deployed ? undefined : refused === refusals.length ? 'pass' : 'deny'} note={data.deployed ? 'stranger calls refused by the real contract' : 'no deployed account to probe'} />
              <Tile label="Deployed account" value={data.deployed ? 'yes' : 'no'} tone={data.deployed ? 'pass' : undefined} note={`${Object.values(data.accounts).filter(Boolean).length} chain account${Object.values(data.accounts).filter(Boolean).length === 1 ? '' : 's'}`} />
            </div>
          </Section>

          <Section label="Chain heads">
            <div className="cl-grid cl-grid-auto">
              {data.heads.map((h) => (
                <Card key={h.chain} title={chainLabel(h.chain)} actions={<StatusBadge status={h.error ? 'FAIL' : 'PASS'} label={h.error ? 'unreachable' : 'reachable'} />}>
                  <KeyValue
                    rows={[
                      { label: 'Head', value: h.head ? (/^\d+$/.test(h.head) ? `block ${Number(h.head).toLocaleString('en-US')}` : h.head) : '—', mono: true },
                      { label: 'Probes', value: `${probes.filter((p) => p.chain === h.chain && p.ok).length} live · ${probes.filter((p) => p.chain === h.chain && !p.ok).length} missing` },
                      ...(h.error ? [{ label: 'Error', value: h.error }] : []),
                    ]}
                  />
                </Card>
              ))}
            </div>
          </Section>

          <Section label="Contract probes" actions={<span className="cl-meta">{visible.length} of {probes.length}</span>}>
            <div className="cl-row cl-row-wrap" style={{ gap: 6, marginBottom: 10 }}>
              {['all', ...chains].map((c) => (
                <button key={c} type="button" className={`cl-btn cl-btn-sm${chainFilter === c ? ' cl-btn-primary' : ''}`} onClick={() => setChainFilter(c)}>
                  {c === 'all' ? 'All chains' : chainLabel(c)}
                </button>
              ))}
              <select className="cl-select" style={{ width: 170, height: 27 }} value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} aria-label="Kind">
                <option value="all">All kinds</option>
                {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
              <input className="cl-input" style={{ width: 200, height: 27 }} placeholder="Search label or address" value={query} onChange={(e) => setQuery(e.target.value)} />
              <label className="cl-checkbox" style={{ marginLeft: 6 }}>
                <input type="checkbox" checked={onlyFailing} onChange={(e) => setOnlyFailing(e.target.checked)} /> Only failing ({failing.length})
              </label>
            </div>
            <Card flush>
              <div className="cl-table-scroll">
                <table className="cl-table" style={{ minWidth: 640, tableLayout: 'fixed' }}>
                  <thead>
                    <tr><th style={{ width: 120 }}>Chain</th><th>What · detail</th><th style={{ width: 190 }}>Reference</th><th style={{ width: 110 }}>On-chain</th></tr>
                  </thead>
                  <tbody>
                    {visible.map((p, i) => (
                      <tr key={`${p.chain}${p.label}${p.ref}${i}`}>
                        <td>{chainLabel(p.chain)}</td>
                        <td>
                          <div className="cl-mono" style={{ fontSize: 12, wordBreak: 'break-word' }}>{p.label}</div>
                          <div className="cl-meta" style={{ whiteSpace: 'normal', wordBreak: 'break-all', marginTop: 2, color: p.ok ? undefined : 'var(--cl-deny)' }}>{p.detail}</div>
                        </td>
                        <td><Ref chain={p.chain} value={p.ref} /></td>
                        <td><StatusBadge status={p.ok ? 'PASS' : 'FAIL'} label={p.ok ? 'live' : 'missing'} /></td>
                      </tr>
                    ))}
                    {visible.length === 0 ? <tr><td colSpan={4} className="cl-meta">No probe matches these filters.</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </Card>
            <p className="cl-meta" style={{ marginTop: 8 }}>
              The addresses come from the Amane deployment manifests Kido compiles against. A missing row means the manifest names something the chain does not have; any action routed through it would fail.
            </p>
          </Section>

          <Section label="Deployed account">
            {!data.deployed ? (
              <EmptyState
                title="Not deployed"
                body="This project has no Amane account on-chain yet, so there is nothing to run refusal probes or read runtime state against. The contract probes above still show what a deployment would build on."
                action={<Link className="cl-btn cl-btn-primary" href={`/projects/${s.projectId}/deploy`}>Open Deploy</Link>}
              />
            ) : (
              <div className="cl-stack" style={{ gap: 12 }}>
                <Card title="Accounts">
                  <KeyValue
                    rows={Object.entries(data.accounts).map(([chain, acct]) => ({
                      label: chainLabel(chain),
                      value: acct ? (
                        <span className="cl-row" style={{ gap: 6, display: 'inline-flex' }}>
                          <a className="cl-mono" href={explorerAccount(chain, acct)} target="_blank" rel="noreferrer">{acct}</a>
                          <CopyButton value={acct} />
                        </span>
                      ) : 'pending',
                    }))}
                  />
                </Card>
                <Card flush title="Refusal probes" actions={<Badge tone={refused === refusals.length ? 'pass' : 'deny'}>{refused}/{refusals.length} refused</Badge>}>
                  {refusals.length === 0 ? (
                    <p className="cl-meta" style={{ padding: 14 }}>No refusal probes were run for this account.</p>
                  ) : (
                    <table className="cl-table">
                      <thead><tr><th style={{ width: 140 }}>Chain</th><th>Stranger call</th><th style={{ width: 120 }}>Result</th><th>What the contract said</th></tr></thead>
                      <tbody>
                        {refusals.map((r, i) => (
                          <tr key={`${r.chain}${r.probe}${i}`}>
                            <td>{chainLabel(r.chain)}</td>
                            <td className="cl-strong">{r.probe}</td>
                            <td><StatusBadge status={r.refused ? 'PASS' : 'FAIL'} label={r.refused ? 'refused' : 'NOT refused'} /></td>
                            <td className="cl-mono" style={{ fontSize: 12, whiteSpace: 'normal', wordBreak: 'break-word' }}>{r.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
                <p className="cl-meta">Each refusal probe simulates a call from an address that is neither the owner nor the leased agent against the real contract. A call that was not refused would mean the account accepts a stranger.</p>
              </div>
            )}
          </Section>
        </>
      ) : null}

      <Section label="Live runtime" actions={runtime.dataUpdatedAt ? <span className="cl-meta">read {new Date(runtime.dataUpdatedAt).toLocaleTimeString()} · every 15 s</span> : null}>
        {runtime.isLoading ? (
          <Skeleton height={100} />
        ) : runtime.isError ? (
          <BlockerBanner tone="deny" title="Runtime unavailable">{(runtime.error as Error).message}</BlockerBanner>
        ) : !runtime.data?.deployed ? (
          <p className="cl-meta">No deployed account, so there is no policy, pause state, lease or balance to read.</p>
        ) : (
          <div className="cl-grid cl-grid-auto">
            {runtime.data.chains.map((c) => (
              <Card key={c.chain} title={chainLabel(c.chain)} actions={c.error ? <Badge tone="deny">read failed</Badge> : c.paused ? <Badge tone="warn">paused</Badge> : <Badge tone={c.leaseStatus === 1 ? 'pass' : 'blocked'}>lease {LEASE_STATUS[c.leaseStatus ?? 0] ?? 'unknown'}</Badge>}>
                {c.error ? <p className="cl-meta">Could not read: {c.error}</p> : null}
                <KeyValue
                  rows={[
                    { label: 'Account', value: c.account ? <Ref chain={c.chain} value={c.account} /> : 'pending' },
                    { label: 'Policy version', value: c.policyVersion ?? '—' },
                    { label: 'Paused', value: c.paused === null ? '—' : c.paused ? `yes (epoch ${c.pauseEpoch})` : 'no' },
                    { label: 'Lease', value: c.leaseStatus === null ? '—' : (LEASE_STATUS[c.leaseStatus] ?? String(c.leaseStatus)) },
                    ...(c.balances.length ? c.balances.map((b) => ({ label: `Balance · ${b.symbol}`, value: formatUnits(b.amount, b.decimals), mono: true })) : [{ label: 'Balances', value: 'none held' }]),
                  ]}
                />
              </Card>
            ))}
            {runtime.data.chains.length === 0 ? <p className="cl-meta">The deployment reports no chain accounts yet.</p> : null}
          </div>
        )}
        {runtime.data?.deployed ? (
          <p className="cl-meta" style={{ marginTop: 8 }}>
            Owner controls (pause, revoke) live on the <Link className="cl-link" href={`/projects/${s.projectId}/runtime`}>Runtime</Link> page; this lab only reads.
          </p>
        ) : null}
      </Section>
    </div>
  );
}
