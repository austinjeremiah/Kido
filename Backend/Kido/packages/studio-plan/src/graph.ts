import type { ExecutionPlan, PlanStep } from "./schema.js";
import { capabilityScopeFor, stepHash } from "./hash.js";
import { dependenciesSatisfied, derivePlanState } from "./machine.js";

/**
 * Deterministic projection: ExecutionPlan → step graph.
 *
 * Grouped by chain, because the chain boundary is the thing a reader most needs to see: it is where
 * atomicity stops. Everything above the line happened on one chain and either did or did not; the
 * arrow crossing the line is a request to a protocol that will finish later, elsewhere, or never.
 *
 * The waiting edge is drawn differently from the others for that reason, and labelled with the
 * timeout, so "this is in flight" and "this is done" cannot be mistaken for each other at a glance.
 */

export interface PlanGraphNode {
  id: string;
  kind: "ChainGroup" | "Step" | "Arrival" | "Policy";
  label: string;
  sublabel?: string;
  parentId?: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  state: "PENDING" | "RUNNING" | "WAITING" | "DONE" | "FAILED" | "BLOCKED";
  detail: Array<{ label: string; value: string }>;
}

export interface PlanGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** `crosschain` is drawn distinctly: it is the edge that is not atomic. */
  kind: "sequence" | "crosschain" | "policy";
  animated: boolean;
}

export interface PlanGraph {
  planId: string;
  revision: number;
  state: string;
  nodes: PlanGraphNode[];
  edges: PlanGraphEdge[];
}

const CHAIN_W = 380;
const STEP_H = 96;
const GAP = 60;

const STATE_OF: Record<PlanStep["status"], PlanGraphNode["state"]> = {
  PENDING: "PENDING",
  AUTHORIZED: "PENDING",
  SUBMITTED: "RUNNING",
  CONFIRMED: "DONE",
  WAITING_EXTERNAL: "WAITING",
  FAILED: "FAILED",
  TIMED_OUT: "FAILED",
  SKIPPED: "BLOCKED",
};

const CHAIN_NAMES: Record<number, string> = {
  11155111: "Ethereum Sepolia",
  84532: "Base Sepolia",
  421614: "Arbitrum Sepolia",
};
const chainName = (id: number) => CHAIN_NAMES[id] ?? `chain ${id}`;

export function projectPlanGraph(plan: ExecutionPlan): PlanGraph {
  const nodes: PlanGraphNode[] = [];
  const edges: PlanGraphEdge[] = [];

  // Chains in the order the plan first touches them, so the picture reads top to bottom in time.
  const chains: number[] = [];
  for (const s of plan.steps) if (!chains.includes(s.chainId)) chains.push(s.chainId);

  chains.forEach((chainId, ci) => {
    const chainSteps = plan.steps.filter((s) => s.chainId === chainId);
    const group = `chain:${chainId}`;
    const y = ci * (STEP_H * 2 + GAP * 2);

    nodes.push({
      id: group,
      kind: "ChainGroup",
      label: chainName(chainId),
      sublabel: chainId === plan.sourceChainId ? "source chain" : "destination chain",
      position: { x: 0, y },
      size: { width: CHAIN_W, height: chainSteps.length * STEP_H + 60 },
      state: "PENDING",
      detail: [
        { label: "chainId", value: String(chainId) },
        { label: "steps", value: String(chainSteps.length) },
      ],
    });

    chainSteps.forEach((s, si) => {
      const id = `step:${s.stepId}`;
      const deps = dependenciesSatisfied(plan, s.stepId);
      nodes.push({
        id,
        kind: "Step",
        label: `${s.action}`,
        sublabel: s.stepId,
        parentId: group,
        position: { x: 20, y: 46 + si * STEP_H },
        size: { width: CHAIN_W - 40, height: STEP_H - 20 },
        state: !deps.ok && s.status === "PENDING" ? "BLOCKED" : STATE_OF[s.status],
        detail: [
          { label: "chain", value: chainName(s.chainId) },
          { label: "adapter", value: `${s.adapterId}@${s.adapterVersion}` },
          { label: "status", value: s.status },
          {
            label: "authorization",
            value:
              s.authorizationRequirement.disposition === "DENY"
                ? "DENY — no path to execution"
                : s.authorizationRequirement.disposition === "REQUIRES_HUMAN"
                  ? "requires a person"
                  : "autonomous",
          },
          {
            label: "value",
            value:
              s.authorizationRequirement.valueUsdCents === null
                ? "UNKNOWN — blocks"
                : `$${(s.authorizationRequirement.valueUsdCents / 100).toFixed(2)}`,
          },
          { label: "timeout", value: `${Math.round(s.timeoutMs / 60_000)} min` },
          { label: "step hash", value: stepHash(plan, s.stepId).slice(0, 18) + "…" },
          // Shown so a reader can see that this capability names this step and nothing else.
          { label: "capability scope", value: capabilityScopeFor(plan, s.stepId).slice(0, 46) + "…" },
          ...(deps.ok ? [] : [{ label: "waiting on", value: deps.missing.join(", ") }]),
        ],
      });

      for (const d of s.dependencies) {
        const dep = plan.steps.find((x) => x.stepId === d);
        const crossesChains = dep !== undefined && dep.chainId !== s.chainId;
        edges.push({
          id: `e:${d}->${s.stepId}`,
          source: `step:${d}`,
          target: id,
          // The label is the honest part: across a chain boundary this is a wait, not a call.
          label: crossesChains ? `waiting — up to ${Math.round(s.timeoutMs / 60_000)} min, not atomic` : "then",
          kind: crossesChains ? "crosschain" : "sequence",
          animated: dep?.status === "SUBMITTED" || dep?.status === "WAITING_EXTERNAL",
        });

        if (crossesChains) {
          // Arrival and policy are drawn as their own nodes because they are their own steps: a
          // message landing is not the same event as ContextLock permitting the next action.
          const arrival = `arrival:${s.stepId}`;
          const policy = `policy:${s.stepId}`;
          nodes.push({
            id: arrival,
            kind: "Arrival",
            label: "Arrival proof",
            sublabel: "message observed on the destination",
            position: { x: CHAIN_W + GAP, y: y + 46 },
            size: { width: 200, height: 56 },
            state: dep?.status === "CONFIRMED" ? "DONE" : "WAITING",
            detail: [
              { label: "replay", value: "one messageId, once" },
              { label: "binds", value: "planHash, stepId, source, sender, token, amount" },
            ],
          });
          nodes.push({
            id: policy,
            kind: "Policy",
            label: "ContextLock policy",
            sublabel: "re-authorizes the destination action",
            position: { x: CHAIN_W + GAP, y: y + 46 + 76 },
            size: { width: 200, height: 56 },
            state: "PENDING",
            detail: [{ label: "grants", value: "a capability for this step only" }],
          });
          edges.push({ id: `e:arr:${s.stepId}`, source: arrival, target: policy, kind: "policy", animated: false });
          edges.push({ id: `e:pol:${s.stepId}`, source: policy, target: id, label: "step capability", kind: "policy", animated: false });
        }
      }
    });
  });

  return { planId: plan.planId, revision: plan.revision, state: derivePlanState(plan), nodes, edges };
}
