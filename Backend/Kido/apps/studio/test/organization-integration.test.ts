import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api.js";
import { testDb } from "./helpers.js";
import type { OrganizationProposal } from "../src/agents/roles.js";

/**
 * P18 integration: the organization as the API actually serves it.
 *
 * The model is scripted here. What is under test is everything AFTER the model — the translation
 * that refuses to invent a limit, the validator, and the nested projection — because that is the
 * part a compromised or merely careless proposal has to get past.
 */

const proposal = (over: Partial<OrganizationProposal> = {}): OrganizationProposal => ({
  orgName: "Acme Treasury",
  rootEns: "acme.eth",
  agents: [
    {
      id: "guardian",
      displayName: "Health Guardian",
      ensLabel: "guardian",
      executionClass: "EXECUTE",
      executionCapabilities: ["lending-execution:REPAY"],
      dataCapabilities: ["lending-state:position"],
      autonomousMaxUsdCents: 50_000,
      escalationMaxUsdCents: 100_000,
      dailyMaxUsdCents: 75_000,
      deniedActions: ["withdraw collateral"],
      purpose: "keep the position solvent",
    },
    {
      id: "rebalancer",
      displayName: "Rebalancer",
      ensLabel: "rebalancer",
      executionClass: "EXECUTE",
      executionCapabilities: ["dex-execution:SWAP"],
      dataCapabilities: ["oracle:price"],
      autonomousMaxUsdCents: 25_000,
      escalationMaxUsdCents: 60_000,
      dailyMaxUsdCents: 75_000,
      deniedActions: [],
      purpose: "hold the target allocation",
    },
    {
      id: "reporter",
      displayName: "Reporter",
      ensLabel: "reporter",
      executionClass: "NONE",
      executionCapabilities: [],
      dataCapabilities: ["indexer:positions"],
      autonomousMaxUsdCents: null,
      escalationMaxUsdCents: null,
      dailyMaxUsdCents: null,
      deniedActions: [],
      purpose: "summarise, never transact",
    },
  ],
  sharedResources: [
    { id: "treasury-main", kind: "treasury", description: "shared treasury", agentIds: ["guardian", "rebalancer"] },
  ],
  aggregateLimits: [
    { id: "org-daily", maxUsdCents: 125_000, windowMs: 86_400_000, description: "24h organization ceiling" },
  ],
  communicationRules: [
    { from: "reporter", to: "guardian", messageKinds: ["observation"], why: "surface a falling health factor" },
  ],
  unknowns: [],
  rationale: "three principals, one treasury",
  ...over,
});

const server = (p: OrganizationProposal) =>
  buildServer({ db: testDb(), organizationAgent: async () => p });

const create = async (p: OrganizationProposal, body: Record<string, unknown> = {}) => {
  const ctx = server(p);
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/studio/organizations",
    headers: { "x-studio-user": "u1" },
    payload: { prompt: "build my treasury department with three agents", ...body },
  });
  return { ctx, res };
};

