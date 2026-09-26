'use client';

/**
 * The open-items inbox: everything the project is waiting on, placed on the page that owns it.
 *
 * Every item is read from the Kido project summary — the interview's pending question, critical
 * requirements still unknown, build blockers, blocking security findings, failing simulation
 * scenarios and lifecycle artifacts that are missing or stale. Nothing is proposed that the backend
 * has not reported. Each item carries one real action: answer inline (the interview records it),
 * run the lifecycle gate that clears it, or open the page that owns it.
 *
 * Pages show only their own items; the Overview shows all of them. It stays invisible while there
 * is nothing waiting.
 */
import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Inbox, X } from 'lucide-react';
import { Badge, SeverityBadge } from './primitives';
import { GateButton, nextGate, useKido } from './kido';
import { segmentForPageKind } from '@/lib/studio/nav';
import { labelOfKey } from '@/lib/kido/format';
import type { ProjectSummary, Question } from '@/lib/kido/types';
import type { PageKind, Severity } from '@/lib/studio/types';

type Gate = NonNullable<ReturnType<typeof nextGate>>;

type ItemAction =
  | { kind: 'answer'; question: Question }
  | { kind: 'edit'; key: string }
  | { kind: 'gate'; gate: Gate }
  | { kind: 'open' };

interface OpenItem {
  id: string;
  page: PageKind;
  severity: Severity;
  source: string;
  title: string;
  detail: string;
  action: ItemAction;
}

const GATE_PAGE: Record<Gate, PageKind> = { finalize: 'blueprint', securityReview: 'permissions', simulate: 'simulation', build: 'code' };
const GATE_TITLE: Record<Gate, string> = {
  finalize: 'Compile the blueprint',
  securityReview: 'Run the security review',
  simulate: 'Run the simulation',
  build: 'Build the agent',
};
const RANK: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

/** Every open item the summary reports, most severe first. */
export function openItems(s: ProjectSummary): OpenItem[] {
  const out: OpenItem[] = [];
  const q = s.interview.question;
  if (q) out.push({ id: `q:${q.key}`, page: 'composer', severity: 'HIGH', source: 'Interview', title: q.reask ? `Kido needs a clearer answer: ${q.topic}` : `Kido is asking: ${q.topic}`, detail: q.text, action: { kind: 'answer', question: q } });

  const unresolved = Array.isArray(s.interview.unresolved) ? (s.interview.unresolved as { key: string; topic: string; critical: boolean }[]) : [];
  const unknown = new Map<string, { key: string; topic: string; critical: boolean }>();
  for (const u of unresolved) unknown.set(u.key, u);
  for (const r of s.interview.requirements) if (r.status === 'UNKNOWN' && r.critical) unknown.set(r.key, { key: r.key, topic: r.topic, critical: r.critical });
  for (const u of unknown.values()) {
    if (q && u.key === q.key) continue;
    out.push({ id: `req:${u.key}`, page: 'blueprint', severity: u.critical ? 'HIGH' : 'MEDIUM', source: 'Requirement', title: `${labelOfKey(u.key)} is not known`, detail: `${u.topic}${u.critical ? ' · critical: the blueprint cannot compile without it' : ''}`, action: { kind: 'edit', key: u.key } });
  }
  for (const r of s.interview.requirements.filter((x) => x.status === 'UNSATISFIABLE')) {
    out.push({ id: `unsat:${r.key}`, page: 'blueprint', severity: 'HIGH', source: 'Requirement', title: `${labelOfKey(r.key)} cannot be satisfied`, detail: `${r.topic}: no registered provider can deliver it as stated.`, action: { kind: 'edit', key: r.key } });
  }

  for (const b of s.blockers) out.push({ id: `blk:${b.code}`, page: 'blueprint', severity: 'HIGH', source: 'Build blocker', title: b.code, detail: b.detail, action: { kind: 'open' } });
  for (const f of s.security?.findings.filter((x) => x.blocking) ?? []) {
    out.push({ id: `sec:${f.id}`, page: 'permissions', severity: (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].includes(f.severity) ? f.severity : 'HIGH') as Severity, source: 'Security finding', title: `${f.class} (${f.id})`, detail: f.evidence, action: { kind: 'open' } });
  }
  for (const r of s.simulation?.results.filter((x) => !x.passed) ?? []) {
    out.push({ id: `sim:${r.id}`, page: 'simulation', severity: 'HIGH', source: 'Simulation', title: `${r.id} did not behave as expected`, detail: `${r.family}: expected ${r.expected}, got ${r.actual}${r.code ? ` (${r.code})` : ''}. ${r.note}`, action: { kind: 'open' } });
  }

  const gate = nextGate(s);
  if (gate) {
    const stale = (gate === 'securityReview' && s.security?.freshness === 'STALE') || (gate === 'simulate' && s.simulation?.freshness === 'STALE') || (gate === 'build' && s.build?.freshness === 'STALE');
    out.push({
      id: `gate:${gate}`,
      page: GATE_PAGE[gate],
      severity: stale ? 'MEDIUM' : 'LOW',
      source: stale ? 'Stale artifact' : 'Next step',
      title: GATE_TITLE[gate],
      detail: stale ? `The current artifact was produced for an older blueprint revision (now r${s.revision ?? '—'}).` : 'The lifecycle is waiting on this gate; the backend enforces the order.',
      action: { kind: 'gate', gate },
    });
  }
  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** `inset` pads it to the page column, for mounting above a page rather than inside one. */
