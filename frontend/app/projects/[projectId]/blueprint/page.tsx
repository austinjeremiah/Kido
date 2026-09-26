'use client';

/**
 * Blueprint: the canonical revision everything compiles from.
 *
 * Every section is read straight from the compiled Kido blueprint (revision, hash and parent hash
 * included) and grouped the way the document reads: what the agent is for, what it can touch, what
 * it may do, how it presents itself and keeps secrets, how it recovers, and what the build must
 * prove. Top-level fields this page does not know are still shown, under "Other fields", so nothing
 * the backend adds is hidden. The raw document is one toggle away.
 *
 * Editing never touches the revision directly: each requirement is edited in plain language through
 * the interview (the backend accepts or refuses with a note), and a recompile produces the next
 * revision, which makes the review, simulation and build stale until they are re-run.
 */
import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Download, FileJson, ListTree } from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, Card, CopyButton, Section, Spec, shortHash } from '@/components/studio/primitives';
import { GateButton, NotYet, WithProject } from '@/components/studio/kido';
import { RecordSpec, RecordTable, StaleArtifacts } from '@/components/studio/blueprint/shared';
import { RequirementsEditor, driftedRequirements } from '@/components/studio/blueprint/RequirementsEditor';
import { useRegistry } from '@/lib/kido/hooks';
import { STAGE_LABEL, amount, chainLabel, explorerAccount, labelOfKey, valueText, windowLabel } from '@/lib/kido/format';
import type { Blueprint, PayeeSpec, ProjectSummary } from '@/lib/kido/types';

/** Top-level blueprint keys each section renders; anything else lands in "Other fields". */
const KNOWN_KEYS = new Set([
  'schemaVersion', 'projectId', 'kidoAgentId', 'revision', 'parentRevisionHash', 'objective', 'chains', 'deployment', 'assets', 'protocols',
  'dataSources', 'monitors', 'triggers', 'authority', 'actions', 'identity', 'privacy', 'recovery', 'crossChain', 'agents', 'simulationScenarios',
  'securityAssertions', 'requirements',
]);

type NavItem = { id: string; label: string; count?: number };

function Group({ id, label, children, actions }: { id: string; label: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div id={`bp-${id}`} style={{ scrollMarginTop: 80 }}>
      <Section label={label} actions={actions}>
        {children}
      </Section>
    </div>
  );
}

