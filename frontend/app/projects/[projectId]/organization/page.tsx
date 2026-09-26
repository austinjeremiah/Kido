'use client';

/**
 * Organization / Agents: the blueprint's specialist roles as distinct principals. Each role owns a
 * set of actions and may request other roles; nothing else lets it act. The page shows every role
 * as a card, the delegation graph (who may request whom), the selected role in full — its build
 * (knowledge packs, exact context size, missing packs) and the authority its actions carry on each
 * chain (allowed / forbidden / excluded, the Amane limits, the pinned adapter) — and a table of
 * every action cross-referenced to the role that owns it. The exact context each role receives is
 * on the Code page.
 */
import '@xyflow/react/dist/style.css';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Background, BackgroundVariant, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { Code2, Network } from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { ArchFlowNode, type ArchFlowNodeData } from '@/components/studio/architecture/ArchNode';
import { Badge, BlockerBanner, Card, Section, Spec, StatusBadge } from '@/components/studio/primitives';
import { NotYet, WithProject } from '@/components/studio/kido';
import { useSelfModel } from '@/lib/kido/hooks';
import { amount, chainLabel, windowLabel } from '@/lib/kido/format';
import type { Blueprint, ProjectSummary, SelfModel } from '@/lib/kido/types';
import type { Status } from '@/lib/studio/types';

type Role = Blueprint['agents'][number];
const nodeTypes = { arch: ArchFlowNode };

export default function OrganizationPage() {
  return (
    <StudioPage segment="organization">
      <WithProject>{(s) => (s.blueprint ? <Organization s={s} /> : <NotYet what="blueprint" where="composer" id={s.projectId} />)}</WithProject>
    </StudioPage>
  );
}

/** A role's build state: missing packs are a warning, no build (or a stale one) is a draft. */
function roleStatus(s: ProjectSummary, role: string): Status {
  const b = s.build?.agents.find((a) => a.role === role);
  if (!b || s.build?.freshness !== 'CURRENT') return 'DRAFT';
  return b.missingPacks.length ? 'WARN' : 'READY';
}

/**
 * What a role may request, resolved to roles: an entry is either a role name or an action, and an
 * action resolves to the roles that own it. Entries neither a role nor owned by one are dangling.
 */
function requestTargets(roles: Role[], r: Role): { targets: string[]; dangling: string[] } {
  const targets = new Set<string>();
  const dangling: string[] = [];
  for (const q of r.mayRequest) {
    if (roles.some((x) => x.role === q)) targets.add(q);
    else {
      const owners = roles.filter((x) => x.role !== r.role && x.owns.includes(q as never)).map((x) => x.role);
      if (owners.length) owners.forEach((o) => targets.add(o));
      else if (!r.owns.includes(q as never)) dangling.push(q);
    }
  }
  return { targets: [...targets], dangling };
}

/** The role's own ENS / SuiNS names (planned by the identity compiler), or the agent's names for `null`. */
function namesOf(s: ProjectSummary, role: string | null) {
  const plan = s.build?.freshness === 'CURRENT' && s.build.identity.length ? s.build.identity : s.identityPlan;
  return plan.filter((b) => (role ? b.role === role : !b.role));
}

function NameLine({ b, compact }: { b: ReturnType<typeof namesOf>[number]; compact?: boolean }) {
  const live = b.liveCapable !== false;
  return (
    <span className="cl-row" style={{ gap: 6, minWidth: 0 }} title={b.blockers?.length ? b.blockers.join('\n') : 'Planned; published when the agent is deployed. A name is discovery only, never authority.'}>
      <Badge tone={b.providerId === 'ens' ? 'data' : 'sim'}>{b.providerId === 'ens' ? 'ENS' : 'SuiNS'}</Badge>
      <span className="cl-mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: compact ? 11.5 : undefined }}>{b.name}</span>
      {compact ? null : <Badge tone={live ? 'pass' : 'warn'}>{live ? 'ready to publish' : 'blocked'}</Badge>}
    </span>
  );
}

function Chips({ items, tone = 'neutral' }: { items: string[]; tone?: 'neutral' | 'pass' | 'warn' | 'deny' | 'data' }) {
  if (!items.length) return <span className="cl-meta">none</span>;
  return (
    <span className="cl-row cl-row-wrap" style={{ gap: 6 }}>
      {items.map((i) => <Badge key={i} tone={tone}>{i}</Badge>)}
    </span>
  );
}

