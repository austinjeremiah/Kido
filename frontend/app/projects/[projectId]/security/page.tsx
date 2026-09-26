'use client';

/**
 * Permissions & Security: what can this agent do, where, and within what bounds — and what can it
 * never do.
 *
 * The permission matrix is derived, not declared: rows are every action Kido knows about for this
 * agent (allowed, forbidden, the self-model's execution routes and its capabilities-not-available),
 * columns are the blueprint's chains, and each cell says whether the action is granted there, with
 * the on-chain limits and the enforcement Amane applies. Below it: who the agent may pay, the
 * deterministic security review (findings by class and severity, blocking flags, evidence), and the
 * self-model's statement of what fails closed and how. Changing authority is not offered here — it is
 * a blueprint edit followed by a recompile.
 */
import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Ban, Check, Minus } from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, Card, CopyButton, EmptyState, Section, SeverityBadge, Skeleton, Spec } from '@/components/studio/primitives';
import { GateButton, NotYet, WithProject } from '@/components/studio/kido';
import { RecordTable, StaleArtifacts, whenText } from '@/components/studio/blueprint/shared';
import { useSelfModel } from '@/lib/kido/hooks';
import { amount, chainLabel, explorerAccount, labelOfKey, windowLabel } from '@/lib/kido/format';
import type { Blueprint, PayeeSpec, ProjectSummary, SecurityFinding, SelfModel } from '@/lib/kido/types';
import type { Severity } from '@/lib/studio/types';

const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

type CellState = 'ALLOWED' | 'FORBIDDEN' | 'NO_ROUTE' | 'NOT_AVAILABLE' | 'NOT_GRANTED';
type Cell = { state: CellState; exec?: SelfModel['execution'][number]; limits: Blueprint['authority']['limits']; why: string };

const CELL_TONE: Record<CellState, 'pass' | 'deny' | 'warn' | 'blocked' | 'neutral'> = { ALLOWED: 'pass', FORBIDDEN: 'deny', NO_ROUTE: 'warn', NOT_AVAILABLE: 'blocked', NOT_GRANTED: 'neutral' };
const CELL_LABEL: Record<CellState, string> = { ALLOWED: 'Allowed', FORBIDDEN: 'Forbidden', NO_ROUTE: 'Allowed, no route', NOT_AVAILABLE: 'Not available', NOT_GRANTED: 'Not granted' };
const CELL_ICON: Record<CellState, ReactNode> = { ALLOWED: <Check size={12} aria-hidden />, FORBIDDEN: <Ban size={12} aria-hidden />, NO_ROUTE: <Minus size={12} aria-hidden />, NOT_AVAILABLE: <Minus size={12} aria-hidden />, NOT_GRANTED: <Minus size={12} aria-hidden /> };

