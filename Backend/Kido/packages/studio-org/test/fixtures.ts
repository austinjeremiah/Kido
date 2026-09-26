import type { Organization, OrgAgent } from "../src/schema.js";

const agent = (o: Partial<OrgAgent> & Pick<OrgAgent, "id" | "ensLabel">): OrgAgent => ({
  displayName: o.id,
  ensName: `${o.ensLabel}.agents.acme.eth`,
  executionClass: "EXECUTE",
  executionCapabilities: ["aave-v3-execution:REPAY"],
  dataCapabilities: ["aave-v3-state:position"],
  autonomousMaxUsdCents: 50_000,
  escalationMaxUsdCents: 100_000,
  dailyMaxUsdCents: 75_000,
  deniedActions: [],
  executionDomain: `domain:${o.id}`,
  policyId: `policy-${o.id}`,
  ...o,
});

/**
 * The canonical treasury department: a guardian that repays debt, a rebalancer that swaps, and a
 * reporter that may only read. Per-agent daily caps sum to 150_000; the aggregate is 125_000, so
 * the organization cap genuinely binds rather than decorating.
 */
export const treasuryOrg = (): Organization => ({
  schemaVersion: "contextlock.organization/v1",
  orgId: "org-acme-treasury",
  revision: 1,
  rootEns: "acme.eth",
  agentNamespace: "agents.acme.eth",
  agents: [
    agent({ id: "guardian", ensLabel: "guardian", displayName: "Health Guardian" }),
    agent({
      id: "rebalancer",
      ensLabel: "rebalancer",
      displayName: "Rebalancer",
      executionCapabilities: ["uniswap-execution:SWAP"],
      autonomousMaxUsdCents: 25_000,
      escalationMaxUsdCents: 60_000,
      dailyMaxUsdCents: 75_000,
    }),
    agent({
      id: "reporter",
      ensLabel: "reporter",
      displayName: "Reporter",
      executionClass: "NONE",
      executionCapabilities: [],
      dataCapabilities: ["aave-v3-state:position", "thegraph:positions"],
      autonomousMaxUsdCents: null,
      escalationMaxUsdCents: null,
      dailyMaxUsdCents: null,
    }),
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
});

export const clone = (o: Organization): Organization => JSON.parse(JSON.stringify(o)) as Organization;

/**
 * A variant for the cross-process race: per-agent caps deliberately generous so that the ORG-wide
 * aggregate is unambiguously the limit being tested. Six reservations of 30_000 are attempted
 * against 125_000, so exactly four fit.
 */
export const raceOrg = (): Organization => {
  const o = treasuryOrg();
  for (const a of o.agents) {
    if (a.executionClass !== "EXECUTE") continue;
    a.autonomousMaxUsdCents = 50_000;
    a.escalationMaxUsdCents = 50_000;
    a.dailyMaxUsdCents = 500_000;
  }
  o.orgId = "org-race";
  return o;
};
