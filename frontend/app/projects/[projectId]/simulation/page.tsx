'use client';

/** Simulation: every declared scenario for this revision, including attacks that must be refused. */
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, Card, EmptyState, StaleBanner, StatusBadge } from '@/components/studio/primitives';
import { GateButton, NotYet, WithProject } from '@/components/studio/kido';
import { labelOfKey } from '@/lib/kido/format';

export default function SimulationPage() {
  return (
    <StudioPage segment="simulation" actions={<GateButton gate="simulate" primary />}>
      <WithProject>
        {(s) => {
          if (!s.blueprint) return <NotYet what="blueprint" where="composer" id={s.projectId} />;
          const sim = s.simulation;
          if (!sim) return <EmptyState title="Not simulated yet" body="Run the simulation once the security review passes." />;
          const families = [...new Set(sim.results.map((r) => r.family))];
          return (
            <>
              {sim.freshness === 'STALE' ? <StaleBanner what="simulation" builtAgainst={sim.blueprintRevision} current={s.blueprint.revision} /> : null}
              <div className="cl-row" style={{ gap: 8, marginBottom: 12 }}>
                <Badge tone={sim.passed ? 'pass' : 'deny'}>{sim.passed ? 'all passed' : 'failures'}</Badge>
                <Badge tone="neutral">{sim.results.filter((r) => r.passed).length}/{sim.results.length} scenarios</Badge>
                <Badge tone="data">revision {sim.blueprintRevision}</Badge>
              </div>
              {families.map((f) => (
                <Card key={f} title={labelOfKey(f)}>
                  <table className="cl-table">
                    <thead>
                      <tr><th>Scenario</th><th>Expected</th><th>Actual</th><th>Code</th><th>Result</th><th>Note</th></tr>
                    </thead>
                    <tbody>
                      {sim.results.filter((r) => r.family === f).map((r) => (
                        <tr key={r.id}>
                          <td className="cl-mono">{r.id}</td>
                          <td>{r.expected}</td>
                          <td>{r.actual}</td>
                          <td className="cl-mono">{r.code ?? '—'}</td>
                          <td><StatusBadge status={r.passed ? 'PASS' : 'FAIL'} /></td>
                          <td>{r.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              ))}
            </>
          );
        }}
      </WithProject>
    </StudioPage>
  );
}
