/**
 * The architecture graph, derived from a compiled blueprint and the provider registry. Authority
 * runs owner → Amane policy → lease → agent role → account → adapter → protocol / payee; data runs
 * source → monitor → role; identity, privacy and cross-chain transports hang off the nodes they
 * serve. Layout is deterministic (a column per role in the flow, each column centred), so the same
 * blueprint always draws the same picture. Nothing is drawn that the blueprint does not define.
 */
import type { ArchEdgeKind, ArchLayer, ArchNodeData, ArchNodeKind, Status } from '@/lib/studio/types';
import type { Blueprint, BuildArtifact, ChainId, ProviderRow } from '@/lib/kido/types';
import { chainLabel, windowLabel } from '@/lib/kido/format';
import type { ArchExtraIcon, ArchFlowNodeData } from './ArchNode';

export type NodeRef =
  | { type: 'owner' }
  | { type: 'policy'; chain: ChainId }
  | { type: 'lease'; chain: ChainId }
  | { type: 'agent'; role: string }
  | { type: 'account'; chain: ChainId }
  | { type: 'action'; action: string; chain: ChainId; providerId: string; deterministic: boolean }
  | { type: 'protocol'; providerId: string; chain: ChainId }
  | { type: 'payee'; label: string; chain: ChainId; address: string; beneficiary: boolean }
  | { type: 'data'; id: string }
  | { type: 'monitor'; id: string }
  | { type: 'identity'; provider: string; chain: ChainId; name: string | null }
  | { type: 'privacy'; providerId: string; chain: ChainId }
  | { type: 'transport'; providerId: string };

/** Node data before the page adds overlay/dimming (Omit would collapse ArchNodeData's index signature). */
export type BaseNodeData = ArchNodeData & Pick<ArchFlowNodeData, 'chainTag' | 'subtitle' | 'iconKey'>;
export interface GNode { id: string; position: { x: number; y: number }; data: BaseNodeData; ref: NodeRef }
export interface GEdge { id: string; source: string; target: string; kind: ArchEdgeKind; label: string; layers: ArchLayer[] }
export interface Graph { nodes: GNode[]; edges: GEdge[]; hasAuthority: boolean }

export const LAYERS: Array<{ id: ArchLayer; label: string; description: string }> = [
  { id: 'identity', label: 'Identity', description: 'The owner and the public names that point at the agent.' },
  { id: 'policy', label: 'Policy', description: 'Owner-signed Amane policies and the leases issued within them.' },
  { id: 'runtime', label: 'Agent runtime', description: 'The specialist roles and the lease each acts under.' },
  { id: 'execution', label: 'Execution', description: 'Accounts, pinned adapters, protocols, payees and transports.' },
  { id: 'data', label: 'Data', description: 'Data sources the agent reads and the monitors built on them.' },
  { id: 'live-health', label: 'Monitoring', description: 'Monitors and the conditions that wake the agent.' },
  { id: 'security-boundaries', label: 'Security boundaries', description: 'Policy bounds, privacy providers and cross-chain transports.' },
];

export const EDGE_KIND: Record<ArchEdgeKind, { label: string; tone: string }> = {
  POLICY: { label: 'Signs / bounds', tone: 'var(--cl-brand)' },
  AUTHORIZATION: { label: 'Authorizes', tone: 'var(--cl-deny)' },
  EXECUTE: { label: 'Executes', tone: 'var(--cl-deny)' },
  ESCALATE: { label: 'May request', tone: 'var(--cl-warn)' },
  READ: { label: 'Reads', tone: 'var(--cl-data)' },
  CONTEXT: { label: 'Context', tone: 'var(--cl-data)' },
  TRIGGER: { label: 'Triggers', tone: 'var(--cl-ink-2)' },
};

const COL = 260;
const ROW = 130;