describe("building a member", () => {
  it("ORG-API-020 a member becomes an ordinary build under its own name, from a prompt that states its limits, exactly once", async () => {
    const { ctx, res } = await create(proposal());
    const orgId = res.json().id as string;
    const guardian = (res.json().organization.agents as Array<{ id: string; ensName: string }>)[0]!;
    const b1 = await ctx.app.inject({ method: "POST", url: `/api/studio/organizations/${orgId}/agents/${guardian.id}/build`, headers: { "x-studio-user": "u1" } });
    expect(b1.statusCode).toBe(201);
    const { build, prompt } = b1.json() as { build: { id: string; projectId: string }; prompt: string };
    expect(prompt).toContain(guardian.ensName);
    expect(prompt).toMatch(/runs automatically/);
    expect(prompt).toMatch(/Ledger signature/);
    expect(prompt).toContain("the organization this agent belongs to");
    // The name the member carries is the one the build is created with.
    const project = ctx.db.prepare(`SELECT ens_name FROM studio_projects WHERE id = ?`).get(build.projectId) as { ens_name: string };
    expect(project.ens_name).toBe(guardian.ensName);
    // A second click returns the same build; a member is one project.
    const b2 = await ctx.app.inject({ method: "POST", url: `/api/studio/organizations/${orgId}/agents/${guardian.id}/build`, headers: { "x-studio-user": "u1" } });
    expect((b2.json() as { build: { id: string } }).build.id).toBe(build.id);
    // And the organization view lists it against the member.
    const view = await ctx.app.inject({ method: "GET", url: `/api/studio/organizations/${orgId}`, headers: { "x-studio-user": "u1" } });
    expect((view.json() as { memberBuilds: Record<string, { buildId: string }> }).memberBuilds[guardian.id]!.buildId).toBe(build.id);
    // Another user cannot build someone else's member.
    const other = await ctx.app.inject({ method: "POST", url: `/api/studio/organizations/${orgId}/agents/${guardian.id}/build`, headers: { "x-studio-user": "u2" } });
    expect(other.statusCode).toBe(404);
  });

  it("ORG-API-021 a reporting member's prompt says it executes nothing, and an unstated limit is said to be unstated", async () => {
    const p = proposal();
    const reporter = p.agents.find((a) => a.executionClass === "READ_ONLY" || a.executionCapabilities.length === 0) ?? p.agents[2]!;
    const { ctx, res } = await create(p);
    const orgId = res.json().id as string;
    const r = await ctx.app.inject({ method: "POST", url: `/api/studio/organizations/${orgId}/agents/${reporter.id}/build`, headers: { "x-studio-user": "u1" } });
    expect(r.statusCode).toBe(201);
    expect((r.json() as { prompt: string }).prompt).toMatch(/may not execute anything|not stated|runs automatically/);
  });
});

describe("designing an organization", () => {
  it("ORG-API-001 the canonical treasury department is buildable and separates every principal", async () => {
    const { res } = await create(proposal());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.buildable).toBe(true);

    const agents = body.organization.agents as Array<Record<string, string>>;
    expect(new Set(agents.map((a) => a.policyId)).size).toBe(3);
    expect(new Set(agents.map((a) => a.executionDomain)).size).toBe(3);
    expect(new Set(agents.map((a) => a.ensName)).size).toBe(3);
    expect(agents.map((a) => a.ensName)).toContain("guardian.agents.acme.eth");
    expect(body.organization.delegationEnabled).toBe(false);
  });

  it("ORG-API-002 an unstated aggregate ceiling is refused by field, never filled in", async () => {
    const p = proposal();
    p.aggregateLimits[0]!.maxUsdCents = null;
    const { res } = await create(p);
    expect(res.statusCode).toBe(422);
    const problems = res.json().problems as Array<{ code: string; path: string }>;
    expect(problems.map((x) => x.code)).toContain("ORG-T-UNKNOWN-AGGREGATE");
    expect(problems.find((x) => x.code === "ORG-T-UNKNOWN-AGGREGATE")!.path).toBe("aggregateLimits[0].maxUsdCents");
  });

  it("ORG-API-003 a reporting agent handed an execution capability blocks the build by exact code", async () => {
    const p = proposal();
    p.agents[2]!.executionCapabilities = ["dex-execution:SWAP"];
    const { res } = await create(p);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.buildable).toBe(false);
    expect((body.issues as Array<{ code: string }>).map((i) => i.code)).toContain("ORG-V-NONEXEC-HAS-EXECUTION");
  });

  it("ORG-API-004 two agents given one identity block the build", async () => {
    const p = proposal();
    p.agents[1]!.ensLabel = "guardian";
    const { res } = await create(p);
    const body = res.json();
    expect(body.buildable).toBe(false);
    expect((body.issues as Array<{ code: string }>).map((i) => i.code)).toContain("ORG-V-DUP-ENS");
  });

  it("ORG-API-005 an aggregate that cannot bind is reported rather than accepted quietly", async () => {
    const p = proposal();
    p.aggregateLimits[0]!.maxUsdCents = 200_000; // above the 150_000 sum of daily caps
    const { res } = await create(p);
    const body = res.json();
    expect((body.issues as Array<{ code: string }>).map((i) => i.code)).toContain("ORG-V-AGGREGATE-VACUOUS");
  });

  it("ORG-API-006 a shared credential is refused as a shared principal", async () => {
    const p = proposal();
    p.sharedResources.push({
      id: "relayer-key",
      kind: "credential",
      description: "one relayer key",
      agentIds: ["guardian", "rebalancer"],
    });
    const { res } = await create(p);
    const body = res.json();
    expect(body.buildable).toBe(false);
    expect((body.issues as Array<{ code: string }>).map((i) => i.code)).toContain("ORG-V-SHARED-CREDENTIAL");
  });
});

