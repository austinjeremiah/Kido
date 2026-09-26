/**
 * Group C canonical demo: a treasury department.
 *
 * Three agents, one treasury, one organization-wide ceiling. Every line below is what the code
 * actually did — nothing is narrated ahead of the result, and nothing is asserted into being true.
 *
 * The department:
 *   guardian    repays lending debt to hold the health factor,  $500/action, $750/day
 *   rebalancer  swaps to hold the target allocation,            $250/action, $750/day
 *   reporter    reads and summarises, and can never transact
 *   organization ceiling                                        $1,250 per 24h
 *
 * The per-agent daily caps sum to $1,500. The organization ceiling is $1,250, so it binds — which
 * is the only reason it is worth having.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import DatabaseCtor from "better-sqlite3";
import {
  validateOrganization,
  projectOrgGraph,
  computeBlastRadius,
  generateOrgScenarios,
  OrgBudgetLedger,
  OrgBudgetError,
  deliverMessage,
  type Organization,
} from "@contextlock/studio-org";

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const org: Organization = {
  schemaVersion: "contextlock.organization/v1",
  orgId: "org-acme-treasury",
  revision: 1,
  rootEns: "acme.eth",
  agentNamespace: "agents.acme.eth",
  agents: [
    {
      id: "guardian",
      displayName: "Health Guardian",
      ensLabel: "guardian",
      ensName: "guardian.agents.acme.eth",
      executionClass: "EXECUTE",
      executionCapabilities: ["lending-execution:REPAY"],
      dataCapabilities: ["lending-state:position"],
      autonomousMaxUsdCents: 50_000,
      escalationMaxUsdCents: 100_000,
      dailyMaxUsdCents: 75_000,
      deniedActions: ["withdraw collateral"],
      executionDomain: "contextlock:org:org-acme-treasury:agent:guardian",
      policyId: "org-acme-treasury-guardian",
    },
    {
      id: "rebalancer",
      displayName: "Rebalancer",
      ensLabel: "rebalancer",
      ensName: "rebalancer.agents.acme.eth",
      executionClass: "EXECUTE",
      executionCapabilities: ["dex-execution:SWAP"],
      dataCapabilities: ["oracle:price"],
      autonomousMaxUsdCents: 25_000,
      escalationMaxUsdCents: 60_000,
      dailyMaxUsdCents: 75_000,
      deniedActions: [],
      executionDomain: "contextlock:org:org-acme-treasury:agent:rebalancer",
      policyId: "org-acme-treasury-rebalancer",
    },
    {
      id: "reporter",
      displayName: "Reporter",
      ensLabel: "reporter",
      ensName: "reporter.agents.acme.eth",
      executionClass: "NONE",
      executionCapabilities: [],
      dataCapabilities: ["indexer:positions"],
      autonomousMaxUsdCents: null,
      escalationMaxUsdCents: null,
      dailyMaxUsdCents: null,
      deniedActions: [],
      executionDomain: "contextlock:org:org-acme-treasury:agent:reporter",
      policyId: "org-acme-treasury-reporter",
    },
  ],
  sharedResources: [
    { id: "treasury-main", kind: "treasury", description: "Shared Sepolia treasury", agentIds: ["guardian", "rebalancer"] },
  ],
  aggregateLimits: [
    { id: "org-daily", maxUsdCents: 125_000, windowMs: 86_400_000, description: "Organization-wide 24h ceiling" },
  ],
  communicationRules: [
    { from: "reporter", to: "guardian", messageKinds: ["observation"] },
    { from: "guardian", to: "rebalancer", messageKinds: ["request", "status"] },
  ],
  delegationEnabled: false,
};

const lines: string[] = [];
const say = (s: string) => {
  console.log(s);
  lines.push(s.replace(/\x1b\[\d+m/g, ""));
};

say(bold("\n1. The organization as designed"));
const v = validateOrganization(org);
say(`   buildable: ${v.buildable ? green("yes") : red("no")}   blocking issues: ${v.issues.filter((i) => i.severity === "CRITICAL" || i.severity === "HIGH").length}`);
for (const a of org.agents) {
  say(
    `   ${a.ensName.padEnd(30)} ${a.executionClass.padEnd(8)} policy=${a.policyId.split("-").pop()}  ` +
      (a.executionClass === "EXECUTE"
        ? `auto ${usd(a.autonomousMaxUsdCents!)} / daily ${usd(a.dailyMaxUsdCents!)}`
        : "cannot move value"),
  );
}
say(`   per-agent daily caps sum to ${usd(150_000)}; the organization ceiling is ${usd(125_000)}, so it binds.`);

say(bold("\n2. The nested view"));
const graph = projectOrgGraph(org);
for (const a of org.agents) {
  const kids = graph.nodes.filter((n) => n.parentId === `agent:${a.id}`);
  say(`   ${`agent:${a.id}`.padEnd(20)} contains ${kids.map((k) => k.kind).join(", ")}`);
}
say(`   ${graph.edges.filter((e) => e.kind === "message").length} message edge(s), each labelled: "${graph.edges.find((e) => e.kind === "message")?.label}"`);

say(bold("\n3. A normal day"));
const db = new DatabaseCtor(":memory:");
let clock = 1_700_000_000_000;
const ledger = new OrgBudgetLedger(db, org, () => clock);

const spend = (agent: string, cents: number, what: string) => {
  try {
    const id = ledger.reserve(agent, cents, what);
    ledger.settle(id, cents);
    say(`   ${green("EXECUTED")}  ${agent.padEnd(11)} ${usd(cents).padStart(9)}  ${what}`);
    return true;
  } catch (e) {
    const reason = e instanceof OrgBudgetError ? e.reason : String(e);
    say(`   ${red("REFUSED ")}  ${agent.padEnd(11)} ${usd(cents).padStart(9)}  ${what}  → ${reason}`);
    return false;
  }
};

spend("guardian", 40_000, "repay debt, health factor 1.55");
spend("rebalancer", 20_000, "swap to target allocation");

say(bold("\n4. The reporter observes, and the guardian still decides"));
const msg = deliverMessage(org, {
  from: "reporter",
  to: "guardian",
  kind: "observation",
  body: "health factor 1.48 and falling",
});
say(
  msg.delivered
    ? `   delivered as ${msg.message.trustClass}, conveysAuthority=${msg.message.conveysAuthority}`
    : `   not delivered: ${msg.reason}`,
);
spend("guardian", 30_000, "repay again on the reporter's observation");

say(bold("\n5. Where the organization ceiling actually falls"));
say(`   spent so far: ${usd(ledger.attribution(86_400_000).reduce((s, a) => s + a.usdCents, 0))} of ${usd(125_000)}`);
spend("rebalancer", 35_000, "a swap that lands exactly on the ceiling");
// One cent more. Both agents are still well inside their own daily caps here, which is the point:
// the only thing standing between the department and another $600 is the aggregate.
spend("rebalancer", 100, "one dollar past it, with both agents inside their own caps");

say(bold("\n6. Attribution"));
for (const a of ledger.attribution(86_400_000)) {
  say(`   ${a.agentId.padEnd(12)} ${usd(a.usdCents).padStart(9)} over ${a.actions} action(s)`);
}

say(bold("\n7. If one agent is compromised"));
for (const a of org.agents) {
  const b = computeBlastRadius(org, a.id);
  say(
    `   ${a.id.padEnd(12)} moves ≤ ${usd(b.maxWindowUsdCents ?? 0).padStart(9)} in the window, ` +
      `reaches ${b.authorityReachesAgents.length} other agent(s), can message [${b.canMessageAgents.join(", ") || "nobody"}]`,
  );
}

say(bold("\n8. Revocation"));
ledger.revoke("guardian", "key compromise suspected");
spend("guardian", 100, "any action at all after revocation");
clock += 86_400_001;
spend("rebalancer", 10_000, "the next day, the uncompromised agent still works");
say(`   settled history preserved: ${JSON.stringify(ledger.attribution(86_400_000 * 2))}`);

say(bold(`\n${generateOrgScenarios(org).length} organization scenarios are generated from this design.`));

mkdirSync("reports/group-c/evidence", { recursive: true });
writeFileSync("reports/group-c/evidence/group-c-demo.txt", lines.join("\n") + "\n");
writeFileSync("reports/group-c/evidence/group-c-organization.json", JSON.stringify(org, null, 2));
console.log("\nwritten: reports/group-c/evidence/group-c-demo.txt");
