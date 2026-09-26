import type { ContextLockAgentBlueprint } from "./schema.js";

/**
 * Deterministic projection: Blueprint → architecture graph.
 *
 * The model never emits coordinates, node ids or edges. It emits semantics; this function is the
 * only thing that turns semantics into a picture. That is what makes the graph *evidence* rather
 * than illustration — two runs of the same Blueprint produce byte-identical graphs, and a node
 * appearing in the picture means the Blueprint actually requires that component.
 */

export type NodeState =
  | "PENDING"
  | "GENERATING"
  | "READY"
  | "RUNNING"
  | "PASS"
  | "WARN"
  | "FAIL"
  | "BLOCKED";

export type NodeKind =
  | "Adapter"
  | "User"
  | "Agent"
  | "EnsIdentity"
  | "Broker"
  | "CreWorkflow"
  | "PrivatePolicy"
  | "DataSource"
  | "AuthorizationRegistry"
  | "Capability"
  | "LedgerKeyRing"
  | "LedgerApproval"
  | "Executor"
  | "DefiProtocol";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  sublabel?: string | undefined;
  /** Column in the flow, 0 = leftmost. Layout is computed, never modelled. */
  rank: number;
  position: { x: number; y: number };
  state: NodeState;
  /** Safe detail for the inspector panel. Never contains a confidential value. */
  detail: Array<{ label: string; value: string }>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string | undefined;
  /** Security-relevant flows are drawn differently from data flows. */
  kind: "authority" | "data" | "control";
  animated: boolean;
}

export interface BlueprintGraph {
  blueprintId: string;
  revision: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const COL_WIDTH = 260;
const ROW_HEIGHT = 130;

/** Ranks define the left-to-right story: who asks → who decides → what binds → what executes. */
const RANK: Record<NodeKind, number> = {
  User: 0,
  // Adapters sit with the other information sources, feeding the decision rather than making it.
  Adapter: 3,
  Agent: 1,
  Broker: 2,
  EnsIdentity: 3,
  CreWorkflow: 3,
  DataSource: 3,
  PrivatePolicy: 4,
  LedgerKeyRing: 4,
  AuthorizationRegistry: 5,
  LedgerApproval: 5,
  Capability: 6,
  Executor: 7,
  DefiProtocol: 8,
};

export function projectGraph(
  bp: ContextLockAgentBlueprint,
  states: Record<string, NodeState> = {},
): BlueprintGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const add = (
    id: string,
    kind: NodeKind,
    label: string,
    detail: Array<{ label: string; value: string }>,
    sublabel?: string,
  ) => {
    nodes.push({
      id,
      kind,
      label,
      sublabel,
      rank: RANK[kind],
      position: { x: 0, y: 0 },
      state: states[id] ?? "PENDING",
      detail,
    });
  };

  const edge = (
    source: string,
    target: string,
    kind: GraphEdge["kind"],
    label?: string,
  ) => {
    edges.push({ id: `${source}->${target}`, source, target, kind, label, animated: false });
  };

  /* nodes ------------------------------------------------------------------ */

  add("user", "User", "User", [
    { label: "Objective", value: bp.objective },
    { label: "Network", value: `${bp.identity.network} (${bp.identity.chainId})` },
  ]);

  add(
    "agent",
    "Agent",
    "Agent runtime",
    [
      { label: "Holds a key", value: bp.execution.agentHoldsNoKey ? "No" : "YES — invalid" },
      { label: "Submits transactions", value: "No — the relayer does" },
      { label: "Trust", value: "Untrusted by design; assumed compromised" },
    ],
    "untrusted",
  );

  add("broker", "Broker", "ContextLock Broker", [
    { label: "Role", value: "Builds exact calldata, requests evaluation, issues capabilities" },
    { label: "Capability TTL", value: `${bp.capabilityPolicy.ttlSeconds}s` },
  ]);

  add(
    "ens",
    "EnsIdentity",
    "ENSv2 identity",
    [
      { label: "Name", value: bp.identity.ensName },
      { label: "Read at", value: bp.ens.identityReadAt },
      { label: "Revocation", value: bp.ens.revocationInvalidatesOutstanding ? "Invalidates outstanding capabilities" : "—" },
      { label: "Financial roles in ENS", value: bp.ens.financialPermissionsInEns ? "YES — invalid" : "No" },
    ],
    "live",
  );