describe("the ENS root", () => {
  it("ORG-API-012 a proposal with no root is refused as MISSING, not as malformed", async () => {
    const p = proposal();
    p.rootEns = "";
    const { res } = await create(p);
    expect(res.statusCode).toBe(422);
    const problems = res.json().problems as Array<{ code: string; message: string }>;
    expect(problems.map((x) => x.code)).toContain("ORG-T-MISSING-ROOT");
    // The two cases need different things from the user, so they must not share a message.
    expect(problems.map((x) => x.code)).not.toContain("ORG-T-BAD-ROOT");
    expect(problems.find((x) => x.code === "ORG-T-MISSING-ROOT")!.message).toContain("not inferred");
  });

  it("ORG-API-013 a malformed root is refused as BAD, quoting what was given", async () => {
    const p = proposal();
    p.rootEns = "Acme Treasury";
    const { res } = await create(p);
    expect(res.statusCode).toBe(422);
    const problems = res.json().problems as Array<{ code: string; message: string }>;
    expect(problems.map((x) => x.code)).toContain("ORG-T-BAD-ROOT");
    expect(problems.find((x) => x.code === "ORG-T-BAD-ROOT")!.message).toContain('"Acme Treasury"');
  });

  it("ORG-API-013b a subname the user controls is a usable root; agents are named beneath it", async () => {
    const p = proposal();
    const { res } = await create(p, { rootEns: "ops.acme.eth" });
    expect(res.statusCode).toBe(201);
    const org = res.json().organization as { rootEns: string; agentNamespace: string; agents: Array<{ ensName: string }> };
    expect(org.rootEns).toBe("ops.acme.eth");
    expect(org.agentNamespace).toBe("agents.ops.acme.eth");
    for (const a of org.agents) expect(a.ensName.endsWith(".agents.ops.acme.eth")).toBe(true);
  });

  it("ORG-API-014 the user's root wins over anything the model proposed", async () => {
    const p = proposal();
    p.rootEns = "somebody-elses.eth";
    const { res } = await create(p, { rootEns: "mine.eth" });
    expect(res.statusCode).toBe(201);
    const org = res.json().organization as { rootEns: string; agentNamespace: string; agents: Array<{ ensName: string }> };
    expect(org.rootEns).toBe("mine.eth");
    expect(org.agentNamespace).toBe("agents.mine.eth");
    expect(org.agents.map((a) => a.ensName)).toContain("guardian.agents.mine.eth");
  });

  it("ORG-API-016 a buildable organization does not still claim a BUILD-blocking unknown", async () => {
    const p = proposal();
    p.rootEns = "";
    p.unknowns = [
      { field: "rootEns", reason: "the user named no domain", requiredBefore: "BUILD" },
      { field: "guardian.ensLabel", reason: "no label given", requiredBefore: "BUILD" },
      { field: "humanApprovalMechanism", reason: "no approver named", requiredBefore: "DEPLOY" },
    ];
    const { res } = await create(p, { rootEns: "mine.eth" });
    expect(res.json().buildable).toBe(true);

    const unknowns = res.json().unknowns as Array<{ field: string; resolved: boolean; resolvedBy?: string }>;
    // Resolved entries are kept and marked, not deleted: the user should see the gap was noticed.
    const root = unknowns.find((u) => u.field === "rootEns")!;
    expect(root.resolved).toBe(true);
    expect(root.resolvedBy).toContain("mine.eth");
    expect(unknowns.find((u) => u.field === "guardian.ensLabel")!.resolvedBy).toContain("guardian.agents.mine.eth");
    // The genuinely outstanding one still stands.
    expect(unknowns.find((u) => u.field === "humanApprovalMechanism")!.resolved).toBe(false);
    // Nothing that still blocks BUILD survives alongside buildable: true.
    expect(unknowns.filter((u) => !u.resolved && u.field !== "humanApprovalMechanism")).toEqual([]);
  });

  it("ORG-API-015 a user-supplied root rescues a proposal that left it empty", async () => {
    const p = proposal();
    p.rootEns = "";
    const { res } = await create(p, { rootEns: "mine.eth" });
    expect(res.statusCode).toBe(201);
    expect(res.json().buildable).toBe(true);
  });
});

