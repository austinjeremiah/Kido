import type { BlueprintGraph, NodeState } from "./api";
import type { OverviewData } from "./views/Overview";

/**
 * Runtime status, overlaid on the canonical architecture graph (§P28.7).
 *
 * > When active, overlay runtime status on same graph.
 * > Do not create another independently authored graph.
 *
 * So this produces a state per node id for the graph the Blueprint already drew, rather than a
 * second picture with its own layout that could disagree about what the agent is made of.
 *
 * One rule decides every mapping below: **an unobserved component is never green.** A node with no
 * corresponding reading stays `PENDING`, and a reading that is no longer current becomes `WARN`
 * regardless of what it said — the same rule the Overview panels follow, for the same reason. A
 * graph that painted a component healthy because nothing had contradicted it would be the exact
 * failure the control plane exists to prevent.
 */

/** A reading's state, with staleness taking precedence over the value. */
const fromFreshness = (
  reading: { isCurrent: boolean } | null | undefined,
  whenCurrent: NodeState,
): NodeState => {
  if (!reading) return "PENDING";
  return reading.isCurrent ? whenCurrent : "WARN";
};

const RUNTIME_STATE: Record<string, NodeState> = {
  HEALTHY: "RUNNING",
  RUNNING: "RUNNING",
  STARTING: "GENERATING",
  PAUSED: "WARN",
  STOPPED: "WARN",
  UNHEALTHY: "FAIL",
  FAILED: "FAIL",
  MISSING: "PENDING",
};

const CRE_STATE: Record<string, NodeState> = {
  HEALTHY: "RUNNING",
  SIMULATING: "RUNNING",
  SIMULATOR_HEALTHY: "RUNNING",
  NOT_DEPLOYED: "READY",
  BLOCKED: "BLOCKED",
  UNAVAILABLE: "FAIL",
  PAUSED: "WARN",
};

export function runtimeNodeStates(graph: BlueprintGraph | null, overview: OverviewData | null): Record<string, NodeState> {
  if (!graph || !overview) return {};
  const p = overview.panels;
  const adapters = new Map(p.adapters.map((a) => [a.adapterId, a.state]));

  const states: Record<string, NodeState> = {};
  for (const node of graph.nodes) {
    switch (node.kind) {
      case "PrivatePolicy":
        /*
         * The policy is the only node whose colour reports financial authority, so its value
         * matters as well as its freshness: enabled is RUNNING, disabled is READY — deployed and
         * inert. Neither is a problem, and a stale reading of either is.
         */
        states[node.id] = p.policy === null
          ? "PENDING"
          : fromFreshness(p.policy, p.policy.value?.enabled ? "RUNNING" : "READY");
        break;

      case "Agent":
      case "Broker":
        states[node.id] = RUNTIME_STATE[p.runtime.state] ?? "PENDING";
        break;

      case "CreWorkflow":
        states[node.id] = CRE_STATE[p.cre.state] ?? "PENDING";
        break;

      case "EnsIdentity":
        states[node.id] = p.identity === null
          ? "PENDING"
          : p.identity.value?.revoked === true
            ? "FAIL"
            : fromFreshness(p.identity, "RUNNING");
        break;

      case "Adapter":
      case "DataSource": {
        const state = adapters.get(node.id) ?? adapters.get(node.label);
        states[node.id] = state === undefined
          ? "PENDING"
          : state === "HEALTHY"
            ? "RUNNING"
            : state === "BLOCKED"
              ? "BLOCKED"
              : state === "DEGRADED"
                ? "WARN"
                : "FAIL";
        break;
      }

      default:
        // Deliberately not a default of PASS. Nothing observed this node, so nothing is claimed.
        states[node.id] = "PENDING";
    }
  }

  /*
   * Drift is a property of the deployment, not of one node, and it lands on whichever node it
   * names. A drift finding with nothing to attach to would otherwise be invisible on this screen.
   */
  for (const d of overview.drift) {
    if (states[d.subject] !== undefined && d.severity !== "INFO") {
      states[d.subject] = d.severity === "CRITICAL" ? "FAIL" : "WARN";
    }
  }

  return states;
}
