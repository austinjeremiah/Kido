'use client';

/**
 * The attack catalogue: every scenario of the project's simulation report, grouped by family, with
 * the expected and actual outcome, the reason code and the note the simulator recorded.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Badge, Card, EmptyState, StaleBanner, StatusBadge, Timestamp } from '@/components/studio/primitives';
import { GateButton, NotYet } from '@/components/studio/kido';
import { labelOfKey } from '@/lib/kido/format';
import type { ProjectSummary, ScenarioResult } from '@/lib/kido/types';

type Outcome = 'all' | 'passed' | 'failed' | 'refused' | 'allowed';

const FAMILY_BLURB: Record<string, string> = {
  happy: 'In-policy actions that must go through.',
  authority: 'Attempts to exceed the owner’s authority: limits, payees, lease.',
  adversarial: 'A compromised or injected specialist trying to move funds.',
  recovery: 'A multi-step plan failing halfway.',
  data: 'Stale or unavailable data that must not trigger an action.',
};

function outcomeTone(o: string) {
  return o === 'ALLOW' ? 'pass' : o === 'REJECT' ? 'deny' : o === 'NO_ACTION' ? 'neutral' : 'warn';
}

export function Catalogue({ s }: { s: ProjectSummary }) {
  const sim = s.simulation;
  const [family, setFamily] = useState<string>('all');
  const [outcome, setOutcome] = useState<Outcome>('all');
  const results = sim?.results ?? [];
  const families = useMemo(() => [...new Set(results.map((r) => r.family))], [results]);

  const visible = results.filter((r) => {
    if (family !== 'all' && r.family !== family) return false;
    if (outcome === 'passed') return r.passed;
    if (outcome === 'failed') return !r.passed;
    if (outcome === 'refused') return r.actual === 'REJECT';
    if (outcome === 'allowed') return r.actual === 'ALLOW';
    return true;
  });
  const grouped = families.map((f) => ({ family: f, rows: visible.filter((r) => r.family === f) })).filter((g) => g.rows.length);

  if (!s.blueprint) return <NotYet what="blueprint" where="composer" id={s.projectId} />;
  if (!sim) {
    return (
      <EmptyState
        title="No simulation yet"
        body="The catalogue is the simulation report: every declared scenario, including the attacks that must be refused. Run the security review and then the simulation for this revision."
        action={<GateButton gate="simulate" primary />}
      />
    );
  }

  const passed = results.filter((r) => r.passed).length;
  const refused = results.filter((r) => r.actual === 'REJECT').length;
  const count = (pred: (r: ScenarioResult) => boolean) => results.filter((r) => (family === 'all' || r.family === family) && pred(r)).length;

  return (
    <div className="cl-stack" style={{ gap: 14 }}>
      {sim.freshness === 'STALE' && s.blueprint ? <StaleBanner what="simulation" builtAgainst={sim.blueprintRevision} current={s.blueprint.revision} /> : null}
      <div className="cl-grid cl-grid-tiles">
        <Tile label="Scenarios" value={String(results.length)} note={`${families.length} families`} />
        <Tile label="Held" value={`${passed} / ${results.length}`} note={sim.passed ? 'every scenario as expected' : 'some scenario diverged'} tone={sim.passed ? 'pass' : 'deny'} />
        <Tile label="Refused" value={String(refused)} note="attacks stopped by a layer" />
        <Tile label="Revision" value={`r${sim.blueprintRevision}`} note={<Timestamp iso={new Date(sim.generatedAt).toISOString()} />} />
      </div>

      <div className="cl-row cl-row-wrap" style={{ gap: 6 }}>
        <span className="cl-label" style={{ marginRight: 4 }}>Family</span>
        {['all', ...families].map((f) => (
          <button key={f} type="button" className={`cl-btn cl-btn-sm${family === f ? ' cl-btn-primary' : ''}`} onClick={() => setFamily(f)}>
            {f === 'all' ? 'All' : labelOfKey(f)} <span className="cl-meta" style={{ color: 'inherit', opacity: 0.7 }}>{f === 'all' ? results.length : results.filter((r) => r.family === f).length}</span>
          </button>
        ))}
        <span className="cl-spacer" />
        <span className="cl-label" style={{ marginRight: 4 }}>Outcome</span>
        {(['all', 'passed', 'failed', 'refused', 'allowed'] as Outcome[]).map((o) => (
          <button key={o} type="button" className={`cl-btn cl-btn-sm${outcome === o ? ' cl-btn-primary' : ''}`} onClick={() => setOutcome(o)}>
            {labelOfKey(o)}{' '}
            <span className="cl-meta" style={{ color: 'inherit', opacity: 0.7 }}>
              {o === 'all' ? count(() => true) : o === 'passed' ? count((r) => r.passed) : o === 'failed' ? count((r) => !r.passed) : o === 'refused' ? count((r) => r.actual === 'REJECT') : count((r) => r.actual === 'ALLOW')}
            </span>
          </button>
        ))}
      </div>

      {grouped.length === 0 ? <p className="cl-meta">No scenario matches these filters.</p> : null}
      {grouped.map((g) => (
        <Card key={g.family} flush title={<span>{labelOfKey(g.family)} <span className="cl-meta">· {FAMILY_BLURB[g.family] ?? `${g.rows.length} scenario${g.rows.length === 1 ? '' : 's'}`}</span></span>} actions={<Badge tone={g.rows.every((r) => r.passed) ? 'pass' : 'deny'}>{g.rows.filter((r) => r.passed).length}/{g.rows.length} held</Badge>}>
          <div className="cl-table-scroll">
            <table className="cl-table" style={{ minWidth: 820 }}>
              <thead>
                <tr><th style={{ width: 190 }}>Scenario</th><th style={{ width: 150 }}>Expected</th><th style={{ width: 150 }}>Actual</th><th>Reason code</th><th style={{ width: 90 }}>Result</th></tr>
              </thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="cl-strong">{labelOfKey(r.id)}</div>
                      <div className="cl-meta" style={{ whiteSpace: 'normal' }}>{r.note}</div>
                    </td>
                    <td><Badge tone={outcomeTone(r.expected)}>{r.expected.replace(/_/g, ' ')}</Badge></td>
                    <td><Badge tone={outcomeTone(r.actual)}>{r.actual.replace(/_/g, ' ')}</Badge></td>
                    <td className="cl-mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{r.code ?? <span className="cl-meta">—</span>}</td>
                    <td><StatusBadge status={r.passed ? 'PASS' : 'FAIL'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
      <p className="cl-meta">
        Each scenario runs the same compiler and Amane subset rules the deployed account enforces. “Held” means the actual outcome matched the expected one — for an attack, that it was refused.
      </p>
    </div>
  );
}

export function Tile({ label, value, note, tone }: { label: string; value: string; note?: ReactNode; tone?: 'pass' | 'deny' | 'warn' }) {
  return (
    <div className="cl-card" style={{ padding: '12px 14px' }}>
      <div className="cl-label">{label}</div>
      <div className="cl-display-s" style={{ margin: '4px 0', color: tone ? `var(--cl-${tone})` : undefined }}>{value}</div>
      {note ? <div className="cl-meta">{note}</div> : null}
    </div>
  );
}