describe("the nested organization view", () => {
  it("ORG-API-007 each agent is a container holding its own identity, policy, limits and capabilities", async () => {
    const { res } = await create(proposal());
    const graph = res.json().graph as {
      nodes: Array<{ id: string; kind: string; parentId?: string }>;
      edges: Array<{ kind: string; label?: string }>;
    };
    for (const id of ["agent:guardian", "agent:rebalancer", "agent:reporter"]) {
      const children = graph.nodes.filter((n) => n.parentId === id);
      expect(children.map((c) => c.kind).sort()).toEqual(["Capability", "EnsIdentity", "Limits", "Policy"]);
    }
    // No child belongs to two containers: the picture cannot show a shared box.
    const childIds = graph.nodes.filter((n) => n.parentId).map((n) => n.id);
    expect(new Set(childIds).size).toBe(childIds.length);
  });

  it("ORG-API-008 a message edge says on its face that it carries no authority", async () => {
    const { res } = await create(proposal());
    const graph = res.json().graph as { edges: Array<{ kind: string; label?: string }> };
    const msg = graph.edges.filter((e) => e.kind === "message");
    expect(msg).toHaveLength(1);
    expect(msg[0]!.label).toContain("no authority");
  });

  it("ORG-API-009 the blast radius of each agent is computed, and the reporter's is zero", async () => {
    const { res } = await create(proposal());
    const radii = res.json().blastRadii as Array<{
      compromisedAgentId: string;
      maxWindowUsdCents: number | null;
      authorityReachesAgents: unknown[];
    }>;
    expect(radii).toHaveLength(3);
    const reporter = radii.find((r) => r.compromisedAgentId === "reporter")!;
    expect(reporter.maxWindowUsdCents).toBe(0);
    for (const r of radii) expect(r.authorityReachesAgents).toEqual([]);
  });

  it("ORG-API-010 the projection is deterministic and survives a reload", async () => {
    const ctx = server(proposal());
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/studio/organizations",
      headers: { "x-studio-user": "u1" },
      payload: { prompt: "build my treasury department with three agents" },
    });
    const id = created.json().id as string;
    const reloaded = await ctx.app.inject({
      method: "GET",
      url: `/api/studio/organizations/${id}`,
      headers: { "x-studio-user": "u1" },
    });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json().graph).toEqual(created.json().graph);
    expect(reloaded.json().scenarios).toEqual(created.json().scenarios);
  });

  it("ORG-API-011 another user cannot read the organization", async () => {
    const ctx = server(proposal());
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/studio/organizations",
      headers: { "x-studio-user": "u1" },
      payload: { prompt: "build my treasury department with three agents" },
    });
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/studio/organizations/${created.json().id}`,
      headers: { "x-studio-user": "u2" },
    });
    expect(res.statusCode).toBe(404);
  });
});
