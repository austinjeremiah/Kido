'use client';

/**
 * Architecture: how the agent obtains identity, data, policy decisions and execution authority,
 * drawn from the compiled blueprint (owner → per-chain Amane policy → lease → specialist roles →
 * account → pinned adapters → protocols / payees, with data sources, monitors, identity names,
 * privacy providers and cross-chain transports attached where the blueprint puts them).
 *
 * The live overlay is the same graph with observed state painted on — the chains' readings from
 * the runtime endpoint once deployed, provider evidence and monitor health from the self-model —
 * and a node with no reading keeps its configured state rather than turning green from absence.
 * The inspector opens inside the canvas, and an accessible node list mirrors it.
 */
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { Activity, Download, Layers, List, Lock, Map as MapIcon, Maximize, RotateCcw, Tags, Unlock, X, ZoomIn, ZoomOut } from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { ArchFlowNode, type ArchFlowNodeData } from '@/components/studio/architecture/ArchNode';
import { EDGE_KIND, LAYERS, buildGraph, providerStatus, type Graph } from '@/components/studio/architecture/graph';
import { NodeInspector } from '@/components/studio/architecture/Inspector';
import { exportJson, exportPng, exportSvg } from '@/components/studio/architecture/export';
import { Badge, BlockerBanner, StatusBadge, statusTone } from '@/components/studio/primitives';
import { MenuItem, MenuLabel, Popover } from '@/components/studio/shell/Popover';
import { NotYet, WithProject, useKido } from '@/components/studio/kido';
import { useRegistry, useRuntime, useSelfModel } from '@/lib/kido/hooks';
import { useWorkbench } from '@/lib/studio/workbench';
import { STAGE_LABEL, chainLabel } from '@/lib/kido/format';
import type { ProjectSummary, Runtime, SelfModel } from '@/lib/kido/types';
import type { ArchEdgeKind, ArchLayer, Status } from '@/lib/studio/types';

const nodeTypes = { arch: ArchFlowNode };
const ALL_LAYERS = LAYERS.map((l) => l.id);

export default function ArchitecturePage() {
  const { s } = useKido();
  if (s?.blueprint) {
    return (
      <ReactFlowProvider>
        <ArchitectureCanvas s={s} />
      </ReactFlowProvider>
    );
  }
  return (
    <StudioPage segment="architecture">
      <WithProject>{(p) => <NotYet what="blueprint" where="composer" id={p.projectId} />}</WithProject>
    </StudioPage>
  );
}

/** Observed state per node id. Only nodes with an actual reading appear here. */
function liveStates(g: Graph, sm: SelfModel | undefined, rt: Runtime | undefined): Record<string, Status> {
  const out: Record<string, Status> = {};
  const deployed = rt?.deployed === true;
  const chain = (c: string) => rt?.chains.find((x) => x.chain === c);
  const leaseOf = (n: number | null): Status | undefined => (n === 1 ? 'ACTIVE' : n === 2 ? 'REVOKED' : n === 0 ? 'NOT_ISSUED' : undefined);
  g.nodes.forEach((n) => {
    const r = n.ref;
    let st: Status | undefined;
    if (r.type === 'owner' && deployed && rt?.owner) st = 'ACTIVE';
    if (deployed && (r.type === 'account' || r.type === 'policy' || r.type === 'lease')) {
      const c = chain(r.chain);
      if (c?.error) st = 'DEGRADED';
      else if (c && r.type === 'account') st = c.paused ? 'PAUSED' : 'ACTIVE';
      else if (c && r.type === 'policy') st = c.policyVersion === null ? undefined : c.paused ? 'PAUSED' : 'ENABLED';
      else if (c && r.type === 'lease') st = leaseOf(c.leaseStatus);
    }
    if (deployed && r.type === 'agent') {
      const chains = g.edges.filter((e) => e.target === n.id && e.source.startsWith('lease:')).map((e) => chain(e.source.slice(6))).filter(Boolean);
      if (chains.length) {
        if (chains.every((c) => c!.leaseStatus === 2)) st = 'REVOKED';
        else if (chains.some((c) => c!.paused)) st = 'PAUSED';
        else if (chains.some((c) => c!.leaseStatus === 1)) st = 'ACTIVE';
      }
    }
    if (r.type === 'protocol' || r.type === 'privacy' || r.type === 'transport' || r.type === 'identity') {
      const pid = r.type === 'identity' ? r.provider : r.providerId;
      const p = sm?.providers.find((x) => x.providerId === pid);
      if (p) st = providerStatus(p.status);
    }
    if (r.type === 'monitor') {
      const h = sm?.monitors.find((m) => m.id === r.id)?.health;
      if (h) st = h as Status;
    }
    if (st) out[n.id] = st;
  });
  return out;
}

