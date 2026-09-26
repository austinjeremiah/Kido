'use client';

/**
 * Safety Report: one blueprint revision's security review, simulation and build, the implementation
 * status of every provider the agent relies on (including what has not been proven), and the
 * evidence behind it: the registry's evidence for those providers, the deployment's transactions
 * and the live reality probes of the Amane contracts.
 *
 * Tabs: Summary (the verdict and how fresh each artifact is), Findings, Simulation, Providers,
 * Evidence and Export. Export downloads the whole report as JSON or opens a print-friendly view
 * (window.print()). Every value comes from the project summary, GET /self-model, GET /registry,
 * GET /deployment and GET /reality. A missing reading is shown as missing.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { ExternalLink, FileJson, Printer, X } from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, Card, EmptyState, KeyValue, Section, Skeleton, StatusBadge, TabStrip } from '@/components/studio/primitives';
import { GateButton, NotYet, WithProject, nextGate, useKido } from '@/components/studio/kido';
import { useDeployment, useReality, useRegistry, useSelfModel } from '@/lib/kido/hooks';
import { chainLabel, explorerAccount, explorerTx } from '@/lib/kido/format';
import type { DeploymentStatus, Freshness, ProjectSummary, ProviderRow, Reality, SelfModel } from '@/lib/kido/types';
import type { Tone } from '@/lib/studio/types';
import { download } from '@/components/studio/operate/derive';

type Tab = 'summary' | 'findings' | 'simulation' | 'providers' | 'evidence' | 'export';

const PROVIDER_TONE: Record<string, Tone> = { TESTNET_LIVE: 'pass', LIVE_ATTESTED: 'pass', VERIFIED_LIVE: 'pass', IMPLEMENTED_LOCAL: 'data', SIMULATED: 'sim', NOT_IMPLEMENTED: 'neutral', BLOCKED_ENV: 'blocked', BLOCKED_AUTH: 'blocked', BLOCKED_UPSTREAM: 'blocked' };
const SEVERITY_TONE: Record<string, Tone> = { CRITICAL: 'deny', HIGH: 'deny', MEDIUM: 'warn', LOW: 'neutral', INFO: 'neutral' };

interface Check { key: string; label: string; ok: boolean; status: string; detail: string; at: number | null; freshness: Freshness; segment: string }

function checksOf(s: ProjectSummary): Check[] {
  const sec = s.security, sim = s.simulation, b = s.build;
  return [
    {
      key: 'security', label: 'Security review', segment: 'security', at: sec?.generatedAt ?? null, freshness: sec?.freshness ?? 'NONE',
      ok: Boolean(sec && sec.freshness === 'CURRENT' && !sec.blocking),
      status: !sec ? 'UNKNOWN' : sec.freshness === 'STALE' ? 'STALE' : sec.blocking ? 'FAIL' : 'PASS',
      detail: sec ? `${sec.findings.length} finding(s), ${sec.findings.filter((f) => f.blocking).length} blocking · revision ${sec.blueprintRevision}` : 'not run',
    },
    {
      key: 'simulation', label: 'Simulation', segment: 'simulation', at: sim?.generatedAt ?? null, freshness: sim?.freshness ?? 'NONE',
      ok: Boolean(sim && sim.freshness === 'CURRENT' && sim.passed),
      status: !sim ? 'UNKNOWN' : sim.freshness === 'STALE' ? 'STALE' : sim.passed ? 'PASS' : 'FAIL',
      detail: sim ? `${sim.results.filter((r) => r.passed).length}/${sim.results.length} scenarios passed · revision ${sim.blueprintRevision}` : 'not run',
    },
    {
      key: 'build', label: 'Build', segment: 'build', at: b?.generatedAt ?? null, freshness: b?.freshness ?? 'NONE',
      ok: Boolean(b && b.freshness === 'CURRENT'),
      status: !b ? 'UNKNOWN' : b.freshness === 'STALE' ? 'STALE' : 'PASS',
      detail: b ? `build ${b.buildRevision} of revision ${b.blueprintRevision} · ${b.agents.length} agent(s)${b.agents.some((a) => a.missingPacks.length) ? ' · missing knowledge packs' : ''}` : 'not built',
    },
  ];
}

function reportOf(s: ProjectSummary, sm: SelfModel | undefined, registry: ProviderRow[] | undefined, dep: DeploymentStatus | undefined, reality: Reality | undefined) {
  const used = new Set((sm?.providers ?? []).map((p) => p.providerId));
  return {
    kind: 'kido.safety-report',
    exportedAt: new Date().toISOString(),
    project: { id: s.projectId, name: s.name, objective: s.objective, agentId: s.kidoAgentId, stage: s.stage, revision: s.revision, blueprintHash: s.blueprintHash, chains: s.chains, agents: s.agents },
    verdict: checksOf(s).map(({ key, label, ok, status, detail, at, freshness }) => ({ key, label, ok, status, detail, generatedAt: at ? new Date(at).toISOString() : null, freshness })),
    blockers: s.blockers,
    security: s.security,
    simulation: s.simulation,
    build: s.build,
    authority: sm?.authority ?? s.blueprint?.authority ?? null,
    providers: sm?.providers ?? null,
    execution: sm?.execution ?? null,
    failureBehaviour: sm?.failureBehaviour ?? null,
    capabilitiesNotAvailable: sm?.capabilitiesNotAvailable ?? null,
    evidence: {
      registry: (registry ?? []).filter((r) => used.has(r.providerId)).map((r) => ({ providerId: r.providerId, status: r.status, implementationStatus: r.implementation.status, evidence: r.implementation.evidence, statusNote: r.statusNote ?? null })),
      deployment: dep ? { deployment: dep.deployment, events: dep.events } : null,
      reality: reality ?? null,
    },
  };
}

const when = (at: number | null) => (at ? new Date(at).toLocaleString() : '—');

/* ------------------------------------------------------------------ tabs */

