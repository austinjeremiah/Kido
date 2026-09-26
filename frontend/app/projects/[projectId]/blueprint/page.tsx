'use client';

/**
 * Blueprint (spec §12).
 *
 * Human-readable and machine-precise view of the canonical agent Blueprint.
 * Editing never mutates the live revision — it opens a draft. Changed fields
 * carry a change marker, and any change that widens authority is called out as
 * an AUTHORITY EXPANSION with the concrete consequence spelled out.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  FileJson,
  GitCompare,
  Pencil,
  Trash2,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import { StudioPage, useStudioPage } from '@/components/studio/PageScaffold';
import { AgentPatchInbox } from '@/components/studio/AgentPatches';
import {
  Badge,
  BlockerBanner,
  Card,
  CopyButton,
  DraftAheadBanner,
  Section,
  SeverityBadge,
  StatusBadge,
} from '@/components/studio/primitives';
import { Modal, StandardConfirmation } from '@/components/studio/dialogs';
import { useWorkbench } from '@/lib/studio/workbench';
import { STALE_ON_BLUEPRINT_CHANGE, VALIDATION_GROUP_LABEL } from '@/lib/studio/content/blueprint';
import { blueprintPatch, toBlueprint } from '@/lib/studio/api/adapters/design';
import { studio } from '@/lib/studio/api/endpoints';
import { useInvalidateAll } from '@/lib/studio/api/queries';
import { ApiError } from '@/lib/studio/api/client';
import { EmptyState } from '@/components/studio/primitives';
import type { Blueprint, BlueprintField, BlueprintSection, ValidationFinding } from '@/lib/studio/types';

/**
 * The Blueprint arrives as nineteen sections. Rendered one-per-heading that is
 * nineteen numbered heads, nineteen card borders and nineteen summary
 * sentences before any content — a wall you scroll rather than a document you
 * read, however well each piece is styled.
 *
 * They are gathered into five, which is how the document actually reads: who
 * the agent is, what it can touch, what it may do, what stays private, and what
 * the build must prove. The grouping is presentation only — the sections, their
 * fields and their ids are exactly what the backend sent.
 */
const SECTION_GROUPS: Array<{ id: string; label: string; members: string[] }> = [
  { id: 'principal', label: 'Principal', members: ['identity', 'objective', 'ens'] },
  { id: 'surface', label: 'Surface', members: ['protocols', 'assets', 'triggers', 'actions'] },
  {
    id: 'authority',
    label: 'Authority',
    members: ['permissions', 'autonomous-policy', 'escalation-policy', 'capability-policy', 'execution-networks'],
  },
  {
    id: 'confidentiality',
    label: 'Confidentiality & data',
    members: ['confidential-policy', 'data-requirements', 'cre', 'ledger'],
  },
  {
    id: 'contract',
    label: 'Build contract',
    members: ['simulation-requirements', 'generated-modules', 'security-assertions'],
  },
];

/**
 * Groups the sections without dropping any. A section the map has never heard
 * of — a new one from the backend — lands in a trailing group rather than
 * disappearing, which is the failure mode a hard-coded layout usually has.
 */
function groupSections(sections: BlueprintSection[]) {
  const seen = new Set<string>();
  const groups = SECTION_GROUPS.map((g) => {
    const members = g.members.map((id) => sections.find((s) => s.id === id)).filter((s): s is BlueprintSection => !!s);
    members.forEach((m) => seen.add(m.id));
    return { ...g, sections: members };
  }).filter((g) => g.sections.length > 0);

  const rest = sections.filter((s) => !seen.has(s.id));
  return rest.length > 0 ? [...groups, { id: 'other', label: 'Other', members: [], sections: rest }] : groups;
}