function Sub({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="cl-subsection" style={{ marginBottom: 18 }}>
      <div className="cl-subsection-head">
        <span className="cl-label">{label}</span>
        <span className="cl-subsection-rule" />
        {note ? <span className="cl-meta cl-subsection-note">{note}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Chips({ items, tone, empty = 'None' }: { items: string[]; tone: 'pass' | 'deny' | 'neutral' | 'data' | 'warn'; empty?: string }) {
  if (!items.length) return <span className="cl-meta">{empty}</span>;
  return (
    <span className="cl-row cl-row-wrap" style={{ gap: 5 }}>
      {items.map((x) => (
        <Badge key={x} tone={tone}>{x}</Badge>
      ))}
    </span>
  );
}

function PayeeTable({ rows, chains, empty }: { rows: PayeeSpec[]; chains: string[]; empty: string }) {
  if (!rows.length) return <p className="cl-meta">{empty}</p>;
  return (
    <table className="cl-table">
      <thead>
        <tr><th>Label</th><th>Chain</th><th>Address</th><th /></tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={`${p.chain}:${p.address}`}>
            <td className="cl-strong">{p.label}</td>
            <td>{chainLabel(p.chain)}{chains.includes(p.chain) ? null : <> <Badge tone="warn">chain not selected</Badge></>}</td>
            <td className="cl-mono" style={{ wordBreak: 'break-all' }}>
              <a className="cl-link" href={explorerAccount(p.chain, p.address)} target="_blank" rel="noreferrer">{p.address}</a>
            </td>
            <td><CopyButton value={p.address} label="Copy" /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BlueprintBody({ s, bp }: { s: ProjectSummary; bp: Blueprint }) {
  const [raw, setRaw] = useState(false);
  const registry = useRegistry();
  const a = bp.authority;
  const amt = (v: string, asset: string, chain: string) => amount(v, asset, chain, bp.assets);
  const rawJson = useMemo(() => JSON.stringify(bp, null, 2), [bp]);
  const extra = Object.entries(bp as unknown as Record<string, unknown>).filter(([k]) => !KNOWN_KEYS.has(k));
  const providerStatus = (id: string) => registry.data?.find((p) => p.providerId === id);
  const results = new Map((s.simulation?.results ?? []).map((r) => [r.id, r]));
  const drifted = driftedRequirements(s);
  const authorityExtras = Object.fromEntries(
    Object.entries(a).filter(([k]) => !['mode', 'provider', 'autonomy', 'allowedActions', 'forbiddenActions', 'limits', 'payees', 'beneficiaries', 'bridgeAllowed', 'leaseLifetimeSeconds', 'swapFloors'].includes(k)),
  );
  const identityExtras = Object.fromEntries(Object.entries(bp.identity).filter(([k]) => !['public', 'bindings'].includes(k)));
  const privacyExtras = Object.fromEntries(Object.entries(bp.privacy).filter(([k]) => !['required', 'values', 'providers'].includes(k)));

  const nav: NavItem[] = [
    { id: 'objective', label: 'Objective & scope' },
    { id: 'surface', label: 'Assets, protocols & data', count: bp.assets.length + bp.protocols.length + bp.dataSources.length },
    { id: 'monitors', label: 'Monitors & triggers', count: bp.monitors.length + bp.triggers.length },
    { id: 'authority', label: 'Authority', count: a.allowedActions.length },
    { id: 'identity', label: 'Identity', count: bp.identity.bindings.length },
    { id: 'privacy', label: 'Privacy', count: bp.privacy.values.length },
    { id: 'recovery', label: 'Recovery & cross-chain' },
    { id: 'agents', label: 'Agents', count: bp.agents.length },
    { id: 'proof', label: 'Scenarios & assertions', count: bp.simulationScenarios.length + bp.securityAssertions.length },
    ...(extra.length ? [{ id: 'other', label: 'Other fields', count: extra.length }] : []),
    { id: 'requirements', label: 'Requirements', count: s.interview.requirements.length },
  ];
  const jump = (id: string) => document.getElementById(`bp-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const header = (
    <div className="cl-row cl-row-wrap" style={{ gap: 8, marginBottom: 14 }}>
      <Badge tone="data" chip>Blueprint r{bp.revision}</Badge>
      <Badge tone="neutral">{STAGE_LABEL[s.stage]}</Badge>
      <Badge tone="neutral" title="Schema version">{bp.schemaVersion}</Badge>
      <span className="cl-meta cl-mono" title={bp.kidoAgentId}>{bp.kidoAgentId}</span>
      {s.blueprintHash ? (
        <span className="cl-row" style={{ gap: 4 }}>
          <span className="cl-meta">hash</span>
          <span className="cl-mono" title={s.blueprintHash}>{shortHash(s.blueprintHash, 10, 6)}</span>
          <CopyButton value={s.blueprintHash} label="Copy" />
        </span>
      ) : null}
      <span className="cl-row" style={{ gap: 4 }}>
        <span className="cl-meta">parent</span>
        {bp.parentRevisionHash ? (
          <>
            <span className="cl-mono" title={bp.parentRevisionHash}>{shortHash(bp.parentRevisionHash, 10, 6)}</span>
            <CopyButton value={bp.parentRevisionHash} label="Copy" />
          </>
        ) : (
          <span className="cl-meta">none (first revision)</span>
        )}
      </span>
      <span className="cl-spacer" />
      <button type="button" className="cl-btn cl-btn-sm" onClick={() => setRaw(!raw)} aria-pressed={raw}>
        {raw ? <ListTree size={12} aria-hidden /> : <FileJson size={12} aria-hidden />}
        {raw ? 'Sections' : 'Raw JSON'}
      </button>
    </div>
  );

  return (
    <>
      {header}
      {s.blockers.length ? (
        <BlockerBanner tone="deny" title={`${s.blockers.length} build blocker${s.blockers.length === 1 ? '' : 's'}`}>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {s.blockers.map((b) => (
              <li key={`${b.code}${b.detail}`}><span className="cl-mono">{b.code}</span>: {b.detail}</li>
            ))}
          </ul>
        </BlockerBanner>
      ) : null}
      <StaleArtifacts s={s} />
      {s.interview.warnings.length ? <BlockerBanner tone="warn" title="Interview warnings">{s.interview.warnings.join(' · ')}</BlockerBanner> : null}
      {drifted.length ? (
        <BlockerBanner tone="warn" title="Requirements edited since this revision" actions={<button type="button" className="cl-btn cl-btn-sm" onClick={() => jump('requirements')}>Review</button>}>
          {drifted.map(labelOfKey).join(', ')} changed. Recompile to produce Blueprint r{bp.revision + 1}.
        </BlockerBanner>
      ) : null}

      {raw ? (
        <Section
          label="Raw document"
          actions={
            <div className="cl-row" style={{ gap: 6 }}>
              <CopyButton value={rawJson} label="Copy JSON" />
              <button
                type="button"
                className="cl-btn cl-btn-sm"
                onClick={() => {
                  const url = URL.createObjectURL(new Blob([rawJson], { type: 'application/json' }));
                  const el = document.createElement('a');
                  el.href = url;
                  el.download = `${bp.projectId}-blueprint-r${bp.revision}.json`;
                  el.click();
                  URL.revokeObjectURL(url);
                }}
              >
                <Download size={12} aria-hidden />
                Download
              </button>
            </div>
          }
        >
          <Card flush>
            <pre className="cl-mono" data-lenis-prevent style={{ margin: 0, padding: 14, whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 12, maxHeight: '70vh', overflow: 'auto' }}>
              {rawJson}
            </pre>
          </Card>
        </Section>
      ) : (
        <div>
          <nav aria-label="Blueprint sections" className="cl-row cl-row-wrap" style={{ position: 'sticky', top: 0, zIndex: 2, gap: 4, padding: '8px 0', marginBottom: 8, background: 'var(--cl-canvas)', borderBottom: '1px solid var(--cl-line)' }}>
            {nav.map((n) => (
              <button key={n.id} type="button" className="cl-btn cl-btn-sm cl-btn-ghost" onClick={() => jump(n.id)}>
                {n.label}
                {n.count !== undefined ? <span className="cl-meta" style={{ marginLeft: 4 }}>{n.count}</span> : null}
              </button>
            ))}
          </nav>

          <div style={{ minWidth: 0 }}>
            <Group id="objective" label="Objective & scope">
              <Spec
                rows={[
                  { key: 'statement', label: 'Objective', value: bp.objective.statement, ok: Boolean(bp.objective.statement) },
                  { key: 'summary', label: 'Kind', value: bp.objective.summary ?? '—' },
                  { key: 'chains', label: 'Chains', value: <Chips items={bp.chains.map(chainLabel)} tone="data" empty="No chain selected" />, ok: bp.chains.length > 0, open: bp.chains.length === 0 },
                  { key: 'env', label: 'Deployment', value: `${bp.deployment.environment} · ${bp.deployment.chains.map(chainLabel).join(', ') || 'no chains'}` },
                  { key: 'project', label: 'Project', value: <span className="cl-mono">{bp.projectId}</span> },
                ]}
              />
            </Group>

            <Group id="surface" label="Assets, protocols & data">
              <Sub label="Assets" note={`${bp.assets.length} declared`}>
                <RecordTable
                  rows={bp.assets}
                  empty="No assets declared."
                  render={{
                    chain: (v) => chainLabel(String(v)),
                    ref: (v, r) => (typeof v === 'string' ? <span className="cl-row" style={{ gap: 4 }}><a className="cl-link cl-mono" title={v} href={explorerAccount(String(r.chain), v)} target="_blank" rel="noreferrer">{shortHash(v, 8, 6)}</a><CopyButton value={v} label="Copy" /></span> : valueText(v)),
                    testnetOnly: (v) => (v ? <Badge tone="sim">testnet only</Badge> : valueText(v)),
                  }}
                />
              </Sub>
              <Sub label="Protocols" note="each pinned to a registry provider and version">
                <RecordTable
                  rows={bp.protocols.map((p) => ({ ...p, registry: providerStatus(p.providerId)?.status ?? (registry.isLoading ? '…' : 'not in registry') }))}
                  empty="No protocols. The agent touches no DeFi protocol."
                  render={{
                    chain: (v) => chainLabel(String(v)),
                    capabilities: (v) => <Chips items={Array.isArray(v) ? v.map(String) : []} tone="neutral" />,
                    registry: (v) => <Badge tone={v === 'VERIFIED_LIVE' ? 'pass' : v === 'not in registry' ? 'deny' : 'warn'}>{String(v)}</Badge>,
                  }}
                />
              </Sub>
              <Sub label="Data sources" note="what monitors observe, and what happens when it is unavailable">
                <RecordTable
                  rows={bp.dataSources}
                  empty="No data sources."
                  render={{
                    chain: (v) => chainLabel(String(v)),
                    maxAgeMs: (v) => (typeof v === 'number' ? `${windowLabel(Math.round(v / 1000))} max age` : valueText(v)),
                    onUnavailable: (v) => <Badge tone={v === 'FAIL_CLOSED' ? 'pass' : 'warn'}>{valueText(v)}</Badge>,
                  }}
                />
              </Sub>
            </Group>

            <Group id="monitors" label="Monitors & triggers">
              <Sub label="Monitors">
                {bp.monitors.length ? (
                  <table className="cl-table">
                    <thead>
                      <tr><th>Monitor</th><th>Source</th><th>Condition</th><th>Response</th><th>Target</th></tr>
                    </thead>
                    <tbody>
                      {bp.monitors.map((m) => (
                        <tr key={m.id}>
                          <td className="cl-mono">{m.id}</td>
                          <td className="cl-mono">{m.dataSource}</td>
                          <td>
                            {labelOfKey(m.metric.toLowerCase())} <span className="cl-mono">{m.op}</span>{' '}
                            {m.threshold ?? (m.thresholdPrivateRef ? <Badge tone="sim" title={m.thresholdPrivateRef}>private threshold</Badge> : '—')}
                          </td>
                          <td>{m.response.toLowerCase().replace(/_/g, ' ')}{m.action ? <> → <Badge tone="neutral">{m.action}</Badge></> : null}</td>
                          <td>{m.target ? `${m.target.share} of ${m.target.asset}` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="cl-meta">No monitors. The agent does not watch any on-chain condition.</p>
                )}
              </Sub>
              <Sub label="Triggers">
                <RecordTable rows={bp.triggers as Array<Record<string, unknown>>} empty="No triggers." />
              </Sub>
            </Group>

            <Group id="authority" label="Authority">
              <Spec
                rows={[
                  { key: 'mode', label: 'Mode', value: a.mode ? labelOfKey(a.mode.toLowerCase()) : '—', note: a.mode ?? undefined, ok: Boolean(a.mode), open: !a.mode },
                  { key: 'provider', label: 'Enforced by', value: a.provider === 'AMANE' ? 'Amane (on-chain policy and lease)' : a.provider === 'OWNER_WALLET' ? 'Owner wallet (every action signed by the owner)' : 'No authority provider', ok: Boolean(a.provider) },
                  { key: 'autonomy', label: 'Autonomy', value: a.autonomy ? labelOfKey(a.autonomy.toLowerCase()) : '—' },
                  { key: 'allowed', label: 'Allowed actions', value: <Chips items={a.allowedActions} tone="pass" empty="None: read-only" /> },
                  { key: 'forbidden', label: 'Forbidden actions', value: <Chips items={a.forbiddenActions} tone="deny" /> },
                  { key: 'lease', label: 'Lease lifetime', value: windowLabel(a.leaseLifetimeSeconds), note: `${a.leaseLifetimeSeconds} s; the agent's authority expires and must be re-issued` },
                  { key: 'bridge', label: 'Bridging', value: a.bridgeAllowed === null ? 'Undecided' : a.bridgeAllowed ? 'Allowed' : 'Not allowed', open: a.bridgeAllowed === null },
                ]}
              />
              <div style={{ height: 16 }} />
              <Sub label="Limits" note="per chain and asset, debited on-chain">
                {a.limits.length ? (
                  <table className="cl-table">
                    <thead>
                      <tr><th>Chain</th><th>Asset</th><th>Per action</th><th>Per window</th><th>Window</th><th>Total</th></tr>
                    </thead>
                    <tbody>
                      {a.limits.map((l) => (
                        <tr key={`${l.chain}:${l.asset}`}>
                          <td>{chainLabel(l.chain)}</td>
                          <td className="cl-strong">{l.asset}</td>
                          <td title={`${l.perAction} base units`}>{amt(l.perAction, l.asset, l.chain)}</td>
                          <td title={`${l.perWindow} base units`}>{amt(l.perWindow, l.asset, l.chain)}</td>
                          <td>{windowLabel(l.windowSeconds)}</td>
                          <td title={`${l.total} base units`}>{amt(l.total, l.asset, l.chain)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="cl-meta">No spending limits: the agent cannot move value.</p>
                )}
              </Sub>
              <Sub label="Payees" note="the only addresses a payment may go to">
                <PayeeTable rows={a.payees} chains={bp.chains} empty="No payees pinned." />
              </Sub>
              <Sub label="Beneficiaries" note="the only positions a repayment may reduce">
                <PayeeTable rows={a.beneficiaries} chains={bp.chains} empty="No beneficiaries pinned." />
              </Sub>
              <Sub label="Swap floors" note="minimum output per unit input, enforced on-chain">
                {a.swapFloors.length ? (
                  <table className="cl-table">
                    <thead>
                      <tr><th>Chain</th><th>In</th><th>Out</th><th>Minimum out per in</th></tr>
                    </thead>
                    <tbody>
                      {a.swapFloors.map((f) => (
                        <tr key={`${f.chain}${f.assetIn}${f.assetOut}`}>
                          <td>{chainLabel(f.chain)}</td>
                          <td>{f.assetIn}</td>
                          <td>{f.assetOut}</td>
                          <td className="cl-mono">{f.minOutPerIn}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="cl-meta">No swap floors.</p>
                )}
              </Sub>
              <Sub label="Execution routes" note="action → chain → provider">
                <RecordTable
                  rows={bp.actions as Array<Record<string, unknown>>}
                  empty="No execution routes."
                  render={{ chain: (v) => chainLabel(String(v)), deterministic: (v) => (v ? 'deterministic' : 'model-proposed, compiler-checked') }}
                />
              </Sub>
              {Object.keys(authorityExtras).length ? (
                <Sub label="Other authority fields">
                  <RecordSpec record={authorityExtras} />
                </Sub>
              ) : null}
            </Group>

            <Group id="identity" label="Identity">
              <Spec rows={[{ key: 'public', label: 'Public identity', value: bp.identity.public === null ? 'Undecided' : bp.identity.public ? 'Yes' : 'No', open: bp.identity.public === null }]} />
              <div style={{ height: 12 }} />
              <Sub label="Name bindings">
                <RecordTable rows={bp.identity.bindings as Array<Record<string, unknown>>} empty="No names bound." render={{ chain: (v) => chainLabel(String(v)), name: (v) => (v ? String(v) : <span className="cl-meta">(planned)</span>) }} />
              </Sub>
              <RecordSpec record={identityExtras} />
            </Group>

            <Group id="privacy" label="Privacy">
              <Spec rows={[{ key: 'required', label: 'Privacy required', value: bp.privacy.required === null ? 'Undecided' : bp.privacy.required ? 'Yes' : 'No', open: bp.privacy.required === null }]} />
              <div style={{ height: 12 }} />
              <Sub label="Protected values">
                <RecordTable rows={bp.privacy.values} empty="No protected values." />
              </Sub>
              <Sub label="Privacy providers">
                <RecordTable
                  rows={bp.privacy.providers as unknown as Array<Record<string, unknown>>}
                  empty="No privacy providers."
                  render={{ chain: (v) => chainLabel(String(v)), capabilities: (v) => <Chips items={Array.isArray(v) ? v.map(String) : []} tone="neutral" />, satisfies: (v) => <Chips items={Array.isArray(v) ? v.map(String) : []} tone="pass" /> }}
                />
              </Sub>
              {Object.keys(privacyExtras).length ? <RecordSpec record={privacyExtras} /> : null}
            </Group>

            <Group id="recovery" label="Recovery & cross-chain">
              <Sub label="Recovery">
                <RecordSpec record={bp.recovery} />
              </Sub>
              <Sub label="Cross-chain">
                <RecordSpec record={bp.crossChain} empty="No cross-chain policy: the agent does not move value between chains." />
              </Sub>
            </Group>

            <Group id="agents" label="Agents">
              {bp.agents.length ? (
                <table className="cl-table">
                  <thead>
                    <tr><th>Role</th><th>Owns</th><th>May request</th><th>Knowledge packs</th><th /></tr>
                  </thead>
                  <tbody>
                    {bp.agents.map((g) => (
                      <tr key={g.role}>
                        <td className="cl-strong">{g.role}</td>
                        <td><Chips items={g.owns} tone="pass" /></td>
                        <td><Chips items={g.mayRequest} tone="neutral" /></td>
                        <td className="cl-mono" style={{ fontSize: 12 }}>{g.knowledgePacks.join(', ') || '—'}</td>
                        <td><Link className="cl-link" href={`/projects/${s.projectId}/code`}>Context</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="cl-meta">No specialist agents.</p>
              )}
            </Group>

            <Group id="proof" label="Scenarios & assertions">
              <Sub label="Simulation scenarios" note={s.simulation ? `latest run r${s.simulation.blueprintRevision} · ${s.simulation.freshness}` : 'not run yet'}>
                {bp.simulationScenarios.length ? (
                  <table className="cl-table">
                    <thead>
                      <tr><th>Scenario</th><th>Family</th><th>What it proves</th><th>Latest</th></tr>
                    </thead>
                    <tbody>
                      {bp.simulationScenarios.map((sc) => {
                        const r = results.get(String(sc.id));
                        return (
                          <tr key={String(sc.id)}>
                            <td className="cl-mono">{String(sc.id)}</td>
                            <td>{valueText(sc.family)}</td>
                            <td>{valueText(sc.description)}</td>
                            <td>
                              {r ? (
                                <Link href={`/projects/${s.projectId}/simulation?scenario=${encodeURIComponent(r.id)}`}>
                                  <Badge tone={r.passed ? (s.simulation?.freshness === 'CURRENT' ? 'pass' : 'warn') : 'deny'}>{r.passed ? 'passed' : 'failed'}{s.simulation?.freshness === 'CURRENT' ? '' : ' · stale'}</Badge>
                                </Link>
                              ) : (
                                <span className="cl-meta">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <p className="cl-meta">No scenarios declared.</p>
                )}
              </Sub>
              <Sub label="Security assertions" note="invariants the review and the chain uphold">
                <RecordTable rows={bp.securityAssertions} empty="No assertions." />
              </Sub>
            </Group>

            {extra.length ? (
              <Group id="other" label="Other fields">
                {extra.map(([k, v]) => (
                  <Sub key={k} label={labelOfKey(k)}>
                    {Array.isArray(v) ? (
                      v.every((x) => x && typeof x === 'object') ? <RecordTable rows={v as Array<Record<string, unknown>>} /> : <Chips items={v.map(valueText)} tone="neutral" />
                    ) : v && typeof v === 'object' ? (
                      <RecordSpec record={v as Record<string, unknown>} />
                    ) : (
                      <p className="cl-body">{valueText(v)}</p>
                    )}
                  </Sub>
                ))}
              </Group>
            ) : null}

            <Group id="requirements" label="Requirements" actions={<span className="cl-meta">{s.interview.requirements.filter((r) => r.status === 'RESOLVED').length}/{s.interview.requirements.length} resolved</span>}>
              <p className="cl-meta" style={{ whiteSpace: 'normal', marginBottom: 10 }}>
                The blueprint compiles from these. Change one in plain language; Kido parses it like an interview answer, then recompiling produces Blueprint r{bp.revision + 1}.
              </p>
              <RequirementsEditor s={s} />
            </Group>
          </div>
        </div>
      )}
    </>
  );
}

export default function BlueprintPage() {
  return (
    <StudioPage segment="blueprint" actions={<GateButton gate="finalize" label="Recompile blueprint" />}>
      <WithProject>{(s) => (s.blueprint ? <BlueprintBody s={s} bp={s.blueprint} /> : <NotYet what="blueprint" where="composer" id={s.projectId} />)}</WithProject>
    </StudioPage>
  );
}
