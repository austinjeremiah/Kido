/**
 * Derivations shared by Overview and Activity: the project's timeline (recorded deployment and
 * control events plus lifecycle events read off the summary) and the alert list (the same rules
 * the Control Plane applies). Nothing here invents a value; an event whose time the backend does
 * not record is marked untimed and ordered by where it must have happened.
 */
import type { ProjectEvent, ProjectSummary, Runtime } from '@/lib/kido/types';
import { LEASE_STATUS, chainLabel } from '@/lib/kido/format';

export type TimelineSource = 'lifecycle' | 'on-chain';
export type TimelineKind = 'project' | 'interview' | 'blueprint' | 'security' | 'simulation' | 'build' | 'deploy' | 'control' | 'wallet' | 'other';
export type TimelineTone = 'pass' | 'warn' | 'deny' | 'data' | 'neutral';

export interface TimelineEvent {
  id: string;
  /** When the backend recorded it; null when it records no time for this step. */
  at: number | null;
  /** Position used for ordering and day grouping (equals `at` when known). */
  sortAt: number;
  seq: number;
  source: TimelineSource;
  kind: TimelineKind;
  type: string;
  title: string;
  detail: string;
  chain?: string;
  tx?: string;
  tone: TimelineTone;
  /** Workbench segment that holds the full record. */
  segment?: string;
}

export const KIND_LABEL: Record<TimelineKind, string> = {
  project: 'Project', interview: 'Interview', blueprint: 'Blueprint', security: 'Security review', simulation: 'Simulation',
  build: 'Build', deploy: 'Deployment', control: 'Owner control', wallet: 'Wallet transaction', other: 'Other',
};

function kindOfRecorded(type: string): TimelineKind {
  if (type.startsWith('deploy.')) return 'deploy';
  if (type.startsWith('control.')) return 'control';
  if (type.startsWith('wallet.')) return 'wallet';
  return 'other';
}

function toneOfRecorded(e: ProjectEvent): TimelineTone {
  if (/refused|failed|error/i.test(e.detail)) return 'deny';
  if (e.type === 'deploy.active') return 'pass';
  if (e.type.startsWith('control.')) return 'warn';
  return 'data';
}

const SEGMENT_OF: Partial<Record<TimelineKind, string>> = { interview: 'build', blueprint: 'blueprint', security: 'security', simulation: 'simulation', build: 'build', deploy: 'deployments', control: 'control-plane', wallet: 'deployments' };

/** Every event for the project, newest first. */
export function timelineOf(s: ProjectSummary, recorded: ProjectEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  let seq = 0;
  const push = (e: Omit<TimelineEvent, 'seq' | 'segment'> & { segment?: string }) => out.push({ segment: SEGMENT_OF[e.kind], ...e, seq: seq++ });

  push({ id: 'project.created', at: s.createdAt, sortAt: s.createdAt, source: 'lifecycle', kind: 'project', type: 'project.created', title: `Project "${s.name}" created`, detail: s.objective, tone: 'data', segment: 'overview' });

  s.interview.transcript.forEach((t, i) => {
    push({
      id: `interview.${i}`, at: null, sortAt: s.createdAt, source: 'lifecycle', kind: 'interview',
      type: t.role === 'kido' ? 'interview.question' : 'interview.answer',
      title: t.role === 'kido' ? `Kido asked${t.key ? ` · ${t.key}` : ''}` : `Owner answered${t.key ? ` · ${t.key}` : ''}`,
      detail: t.text, tone: 'neutral',
    });
  });

  const gateTimes = [s.security?.generatedAt, s.simulation?.generatedAt, s.build?.generatedAt].filter((x): x is number => typeof x === 'number');
  if (s.blueprint) {
    const bound = gateTimes.length ? Math.min(...gateTimes) : s.createdAt;
    push({
      id: `blueprint.r${s.blueprint.revision}`, at: null, sortAt: bound, source: 'lifecycle', kind: 'blueprint', type: 'blueprint.compiled',
      title: `Blueprint revision ${s.blueprint.revision} compiled`,
      detail: `${s.blueprintHash ?? ''}${s.blueprint.parentRevisionHash ? ` · parent ${s.blueprint.parentRevisionHash}` : ' · first revision'}${s.blockers.length ? ` · ${s.blockers.length} blocker(s)` : ''}`,
      tone: s.blockers.length ? 'warn' : 'pass',
    });
  }
  if (s.security) {
    const blocking = s.security.findings.filter((f) => f.blocking).length;
    push({
      id: 'security.review', at: s.security.generatedAt, sortAt: s.security.generatedAt, source: 'lifecycle', kind: 'security', type: 'security.reviewed',
      title: `Security review of revision ${s.security.blueprintRevision}`,
      detail: `${s.security.findings.length} finding(s), ${blocking} blocking · ${s.security.freshness.toLowerCase()}`,
      tone: s.security.blocking ? 'deny' : s.security.freshness === 'STALE' ? 'warn' : 'pass',
    });
  }
  if (s.simulation) {
    const passed = s.simulation.results.filter((r) => r.passed).length;
    push({
      id: 'simulation.run', at: s.simulation.generatedAt, sortAt: s.simulation.generatedAt, source: 'lifecycle', kind: 'simulation', type: 'simulation.run',
      title: `Simulation of revision ${s.simulation.blueprintRevision}`,
      detail: `${passed}/${s.simulation.results.length} scenarios passed · ${s.simulation.freshness.toLowerCase()}`,
      tone: !s.simulation.passed ? 'deny' : s.simulation.freshness === 'STALE' ? 'warn' : 'pass',
    });
  }
  if (s.build) {
    push({
      id: 'build.done', at: s.build.generatedAt, sortAt: s.build.generatedAt, source: 'lifecycle', kind: 'build', type: 'build.completed',
      title: `Build ${s.build.buildRevision} of revision ${s.build.blueprintRevision}`,
      detail: `${s.build.agents.length} agent(s): ${s.build.agents.map((a) => a.role).join(', ')} · ${s.build.freshness.toLowerCase()}`,
      tone: s.build.freshness === 'STALE' ? 'warn' : 'pass',
    });
  }

  recorded.forEach((e, i) => {
    const kind = kindOfRecorded(e.type);
    push({ id: `rec.${i}.${e.at}`, at: e.at, sortAt: e.at, source: 'on-chain', kind, type: e.type, title: e.type, detail: e.detail, chain: e.chain, tx: e.tx, tone: toneOfRecorded(e) });
  });

  return out.sort((a, b) => b.sortAt - a.sortAt || b.seq - a.seq);
}

