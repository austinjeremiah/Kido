'use client';

/**
 * Overview: where the agent is in its life (interview → blueprint → reviewed → simulated → built →
 * deployed → active), the one next action, what it is allowed to do per chain, how its accounts
 * read on-chain once deployed, what needs attention, recent activity, the health of the providers
 * it relies on, and a way into every section.
 *
 * Backed by the project summary, GET /deployment and /runtime (the chains' own readings), the
 * activity log, and the self-model. Alerts use the same rules as the Control Plane.
 */
import { useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, Card, KeyValue, Section, Skeleton, StatusBadge, useNow } from '@/components/studio/primitives';
import { GateButton, WithProject, nextGate, useKido } from '@/components/studio/kido';
import { useActivity, useDeployment, useRuntime, useSelfModel } from '@/lib/kido/hooks';
import { LEASE_STATUS, STAGE_LABEL, amount, chainLabel, explorerAccount, explorerTx, windowLabel } from '@/lib/kido/format';
import { NAV_GROUPS, PAGE_META } from '@/lib/studio/nav';
import type { ProjectSummary, Runtime, DeploymentStatus } from '@/lib/kido/types';
import type { Tone } from '@/lib/studio/types';
import { KIND_LABEL, alertsOf, relTime, timelineOf } from '@/components/studio/operate/derive';

const PROVIDER_TONE: Record<string, Tone> = { TESTNET_LIVE: 'pass', LIVE_ATTESTED: 'pass', IMPLEMENTED_LOCAL: 'data', SIMULATED: 'sim', NOT_IMPLEMENTED: 'neutral', BLOCKED_ENV: 'blocked', BLOCKED_AUTH: 'blocked', BLOCKED_UPSTREAM: 'blocked' };

type StepState = 'done' | 'current' | 'pending' | 'exception';
interface Step { key: string; label: string; state: StepState; detail: string; segment: string }

function stepsOf(s: ProjectSummary, dep: DeploymentStatus | undefined, rt: Runtime | undefined): Step[] {
  const sec = s.security, sim = s.simulation, b = s.build;
  const d = dep?.deployment ?? null;
  const leaseActive = rt?.deployed ? rt.chains.length > 0 && rt.chains.every((c) => c.leaseStatus === 1 && !c.paused) : false;
  const raw: Array<Omit<Step, 'state'> & { done: boolean; bad?: boolean }> = [
    { key: 'interview', label: 'Interview', segment: 'build', done: !s.interview.question, detail: s.interview.question ? `question ${s.interview.questionsAsked + 1}: ${s.interview.question.text}` : `${s.interview.questionsAsked} questions answered` },
    { key: 'blueprint', label: 'Blueprint', segment: 'blueprint', done: Boolean(s.blueprint), bad: s.blockers.length > 0, detail: s.blueprint ? `revision ${s.revision}${s.blockers.length ? ` · ${s.blockers.length} blocker(s)` : ''}` : 'not compiled' },
    { key: 'reviewed', label: 'Reviewed', segment: 'security', done: Boolean(sec && sec.freshness === 'CURRENT' && !sec.blocking), bad: Boolean(sec?.blocking), detail: sec ? `${sec.findings.length} finding(s) · ${sec.freshness.toLowerCase()}` : 'not run' },
    { key: 'simulated', label: 'Simulated', segment: 'simulation', done: Boolean(sim && sim.freshness === 'CURRENT' && sim.passed), bad: Boolean(sim && !sim.passed), detail: sim ? `${sim.results.filter((r) => r.passed).length}/${sim.results.length} passed · ${sim.freshness.toLowerCase()}` : 'not run' },
    { key: 'built', label: 'Built', segment: 'build', done: Boolean(b && b.freshness === 'CURRENT'), detail: b ? `build ${b.buildRevision} · ${b.freshness.toLowerCase()}` : 'not built' },
    { key: 'deployed', label: 'Deployed', segment: 'deploy', done: Boolean(d), detail: d ? `${d.status.toLowerCase().replace(/_/g, ' ')} · revision ${d.blueprintRevision}` : 'no deployment' },
    { key: 'active', label: 'Active', segment: 'runtime', done: d?.status === 'ACTIVE' && leaseActive, bad: d?.status === 'ACTIVE' && !leaseActive && Boolean(rt?.deployed), detail: d?.status === 'ACTIVE' ? (leaseActive ? 'lease active on every chain' : 'lease not active or paused on a chain') : 'policy not installed' },
  ];
  let seenCurrent = false;
  return raw.map((r) => {
    let state: StepState = 'pending';
    if (r.done) state = 'done';
    else if (!seenCurrent) {
      seenCurrent = true;
      state = r.bad ? 'exception' : 'current';
    }
    return { key: r.key, label: r.label, state, detail: r.detail, segment: r.segment };
  });
}

