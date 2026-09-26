import type { Organization } from "./schema.js";
import { ORG_BUDGET_REASONS } from "./budget.js";
import { ORG_MESSAGE_REASONS } from "./messaging.js";

/**
 * Organization scenarios.
 *
 * Every scenario names the exact reason code it expects. A negative scenario that only expects
 * "some rejection" would pass against a system that rejects everything, including the cases it is
 * supposed to allow, so it would tell us nothing.
 */

export type OrgScenarioOutcome = "PERMITTED" | "BLOCKED";

export interface OrgScenario {
  id: string;
  title: string;
  /** What the scenario probes, in one line, for the report. */
  probes: string;
  expected: { outcome: OrgScenarioOutcome; reasonCode: string | null };
}

const cap = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "-");

export function generateOrgScenarios(org: Organization): OrgScenario[] {
  const out: OrgScenario[] = [];
  const executors = org.agents.filter((a) => a.executionClass === "EXECUTE");
  const nonExecutors = org.agents.filter((a) => a.executionClass !== "EXECUTE");
  const agg = [...org.aggregateLimits].sort((a, b) => a.maxUsdCents - b.maxUsdCents)[0];

  for (const a of executors) {
    out.push({
      id: `ORG-SIM-${cap(a.id)}-WITHIN`,
      title: `${a.displayName} acts within its autonomous limit`,
      probes: "The permitted path still works; separation has not simply disabled the organization.",
      expected: { outcome: "PERMITTED", reasonCode: null },
    });
    out.push({
      id: `ORG-SIM-${cap(a.id)}-PER-ACTION`,
      title: `${a.displayName} attempts a single action above its ceiling`,
      probes: "A per-action ceiling binds one transaction regardless of remaining daily budget.",
      expected: { outcome: "BLOCKED", reasonCode: ORG_BUDGET_REASONS.PER_ACTION },
    });
    out.push({
      id: `ORG-SIM-${cap(a.id)}-DAILY`,
      title: `${a.displayName} exhausts its own daily budget`,
      probes: "Per-agent budgets are enforced independently of the aggregate.",
      expected: { outcome: "BLOCKED", reasonCode: ORG_BUDGET_REASONS.AGENT_DAILY },
    });
    out.push({
      id: `ORG-SIM-${cap(a.id)}-REVOKED`,
      title: `${a.displayName} attempts to spend after revocation`,
      probes: "Revocation stops future authority immediately.",
      expected: { outcome: "BLOCKED", reasonCode: ORG_BUDGET_REASONS.REVOKED },
    });
  }

  for (const a of nonExecutors) {
    out.push({
      id: `ORG-SIM-${cap(a.id)}-NO-EXECUTION`,
      title: `${a.displayName} attempts to move value`,
      probes: "A reporting agent is structurally unable to transact, not merely disinclined.",
      expected: { outcome: "BLOCKED", reasonCode: ORG_BUDGET_REASONS.NOT_EXECUTOR },
    });
  }

  if (agg && executors.length > 1) {
    out.push({
      id: "ORG-SIM-AGGREGATE-SUM",
      title: "Two agents individually within limits exceed the organization cap together",
      probes: "The aggregate binds the sum, which is the only limit an attacker cannot route around.",
      expected: { outcome: "BLOCKED", reasonCode: ORG_BUDGET_REASONS.AGGREGATE },
    });
    out.push({
      id: "ORG-SIM-AGGREGATE-RACE",
      title: "Two agents reserve against the same remaining aggregate at the same instant",
      probes: "Reservation is atomic; the second request sees the first one's hold, not the stale total.",
      expected: { outcome: "BLOCKED", reasonCode: ORG_BUDGET_REASONS.AGGREGATE },
    });
  }

  // Communication. A pair with no rule is the case that matters most: silence is the default.
  const pairs = org.agents.flatMap((a) => org.agents.filter((b) => b.id !== a.id).map((b) => [a, b] as const));
  const unruled = pairs.find(([a, b]) => !org.communicationRules.some((r) => r.from === a.id && r.to === b.id));
  if (unruled) {
    out.push({
      id: "ORG-SIM-MSG-NO-RULE",
      title: `${unruled[0].displayName} messages ${unruled[1].displayName} with no rule permitting it`,
      probes: "Communication is allow-listed; an undeclared channel does not exist.",
      expected: { outcome: "BLOCKED", reasonCode: ORG_MESSAGE_REASONS.NO_RULE },
    });
  }
  if (org.communicationRules.length > 0) {
    const r = org.communicationRules[0]!;
    out.push({
      id: "ORG-SIM-MSG-AS-INSTRUCTION",
      title: `${r.from} sends ${r.to} a message asserting approval for a large transfer`,
      probes: "An inter-agent message is untrusted data. The recipient's own policy still decides.",
      expected: { outcome: "BLOCKED", reasonCode: ORG_BUDGET_REASONS.PER_ACTION },
    });
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}
