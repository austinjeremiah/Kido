import type { Organization, OrgAgent } from "./schema.js";

/**
 * Blast radius of one compromised agent.
 *
 * The question a user actually wants answered is "if this one is taken, what is gone?" — and the
 * honest answer distinguishes two things that look similar on a diagram: authority the attacker
 * now holds, and agents it can merely talk to. Talking is influence. It is not authority, because
 * a recipient still has to pass its own policy.
 *
 * The radius widens only through concrete sharing: a shared policy, a shared execution domain, or
 * a shared credential. Each of those is a CRITICAL validator finding for exactly this reason.
 */

export interface BlastRadius {
  compromisedAgentId: string;
  /** Capabilities the attacker can now exercise directly. */
  directCapabilities: string[];
  /** Worst-case value reachable before any further approval, in USD cents. Null when unknown. */
  maxAutonomousUsdCents: number | null;
  /** Worst case over a full aggregate window, bounded by whichever cap binds first. */
  maxWindowUsdCents: number | null;
  /** Agents whose authority the attacker also obtains, and why. */
  authorityReachesAgents: Array<{ agentId: string; via: "SHARED_POLICY" | "SHARED_DOMAIN" | "SHARED_CREDENTIAL" }>;
  /** Agents it can send messages to. Influence only — recorded separately on purpose. */
  canMessageAgents: string[];
  /** Things the attacker still cannot do, stated positively so the containment is legible. */
  containedBy: string[];
}

const bindingWindowCap = (org: Organization, agent: OrgAgent): number | null => {
  const agg = [...org.aggregateLimits].sort((a, b) => a.maxUsdCents - b.maxUsdCents)[0];
  const daily = agent.dailyMaxUsdCents;
  if (daily === null) return agg ? agg.maxUsdCents : null;
  return agg ? Math.min(daily, agg.maxUsdCents) : daily;
};

export function computeBlastRadius(org: Organization, compromisedAgentId: string): BlastRadius {
  const agent = org.agents.find((a) => a.id === compromisedAgentId);
  if (!agent) throw new Error(`ORG-BLAST-UNKNOWN-AGENT: ${compromisedAgentId}`);

  const reaches: BlastRadius["authorityReachesAgents"] = [];
  for (const other of org.agents) {
    if (other.id === agent.id) continue;
    if (other.policyId === agent.policyId) reaches.push({ agentId: other.id, via: "SHARED_POLICY" });
    else if (other.executionDomain === agent.executionDomain) reaches.push({ agentId: other.id, via: "SHARED_DOMAIN" });
  }
  for (const r of org.sharedResources) {
    if (r.kind !== "credential") continue;
    if (!r.agentIds.includes(agent.id)) continue;
    for (const other of r.agentIds) {
      if (other === agent.id) continue;
      if (!reaches.some((x) => x.agentId === other)) reaches.push({ agentId: other, via: "SHARED_CREDENTIAL" });
    }
  }

  const contained: string[] = [];
  if (agent.executionClass !== "EXECUTE") {
    contained.push("Agent holds no execution capability, so no value can move through it.");
  }
  if (reaches.length === 0) {
    contained.push("No other agent shares its policy, execution domain, or credentials.");
  }
  if (org.aggregateLimits.length > 0) {
    const agg = [...org.aggregateLimits].sort((a, b) => a.maxUsdCents - b.maxUsdCents)[0]!;
    contained.push(
      `Organization aggregate cap of ${agg.maxUsdCents} cents per ${agg.windowMs} ms bounds total loss regardless of per-agent limits.`,
    );
  }
  contained.push("Messages it sends carry no authority; a recipient still has to pass its own policy.");
  if (!org.delegationEnabled) {
    contained.push("Delegation is not representable, so it cannot grant itself another agent's authority.");
  }

  return {
    compromisedAgentId,
    directCapabilities: agent.executionClass === "EXECUTE" ? [...agent.executionCapabilities] : [],
    maxAutonomousUsdCents: agent.executionClass === "EXECUTE" ? agent.autonomousMaxUsdCents : 0,
    maxWindowUsdCents: agent.executionClass === "EXECUTE" ? bindingWindowCap(org, agent) : 0,
    authorityReachesAgents: reaches.sort((a, b) => a.agentId.localeCompare(b.agentId)),
    canMessageAgents: org.communicationRules
      .filter((r) => r.from === agent.id)
      .map((r) => r.to)
      .sort(),
    containedBy: contained,
  };
}