function ArchitectureCanvas({ s }: { s: ProjectSummary }) {
  const bp = s.blueprint!;
  const id = s.projectId;
  const { pushToast } = useWorkbench();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const registry = useRegistry();
  const sm = useSelfModel(id);
  const rt = useRuntime(id);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /* SVG fill attributes do not resolve CSS variables, so the minimap gets the theme's actual colours. */
  const [palette, setPalette] = useState<Record<string, string>>({});
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const css = getComputedStyle(el);
    setPalette(Object.fromEntries(['pass', 'warn', 'deny', 'sim', 'data', 'blocked', 'ink-2', 'panel', 'line-strong'].map((t) => [t, css.getPropertyValue(`--cl-${t}`).trim()])));
  }, []);

  const graph = useMemo(() => buildGraph(bp, s.build, registry.data ?? []), [bp, s.build, registry.data]);
  const live = useMemo(() => liveStates(graph, sm.data, rt.data), [graph, sm.data, rt.data]);
  const deployed = rt.data?.deployed === true;

  const [liveOverlay, setLiveOverlay] = useState(true);
  const [locked, setLocked] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [showLegend, setShowLegend] = useState(true);
  const [listOpen, setListOpen] = useState(false);
  const [activeLayers, setActiveLayers] = useState<ArchLayer[]>(ALL_LAYERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});

  const isLayerOn = useCallback((layers: ArchLayer[]) => layers.some((l) => activeLayers.includes(l)), [activeLayers]);
  const statusOf = useCallback((nid: string): Status => {
    const n = graph.nodes.find((x) => x.id === nid);
    return (liveOverlay ? live[nid] : undefined) ?? n?.data.status ?? 'UNKNOWN';
  }, [graph, live, liveOverlay]);

  const nodes = useMemo<Node[]>(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: 'arch',
        position: moved[n.id] ?? n.position,
        selected: n.id === selectedId,
        data: { ...n.data, liveStatus: live[n.id], liveOverlay, dimmed: !isLayerOn(n.data.layers) } satisfies ArchFlowNodeData,
      })),
    [graph, moved, selectedId, live, liveOverlay, isLayerOn],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e) => {
        const visible = isLayerOn(e.layers);
        const tone = EDGE_KIND[e.kind].tone;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          animated: liveOverlay && deployed && (e.kind === 'EXECUTE' || e.kind === 'AUTHORIZATION'),
          style: { stroke: tone, strokeWidth: 1.4, opacity: visible ? 1 : 0.12, strokeDasharray: e.kind === 'ESCALATE' ? '5 4' : undefined },
          labelStyle: { fill: tone, fontFamily: 'var(--medium)', fontSize: 9.5, letterSpacing: '0.08em', opacity: visible ? 1 : 0.12 },
          labelBgStyle: { fill: 'var(--cl-panel)', fillOpacity: visible ? 0.95 : 0.1 },
          labelBgPadding: [4, 2] as [number, number],
        };
      }),
    [graph, isLayerOn, liveOverlay, deployed],
  );

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const pos = changes.filter((c): c is Extract<NodeChange, { type: 'position' }> => c.type === 'position' && Boolean(c.position));
    if (pos.length) setMoved((m) => ({ ...m, ...Object.fromEntries(pos.map((c) => [c.id, c.position!])) }));
  }, []);

  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;
  const toggleLayer = (l: ArchLayer) => setActiveLayers((p) => (p.includes(l) ? p.filter((x) => x !== l) : [...p, l]));
  const counts = useMemo(() => Object.fromEntries(LAYERS.map((l) => [l.id, graph.nodes.filter((n) => n.data.layers.includes(l.id)).length])), [graph]);
  const edgeKinds = useMemo(() => [...new Set(graph.edges.map((e) => e.kind))] as ArchEdgeKind[], [graph]);
  const positioned = graph.nodes.map((n) => ({ ...n, position: moved[n.id] ?? n.position }));
  const fileName = `${s.name || id}-architecture-r${bp.revision}`.replace(/[^\w.-]+/g, '-');
  const scope = () => canvasRef.current?.closest('.cl-studio') ?? canvasRef.current;
  const overlayNote = !liveOverlay ? 'Configured state' : deployed ? 'Live overlay · chain readings' : sm.data ? 'Live overlay · provider evidence only (not deployed)' : 'Live overlay · nothing observed yet';

  return (
    <StudioPage
      segment="architecture"
      bleed
      live={liveOverlay && deployed}
      banners={
        <div className="cl-row cl-row-wrap" style={{ marginBottom: 12, gap: 8 }}>
          <span className="cl-page-title" style={{ fontSize: 22, marginRight: 8 }}>Architecture</span>
          <Badge tone="neutral">{s.name}</Badge>
          <Badge tone="neutral">Blueprint r{bp.revision}</Badge>
          <Badge tone={s.stage === 'BUILT' ? 'pass' : 'neutral'}>{STAGE_LABEL[s.stage]}</Badge>
          {bp.chains.map((c) => <Badge key={c} tone="sim">{chainLabel(c)}</Badge>)}
          {!graph.hasAuthority ? <Badge tone="blocked">EXECUTION: NONE</Badge> : null}
          <Badge tone={liveOverlay && deployed ? 'pass' : 'neutral'}>{overlayNote}</Badge>
          <span className="cl-spacer" />
          <div className="cl-btn-group">
            <button type="button" className="cl-btn cl-btn-sm" onClick={() => fitView({ duration: 300, padding: 0.15 })}><Maximize size={12} aria-hidden />Fit</button>
            <button type="button" className="cl-btn cl-btn-sm" onClick={() => zoomOut({ duration: 160 })} aria-label="Zoom out"><ZoomOut size={12} aria-hidden /></button>
            <button type="button" className="cl-btn cl-btn-sm" onClick={() => zoomIn({ duration: 160 })} aria-label="Zoom in"><ZoomIn size={12} aria-hidden /></button>
            <button type="button" className="cl-btn cl-btn-sm" onClick={() => setLocked((v) => !v)} aria-pressed={locked} title={locked ? 'Unlock: drag nodes and pan' : 'Lock nodes and viewport'}>
              {locked ? <Lock size={12} aria-hidden /> : <Unlock size={12} aria-hidden />}
              {locked ? 'Locked' : 'Lock'}
            </button>
            <button type="button" className="cl-btn cl-btn-sm" disabled={!Object.keys(moved).length} onClick={() => { setMoved({}); setTimeout(() => fitView({ duration: 300, padding: 0.15 }), 0); }} title="Restore the deterministic layout">
              <RotateCcw size={12} aria-hidden />Reset layout
            </button>
            <Popover
              width={320}
              label="Layers"
              trigger={({ toggle }) => (
                <button type="button" className="cl-btn cl-btn-sm" onClick={toggle}><Layers size={12} aria-hidden />Layers ({activeLayers.length}/{ALL_LAYERS.length})</button>
              )}
            >
              {() => (
                <>
                  <MenuLabel>Show layers</MenuLabel>
                  {LAYERS.map((l) => (
                    <label key={l.id} className="cl-checkbox" style={{ padding: '7px 12px' }}>
                      <input type="checkbox" checked={activeLayers.includes(l.id)} onChange={() => toggleLayer(l.id)} />
                      <span>
                        {l.label} <span className="cl-meta">({counts[l.id] ?? 0})</span>
                        <span className="cl-meta" style={{ display: 'block', whiteSpace: 'normal' }}>{l.description}</span>
                      </span>
                    </label>
                  ))}
                </>
              )}
            </Popover>
            <button type="button" className="cl-btn cl-btn-sm" onClick={() => setLiveOverlay((v) => !v)} aria-pressed={liveOverlay}><Activity size={12} aria-hidden />Live overlay</button>
            <button type="button" className="cl-btn cl-btn-sm" onClick={() => setShowLegend((v) => !v)} aria-pressed={showLegend}><Tags size={12} aria-hidden />Legend</button>
            <button type="button" className="cl-btn cl-btn-sm" onClick={() => setShowMap((v) => !v)} aria-pressed={showMap}><MapIcon size={12} aria-hidden />Map</button>
            <button type="button" className="cl-btn cl-btn-sm" onClick={() => setListOpen((v) => !v)} aria-pressed={listOpen} title="Accessible node list"><List size={12} aria-hidden />Nodes</button>
            <Popover
              width={220}
              align="right"
              label="Export"
              trigger={({ toggle }) => (
                <button type="button" className="cl-btn cl-btn-sm" onClick={toggle}><Download size={12} aria-hidden />Export</button>
              )}
            >
              {({ close }) => (
                <>
                  <MenuLabel>Export the graph</MenuLabel>
                  <MenuItem onClick={() => { close(); exportPng(fileName, positioned, graph.edges, statusOf, scope()).then(() => pushToast('Architecture exported as PNG')).catch((e) => pushToast(`PNG export failed: ${(e as Error).message}`)); }}>PNG image</MenuItem>
                  <MenuItem onClick={() => { close(); exportSvg(fileName, positioned, graph.edges, statusOf, scope()); pushToast('Architecture exported as SVG'); }}>SVG drawing</MenuItem>
                  <MenuItem onClick={() => { close(); exportJson(fileName, { projectId: id, blueprintRevision: bp.revision, blueprintHash: s.blueprintHash, kidoAgentId: bp.kidoAgentId, liveOverlay, deployed }, positioned, graph.edges, statusOf); pushToast('Architecture exported as JSON'); }}>JSON graph</MenuItem>
                </>
              )}
            </Popover>
          </div>
        </div>
      }
    >
      {!graph.hasAuthority ? (
        <div style={{ padding: '0 16px 12px' }}>
          <BlockerBanner tone="neutral" title="This agent has no execution path">
            The blueprint&apos;s authority mode is {bp.authority.mode ?? 'unset'}{bp.authority.provider ? ` with ${bp.authority.provider}` : ' with no authority provider'}, so there is no policy, lease or account in its architecture — the absence of authority is structural, not a setting.
          </BlockerBanner>
        </div>
      ) : null}

      <div style={{ display: 'flex', flex: '1 1 auto', minHeight: 560, borderTop: '1px solid var(--cl-line)' }}>
        {listOpen ? (
          <div style={{ flex: '0 0 260px', overflowY: 'auto', borderRight: '1px solid var(--cl-line)', background: 'var(--cl-panel)' }}>
            <div className="cl-explorer-head">
              <span className="cl-label">Nodes ({graph.nodes.length})</span>
              <button type="button" className="cl-btn cl-btn-ghost cl-btn-sm" onClick={() => setListOpen(false)} aria-label="Close node list"><X size={12} aria-hidden /></button>
            </div>
            <ul>
              {graph.nodes.map((n) => (
                <li key={n.id}>
                  <button type="button" className="cl-nav-item" data-active={n.id === selectedId} onClick={() => setSelectedId(n.id)}>
                    <span className="cl-nav-item-label">{n.data.label}{n.data.chainTag ? <span className="cl-meta"> · {n.data.chainTag}</span> : null}</span>
                    <StatusBadge status={statusOf(n.id)} icon={false} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div ref={canvasRef} className="cl-graph" data-lenis-prevent style={{ flex: '1 1 auto', minWidth: 0, position: 'relative' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            fitView
            fitViewOptions={{ padding: 0.12, maxZoom: 1.1 }}
            minZoom={0.2}
            maxZoom={1.6}
            panOnDrag={!locked}
            zoomOnScroll={!locked}
            zoomOnPinch={!locked}
            zoomOnDoubleClick={!locked}
            nodesDraggable={!locked}
            nodesConnectable={false}
            elementsSelectable
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            style={{ background: 'var(--cl-canvas)' }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} color="var(--cl-canvas-dot)" />
            <Controls position="bottom-left" showInteractive={false} fitViewOptions={{ padding: 0.15, duration: 300 }} />
            {showMap ? (
              <MiniMap
                pannable
                zoomable
                position="bottom-right"
                style={{ marginRight: selected ? 350 : 15, background: 'var(--cl-panel)', border: '1px solid var(--cl-line-strong)' }}
                maskColor="rgba(0,0,0,0.12)"
                nodeStrokeWidth={2}
                nodeColor={(n) => {
                  const t = statusTone(statusOf(n.id));
                  return palette[t === 'neutral' ? 'ink-2' : t] || '#888';
                }}
              />
            ) : null}
            {showLegend ? (
              <Panel position="top-left">
                <div className="cl-card" style={{ padding: '10px 12px', minWidth: 190, fontSize: 11 }}>
                  <div className="cl-label" style={{ marginBottom: 6 }}>Edges</div>
                  {edgeKinds.map((k) => (
                    <div key={k} className="cl-row" style={{ gap: 8, marginBottom: 4 }}>
                      <svg width="26" height="8" aria-hidden><line x1="0" y1="4" x2="26" y2="4" stroke={EDGE_KIND[k].tone} strokeWidth="2" strokeDasharray={k === 'ESCALATE' ? '5 4' : undefined} /></svg>
                      <span>{EDGE_KIND[k].label}</span>
                      <span className="cl-meta" style={{ marginLeft: 'auto' }}>{graph.edges.filter((e) => e.kind === k).length}</span>
                    </div>
                  ))}
                  <div className="cl-label" style={{ margin: '8px 0 6px' }}>Nodes</div>
                  <div className="cl-meta" style={{ whiteSpace: 'normal' }}>
                    {graph.nodes.length} nodes · {graph.edges.length} edges · {Object.keys(live).length} with an observed reading
                  </div>
                </div>
              </Panel>
            ) : null}
          </ReactFlow>

          {selected ? (
            <div className="cl-drawer cl-drawer-float">
              <div className="cl-drawer-head">
                <span className="cl-label" style={{ flex: '1 1 auto' }}>Node inspector</span>
                <button type="button" className="cl-btn cl-btn-ghost cl-btn-sm" onClick={() => setSelectedId(null)} aria-label="Close inspector"><X size={13} aria-hidden /></button>
              </div>
              <div className="cl-drawer-body">
                <NodeInspector node={selected} graph={graph} status={statusOf(selected.id)} s={s} sm={sm.data} rt={rt.data} registry={registry.data ?? []} onSelect={setSelectedId} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </StudioPage>
  );
}