export default function BlueprintPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setSelection, openBottom, pushToast } = useWorkbench();

  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(false);
  const [compareOpen, setCompareOpen] = useState(searchParams.get('compare') === '1');
  const [discardOpen, setDiscardOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [validated, setValidated] = useState<null | 'running' | 'done'>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [focusField, setFocusField] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fieldRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const { project, ctx } = useStudioPage('blueprint');
  const invalidate = useInvalidateAll();

  const doc = ctx.buildView?.blueprint ?? null;
  const findings = ctx.buildView?.findings ?? [];

  /* The live revision, from the build; the draft is the same document with this page's edits. */
  const live = useMemo<Blueprint | null>(() => (doc ? toBlueprint(doc, findings) : null), [doc, findings]);
  const patched = useMemo(() => (doc ? blueprintPatch(doc, edits) : { patch: {}, diff: [], problems: [] }), [doc, edits]);
  const AUTHORITY_DIFF = patched.diff;
  const draftRevision = (doc?.revision ?? 0) + 1;
  const blueprint: Blueprint = live
    ? editing
      ? { ...live, revision: draftRevision, isDraft: true, baseRevision: live.revision, status: AUTHORITY_DIFF.length ? 'DRAFT' : live.status }
      : live
    : { revision: 0, status: 'DRAFT', isDraft: false, baseRevision: null, sections: [], findings: [], raw: {} };
  const deployedRevision = project.revisions.deployment ?? 0;
  const liveBlueprintRevision = live?.revision ?? 0;

  /* Draft edits layer over the live revision without touching it; a changed field carries its previous value. */
  const sections = useMemo<BlueprintSection[]>(
    () =>
      blueprint.sections.map((section) => ({
        ...section,
        fields: section.fields.map((field) => {
          if (edits[field.key] === undefined || edits[field.key] === field.value) return field;
          const d = AUTHORITY_DIFF.find((x) => x.field === field.key);
          return { ...field, value: edits[field.key]!, previousValue: field.value, authorityExpansion: d?.expansion ?? false, authorityNote: d?.note };
        }),
      })),
    [blueprint.sections, edits, AUTHORITY_DIFF],
  );

  const createRevision = async () => {
    if (!ctx.buildId || !doc) return;
    setError(null);
    if (patched.problems.length) { setProblems(patched.problems); return; }
    setSaving(true);
    try {
      await studio.editBlueprint(ctx.buildId, patched.patch);
      await invalidate();
      setEdits({});
      setEditing(false);
      setCreateOpen(false);
      pushToast(`Blueprint r${draftRevision} created — simulations and code are now STALE until rebuilt`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const findingsByGroup = useMemo(() => {
    const groups = new Map<string, ValidationFinding[]>();
    for (const finding of blueprint.findings) {
      groups.set(finding.group, [...(groups.get(finding.group) ?? []), finding]);
    }
    return [...groups.entries()];
  }, [blueprint.findings]);

  const changedFields = useMemo(
    () => sections.flatMap((s) => s.fields.filter((f) => f.previousValue || edits[f.key] !== undefined)),
    [sections, edits],
  );
  const expansions = changedFields.filter((f) => f.authorityExpansion);

  const jumpToField = useCallback((fieldKey: string) => {
    setFocusField(fieldKey);
    const node = fieldRefs.current[fieldKey];
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => setFocusField(null), 2200);
  }, []);

  /* Validate: the client checks what it can (shape of the edited fields); the deterministic
     validator runs on the server when the revision is created, and its findings appear below. */
  useEffect(() => {
    if (validated !== 'running') return;
    const handle = window.setTimeout(() => {
      setProblems(patched.problems);
      setValidated('done');
      if (patched.problems.length) openBottom('problems');
    }, 300);
    return () => window.clearTimeout(handle);
  }, [validated, openBottom, patched.problems]);

  /* The canonical document, exactly as the backend holds it — with the draft patch applied while editing. */
  const rawJson = useMemo(() => JSON.stringify(doc ? (editing ? { ...doc, ...patched.patch, revision: draftRevision } : doc) : {}, null, 2), [doc, editing, patched.patch, draftRevision]);

  if (!doc || !live) {
    return (
      <StudioPage segment="blueprint">
        <EmptyState
          title={ctx.loading ? 'Loading the Blueprint…' : 'No Blueprint yet'}
          body={ctx.loading ? '' : 'Describe your agent first. Kido will generate a typed Blueprint that defines identity, data sources, actions and authority boundaries.'}
          action={ctx.loading ? undefined : <button type="button" className="cl-btn cl-btn-primary" onClick={() => router.push(`/projects/${ctx.routeProjectId}/build`)}>Build Agent</button>}
        />
      </StudioPage>
    );
  }

  return (
    <StudioPage
      segment="blueprint"
      stale={editing}
      badges={
        <>
          <Badge tone={editing ? 'warn' : 'neutral'}>
            Blueprint r{blueprint.revision}
            {editing ? ' · draft' : ''}
          </Badge>
          <StatusBadge status={blueprint.status} />
          {editing ? <Badge tone="sim">Based on r{blueprint.baseRevision}</Badge> : null}
          {blueprint.findings.length > 0 ? (
            <button
              type="button"
              className="cl-badge"
              data-tone="warn"
              style={{ cursor: 'pointer' }}
              onClick={() => document.getElementById('cl-validation')?.scrollIntoView({ behavior: 'smooth' })}
            >
              {blueprint.findings.length} finding{blueprint.findings.length === 1 ? '' : 's'}
            </button>
          ) : null}
        </>
      }
      actions={
        <>
          {!editing ? (
            <button type="button" className="cl-btn" onClick={() => setEditing(true)}>
              <Pencil size={13} aria-hidden />
              Edit Blueprint
            </button>
          ) : (
            <>
              <button
                type="button"
                className="cl-btn"
                onClick={() => pushToast(`Draft r${draftRevision} kept on this page — it is not a revision until you create one`)}
              >
                Save Draft
              </button>
              <button type="button" className="cl-btn" onClick={() => setValidated('running')}>
                {validated === 'running' ? 'Validating…' : 'Validate'}
              </button>
              <button type="button" className="cl-btn cl-btn-danger" onClick={() => setDiscardOpen(true)}>
                <Trash2 size={13} aria-hidden />
                Discard Draft
              </button>
            </>
          )}
          <button type="button" className="cl-btn" onClick={() => setCompareOpen(true)}>
            <GitCompare size={13} aria-hidden />
            Compare Revision
          </button>
          <button type="button" className="cl-btn" onClick={() => setRaw((v) => !v)} aria-pressed={raw}>
            <FileJson size={13} aria-hidden />
            Raw JSON
          </button>
          {editing ? (
            /* Publishing an already-built agent creates a revision; it never "saves over" one. */
            <button type="button" className="cl-btn cl-btn-primary" onClick={() => setCreateOpen(true)} disabled={AUTHORITY_DIFF.length === 0}>
              Create Revision
            </button>
          ) : (
            <button
              type="button"
              className="cl-btn cl-btn-primary"
              onClick={() => router.push(`/projects/${ctx.routeProjectId}/architecture`)}
            >
              <Workflow size={13} aria-hidden />
              Generate Architecture
            </button>
          )}
        </>
      }
      banners={
        <>
          {error ? <BlockerBanner tone="deny" title="The Studio API refused the revision">{error}</BlockerBanner> : null}
          {problems.length > 0 ? <BlockerBanner tone="deny" title="The draft has problems">{problems.join(' · ')}</BlockerBanner> : null}
          {ctx.buildView?.codeStale ? (
            <BlockerBanner tone="warn" title="Architecture changed — rebuild required">
              The generated code and its simulations were produced against an earlier Blueprint revision. Regenerate from the Composer to bring them up to r{liveBlueprintRevision}.
            </BlockerBanner>
          ) : null}
          {deployedRevision > 0 && liveBlueprintRevision > deployedRevision ? (
            <DraftAheadBanner
              draftRevision={editing ? draftRevision : liveBlueprintRevision}
              deployedRevision={deployedRevision}
              onCompare={() => setCompareOpen(true)}
              onDeploy={() => router.push(`/projects/${ctx.routeProjectId}/deploy`)}
            />
          ) : null}
          {expansions.length > 0 ? (
            <BlockerBanner
              tone="warn"
              title={`${expansions.length} authority-increasing change${expansions.length === 1 ? '' : 's'} in this draft`}
              actions={
                <button type="button" className="cl-btn cl-btn-sm" onClick={() => setCompareOpen(true)}>
                  Review changes
                </button>
              }
            >
              An authority expansion widens what the agent can do without a human. Simulations proving the previous
              boundary become stale and must be re-run.
            </BlockerBanner>
          ) : null}
        </>
      }
    >
      <AgentPatchInbox pageKind="blueprint" />

      {raw ? (
        <Section
          label="Raw JSON"
          actions={
            <div className="cl-row" style={{ gap: 6 }}>
              <CopyButton value={rawJson} label="Copy JSON" />
              <button
                type="button"
                className="cl-btn cl-btn-sm"
                onClick={() => {
                  const blob = new Blob([rawJson], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `blueprint-r${blueprint.revision}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                  pushToast('Blueprint exported');
                }}
              >
                <Download size={12} aria-hidden />
                Export Blueprint
              </button>
            </div>
          }
        >
          <Card flush>
            <pre
              className="cl-mono"
              style={{ margin: 0, padding: 14, whiteSpace: 'pre-wrap', lineHeight: 1.6, maxHeight: 560, overflow: 'auto' }}
            >
              {rawJson}
            </pre>
          </Card>
        </Section>
      ) : (
        groupSections(sections).map((group) => (
          /* The section head used to read "01  1. Identity" — the CSS counter
             and the backend's own index both printing a number at the same
             heading. The counter keeps it; the title is just the title. */
          <Section key={group.id} label={group.label}>
            {group.sections.map((section) => (
              <div className="cl-subsection" key={section.id}>
                {/* The summary was a paragraph at the top of every card,
                    restating the heading above it. It is the caption on the
                    sub-head now: nothing is lost, and the block opens with
                    data rather than with a sentence about data. */}
                <div className="cl-subsection-head">
                  <span className="cl-label">{section.title}</span>
                  <span className="cl-subsection-rule" />
                  <span className="cl-meta cl-subsection-note">{section.summary}</span>
                </div>
                {/* No Card. A section rule followed immediately by a card
                    border framed the same content twice. */}
                <div className="cl-spec">
                  {section.fields.map((field) => (
                    <FieldRow
                      key={field.key}
                      field={field}
                      editing={editing}
                      focused={focusField === field.key}
                      registerRef={(el) => {
                        fieldRefs.current[field.key] = el;
                      }}
                      onChange={(value) => setEdits((prev) => ({ ...prev, [field.key]: value }))}
                      onSelect={() =>
                        setSelection({ kind: 'blueprint-field', id: field.key, label: `${section.title} · ${field.label}` })
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </Section>
        ))
      )}

      {/* validation panel */}
      <div id="cl-validation">
        <Section
          label="Validation"
          actions={
            <span className="cl-meta">
              {blueprint.findings.length === 0
                ? 'No findings'
                : `${blueprint.findings.length} finding${blueprint.findings.length === 1 ? '' : 's'}`}
            </span>
          }
        >
          {blueprint.findings.length === 0 ? (
            <Card>
              <p className="cl-meta">
                The deterministic validator reports no schema, security-invariant, trust or adapter findings for this
                revision.
              </p>
            </Card>
          ) : (
            <div className="cl-col" style={{ gap: 12 }}>
              {findingsByGroup.map(([group, findings]) => (
                <Card key={group} title={VALIDATION_GROUP_LABEL[group] ?? group} flush>
                  <ul>
                    {findings.map((finding) => (
                      <li key={finding.id}>
                        <button
                          type="button"
                          className="cl-list-row"
                          style={{ width: '100%', textAlign: 'left', alignItems: 'flex-start' }}
                          onClick={() => {
                            if (finding.fieldKey) jumpToField(finding.fieldKey);
                            setSelection({ kind: 'validation-finding', id: finding.id, label: finding.id });
                          }}
                        >
                          <SeverityBadge severity={finding.severity} />
                          <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                            <span className="cl-row" style={{ gap: 8 }}>
                              <span className="cl-mono" style={{ fontSize: 11.5 }}>
                                {finding.id}
                              </span>
                              <span className="cl-strong">{finding.message}</span>
                            </span>
                            <span className="cl-meta" style={{ display: 'block', marginTop: 3, whiteSpace: 'normal' }}>
                              {finding.detail}
                            </span>
                          </span>
                          <ChevronRight size={13} aria-hidden style={{ opacity: 0.5, marginTop: 3 }} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </Card>
              ))}
            </div>
          )}
        </Section>
      </div>

      {/* compare revisions */}
      <Modal
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        title={`Compare r${liveBlueprintRevision} → r${draftRevision}`}
        subtitle="Authority-increasing changes are listed first."
        wide
        footer={
          <button type="button" className="cl-btn cl-btn-primary" onClick={() => setCompareOpen(false)}>
            Close
          </button>
        }
      >
        <div className="cl-col" style={{ gap: 10 }}>
          {AUTHORITY_DIFF.length === 0 ? <p className="cl-meta">No fields differ from r{liveBlueprintRevision}. Edit the Blueprint to see a comparison.</p> : null}
          {[...AUTHORITY_DIFF].sort((a, b) => Number(b.expansion) - Number(a.expansion)).map((diff) => (
            <div
              className="cl-card"
              key={diff.field}
              style={{ borderColor: diff.expansion ? 'var(--cl-warn)' : 'var(--cl-line)' }}
            >
              <div className="cl-card-head" style={{ background: diff.expansion ? 'var(--cl-warn-bg)' : undefined }}>
                <div className="cl-card-title">{diff.label}</div>
                {diff.expansion ? <Badge tone="warn">Authority expansion</Badge> : <Badge tone="pass">Tightening</Badge>}
              </div>
              <div className="cl-card-body">
                <div className="cl-mono" style={{ fontSize: 11.5, marginBottom: 6 }}>
                  {diff.field}
                </div>
                <div style={{ fontSize: 13.5 }}>
                  <span style={{ color: 'var(--cl-deny)', textDecoration: 'line-through' }}>{diff.before}</span>
                  {'  →  '}
                  <span style={{ color: diff.expansion ? 'var(--cl-warn)' : 'var(--cl-pass)' }}>{diff.after}</span>
                </div>
                <p className="cl-meta" style={{ marginTop: 7, whiteSpace: 'normal' }}>
                  {diff.note}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 18 }}>
          <div className="cl-label" style={{ marginBottom: 8 }}>
            What becomes stale if this is applied
          </div>
          <div className="cl-path">
            {STALE_ON_BLUEPRINT_CHANGE.map((row) => (
              <div className="cl-path-step" key={row.surface}>
                <span className="cl-path-step-name">{row.surface}</span>
                <StatusBadge status={row.surface === 'Deployment' ? 'READY' : 'STALE'} />
                <span className="cl-path-step-detail">{row.detail}</span>
              </div>
            ))}
          </div>
        </div>
      </Modal>

      {/* discard draft */}
      <StandardConfirmation
        open={discardOpen}
        onClose={() => setDiscardOpen(false)}
        onConfirm={() => {
          setEdits({});
          setEditing(false);
          setDiscardOpen(false);
          pushToast('Draft discarded');
        }}
        title="Discard draft"
        consequence={`Draft r${draftRevision} and its unsaved edits are removed. The live Blueprint r${liveBlueprintRevision} and the active deployment are unaffected.`}
        resource={`Blueprint draft r${draftRevision}`}
        actionLabel="Discard Draft"
      />

      {/* create revision */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={`Create Blueprint revision r${draftRevision}`}
        subtitle="This publishes a new revision. It does not deploy anything."
        wide
        footer={
          <>
            <button type="button" className="cl-btn" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button type="button" className="cl-btn cl-btn-primary" onClick={() => void createRevision()} disabled={saving}>
              {saving ? 'Creating…' : `Create Revision r${draftRevision}`}
            </button>
          </>
        }
      >
        {expansions.length > 0 ? (
          <BlockerBanner tone="warn" title="This revision increases authority">
            {expansions.map((f) => f.authorityNote).filter(Boolean).join(' ')}
          </BlockerBanner>
        ) : null}
        <dl className="cl-statechange">
          <div className="cl-statechange-row">
            <dt>Current revision</dt>
            <dd>r{liveBlueprintRevision}</dd>
          </div>
          <div className="cl-statechange-row">
            <dt>New revision</dt>
            <dd>r{draftRevision}</dd>
          </div>
          <div className="cl-statechange-row">
            <dt>Changed fields</dt>
            <dd>{AUTHORITY_DIFF.length}</dd>
          </div>
          <div className="cl-statechange-row">
            <dt>Active deployment</dt>
            <dd>
              {deployedRevision > 0 ? `Stays on r${deployedRevision} until you deploy again` : 'None'}
            </dd>
          </div>
          <div className="cl-statechange-row">
            <dt>Becomes stale</dt>
            <dd>Strategy, build, simulations and generated code</dd>
          </div>
        </dl>
      </Modal>
    </StudioPage>
  );
}

/* ------------------------------------------------------------------ field */

function FieldRow({
  field,
  editing,
  focused,
  onChange,
  onSelect,
  registerRef,
}: {
  field: BlueprintField;
  editing: boolean;
  focused: boolean;
  onChange: (value: string) => void;
  onSelect: () => void;
  registerRef: (el: HTMLDivElement | null) => void;
}) {
  const changed = Boolean(field.previousValue);
  const canEdit = editing && field.editable;

  /* Same ruled row as the Composer's requirements and the Organization's
     identity block — one pattern for a named value, instead of a third
     hand-rolled grid with its own paddings. The change marker rides the row's
     left edge, which is the track `open` already uses. */
  return (
    <div
      className="cl-spec-row"
      data-changed={changed ? '' : undefined}
      data-focused={focused ? '' : undefined}
      ref={registerRef}
      onClick={onSelect}
      style={{ scrollMarginTop: 90 }}
    >
      <div className="cl-spec-key">
        <span>{field.label}</span>
      </div>

      <div className="cl-spec-val">
        {canEdit ? (
          <input
            className="cl-input"
            value={field.value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={field.label}
          />
        ) : (
          <span className={field.mono ? 'cl-spec-value cl-mono' : 'cl-spec-value'}>{field.value}</span>
        )}

        {/* The hint used to sit under the label, in the narrow column, where a
            one-line sentence wrapped to three. It says something about the
            value, so it belongs beside it. */}
        {field.hint ? <span className="cl-spec-note">{field.hint}</span> : null}

        {changed ? (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 12.5 }}>
              <span style={{ color: 'var(--cl-ink-3)', textDecoration: 'line-through' }}>{field.previousValue}</span>
              {'  →  '}
              <span className="cl-strong">{field.value}</span>
            </div>
            {field.authorityExpansion ? (
              <div
                style={{
                  marginTop: 6,
                  padding: '7px 10px',
                  border: '1px solid var(--cl-warn)',
                  background: 'var(--cl-warn-bg)',
                }}
              >
                <span className="cl-row" style={{ gap: 7 }}>
                  <TriangleAlert size={13} aria-hidden style={{ color: 'var(--cl-warn)' }} />
                  <span
                    className="cl-strong"
                    style={{ color: 'var(--cl-warn)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase' }}
                  >
                    Authority expansion
                  </span>
                </span>
                {field.authorityNote ? (
                  <div style={{ fontSize: 12.5, marginTop: 4 }}>{field.authorityNote}</div>
                ) : null}
              </div>
            ) : field.authorityNote ? (
              <div className="cl-row" style={{ gap: 7, marginTop: 5 }}>
                <Check size={12} aria-hidden style={{ color: 'var(--cl-pass)' }} />
                <span className="cl-meta">{field.authorityNote}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