function Organization({ s }: { s: ProjectSummary }) {
  const bp = s.blueprint!;
  const sm = useSelfModel(s.projectId);
  const params = useSearchParams();
  const roles = bp.agents;
  const [selected, setSelected] = useState<string | null>(roles.find((r) => r.role === params.get('role'))?.role ?? roles[0]?.role ?? null);
  const role = roles.find((r) => r.role === selected) ?? null;

  const owned = new Set(roles.flatMap((r) => r.owns));
  const unowned = bp.authority.allowedActions.filter((a) => !owned.has(a));
  const missingTargets = roles.flatMap((r) => requestTargets(roles, r).dangling.map((q) => `${r.role} → ${q}`));
  const agentNames = namesOf(s, null);
  const totalContext = s.build?.agents.reduce((n, a) => n + a.contextChars, 0) ?? 0;

  if (!roles.length) {
    return (
      <div className="cl-stack" style={{ gap: 16 }}>
        <BlockerBanner tone="neutral" title="No agent roles">
          This blueprint defines no specialist roles — its authority mode is {bp.authority.mode ?? 'unset'}, so nothing is allowed to act.
          {bp.monitors.length ? ` Its ${bp.monitors.length} monitor${bp.monitors.length === 1 ? '' : 's'} (${bp.monitors.map((m) => m.id).join(', ')}) respond by ${[...new Set(bp.monitors.map((m) => m.action ?? m.response))].join(', ')}.` : ''}
        </BlockerBanner>
        <AuthoritySummary s={s} sm={sm.data} />
      </div>
    );
  }

  return (
    <div className="cl-stack" style={{ gap: 4 }}>
      {unowned.length ? (
        <BlockerBanner tone="warn" title="Allowed actions no role owns">
          {unowned.join(', ')} {unowned.length === 1 ? 'is' : 'are'} allowed by the policy but owned by no role, so no specialist will ever request {unowned.length === 1 ? 'it' : 'them'}.
        </BlockerBanner>
      ) : null}
      {missingTargets.length ? (
        <BlockerBanner tone="deny" title="Delegation to a role that does not exist">{missingTargets.join(' · ')}</BlockerBanner>
      ) : null}

      {bp.identity.public ? (
        <Section label="Public identity" actions={<Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/identity`}>Identity</Link>}>
          <div className="cl-card">
            <div className="cl-card-body cl-stack" style={{ gap: 8 }}>
              {agentNames.length ? agentNames.map((b) => <NameLine key={`${b.providerId}:${b.name}`} b={b} />) : <span className="cl-meta">Compile the blueprint to plan the agent&apos;s names.</span>}
              <p className="cl-meta" style={{ margin: 0, whiteSpace: 'normal' }}>
                Each specialist below gets its own subname under the agent&apos;s name, carrying its KidoAgentId and role as text records, so anyone can look up who does what. Names are discovery only: authority comes from the Amane policy, never from a name.
              </p>
            </div>
          </div>
        </Section>
      ) : null}

      <Section
        label="Agents"
        actions={
          <span className="cl-meta">
            {roles.length} role{roles.length === 1 ? '' : 's'} · {owned.size} owned action{owned.size === 1 ? '' : 's'}
            {s.build ? ` · build r${s.build.buildRevision} · ${totalContext.toLocaleString()} context chars` : ' · not built'}
          </span>
        }
      >
        <div className="cl-principals">
          {roles.map((r) => {
            const b = s.build?.agents.find((a) => a.role === r.role);
            return (
              <button key={r.role} type="button" className="cl-principal" data-selected={r.role === selected} onClick={() => setSelected(r.role)}>
                <span className="cl-principal-head">
                  <span className="cl-principal-name">{r.role}</span>
                  <StatusBadge status={roleStatus(s, r.role)} />
                </span>
                <span className="cl-principal-role">{r.owns.length ? `Owns ${r.owns.join(', ')}` : 'Owns no actions — observes and reports'}</span>
                {namesOf(s, r.role).length ? (
                  <span className="cl-stack" style={{ gap: 4, margin: '6px 0 2px', minWidth: 0 }}>
                    {namesOf(s, r.role).map((b) => <NameLine key={b.name} b={b} compact />)}
                  </span>
                ) : null}
                <span className="cl-principal-foot">
                  <span className="cl-num">{b ? b.contextChars.toLocaleString() : '—'}</span>
                  <span className="cl-meta">context chars · {r.knowledgePacks.length} pack{r.knowledgePacks.length === 1 ? '' : 's'}{b?.missingPacks.length ? ` · ${b.missingPacks.length} missing` : ''}</span>
                </span>
              </button>
            );
          })}
        </div>
        {s.build ? (
          <p className="cl-aggregate">
            <span className="cl-label">Cross-chain total</span>
            <span className="cl-num cl-aggregate-figure">
              {Object.entries(s.build.authority.crossChainTotal).map(([a, v]) => amount(v, a, bp.chains[0] ?? '', bp.assets)).join(' · ') || '—'}
            </span>
            <span className="cl-meta">Worst-case combined authority across every chain&apos;s Amane policy, shared by all roles through one lease per chain.</span>
          </p>
        ) : null}
      </Section>

      {role ? <RoleDetail s={s} sm={sm.data} role={role} /> : null}

      <Section label="Delegation" actions={<span className="cl-meta"><Network size={12} aria-hidden /> who may request whom</span>}>
        <DelegationGraph s={s} selected={selected} onSelect={setSelected} />
      </Section>

      <Section label="Roles">
        <div className="cl-card" style={{ overflowX: 'auto' }}>
          <table className="cl-table">
            <thead>
              <tr><th>Role</th><th>Names</th><th>Owns</th><th>May request</th><th>Requested by</th><th>Knowledge packs</th><th>Context</th><th>Missing packs</th><th /></tr>
            </thead>
            <tbody>
              {roles.map((r) => {
                const b = s.build?.agents.find((a) => a.role === r.role);
                return (
                  <tr key={r.role} data-selected={r.role === selected ? '' : undefined} onClick={() => setSelected(r.role)} style={{ cursor: 'pointer' }}>
                    <td><strong>{r.role}</strong></td>
                    <td><span className="cl-stack" style={{ gap: 4 }}>{namesOf(s, r.role).map((b) => <NameLine key={b.name} b={b} compact />)}{namesOf(s, r.role).length ? null : <span className="cl-meta">none</span>}</span></td>
                    <td><Chips items={r.owns} tone="pass" /></td>
                    <td><Chips items={requestTargets(roles, r).targets} tone="warn" /></td>
                    <td><Chips items={roles.filter((x) => requestTargets(roles, x).targets.includes(r.role)).map((x) => x.role)} /></td>
                    <td><Chips items={r.knowledgePacks} tone="data" /></td>
                    <td className="cl-num">{b ? b.contextChars.toLocaleString() : '—'}</td>
                    <td>{b ? <Chips items={b.missingPacks} tone="deny" /> : <span className="cl-meta">not built</span>}</td>
                    <td><Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/code?role=${encodeURIComponent(r.role)}`} onClick={(e) => e.stopPropagation()}><Code2 size={12} aria-hidden />Context</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <AuthoritySummary s={s} sm={sm.data} />
    </div>
  );
}

function RoleDetail({ s, sm, role }: { s: ProjectSummary; sm: SelfModel | undefined; role: Role }) {
  const bp = s.blueprint!;
  const b = s.build?.agents.find((a) => a.role === role.role);
  const excluded = s.build?.authority.excludedActions ?? [];
  const actionRows = role.owns.flatMap((action) => {
    const entries = bp.actions.filter((x) => x.action === action);
    const state = bp.authority.forbiddenActions.includes(action) ? 'FORBIDDEN' : excluded.includes(action) ? 'EXCLUDED' : bp.authority.allowedActions.includes(action) ? 'ALLOWED' : 'NOT_ALLOWED';
    if (!entries.length) return [{ key: action, label: action, value: <StatusBadge status={state === 'ALLOWED' ? 'PASS' : 'BLOCKED'} label={state.replace('_', ' ')} />, note: 'No chain in the blueprint carries this action.' }];
    return entries.map((x) => {
      const ex = sm?.execution.find((e) => e.action === action && e.chain === x.chain);
      const limits = bp.authority.limits.filter((l) => l.chain === x.chain).map((l) => sm?.authority.limits.find((y) => y.chain === l.chain && y.asset === l.asset)?.readable ?? `${amount(l.perAction, l.asset, l.chain, bp.assets)} per action, ${amount(l.perWindow, l.asset, l.chain, bp.assets)} per ${windowLabel(l.windowSeconds)}, ${amount(l.total, l.asset, l.chain, bp.assets)} total`);
      return {
        key: `${action}:${x.chain}`,
        label: `${action} · ${chainLabel(x.chain)}`,
        value: (
          <span className="cl-row cl-row-wrap" style={{ gap: 6 }}>
            <StatusBadge status={state === 'ALLOWED' ? 'PASS' : 'BLOCKED'} label={state.replace('_', ' ')} />
            <span>{ex?.adapter ? `${ex.adapter.name} v${ex.adapter.version}` : `via ${x.providerId}`}</span>
          </span>
        ),
        note: limits.length ? limits.join(' · ') : 'No limit stated for this chain.',
      };
    });
  });

  return (
    <Section
      label={role.role}
      actions={
        <div className="cl-row" style={{ gap: 6 }}>
          <StatusBadge status={roleStatus(s, role.role)} />
          {s.build ? <Badge tone={s.build.freshness === 'CURRENT' ? 'pass' : 'warn'}>build {s.build.freshness.toLowerCase()}</Badge> : null}
          <Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/code?role=${encodeURIComponent(role.role)}`}><Code2 size={12} aria-hidden />Exact context</Link>
          <Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/architecture`}>Architecture</Link>
          <Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/policies`}>Policy</Link>
        </div>
      }
    >
      <p className="cl-lead">{bp.objective.statement}</p>
      {b?.missingPacks.length ? (
        <BlockerBanner tone="warn" title="Knowledge packs missing from this role's context">{b.missingPacks.join(', ')} — the role was built without them.</BlockerBanner>
      ) : null}
      <div className="cl-grid cl-grid-2" style={{ alignItems: 'start', gap: 22 }}>
        <div>
          <div className="cl-label cl-spec-group">Context</div>
          <Spec
            rows={[
              { key: 'packs', label: 'Knowledge packs', value: <Chips items={role.knowledgePacks} tone="data" /> },
              { key: 'ctx', label: 'Context size', value: b ? `${b.contextChars.toLocaleString()} chars` : <span className="cl-meta">Not built yet.</span>, note: b ? 'The exact text is on the Code page.' : undefined },
              { key: 'missing', label: 'Missing packs', value: b ? <Chips items={b.missingPacks} tone="deny" /> : <span className="cl-meta">—</span> },
              { key: 'build', label: 'Build', value: s.build ? `r${s.build.buildRevision} of blueprint r${s.build.blueprintRevision}` : <span className="cl-meta">Not built.</span> },
              { key: 'may', label: 'May request', value: <Chips items={requestTargets(bp.agents, role).targets} tone="warn" />, note: role.mayRequest.length ? `asks for ${role.mayRequest.join(', ')}` : undefined },
              { key: 'by', label: 'Requested by', value: <Chips items={bp.agents.filter((x) => requestTargets(bp.agents, x).targets.includes(role.role)).map((x) => x.role)} /> },
            ]}
          />
        </div>
        <div>
          {namesOf(s, role.role).length ? (
            <>
              <div className="cl-label cl-spec-group">Identity</div>
              <Spec
                rows={namesOf(s, role.role).map((b) => ({
                  key: b.name,
                  label: b.providerId === 'ens' ? `ENS · ${chainLabel(b.chain)}` : `SuiNS · ${chainLabel(b.chain)}`,
                  value: (
                    <span className="cl-stack" style={{ gap: 4, minWidth: 0 }}>
                      <span className="cl-mono" style={{ wordBreak: 'break-all' }}>{b.name}</span>
                      <Badge tone={b.liveCapable !== false ? 'pass' : 'warn'}>{b.liveCapable !== false ? 'ready to publish' : 'blocked'}</Badge>
                    </span>
                  ),
                  note: b.blockers?.length ? b.blockers.join('; ') : b.records && Object.keys(b.records).length ? `records: ${Object.entries(b.records).map(([k, v]) => `${k}=${v}`).join(', ')}` : 'discovery only',
                }))}
              />
            </>
          ) : null}
          <div className="cl-label cl-spec-group">Authority</div>
          <Spec
            rows={[
              { key: 'mode', label: 'Authority', value: `${(bp.authority.mode ?? 'unset').replace(/_/g, ' ')}${bp.authority.provider ? ` · ${bp.authority.provider}` : ''}`, note: bp.authority.autonomy ? `autonomy ${bp.authority.autonomy}` : undefined },
              { key: 'lease', label: 'Lease lifetime', value: windowLabel(bp.authority.leaseLifetimeSeconds), note: 'The role acts only through the agent key’s lease, never the owner key.' },
              ...(actionRows.length ? actionRows : [{ key: 'none', label: 'Owned actions', value: <span className="cl-meta">None — this role cannot move value.</span> }]),
            ]}
          />
        </div>
      </div>
    </Section>
  );
}

/** Roles laid out by depth: a role nobody requests sits in the first column, each request one column right. */
function DelegationGraph({ s, selected, onSelect }: { s: ProjectSummary; selected: string | null; onSelect: (r: string) => void }) {
  const roles = s.blueprint!.agents;
  const { nodes, edges } = useMemo(() => {
    const depth = new Map<string, number>();
    const roots = roles.filter((r) => !roles.some((x) => requestTargets(roles, x).targets.includes(r.role)));
    const queue = (roots.length ? roots : roles.slice(0, 1)).map((r) => ({ role: r.role, d: 0 }));
    while (queue.length) {
      const { role, d } = queue.shift()!;
      if (depth.has(role)) continue;
      depth.set(role, d);
      const rr = roles.find((r) => r.role === role);
      if (rr) requestTargets(roles, rr).targets.forEach((q) => queue.push({ role: q, d: d + 1 }));
    }
    roles.forEach((r) => depth.has(r.role) || depth.set(r.role, 0));
    const perCol = new Map<number, number>();
    const nodes: Node[] = roles.map((r) => {
      const d = depth.get(r.role)!;
      const row = perCol.get(d) ?? 0;
      perCol.set(d, row + 1);
      const data: ArchFlowNodeData = {
        kind: 'agent-runtime', label: r.role, purpose: '', networkRole: 'NONE', status: roleStatus(s, r.role), layers: ['runtime'],
        subtitle: r.owns.length ? `owns ${r.owns.join(', ')}` : 'observes only', liveOverlay: false, dimmed: false,
      };
      return { id: r.role, type: 'arch', position: { x: d * 300, y: row * 130 }, selected: r.role === selected, data };
    });
    const edges: Edge[] = roles.flatMap((r) => requestTargets(roles, r).targets.map((q) => ({
      id: `${r.role}->${q}`, source: r.role, target: q, label: 'may request', animated: false,
      style: { stroke: 'var(--cl-warn)', strokeWidth: 1.4, strokeDasharray: '5 4' },
      labelStyle: { fill: 'var(--cl-warn)', fontSize: 9.5 }, labelBgStyle: { fill: 'var(--cl-panel)' },
    })));
    return { nodes, edges };
  }, [roles, s, selected]);
  const pairs = roles.flatMap((r) => requestTargets(roles, r).targets.map((q) => `${r.role} → ${q} (${r.mayRequest.join(', ')})`));

  return (
    <div className="cl-grid cl-grid-2" style={{ alignItems: 'start', gap: 16, gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
      <div className="cl-graph" data-lenis-prevent style={{ height: Math.max(220, Math.min(460, 130 * Math.max(...[...new Set(nodes.map((n) => n.position.x))].map((x) => nodes.filter((n) => n.position.x === x).length)) + 90)), position: 'relative', border: '1px solid var(--cl-line)' }}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.3, maxZoom: 1.1 }} nodesDraggable={false} nodesConnectable={false} proOptions={{ hideAttribution: true }} onNodeClick={(_, n) => onSelect(n.id)} style={{ background: 'var(--cl-canvas)' }}>
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} color="var(--cl-canvas-dot)" />
        </ReactFlow>
      </div>
      <Card title="Requests">
        {pairs.length ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {pairs.map((p) => <li key={p} className="cl-mono" style={{ marginBottom: 4 }}>{p}</li>)}
          </ul>
        ) : (
          <p className="cl-meta" style={{ margin: 0, whiteSpace: 'normal' }}>No role may request another: each acts alone on the actions it owns.</p>
        )}
        <p className="cl-meta" style={{ whiteSpace: 'normal' }}>A request never transfers authority. The requested role still acts only on its own actions, under the same lease and on-chain policy.</p>
      </Card>
    </div>
  );
}

/** Every allowed and forbidden action, per chain, with its owner, adapter and limits. */
function AuthoritySummary({ s, sm }: { s: ProjectSummary; sm: SelfModel | undefined }) {
  const bp = s.blueprint!;
  const excluded = s.build?.authority.excludedActions ?? [];
  const actions = [...new Set([...bp.authority.allowedActions, ...bp.actions.map((a) => a.action)])];
  const rows = actions.flatMap((action) => {
    const entries = bp.actions.filter((x) => x.action === action);
    return (entries.length ? entries : [{ action, chain: '', providerId: '—', deterministic: false }]).map((x) => ({ ...x, action }));
  });
  return (
    <Section label="Actions and limits" actions={<span className="cl-meta">{bp.authority.mode ?? 'no authority mode'}{bp.authority.provider ? ` · ${bp.authority.provider}` : ''}</span>}>
      <div className="cl-card" style={{ overflowX: 'auto' }}>
        <table className="cl-table">
          <thead>
            <tr><th>Action</th><th>Chain</th><th>State</th><th>Owned by</th><th>Adapter</th><th>Limits on this chain</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="cl-meta">No action is allowed. The agent can observe but never move value.</td></tr>
            ) : rows.map((r) => {
              const owners = bp.agents.filter((a) => a.owns.includes(r.action)).map((a) => a.role);
              const ex = sm?.execution.find((e) => e.action === r.action && e.chain === r.chain);
              const state = excluded.includes(r.action) ? 'EXCLUDED' : bp.authority.allowedActions.includes(r.action) ? 'ALLOWED' : 'NOT ALLOWED';
              const limits = bp.authority.limits.filter((l) => l.chain === r.chain);
              return (
                <tr key={`${r.action}:${r.chain}`}>
                  <td><strong>{r.action}</strong></td>
                  <td>{r.chain ? chainLabel(r.chain) : <span className="cl-meta">no chain</span>}</td>
                  <td><StatusBadge status={state === 'ALLOWED' ? 'PASS' : 'BLOCKED'} label={state} /></td>
                  <td>{owners.length ? <Chips items={owners} /> : <Badge tone="warn">no owner</Badge>}</td>
                  <td>{ex?.adapter ? <span>{ex.adapter.name} v{ex.adapter.version}<span className="cl-meta"> · {r.providerId}</span></span> : <span className="cl-meta">{r.providerId}</span>}</td>
                  <td>
                    {limits.length ? (
                      <span className="cl-stack" style={{ gap: 2 }}>
                        {limits.map((l) => (
                          <span key={l.asset}>{sm?.authority.limits.find((y) => y.chain === l.chain && y.asset === l.asset)?.readable ?? `${amount(l.perAction, l.asset, l.chain, bp.assets)} / action · ${amount(l.perWindow, l.asset, l.chain, bp.assets)} / ${windowLabel(l.windowSeconds)} · ${amount(l.total, l.asset, l.chain, bp.assets)} total`}</span>
                        ))}
                      </span>
                    ) : <span className="cl-meta">none stated</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="cl-grid cl-grid-2" style={{ marginTop: 14, gap: 16, alignItems: 'start' }}>
        <Card title="Forbidden actions">
          <Chips items={bp.authority.forbiddenActions} tone="deny" />
          {sm?.capabilitiesNotAvailable.length ? (
            <p className="cl-meta" style={{ whiteSpace: 'normal' }}>Not available to this agent at all: {sm.capabilitiesNotAvailable.join(', ')}.</p>
          ) : null}
        </Card>
        <Card title="Payees and beneficiaries">
          {bp.authority.payees.length + bp.authority.beneficiaries.length === 0 ? (
            <span className="cl-meta">None pinned.</span>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {[...bp.authority.payees.map((p) => ({ ...p, kind: 'payee' })), ...bp.authority.beneficiaries.map((p) => ({ ...p, kind: 'beneficiary' }))].map((p) => (
                <li key={`${p.kind}:${p.chain}:${p.address}`} style={{ marginBottom: 4 }}>
                  {p.label} <span className="cl-meta">({p.kind}, {chainLabel(p.chain)})</span> <span className="cl-mono cl-meta">{p.address}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Section>
  );
}