export function AgentPatchInbox({ pageKind, inset }: { pageKind: PageKind; inset?: boolean }) {
  const { s, ctx } = useKido();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState(false);
  const items = useMemo(() => (s ? openItems(s) : []), [s]);

  if (!s || ctx.isDraft) return null;
  /* The Composer renders the pending question itself; the Overview collects everything. */
  const mine = items.filter((it) => !hidden.has(it.id) && (pageKind === 'overview' || (it.page === pageKind && !(pageKind === 'composer' && it.action.kind === 'answer'))));
  if (mine.length === 0) return null;
  const top = mine[0].severity;

  const card = (
    <div className="cl-card cl-agent-patch" style={{ marginBottom: inset ? 0 : 16 }}>
      <div className="cl-card-head">
        <button type="button" className="cl-btn cl-btn-ghost cl-btn-sm" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand open items' : 'Collapse open items'}>
          {collapsed ? <ChevronRight size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
        </button>
        <div className="cl-card-title">
          <Inbox size={13} aria-hidden style={{ marginRight: 6, verticalAlign: '-2px' }} />
          {pageKind === 'overview' ? 'Open items' : 'Waiting on this page'}
        </div>
        <Badge tone={top === 'CRITICAL' || top === 'HIGH' ? 'deny' : top === 'MEDIUM' ? 'warn' : 'neutral'}>{mine.length} open</Badge>
      </div>
      {collapsed ? null : (
        <div className="cl-card-body cl-card-body-flush">
          {mine.map((it) => (
            <Row key={it.id} item={it} projectId={s.projectId} showPage={pageKind === 'overview'} onHide={() => setHidden((h) => new Set(h).add(it.id))} />
          ))}
        </div>
      )}
    </div>
  );
  return inset ? <div style={{ padding: '20px 28px 0', maxWidth: 1280 }}>{card}</div> : card;
}

function Row({ item, projectId, showPage, onHide }: { item: OpenItem; projectId: string; showPage: boolean; onHide: () => void }) {
  const href = `/projects/${projectId}/${segmentForPageKind(item.page)}`;
  return (
    <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--cl-line)' }}>
      <div className="cl-row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <SeverityBadge severity={item.severity} />
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div className="cl-row cl-row-wrap" style={{ gap: 6 }}>
            <span className="cl-strong" style={{ fontSize: 13 }}>{item.title}</span>
            <span className="cl-meta">{item.source}</span>
          </div>
          <p className="cl-meta" style={{ whiteSpace: 'normal', marginTop: 3 }}>{item.detail}</p>
          <div style={{ marginTop: 8 }}>
            <Action item={item} href={href} showPage={showPage} />
          </div>
        </div>
        <button type="button" className="cl-btn cl-btn-ghost cl-btn-sm" onClick={onHide} aria-label="Hide for this session" title="Hide for this session">
          <X size={12} aria-hidden />
        </button>
      </div>
    </div>
  );
}

