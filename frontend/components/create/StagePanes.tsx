'use client';

/**
 * The right-hand pane for the stages after the blueprint.
 *
 * Shallow throughout: the workbench has real pages for findings, code and
 * simulations, and none of this is a second copy of them.
 */
import { Check, FileCode2, Loader } from 'lucide-react';
import { SeverityBadge } from '@/components/studio/primitives';
import type { Finding } from '@/lib/create/review';

/* ── 04 · security ──────────────────────────────────────────────────────── */

export function FindingList({ findings }: { findings: Finding[] }) {
  return (
    <div className="kc-boxes">
      <p className="kc-boxes__count">
        {findings.length} finding{findings.length === 1 ? '' : 's'} · none blocking
      </p>
      <div className="kc-list">
        {findings.map((f) => (
          <div key={f.id} className="kc-finding">
            <div className="kc-finding__head">
              <span className="kc-finding__title">{f.title}</span>
              <SeverityBadge severity={f.severity} />
            </div>
            <p className="kc-finding__body">{f.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 05 · approve ───────────────────────────────────────────────────────── */

export function ApprovalList({
  findings,
  acknowledged,
  onToggle,
}: {
  findings: Finding[];
  acknowledged: string[];
  onToggle: (id: string) => void;
}) {
  const all = acknowledged.length === findings.length;

  return (
    <div className="kc-boxes">
      <p className="kc-boxes__count">
        {acknowledged.length} of {findings.length} acknowledged
      </p>
      <div className="kc-list">
        {findings.map((f) => {
          const on = acknowledged.includes(f.id);
          return (
            <button
              key={f.id}
              type="button"
              className="kc-ack"
              data-on={on}
              onClick={() => onToggle(f.id)}
              aria-pressed={on}
            >
              <span className="kc-ack__box" aria-hidden>
                {on ? <Check size={12} strokeWidth={3} /> : null}
              </span>
              <span className="kc-ack__text">
                <span className="kc-finding__head">
                  <span className="kc-finding__title">{f.title}</span>
                  <SeverityBadge severity={f.severity} />
                </span>
                <span className="kc-finding__body">{f.body}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="kc-boxes__foot">
        {all
          ? 'Every finding is acknowledged. Approve on the left to generate the agent.'
          : 'Each finding is acknowledged on its own. Nothing is generated until all of them are.'}
      </p>
    </div>
  );
}

/* ── 06 · build ─────────────────────────────────────────────────────────── */

export function BuildProgress({ files, done }: { files: string[]; done: boolean }) {
  return (
    <div className="kc-boxes">
      <p className="kc-boxes__count">{done ? 'Generated' : 'Generating'}</p>
      <div className="kc-list">
        {files.map((f) => (
          <div key={f} className="kc-file">
            <FileCode2 size={13} aria-hidden />
            <span className="cl-mono">{f}</span>
            <Check size={12} strokeWidth={3} className="kc-file__tick" aria-hidden />
          </div>
        ))}
        {!done ? (
          <div className="kc-file kc-file--working">
            <Loader size={13} aria-hidden className="kc-spin" />
            <span className="cl-mono">…</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ── 07 · tests ─────────────────────────────────────────────────────────── */

export interface Suite {
  name: string;
  passed: number;
  failed: number;
}

export function TestResults({ suites, done }: { suites: Suite[]; done: boolean }) {
  const passed = suites.reduce((n, s) => n + s.passed, 0);
  const failed = suites.reduce((n, s) => n + s.failed, 0);

  return (
    <div className="kc-boxes">
      <p className="kc-boxes__count">
        {done ? `${passed} passed · ${failed} failed` : 'Running'}
      </p>
      <div className="kc-list">
        {suites.map((s) => (
          <div key={s.name} className="kc-suite">
            <span className="kc-suite__name">{s.name}</span>
            <span className="kc-suite__score" data-failed={s.failed > 0}>
              {s.passed}/{s.passed + s.failed}
            </span>
          </div>
        ))}
        {!done ? (
          <div className="kc-file kc-file--working">
            <Loader size={13} aria-hidden className="kc-spin" />
            <span className="cl-mono">…</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
