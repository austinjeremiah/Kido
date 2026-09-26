'use client';

/**
 * Architecture: how the agent observes, decides and acts, built from the blueprint. Authority edges
 * run owner → Amane policy → the agent's account per chain; the agent only ever holds a lease. The
 * layout is deterministic (columns by role), so the same blueprint always draws the same graph.
 */
import '@xyflow/react/dist/style.css';
import { useMemo, useState } from 'react';
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { ArchFlowNode, type ArchFlowNodeData } from '@/components/studio/architecture/ArchNode';
import { Card, KeyValue } from '@/components/studio/primitives';
import { NotYet, WithProject } from '@/components/studio/kido';
import { chainLabel } from '@/lib/kido/format';
import type { Blueprint } from '@/lib/kido/types';
import type { ArchNodeKind, Status } from '@/lib/studio/types';

const nodeTypes = { arch: ArchFlowNode };
const COL = 300;
const ROW = 170;

function kindFor(providerId: string): ArchNodeKind {
  if (providerId.startsWith('aave')) return 'aave';
  if (providerId.startsWith('uniswap') || providerId.startsWith('cetus')) return 'uniswap';
  if (providerId === 'ens' || providerId === 'suins') return 'ens';
  if (providerId.includes('cre')) return 'cre';
  return 'adapter-broker';
}

function graphOf(bp: Blueprint, built: boolean): { nodes: Node<ArchFlowNodeData>[]; edges: Edge[] } {
  const nodes: Node<ArchFlowNodeData>[] = [];
  const edges: Edge[] = [];
  const status: Status = built ? 'READY' : 'PENDING' as Status;
  const add = (id: string, col: number, row: number, kind: ArchNodeKind, label: string, purpose: string, extra: Partial<ArchFlowNodeData> = {}) =>
    nodes.push({ id, type: 'arch', position: { x: col * COL, y: row * ROW }, data: { kind, label, purpose, networkRole: 'EXECUTION_TESTNET', status, layers: ['policy'], liveOverlay: false, dimmed: false, ...extra } as ArchFlowNodeData });
  const link = (source: string, target: string, kind: 'authority' | 'data' | 'control', label?: string) =>
    edges.push({ id: `${source}->${target}`, source, target, label, animated: kind === 'data', style: kind === 'authority' ? { strokeWidth: 2 } : undefined });

  add('owner', 0, 0, 'operator', 'Owner', 'Signs the root policy with their own wallet. Kido never holds this key.');
  bp.chains.forEach((c, i) => {
    add(`policy:${c}`, 1, i, 'policy', `Amane policy · ${chainLabel(c)}`, 'Owner-signed limits, payees and actions, enforced on-chain.', { capabilities: bp.authority.allowedActions });
    add(`account:${c}`, 3, i, 'treasury', `Agent account · ${chainLabel(c)}`, 'Holds the funds; every action is checked against lease and policy before value moves.');
    link('owner', `policy:${c}`, 'authority', 'signs');
    link(`policy:${c}`, `account:${c}`, 'authority', 'bounds');
  });
  bp.agents.forEach((a, i) => {
    add(`agent:${a.role}`, 2, bp.chains.length + 2 * i, 'agent-runtime', a.role, `Owns ${a.owns.join(', ') || 'nothing'}; may request ${a.mayRequest.join(', ') || 'nothing'}.`, { capabilities: a.owns });
    add(`lease:${a.role}`, 1, bp.chains.length + 2 * i, 'capability', 'Lease', `Short-lived, revocable subset of the policy (${Math.round(bp.authority.leaseLifetimeSeconds / 60)} min).`);
    bp.chains.forEach((c) => {
      link(`agent:${a.role}`, `account:${c}`, 'control', 'signed intents');
      link(`policy:${c}`, `lease:${a.role}`, 'authority', 'issues within');
    });
    link(`lease:${a.role}`, `agent:${a.role}`, 'authority', 'grants');
  });
  bp.dataSources.forEach((d, i) => {
    const id = String(d.id);
    add(`data:${id}`, 0, bp.chains.length + i + 1, 'chainlink-feed', id, `${String(d.kind)} via ${String(d.providerId)} (min trust ${String(d.minTrust ?? '—')})`, { layers: ['data'] });
  });
  bp.monitors.forEach((m, i) => {
    add(`monitor:${m.id}`, 1, bp.chains.length + i + 1, 'reality-engine', m.id, `${m.metric} ${m.op} ${m.threshold ?? (m.thresholdPrivateRef ? 'private threshold' : '—')} → ${m.action ?? m.response}`, { layers: ['data'] });
    link(`data:${m.dataSource}`, `monitor:${m.id}`, 'data');
    bp.agents.forEach((a) => link(`monitor:${m.id}`, `agent:${a.role}`, 'data', 'wakes'));
  });
  bp.protocols.forEach((p, i) => {
    add(`protocol:${p.providerId}:${p.chain}`, 4, i, kindFor(p.providerId), p.providerId, `${chainLabel(p.chain)} protocol, reached only through a pinned Amane adapter.`, { layers: ['execution'] });
    link(`account:${p.chain}`, `protocol:${p.providerId}:${p.chain}`, 'control', 'adapter');
  });
  bp.identity.bindings.forEach((b, i) => {
    add(`identity:${b.provider}:${b.chain}`, 4, bp.protocols.length + i + 0.5, 'ens', b.name ?? `${b.provider.toUpperCase()} name`, 'Public discovery only; a name never grants authority.', { layers: ['identity'] });
  });
  return { nodes: nodes.filter((n, i, all) => all.findIndex((x) => x.id === n.id) === i), edges: edges.filter((e) => nodes.some((n) => n.id === e.source) && nodes.some((n) => n.id === e.target)) };
}

function Graph({ bp, built }: { bp: Blueprint; built: boolean }) {
  const { nodes, edges } = useMemo(() => graphOf(bp, built), [bp, built]);
  const [selected, setSelected] = useState<string | null>(null);
  const node = nodes.find((n) => n.id === selected);
  return (
    <div style={{ display: 'flex', flex: '1 1 auto', minHeight: 560, gap: 12 }}>
      <div className="cl-graph" data-lenis-prevent style={{ flex: '1 1 auto', minWidth: 0, position: 'relative', minHeight: 560 }}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.08, maxZoom: 1.25 }} minZoom={0.25} maxZoom={1.6} nodesDraggable={false} nodesConnectable={false} proOptions={{ hideAttribution: true }} onNodeClick={(_, n) => setSelected(n.id)} onPaneClick={() => setSelected(null)}>
          <Background />
        </ReactFlow>
      </div>
      {node ? (
        <div style={{ width: 300, flex: '0 0 auto' }}>
          <Card title={node.data.label}>
            <p className="cl-body" style={{ marginTop: 0 }}>{node.data.purpose}</p>
            <KeyValue rows={[{ label: 'Kind', value: node.data.kind }, { label: 'Capabilities', value: node.data.capabilities?.join(', ') || '—' }]} />
          </Card>
        </div>
      ) : null}
    </div>
  );
}

export default function ArchitecturePage() {
  return (
    <StudioPage segment="architecture">
      <WithProject>{(s) => (s.blueprint ? <Graph bp={s.blueprint} built={s.stage === 'BUILT'} /> : <NotYet what="blueprint" where="composer" id={s.projectId} />)}</WithProject>
    </StudioPage>
  );
}
