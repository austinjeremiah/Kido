import type { Organization } from "./schema.js";
import { computeBlastRadius } from "./blast.js";

/**
 * Deterministic projection: Organization → nested graph.
 *
 * Nesting is the point. A flat diagram of five agents around a treasury makes them look like parts
 * of one system; a diagram where each agent is a CONTAINER holding its own identity, policy and
 * limits makes the separation visible, and makes a shared box obviously wrong.
 *
 * Every node here is derived. Nothing is positioned by a model.
 */

export type OrgNodeKind =
  | "Organization"
  | "AgentGroup"
  | "EnsIdentity"
  | "Policy"
  | "Limits"
  | "Capability"
  | "SharedResource"
  | "AggregateLimit";

export interface OrgGraphNode {
  id: string;
  kind: OrgNodeKind;
  label: string;
  sublabel?: string;
  /** Set for nodes drawn inside an agent container. */
  parentId?: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  state: "OK" | "WARN" | "BLOCKED";
  detail: Array<{ label: string; value: string }>;
}

export interface OrgGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  /**
   * `message` edges are drawn distinctly from `resource` edges because they are the ones a reader
   * most often mistakes for authority. They are not.
   */
  kind: "resource" | "message" | "namespace";
  animated: boolean;
}

export interface OrgGraph {
  orgId: string;
  revision: number;
  nodes: OrgGraphNode[];
  edges: OrgGraphEdge[];
}

const AGENT_W = 300;
const AGENT_H = 260;
const GAP_X = 60;
const CHILD_H = 46;

const usd = (cents: number | null) => (cents === null ? "UNKNOWN" : `$${(cents / 100).toFixed(2)}`);

export function projectOrgGraph(org: Organization): OrgGraph {
  const nodes: OrgGraphNode[] = [];
  const edges: OrgGraphEdge[] = [];

  nodes.push({
    id: "org",
    kind: "Organization",
    label: org.rootEns,
    sublabel: org.agentNamespace,
    position: { x: 0, y: 0 },
    size: { width: org.agents.length * (AGENT_W + GAP_X) - GAP_X, height: 90 },
    state: "OK",
    detail: [
      { label: "agents", value: String(org.agents.length) },
      { label: "delegation", value: "not representable" },
      { label: "revision", value: String(org.revision) },
    ],
  });

  org.agents.forEach((a, i) => {
    const x = i * (AGENT_W + GAP_X);
    const y = 170;
    const blast = computeBlastRadius(org, a.id);
    const container = `agent:${a.id}`;

    nodes.push({
      id: container,
      kind: "AgentGroup",
      label: a.displayName,
      sublabel: a.executionClass,
      position: { x, y },
      size: { width: AGENT_W, height: AGENT_H },
      state: blast.authorityReachesAgents.length > 0 ? "WARN" : "OK",
      detail: [
        { label: "execution class", value: a.executionClass },
        { label: "reachable agents if compromised", value: String(blast.authorityReachesAgents.length) },
        { label: "worst case in window", value: usd(blast.maxWindowUsdCents) },
      ],
    });

    edges.push({ id: `e:org:${a.id}`, source: "org", target: container, kind: "namespace", animated: false });

    const child = (suffix: string, kind: OrgNodeKind, label: string, sublabel: string, row: number, detail: Array<{ label: string; value: string }>, state: OrgGraphNode["state"] = "OK") =>
      nodes.push({
        id: `${container}:${suffix}`,
        kind,
        label,
        sublabel,
        parentId: container,
        position: { x: 16, y: 56 + row * CHILD_H },
        size: { width: AGENT_W - 32, height: CHILD_H - 8 },
        state,
        detail,
      });

    child("ens", "EnsIdentity", a.ensName, "identity, lifecycle, revocation", 0, [
      { label: "grants financial authority", value: "no" },
    ]);
    child("policy", "Policy", a.policyId, "ContextLock policy", 1, [
      { label: "execution domain", value: a.executionDomain },
    ]);
    child(
      "limits",
      "Limits",
      a.executionClass === "EXECUTE" ? usd(a.autonomousMaxUsdCents) : "no execution",
      a.executionClass === "EXECUTE" ? `daily ${usd(a.dailyMaxUsdCents)}` : "cannot move value",
      2,
      [
        { label: "autonomous", value: usd(a.autonomousMaxUsdCents) },
        { label: "escalation ceiling", value: usd(a.escalationMaxUsdCents) },
        { label: "daily", value: usd(a.dailyMaxUsdCents) },
      ],
      a.executionClass === "EXECUTE" && a.dailyMaxUsdCents === null ? "BLOCKED" : "OK",
    );
    child(
      "caps",
      "Capability",
      a.executionCapabilities.length > 0 ? a.executionCapabilities.join(", ") : "none",
      `${a.dataCapabilities.length} data source(s)`,
      3,
      a.dataCapabilities.map((c) => ({ label: "reads", value: c })),
    );
  });

  const rowY = 170 + AGENT_H + 80;
  org.sharedResources.forEach((r, i) => {
    const id = `res:${r.id}`;
    nodes.push({
      id,
      kind: "SharedResource",
      label: r.id,
      sublabel: r.kind,
      position: { x: i * (AGENT_W + GAP_X), y: rowY },
      size: { width: AGENT_W, height: 80 },
      state: r.kind === "credential" && r.agentIds.length > 1 ? "BLOCKED" : "OK",
      detail: [
        { label: "kind", value: r.kind },
        { label: "shared by", value: r.agentIds.join(", ") || "nobody" },
      ],
    });
    for (const a of r.agentIds) {
      edges.push({ id: `e:${r.id}:${a}`, source: `agent:${a}`, target: id, kind: "resource", animated: false });
    }
  });

  org.aggregateLimits.forEach((l, i) => {
    const id = `agg:${l.id}`;
    nodes.push({
      id,
      kind: "AggregateLimit",
      label: usd(l.maxUsdCents),
      sublabel: `per ${Math.round(l.windowMs / 3_600_000)}h across all agents`,
      position: { x: (org.sharedResources.length + i) * (AGENT_W + GAP_X), y: rowY },
      size: { width: AGENT_W, height: 80 },
      state: "OK",
      detail: [{ label: "description", value: l.description }],
    });
  });

  org.communicationRules.forEach((c, i) => {
    edges.push({
      id: `e:msg:${i}`,
      source: `agent:${c.from}`,
      target: `agent:${c.to}`,
      // Spelled out on the edge itself: a reader should not have to know the model to know a
      // message is not an approval.
      label: `${c.messageKinds.join("/")} — untrusted, no authority`,
      kind: "message",
      animated: true,
    });
  });

  return { orgId: org.orgId, revision: org.revision, nodes, edges };
}