  if (bp.cre.required) {
    add(
      "cre",
      "CreWorkflow",
      "Chainlink CRE workflow",
      [
        { label: "Mode", value: bp.cre.mode },
        { label: "Confidential handler", value: bp.cre.confidentialHandler ? "Yes" : "No" },
        { label: "Verdicts", value: bp.cre.verdicts.join(" / ") },
      ],
      bp.cre.mode,
    );

    if (bp.confidentialPolicy.required) {
      add(
        "private-policy",
        "PrivatePolicy",
        "Private policy",
        [
          // Names only. The values are not in the Blueprint, so they cannot leak through the graph.
          { label: "Parameters", value: bp.confidentialPolicy.parameterNames.join(", ") },
          { label: "Values", value: "confidential — never rendered" },
          { label: "Reason codes", value: bp.confidentialPolicy.reasonCodes.join(", ") },
        ],
        "confidential",
      );
    }
  }

  /*
   * Adapter nodes are rendered from the Blueprint's bindings, generically.
   *
   * There is no branch here for Uniswap, The Graph or Chainlink — the node's label, trust class and
   * inspector fields all come from the binding and the requirement it serves. Adding a provider in a
   * later phase adds a manifest, not a case in this function.
   */
  for (const b of bp.adapters) {
    const req = bp.dataRequirements.find((r) => r.key === b.configRef);
    add(
      `adapter-${b.adapterId}-${b.configRef}`,
      "Adapter",
      b.adapterId,
      [
        { label: "Adapter", value: `${b.adapterId}@${b.adapterVersion}` },
        { label: "Role", value: b.role },
        { label: "Serves", value: b.configRef },
        ...(req
          ? [
              { label: "Data kind", value: req.kind },
              { label: "Required trust", value: req.minimumTrustClass },
              { label: "Max age", value: `${req.maxAgeMs}ms` },
              { label: "Confidential", value: req.confidential ? "yes" : "no" },
              {
                label: "Fallback",
                value: req.fallback
                  ? `${req.fallback.adapterId}@${req.fallback.adapterVersion} (max ${req.fallback.allowedTrust}, ${req.fallback.maxAgeMs}ms)`
                  : "none declared — no silent downgrade",
              },
            ]
          : []),
        { label: "Selected because", value: b.rationale || "—" },
      ],
      req?.minimumTrustClass ?? b.role,
    );
  }

  for (const cs of bp.contextSources) {
    add(
      `ctx-${cs.id}`,
      "DataSource",
      cs.dataKind,
      [
        { label: "Minimum trust", value: cs.minimumTrustClass },
        { label: "Max age", value: `${cs.maxAgeMs}ms` },
        { label: "Fallback", value: cs.fallbackAllowed ? "Allowed (declared)" : "Not allowed" },
        { label: "Placement", value: cs.placement },
      ],
      cs.minimumTrustClass,
    );
  }

  add("authreg", "AuthorizationRegistry", "Authorization registry", [
    { label: "Writer", value: "CRE consumer contract only" },
    { label: "Write policy", value: "Idempotent upsert, bound to a recomputed request hash" },
  ]);

  if (bp.ledger.keyRingRequired) {
    add(
      "keyring",
      "LedgerKeyRing",
      "Ledger Key Ring",
      [
        { label: "Purpose", value: "Broker credential, unreachable by the agent" },
        { label: "Getter", value: "None — performProtectedAction only" },
        { label: "Provisioned on device", value: "No" },
      ],
      "software only",
    );
  }

  if (bp.ledger.humanApprovalRequired) {
    add(
      "approval",
      "LedgerApproval",
      "Human approval",
      [
        { label: "Mechanism", value: bp.escalationPolicy.mechanism },
        { label: "Physical device evidence", value: "None" },
        { label: "Blocker", value: bp.ledger.blockerRef ?? "—" },
        { label: "Can override DENY", value: "No — structurally terminal" },
      ],
      bp.escalationPolicy.mechanism === "ledger-device" ? "device" : "STAND-IN",
    );
  }