function NextAction({ s, dep }: { s: ProjectSummary; dep: DeploymentStatus | undefined }) {
  const base = `/projects/${s.projectId}`;
  const gate = nextGate(s);
  let title: string, body: ReactNode, action: ReactNode;
  if (s.interview.question) {
    title = 'Continue the interview';
    body = s.interview.question.text;
    action = <Link className="cl-btn cl-btn-primary" href={`${base}/build`}>Answer in the Composer</Link>;
  } else if (gate) {
    title = { finalize: 'Compile the blueprint', securityReview: 'Run the security review', simulate: 'Run the simulation', build: 'Build the agent' }[gate];
    body = 'The backend enforces the order; a refusal shows its reason under the button.';
    action = <GateButton gate={gate} primary />;
  } else if (s.security?.blocking) {
    title = 'Resolve the blocking findings';
    body = `${s.security.findings.filter((f) => f.blocking).length} blocking finding(s) stop the lifecycle. Change the answers they point to.`;
    action = <Link className="cl-btn cl-btn-primary" href={`${base}/security`}>Open the findings</Link>;
  } else if (s.simulation && !s.simulation.passed) {
    title = 'Fix the failing scenarios';
    body = `${s.simulation.results.filter((r) => !r.passed).length} scenario(s) did not behave as expected.`;
    action = <Link className="cl-btn cl-btn-primary" href={`${base}/simulation`}>Open the simulation</Link>;
  } else if (s.stage === 'BUILT' && !dep?.deployment) {
    title = 'Deploy';
    body = 'Create the Amane accounts and sign the policy from your wallet.';
    action = <Link className="cl-btn cl-btn-primary" href={`${base}/deploy`}>Open Deploy</Link>;
  } else if (dep?.deployment && dep.deployment.status !== 'ACTIVE') {
    title = 'Finish the deployment';
    body = `The deployment is at ${dep.deployment.status.toLowerCase().replace(/_/g, ' ')}.`;
    action = <Link className="cl-btn cl-btn-primary" href={`${base}/deploy`}>Continue in Deploy</Link>;
  } else if (dep?.deployment) {
    title = 'Operate';
    body = 'The agent is deployed. Watch its accounts and keep the owner controls at hand.';
    action = <Link className="cl-btn cl-btn-primary" href={`${base}/control-plane`}>Open the Control Plane</Link>;
  } else {
    title = 'Resolve in the Composer';
    body = s.blockers.map((b) => b.code).join(', ') || 'Nothing can advance automatically.';
    action = <Link className="cl-btn" href={`${base}/build`}>Open the Composer</Link>;
  }
  return (
    <Card title="Next action">
      <div className="cl-strong" style={{ fontSize: 15, marginBottom: 4 }}>{title}</div>
      <p className="cl-meta" style={{ whiteSpace: 'normal', marginBottom: 12 }}>{body}</p>
      {action}
    </Card>
  );
}

