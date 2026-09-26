'use client';

/**
 * Settings: the project's name (PATCH /projects/:id), its identifiers, the Kido backend's
 * configuration as it reports it (GET /health and the deployment status flags), workbench
 * preferences kept in this browser, and the danger zone.
 *
 * Preferences are only the ones the workbench shell actually reads: theme, density, the assistant
 * sidebar and developer mode. They persist through the workbench's own
 * localStorage record (read and written inside try/catch there), so a blocked storage simply
 * resets them next session. The backend has no endpoint to delete or archive a project, and this
 * page says so rather than offering a button that would do nothing.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { RotateCcw, Save } from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, Card, CopyButton, KeyValue, Section, StatusBadge, TabStrip } from '@/components/studio/primitives';
import { WithProject, useKido } from '@/components/studio/kido';
import { useDeployment, useHealth } from '@/lib/kido/hooks';
import { STAGE_LABEL, chainLabel } from '@/lib/kido/format';
import { useWorkbench } from '@/lib/studio/workbench';
import type { ProjectSummary } from '@/lib/kido/types';

type Tab = 'project' | 'backend' | 'preferences' | 'danger';
const NAME_MAX = 120; // the backend's Rename schema: 1–120 characters

function Rename({ s }: { s: ProjectSummary }) {
  const { lifecycle } = useKido();
  const { pushToast } = useWorkbench();
  const [v, setV] = useState(s.name);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setV(s.name), [s.name]);
  const trimmed = v.trim();
  const invalid = !trimmed ? 'A name is required.' : trimmed.length > NAME_MAX ? `At most ${NAME_MAX} characters.` : null;
  const dirty = trimmed !== s.name;
  const save = () => {
    setErr(null);
    lifecycle.rename.mutate([trimmed], {
      onSuccess: (r) => pushToast(`Renamed to "${r.name}"`),
      onError: (e) => setErr((e as Error).message),
    });
  };
  return (
    <Card title="Project name" actions={dirty ? <Badge tone="warn">UNSAVED</Badge> : <Badge tone="pass">SAVED</Badge>}>
      <div className="cl-field">
        <label className="cl-field-label" htmlFor="set-name">Name</label>
        <div className="cl-row" style={{ gap: 8 }}>
          <input
            id="set-name"
            className="cl-input"
            style={{ flex: 1 }}
            value={v}
            maxLength={NAME_MAX + 20}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && dirty && !invalid) save(); }}
          />
          <button type="button" className="cl-btn cl-btn-primary" disabled={!dirty || Boolean(invalid) || lifecycle.rename.isPending} onClick={save}>
            <Save size={13} aria-hidden />{lifecycle.rename.isPending ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="cl-btn" disabled={!dirty} onClick={() => setV(s.name)}>Discard</button>
        </div>
        <span className="cl-field-hint">
          {invalid && dirty ? invalid : `${trimmed.length}/${NAME_MAX} · A label for you. It is not part of the blueprint, its hash or the agent's authority.`}
        </span>
        {err ? <span className="cl-meta" style={{ color: 'var(--cl-deny)' }}>{err}</span> : null}
      </div>
      <KeyValue rows={[{ label: 'Objective', value: s.objective }, ...(s.blueprint?.objective.summary ? [{ label: 'Summary', value: s.blueprint.objective.summary }] : [])]} />
    </Card>
  );
}

function IdRow({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="cl-dim">—</span>;
  return (
    <span className="cl-row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <span className="cl-mono" style={{ wordBreak: 'break-all' }}>{value}</span>
      <CopyButton value={value} />
    </span>
  );
}

function Identifiers({ s }: { s: ProjectSummary }) {
  return (
    <Card title="Identifiers">
      <KeyValue
        rows={[
          { label: 'Project id', value: <IdRow value={s.projectId} /> },
          { label: 'Kido agent id', value: <IdRow value={s.kidoAgentId} /> },
          { label: 'Blueprint hash', value: <IdRow value={s.blueprintHash} /> },
          { label: 'Parent revision hash', value: <IdRow value={s.blueprint?.parentRevisionHash} /> },
          { label: 'Blueprint revision', value: s.revision ?? '—' },
          { label: 'Schema', value: s.blueprint?.schemaVersion ?? '—', mono: true },
          { label: 'Stage', value: <StatusBadge status={s.stage === 'BUILT' ? 'PASS' : 'PENDING'} label={STAGE_LABEL[s.stage]} /> },
          { label: 'Created', value: <span>{new Date(s.createdAt).toLocaleString()} <span className="cl-meta cl-mono">({new Date(s.createdAt).toISOString()})</span></span> },
          { label: 'Chains', value: s.chains.map(chainLabel).join(' · ') || '—' },
          { label: 'Agents', value: s.agents.join(', ') || '—' },
        ]}
      />
    </Card>
  );
}

function Backend({ s }: { s: ProjectSummary }) {
  const health = useHealth();
  const dep = useDeployment(s.projectId);
  const h = health.data;
  const flag = (on: boolean | undefined, yes: string, no: string) =>
    on === undefined ? <span className="cl-dim">…</span> : <StatusBadge status={on ? 'PASS' : 'BLOCKED'} label={on ? yes : no} />;
  return (
    <>
      <Section label="Backend connection" actions={<button type="button" className="cl-btn cl-btn-sm" onClick={() => { void health.refetch(); void dep.refetch(); }}>Check again</button>}>
        {health.isError ? <BlockerBanner tone="deny" title="The Kido API is unreachable">{(health.error as Error).message}</BlockerBanner> : null}
        <div className="cl-stack" style={{ gap: 16 }}>
          <Card title="Kido API">
            <KeyValue
              rows={[
                { label: 'API', value: h?.ok ? <StatusBadge status="PASS" label="reachable" /> : health.isError ? <StatusBadge status="FAIL" label="unreachable" /> : '…' },
                { label: 'Interview model', value: h ? (h.interviewModel === 'openai' ? <Badge tone="pass">live model (OpenAI)</Badge> : <Badge tone="neutral">rule-based</Badge>) : '…' },
                { label: 'Assistant chat model', value: h ? flag(Boolean(h.chatModel), 'configured', 'not configured') : '…' },
                {
                  label: 'Signer addresses',
                  value: h ? (h.simulationSigners ? <Badge tone="sim">throwaway (simulation only)</Badge> : <Badge tone="pass">configured</Badge>) : '…',
                },
              ]}
            />
            {h?.simulationSigners ? (
              <p className="cl-meta" style={{ marginTop: 10, whiteSpace: 'normal' }}>
                The backend is using throwaway signer addresses for simulation. Set KIDO_CONTROLLER_ADDRESSES, KIDO_ISSUER_ADDRESS and KIDO_AGENT_ADDRESS on the backend to use real ones.
              </p>
            ) : null}
            {h && !h.chatModel ? <p className="cl-meta" style={{ marginTop: 6 }}>Without a chat model the assistant answers with a BLOCKED_ENV refusal.</p> : null}
          </Card>
          <Card title="Deployment services">
            <KeyValue
              rows={[
                { label: 'Lease issuer', value: flag(dep.data?.issuerConfigured, 'configured', 'not configured') },
                { label: 'Sui relayer', value: flag(dep.data?.suiRelayer, 'configured', 'not configured') },
                { label: 'EVM RPC', value: flag(dep.data?.evmRpc, 'configured', 'not configured') },
                { label: 'This project', value: dep.data ? (dep.data.deployment ? `deployment ${dep.data.deployment.status.toLowerCase().replace(/_/g, ' ')}` : 'not deployed') : '…' },
              ]}
            />
            {dep.isError ? <p className="cl-meta" style={{ color: 'var(--cl-deny)' }}>{(dep.error as Error).message}</p> : null}
          </Card>
        </div>
        <p className="cl-meta" style={{ marginTop: 10 }}>Configuration lives in the backend's environment; the workbench only reads it. Requests go to /api on this origin and are proxied to the Kido API.</p>
      </Section>
    </>
  );
}

function Preferences() {
  const { appearance, setAppearance, resetAppearance, agentOpen, toggleAgent, developerMode, setDeveloperMode, resetPanelSize, pushToast } = useWorkbench();
  return (
    <Section
      label="Workbench preferences"
      actions={
        <button type="button" className="cl-btn cl-btn-sm" onClick={() => { resetAppearance(); (['explorer', 'agent', 'bottom'] as const).forEach(resetPanelSize); pushToast('Appearance and panel sizes restored to defaults'); }}>
          <RotateCcw size={12} aria-hidden />Reset to defaults
        </button>
      }
    >
      <Card>
        <div className="cl-field">
          <label className="cl-field-label" htmlFor="set-theme">Theme</label>
          <select id="set-theme" className="cl-select" value={appearance.theme === 'auto' ? 'dark' : appearance.theme} onChange={(e) => setAppearance({ theme: e.target.value as 'light' | 'dark' })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
          <span className="cl-field-hint">Applies immediately. Every badge keeps its text label, so colour is never the only signal.</span>
        </div>
        <div className="cl-field">
          <label className="cl-field-label" htmlFor="set-density">Density</label>
          <select id="set-density" className="cl-select" value={appearance.density} onChange={(e) => setAppearance({ density: e.target.value as 'comfortable' | 'compact' })}>
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact: tighter cards, tables and lists</option>
          </select>
        </div>
        <div className="cl-toggle-row">
          <div>
            <div className="cl-strong">Assistant sidebar</div>
            <div className="cl-meta">Show the Kido assistant beside each page (⌘⇧A toggles it anywhere).</div>
          </div>
          <label className="cl-checkbox"><input type="checkbox" checked={agentOpen} onChange={toggleAgent} /> {agentOpen ? 'On' : 'Off'}</label>
        </div>
        <div className="cl-toggle-row">
          <div>
            <div className="cl-strong">Developer mode</div>
            <div className="cl-meta">Adds the terminal tab to the bottom panel.</div>
          </div>
          <label className="cl-checkbox"><input type="checkbox" checked={developerMode} onChange={(e) => setDeveloperMode(e.target.checked)} /> {developerMode ? 'On' : 'Off'}</label>
        </div>
        <p className="cl-meta" style={{ marginTop: 12, whiteSpace: 'normal' }}>
          Kept in this browser only, never sent to the backend. If browser storage is blocked they still apply for this session and reset on the next. Reduced motion follows your operating system setting.
        </p>
      </Card>
    </Section>
  );
}

function Danger({ s }: { s: ProjectSummary }) {
  return (
    <Section label="Danger zone">
      <BlockerBanner tone="warn" title="Projects cannot be deleted or archived from the workbench">
        The Kido API has no delete or archive endpoint, so there is no button for it here. The project record stays on the backend.
      </BlockerBanner>
      <Card>
        <KeyValue
          rows={[
            { label: 'Stop the agent acting', value: <span>Pause it or revoke its lease from the owner wallet. <Link className="cl-link" href={`/projects/${s.projectId}/control-plane`}>Control Plane</Link> · <Link className="cl-link" href={`/projects/${s.projectId}/runtime`}>Runtime</Link></span> },
            { label: 'Change what it may do', value: <span>Edit an answer in the Composer. That makes a new blueprint revision, and review, simulation and build go stale until they run again. <Link className="cl-link" href={`/projects/${s.projectId}/build`}>Composer</Link></span> },
            { label: 'Start over', value: <span>Create a new agent. <Link className="cl-link" href="/new">New agent</Link></span> },
          ]}
        />
      </Card>
    </Section>
  );
}

function Body({ s }: { s: ProjectSummary }) {
  const [tab, setTab] = useState<Tab>('project');
  return (
    <>
      <TabStrip<Tab>
        tabs={[
          { id: 'project', label: 'Project' },
          { id: 'backend', label: 'Backend' },
          { id: 'preferences', label: 'Preferences' },
          { id: 'danger', label: 'Danger zone' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'project' ? (
        <div className="cl-stack" style={{ gap: 16 }}>
          <Rename s={s} />
          <Identifiers s={s} />
        </div>
      ) : null}
      {tab === 'backend' ? <Backend s={s} /> : null}
      {tab === 'preferences' ? <Preferences /> : null}
      {tab === 'danger' ? <Danger s={s} /> : null}
    </>
  );
}

export default function SettingsPage() {
  const { s } = useKido();
  return (
    <StudioPage segment="settings" badges={s ? <><Badge tone="neutral">{s.name}</Badge><Badge tone="neutral">{STAGE_LABEL[s.stage]}</Badge></> : undefined}>
      <WithProject>{(s) => <Body s={s} />}</WithProject>
    </StudioPage>
  );
}
