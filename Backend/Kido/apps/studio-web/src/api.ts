/**
 * Studio API client.
 *
 * Everything the UI renders comes from the server. Nothing about a build lives in React state that
 * cannot be re-fetched — which is what makes a tab switch or a browser refresh a non-event: the
 * build is running in the backend either way, and the UI is only ever a view of it.
 */

export type NodeState = "PENDING" | "GENERATING" | "READY" | "RUNNING" | "PASS" | "WARN" | "FAIL" | "BLOCKED";

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  sublabel?: string;
  rank: number;
  position: { x: number; y: number };
  state: NodeState;
  detail: Array<{ label: string; value: string }>;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  kind: "authority" | "data" | "control";
  animated: boolean;
}
export interface BlueprintGraph {
  blueprintId: string;
  revision: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SimulationView {
  scenarioId: string;
  verdict: string;
  reasonCode: string;
  outcome: string;
  stoppedAt: string;
  passed: boolean;
  stale: boolean;
  blueprintRevision: number;
  buildRevision: number;
  stages: Array<{ stage: string; status: string; detail: string; reason?: string }>;
  assertions: Array<{ id: string; statement: string; held: boolean; detail: string }>;
  timeline: Array<{ t: number; label: string }>;
}

export interface BuildView {
  build: {
    id: string;
    projectId: string;
    stage: string;
    status: string;
    buildRevision: number;
    blueprintRevision: number | null;
    repairCycles: number;
    approvedAt: string | null;
    failureReason: string | null;
  };
  blueprint: Record<string, unknown> | null;
  graph: BlueprintGraph | null;
  simulations: SimulationView[];
  staleSimulations: number;
  codeStale: boolean;
  files: Array<{ path: string; bytes: number; buildRevision: number }>;
  findings: Array<{ code: string; severity: string; path: string; message: string; source: string }>;
  tests: Array<{ suite: string; passed: number; failed: number; buildRevision: number }>;
  score: {
    total: number;
    max: number;
    band: string;
    criticalOutstanding: number;
    categories: Array<{ id: string; label: string; points: number; max: number; reasons: string[]; missing: string[] }>;
  } | null;
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    simulations: number;
    userSimulations: number;
    mandatorySimulations: number;
    generatedFiles: number;
    estimatedCostUsd: number | null;
    peakFraction: number;
    warned: boolean;
    limits: Record<string, number>;
  };
}


/* ─────────────────────── organizations ─────────────────────── */

export interface OrgGraphNode {
  id: string;
  kind: string;
  label: string;
  sublabel?: string;
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
  kind: "resource" | "message" | "namespace";
  animated: boolean;
}
export interface OrgGraph {
  orgId: string;
  revision: number;
  nodes: OrgGraphNode[];
  edges: OrgGraphEdge[];
}
export interface BlastRadius {
  compromisedAgentId: string;
  directCapabilities: string[];
  maxAutonomousUsdCents: number | null;
  maxWindowUsdCents: number | null;
  authorityReachesAgents: Array<{ agentId: string; via: string }>;
  canMessageAgents: string[];
  containedBy: string[];
}
export interface OrgView {
  id: string;
  buildable: boolean;
  organization: { orgId: string; rootEns: string; agents: Array<{ id: string; displayName: string; ensName: string; executionCapabilities: string[]; autonomousMaxUsdCents: number | null; escalationMaxUsdCents: number | null }> };
  /** Builds started for members, by member id. */
  memberBuilds?: Record<string, { buildId: string; projectId: string; stage: string; status: string }>;
  issues: Array<{ code: string; severity: string; path: string; message: string; remediation: string }>;
  graph: OrgGraph;
  scenarios: Array<{ id: string; title: string; probes: string; expected: { outcome: string; reasonCode: string | null } }>;
  blastRadii: BlastRadius[];
}

const j = async (r: Response) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};

export const api = {
  health: () => fetch("/api/studio/health").then(j),
  createBuild: (prompt: string, idempotencyKey: string, ensName?: string) =>
    fetch("/api/studio/builds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, idempotencyKey, ...(ensName ? { ensName } : {}) }),
    }).then(j),
  design: (id: string) => fetch(`/api/studio/builds/${id}/design`, { method: "POST" }).then(j),
  approve: (id: string, acknowledgeFindings: string[]) =>
    fetch(`/api/studio/builds/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acknowledgeFindings }),
    }).then(j),
  build: (id: string) => fetch(`/api/studio/builds/${id}/build`, { method: "POST" }).then(j),
  abandon: (id: string, reason: string) =>
    fetch(`/api/studio/builds/${id}/abandon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    }).then(j),
  get: (id: string): Promise<BuildView> => fetch(`/api/studio/builds/${id}`).then(j),
  file: (id: string, path: string) => fetch(`/api/studio/builds/${id}/files/${path}`).then((r) => r.text()),
  exportBundle: (id: string) => fetch(`/api/studio/builds/${id}/export`).then(j),
  createOrganization: (prompt: string, rootEns: string): Promise<OrgView> =>
    fetch("/api/studio/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, rootEns }),
    }).then(j),
  organization: (id: string): Promise<OrgView> => fetch(`/api/studio/organizations/${id}`).then(j),
  buildMember: (orgId: string, agentId: string): Promise<{ build: { id: string; projectId: string }; prompt: string }> =>
    fetch(`/api/studio/organizations/${orgId}/agents/${encodeURIComponent(agentId)}/build`, { method: "POST" }).then(j),
};

/**
 * Subscribe to the build's event stream.
 *
 * `afterSeq` is persisted in sessionStorage so a reconnect resumes rather than replaying from the
 * beginning. The build does not care whether anyone is listening.
 */
export function subscribe(buildId: string, onEvent: (type: string, payload: unknown, seq: number) => void): () => void {
  const key = `studio:seq:${buildId}`;
  const after = Number(sessionStorage.getItem(key) ?? 0);
  const es = new EventSource(`/api/studio/builds/${buildId}/events?afterSeq=${after}`);
  const handler = (e: MessageEvent) => {
    const seq = Number((e as MessageEvent & { lastEventId: string }).lastEventId || 0);
    if (seq) sessionStorage.setItem(key, String(seq));
    let payload: unknown = {};
    try {
      payload = JSON.parse(e.data);
    } catch {
      /* keep-alive comments are not events */
    }
    onEvent(e.type, payload, seq);
  };
  // The server names every event, so each type is subscribed explicitly rather than relying on a
  // default `message` handler that would never fire.
  for (const t of [
    "build.created", "requirements.started", "requirements.completed",
    "blueprint.started", "blueprint.updated", "blueprint.completed",
    "security.started", "security.finding", "security.completed",
    "approval.requested", "approval.granted",
    "code.started", "code.file.created", "code.file.updated", "code.file.deleted",
    "test.started", "test.passed", "test.failed",
    "repair.started", "repair.completed",
    "simulation.started", "simulation.step", "simulation.completed",
    "usage.updated", "usage.warning",
    "build.completed", "build.failed", "build.paused", "build.limit_reached",
  ]) {
    es.addEventListener(t, handler as EventListener);
  }
  return () => es.close();
}