function Summary({ s, sm, go }: { s: ProjectSummary; sm: SelfModel | undefined; go: (t: Tab) => void }) {
  const checks = checksOf(s);
  const allOk = checks.every((c) => c.ok);
  const next = nextGate(s);
  const notProven = (sm?.providers ?? []).reduce((n, p) => n + p.notProven.length, 0);
  return (
    <>
      <Section label="Verdict">
        {allOk ? (
          <BlockerBanner tone="pass" title={`Revision ${s.revision} is reviewed, simulated and built`}>
            All three artifacts are current for blueprint {s.blueprintHash?.slice(0, 12)}…. This report does not prove the providers below beyond what each states it has proven.
          </BlockerBanner>
        ) : (
          <BlockerBanner tone="warn" title={`Revision ${s.revision} is not fully verified`} actions={next ? <GateButton gate={next} primary /> : undefined}>
            {checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.status === 'UNKNOWN' ? c.detail : c.status.toLowerCase()}`).join(' · ')}
          </BlockerBanner>
        )}
        <div className="cl-steps" style={{ marginTop: 12 }}>
          {checks.map((c, i) => (
            <Link key={c.key} href={`/projects/${s.projectId}/${c.segment}`} className="cl-step" data-state={c.ok ? 'done' : c.status === 'FAIL' ? 'exception' : 'pending'}>
              <span className="cl-step-index">{i + 1}</span>
              <span className="cl-step-name">{c.label}</span>
              <span className="cl-step-status"><StatusBadge status={c.status} /></span>
              <span className="cl-step-detail">{c.detail} · {c.at ? `generated ${when(c.at)}` : 'no run recorded'}</span>
            </Link>
          ))}
        </div>
      </Section>
      <Section label="What this report covers">
        <div className="cl-stack" style={{ gap: 16 }}>
          <Card title={`${s.name} · revision ${s.revision ?? '—'}`}>
            <KeyValue
              rows={[
                { label: 'Objective', value: s.blueprint?.objective.summary ?? s.objective },
                { label: 'Agent id', value: s.kidoAgentId ?? '—', mono: true },
                { label: 'Blueprint hash', value: <span style={{ wordBreak: 'break-all' }}>{s.blueprintHash ?? '—'}</span>, mono: true },
                { label: 'Chains', value: s.chains.map(chainLabel).join(' · ') || '—' },
                { label: 'Allowed', value: (sm?.allowedActions ?? s.blueprint?.authority.allowedActions ?? []).join(', ') || '—' },
                { label: 'Forbidden', value: (sm?.forbiddenActions ?? s.blueprint?.authority.forbiddenActions ?? []).join(', ') || '—' },
              ]}
            />
          </Card>
          <Card title="At a glance">
            <div className="cl-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
              <Figure label="Findings" value={s.security ? String(s.security.findings.length) : '—'} note={s.security ? `${s.security.findings.filter((f) => f.blocking).length} blocking` : 'not reviewed'} onClick={() => go('findings')} />
              <Figure label="Scenarios passed" value={s.simulation ? `${s.simulation.results.filter((r) => r.passed).length}/${s.simulation.results.length}` : '—'} note={s.simulation ? `${new Set(s.simulation.results.map((r) => r.family)).size} families` : 'not simulated'} onClick={() => go('simulation')} />
              <Figure label="Providers relied on" value={sm ? String(sm.providers.length) : '—'} note={sm ? `${sm.providers.filter((p) => p.live).length} live` : 'self-model loading'} onClick={() => go('providers')} />
              <Figure label="Claims not proven" value={sm ? String(notProven) : '—'} note="stated by the providers" onClick={() => go('providers')} />
            </div>
          </Card>
        </div>
        {s.blockers.length ? (
          <Card title={`Blueprint blockers · ${s.blockers.length}`}>
            <KeyValue rows={s.blockers.map((b) => ({ label: b.code, value: b.detail }))} />
          </Card>
        ) : null}
      </Section>
    </>
  );
}

function Figure({ label, value, note, onClick }: { label: string; value: string; note: string; onClick: () => void }) {
  return (
    <button type="button" className="cl-card" style={{ textAlign: 'left', cursor: 'pointer', padding: 0 }} onClick={onClick}>
      <div className="cl-card-body">
        <div className="cl-label">{label}</div>
        <div className="cl-aggregate-figure cl-num" style={{ fontSize: 22, margin: '4px 0' }}>{value}</div>
        <div className="cl-meta">{note}</div>
      </div>
    </button>
  );
}

function Findings({ s }: { s: ProjectSummary }) {
  const [sev, setSev] = useState('all');
  const [blockingOnly, setBlockingOnly] = useState(false);
  if (!s.security) return <EmptyState title="Not reviewed yet" body="Run the security review for this revision to see its findings." action={<GateButton gate="securityReview" primary />} />;
  const severities = [...new Set(s.security.findings.map((f) => f.severity))];
  const rows = s.security.findings.filter((f) => (sev === 'all' || f.severity === sev) && (!blockingOnly || f.blocking));
  return (
    <Section label={`Security findings · revision ${s.security.blueprintRevision}`} actions={<StatusBadge status={s.security.freshness === 'STALE' ? 'STALE' : s.security.blocking ? 'FAIL' : 'PASS'} label={`${s.security.freshness.toLowerCase()} · ${when(s.security.generatedAt)}`} />}>
      {s.security.freshness === 'STALE' ? <BlockerBanner tone="warn" title="This review is for an older revision" actions={<GateButton gate="securityReview" />}>The blueprint is now revision {s.revision}.</BlockerBanner> : null}
      {s.security.findings.length === 0 ? (
        <Card><p className="cl-body">The review raised no findings for revision {s.security.blueprintRevision}.</p></Card>
      ) : (
        <Card
          flush
          title={`${rows.length} of ${s.security.findings.length}`}
          actions={
            <span className="cl-row" style={{ gap: 8 }}>
              <select className="cl-select" value={sev} onChange={(e) => setSev(e.target.value)} aria-label="Severity">
                <option value="all">All severities</option>
                {severities.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              <label className="cl-checkbox"><input type="checkbox" checked={blockingOnly} onChange={(e) => setBlockingOnly(e.target.checked)} /> Blocking only</label>
            </span>
          }
        >
          <div className="cl-table-scroll">
            <table className="cl-table">
              <thead><tr><th style={{ width: 120 }}>Id</th><th style={{ width: 170 }}>Class</th><th style={{ width: 110 }}>Severity</th><th style={{ width: 100 }}>Blocking</th><th>Evidence</th></tr></thead>
              <tbody>
                {rows.map((f) => (
                  <tr key={f.id}>
                    <td className="cl-mono">{f.id}</td>
                    <td>{f.class}</td>
                    <td><Badge tone={SEVERITY_TONE[f.severity] ?? 'neutral'}>{f.severity}</Badge></td>
                    <td>{f.blocking ? <Badge tone="deny">blocking</Badge> : <span className="cl-dim">no</span>}</td>
                    <td style={{ whiteSpace: 'normal' }}>{f.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </Section>
  );
}

function Simulation({ s }: { s: ProjectSummary }) {
  const [family, setFamily] = useState('all');
  if (!s.simulation) return <EmptyState title="Not simulated yet" body="Run the simulation for this revision to see every scenario's outcome." action={<GateButton gate="simulate" primary />} />;
  const sim = s.simulation;
  const families = [...new Set(sim.results.map((r) => r.family))];
  const rows = sim.results.filter((r) => family === 'all' || r.family === family);
  return (
    <Section label={`Simulation · revision ${sim.blueprintRevision}`} actions={<StatusBadge status={sim.freshness === 'STALE' ? 'STALE' : sim.passed ? 'PASS' : 'FAIL'} label={`${sim.freshness.toLowerCase()} · ${when(sim.generatedAt)}`} />}>
      {sim.freshness === 'STALE' ? <BlockerBanner tone="warn" title="This simulation is for an older revision" actions={<GateButton gate="simulate" />}>The blueprint is now revision {s.revision}.</BlockerBanner> : null}
      <div className="cl-grid cl-grid-tiles" style={{ marginBottom: 12 }}>
        {families.map((f) => {
          const rs = sim.results.filter((r) => r.family === f);
          const ok = rs.filter((r) => r.passed).length;
          return (
            <button key={f} type="button" className="cl-card" style={{ textAlign: 'left', cursor: 'pointer', padding: 0, outline: family === f ? '1px solid var(--cl-ink)' : undefined }} onClick={() => setFamily(family === f ? 'all' : f)}>
              <div className="cl-card-body">
                <div className="cl-label">{f}</div>
                <div className="cl-row" style={{ gap: 8, marginTop: 6 }}>
                  <span className="cl-num" style={{ fontSize: 18 }}>{ok}/{rs.length}</span>
                  <StatusBadge status={ok === rs.length ? 'PASS' : 'FAIL'} />
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <Card flush title={family === 'all' ? `All ${sim.results.length} scenarios` : `${rows.length} ${family} scenario(s)`} actions={family !== 'all' ? <button type="button" className="cl-btn cl-btn-sm" onClick={() => setFamily('all')}>Show all</button> : undefined}>
        <div className="cl-table-scroll">
          <table className="cl-table">
            <thead><tr><th style={{ width: 190 }}>Scenario</th><th style={{ width: 100 }}>Family</th><th style={{ width: 90 }}>Expected</th><th style={{ width: 90 }}>Actual</th><th style={{ width: 150 }}>Code</th><th style={{ width: 90 }}>Result</th><th>Note</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="cl-mono">{r.id}</td>
                  <td>{r.family}</td>
                  <td><Badge tone={r.expected === 'ALLOW' ? 'pass' : 'deny'}>{r.expected}</Badge></td>
                  <td><Badge tone={r.actual === 'ALLOW' ? 'pass' : 'deny'}>{r.actual}</Badge></td>
                  <td className="cl-mono" style={{ fontSize: 11.5 }}>{r.code ?? '—'}</td>
                  <td><StatusBadge status={r.passed ? 'PASS' : 'FAIL'} /></td>
                  <td style={{ whiteSpace: 'normal' }}>{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Section>
  );
}

function Providers({ sm, error }: { sm: SelfModel | undefined; error: string | null }) {
  if (!sm) return error ? <BlockerBanner tone="deny" title="The self-model could not be loaded">{error}</BlockerBanner> : <Skeleton height={160} />;
  return (
    <>
      <Section label={`Providers this agent relies on · ${sm.providers.length}`}>
        <div className="cl-stack" style={{ gap: 12 }}>
          {sm.providers.map((p) => (
            <Card
              key={`${p.providerId}-${p.role}`}
              title={<span className="cl-row" style={{ gap: 8 }}><span className="cl-mono">{p.providerId}</span><span className="cl-meta">{p.role}</span></span>}
              actions={<span className="cl-row" style={{ gap: 6 }}>{p.live ? <Badge tone="pass">live</Badge> : <Badge tone="neutral">not live</Badge>}<Badge tone={PROVIDER_TONE[p.status] ?? 'neutral'} title={p.statusMeaning}>{p.status}</Badge></span>}
            >
              <p className="cl-meta" style={{ marginBottom: 10 }}>{p.statusMeaning}</p>
              {p.blocker ? <BlockerBanner tone="blocked" title="Blocked">{p.blocker}</BlockerBanner> : null}
              <div className="cl-grid cl-grid-3">
                <ClaimList title="Proven" tone="pass" items={p.proven} />
                <ClaimList title="Not proven" tone="warn" items={p.notProven} />
                <ClaimList title="Does not provide" tone="neutral" items={p.doesNotProvide} />
              </div>
            </Card>
          ))}
        </div>
      </Section>
      {sm.execution.length ? (
        <Section label="How each action executes">
          <Card flush>
            <div className="cl-table-scroll">
              <table className="cl-table">
                <thead><tr><th style={{ width: 90 }}>Action</th><th style={{ width: 140 }}>Chain</th><th style={{ width: 200 }}>Provider</th><th style={{ width: 150 }}>Adapter</th><th>Enforcement</th></tr></thead>
                <tbody>
                  {sm.execution.map((e) => (
                    <tr key={`${e.action}-${e.chain}`}>
                      <td className="cl-mono">{e.action}</td>
                      <td>{chainLabel(e.chain)}</td>
                      <td><span className="cl-mono">{e.providerId}</span><div className="cl-meta">{e.providerVersion}</div></td>
                      <td>{e.adapter ? `${e.adapter.name} v${e.adapter.version}` : '—'}</td>
                      <td style={{ whiteSpace: 'normal' }}><ul style={{ margin: 0, paddingLeft: 16 }}>{e.enforcement.map((x) => <li key={x}>{x}</li>)}</ul></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </Section>
      ) : null}
      <Section label="Failure behaviour">
        <Card>
          <KeyValue rows={Object.entries(sm.failureBehaviour).map(([k, v]) => ({ label: k, value: v }))} />
          {sm.capabilitiesNotAvailable.length ? <p className="cl-meta" style={{ marginTop: 10 }}>Not available to this agent: {sm.capabilitiesNotAvailable.join(', ')}</p> : null}
          <p className="cl-meta" style={{ marginTop: 6, whiteSpace: 'normal' }}>{sm.upstreamChangePolicy}</p>
        </Card>
      </Section>
    </>
  );
}

function ClaimList({ title, tone, items }: { title: string; tone: Tone; items: string[] }) {
  return (
    <div>
      <div className="cl-row" style={{ gap: 6, marginBottom: 6 }}><span className="cl-label">{title}</span><Badge tone={items.length ? tone : 'neutral'}>{items.length}</Badge></div>
      {items.length ? <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13 }}>{items.map((x) => <li key={x} style={{ marginBottom: 3 }}>{x}</li>)}</ul> : <span className="cl-dim">—</span>}
    </div>
  );
}

function Evidence({ s, sm, registry, dep, reality }: { s: ProjectSummary; sm: SelfModel | undefined; registry: ReturnType<typeof useRegistry>; dep: ReturnType<typeof useDeployment>; reality: ReturnType<typeof useReality> }) {
  const used = new Set((sm?.providers ?? []).map((p) => p.providerId));
  const rows = (registry.data ?? []).filter((r) => used.has(r.providerId));
  const d = dep.data?.deployment ?? null;
  const txEvents = (dep.data?.events ?? []).filter((e) => e.tx && e.chain);
  const r = reality.data;
  const failedProbes = r?.probes.filter((p) => !p.ok) ?? [];
  return (
    <>
      <Section label="Registry evidence for the providers used">
        {!sm || registry.isLoading ? <Skeleton height={80} /> : rows.length === 0 ? (
          <Card><p className="cl-meta">{registry.isError ? (registry.error as Error).message : 'No registry entries match the providers this agent uses.'}</p></Card>
        ) : (
          <Card flush>
            <div className="cl-table-scroll">
              <table className="cl-table">
                <thead><tr><th style={{ width: 170 }}>Provider</th><th style={{ width: 160 }}>Registry status</th><th style={{ width: 160 }}>Implementation</th><th>Evidence</th></tr></thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.providerId}>
                      <td className="cl-mono">{p.providerId}<div className="cl-meta">{p.kind}</div></td>
                      <td><Badge tone={PROVIDER_TONE[p.status] ?? 'neutral'}>{p.status}</Badge>{p.statusNote ? <div className="cl-meta" style={{ whiteSpace: 'normal', marginTop: 4 }}>{p.statusNote}</div> : null}</td>
                      <td><Badge tone={PROVIDER_TONE[p.implementation.status] ?? 'neutral'}>{p.implementation.status}</Badge></td>
                      <td style={{ whiteSpace: 'normal' }}>{p.implementation.evidence.length ? <ul style={{ margin: 0, paddingLeft: 16 }}>{p.implementation.evidence.map((e) => <li key={e} className="cl-mono" style={{ fontSize: 11.5 }}>{e}</li>)}</ul> : <span className="cl-dim">none recorded</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </Section>

      <Section label="Deployment transactions" actions={<Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/deployments`}>Open Deployments</Link>}>
        {dep.isLoading ? <Skeleton height={60} /> : !d ? (
          <Card><p className="cl-meta">Not deployed, so there are no on-chain transactions to cite yet.</p></Card>
        ) : (
          <Card flush title={<span className="cl-row" style={{ gap: 8 }}>Deployment <StatusBadge status={d.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING'} label={d.status} /> <span className="cl-meta">revision {d.blueprintRevision}</span></span>}>
            <div className="cl-table-scroll">
              <table className="cl-table">
                <thead><tr><th style={{ width: 150 }}>Chain</th><th>Account</th><th>Deploy</th><th>Install</th><th>Activate</th></tr></thead>
                <tbody>
                  {Object.entries(d.chains).map(([chain, c]) => (
                    <tr key={chain}>
                      <td>{chainLabel(chain)}</td>
                      <td>{c.account ? <a className="cl-link cl-mono" href={explorerAccount(chain, c.account)} target="_blank" rel="noreferrer">{c.account.slice(0, 10)}… <ExternalLink size={11} aria-hidden /></a> : '—'}</td>
                      {[c.deployTx, c.install, c.activate].map((tx, i) => (
                        <td key={i}>{tx ? <a className="cl-link cl-mono" href={explorerTx(chain, tx)} target="_blank" rel="noreferrer">{tx.slice(0, 10)}… <ExternalLink size={11} aria-hidden /></a> : <span className="cl-dim">—</span>}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {txEvents.length ? (
              <div style={{ padding: 12 }}>
                <div className="cl-label" style={{ marginBottom: 6 }}>Recorded transactions · {txEvents.length}</div>
                <KeyValue rows={txEvents.map((e, i) => ({ label: `${e.type} #${i + 1}`, value: <a className="cl-link cl-mono" href={explorerTx(e.chain!, e.tx!)} target="_blank" rel="noreferrer">{chainLabel(e.chain!)} · {e.tx!.slice(0, 14)}… <ExternalLink size={11} aria-hidden /></a> }))} />
              </div>
            ) : null}
          </Card>
        )}
      </Section>

      <Section label="Reality probes" actions={<Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/reality`}>Open Reality Lab</Link>}>
        {reality.isLoading ? <Skeleton height={80} /> : !r ? (
          <Card><p className="cl-meta">{reality.isError ? `Probes could not run: ${(reality.error as Error).message}` : 'No probe result.'}</p></Card>
        ) : (
          <div className="cl-grid cl-grid-2">
            <Card title="Contracts on the live testnets">
              <KeyValue
                rows={[
                  ...r.heads.map((h) => ({ label: `${chainLabel(h.chain)} head`, value: h.error ? <Badge tone="deny">{h.error}</Badge> : <span className="cl-mono">{h.head ?? '—'}</span> })),
                  { label: 'Probes passing', value: <StatusBadge status={failedProbes.length ? 'FAIL' : 'PASS'} label={`${r.probes.length - failedProbes.length}/${r.probes.length}`} /> },
                  { label: 'Agent accounts', value: r.deployed ? Object.entries(r.accounts).map(([c, a]) => `${chainLabel(c)}: ${a ? a.slice(0, 10) + '…' : '—'}`).join(' · ') : 'not deployed' },
                ]}
              />
              {failedProbes.length ? (
                <div style={{ marginTop: 10 }}>
                  <div className="cl-label" style={{ marginBottom: 4 }}>Failing</div>
                  {failedProbes.map((p) => <div key={`${p.chain}-${p.label}`} className="cl-meta" style={{ whiteSpace: 'normal' }}>{chainLabel(p.chain)} · {p.label}: {p.detail}</div>)}
                </div>
              ) : null}
            </Card>
            <Card title={`Refusal probes · ${r.refusals.length}`}>
              {r.refusals.length === 0 ? (
                <p className="cl-meta">{r.deployed ? 'No refusal probes returned.' : 'Refusal probes run against the deployed account; this agent is not deployed.'}</p>
              ) : (
                <KeyValue rows={r.refusals.map((x) => ({ label: `${chainLabel(x.chain)} · ${x.probe}`, value: <span><StatusBadge status={x.refused ? 'PASS' : 'FAIL'} label={x.refused ? 'refused' : 'NOT refused'} /> <span className="cl-meta">{x.detail}</span></span> }))} />
              )}
            </Card>
          </div>
        )}
      </Section>
    </>
  );
}

/* ------------------------------------------------------------ print view */

const PRINT_CSS = `
.kr-print{position:fixed;inset:0;z-index:10000;overflow:auto;background:#fff;color:#111;font:13px/1.5 system-ui,-apple-system,sans-serif}
.kr-print-inner{max-width:900px;margin:0 auto;padding:32px 28px 60px}
.kr-print h1{font-size:24px;margin:0 0 4px}.kr-print h2{font-size:16px;margin:26px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}
.kr-print table{width:100%;border-collapse:collapse;margin:6px 0}.kr-print th,.kr-print td{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top;font-size:12px}
.kr-print th{background:#f3f3f3}.kr-print *{color:#111}.kr-print td{word-break:break-word}.kr-print .mono{white-space:pre-line;font-family:ui-monospace,monospace;font-size:11.5px;word-break:break-all}.kr-print .muted,.kr-print .muted *{color:#666}
.kr-print-bar{position:sticky;top:0;display:flex;gap:8px;justify-content:flex-end;padding:10px 16px;background:#f7f7f7;border-bottom:1px solid #ddd}
.kr-print-bar button{font:inherit;padding:6px 12px;border:1px solid #bbb;border-radius:6px;background:#fff;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
@media print{
  html,body{height:auto!important;overflow:visible!important;background:#fff!important}
  body>*:not(.kr-print){display:none!important}
  .kr-print{position:static;overflow:visible}.kr-print-bar{display:none}
  .kr-print tr{break-inside:avoid}
}`;

function PrintView({ report, onClose }: { report: ReturnType<typeof reportOf>; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const T = ({ head, rows }: { head: string[]; rows: ReactNode[][] }) => (
    <table><thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.length ? rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>) : <tr><td colSpan={head.length} className="muted">none</td></tr>}</tbody></table>
  );
  const p = report.project;
  return createPortal(
    <div className="kr-print" role="dialog" aria-label="Print view">
      <style>{PRINT_CSS}</style>
      <div className="kr-print-bar">
        <button type="button" onClick={() => window.print()}><Printer size={14} aria-hidden />Print</button>
        <button type="button" onClick={onClose}><X size={14} aria-hidden />Close</button>
      </div>
      <div className="kr-print-inner">
        <h1>Kido Safety Report: {p.name}</h1>
        <div className="muted">Revision {p.revision ?? '—'} · exported {new Date(report.exportedAt).toLocaleString()}</div>
        <table><tbody>
          <tr><th>Project</th><td className="mono">{p.id}</td></tr>
          <tr><th>Agent id</th><td className="mono">{p.agentId ?? '—'}</td></tr>
          <tr><th>Blueprint hash</th><td className="mono">{p.blueprintHash ?? '—'}</td></tr>
          <tr><th>Objective</th><td>{p.objective}</td></tr>
          <tr><th>Chains</th><td>{p.chains.map(chainLabel).join(', ')}</td></tr>
        </tbody></table>

        <h2>Verdict</h2>
        <T head={['Check', 'Status', 'Detail', 'Generated']} rows={report.verdict.map((v) => [v.label, v.status, v.detail, v.generatedAt ? new Date(v.generatedAt).toLocaleString() : '—'])} />
        {report.blockers.length ? <T head={['Blocker', 'Detail']} rows={report.blockers.map((b) => [b.code, b.detail])} /> : null}

        <h2>Security findings</h2>
        <T head={['Id', 'Class', 'Severity', 'Blocking', 'Evidence']} rows={(report.security?.findings ?? []).map((f) => [f.id, f.class, f.severity, f.blocking ? 'yes' : 'no', f.evidence])} />

        <h2>Simulation</h2>
        <T head={['Scenario', 'Family', 'Expected', 'Actual', 'Code', 'Result', 'Note']} rows={(report.simulation?.results ?? []).map((r) => [r.id, r.family, r.expected, r.actual, r.code ?? '—', r.passed ? 'PASS' : 'FAIL', r.note])} />

        <h2>Providers</h2>
        <T head={['Provider', 'Role', 'Status', 'Proven', 'Not proven / does not provide']} rows={(report.providers ?? []).map((x) => [x.providerId, x.role, x.status, x.proven.join('; ') || '—', [...x.notProven, ...x.doesNotProvide].join('; ') || '—'])} />
        {report.failureBehaviour ? <T head={['Failure', 'Behaviour']} rows={Object.entries(report.failureBehaviour).map(([k, v]) => [k, v])} /> : null}

        <h2>Evidence</h2>
        <T head={['Provider', 'Status', 'Evidence']} rows={report.evidence.registry.map((e) => [e.providerId, `${e.status} / ${e.implementationStatus}`, <span key="e" className="mono">{e.evidence.join('\n') || '—'}</span>])} />
        {report.evidence.deployment?.deployment ? (
          <T head={['Chain', 'Account', 'Deploy tx', 'Install tx', 'Activate tx']} rows={Object.entries(report.evidence.deployment.deployment.chains).map(([c, x]) => [chainLabel(c), <span key="a" className="mono">{x.account ?? '—'}</span>, <span key="d" className="mono">{x.deployTx ?? '—'}</span>, <span key="i" className="mono">{x.install ?? '—'}</span>, <span key="v" className="mono">{x.activate ?? '—'}</span>])} />
        ) : <p className="muted">Not deployed.</p>}
        {report.evidence.reality ? (
          <p>Reality probes: {report.evidence.reality.probes.filter((x) => x.ok).length}/{report.evidence.reality.probes.length} contract probes passing; {report.evidence.reality.refusals.length} refusal probe(s).</p>
        ) : <p className="muted">Reality probes not available.</p>}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ page */

function Report({ s }: { s: ProjectSummary }) {
  const [tab, setTab] = useState<Tab>('summary');
  const [printing, setPrinting] = useState(false);
  const sm = useSelfModel(s.projectId, Boolean(s.blueprint));
  const registry = useRegistry();
  const dep = useDeployment(s.projectId);
  const reality = useReality(s.projectId);
  const report = useMemo(() => reportOf(s, sm.data, registry.data, dep.data, reality.data), [s, sm.data, registry.data, dep.data, reality.data]);
  const json = useMemo(() => JSON.stringify(report, null, 2), [report]);
  const downloadJson = () => download(`kido-safety-report-${s.projectId}-r${s.revision ?? 0}.json`, json, 'application/json');

  if (!s.blueprint) return <NotYet what="report" where="composer" id={s.projectId} />;
  const checks = checksOf(s);
  const findings = s.security?.findings.length ?? 0;
  const failed = s.simulation?.results.filter((r) => !r.passed).length ?? 0;

  return (
    <>
      <div className="cl-row cl-row-wrap" style={{ gap: 6, marginBottom: 12 }}>
        {checks.map((c) => <StatusBadge key={c.key} status={c.status} label={`${c.label}: ${c.status.toLowerCase()}`} />)}
        <span className="cl-spacer" />
        <button type="button" className="cl-btn cl-btn-sm" onClick={downloadJson}><FileJson size={12} aria-hidden />Download JSON</button>
        <button type="button" className="cl-btn cl-btn-sm" onClick={() => setPrinting(true)}><Printer size={12} aria-hidden />Print view</button>
      </div>
      <TabStrip<Tab>
        tabs={[
          { id: 'summary', label: 'Summary' },
          { id: 'findings', label: 'Findings', badge: <Badge tone={s.security?.blocking ? 'deny' : 'neutral'}>{findings}</Badge> },
          { id: 'simulation', label: 'Simulation', badge: failed ? <Badge tone="deny">{failed} failed</Badge> : undefined },
          { id: 'providers', label: 'Providers', badge: sm.data ? <Badge tone="neutral">{sm.data.providers.length}</Badge> : undefined },
          { id: 'evidence', label: 'Evidence' },
          { id: 'export', label: 'Export' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'summary' ? <Summary s={s} sm={sm.data} go={setTab} /> : null}
      {tab === 'findings' ? <Findings s={s} /> : null}
      {tab === 'simulation' ? <Simulation s={s} /> : null}
      {tab === 'providers' ? <Providers sm={sm.data} error={sm.isError ? (sm.error as Error).message : null} /> : null}
      {tab === 'evidence' ? <Evidence s={s} sm={sm.data} registry={registry} dep={dep} reality={reality} /> : null}
      {tab === 'export' ? (
        <Section label="Export">
          <div className="cl-grid cl-grid-2">
            <Card title="JSON">
              <p className="cl-body" style={{ marginBottom: 10 }}>The whole report: verdict, findings, every scenario, providers with what they have and have not proven, execution paths, failure behaviour, registry evidence, deployment record and reality probes.</p>
              <button type="button" className="cl-btn cl-btn-primary" onClick={downloadJson}><FileJson size={13} aria-hidden />Download JSON · {(json.length / 1024).toFixed(1)} KB</button>
            </Card>
            <Card title="Print or save as PDF">
              <p className="cl-body" style={{ marginBottom: 10 }}>A plain black-on-white layout of the same report, without the workbench around it. Use your browser&apos;s print dialog to print it or save it as a PDF.</p>
              <button type="button" className="cl-btn" onClick={() => setPrinting(true)}><Printer size={13} aria-hidden />Open print view</button>
            </Card>
          </div>
          <p className="cl-meta" style={{ margin: '10px 0' }}>
            {[sm.isLoading && 'self-model', registry.isLoading && 'registry', dep.isLoading && 'deployment', reality.isLoading && 'reality probes'].filter(Boolean).length
              ? `Still loading: ${[sm.isLoading && 'self-model', registry.isLoading && 'registry', dep.isLoading && 'deployment', reality.isLoading && 'reality probes'].filter(Boolean).join(', ')}. Those parts export as null until they arrive.`
              : 'Every section is loaded.'}{' '}
            The report holds no secrets: the backend never returns private thresholds or keys.
          </p>
          <Card title="Preview" flush>
            <pre className="cl-mono" data-lenis-prevent style={{ margin: 0, padding: 12, maxHeight: 420, overflow: 'auto', fontSize: 11.5, whiteSpace: 'pre' }}>{json}</pre>
          </Card>
        </Section>
      ) : null}
      {printing ? <PrintView report={report} onClose={() => setPrinting(false)} /> : null}
    </>
  );
}

export default function ReportsPage() {
  const { s } = useKido();
  return (
    <StudioPage segment="reports" badges={s ? <><Badge tone="neutral">{s.name}</Badge><Badge tone="neutral">revision {s.revision ?? '—'}</Badge></> : undefined}>
      <WithProject>{(s) => <Report s={s} />}</WithProject>
    </StudioPage>
  );
}
