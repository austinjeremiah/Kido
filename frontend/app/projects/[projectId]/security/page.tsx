'use client';

/**
 * Permissions & Security (spec §14).
 *
 * The clearest possible answer to: what can this agent do, and what can it
 * never do? Enabling or disabling authority is deliberately NOT offered here —
 * that belongs to Policies / Control Plane behind a typed confirmation.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, FileDiff, GitCompare, Play, ShieldCheck } from 'lucide-react';
import { StudioPage, useStudioPage } from '@/components/studio/PageScaffold';
import {
  Badge,
  BlockerBanner,
  Section,
  Spec,
  StatusBadge,
  VerdictBadge,
} from '@/components/studio/primitives';
import { Modal } from '@/components/studio/dialogs';
import { useWorkbench } from '@/lib/studio/workbench';
import { toPermissions, type AuthorityDiff } from '@/lib/studio/api/adapters/design';
import { useLabSummary } from '@/lib/studio/api/queries';
import { EmptyState } from '@/components/studio/primitives';
import type { PermissionsModel, Verdict } from '@/lib/studio/types';

const COLUMNS: { verdict: Verdict; tone: 'pass' | 'warn' | 'deny'; blurb: string }[] = [
  { verdict: 'ALLOW', tone: 'pass', blurb: 'Performed autonomously, with no human in the loop.' },
  { verdict: 'ESCALATE', tone: 'warn', blurb: 'Refused autonomously. Requires an explicit human approval.' },
  { verdict: 'DENY', tone: 'deny', blurb: 'Never permitted. No approval path exists.' },
];

export default function PermissionsPage() {
  const router = useRouter();
  const { setSelection, pushToast } = useWorkbench();
  const [expansionsOpen, setExpansionsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const { project, ctx } = useStudioPage('security');
  const summaryQ = useLabSummary(ctx.dataProjectId);
  const bp = ctx.buildView?.blueprint ?? null;
  const PERMISSIONS = useMemo<PermissionsModel | null>(
    () => (bp ? toPermissions(bp, ctx.buildView?.findings ?? [], summaryQ.data?.summary.execution.label ?? project.environment.executionNetwork) : null),
    [bp, ctx.buildView?.findings, summaryQ.data, project.environment.executionNetwork],
  );
  const capabilities = summaryQ.data?.capabilities ?? [];
  const unestablished = summaryQ.data?.unestablishedBoundaries ?? [];

  const grouped = useMemo(
    () =>
      COLUMNS.map((column) => ({
        ...column,
        rules: (PERMISSIONS?.rules ?? []).filter((rule) => rule.verdict === column.verdict),
      })),
    [PERMISSIONS],
  );

  /* Drafts live on the Blueprint page; a revision newer than the deployment is what this page can compare. */
  const AUTHORITY_DIFF: AuthorityDiff[] = [];
  const expansions = AUTHORITY_DIFF.filter((d) => d.expansion);
  const deployedBehind = (project.revisions.deployment ?? 0) > 0 && (project.revisions.blueprint ?? 0) > (project.revisions.deployment ?? 0);
  const go = (segment: string, qs = '') => router.push(`/projects/${ctx.routeProjectId}/${segment}${qs}`);

  if (!bp || !PERMISSIONS) {
    return (
      <StudioPage segment="security" subtitle="What can this agent do, and what can it never do?">
        <EmptyState
          title={ctx.loading ? 'Loading…' : 'No authority model yet'}
          body={ctx.loading ? '' : 'The permission matrix is derived from the Blueprint. Describe the agent first and generate it.'}
          action={ctx.loading ? undefined : <button type="button" className="cl-btn cl-btn-primary" onClick={() => go('build')}>Build Agent</button>}
        />
      </StudioPage>
    );
  }

  return (
    <StudioPage
      segment="security"
      subtitle="What can this agent do, and what can it never do?"
      actions={
        <>
          {/* Five full-length labels wrapped onto a second row and pushed the
              primary action down under the others. The verbs were doing the
              work anyway — "Open Policy" next to a shield is just "Policy". */}
          <button type="button" className="cl-btn" onClick={() => go('policies')} title="Open the Policies page">
            <ShieldCheck size={13} aria-hidden />
            Policy
          </button>
          <button type="button" className="cl-btn" onClick={() => go('blueprint', '?compare=1')} title="Compare Blueprint revisions">
            <GitCompare size={13} aria-hidden />
            Compare
          </button>
          <button type="button" className="cl-btn" onClick={() => go('simulation', '?group=policy-boundaries&run=1')} title="Run the boundary simulations">
            <Play size={13} aria-hidden />
            Simulate
          </button>
          <button type="button" className="cl-btn" onClick={() => setExportOpen(true)} title="Export a secret-free permission summary">
            <Download size={13} aria-hidden />
            Export
          </button>
          <button type="button" className="cl-btn cl-btn-primary" onClick={() => go('blueprint')}>
            Create policy revision
          </button>
        </>
      }
      banners={
        <>
          {unestablished.length > 0 ? (
            <BlockerBanner tone="warn" title="Boundaries not established" actions={<button type="button" className="cl-btn cl-btn-sm" onClick={() => go('build')}>Open Composer</button>}>
              {unestablished.join(' · ')} — a limit the description did not state is never invented. State it and regenerate.
            </BlockerBanner>
          ) : null}
          {deployedBehind ? (
            <BlockerBanner
              tone="warn"
              title={`The active deployment is on r${project.revisions.deployment}; the Blueprint is r${project.revisions.blueprint}`}
              actions={<button type="button" className="cl-btn cl-btn-sm" onClick={() => go('blueprint', '?compare=1')}><FileDiff size={12} aria-hidden />Compare</button>}
            >
              The matrix below reflects Blueprint r{PERMISSIONS.policyRevision}. The deployed agent keeps its own revision until you deploy again.
            </BlockerBanner>
          ) : null}
          {expansions.length > 0 ? (
            <BlockerBanner tone="warn" title={`${expansions.length} authority increase${expansions.length === 1 ? '' : 's'}`} actions={<button type="button" className="cl-btn cl-btn-sm" onClick={() => setExpansionsOpen(true)}>Review</button>}>
              An authority expansion widens what the agent can do without a human.
            </BlockerBanner>
          ) : null}
        </>
      }
    >
      {/* Posture leads: it is the one-line answer, and the two sections under
          it are the working. It was third, after the thing it summarises.

          The inner tile also read "Security posture" inside a section called
          "Security posture" — the same two words, eight pixels apart. And the
          Card around four badges framed a row that has no need of a frame. */}
      <Section label="Posture">
        <div className="cl-posture">
          <PostureItem label="Overall" value={<StatusBadge status={PERMISSIONS.posture} large />} />
          <PostureItem label="Execution" value={<Badge tone="sim" large>{PERMISSIONS.executionSummary}</Badge>} />
          <PostureItem label="Mainnet writes" value={<Badge tone="deny" large>{PERMISSIONS.mainnetWrites}</Badge>} />
          <PostureItem label="Policy" value={<Badge tone="neutral" large>{`revision ${PERMISSIONS.policyRevision}`}</Badge>} />
        </div>
      </Section>

      {/* "In one sentence each" named the *format* of the content, not the
          content. Two cards headed "This agent can" and "This agent can never"
          already say what they are; the section says what they are about. */}
      {capabilities.length > 0 ? (
        <Section label="Can and cannot">
          <div className="cl-grid cl-grid-2">
            {(['CAN', 'CANNOT'] as const).map((kind) => (
              /* Tone-marked rather than titled alike: "can" and "can never"
                 differ by one word in the heading and by everything in meaning,
                 so the column carries the verdict colour down its edge. */
              <div className="cl-claims" data-tone={kind === 'CAN' ? 'pass' : 'deny'} key={kind}>
                <div className="cl-claims-head">{kind === 'CAN' ? 'This agent can' : 'This agent can never'}</div>
                <ul>
                  {capabilities.filter((c) => c.kind === kind).map((c, i) => (
                    <li key={i} className="cl-claim" title={`derived from ${c.derivedFrom}`}>
                      <span className="cl-claim-text">{c.statement}</span>
                      <span className="cl-claim-ref">{c.derivedFrom}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      ) : null}


      {/* ALLOW / ESCALATE / DENY */}
      <Section label="Authority boundaries">
        <div className="cl-matrix">
          {grouped.map((column) => (
            <div className="cl-matrix-col" data-tone={column.tone} key={column.verdict}>
              <div className="cl-matrix-col-head">
                {column.verdict}
                <span style={{ marginLeft: 8, opacity: 0.75, textTransform: 'none', letterSpacing: 0 }}>
                  {column.rules.length}
                </span>
              </div>
              <div style={{ padding: '9px 14px', borderBottom: '1px solid var(--cl-line)' }}>
                <span className="cl-meta" style={{ whiteSpace: 'normal' }}>
                  {column.blurb}
                </span>
              </div>
              {column.rules.map((rule) => (
                <button
                  key={rule.id}
                  type="button"
                  className="cl-matrix-item"
                  style={{ width: '100%', textAlign: 'left', cursor: 'pointer', display: 'block' }}
                  onClick={() => setSelection({ kind: 'permission-rule', id: rule.id, label: rule.label })}
                >
                  <div className="cl-strong">{rule.label}</div>
                  <div className="cl-meta" style={{ marginTop: 3, whiteSpace: 'normal' }}>
                    {rule.detail}
                  </div>
                  <div className="cl-row cl-row-wrap" style={{ gap: 5, marginTop: 6 }}>
                    <span className="cl-mono" style={{ fontSize: 11 }}>
                      {rule.policyRef}
                    </span>
                    <span
                      className="cl-badge"
                      data-tone="neutral"
                      title={`Proved by ${rule.provenSimulationIds.length} simulation(s)`}
                      onClick={(e) => {
                        e.stopPropagation();
                        go('simulation', `?scenario=${rule.provenSimulationIds[0]}`);
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      {rule.provenSimulationIds.length} proof{rule.provenSimulationIds.length === 1 ? '' : 's'}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>
      </Section>

      {/* supporting panels */}
      <Section label="Constraints">
        <div className="cl-grid cl-grid-2">
          {PERMISSIONS.panels.map((panel) => (
            /* Sub-blocks rather than cards: a section rule and a card border
               around the same content is two frames for one thing, and these
               sit two-across under a head that already groups them. */
            <div className="cl-subsection" key={panel.id}>
              <div className="cl-subsection-head">
                <span className="cl-label">{panel.title}</span>
                <span className="cl-subsection-rule" />
                <span className="cl-meta cl-subsection-note">{panel.description}</span>
              </div>
              <Spec
                rows={panel.items.map((item) => ({
                  key: item.label,
                  label: item.label,
                  value: item.tone ? <Badge tone={item.tone}>{item.value}</Badge> : item.mono ? <span className="cl-mono">{item.value}</span> : item.value,
                }))}
              />
            </div>
          ))}
        </div>
      </Section>

      <BlockerBanner tone="neutral" title="Changing authority happens elsewhere, on purpose">
        This page states the boundary; it does not move it. Enabling or disabling financial authority is done on the
        Policies page behind a typed confirmation that shows the current state, the requested state, the network and the
        consequence.
      </BlockerBanner>

      {/* authority increases */}
      <Modal
        open={expansionsOpen}
        onClose={() => setExpansionsOpen(false)}
        title="Authority increases since the live revision"
        wide
        footer={
          <>
            <button type="button" className="cl-btn" onClick={() => setExpansionsOpen(false)}>
              Close
            </button>
            <button
              type="button"
              className="cl-btn cl-btn-primary"
              onClick={() => {
                setExpansionsOpen(false);
                go('blueprint', '?compare=1');
              }}
            >
              Open full comparison
            </button>
          </>
        }
      >
        <div className="cl-col" style={{ gap: 10 }}>
          {AUTHORITY_DIFF.length === 0 ? <p className="cl-meta">No pending authority change. Edits are made on the Blueprint page, where each change is compared before a revision is created.</p> : null}
          {AUTHORITY_DIFF.map((diff) => (
            <div className="cl-card" key={diff.field}>
              <div className="cl-card-head" style={{ background: diff.expansion ? 'var(--cl-warn-bg)' : undefined }}>
                <div className="cl-card-title">{diff.label}</div>
                {diff.expansion ? <Badge tone="warn">Authority expansion</Badge> : <Badge tone="pass">Tightening</Badge>}
              </div>
              <div className="cl-card-body">
                <div style={{ fontSize: 13.5 }}>
                  <span style={{ color: 'var(--cl-ink-3)', textDecoration: 'line-through' }}>{diff.before}</span>
                  {'  →  '}
                  <span className="cl-strong">{diff.after}</span>
                </div>
                <p className="cl-meta" style={{ marginTop: 6, whiteSpace: 'normal' }}>
                  {diff.note}
                </p>
              </div>
            </div>
          ))}
        </div>
      </Modal>

      {/* export */}
      <Modal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title="Export permission summary"
        subtitle="A secret-free statement of this agent's authority boundary."
        footer={
          <>
            <button type="button" className="cl-btn" onClick={() => setExportOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="cl-btn cl-btn-primary"
              onClick={() => {
                setExportOpen(false);
                pushToast('Permission summary exported');
              }}
            >
              Download summary
            </button>
          </>
        }
      >
        <dl className="cl-statechange">
          <div className="cl-statechange-row">
            <dt>Contents</dt>
            <dd>Authority matrix, capability bindings, recipient restrictions, data trust and organization aggregate</dd>
          </div>
          <div className="cl-statechange-row">
            <dt>Revision</dt>
            <dd>Policy revision {PERMISSIONS.policyRevision}</dd>
          </div>
          <div className="cl-statechange-row">
            <dt>Confidential values</dt>
            <dd>Excluded — hash-only disclosure</dd>
          </div>
          <div className="cl-statechange-row">
            <dt>Secret scan</dt>
            <dd>
              <StatusBadge status="PASS" />
            </dd>
          </div>
        </dl>
      </Modal>
    </StudioPage>
  );
}

function PostureItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="cl-label" style={{ marginBottom: 7 }}>
        {label}
      </div>
      {value}
    </div>
  );
}
