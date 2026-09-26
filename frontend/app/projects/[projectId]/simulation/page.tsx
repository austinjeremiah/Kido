'use client';

/**
 * Simulation: every scenario the blueprint declares, run by the Kido simulation engine against the
 * current revision — including the attacks that must be refused.
 *
 * Verdicts for authority scenarios come from the same compiler preflight and Amane subset rules the
 * chain enforces, so each result names the layer that decided it and the rule that fired (decoded
 * from the engine's reason code). Two rules the page will not bend: a run against an older revision
 * is shown STALE, never as current proof; and the expected verdict is fixed by the scenario, nothing
 * here edits it. Custom attacks go to the Attack Lab.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Search, Swords, X } from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, Card, CopyButton, EmptyState, KeyValue, Section, StatusBadge, TabStrip, TimeAgo } from '@/components/studio/primitives';
import { GateButton, NotYet, WithProject, useKido } from '@/components/studio/kido';
import { RateBar, StaleArtifacts, isoOf, whenText } from '@/components/studio/blueprint/shared';
import { LAYER_LABEL, VERDICT_MEANING, decode, ruleText } from '@/components/studio/simulation/codes';
import { labelOfKey, valueText } from '@/lib/kido/format';
import type { Blueprint, ProjectSummary, ScenarioResult, SimulationReport } from '@/lib/kido/types';

type Filter = 'all' | 'passed' | 'failed';

function Summary({ sim, bp }: { sim: SimulationReport; bp: Blueprint }) {
  const passed = sim.results.filter((r) => r.passed).length;
  const families = [...new Set(sim.results.map((r) => r.family))];
  const layers = new Map<string, number>();
  for (const r of sim.results) {
    const d = decode(r);
    layers.set(d.layerLabel, (layers.get(d.layerLabel) ?? 0) + 1);
  }
  const current = sim.freshness === 'CURRENT';
  return (
    <Section label="Summary">
      <div className="cl-grid cl-grid-4" style={{ gap: 12, marginBottom: 16 }}>
        <Card title="Scenarios passed">
          <div className="cl-display-s" style={{ fontSize: 28 }}>{passed}<span className="cl-meta" style={{ fontSize: 16 }}> / {sim.results.length}</span></div>
          <RateBar value={passed} total={sim.results.length} tone={passed === sim.results.length ? 'pass' : 'deny'} />
          <div style={{ marginTop: 8 }}><Badge tone={sim.passed ? 'pass' : 'deny'}>{sim.passed ? 'all passed' : `${sim.results.length - passed} failed`}</Badge></div>
        </Card>
        <Card title="Revision">
          <div className="cl-display-s" style={{ fontSize: 28 }}>r{sim.blueprintRevision}</div>
          <div className="cl-meta">current blueprint r{bp.revision}</div>
          <div style={{ marginTop: 8 }}><Badge tone={current ? 'pass' : 'warn'}>{sim.freshness}</Badge></div>
        </Card>
        <Card title="Generated">
          <div className="cl-mono" style={{ fontSize: 13 }}>{whenText(sim.generatedAt)}</div>
          <div className="cl-meta"><TimeAgo iso={isoOf(sim.generatedAt)} /> ago</div>
          <div className="cl-meta" style={{ marginTop: 8 }}>{bp.simulationScenarios.length} declared · {sim.results.length} run</div>
        </Card>
        <Card title="Decided by">
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {[...layers.entries()].map(([l, n]) => (
              <li key={l} className="cl-row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}><span>{l}</span><span className="cl-mono">{n}</span></li>
            ))}
          </ul>
        </Card>
      </div>
      <div className="cl-stack" style={{ gap: 8 }}>
        {families.map((f) => {
          const rows = sim.results.filter((r) => r.family === f);
          const ok = rows.filter((r) => r.passed).length;
          return (
            <div key={f} style={{ display: 'grid', gridTemplateColumns: '140px minmax(0, 1fr) 70px', gap: 12, alignItems: 'center' }}>
              <span className="cl-label">{labelOfKey(f)}</span>
              <RateBar value={ok} total={rows.length} tone={ok === rows.length ? 'pass' : 'deny'} />
              <span className="cl-mono cl-meta" style={{ textAlign: 'right' }}>{ok}/{rows.length} · {Math.round((ok / rows.length) * 100)}%</span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function Detail({ r, s, onClose }: { r: ScenarioResult; s: ProjectSummary; onClose: () => void }) {
  const d = decode(r);
  const declared = s.blueprint?.simulationScenarios.find((x) => x.id === r.id);
  const stale = s.simulation?.freshness !== 'CURRENT';
  return (
    <aside className="cl-card" style={{ position: 'sticky', top: 12 }} aria-label={`Scenario ${r.id}`}>
      <div className="cl-card-head">
        <div className="cl-card-title cl-mono">{r.id}</div>
        <button type="button" className="cl-icon-btn" aria-label="Close detail" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="cl-card-body cl-stack" style={{ gap: 14 }}>
        <div className="cl-row cl-row-wrap" style={{ gap: 6 }}>
          <StatusBadge status={r.passed ? 'PASS' : 'FAIL'} large />
          <Badge tone="neutral">{labelOfKey(r.family)}</Badge>
          {stale ? <Badge tone="warn">stale · r{s.simulation?.blueprintRevision}</Badge> : null}
        </div>
        {declared?.description ? <p className="cl-body" style={{ margin: 0 }}>{valueText(declared.description)}</p> : null}
        <KeyValue
          rows={[
            { label: 'Expected', value: <><span className="cl-mono">{r.expected}</span> <span className="cl-meta">— {VERDICT_MEANING[r.expected] ?? ''}</span></> },
            { label: 'Actual', value: <><span className="cl-mono" style={{ color: r.expected === r.actual ? undefined : 'var(--cl-deny)' }}>{r.actual}</span> <span className="cl-meta">— {VERDICT_MEANING[r.actual] ?? ''}</span></> },
            { label: 'Decided by', value: d.layerLabel },
            { label: 'Reason code', value: r.code ? <span className="cl-row" style={{ gap: 6 }}><span className="cl-mono" style={{ wordBreak: 'break-all' }}>{r.code}</span><CopyButton value={r.code} label="Copy" /></span> : <span className="cl-meta">none</span> },
            ...(d.rule ? [{ label: 'Rule', value: ruleText(d.rule) }] : []),
            { label: 'Note', value: r.note },
          ]}
        />
        <div>
          <div className="cl-label" style={{ marginBottom: 8 }}>Path through the layers</div>
          <div className="cl-path">
            {d.steps.map((st, i) => (
              <div className="cl-path-step" key={i}>
                <span className="cl-path-step-name">{st.layer}</span>
                <Badge tone={st.outcome === 'PASSED' ? 'pass' : st.outcome === 'REFUSED' ? 'deny' : st.outcome === 'OBSERVED' ? 'data' : 'blocked'}>{st.outcome.replace('_', ' ')}</Badge>
                <span className="cl-path-step-detail">{st.detail}</span>
              </div>
            ))}
          </div>
        </div>
        {r.actual === 'SKIPPED' ? (
          <BlockerBanner tone="warn" title="Counted as passed, but not exercised">A skipped scenario never fails the run; it proves nothing about this blueprint.</BlockerBanner>
        ) : null}
        <div className="cl-row cl-row-wrap" style={{ gap: 8 }}>
          <Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/attacks`}>
            <Swords size={12} aria-hidden />
            Try a variation in the Attack Lab
          </Link>
          <Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/blueprint`}>Blueprint</Link>
        </div>
      </div>
    </aside>
  );
}

function SimulationBody({ s }: { s: ProjectSummary }) {
  const params = useSearchParams();
  const sim = s.simulation!;
  const bp = s.blueprint!;
  const families = [...new Set(sim.results.map((r) => r.family))];
  const [family, setFamily] = useState<string>(params.get('family') ?? 'all');
  const [filter, setFilter] = useState<Filter>((params.get('filter') as Filter) ?? 'all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(params.get('scenario'));

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sim.results.filter(
      (r) =>
        (family === 'all' || r.family === family) &&
        (filter === 'all' || (filter === 'passed' ? r.passed : !r.passed)) &&
        (!needle || [r.id, r.family, r.expected, r.actual, r.code ?? '', r.note].some((x) => x.toLowerCase().includes(needle))),
    );
  }, [sim.results, family, filter, q]);
  const sel = sim.results.find((r) => r.id === selected) ?? null;
  const notRun = bp.simulationScenarios.filter((x) => !sim.results.some((r) => r.id === x.id));

  return (
    <>
      <StaleArtifacts s={s} only={['security', 'simulation']} />
      {!sim.passed ? (
        <BlockerBanner tone="deny" title="The simulation failed" actions={<button type="button" className="cl-btn cl-btn-sm" onClick={() => setFilter('failed')}>Show failures</button>}>
          The build gate stays closed until every scenario returns its expected verdict. The expected verdict is fixed by the scenario; change the blueprint, not the test.
        </BlockerBanner>
      ) : null}
      {notRun.length ? <BlockerBanner tone="warn" title="Declared but not in this run">{notRun.map((x) => String(x.id)).join(', ')}</BlockerBanner> : null}

      <Summary sim={sim} bp={bp} />

      <Section label="Scenarios">
        <TabStrip
          tabs={[{ id: 'all', label: `All (${sim.results.length})` }, ...families.map((f) => ({ id: f, label: `${labelOfKey(f)} (${sim.results.filter((r) => r.family === f).length})` }))]}
          active={family}
          onChange={setFamily}
        />
        <div className="cl-row cl-row-wrap" style={{ gap: 8, marginBottom: 12 }}>
          <div className="cl-btn-group" role="group" aria-label="Result filter">
            {(['all', 'passed', 'failed'] as Filter[]).map((f) => (
              <button key={f} type="button" className="cl-btn cl-btn-sm" aria-pressed={filter === f} style={filter === f ? { borderColor: 'var(--cl-ink)', fontWeight: 600 } : undefined} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'passed' ? `Passed (${sim.results.filter((r) => r.passed).length})` : `Failed (${sim.results.filter((r) => !r.passed).length})`}
              </button>
            ))}
          </div>
          <label className="cl-row" style={{ gap: 6, flex: '1 1 220px', maxWidth: 360 }}>
            <Search size={13} aria-hidden />
            <input className="cl-input" placeholder="Search id, code, note…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search scenarios" />
          </label>
          <span className="cl-meta">{rows.length} shown</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: sel ? 'minmax(0, 1fr) minmax(320px, 400px)' : 'minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
          <div className="cl-table-scroll">
            <table className="cl-table">
              <thead>
                <tr><th>Scenario</th><th>Family</th><th>Expected</th><th>Actual</th><th>Code</th><th>Result</th><th>Note</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-clickable="true" data-selected={r.id === selected} onClick={() => setSelected(r.id === selected ? null : r.id)}>
                    <td className="cl-mono">{r.id}</td>
                    <td>{labelOfKey(r.family)}</td>
                    <td className="cl-mono">{r.expected}</td>
                    <td className="cl-mono" style={{ color: r.expected === r.actual ? undefined : 'var(--cl-deny)' }}>{r.actual}</td>
                    <td className="cl-mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }} title={r.code ? decode(r).layerLabel : undefined}>{r.code ?? '—'}</td>
                    <td><StatusBadge status={r.passed ? 'PASS' : 'FAIL'} /></td>
                    <td className="cl-meta" style={{ whiteSpace: 'normal' }}>{r.note}</td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr><td colSpan={7} className="cl-meta">No scenario matches.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {sel ? <Detail r={sel} s={s} onClose={() => setSelected(null)} /> : null}
        </div>
      </Section>

      <Section label="Layers">
        <div className="cl-grid cl-grid-2" style={{ gap: 12 }}>
          {(['KIDO_VALIDATOR', 'KIDO_COMPILER', 'AMANE_RULES', 'MONITOR'] as const).map((l) => (
            <Card key={l} title={LAYER_LABEL[l]}>
              <p className="cl-meta" style={{ whiteSpace: 'normal', margin: 0 }}>
                {l === 'KIDO_VALIDATOR'
                  ? 'Checks a specialist agent’s proposal against its contract (roles, actions, chains, assets). Codes start KIDO_REASON_.'
                  : l === 'KIDO_COMPILER'
                    ? 'Turns a step into a bounded intent and runs the Amane subset rules as a preflight. A preflight refusal is KIDO_PLAN_OUT_OF_POLICY:<rule>.'
                    : l === 'AMANE_RULES'
                      ? 'The owner-signed policy and lease on-chain. The same rules decide the preflight; codes start AMANE_.'
                      : 'Observes data sources; stale or unavailable data never produces an event.'}
              </p>
              <div className="cl-meta" style={{ marginTop: 6 }}>{sim.results.filter((r) => decode(r).layer === l).length} scenario(s) decided here</div>
            </Card>
          ))}
        </div>
      </Section>
    </>
  );
}

export default function SimulationPage() {
  return (
    <StudioPage
      segment="simulation"
      actions={
        <>
          <AttackLabLink />
          <GateButton gate="simulate" primary label="Re-run simulation" />
        </>
      }
    >
      <WithProject>
        {(s) => {
          if (!s.blueprint) return <NotYet what="blueprint" where="composer" id={s.projectId} />;
          if (!s.simulation)
            return (
              <EmptyState
                title="Not simulated yet"
                body={`Blueprint r${s.blueprint.revision} declares ${s.blueprint.simulationScenarios.length} scenarios. The simulation runs once the security review for this revision is current and not blocking.`}
                action={<GateButton gate={s.security?.freshness === 'CURRENT' ? 'simulate' : 'securityReview'} primary />}
              />
            );
          return <SimulationBody s={s} />;
        }}
      </WithProject>
    </StudioPage>
  );
}

function AttackLabLink() {
  const { id } = useKido();
  return (
    <Link className="cl-btn" href={`/projects/${id}/attacks`}>
      <Swords size={13} aria-hidden />
      Attack Lab
    </Link>
  );
}