function Action({ item, href, showPage }: { item: OpenItem; href: string; showPage: boolean }) {
  const open = <Link className="cl-btn cl-btn-sm" href={href}>Open {item.page === 'composer' ? 'Composer' : labelOfKey(segmentForPageKind(item.page))}</Link>;
  switch (item.action.kind) {
    case 'answer':
      return <AnswerInline question={item.action.question} extra={showPage ? open : null} />;
    case 'edit':
      return <EditInline reqKey={item.action.key} extra={open} />;
    case 'gate':
      return (
        <div className="cl-row cl-row-wrap" style={{ gap: 6, alignItems: 'flex-start' }}>
          <GateButton gate={item.action.gate} primary />
          {showPage ? open : null}
        </div>
      );
    default:
      return open;
  }
}

/** Answers the interview's pending question; the backend decides what to ask next. */
function AnswerInline({ question, extra }: { question: Question; extra: ReactNode }) {
  const { lifecycle } = useKido();
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const send = (value: string) => {
    if (!value.trim()) return;
    setNote(null);
    lifecycle.answer.mutate([value.trim()], {
      onSuccess: (r) => {
        setText('');
        if (!r.accepted) setNote(r.note ?? 'Kido did not accept that answer.');
      },
      onError: (e) => setNote((e as Error).message),
    });
  };
  const busy = lifecycle.answer.isPending;
  return (
    <div className="cl-stack" style={{ gap: 6 }}>
      {question.choices?.length ? (
        <div className="cl-row cl-row-wrap" style={{ gap: 6 }}>
          {question.choices.map((c) => (
            <button key={c.value} type="button" className="cl-btn cl-btn-sm" disabled={busy} onClick={() => send(c.value)}>
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="cl-row cl-row-wrap" style={{ gap: 6 }}>
        <input className="cl-input" style={{ flex: '1 1 240px', width: 'auto' }} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send(text)} placeholder="Answer in your own words" aria-label={`Answer: ${question.topic}`} />
        <button type="button" className="cl-btn cl-btn-sm cl-btn-primary" disabled={busy || !text.trim()} onClick={() => send(text)}>
          {busy ? 'Sending…' : 'Answer'}
        </button>
        {extra}
      </div>
      {note ? <span className="cl-meta" style={{ color: 'var(--cl-deny)' }}>{note}</span> : null}
    </div>
  );
}

/** States a requirement directly; the backend validates it like an interview answer. */
function EditInline({ reqKey, extra }: { reqKey: string; extra: ReactNode }) {
  const { lifecycle } = useKido();
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const busy = lifecycle.edit.isPending;
  const send = () => {
    if (!text.trim()) return;
    setNote(null);
    lifecycle.edit.mutate([reqKey, text.trim()], {
      onSuccess: (r) => {
        if (r.accepted) setText('');
        else setNote(r.note ?? 'Kido did not accept that value.');
      },
      onError: (e) => setNote((e as Error).message),
    });
  };
  return (
    <div className="cl-stack" style={{ gap: 6 }}>
      <div className="cl-row cl-row-wrap" style={{ gap: 6 }}>
        <input className="cl-input" style={{ flex: '1 1 240px', width: 'auto' }} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder={`State ${labelOfKey(reqKey).toLowerCase()}`} aria-label={`Set ${reqKey}`} />
        <button type="button" className="cl-btn cl-btn-sm cl-btn-primary" disabled={busy || !text.trim()} onClick={send}>
          {busy ? 'Saving…' : 'Set'}
        </button>
        {extra}
      </div>
      {note ? <span className="cl-meta" style={{ color: 'var(--cl-deny)' }}>{note}</span> : null}
    </div>
  );
}