  add("capability", "Capability", "EIP-712 capability", [
    { label: "Bound fields", value: bp.capabilityPolicy.bindings.join(", ") },
    { label: "TTL", value: `${bp.capabilityPolicy.ttlSeconds}s` },
    { label: "Nonce", value: bp.capabilityPolicy.nonceStrategy },
  ]);

  add("executor", "Executor", "ContextLock Executor", [
    { label: "Role", value: "Reference monitor — re-checks every input on-chain" },
    { label: "Failure mode", value: "Fails closed" },
    { label: "Chain", value: String(bp.execution.chainId) },
  ]);

  for (const p of bp.protocols) {
    add(
      `proto-${p.id}`,
      "DefiProtocol",
      p.displayName,
      [
        { label: "Kind", value: p.kind },
        { label: "Contracts", value: p.contracts.map((c) => c.role).join(", ") },
        {
          label: "Actions",
          value: bp.actions.filter((a) => a.protocolRef === p.id).map((a) => a.kind).join(", ") || "—",
        },
      ],
      p.kind,
    );
  }

  /* edges ------------------------------------------------------------------ */

  edge("user", "agent", "control", "instructs");
  edge("agent", "broker", "control", "proposes intent");
  edge("broker", "ens", "data", "who is this agent");
  if (bp.cre.required) {
    edge("broker", "cre", "control", "evaluate");
    if (bp.confidentialPolicy.required) edge("private-policy", "cre", "data", "private thresholds");
    for (const cs of bp.contextSources) {
      edge(`ctx-${cs.id}`, cs.placement === "cre-confidential" ? "cre" : "broker", "data", cs.dataKind);
    }
    for (const b of bp.adapters) {
      const req = bp.dataRequirements.find((r) => r.key === b.configRef);
      const id = `adapter-${b.adapterId}-${b.configRef}`;
      if (b.role === "EXECUTION") {
        // Execution adapters sit AFTER the executor: they construct the call the executor makes,
        // and they never feed the decision that authorized it.
        edge("executor", id, "control", "prepare + decode");
      } else {
        edge(id, req?.confidential ? "cre" : "broker", "data", req?.kind ?? b.configRef);
      }
    }
    edge("cre", "authreg", "authority", "verdict");
  }
  if (bp.ledger.keyRingRequired) edge("keyring", "broker", "data", "protected secret");
  edge("broker", "capability", "authority", "issues");
  if (bp.ledger.humanApprovalRequired) {
    edge("authreg", "approval", "control", "ESCALATE");
    edge("approval", "executor", "authority", "approval record");
  }
  edge("authreg", "executor", "authority", "verdict read on-chain");
  edge("ens", "executor", "authority", "identity read live");
  edge("capability", "executor", "authority", "signed, one transaction");
  for (const p of bp.protocols) edge("executor", `proto-${p.id}`, "control", "exact call");
  if (!bp.cre.required) {
    for (const b of bp.adapters) {
      const id = `adapter-${b.adapterId}-${b.configRef}`;
      if (b.role === "EXECUTION") edge("executor", id, "control", "prepare + decode");
      else edge(id, "broker", "data", b.configRef);
    }
  }

  /* deterministic layout --------------------------------------------------- */

  const byRank = new Map<number, GraphNode[]>();
  // Sort by id within a rank so ordering never depends on insertion or object key order.
  for (const n of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const list = byRank.get(n.rank) ?? [];
    list.push(n);
    byRank.set(n.rank, list);
  }
  for (const [rank, list] of byRank) {
    const total = list.length;
    list.forEach((n, i) => {
      n.position = {
        x: rank * COL_WIDTH,
        y: Math.round((i - (total - 1) / 2) * ROW_HEIGHT),
      };
    });
  }

  return {
    blueprintId: bp.blueprintId,
    revision: bp.revision,
    nodes: nodes.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)),
    edges: edges.filter((e) => nodes.some((n) => n.id === e.source) && nodes.some((n) => n.id === e.target)),
  };
}