function matrixOf(bp: Blueprint, sm: SelfModel | undefined) {
  const a = bp.authority;
  const exec = sm?.execution ?? [];
  const notAvail = new Set(sm?.capabilitiesNotAvailable ?? []);
  const actions = [...new Set([...a.allowedActions, ...bp.actions.map((x) => x.action), ...exec.map((x) => x.action), ...a.forbiddenActions, ...(sm?.capabilitiesNotAvailable ?? [])])];
  const chains = bp.chains.length ? bp.chains : [...new Set(exec.map((x) => x.chain))];
  const cell = (action: string, chain: string): Cell => {
    const e = exec.find((x) => x.action === action && x.chain === chain);
    const limits = a.limits.filter((l) => l.chain === chain);
    if (a.forbiddenActions.includes(action)) return { state: 'FORBIDDEN', limits: [], why: 'forbidden by the blueprint; never granted to the agent' };
    if (a.allowedActions.includes(action)) {
      if (e) return { state: 'ALLOWED', exec: e, limits, why: `granted; executed through ${e.providerId}${e.adapter ? ` · ${e.adapter.name} v${e.adapter.version}` : ''}` };
      const routed = bp.actions.some((x) => x.action === action && x.chain === chain);
      return { state: 'NO_ROUTE', limits, why: routed ? 'granted, but no execution adapter is reported for this chain' : 'granted, but not routed on this chain' };
    }
    if (notAvail.has(action)) return { state: 'NOT_AVAILABLE', limits: [], why: 'not in the owner policy; the agent has no way to perform it' };
    return { state: 'NOT_GRANTED', limits: [], why: 'not granted' };
  };
  return { actions, chains, cell };
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

function Findings({ s }: { s: ProjectSummary }) {
  const [sev, setSev] = useState<Severity | 'ALL'>('ALL');
  const [blockingOnly, setBlockingOnly] = useState(false);
  const report = s.security;
  const findings = report?.findings ?? [];
  const shown = findings.filter((f) => (sev === 'ALL' || f.severity === sev) && (!blockingOnly || f.blocking));
  const byClass = useMemo(() => {
    const m = new Map<string, SecurityFinding[]>();
    for (const f of shown) m.set(f.class, [...(m.get(f.class) ?? []), f]);
    return [...m.entries()].sort((x, y) => SEVERITIES.indexOf(x[1][0]!.severity as Severity) - SEVERITIES.indexOf(y[1][0]!.severity as Severity));
  }, [shown]);

  if (!report) return <EmptyState title="Not reviewed yet" body="The deterministic security review runs over the blueprint and every compiled plan. Run it for this revision." action={<GateButton gate="securityReview" primary />} />;
  return (
    <>
      <div className="cl-row cl-row-wrap" style={{ gap: 8, marginBottom: 12 }}>
        <Badge tone={report.blocking ? 'deny' : 'pass'} chip>{report.blocking ? 'blocking' : 'not blocking'}</Badge>
        <Badge tone={report.freshness === 'CURRENT' ? 'pass' : 'warn'}>{report.freshness} · r{report.blueprintRevision}</Badge>
        <span className="cl-meta">generated {whenText(report.generatedAt)}</span>
        <span className="cl-spacer" />
        <div className="cl-btn-group" role="group" aria-label="Severity filter">
          {(['ALL', ...SEVERITIES] as const).map((x) => {
            const n = x === 'ALL' ? findings.length : findings.filter((f) => f.severity === x).length;
            return (
              <button key={x} type="button" className="cl-btn cl-btn-sm" aria-pressed={sev === x} style={sev === x ? { borderColor: 'var(--cl-ink)', fontWeight: 600 } : undefined} onClick={() => setSev(x)} disabled={x !== 'ALL' && n === 0}>
                {x === 'ALL' ? 'All' : x} ({n})
              </button>
            );
          })}
        </div>
        <label className="cl-row" style={{ gap: 5, fontSize: 12.5 }}>
          <input type="checkbox" checked={blockingOnly} onChange={(e) => setBlockingOnly(e.target.checked)} />
          Blocking only
        </label>
      </div>
      {findings.length === 0 ? (
        <BlockerBanner tone="pass" title={`No findings for Blueprint r${report.blueprintRevision}`}>
          No build blocker, unbounded approval, arbitrary recipient or target, authority expansion, missing adapter, privacy leak, stale-data fallback or version drift was found.
        </BlockerBanner>
      ) : shown.length === 0 ? (
        <p className="cl-meta">No finding matches the filter.</p>
      ) : (
        byClass.map(([cls, list]) => (
          <Card key={cls} title={<span className="cl-row" style={{ gap: 8 }}>{labelOfKey(cls)} <span className="cl-meta cl-mono">{cls}</span></span>} actions={<span className="cl-meta">{list.length}</span>} flush>
            <table className="cl-table">
              <thead>
                <tr><th>Finding</th><th>Severity</th><th>Blocking</th><th>Evidence</th></tr>
              </thead>
              <tbody>
                {list.map((f) => (
                  <tr key={f.id}>
                    <td className="cl-mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{f.id}</td>
                    <td><SeverityBadge severity={f.severity as Severity} /></td>
                    <td>{f.blocking ? <Badge tone="deny">blocking</Badge> : <Badge tone="neutral">advisory</Badge>}</td>
                    <td style={{ whiteSpace: 'normal' }}>{f.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))
      )}
    </>
  );
}

function SecurityBody({ s, bp }: { s: ProjectSummary; bp: Blueprint }) {
  const smQ = useSelfModel(s.projectId);
  const sm = smQ.data;
  const a = bp.authority;
  const { actions, chains, cell } = matrixOf(bp, sm);
  const [focus, setFocus] = useState<{ action: string; chain: string } | null>(null);
  const amt = (v: string, asset: string, chain: string) => amount(v, asset, chain, bp.assets);
  const f = focus ? cell(focus.action, focus.chain) : null;
  const findings = s.security?.findings ?? [];

  return (
    <>
      <StaleArtifacts s={s} only={['security']} />
      {s.security?.blocking ? <BlockerBanner tone="deny" title="The security review is blocking">{findings.filter((x) => x.blocking).length} blocking finding(s). Simulation and build stay closed until the blueprint is changed and re-reviewed.</BlockerBanner> : null}
      {smQ.error ? <BlockerBanner tone="warn" title="Self-model unavailable">{(smQ.error as Error).message}. The matrix falls back to the blueprint alone.</BlockerBanner> : null}

      <Section label="Posture">
        <div className="cl-posture">
          <Posture label="Review" value={s.security ? <Badge tone={s.security.blocking ? 'deny' : 'pass'} large>{s.security.blocking ? 'Blocking' : `${findings.length} finding${findings.length === 1 ? '' : 's'}`}</Badge> : <Badge tone="blocked" large>Not run</Badge>} />
          <Posture label="Mode" value={<Badge tone="neutral" large>{a.mode ? labelOfKey(a.mode.toLowerCase()) : '—'}</Badge>} />
          <Posture label="Enforced by" value={<Badge tone={a.provider === 'AMANE' ? 'pass' : 'neutral'} large>{a.provider === 'AMANE' ? 'Amane on-chain' : a.provider === 'OWNER_WALLET' ? 'Owner wallet' : 'None'}</Badge>} />
          <Posture label="Amane account" value={sm ? <Badge tone={sm.authority.amaneActive ? 'pass' : 'warn'} large>{sm.authority.amaneActive ? 'Active' : 'Not active'}</Badge> : <Skeleton width={80} height={20} />} />
          <Posture label="Revision" value={<Badge tone="data" large>r{bp.revision}</Badge>} />
        </div>
      </Section>

      <Section label="Permission matrix" actions={<span className="cl-meta">{actions.length} actions × {chains.length} chain{chains.length === 1 ? '' : 's'}</span>}>
        {smQ.isLoading ? <Skeleton height={120} /> : (
          <>
            <div className="cl-table-scroll">
              <table className="cl-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    {chains.map((c) => <th key={c}>{chainLabel(c)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {actions.map((act) => (
                    <tr key={act}>
                      <td className="cl-strong cl-mono">{act}</td>
                      {chains.map((c) => {
                        const x = cell(act, c);
                        const on = focus?.action === act && focus.chain === c;
                        return (
                          <td key={c} data-clickable="true" onClick={() => setFocus(on ? null : { action: act, chain: c })} style={{ cursor: 'pointer', background: on ? 'var(--cl-sel)' : undefined }} title={x.why}>
                            <span className="cl-badge" data-tone={CELL_TONE[x.state]}>{CELL_ICON[x.state]}{CELL_LABEL[x.state]}</span>
                            {x.state === 'ALLOWED' || x.state === 'NO_ROUTE'
                              ? x.limits.map((l) => (
                                  <div key={l.asset} className="cl-meta" style={{ fontSize: 11.5, marginTop: 4 }}>
                                    {amt(l.perAction, l.asset, l.chain)} / action · {amt(l.perWindow, l.asset, l.chain)} / {windowLabel(l.windowSeconds)} · {amt(l.total, l.asset, l.chain)} total
                                  </div>
                                ))
                              : null}
                            {x.state === 'ALLOWED' && !x.limits.length ? <div className="cl-meta" style={{ fontSize: 11.5 }}>no limit on this chain</div> : null}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cl-row cl-row-wrap" style={{ gap: 10, marginTop: 8 }}>
              {(Object.keys(CELL_LABEL) as CellState[]).map((k) => <span key={k} className="cl-badge" data-tone={CELL_TONE[k]}>{CELL_ICON[k]}{CELL_LABEL[k]}</span>)}
              <span className="cl-meta">Select a cell for its enforcement.</span>
            </div>
            {focus && f ? (
              <Card title={`${focus.action} on ${chainLabel(focus.chain)}`} actions={<span className="cl-badge" data-tone={CELL_TONE[f.state]}>{CELL_LABEL[f.state]}</span>}>
                <Spec
                  rows={[
                    { key: 'why', label: 'Why', value: f.why },
                    ...(f.exec ? [
                      { key: 'provider', label: 'Provider', value: `${f.exec.providerId} · ${f.exec.providerVersion}` },
                      { key: 'adapter', label: 'Adapter', value: f.exec.adapter ? `${f.exec.adapter.name} v${f.exec.adapter.version}` : 'none' },
                      { key: 'enf', label: 'Enforcement', value: <ul style={{ margin: 0, paddingLeft: 16 }}>{f.exec.enforcement.map((e) => <li key={e}>{e}</li>)}</ul> },
                    ] : []),
                    ...f.limits.map((l) => ({ key: `l-${l.asset}`, label: `Limit · ${l.asset}`, value: `${amt(l.perAction, l.asset, l.chain)} per action · ${amt(l.perWindow, l.asset, l.chain)} per ${windowLabel(l.windowSeconds)} · ${amt(l.total, l.asset, l.chain)} total` })),
                  ]}
                />
              </Card>
            ) : null}
          </>
        )}
      </Section>

      <Section label="Enforcement by action">
        {sm?.execution.length ? (
          <div className="cl-grid cl-grid-2" style={{ gap: 12 }}>
            {sm.execution.map((e) => (
              <Card key={`${e.action}${e.chain}`} title={<span className="cl-row" style={{ gap: 8 }}><span className="cl-mono">{e.action}</span><span className="cl-meta">{chainLabel(e.chain)}</span></span>} actions={<Badge tone="neutral">{e.providerId}</Badge>}>
                <div className="cl-meta" style={{ marginBottom: 6 }}>{e.adapter ? `${e.adapter.name} v${e.adapter.version}` : 'no adapter'} · {e.providerVersion}</div>
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {e.enforcement.map((x) => <li key={x} className="cl-body" style={{ margin: '3px 0' }}>{x}</li>)}
                </ul>
                {Object.keys(e.upstream ?? {}).length ? <pre className="cl-mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', marginTop: 8 }}>{JSON.stringify(e.upstream, null, 2)}</pre> : null}
              </Card>
            ))}
          </div>
        ) : (
          <p className="cl-meta">{smQ.isLoading ? 'Loading…' : 'No execution routes: the agent cannot act on any chain.'}</p>
        )}
      </Section>

      <Section label="Who it can pay">
        <div className="cl-subsection" style={{ marginBottom: 16 }}>
          <div className="cl-subsection-head"><span className="cl-label">Payees</span><span className="cl-subsection-rule" /><span className="cl-meta cl-subsection-note">payments go only here</span></div>
          <PayeeTable rows={a.payees} chains={bp.chains} empty="No payees: the agent cannot pay anyone." />
        </div>
        <div className="cl-subsection" style={{ marginBottom: 16 }}>
          <div className="cl-subsection-head"><span className="cl-label">Beneficiaries</span><span className="cl-subsection-rule" /><span className="cl-meta cl-subsection-note">repayments reduce only these positions</span></div>
          <PayeeTable rows={a.beneficiaries} chains={bp.chains} empty="No beneficiaries." />
        </div>
        {sm?.authority.limits.length ? (
          <div className="cl-subsection">
            <div className="cl-subsection-head"><span className="cl-label">Limits in words</span><span className="cl-subsection-rule" /></div>
            <Spec rows={sm.authority.limits.map((l) => ({ key: `${l.chain}${l.asset}`, label: `${chainLabel(l.chain)} · ${l.asset}`, value: l.readable ?? `${amt(l.perAction, l.asset, l.chain)} per action` }))} />
          </div>
        ) : null}
      </Section>

      <Section label="Security review" actions={<GateButton gate="securityReview" label="Re-run review" />}>
        <Findings s={s} />
      </Section>

      <Section label="Assertions">
        <RecordTable rows={bp.securityAssertions} empty="No security assertions declared." />
      </Section>

      <Section label="Failure behaviour">
        {sm ? (
          <div className="cl-grid cl-grid-2" style={{ gap: 16 }}>
            <div>
              <div className="cl-label" style={{ marginBottom: 8 }}>When something fails</div>
              <Spec rows={Object.entries(sm.failureBehaviour).map(([k, v]) => ({ key: k, label: labelOfKey(k.replace(/([A-Z])/g, ' $1')), value: v }))} />
            </div>
            <div>
              <div className="cl-label" style={{ marginBottom: 8 }}>Capabilities not available</div>
              <div className="cl-row cl-row-wrap" style={{ gap: 5, marginBottom: 12 }}>
                {sm.capabilitiesNotAvailable.length ? sm.capabilitiesNotAvailable.map((c) => <Badge key={c} tone="blocked">{c}</Badge>) : <span className="cl-meta">None</span>}
              </div>
              <div className="cl-label" style={{ marginBottom: 8 }}>Upstream change policy</div>
              <p className="cl-body" style={{ whiteSpace: 'normal', margin: 0 }}>{sm.upstreamChangePolicy}</p>
            </div>
          </div>
        ) : smQ.isLoading ? <Skeleton height={80} /> : <p className="cl-meta">Self-model unavailable.</p>}
      </Section>

      {sm?.providers.length ? (
        <Section label="Providers relied on">
          <div className="cl-grid cl-grid-2" style={{ gap: 12 }}>
            {sm.providers.map((p) => (
              <Card key={p.providerId} title={<span className="cl-row" style={{ gap: 8 }}>{p.providerId}<span className="cl-meta">{p.role}</span></span>} actions={<Badge tone={p.live ? 'pass' : 'warn'} title={p.statusMeaning}>{p.status}</Badge>}>
                <p className="cl-meta" style={{ whiteSpace: 'normal', marginTop: 0 }}>{p.statusMeaning}</p>
                {p.blocker ? <BlockerBanner tone="warn" title="Blocker">{p.blocker}</BlockerBanner> : null}
                <Spec
                  rows={[
                    { key: 'proven', label: 'Proven', value: p.proven.length ? <ul style={{ margin: 0, paddingLeft: 16 }}>{p.proven.map((x) => <li key={x}>{x}</li>)}</ul> : '—' },
                    { key: 'notProven', label: 'Not proven', value: p.notProven.join(', ') || '—' },
                    ...(p.doesNotProvide.length ? [{ key: 'dnp', label: 'Does not provide', value: p.doesNotProvide.join(', ') }] : []),
                  ]}
                />
              </Card>
            ))}
          </div>
        </Section>
      ) : null}

      <BlockerBanner tone="neutral" title="Changing authority happens on the Blueprint, on purpose" actions={<Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/blueprint`}>Open Blueprint</Link>}>
        This page states the boundary; it does not move it. Edit a requirement, recompile, and the review, simulation and build must be re-run before anything can be deployed.
      </BlockerBanner>
    </>
  );
}

function Posture({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="cl-label" style={{ marginBottom: 7 }}>{label}</div>
      {value}
    </div>
  );
}

export default function SecurityPage() {
  return (
    <StudioPage segment="security" subtitle="What can this agent do, where, within what bounds — and what can it never do?" actions={<GateButton gate="securityReview" primary label="Re-run review" />}>
      <WithProject>{(s) => (s.blueprint ? <SecurityBody s={s} bp={s.blueprint} /> : <NotYet what="blueprint" where="composer" id={s.projectId} />)}</WithProject>
    </StudioPage>
  );
}
