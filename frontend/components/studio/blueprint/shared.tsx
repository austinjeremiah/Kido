'use client';

/**
 * Small pieces shared by the Blueprint, Simulation and Security pages: the stale-artifact banner
 * (derived from each artifact's freshness in the project summary), a generic record renderer for
 * blueprint sub-documents whose shape is open, and time helpers for the backend's epoch-ms stamps.
 */
import type { ReactNode } from 'react';
import { BlockerBanner, Spec } from '@/components/studio/primitives';
import { GateButton, nextGate } from '@/components/studio/kido';
import { labelOfKey, valueText } from '@/lib/kido/format';
import type { Freshness, ProjectSummary } from '@/lib/kido/types';

export const isoOf = (ms: number | null | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);
export const whenText = (ms: number | null | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '—');

type Artifact = { key: 'security' | 'simulation' | 'build'; label: string; freshness: Freshness; revision: number | null };

/** Freshness of every derived artifact for the current blueprint revision. */
export function artifactsOf(s: ProjectSummary): Artifact[] {
  return [
    { key: 'security', label: 'Security review', freshness: s.security?.freshness ?? 'NONE', revision: s.security?.blueprintRevision ?? null },
    { key: 'simulation', label: 'Simulation', freshness: s.simulation?.freshness ?? 'NONE', revision: s.simulation?.blueprintRevision ?? null },
    { key: 'build', label: 'Build', freshness: s.build?.freshness ?? 'NONE', revision: s.build?.blueprintRevision ?? null },
  ];
}

/**
 * One banner naming every artifact that is not CURRENT for the blueprint revision, with the next
 * gate the backend will accept. `only` narrows it to the artifacts a page cares about.
 */
export function StaleArtifacts({ s, only }: { s: ProjectSummary; only?: Artifact['key'][] }) {
  if (!s.blueprint) return null;
  const rows = artifactsOf(s).filter((a) => a.freshness !== 'CURRENT' && (!only || only.includes(a.key)));
  if (!rows.length) return null;
  const gate = nextGate(s);
  const stale = rows.filter((r) => r.freshness === 'STALE');
  return (
    <BlockerBanner
      tone={stale.length ? 'warn' : 'neutral'}
      title={stale.length ? `${stale.map((r) => r.label).join(', ')} STALE` : `${rows.map((r) => r.label).join(', ')} not produced yet`}
      actions={gate ? <GateButton gate={gate} /> : null}
    >
      {rows
        .map((r) => (r.freshness === 'STALE' ? `${r.label} was produced for Blueprint r${r.revision}; the current Blueprint is r${s.blueprint!.revision}.` : `${r.label} has not been run for r${s.blueprint!.revision}.`))
        .join(' ')}{' '}
      Old results are never presented as proof of the current revision.
    </BlockerBanner>
  );
}

/** Any open blueprint sub-document as ruled rows; nested objects render as their JSON. */
export function RecordSpec({ record, empty = 'Nothing recorded' }: { record: Record<string, unknown> | null | undefined; empty?: string }) {
  const entries = Object.entries(record ?? {});
  if (!entries.length) return <p className="cl-meta">{empty}</p>;
  return (
    <Spec
      rows={entries.map(([k, v]) => ({
        key: k,
        label: labelOfKey(k),
        value: v !== null && typeof v === 'object' && !Array.isArray(v) ? <span className="cl-mono" style={{ fontSize: 12 }}>{JSON.stringify(v)}</span> : valueText(Array.isArray(v) && v.length === 0 ? '—' : v),
      }))}
    />
  );
}

/** A table over an array of open records; columns are the union of their keys unless given. */
export function RecordTable({ rows, columns, empty = 'None', render }: { rows: Array<Record<string, unknown>>; columns?: string[]; empty?: string; render?: Record<string, (v: unknown, row: Record<string, unknown>) => ReactNode> }) {
  if (!rows.length) return <p className="cl-meta">{empty}</p>;
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return (
    <div className="cl-table-scroll">
      <table className="cl-table">
        <thead>
          <tr>{cols.map((c) => <th key={c}>{labelOfKey(c)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className={typeof r[c] === 'string' && /^0x[0-9a-f]{8,}/i.test(String(r[c])) ? 'cl-mono' : undefined} style={{ wordBreak: 'break-word' }}>
                  {render?.[c] ? render[c]!(r[c], r) : r[c] !== null && typeof r[c] === 'object' && !Array.isArray(r[c]) ? <span className="cl-mono" style={{ fontSize: 12 }}>{JSON.stringify(r[c])}</span> : valueText(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A horizontal proportion bar (pass rate, counts). */
export function RateBar({ value, total, tone = 'pass' }: { value: number; total: number; tone?: 'pass' | 'deny' | 'warn' }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  const color = tone === 'pass' ? 'var(--cl-pass)' : tone === 'deny' ? 'var(--cl-deny)' : 'var(--cl-warn)';
  return (
    <div role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={value} aria-label={`${value} of ${total}`} style={{ height: 6, background: 'var(--cl-line)', width: '100%', overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color }} />
    </div>
  );
}
