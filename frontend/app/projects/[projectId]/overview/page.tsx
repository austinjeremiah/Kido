'use client';

/** Overview: where the agent is in its lifecycle, what it may do, and what needs attention. */
import Link from 'next/link';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, Card, KeyValue, StatusBadge } from '@/components/studio/primitives';
import { GateButton, WithProject, nextGate, useKido } from '@/components/studio/kido';
import { chainLabel, STAGE_LABEL } from '@/lib/kido/format';
import type { ProjectStage } from '@/lib/kido/types';

const STAGES: ProjectStage[] = ['INTERVIEW', 'BLUEPRINT', 'REVIEWED', 'SIMULATED', 'BUILT'];

export default function OverviewPage() {
  const { ctx } = useKido();
  return (
    <StudioPage segment="overview">
      <WithProject>
        {(s) => {
          const next = nextGate(s);
          const reached = STAGES.indexOf(s.stage);
          const a = s.blueprint?.authority;
          return (
            <>
              <Card title="Lifecycle">
                <div className="cl-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {STAGES.map((st, i) => (
                    <Badge key={st} tone={i < reached ? 'pass' : i === reached ? 'data' : 'neutral'}>
                      {i + 1}. {STAGE_LABEL[st]}
                    </Badge>
                  ))}
                  <Badge tone="neutral">Deploy (after build)</Badge>
                </div>
                <div className="cl-row" style={{ gap: 8, marginTop: 12 }}>
                  {s.interview.question ? (
                    <Link className="cl-btn cl-btn-primary" href={`/projects/${s.projectId}/build`}>Continue the interview</Link>
                  ) : next ? (
                    <GateButton gate={next} primary />
                  ) : s.stage === 'BUILT' ? (
                    <Link className="cl-btn cl-btn-primary" href={`/projects/${s.projectId}/deploy`}>Deploy</Link>
                  ) : (
                    <Link className="cl-btn" href={`/projects/${s.projectId}/build`}>Resolve in the Composer</Link>
                  )}
                </div>
              </Card>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginTop: 16 }}>
                <Card title="Agent">
                  <KeyValue
                    rows={[
                      { label: 'Objective', value: s.blueprint?.objective.summary ?? s.objective },
                      { label: 'Agent id', value: s.kidoAgentId ?? '—', mono: true },
                      { label: 'Chains', value: s.chains.map(chainLabel).join(' · ') || '—' },
                      { label: 'Agents', value: s.agents.join(', ') || '—' },
                      { label: 'Revision', value: s.revision ?? '—' },
                    ]}
                  />
                </Card>
                <Card title="Authority">
                  <KeyValue
                    rows={[
                      { label: 'Mode', value: a?.mode ?? '—' },
                      { label: 'Enforced by', value: a?.provider === 'AMANE' ? 'Amane, on-chain' : a?.provider ?? '—' },
                      { label: 'Allowed', value: a?.allowedActions.join(', ') || '—' },
                      { label: 'Forbidden', value: a?.forbiddenActions.join(', ') || '—' },
                      { label: 'Payees', value: String((a?.payees.length ?? 0) + (a?.beneficiaries.length ?? 0)) },
                    ]}
                  />
                </Card>
                <Card title={`Needs attention · ${ctx.problems.length}`}>
                  {ctx.problems.length === 0 ? (
                    <p className="cl-body">Nothing open.</p>
                  ) : (
                    ctx.problems.map((p) => (
                      <div key={p.id} className="cl-row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                        <span className="cl-body">{p.message}</span>
                        {p.href ? <Link className="cl-btn cl-btn-ghost" href={p.href}>Open</Link> : null}
                      </div>
                    ))
                  )}
                </Card>
                <Card title="Gates">
                  <div className="cl-stack" style={{ gap: 6 }}>
                    <span className="cl-row" style={{ justifyContent: 'space-between' }}>Security review <StatusBadge status={s.security ? (s.security.freshness === 'STALE' ? 'STALE' : s.security.blocking ? 'FAIL' : 'PASS') : 'UNKNOWN'} /></span>
                    <span className="cl-row" style={{ justifyContent: 'space-between' }}>Simulation <StatusBadge status={s.simulation ? (s.simulation.freshness === 'STALE' ? 'STALE' : s.simulation.passed ? 'PASS' : 'FAIL') : 'UNKNOWN'} /></span>
                    <span className="cl-row" style={{ justifyContent: 'space-between' }}>Build <StatusBadge status={s.build ? (s.build.freshness === 'STALE' ? 'STALE' : 'PASS') : 'UNKNOWN'} /></span>
                  </div>
                </Card>
              </div>
            </>
          );
        }}
      </WithProject>
    </StudioPage>
  );
}
