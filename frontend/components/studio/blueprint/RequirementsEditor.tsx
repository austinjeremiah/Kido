'use client';

/**
 * Requirements the blueprint compiles from, each editable in place. An edit is sent to the interview
 * as plain language (POST /projects/:id/edit); the backend decides whether it parses and says why
 * not. An accepted edit changes the requirement, not the blueprint: the page then invites a
 * recompile, which produces the next revision and makes the review, simulation and build stale.
 */
import { Fragment, useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Badge, BlockerBanner } from '@/components/studio/primitives';
import { GateButton, useKido } from '@/components/studio/kido';
import { labelOfKey, valueText } from '@/lib/kido/format';
import type { Blueprint, ProjectSummary, Requirement } from '@/lib/kido/types';

type Provenance = { kind?: string; quote?: string; turn?: number; from?: string[]; rule?: string } & Record<string, unknown>;
type CompiledRequirement = Requirement & { class?: string; provenance?: Provenance };

const STATUS_TONE: Record<Requirement['status'], 'pass' | 'warn' | 'deny' | 'neutral'> = { RESOLVED: 'pass', UNKNOWN: 'warn', UNSATISFIABLE: 'deny', NOT_APPLICABLE: 'neutral' };

/** The requirements recorded in the compiled blueprint (with provenance), keyed by requirement key. */
function compiledOf(bp: Blueprint | null): Map<string, CompiledRequirement> {
  const list = (bp as unknown as { requirements?: CompiledRequirement[] } | null)?.requirements ?? [];
  return new Map(list.map((r) => [r.key, r]));
}

function provenanceText(p: Provenance | undefined): string | null {
  if (!p) return null;
  if (p.quote) return `“${p.quote}”${typeof p.turn === 'number' ? ` · turn ${p.turn}` : ''}`;
  if (p.rule) return `${p.kind ? `${p.kind.toLowerCase()}: ` : ''}${p.rule}${p.from?.length ? ` (from ${p.from.join(', ')})` : ''}`;
  return p.kind ? p.kind.toLowerCase().replace(/_/g, ' ') : null;
}

/** Requirements whose current value differs from what the compiled blueprint recorded. */
export function driftedRequirements(s: ProjectSummary): string[] {
  const compiled = compiledOf(s.blueprint);
  if (!compiled.size) return [];
  return s.interview.requirements.filter((r) => {
    const c = compiled.get(r.key);
    return !c || JSON.stringify(c.value) !== JSON.stringify(r.value) || c.status !== r.status;
  }).map((r) => r.key);
}

