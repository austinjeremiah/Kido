'use client';

/**
 * Organization / Agents (spec §11).
 *
 * Agents are distinct principals, not one super-agent: separate identity,
 * separate policy hash, separate budget. A shared security primitive between two
 * agents is a blocking CRITICAL issue, and a reporting-only agent always shows
 * EXECUTION: NONE.
 */
import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Copy, Hammer, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { StudioPage, useStudioPage } from '@/components/studio/PageScaffold';
import {
  Badge,
  BlockchainRef,
  BlockerBanner,
  Card,
  NetworkRoleBadge,
  Section,
  Spec,
  StatusBadge,
  formatUsd,
} from '@/components/studio/primitives';
import { SecurityConfirmation, StandardConfirmation } from '@/components/studio/dialogs';
import { useWorkbench } from '@/lib/studio/workbench';
import { useControlRequest } from '@/lib/studio/control-bridge';
import { studio } from '@/lib/studio/api/endpoints';
import { useControlCommand, useInvalidateAll } from '@/lib/studio/api/queries';
import { ApiError } from '@/lib/studio/api/client';
import type { Agent } from '@/lib/studio/types';

export default function OrganizationPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setSelection, pushToast } = useWorkbench();
  const { project, ctx } = useStudioPage('organization');
  const invalidate = useInvalidateAll();

  const agents = project.agents;
  const initial = agents.find((a) => a.slug === searchParams.get('agent')) ?? agents[0] ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(initial?.id ?? null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [building, setBuilding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected: Agent | null = agents.find((a) => a.id === selectedId) ?? initial;
  const isRevoked = ctx.overview?.panels.identity?.value?.revoked === true && selected?.projectId === ctx.dataProjectId;
  const revoke = useControlCommand(ctx.deploymentId, ctx.dataProjectId ?? undefined);

  useControlRequest('REVOKE_AGENT', () => setRevokeOpen(true));

  /* A forbidden shared primitive between principals is a blocking issue — the backend's own check. */
  /* Every issue that stops the organization from being built, not only the CRITICAL ones: a HIGH
     validator finding (an unstated daily cap) disables the Build button just the same, and the
     page has to say so where the button is. */
  const blockingIssues = useMemo(() => {
    const issues = ctx.orgView?.issues ?? [];
    return ctx.orgView?.buildable === false ? issues.filter((i) => i.severity === 'CRITICAL' || i.severity === 'HIGH') : issues.filter((i) => i.severity === 'CRITICAL');
  }, [ctx.orgView]);
  const sharedPolicy = useMemo(() => {
    const issues = ctx.orgView?.issues ?? [];
    return issues.filter((i) => i.severity === 'CRITICAL');
  }, [ctx.orgView]);

  const aggregate = agents.reduce((sum, a) => sum + a.orgBudgetImpact, 0);
  const blast = selected ? ctx.orgView?.blastRadii.find((b) => b.compromisedAgentId === selected.id) ?? null : null;

  const go = (segment: string) => {
    if (!selected) return;
    const base = selected.projectId ?? ctx.routeProjectId;
    router.push(`/projects/${base}/${segment}?agent=${selected.slug}`);
  };

  /** Start a member's build: an ordinary single-agent build whose prompt is derived from its role. */
  const buildMember = async (agent: Agent) => {
    if (!ctx.organization) return;
    setError(null);
    setBuilding(agent.id);
    try {
      const r = await studio.buildMember(ctx.organization.id, agent.id);
      await invalidate();
      router.push(`/projects/${r.build.projectId}/build?start=1`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBuilding(null);
    }
  };

  if (!selected) {
    return (
      <StudioPage segment="organization">
        <Card>
          <p className="cl-meta">{ctx.loading ? 'Loading the organization…' : 'This project has no agents to show yet.'}</p>
        </Card>
      </StudioPage>
    );
  }

  return (
    <StudioPage
      segment="organization"
      actions={
        <button type="button" className="cl-btn cl-btn-primary" disabled title="Members are designed together from the organization's description. To add one, design the organization again with the new member described.">
          <Plus size={13} aria-hidden />
          Add Agent
        </button>
      }
      banners={
        <>
          {error ? <BlockerBanner tone="deny" title="The Studio API refused">{error}</BlockerBanner> : null}
          {blockingIssues.length > 0 ? (
            <BlockerBanner tone="deny" title={sharedPolicy.length > 0 ? 'CRITICAL — the organization is not buildable' : 'The organization is not buildable until its design states every limit'}>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {blockingIssues.map((i) => (
                  <li key={`${i.code}-${i.path}`}><span className="cl-mono">{i.code}</span> · {i.message} <span className="cl-meta">{i.remediation}</span></li>
                ))}
              </ul>
              <p className="cl-meta" style={{ marginTop: 8, whiteSpace: 'normal' }}>Members are designed together from the description, so the fix is to design the organization again with the missing statements in it (for example “at most $10,000 a day” per agent).</p>
            </BlockerBanner>
          ) : null}
          {ctx.orgView?.unknowns?.length ? (
            <BlockerBanner tone="warn" title="Not established">
              {ctx.orgView.unknowns.join(' · ')}
            </BlockerBanner>
          ) : null}
        </>
      }
    >
      {/*
        Was a two-column split: a list of agents on the left, the selected one's
        detail on the right. With one principal that is a list of one beside its
        own card, and with three it halves the width available to nine rows of
        derived values. The page stacks instead — every principal across the
        top, then the selected one in full width below it.
      */}
      <Section label="Agents" actions={<span className="cl-meta">{agents.length} principal{agents.length === 1 ? '' : 's'} · aggregate {formatUsd(aggregate)}</span>}>
        <div className="cl-principals">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="cl-principal"
              data-selected={agent.id === selectedId}
              onClick={() => {
                setSelectedId(agent.id);
                setSelection({ kind: 'agent', id: agent.id, label: agent.name });
              }}
            >
              <span className="cl-principal-head">
                <span className="cl-principal-name">{agent.name}</span>
                <StatusBadge status={agent.unbuilt ? 'DRAFT' : agent.status} />
              </span>
              <span className="cl-principal-role">{agent.role}</span>
              <span className="cl-principal-foot">
                <span className="cl-num">{formatUsd(agent.orgBudgetImpact)}</span>
                <span className="cl-meta">of the aggregate</span>
              </span>
            </button>
          ))}
        </div>

        <p className="cl-aggregate">
          <span className="cl-label">Aggregate authority</span>
          <span className="cl-num cl-aggregate-figure">{formatUsd(aggregate)}</span>
          <span className="cl-meta">
            Worst-case combined daily authority across all principals{ctx.organization ? ` under ${ctx.organization.rootEns}` : ''}.
          </span>
        </p>
      </Section>

      <Section
        label={selected.name}
        actions={
          <div className="cl-row" style={{ gap: 6 }}>
            <StatusBadge status={isRevoked ? 'REVOKED' : selected.status} />
            {selected.executionClass === 'REPORTING_ONLY' ? <NetworkRoleBadge role="NONE" /> : <NetworkRoleBadge role="EXECUTION_TESTNET" />}
            <span style={{ width: 4 }} />
            <button type="button" className="cl-btn cl-btn-sm" onClick={() => go('blueprint')}>Blueprint</button>
            <button type="button" className="cl-btn cl-btn-sm" onClick={() => go('architecture')}>Architecture</button>
            <button type="button" className="cl-btn cl-btn-sm" onClick={() => go('policies')}>Policy</button>
          </div>
        }
      >
        <p className="cl-lead">{selected.objective || selected.role}</p>

        {selected.unbuilt ? (
          <BlockerBanner
            tone="warn"
            title="Not built yet"
            actions={
              <button type="button" className="cl-btn cl-btn-sm cl-btn-primary" disabled={building === selected.id || !ctx.orgView?.buildable} title={!ctx.orgView?.buildable ? `Not buildable: ${blockingIssues.map((i) => i.message).join(' ')}` : undefined} onClick={() => void buildMember(selected)}>
                <Hammer size={12} aria-hidden />
                {building === selected.id ? 'Starting…' : 'Build this member'}
              </button>
            }
          >
            This member is a design. Building it runs the ordinary single-agent pipeline on a prompt derived from its role and limits, and stops for your review before any code is generated.
          </BlockerBanner>
        ) : null}

        {selected.executionClass === 'REPORTING_ONLY' ? (
          <BlockerBanner tone="neutral" title="Reporting-only principal">
            {selected.name} has execution class NONE. There is no capability-issuing path for it, so no policy limit
            needs to exist — the absence of authority is structural, not a setting that could be raised in place.
          </BlockerBanner>
        ) : null}

        {/*
          Nine rows in one undifferentiated list is why this read as clutter —
          an ENS name, a dollar ceiling and a deployment revision have nothing
          to do with each other, and reading them in sequence makes you sort
          them yourself. Split into what the agent *is* and what it may *do*,
          side by side, which also halves the height.
        */}
        <div className="cl-grid cl-grid-2" style={{ alignItems: 'start', gap: 22 }}>
          <div>
            <div className="cl-label cl-spec-group">Identity</div>
            <Spec
              rows={[
                {
                  key: 'ens',
                  label: 'ENS identity',
                  value: selected.ensNode ? <BlockchainRef label={selected.ensName} value={selected.ensNode} kind="node" network={project.environment.executionNetwork} /> : <span className="cl-mono">{selected.ensName}</span>,
                },
                {
                  key: 'address',
                  label: 'Agent address',
                  value: selected.address ? <BlockchainRef value={selected.address} network={project.environment.executionNetwork} /> : <span className="cl-meta">Not established until deployed.</span>,
                },
                {
                  key: 'policy-hash',
                  label: 'Policy hash',
                  value: selected.policyHash ? <BlockchainRef value={selected.policyHash} kind="hash" /> : <span className="cl-meta">Assigned at deployment.</span>,
                },
                { key: 'role', label: 'Role', value: selected.role },
                { key: 'runtime', label: 'Runtime revision', value: selected.runtimeRevision === null ? 'Never deployed' : `r${selected.runtimeRevision}` },
              ]}
            />
          </div>

          <div>
            <div className="cl-label cl-spec-group">Authority</div>
            <Spec
              rows={[
                {
                  key: 'exec-class',
                  label: 'Execution class',
                  value:
                    selected.executionClass === 'REPORTING_ONLY' ? <Badge tone="blocked">EXECUTION: NONE</Badge> : selected.executionClass.replace(/_/g, ' '),
                  note: selected.executionClass === 'REPORTING_ONLY' ? 'This agent can never obtain a capability or submit a transaction.' : undefined,
                },
                {
                  key: 'adapters',
                  label: 'Allowed adapters',
                  value:
                    selected.allowedAdapters.length === 0 ? (
                      <span className="cl-meta">none bound yet</span>
                    ) : (
                      <span className="cl-row cl-row-wrap" style={{ gap: 10 }}>
                        {selected.allowedAdapters.map((a) => (
                          <Badge key={a} tone="neutral">{a.replace('adp_', '')}</Badge>
                        ))}
                      </span>
                    ),
                },
                {
                  key: 'budget',
                  label: 'Individual budget',
                  value:
                    selected.budget.autonomousPerAction === 0 ? (
                      <span className="cl-meta">No budget — this agent holds no spending authority.</span>
                    ) : (
                      <>
                        <span className="cl-num">{formatUsd(selected.budget.autonomousPerAction)}</span> autonomous per action ·{' '}
                        {selected.budget.window === '24h' ? <><span className="cl-num">{formatUsd(selected.budget.windowLimit)}</span> per 24h</> : <>escalate up to <span className="cl-num">{formatUsd(selected.budget.windowLimit)}</span></>}
                      </>
                    ),
                  note: blast ? (
                    <>
                      Blast radius if compromised: {blast.directCapabilities.join(', ') || 'no direct capabilities'};
                      {' '}reaches {blast.authorityReachesAgents.length === 0 ? 'no other agent' : blast.authorityReachesAgents.map((r) => `${r.agentId} via ${r.via}`).join(', ')};
                      {' '}contained by {blast.containedBy.join(', ') || '—'}.
                    </>
                  ) : undefined,
                },
                {
                  key: 'org-impact',
                  label: 'Organization impact',
                  value: <><span className="cl-num">{formatUsd(selected.orgBudgetImpact)}</span> of the <span className="cl-num">{formatUsd(aggregate)}</span> aggregate</>,
                },
              ]}
            />
          </div>
        </div>
      </Section>

      <Section label="Agent controls">
        <div className="cl-btn-group">
          <button type="button" className="cl-btn" onClick={() => setDuplicateOpen(true)} disabled={!selected.projectId}>
            <Copy size={13} aria-hidden />
            Duplicate as New Agent
          </button>
          <button type="button" className="cl-btn" onClick={() => setRemoveOpen(true)} disabled title="Members are part of the organization's design; removing one means designing the organization again without it.">
            <Trash2 size={13} aria-hidden />
            Remove Draft Agent
          </button>
          <span className="cl-spacer" />
          <button
            type="button"
            className="cl-btn cl-btn-danger"
            onClick={() => setRevokeOpen(true)}
            disabled={isRevoked || !ctx.deploymentId || selected.projectId !== ctx.dataProjectId}
            title={!ctx.deploymentId ? 'Identity revocation acts on a live deployment. This agent has none.' : undefined}
          >
            <ShieldAlert size={13} aria-hidden />
            Revoke Agent
          </button>
        </div>
      </Section>

      {/* revoke — security confirmation */}
      <SecurityConfirmation
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        onConfirm={() => {
          setRevokeOpen(false);
          if (!ctx.deployment) return;
          revoke.mutate(
            { operation: 'REVOKE_IDENTITY', expectedRevision: ctx.deployment.revision, reason: 'revoked from the Organization page', target: { identityNode: selected.ensNode || null } },
            {
              onSuccess: (r) => pushToast(r.ok === false ? `Revocation refused: ${r.detail}` : 'Revocation submitted — the identity page shows the fresh read'),
              onError: (e) => setError((e as Error).message),
            },
          );
        }}
        action="Revoke agent identity"
        currentState={<StatusBadge status="ACTIVE" />}
        requestedState={<StatusBadge status="REVOKED" />}
        network={project.environment.executionNetwork}
        resource={<BlockchainRef label={selected.ensName} value={selected.ensNode || selected.ensName} kind="node" />}
        extraRows={[
          {
            label: 'Sibling impact',
            value:
              agents.filter((a) => a.id !== selected.id).map((a) => a.name).join(', ') +
              ' are separate principals and are not affected.',
          },
          {
            label: 'Capability impact',
            value: 'Capabilities already issued to this identity can no longer be honoured by the executor.',
          },
        ]}
        consequence="The agent loses its verifiable identity. This does not by itself change the policy's enabled state — financial authority is a separate control."
        actionLabel="Revoke Agent Identity"
      />

      {/* duplicate */}
      <StandardConfirmation
        open={duplicateOpen}
        onClose={() => setDuplicateOpen(false)}
        onConfirm={() => {
          setDuplicateOpen(false);
          const row = ctx.row;
          if (!row) return;
          void studio
            .createBuild({ prompt: row.prompt, name: `${selected.name} (copy)`, idempotencyKey: `dup-${row.id}-${Date.now()}` })
            .then(async (b) => { await invalidate(); router.push(`/projects/${b.projectId}/build?start=1`); })
            .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
        }}
        title="Duplicate as new agent"
        consequence="Configuration is copied. A new ENS identity, a new namespace entry and a new policy are required — identity, policy hash and any active authority are never copied, so the duplicate starts with no authority."
        resource={selected.name}
        actionLabel="Duplicate as New Agent"
      />

      {/* remove draft */}
      <StandardConfirmation
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        onConfirm={() => setRemoveOpen(false)}
        title="Remove draft agent"
        consequence="The draft principal and its unsaved configuration are removed. This is only possible because the agent has never been deployed."
        resource={selected.name}
        actionLabel="Remove Draft Agent"
      />
    </StudioPage>
  );
}
