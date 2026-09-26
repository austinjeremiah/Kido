'use client';

/**
 * Right-hand panes of the create flow, rendered from the Kido project summary. Nothing here is
 * derived on the client: requirements, blueprint, findings, scenarios and the build artifact are
 * exactly what the backend returned.
 */
import { Check, Loader, X } from 'lucide-react';
import { SeverityBadge } from '@/components/studio/primitives';
import type { Blocker, Blueprint, BuildArtifact, Requirement, SecurityReport, SimulationReport } from '@/lib/kido/types';
import { amount, chainLabel, labelOfKey, valueText, windowLabel } from '@/lib/kido/format';
import type { Severity } from '@/lib/studio/types';

export function KidoRequirementBoxes({ requirements, pendingKey }: { requirements: Requirement[]; pendingKey?: string }) {
  const shown = requirements.filter((r) => r.status !== 'NOT_APPLICABLE');
  const resolved = shown.filter((r) => r.status === 'RESOLVED').length;
  return (
    <div className="kc-boxes">
      <p className="kc-boxes__count">
        {resolved} of {shown.length} captured
      </p>
      <div className="kc-boxes__grid">
        {shown.map((r) => {
          const asking = r.key === pendingKey;
          const state = r.status === 'RESOLVED' ? 'set' : asking ? 'asking' : 'open';
          return (
            <div key={r.key} className="kc-box" data-state={state}>
              <div className="kc-box__head">
                <span className="kc-box__label">{labelOfKey(r.key)}</span>
                <span className="kc-box__state">{r.status === 'RESOLVED' ? (r.confirmed ? 'Confirmed' : 'Inferred') : asking ? 'Asking' : r.critical ? 'Required' : 'Open'}</span>
              </div>
              <p className={r.status === 'RESOLVED' ? 'kc-box__value' : 'kc-box__wants'}>{r.status === 'RESOLVED' ? valueText(r.value) : r.topic.toLowerCase()}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function KidoBlueprintBoxes({ blueprint, blockers }: { blueprint: Blueprint; blockers: Blocker[] }) {
  const a = blueprint.authority;
  const rows: { label: string; value: string; pending?: boolean }[] = [
    { label: 'Objective', value: blueprint.objective.summary ?? blueprint.objective.statement },
    { label: 'Agent id', value: blueprint.kidoAgentId },
    { label: 'Chains', value: blueprint.chains.map(chainLabel).join(' · ') || '—', pending: !blueprint.chains.length },
    {
      label: 'Identity',
      value: blueprint.identity.bindings.length ? blueprint.identity.bindings.map((b) => `${b.name ?? '(name planned)'} · ${b.provider.toUpperCase()}`).join('\n') : 'No public identity',
    },
    { label: 'Monitors', value: blueprint.monitors.map((m) => `${m.metric} ${m.op} ${m.threshold ?? (m.thresholdPrivateRef ? '(private)' : '—')} → ${m.action ?? m.response}`).join('\n') || 'None' },
    { label: 'Allowed actions', value: a.allowedActions.join(', ') || 'None' },
    { label: 'Forbidden', value: a.forbiddenActions.join(', ') || 'None' },
    {
      label: 'Limits',
      value: a.limits.map((l) => { const f = (v: string) => amount(v, l.asset, l.chain, blueprint.assets); return `${chainLabel(l.chain)}: ${f(l.perAction)} per action, ${f(l.perWindow)} per ${windowLabel(l.windowSeconds)}, ${f(l.total)} total`; }).join('\n') || 'None',
      pending: a.allowedActions.length > 0 && !a.limits.length,
    },
    { label: 'Payees', value: [...a.payees, ...a.beneficiaries].map((p) => `${p.label} · ${chainLabel(p.chain)}`).join('\n') || 'None' },
    { label: 'Authority', value: `${a.mode ?? '—'}${a.provider ? ` · enforced by ${a.provider === 'AMANE' ? 'Amane' : 'owner wallet'}` : ''}` },
    { label: 'Privacy', value: blueprint.privacy.required ? blueprint.privacy.providers.map((p) => `${p.providerId} (${chainLabel(p.chain)})`).join(', ') || 'Required' : 'Not required' },
  ];
  return (
    <div className="kc-boxes">
      <p className="kc-boxes__count">
        Blueprint revision {blueprint.revision}
        {blockers.length ? ` · ${blockers.length} blocker${blockers.length === 1 ? '' : 's'}` : ' · buildable'}
      </p>
      {blockers.length ? (
        <div className="kc-list">
          {blockers.map((b) => (
            <div key={`${b.code}:${b.detail}`} className="kc-finding">
              <div className="kc-finding__head">
                <span className="kc-finding__title">{b.code}</span>
                <SeverityBadge severity="HIGH" />
              </div>
              <p className="kc-finding__body">{b.detail}</p>
            </div>
          ))}
        </div>
      ) : null}
      <div className="kc-boxes__grid">
        {rows.map((r) => (
          <div key={r.label} className="kc-box" data-state={r.pending ? 'open' : 'set'}>
            <div className="kc-box__head">
              <span className="kc-box__label">{r.label}</span>
              <span className="kc-box__state">{r.pending ? 'Missing' : 'Set'}</span>
            </div>
            <p className={r.pending ? 'kc-box__wants' : 'kc-box__value'} style={{ whiteSpace: 'pre-line' }}>
              {r.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function KidoFindingList({ report }: { report: SecurityReport }) {
  const blocking = report.findings.filter((f) => f.blocking).length;
  return (
    <div className="kc-boxes">
      <p className="kc-boxes__count">
        {report.findings.length} finding{report.findings.length === 1 ? '' : 's'} · {blocking ? `${blocking} blocking` : 'none blocking'}
      </p>
      <div className="kc-list">
        {report.findings.length === 0 ? <p className="cl-body">No findings for this revision.</p> : null}
        {report.findings.map((f) => (
          <div key={f.id} className="kc-finding">
            <div className="kc-finding__head">
              <span className="kc-finding__title">
                {f.id} · {f.class}
                {f.blocking ? ' · blocking' : ''}
              </span>
              <SeverityBadge severity={f.severity as Severity} />
            </div>
            <p className="kc-finding__body">{f.evidence}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function KidoSimulation({ report, running }: { report: SimulationReport | null; running: boolean }) {
  if (!report) {
    return (
      <div className="kc-boxes">
        <p className="kc-boxes__count">{running ? 'Running the scenarios' : 'Not run yet'}</p>
        {running ? (
          <div className="kc-file kc-file--working">
            <Loader size={13} aria-hidden className="kc-spin" />
            <span className="cl-mono">…</span>
          </div>
        ) : null}
      </div>
    );
  }
  const families = new Map<string, { passed: number; failed: number }>();
  for (const r of report.results) {
    const f = families.get(r.family) ?? { passed: 0, failed: 0 };
    r.passed ? f.passed++ : f.failed++;
    families.set(r.family, f);
  }
  const failed = report.results.filter((r) => !r.passed);
  return (
    <div className="kc-boxes">
      <p className="kc-boxes__count">
        {report.results.length - failed.length} passed · {failed.length} failed
      </p>
      <div className="kc-list">
        {[...families].map(([name, s]) => (
          <div key={name} className="kc-suite">
            <span className="kc-suite__name">{labelOfKey(name)}</span>
            <span className="kc-suite__score" data-failed={s.failed > 0}>
              {s.passed}/{s.passed + s.failed}
            </span>
          </div>
        ))}
        {failed.map((r) => (
          <div key={r.id} className="kc-finding">
            <div className="kc-finding__head">
              <span className="kc-finding__title">{r.id}</span>
              <X size={13} aria-hidden />
            </div>
            <p className="kc-finding__body">
              expected {r.expected}, got {r.actual}
              {r.code ? ` (${r.code})` : ''}. {r.note}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function KidoBuildPane({ build, running }: { build: BuildArtifact | null; running: boolean }) {
  if (!build) {
    return (
      <div className="kc-boxes">
        <p className="kc-boxes__count">{running ? 'Building' : 'Not built yet'}</p>
        {running ? (
          <div className="kc-file kc-file--working">
            <Loader size={13} aria-hidden className="kc-spin" />
            <span className="cl-mono">…</span>
          </div>
        ) : null}
      </div>
    );
  }
  const items = [
    ...build.agents.map((a) => `agent ${a.role} · ${a.knowledgePacks.length} knowledge pack${a.knowledgePacks.length === 1 ? '' : 's'}${a.missingPacks.length ? ` · missing ${a.missingPacks.join(', ')}` : ''}`),
    ...build.monitors.map((m) => `monitor ${m}`),
    ...build.identity.map((b) => `identity ${b.name} (${String(b.providerId).toUpperCase()})`),
    ...Object.entries(build.authority.crossChainTotal).map(([k, v]) => `authority cap ${k}: ${v}`),
    ...build.authority.excludedActions.map((x) => `excluded ${x}`),
  ];
  return (
    <div className="kc-boxes">
      <p className="kc-boxes__count">Build {build.buildRevision} · blueprint revision {build.blueprintRevision}</p>
      <div className="kc-list">
        {items.map((f) => (
          <div key={f} className="kc-file">
            <Check size={12} strokeWidth={3} className="kc-file__tick" aria-hidden />
            <span className="cl-mono">{f}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