export function RequirementsEditor({ s }: { s: ProjectSummary }) {
  const { lifecycle } = useKido();
  const compiled = useMemo(() => compiledOf(s.blueprint), [s.blueprint]);
  const drifted = useMemo(() => new Set(driftedRequirements(s)), [s]);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [topic, setTopic] = useState<string>('ALL');
  const [result, setResult] = useState<{ key: string; accepted: boolean; note?: string; next?: string | null; error?: string } | null>(null);

  const reqs = s.interview.requirements;
  const topics = [...new Set(reqs.map((r) => r.topic))];
  const shown = reqs.filter((r) => topic === 'ALL' || r.topic === topic);

  const submit = (key: string) => {
    if (!text.trim()) return;
    setResult(null);
    lifecycle.edit.mutate([key, text.trim()], {
      onSuccess: (r) => {
        setResult({ key, accepted: r.accepted, note: r.note, next: r.next?.text ?? null });
        if (r.accepted) {
          setEditing(null);
          setText('');
        }
      },
      onError: (e) => setResult({ key, accepted: false, error: (e as Error).message }),
    });
  };

  return (
    <div className="cl-stack" style={{ gap: 12 }}>
      {drifted.size > 0 ? (
        <BlockerBanner tone="warn" title={`${drifted.size} requirement${drifted.size === 1 ? '' : 's'} changed since Blueprint r${s.blueprint?.revision ?? '—'}`} actions={<GateButton gate="finalize" primary label="Recompile blueprint" />}>
          {[...drifted].map(labelOfKey).join(', ')}. The blueprint, and everything derived from it, still reflects the previous values until you recompile.
        </BlockerBanner>
      ) : null}
      {result ? (
        <BlockerBanner
          tone={result.accepted ? 'pass' : 'deny'}
          title={result.accepted ? `Edit to ${labelOfKey(result.key)} accepted` : `Edit to ${labelOfKey(result.key)} not accepted`}
          actions={result.accepted ? <GateButton gate="finalize" primary label="Recompile blueprint" /> : null}
        >
          {result.error ?? result.note ?? (result.accepted ? 'The requirement is updated. Recompile to produce the next revision.' : 'Kido could not apply that edit.')}
          {result.next ? ` Kido now asks: ${result.next}` : ''}
        </BlockerBanner>
      ) : null}

      <div className="cl-row cl-row-wrap" style={{ gap: 6 }}>
        {['ALL', ...topics].map((t) => (
          <button key={t} type="button" className="cl-btn cl-btn-sm" aria-pressed={topic === t} style={topic === t ? { borderColor: 'var(--cl-ink)' } : undefined} onClick={() => setTopic(t)}>
            {t === 'ALL' ? `All (${reqs.length})` : `${labelOfKey(t.toLowerCase())} (${reqs.filter((r) => r.topic === t).length})`}
          </button>
        ))}
      </div>

      <div className="cl-table-scroll">
        <table className="cl-table">
          <thead>
            <tr>
              <th>Requirement</th>
              <th>Topic</th>
              <th>Status</th>
              <th>Value</th>
              <th>Source</th>
              <th style={{ width: 90 }} />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const c = compiled.get(r.key);
              const open = editing === r.key;
              return (
                <Fragment key={r.key}>
                  <tr data-selected={open}>
                    <td>
                      <div className="cl-strong">{labelOfKey(r.key)}</div>
                      <div className="cl-mono cl-meta" style={{ fontSize: 11 }}>{r.key}</div>
                    </td>
                    <td className="cl-meta">{r.topic}</td>
                    <td>
                      <div className="cl-row cl-row-wrap" style={{ gap: 4 }}>
                        <Badge tone={STATUS_TONE[r.status]}>{r.status.replace(/_/g, ' ')}</Badge>
                        {r.critical ? <Badge tone="warn">critical</Badge> : null}
                        <Badge tone={r.confirmed ? 'pass' : 'neutral'} title={r.confirmed ? 'Confirmed by the owner' : 'Inferred or defaulted; not explicitly confirmed'}>{r.confirmed ? 'confirmed' : 'unconfirmed'}</Badge>
                        {drifted.has(r.key) ? <Badge tone="warn">changed</Badge> : null}
                      </div>
                    </td>
                    <td style={{ wordBreak: 'break-word', maxWidth: 360 }}>
                      {Array.isArray(r.value) && r.value.some((v) => v && typeof v === 'object') ? (
                        <span className="cl-mono" style={{ fontSize: 12 }}>{(r.value as Array<Record<string, unknown>>).map((v) => Object.values(v).map(valueText).join(' · ')).join('\n')}</span>
                      ) : (
                        valueText(r.value)
                      )}
                      {c && drifted.has(r.key) ? <div className="cl-meta" style={{ textDecoration: 'line-through' }}>{valueText(c.value)}</div> : null}
                    </td>
                    <td className="cl-meta" style={{ whiteSpace: 'normal', maxWidth: 260 }}>
                      {c?.class ? <div className="cl-mono" style={{ fontSize: 11 }}>{c.class}</div> : null}
                      {provenanceText(c?.provenance) ?? '—'}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="cl-btn cl-btn-sm"
                        onClick={() => {
                          setEditing(open ? null : r.key);
                          setText('');
                          setResult(null);
                        }}
                      >
                        <Pencil size={11} aria-hidden />
                        {open ? 'Close' : 'Edit'}
                      </button>
                    </td>
                  </tr>
                  {open ? (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--cl-raised)' }}>
                        <form
                          className="cl-stack"
                          style={{ gap: 8 }}
                          onSubmit={(e) => {
                            e.preventDefault();
                            submit(r.key);
                          }}
                        >
                          <label className="cl-label" htmlFor={`edit-${r.key}`}>
                            New value for {labelOfKey(r.key)}, in plain language
                          </label>
                          <textarea
                            id={`edit-${r.key}`}
                            className="cl-textarea"
                            value={text}
                            autoFocus
                            placeholder={`Currently: ${valueText(r.value)}`}
                            onChange={(e) => setText(e.target.value)}
                          />
                          <div className="cl-row" style={{ gap: 8 }}>
                            <button type="submit" className="cl-btn cl-btn-primary cl-btn-sm" disabled={!text.trim() || lifecycle.edit.isPending}>
                              {lifecycle.edit.isPending ? 'Sending…' : 'Send edit to Kido'}
                            </button>
                            <button type="button" className="cl-btn cl-btn-sm" onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                            <span className="cl-meta">Kido parses the text the same way it parses an interview answer and may refuse it with a reason.</span>
                          </div>
                          {result && result.key === r.key && !result.accepted ? <span className="cl-meta" style={{ color: 'var(--cl-deny)' }}>{result.error ?? result.note}</span> : null}
                        </form>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
