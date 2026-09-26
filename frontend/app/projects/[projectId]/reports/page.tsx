'use client';

/**
 * Safety Report: one revision's review, simulation, build and the implementation status of every
 * provider the agent relies on — including what has not been proven. Downloadable as JSON.
 */
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, Card, KeyValue, StatusBadge } from '@/components/studio/primitives';
import { NotYet, WithProject, useKido } from '@/components/studio/kido';
import { useSelfModel } from '@/lib/kido/hooks';
import type { Tone } from '@/lib/studio/types';

const TONE: Record<string, Tone> = { TESTNET_LIVE: 'pass', LIVE_ATTESTED: 'pass', IMPLEMENTED_LOCAL: 'data', SIMULATED: 'sim', NOT_IMPLEMENTED: 'neutral', BLOCKED_ENV: 'blocked', BLOCKED_AUTH: 'blocked', BLOCKED_UPSTREAM: 'blocked' };

export default function ReportsPage() {
  const { s, id } = useKido();
  const sm = useSelfModel(id, Boolean(s?.blueprint));
  const download = () => {
    if (!s) return;
    const report = { generatedAt: new Date().toISOString(), project: { id: s.projectId, name: s.name, agentId: s.kidoAgentId, revision: s.revision, blueprintHash: s.blueprintHash }, security: s.security, simulation: s.simulation, build: s.build, providers: sm.data?.providers ?? [] };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `kido-safety-report-${s.projectId}-r${s.revision ?? 0}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <StudioPage segment="reports" actions={<button type="button" className="cl-btn" onClick={download} disabled={!s?.blueprint}>Download JSON</button>}>
      <WithProject>
        {(s) => {
          if (!s.blueprint) return <NotYet what="report" where="composer" id={s.projectId} />;
          return (
            <div className="cl-stack" style={{ gap: 16 }}>
              <Card title={`${s.name} · revision ${s.revision}`}>
                <KeyValue
                  rows={[
                    { label: 'Agent id', value: s.kidoAgentId ?? '—', mono: true },
                    { label: 'Blueprint hash', value: s.blueprintHash ?? '—', mono: true },
                    { label: 'Security review', value: <StatusBadge status={s.security ? (s.security.freshness === 'STALE' ? 'STALE' : s.security.blocking ? 'FAIL' : 'PASS') : 'UNKNOWN'} label={s.security ? `${s.security.findings.length} finding(s)` : 'not run'} /> },
                    { label: 'Simulation', value: <StatusBadge status={s.simulation ? (s.simulation.freshness === 'STALE' ? 'STALE' : s.simulation.passed ? 'PASS' : 'FAIL') : 'UNKNOWN'} label={s.simulation ? `${s.simulation.results.filter((r) => r.passed).length}/${s.simulation.results.length} scenarios` : 'not run'} /> },
                    { label: 'Build', value: <StatusBadge status={s.build ? (s.build.freshness === 'STALE' ? 'STALE' : 'PASS') : 'UNKNOWN'} label={s.build ? `build ${s.build.buildRevision}` : 'not built'} /> },
                  ]}
                />
              </Card>
              <Card title="Providers this agent relies on">
                {!sm.data ? (
                  <p className="cl-meta">{sm.isError ? (sm.error as Error).message : 'Loading…'}</p>
                ) : (
                  <table className="cl-table">
                    <thead>
                      <tr><th>Provider</th><th>Role</th><th>Status</th><th>Proven</th><th>Not proven</th></tr>
                    </thead>
                    <tbody>
                      {sm.data.providers.map((p) => (
                        <tr key={`${p.providerId}${p.role}`}>
                          <td>{p.providerId}</td>
                          <td>{p.role}</td>
                          <td title={p.statusMeaning}><Badge tone={TONE[p.status] ?? 'neutral'}>{p.status}</Badge>{p.blocker ? <div className="cl-meta">{p.blocker}</div> : null}</td>
                          <td>{p.proven.join('; ') || '—'}</td>
                          <td>{[...p.notProven, ...p.doesNotProvide].join('; ') || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
              {sm.data ? (
                <Card title="Failure behaviour">
                  <KeyValue rows={Object.entries(sm.data.failureBehaviour).map(([k, v]) => ({ label: k, value: v }))} />
                </Card>
              ) : null}
            </div>
          );
        }}
      </WithProject>
    </StudioPage>
  );
}