/** Registry lifecycle status → a node status. Unknown strings stay neutral rather than green. */
export function providerStatus(raw: string | undefined): Status {
  if (!raw) return 'UNKNOWN';
  if (raw.includes('LIVE')) return 'HEALTHY';
  if (raw.startsWith('BLOCKED')) return 'BLOCKED';
  if (raw.includes('MOCK') || raw.includes('SIM')) return 'SIMULATED';
  return 'UNKNOWN';
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export function buildGraph(bp: Blueprint, build: BuildArtifact | null, registry: ProviderRow[]): Graph {
  const reg = new Map(registry.map((r) => [r.providerId, r]));
  const built = build?.freshness === 'CURRENT';
  const configured: Status = built ? 'READY' : 'DRAFT';
  const hasAuthority = bp.authority.provider === 'AMANE' && bp.authority.allowedActions.length > 0;
  const columns: GNode[][] = [[], [], [], [], [], [], []];
  const edges: GEdge[] = [];
  const ids = new Set<string>();

  const add = (col: number, id: string, ref: NodeRef, kind: ArchNodeKind, label: string, purpose: string, layers: ArchLayer[], extra: Partial<BaseNodeData> = {}) => {
    if (ids.has(id)) return;
    ids.add(id);
    columns[col]!.push({ id, ref, position: { x: 0, y: 0 }, data: { kind, label, purpose, networkRole: 'NONE', status: configured, layers, ...extra } });
  };
  const link = (source: string, target: string, kind: ArchEdgeKind, label: string, layers: ArchLayer[]) => {
    const id = `${source}->${target}:${kind}`;
    if (!edges.some((e) => e.id === id)) edges.push({ id, source, target, kind, label, layers });
  };
  const icon = (i: ArchExtraIcon) => ({ iconKey: i });
  const regStatus = (pid: string) => ({ status: providerStatus(reg.get(pid)?.status) });

  add(0, 'owner', { type: 'owner' }, 'operator', 'Owner', 'Signs the root policy with their own wallet. Kido never holds this key.', ['identity', 'policy']);

  const roleChains = (owns: string[]) => {
    const onChains = bp.actions.filter((a) => owns.includes(a.action)).map((a) => a.chain);
    return onChains.length ? [...new Set(onChains)] : owns.length ? bp.chains : [];
  };

  if (hasAuthority) {
    bp.chains.forEach((c) => {
      const actions = bp.actions.filter((a) => a.chain === c).map((a) => a.action);
      add(1, `policy:${c}`, { type: 'policy', chain: c }, 'policy', 'Amane policy', 'Owner-signed limits, payees and actions, enforced on-chain by the account itself.', ['policy', 'security-boundaries'], {
        chainTag: chainLabel(c),
        subtitle: (actions.length ? [...new Set(actions)] : bp.authority.allowedActions).join(' · '),
        capabilities: bp.authority.allowedActions,
      });
      add(2, `lease:${c}`, { type: 'lease', chain: c }, 'capability', 'Agent lease', 'A short-lived, revocable subset of the policy. The agent key only ever holds this.', ['policy', 'runtime'], {
        chainTag: chainLabel(c),
        subtitle: `${windowLabel(bp.authority.leaseLifetimeSeconds)} lifetime`,
      });
      add(4, `account:${c}`, { type: 'account', chain: c }, 'treasury', 'Agent account', 'Holds the funds; every action is checked against lease and policy before value moves.', ['execution', 'policy'], { chainTag: chainLabel(c) });
      link('owner', `policy:${c}`, 'POLICY', 'signs', ['policy']);
      link(`policy:${c}`, `lease:${c}`, 'AUTHORIZATION', 'issues within', ['policy']);
      link(`policy:${c}`, `account:${c}`, 'POLICY', 'bounds', ['policy', 'execution']);
    });
  }

  bp.agents.forEach((a) => {
    add(3, `agent:${a.role}`, { type: 'agent', role: a.role }, 'agent-runtime', a.role, `Specialist role. Owns ${a.owns.join(', ') || 'no actions'}; may request ${a.mayRequest.join(', ') || 'no other role'}.`, ['runtime'], {
      subtitle: a.owns.length ? `owns ${a.owns.join(', ')}` : 'observes only',
      capabilities: a.owns,
    });
    if (hasAuthority) {
      roleChains(a.owns).forEach((c) => {
        link(`lease:${c}`, `agent:${a.role}`, 'AUTHORIZATION', 'grants', ['policy', 'runtime']);
        link(`agent:${a.role}`, `account:${c}`, 'EXECUTE', 'signed intents', ['runtime', 'execution']);
      });
    }
  });
  bp.agents.forEach((a) => a.mayRequest.forEach((q) => link(`agent:${a.role}`, `agent:${q}`, 'ESCALATE', 'may request', ['runtime'])));

  if (hasAuthority) {
    bp.actions.forEach((x) => {
      const id = `action:${x.action}:${x.chain}`;
      add(5, id, { type: 'action', action: x.action, chain: x.chain, providerId: x.providerId, deterministic: x.deterministic }, 'executor', x.action, `Reached only through the Amane adapter pinned for ${x.action} on ${chainLabel(x.chain)}.`, ['execution'], {
        ...icon('action'),
        chainTag: chainLabel(x.chain),
        subtitle: `via ${x.providerId}`,
      });
      link(`account:${x.chain}`, id, 'EXECUTE', 'adapter', ['execution']);
      const kind = reg.get(x.providerId)?.kind;
      if (kind === 'authority') {
        [...bp.authority.payees.map((p) => ({ p, b: false })), ...bp.authority.beneficiaries.map((p) => ({ p, b: true }))]
          .filter(({ p }) => p.chain === x.chain)
          .forEach(({ p, b }) => {
            const pid = `payee:${p.chain}:${p.address}`;
            add(6, pid, { type: 'payee', label: p.label, chain: p.chain, address: p.address, beneficiary: b }, 'treasury', p.label, b ? 'Beneficiary pinned in the policy.' : 'Payee pinned in the owner-signed policy; payments go nowhere else.', ['execution'], {
              ...icon('payee'),
              chainTag: chainLabel(p.chain),
              subtitle: `${p.address.slice(0, 8)}…${p.address.slice(-4)}`,
            });
            link(id, pid, 'EXECUTE', b ? 'delivers' : 'pays', ['execution']);
          });
      } else {
        const pid = `protocol:${x.providerId}:${x.chain}`;
        add(6, pid, { type: 'protocol', providerId: x.providerId, chain: x.chain }, 'adapter-broker', x.providerId, `${chainLabel(x.chain)} protocol, reached only through a pinned Amane adapter.`, ['execution'], { chainTag: chainLabel(x.chain), ...regStatus(x.providerId) });
        link(id, pid, 'EXECUTE', 'calls', ['execution']);
      }
    });
  }

  bp.protocols.forEach((p) => {
    const pid = `protocol:${p.providerId}:${p.chain}`;
    add(6, pid, { type: 'protocol', providerId: p.providerId, chain: p.chain }, 'adapter-broker', p.providerId, `${chainLabel(p.chain)} protocol, reached only through a pinned Amane adapter.`, ['execution'], {
      chainTag: chainLabel(p.chain),
      subtitle: str(p.version) || undefined,
      capabilities: Array.isArray(p.capabilities) ? (p.capabilities as string[]) : undefined,
      ...regStatus(p.providerId),
    });
    if (hasAuthority && !edges.some((e) => e.target === pid)) link(`account:${p.chain}`, pid, 'EXECUTE', 'adapter', ['execution']);
  });

  bp.dataSources.forEach((d) => {
    const id = str(d.id);
    add(0, `data:${id}`, { type: 'data', id }, 'chainlink-feed', id, `${str(d.kind)} read from ${str(d.providerId)}${d.chain ? ` on ${chainLabel(str(d.chain))}` : ''}.`, ['data'], {
      chainTag: d.chain ? chainLabel(str(d.chain)) : undefined,
      subtitle: `${str(d.kind)} · min trust ${str(d.minTrust) || '—'}`,
    });
  });

  bp.monitors.forEach((m) => {
    const id = `monitor:${m.id}`;
    add(1, id, { type: 'monitor', id: m.id }, 'reality-engine', m.id, `Watches ${m.metric} ${m.op} ${m.threshold ?? (m.thresholdPrivateRef ? 'a private threshold' : '—')} and responds with ${m.action ?? m.response}.`, ['data', 'live-health'], {
      ...icon('monitor'),
      subtitle: `${m.metric} ${m.op} ${m.threshold ?? (m.thresholdPrivateRef ? 'private' : '—')} → ${m.action ?? m.response}`,
    });
    link(`data:${m.dataSource}`, id, 'READ', 'reads', ['data']);
    const wakes = bp.agents.filter((a) => (m.action ? a.owns.includes(m.action) : true));
    if (wakes.length) wakes.forEach((a) => link(id, `agent:${a.role}`, 'TRIGGER', 'wakes', ['live-health', 'runtime']));
    else link(id, 'owner', 'TRIGGER', 'alerts', ['live-health']);
  });

  bp.identity.bindings.forEach((b) => {
    const id = `identity:${b.provider}:${b.chain}`;
    add(0, id, { type: 'identity', provider: b.provider, chain: b.chain, name: b.name }, 'ens', b.name ?? `${b.provider.toUpperCase()} name`, 'Public discovery only; a name never grants authority.', ['identity'], {
      chainTag: chainLabel(b.chain),
      subtitle: `${b.provider.toUpperCase()} · ${b.status}`,
      ...(reg.get(b.provider) ? { status: b.status === 'PLANNED' ? configured : providerStatus(reg.get(b.provider)?.status) } : {}),
    });
    if (ids.has(`account:${b.chain}`)) link(id, `account:${b.chain}`, 'CONTEXT', 'names', ['identity']);
    else bp.agents.forEach((a) => link(id, `agent:${a.role}`, 'CONTEXT', 'advertises', ['identity']));
  });

  bp.privacy.providers.forEach((p) => {
    const id = `privacy:${p.providerId}:${p.chain}`;
    add(2, id, { type: 'privacy', providerId: p.providerId, chain: p.chain }, 'cre', p.providerId, `Protects private values (${p.satisfies.join(', ') || 'no stated value'}) so they never reach the agent in plaintext.`, ['security-boundaries', 'data'], {
      ...icon('privacy'),
      chainTag: chainLabel(p.chain),
      subtitle: p.capabilities.join(' · ') || undefined,
      capabilities: p.capabilities,
      ...regStatus(p.providerId),
    });
    const privMonitors = bp.monitors.filter((m) => m.thresholdPrivateRef);
    const privData = bp.dataSources.filter((d) => d.privateValueRef);
    if (privMonitors.length || privData.length) {
      privMonitors.forEach((m) => link(id, `monitor:${m.id}`, 'CONTEXT', 'protects', ['security-boundaries']));
      privData.forEach((d) => link(id, `data:${str(d.id)}`, 'CONTEXT', 'protects', ['security-boundaries']));
    } else bp.agents.forEach((a) => link(id, `agent:${a.role}`, 'CONTEXT', 'protects inputs', ['security-boundaries']));
  });

  const cc = bp.crossChain as { allowed?: boolean; transports?: string[] } | undefined;
  if (cc?.allowed) {
    (cc.transports ?? []).forEach((t) => {
      const id = `transport:${t}`;
      add(6, id, { type: 'transport', providerId: t }, 'adapter-broker', t, 'Cross-chain transport. Arrivals are reserved on-chain for one signed intent; undeliverable funds enter recovery.', ['execution', 'security-boundaries'], {
        ...icon('transport'),
        subtitle: bp.chains.map(chainLabel).join(' ⇄ '),
        ...regStatus(t),
      });
      const [first, ...rest] = bp.chains;
      if (first && ids.has(`account:${first}`)) link(`account:${first}`, id, 'EXECUTE', 'bridge', ['execution', 'security-boundaries']);
      rest.forEach((c) => ids.has(`account:${c}`) && link(id, `account:${c}`, 'EXECUTE', 'arrival', ['execution', 'security-boundaries']));
    });
  }

  const used = columns.filter((c) => c.length);
  const tallest = Math.max(1, ...used.map((c) => c.length));
  // A shallow graph (one or two nodes per column) wraps onto a second band so it fits a normal
  // canvas at a readable zoom instead of one long row.
  const perBand = tallest <= 2 && used.length > 4 ? Math.ceil(used.length / 2) : used.length;
  const nodes: GNode[] = [];
  used.forEach((col, ci) => {
    const band = Math.floor(ci / perBand);
    col.forEach((n, ri) => {
      n.position = { x: (ci % perBand) * COL, y: (band * (tallest + 0.6) + ri + (tallest - col.length) / 2) * ROW };
      nodes.push(n);
    });
  });
  return { nodes, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)), hasAuthority };
}
