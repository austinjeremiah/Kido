import { useMemo, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { BlueprintGraph, GraphNode, NodeState } from "../api";

/**
 * Architecture view.
 *
 * Every node position comes from the Blueprint projection on the server. The model never emitted a
 * coordinate, and this component never invents one — so the same Blueprint always draws the same
 * picture, and a node being present means the Blueprint genuinely requires that component.
 */

const STATE_COLOR: Record<NodeState, string> = {
  PENDING: "#3a4257",
  GENERATING: "#6ea8fe",
  READY: "#6ea8fe",
  RUNNING: "#f0b429",
  PASS: "#46d39a",
  WARN: "#f0b429",
  FAIL: "#f2687a",
  BLOCKED: "#f2687a",
};

const KIND_ACCENT: Record<string, string> = {
  Adapter: "#8f7ae5",
  Agent: "#f2687a",
  Executor: "#6ea8fe",
  Capability: "#46d39a",
  PrivatePolicy: "#f0b429",
  LedgerApproval: "#f0b429",
  LedgerKeyRing: "#f0b429",
};

export function ArchitectureView({
  graph,
  nodeStates,
}: {
  graph: BlueprintGraph | null;
  nodeStates: Record<string, NodeState>;
}) {
  const [selected, setSelected] = useState<GraphNode | null>(null);

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[] };
    const nodes: Node[] = graph.nodes.map((n) => {
      const state = nodeStates[n.id] ?? n.state;
      return {
        id: n.id,
        position: n.position,
        data: { label: n.label },
        type: "default",
        style: {
          background: "#131824",
          color: "#e6eaf2",
          border: `1px solid ${KIND_ACCENT[n.kind] ?? "#26304a"}`,
          borderLeft: `4px solid ${STATE_COLOR[state]}`,
          borderRadius: 8,
          padding: "8px 12px",
          fontSize: 12,
          width: 190,
        },
      } satisfies Node;
    });
    const edges: Edge[] = graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      animated: e.animated,
      style: {
        stroke: e.kind === "authority" ? "#46d39a" : e.kind === "data" ? "#6ea8fe" : "#3a4257",
        strokeWidth: e.kind === "authority" ? 2 : 1,
      },
      labelStyle: { fill: "#8d99b3", fontSize: 10 },
    }));
    return { nodes, edges };
  }, [graph, nodeStates]);

  if (!graph) {
    return <div className="empty">The architecture appears once the Blueprint is designed.</div>;
  }

  return (
    <div className="arch">
      <div className="arch-graph">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          nodesDraggable={false}
          onNodeClick={(_, n) => setSelected(graph.nodes.find((g) => g.id === n.id) ?? null)}
          proOptions={{ hideAttribution: false }}
        >
          <Background color="#1a2030" gap={20} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            style={{ background: "#0b0e14" }}
            nodeColor={(n) => STATE_COLOR[nodeStates[n.id] ?? "PENDING"]}
          />
        </ReactFlow>
      </div>

      <aside className="inspector">
        {selected ? (
          <>
            <h3>{selected.label}</h3>
            <div className="chip">{selected.kind}</div>
            {selected.sublabel && <div className="chip muted">{selected.sublabel}</div>}
            <dl>
              {selected.detail.map((d) => (
                <div key={d.label}>
                  <dt>{d.label}</dt>
                  <dd className={/confidential|never rendered/i.test(d.value) ? "redacted" : ""}>{d.value}</dd>
                </div>
              ))}
            </dl>
            {selected.kind === "PrivatePolicy" && (
              <p className="note">
                Parameter names only. The values are read inside the confidential handler and are not
                present in the Blueprint, so they cannot reach this panel.
              </p>
            )}
            {selected.kind === "Adapter" && (
              <p className="note">
                This adapter was chosen by deterministic resolution, not by the model. The trust class
                comes from its registered manifest — never inferred from the provider's name — and the
                version is pinned, so a registry update cannot silently change what this build runs.
              </p>
            )}
          </>
        ) : (
          <p className="note">Select a node to inspect its configuration and security properties.</p>
        )}
      </aside>
    </div>
  );
}
