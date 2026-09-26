'use client';

/**
 * Composer: the design interview and the lifecycle gates for an existing project.
 *
 * The interview is the backend's: the pending question comes from Kido, answers are recorded by
 * Kido, and editing a captured requirement starts a new blueprint revision there. The gates run in
 * Kido's order — blueprint, security review, simulation, build — and each shows its current state.
 */
import { useState } from 'react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, Card, Section, StatusBadge } from '@/components/studio/primitives';
import { GateButton, WithProject, nextGate, useKido } from '@/components/studio/kido';
import { labelOfKey, STAGE_LABEL, valueText } from '@/lib/kido/format';
import type { ProjectSummary, Requirement } from '@/lib/kido/types';

function Interview({ s }: { s: ProjectSummary }) {
  const { lifecycle } = useKido();
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const q = s.interview.question;
  const send = (value: string) => {
    if (!value.trim()) return;
    setNote(null);
    lifecycle.answer.mutate([value], {
      onSuccess: (r) => {
        setText('');
        if (!r.accepted) setNote(r.note ?? 'That answer could not be used.');
      },
      onError: (e) => setNote((e as Error).message),
    });
  };
  return (
    <Card title="Interview">
      <div className="cl-stack" style={{ gap: 10, maxHeight: 420, overflow: 'auto' }} data-lenis-prevent>
        {s.interview.transcript.map((t, i) => (
          <p key={i} className="cl-body" style={{ margin: 0, textAlign: t.role === 'user' ? 'right' : 'left', opacity: t.role === 'user' ? 0.85 : 1 }}>
            <span className="cl-meta">{t.role === 'user' ? 'You' : 'Kido'} · </span>
            {t.text}
          </p>
        ))}
      </div>
      {q ? (
        <div className="cl-stack" style={{ gap: 8, marginTop: 14 }}>
          <p className="cl-body" style={{ margin: 0, fontWeight: 600 }}>{q.text}</p>
          {q.choices?.length ? (
            <div className="cl-row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {q.choices.map((c) => (
                <button key={c.value} type="button" className="cl-btn" disabled={lifecycle.answer.isPending} onClick={() => send(c.label)}>
                  {c.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="cl-row" style={{ gap: 8 }}>
            <input className="cl-input" style={{ flex: 1 }} value={text} placeholder="Your answer" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send(text)} aria-label="Your answer" />
            <button type="button" className="cl-btn cl-btn-primary" disabled={lifecycle.answer.isPending || !text.trim()} onClick={() => send(text)}>
              Answer
            </button>
          </div>
          {note ? <p className="cl-meta" style={{ margin: 0 }}>{note}</p> : null}
        </div>
      ) : (
        <p className="cl-meta" style={{ marginTop: 14 }}>The interview is complete.</p>
      )}
      {s.interview.warnings.length ? (
        <div className="cl-stack" style={{ gap: 4, marginTop: 10 }}>
          {s.interview.warnings.map((w) => (
            <p key={w} className="cl-meta" style={{ margin: 0 }}>⚠ {w}</p>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function RequirementRow({ r }: { r: Requirement }) {
  const { lifecycle } = useKido();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="cl-stack" style={{ gap: 4, padding: '8px 0', borderBottom: '1px solid var(--cl-line)' }}>
      <div className="cl-row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <span className="cl-label">{labelOfKey(r.key)}</span>
        <span className="cl-row" style={{ gap: 6 }}>
          <Badge tone={r.status === 'RESOLVED' ? (r.confirmed ? 'pass' : 'data') : r.critical ? 'warn' : 'neutral'}>{r.status === 'RESOLVED' ? (r.confirmed ? 'confirmed' : 'inferred') : r.status.toLowerCase()}</Badge>
          {r.status === 'RESOLVED' ? (
            <button type="button" className="cl-btn cl-btn-ghost" onClick={() => setEditing((v) => !v)}>
              {editing ? 'Cancel' : 'Edit'}
            </button>
          ) : null}
        </span>
      </div>
      <span className="cl-body">{r.status === 'RESOLVED' ? valueText(r.value) : '—'}</span>
      {editing ? (
        <div className="cl-row" style={{ gap: 6 }}>
          <input className="cl-input" style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="New answer, in your own words" aria-label={`Edit ${r.key}`} />
          <button
            type="button"
            className="cl-btn cl-btn-primary"
            disabled={!text.trim() || lifecycle.edit.isPending}
            onClick={() =>
              lifecycle.edit.mutate([r.key, text], {
                onSuccess: () => {
                  setEditing(false);
                  setText('');
                },
                onError: (e) => setErr((e as Error).message),
              })
            }
          >
            Save
          </button>
        </div>
      ) : null}
      {err ? <span className="cl-meta">{err}</span> : null}
    </div>
  );
}

function Gates({ s }: { s: ProjectSummary }) {
  const next = nextGate(s);
  const row = (label: string, state: string | null, fresh: string | undefined, detail: string) => (
    <div className="cl-row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--cl-line)' }}>
      <span className="cl-stack" style={{ gap: 2 }}>
        <span className="cl-label">{label}</span>
        <span className="cl-meta">{detail}</span>
      </span>
      <StatusBadge status={fresh === 'STALE' ? 'STALE' : (state ?? 'UNKNOWN')} />
    </div>
  );
  return (
    <Card title="Lifecycle">
      {row('Interview', s.interview.question ? 'RUNNING' : 'PASS', undefined, s.interview.question ? 'questions remain' : `${s.interview.questionsAsked} questions answered`)}
      {row('Blueprint', s.blueprint ? (s.blockers.length ? 'BLOCKED' : 'PASS') : null, undefined, s.blueprint ? `revision ${s.blueprint.revision}${s.blockers.length ? ` · ${s.blockers.length} blocker(s)` : ''}` : 'not compiled')}
      {row('Security review', s.security ? (s.security.blocking ? 'FAIL' : 'PASS') : null, s.security?.freshness, s.security ? `${s.security.findings.length} finding(s)` : 'not run')}
      {row('Simulation', s.simulation ? (s.simulation.passed ? 'PASS' : 'FAIL') : null, s.simulation?.freshness, s.simulation ? `${s.simulation.results.filter((r) => r.passed).length}/${s.simulation.results.length} scenarios` : 'not run')}
      {row('Build', s.build ? 'PASS' : null, s.build?.freshness, s.build ? `build ${s.build.buildRevision}` : 'not built')}
      <div className="cl-row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {next ? <GateButton gate={next} primary /> : null}
        {s.blueprint && next !== 'finalize' && !s.interview.question ? <GateButton gate="finalize" label="Recompile blueprint" /> : null}
      </div>
      {s.stage === 'BUILT' && s.build?.freshness === 'CURRENT' ? <p className="cl-meta" style={{ marginTop: 10 }}>Built. Continue to Deploy.</p> : null}
    </Card>
  );
}

export default function ComposerPage() {
  return (
    <StudioPage segment="build">
      <WithProject>
        {(s) => (
          <div className="cl-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr)', gap: 16 }}>
            <div className="cl-stack" style={{ gap: 16 }}>
              <Card title="Objective">
                <p className="cl-body" style={{ margin: 0 }}>{s.objective}</p>
                <p className="cl-meta" style={{ marginTop: 6 }}>{STAGE_LABEL[s.stage]}{s.kidoAgentId ? ` · ${s.kidoAgentId}` : ''}</p>
              </Card>
              <Interview s={s} />
            </div>
            <div className="cl-stack" style={{ gap: 16 }}>
              <Gates s={s} />
              <Section label={`Requirements · ${s.interview.requirements.filter((r) => r.status === 'RESOLVED').length} captured`}>
                {s.interview.requirements.filter((r) => r.status !== 'NOT_APPLICABLE').map((r) => (
                  <RequirementRow key={r.key} r={r} />
                ))}
              </Section>
            </div>
          </div>
        )}
      </WithProject>
    </StudioPage>
  );
}