export type AlertSeverity = 'critical' | 'warning' | 'info';
export interface Alert { id: string; severity: AlertSeverity; title: string; detail: string; segment: string }

/** Open alerts: runtime read errors, paused accounts, inactive leases, stale artifacts, blocking findings. */
export function alertsOf(s: ProjectSummary, runtime: Runtime | null | undefined): Alert[] {
  const out: Alert[] = [];
  for (const c of runtime?.deployed ? runtime.chains : []) {
    if (c.error) out.push({ id: `rt-err-${c.chain}`, severity: 'critical', title: `${chainLabel(c.chain)}: runtime read failed`, detail: c.error, segment: 'runtime' });
    if (c.paused) out.push({ id: `rt-paused-${c.chain}`, severity: 'warning', title: `${chainLabel(c.chain)}: account paused`, detail: `Every action is refused until the owner signs an unpause${c.pauseEpoch !== null ? ` (pause epoch ${c.pauseEpoch})` : ''}.`, segment: 'control-plane' });
    if (c.leaseStatus !== null && c.leaseStatus !== 1)
      out.push({ id: `rt-lease-${c.chain}`, severity: c.leaseStatus === 2 ? 'critical' : 'warning', title: `${chainLabel(c.chain)}: lease ${LEASE_STATUS[c.leaseStatus] ?? c.leaseStatus}`, detail: 'The agent key cannot act on this chain without an active lease.', segment: 'runtime' });
  }
  for (const f of s.security?.findings ?? []) if (f.blocking) out.push({ id: `finding-${f.id}`, severity: 'critical', title: `Blocking finding ${f.id} · ${f.class}`, detail: f.evidence, segment: 'security' });
  for (const r of s.simulation?.results ?? []) if (!r.passed) out.push({ id: `sim-${r.id}`, severity: 'critical', title: `Scenario ${r.id} failed`, detail: `expected ${r.expected}, got ${r.actual}${r.code ? ` (${r.code})` : ''}. ${r.note}`, segment: 'simulation' });
  for (const b of s.blockers) out.push({ id: `blocker-${b.code}`, severity: 'warning', title: b.code, detail: b.detail, segment: 'blueprint' });
  const stale: Array<[string, string, string]> = [];
  if (s.security?.freshness === 'STALE') stale.push(['security', 'Security review', 'security']);
  if (s.simulation?.freshness === 'STALE') stale.push(['simulation', 'Simulation', 'simulation']);
  if (s.build?.freshness === 'STALE') stale.push(['build', 'Build', 'build']);
  for (const [k, label, seg] of stale) out.push({ id: `stale-${k}`, severity: 'warning', title: `${label} is stale`, detail: `The blueprint changed after it ran (revision ${s.revision}); run it again.`, segment: seg });
  return out;
}

/** "3 min ago" for a millisecond timestamp. */
export function relTime(at: number, now = Date.now()): string {
  const d = Math.round((now - at) / 1000);
  if (Math.abs(d) < 45) return 'just now';
  const units: Array<[number, string]> = [[60, 'min'], [3600, 'h'], [86_400, 'd'], [2_592_000, 'mo'], [31_536_000, 'y']];
  let label = `${Math.round(d / 60)} min`;
  for (let i = units.length - 1; i >= 0; i--) {
    const [sec, u] = units[i]!;
    if (Math.abs(d) >= sec) {
      label = `${Math.round(d / sec)} ${u}`;
      break;
    }
  }
  return d >= 0 ? `${label} ago` : `in ${label.replace('-', '')}`;
}

/** Triggers a browser download of text content. */
export function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
