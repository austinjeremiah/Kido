import { useMemo, useState } from "react";
import { ReactFlow, Background, Controls, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { OrgGraph, OrgGraphNode, OrgView } from "../api";

/**
 * Organization view.
 *
 * The nesting is the argument. A flat picture of four agents around a treasury reads as one system
 * with four parts; drawing each agent as a container that holds its OWN identity, policy, domain
 * and limits makes the separation visible — and makes a box that appears in two containers
 * obviously wrong, which is the whole thing a user needs to be able to see at a glance.
 *
 * Positions come from the server projection. Nothing here is arranged for effect.
 */

const STATE_COLOR: Record<OrgGraphNode["state"], string> = {
  OK: "#46d39a",
  WARN: "#f0b429",
  BLOCKED: "#f2687a",
};

const KIND_ACCENT: Record<string, string> = {
  Organization: "#8f7ae5",
  AgentGroup: "#6ea8fe",
  EnsIdentity: "#8f7ae5",
  Policy: "#f0b429",
  Limits: "#46d39a",
  Capability: "#6ea8fe",
  SharedResource: "#f0b429",
  AggregateLimit: "#46d39a",
};

const money = (c: number | null) => (c === null ? "UNKNOWN" : `$${(c / 100).toFixed(2)}`);

export function OrganizationView({ view, onBuildMember }: { view: OrgView | null; onBuildMember?: (agentId: string) => Promise<void> }) {
  const [selected, setSelected] = useState<OrgGraphNode | null>(null);

  const { nodes, edges } = useMemo(() => {
    const g: OrgGraph | undefined = view?.graph;
    if (!g) return { nodes: [] as Node[], edges: [] as Edge[] };

    const nodes: Node[] = g.nodes.map((n) => {
      const isContainer = n.kind === "AgentGroup" || n.kind === "Organization";
      return {
        id: n.id,
        position: n.position,
        data: { label: n.sublabel ? `${n.label}\n${n.sublabel}` : n.label },
        ...(n.parentId ? { parentId: n.parentId, extent: "parent" as const } : {}),
        type: "default",
        style: {
          background: isContainer ? "rgba(19,24,36,0.55)" : "#131824",
          color: "#e6eaf2",
          border: `1px solid ${KIND_ACCENT[n.kind] ?? "#26304a"}`,
          borderLeft: `4px solid ${STATE_COLOR[n.state]}`,
          borderRadius: isContainer ? 12 : 6,
          padding: isContainer ? "10px 12px" : "6px 10px",
          fontSize: isContainer ? 13 : 11,
          whiteSpace: "pre-line",
          width: n.size.width,
          height: n.size.height,
        },
      } satisfies Node;
    });

    const edges: Edge[] = g.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      animated: e.animated,
      style: {
        // A message edge is drawn dashed and muted on purpose: it is the edge a reader is most
        // likely to mistake for authority, and it carries none.
        stroke: e.kind === "resource" ? "#f0b429" : e.kind === "message" ? "#8d99b3" : "#3a4257",
        strokeWidth: e.kind === "resource" ? 2 : 1,
        strokeDasharray: e.kind === "message" ? "4 3" : undefined,
      },
      labelStyle: { fill: "#8d99b3", fontSize: 10 },
    }));

    return { nodes, edges };
  }, [view]);

  if (!view) {
    return <div className="empty">Describe a team of agents to design an organization.</div>;
  }

  const blast = selected?.id.startsWith("agent:")
    ? view.blastRadii.find((b) => `agent:${b.compromisedAgentId}` === selected.id)
    : undefined;

  return (
    <div className="arch">
      <div className="arch-graph">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          nodesDraggable={false}
          onNodeClick={(_, n) => setSelected(view.graph.nodes.find((x) => x.id === n.id) ?? null)}
          proOptions={{ hideAttribution: false }}
        >
          <Background color="#1a2030" gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <aside className="inspector">
        {!view.buildable && (
          <p className="note warn">
            This organization is not buildable. {view.issues.filter((i) => i.severity === "CRITICAL" || i.severity === "HIGH").length}{" "}
            blocking issue(s) below.
          </p>
        )}

        {selected ? (
          <>
            <h3>{selected.label}</h3>
            <div className="chip">{selected.kind}</div>
            {selected.sublabel && <div className="chip muted">{selected.sublabel}</div>}
            <dl>
              {selected.detail.map((d, i) => (
                <div key={`${d.label}-${i}`}>
                  <dt>{d.label}</dt>
                  <dd>{d.value}</dd>
                </div>
              ))}
            </dl>

            {blast && (
              <>
                <h4>If this agent is compromised</h4>
                <dl>
                  <div>
                    <dt>can move</dt>
                    <dd>{money(blast.maxAutonomousUsdCents)} per action</dd>
                  </div>
                  <div>
                    <dt>worst case in window</dt>
                    <dd>{money(blast.maxWindowUsdCents)}</dd>
                  </div>
                  <div>
                    <dt>other agents' authority</dt>
                    <dd>
                      {blast.authorityReachesAgents.length === 0
                        ? "none"
                        : blast.authorityReachesAgents.map((a) => `${a.agentId} (${a.via})`).join(", ")}
                    </dd>
                  </div>
                  <div>
                    <dt>can message</dt>
                    <dd>{blast.canMessageAgents.join(", ") || "nobody"} — influence only</dd>
                  </div>
                </dl>
                <ul className="contained">
                  {blast.containedBy.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <p className="note">Select an agent to see what its compromise would cost.</p>
        )}

        {/*
          * The members, and the way from a design to a running agent.
          *
          * An organization is separate principals by construction, and building one is an ordinary
          * single-agent build under the member's own name and limits. A member already built links
          * to its build; the rest offer the button. Nothing here builds all five at once: each is a
          * project, each stops at its own approval boundary.
          */}
        <h4>Members</h4>
        <ul className="members">
          {view.organization.agents.map((a) => {
            const b = view.memberBuilds?.[a.id];
            return (
              <li key={a.id}>
                <div className="member-head">
                  <strong>{a.displayName}</strong> <code>{a.ensName}</code>
                </div>
                <div className="member-caps">
                  {a.executionCapabilities.length > 0 ? a.executionCapabilities.join("; ") : "reads and reports only"}
                  {a.autonomousMaxUsdCents !== null && <> · auto ≤ ${(a.autonomousMaxUsdCents / 100).toLocaleString("en-US")}</>}
                  {a.escalationMaxUsdCents !== null && <> · signature ≤ ${(a.escalationMaxUsdCents / 100).toLocaleString("en-US")}</>}
                </div>
                {b ? (
                  <a className="member-build" href={`?build=${b.buildId}`}>build {b.buildId} — {b.stage} {b.status}</a>
                ) : onBuildMember ? (
                  <button type="button" className="member-build-btn" onClick={() => void onBuildMember(a.id)}>Build this agent</button>
                ) : null}
              </li>
            );
          })}
        </ul>

        {view.issues.length > 0 && (
          <>
            <h4>Findings</h4>
            <ul className="findings">
              {view.issues.map((i, n) => (
                <li key={`${i.code}-${n}`} className={i.severity.toLowerCase()}>
                  <code>{i.code}</code> {i.message}
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}