function Authority({ s }: { s: ProjectSummary }) {
  const a = s.blueprint?.authority;
  if (!a) return <Card title="Authority"><p className="cl-meta">Set once the blueprint compiles.</p></Card>;
  const assets = s.blueprint?.assets ?? [];
  const chains = [...new Set([...s.chains, ...a.limits.map((l) => l.chain)])];
  return (
    <Card title="Authority" actions={<Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/policies`}>Open Authority</Link>}>
      <KeyValue
        rows={[
          { label: 'Mode', value: a.mode ?? '—' },
          { label: 'Enforced by', value: a.provider === 'AMANE' ? 'Amane, on-chain' : a.provider === 'OWNER_WALLET' ? 'owner wallet' : '—' },
          { label: 'Allowed', value: a.allowedActions.length ? <span className="cl-row cl-row-wrap" style={{ gap: 4 }}>{a.allowedActions.map((x) => <Badge key={x} tone="pass">{x}</Badge>)}</span> : '—' },
          { label: 'Forbidden', value: a.forbiddenActions.length ? <span className="cl-row cl-row-wrap" style={{ gap: 4 }}>{a.forbiddenActions.map((x) => <Badge key={x} tone="deny">{x}</Badge>)}</span> : '—' },
          { label: 'Payees', value: `${a.payees.length} payee(s)${a.beneficiaries.length ? `, ${a.beneficiaries.length} beneficiar${a.beneficiaries.length === 1 ? 'y' : 'ies'}` : ''}${a.payees.length ? ` · ${a.payees.map((p) => p.label).join(', ')}` : ''}` },
          { label: 'Lease lifetime', value: a.leaseLifetimeSeconds ? windowLabel(a.leaseLifetimeSeconds) : '—' },
          { label: 'Bridging', value: a.bridgeAllowed === null ? '—' : a.bridgeAllowed ? 'allowed' : 'not allowed' },
        ]}
      />
      {chains.map((c) => {
        const ls = a.limits.filter((l) => l.chain === c);
        return (
          <div key={c} style={{ marginTop: 12 }}>
            <div className="cl-label" style={{ marginBottom: 4 }}>{chainLabel(c)} limits</div>
            {ls.length === 0 ? (
              <span className="cl-meta">No limits on this chain.</span>
            ) : (
              <table className="cl-table">
                <thead><tr><th>Asset</th><th>Per action</th><th>Per window</th><th>Total</th></tr></thead>
                <tbody>
                  {ls.map((l) => (
                    <tr key={l.asset}>
                      <td className="cl-mono">{l.asset}</td>
                      <td>{amount(l.perAction, l.asset, c, assets)}</td>
                      <td>{amount(l.perWindow, l.asset, c, assets)} / {windowLabel(l.windowSeconds)}</td>
                      <td>{amount(l.total, l.asset, c, assets)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function formatUnits(v: string, d: number) {
  if (!/^\d+$/.test(v)) return v;
  const s = v.padStart(d + 1, '0');
  const frac = d ? s.slice(-d).replace(/0+$/, '') : '';
  return `${s.slice(0, s.length - d).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
}

function RuntimeTiles({ s, rt, loading }: { s: ProjectSummary; rt: Runtime | undefined; loading: boolean }) {
  if (loading) return <Skeleton height={100} />;
  if (!rt?.deployed) return null;
  return (
    <Section label="On-chain accounts" actions={<Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/runtime`}>Open Runtime</Link>}>
      <div className="cl-grid cl-grid-tiles">
        {rt.chains.map((c) => (
          <Card key={c.chain} title={chainLabel(c.chain)} actions={c.error ? <Badge tone="deny">read failed</Badge> : c.paused ? <Badge tone="warn">paused</Badge> : <Badge tone={c.leaseStatus === 1 ? 'pass' : 'warn'}>lease {c.leaseStatus !== null ? LEASE_STATUS[c.leaseStatus] ?? c.leaseStatus : '—'}</Badge>}>
            {c.error ? <p className="cl-meta" style={{ color: 'var(--cl-deny)', whiteSpace: 'normal' }}>{c.error}</p> : null}
            <KeyValue
              rows={[
                { label: 'Account', value: c.account ? <a className="cl-link cl-mono" href={explorerAccount(c.chain, c.account)} target="_blank" rel="noreferrer">{c.account.slice(0, 10)}…</a> : '—' },
                { label: 'Policy version', value: c.policyVersion ?? '—' },
                { label: 'Paused', value: c.paused === null ? '—' : c.paused ? `yes (epoch ${c.pauseEpoch ?? '—'})` : 'no' },
                ...c.balances.map((b) => ({ label: b.symbol, value: <span className="cl-mono">{formatUnits(b.amount, b.decimals)}</span> })),
              ]}
            />
          </Card>
        ))}
      </div>
      <p className="cl-meta" style={{ marginTop: 8 }}>Read from the chains every 15 s{rt.leaseId ? ` · lease ${rt.leaseId.slice(0, 12)}…` : ''}.</p>
    </Section>
  );
}

function Recent({ s }: { s: ProjectSummary }) {
  const q = useActivity(s.projectId);
  const now = useNow(30_000);
  const events = useMemo(() => timelineOf(s, q.data ?? []).slice(0, 5), [s, q.data]);
  return (
    <Card title="Recent activity" actions={<Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/activity`}>Open Activity</Link>} flush>
      <table className="cl-table">
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td style={{ width: 110 }} className="cl-meta" title={e.at !== null ? new Date(e.at).toLocaleString() : 'time not recorded'}>{e.at !== null ? (now ? relTime(e.at, now) : '…') : 'untimed'}</td>
              <td style={{ width: 130 }}><Badge tone={e.tone}>{KIND_LABEL[e.kind]}</Badge></td>
              <td>
                <div className="cl-strong" style={{ fontSize: 13 }}>{e.title}</div>
                <div className="cl-meta cl-truncate" style={{ maxWidth: 420 }}>{e.detail}</div>
              </td>
              <td style={{ width: 90 }}>{e.tx && e.chain ? <a className="cl-link cl-mono" href={explorerTx(e.chain, e.tx)} target="_blank" rel="noreferrer">{e.tx.slice(0, 8)}…</a> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ProviderHealth({ s }: { s: ProjectSummary }) {
  const sm = useSelfModel(s.projectId, Boolean(s.blueprint));
  return (
    <Card title="Provider health" actions={<Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/integrations`}>Open Providers</Link>}>
      {!s.blueprint ? <p className="cl-meta">Providers are selected when the blueprint compiles.</p> : !sm.data ? (
        <p className="cl-meta">{sm.isError ? (sm.error as Error).message : 'Loading…'}</p>
      ) : sm.data.providers.length === 0 ? <p className="cl-meta">This agent relies on no providers.</p> : (
        <div className="cl-stack" style={{ gap: 8 }}>
          {sm.data.providers.map((p) => (
            <div key={`${p.providerId}-${p.role}`} className="cl-row" style={{ justifyContent: 'space-between', gap: 8 }} title={p.statusMeaning}>
              <span>
                <span className="cl-mono">{p.providerId}</span> <span className="cl-meta">{p.role}</span>
                {p.blocker ? <div className="cl-meta" style={{ whiteSpace: 'normal' }}>{p.blocker}</div> : null}
              </span>
              <span className="cl-row" style={{ gap: 4 }}>
                {p.notProven.length ? <Badge tone="warn">{p.notProven.length} not proven</Badge> : null}
                <Badge tone={PROVIDER_TONE[p.status] ?? 'neutral'}>{p.status}</Badge>
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Overview({ s }: { s: ProjectSummary }) {
  const dep = useDeployment(s.projectId);
  const rt = useRuntime(s.projectId, Boolean(dep.data?.deployment));
  const steps = stepsOf(s, dep.data, rt.data);
  const alerts = alertsOf(s, rt.data);
  const base = `/projects/${s.projectId}`;
  const critical = alerts.filter((a) => a.severity === 'critical').length;

  return (
    <>
      {critical ? (
        <BlockerBanner tone="deny" title={`${critical} critical alert${critical === 1 ? '' : 's'}`} actions={<Link className="cl-btn cl-btn-sm" href={`${base}/control-plane`}>Open Control Plane</Link>}>
          {alerts.filter((a) => a.severity === 'critical').slice(0, 3).map((a) => a.title).join(' · ')}
        </BlockerBanner>
      ) : null}

      <Section label="Lifecycle">
        <div className="cl-grid cl-grid-wide-narrow">
          <div className="cl-steps">
            {steps.map((st, i) => (
              <Link key={st.key} href={`${base}/${st.segment}`} className="cl-step" data-state={st.state}>
                <span className="cl-step-index">{st.state === 'done' ? <Check aria-hidden /> : i + 1}</span>
                <span className="cl-step-name">{st.label}</span>
                <span className="cl-step-detail">{st.detail}</span>
              </Link>
            ))}
          </div>
          <div className="cl-stack" style={{ gap: 16 }}>
            <NextAction s={s} dep={dep.data} />
            <Card title="Agent">
              <KeyValue
                rows={[
                  { label: 'Objective', value: s.blueprint?.objective.summary ?? s.objective },
                  { label: 'Agent id', value: s.kidoAgentId ?? '—', mono: true },
                  { label: 'Chains', value: s.chains.map(chainLabel).join(' · ') || '—' },
                  { label: 'Specialists', value: s.agents.join(', ') || '—' },
                  { label: 'Stage', value: STAGE_LABEL[s.stage] },
                ]}
              />
            </Card>
          </div>
        </div>
      </Section>

      <RuntimeTiles s={s} rt={rt.data} loading={Boolean(dep.data?.deployment) && rt.isLoading} />

      <Section label={`Needs attention · ${alerts.length}`}>
        {alerts.length === 0 ? (
          <Card><p className="cl-body"><StatusBadge status="PASS" label="Nothing open" /> <span className="cl-meta">No runtime errors, pauses, inactive leases, stale artifacts or blocking findings.</span></p></Card>
        ) : (
          <Card flush>
            <table className="cl-table">
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id}>
                    <td style={{ width: 100 }}><Badge tone={a.severity === 'critical' ? 'deny' : a.severity === 'warning' ? 'warn' : 'neutral'}>{a.severity}</Badge></td>
                    <td><div className="cl-strong" style={{ fontSize: 13 }}>{a.title}</div><div className="cl-meta" style={{ whiteSpace: 'normal' }}>{a.detail}</div></td>
                    <td style={{ width: 90 }}><Link className="cl-btn cl-btn-sm" href={`${base}/${a.segment}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>

      <Section label="Authority and activity">
        <div className="cl-grid cl-grid-2">
          <Authority s={s} />
          <div className="cl-stack" style={{ gap: 16 }}>
            <Recent s={s} />
            <ProviderHealth s={s} />
          </div>
        </div>
      </Section>

      <Section label="Every section">
        <div className="cl-grid cl-grid-tiles">
          {NAV_GROUPS.filter((g) => g.items.length).map((g) => (
            <Card key={g.id} title={g.label}>
              <div className="cl-stack" style={{ gap: 6 }}>
                {g.items.filter((it) => it.segment !== 'overview').map((it) => (
                  <Link key={it.id} href={`${base}/${it.segment}`} className="cl-link" title={PAGE_META[it.segment]?.purpose}>
                    {it.label}
                  </Link>
                ))}
              </div>
            </Card>
          ))}
        </div>
      </Section>
    </>
  );
}

export default function OverviewPage() {
  const { s } = useKido();
  return (
    <StudioPage
      segment="overview"
      title={s?.name}
      subtitle={s ? (s.blueprint?.objective.statement ?? s.objective) : undefined}
      badges={s ? <><Badge tone={s.stage === 'BUILT' ? 'pass' : 'data'}>{STAGE_LABEL[s.stage]}</Badge>{s.revision ? <Badge tone="neutral">revision {s.revision}</Badge> : null}{s.chains.map((c) => <Badge key={c} tone="neutral">{chainLabel(c)}</Badge>)}{s.blueprint ? <Badge tone="sim">{s.blueprint.deployment.environment}</Badge> : null}</> : undefined}
    >
      <WithProject>{(s) => <Overview s={s} />}</WithProject>
    </StudioPage>
  );
}
