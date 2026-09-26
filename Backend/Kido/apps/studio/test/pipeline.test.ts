import { describe, it, expect, vi } from "vitest";

/**
 * The Agents SDK is replaced for the maxTurns assertion below. Every other suite drives the
 * pipeline through scripted agents, and the real model is exercised by the end-to-end demo whose
 * output is recorded as evidence -- so nothing here depends on this mock being faithful beyond the
 * one property it is used to check.
 */
vi.mock("@openai/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openai/agents")>();
  return {
    ...actual,
    run: vi.fn(async () => ({
      finalOutput: { ok: true },
      state: { usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    })),
  };
});
import { buildServer } from "../src/api.js";
import { StudioPipeline } from "../src/pipeline.js";
import { StudioEventBus } from "../src/events.js";
import { QuotaManager, QuotaExceededError } from "../src/quota.js";
import { DEFAULT_QUOTA } from "../src/config.js";
import { testDb, scriptedAgents, RecordingSandbox } from "./helpers.js";
import type { ArchitectureChoice } from "../src/agents/roles.js";
import { registerSandboxProvider, getSandboxProvider, SandboxProviderUnavailableError, type StudioSandbox, type StudioSandboxProvider } from "../src/sandbox/provider.js";
import { validateBlueprint } from "@contextlock/studio-blueprint";

const okExec = (cmd: string) =>
  cmd.includes("vitest") ? { stdout: "Tests  7 passed (7)", exitCode: 0 } : { stdout: "", exitCode: 0 };

function provider(sandbox: RecordingSandbox, id: string) {
  class P implements StudioSandboxProvider {
    readonly id = id;
    async create(): Promise<StudioSandbox> { return sandbox as unknown as StudioSandbox; }
    async resume(): Promise<StudioSandbox> { return sandbox as unknown as StudioSandbox; }
    async snapshot() { return "s"; }
    async destroy() {}
  }
  registerSandboxProvider(id, () => new P());
  return id;
}

function harness(opts: { agents?: ReturnType<typeof scriptedAgents>; exec?: (c: string) => { stdout: string; exitCode: number }; id?: string } = {}) {
  const db = testDb();
  const bus = new StudioEventBus(db);
  const quota = new QuotaManager(db, DEFAULT_QUOTA);
  const sandbox = new RecordingSandbox(opts.exec ?? okExec);
  const pid = provider(sandbox, opts.id ?? `rec_${Math.random().toString(36).slice(2, 8)}`);
  const pipeline = new StudioPipeline({ db, bus, quota, agents: opts.agents ?? scriptedAgents(), sandboxProviderId: pid });
  return { db, bus, quota, pipeline, sandbox };
}

async function designed(h: ReturnType<typeof harness>, prompt = "Aave guardian, repay up to $1,000, never withdraw collateral, $1,000-$5,000 needs a human.") {
  const b = h.pipeline.createBuild({ userId: "u1", prompt });
  const r = await h.pipeline.runToApproval(b.id);
  return { id: b.id, ...r };
}

/* ─────────────────────────────── STUDIO-001..003 ──────────────────────────── */

describe("STUDIO-001 natural language → valid requirements", () => {
  it("produces a Blueprint whose limits are quoted from the user's own words", async () => {
    const h = harness();
    const { blueprint } = await designed(h);
    const auto = blueprint.autonomousPolicy.maxValueUsdCents;
    expect(auto.known).toBe(true);
    if (auto.known) {
      expect(auto.value).toBe(100_000);
      expect(auto.sourceQuote).toMatch(/\$1,000/);
    }
  });
});

describe("STUDIO-001b the agent's ENS name is the user's, when they gave one", () => {
  it("a supplied name is used verbatim and the agent id is its first label; without one, the placeholder says so", async () => {
    const h = harness();
    const named = h.pipeline.createBuild({ userId: "u1", prompt: "Aave guardian, repay up to $1,000, never withdraw collateral, $1,000-$5,000 needs a human.", ensName: "guardian.ops.acme.eth" });
    const { blueprint } = await h.pipeline.runToApproval(named.id);
    expect(blueprint.identity.ensName).toBe("guardian.ops.acme.eth");
    expect(blueprint.identity.agentId).toBe("guardian");

    const unnamed = await designed(harness());
    // Whatever the scripted architect proposes, the name is never the template's own.
    expect(unnamed.blueprint.identity.ensName).not.toBe("guardian.contextlock.eth");
    expect(unnamed.blueprint.identity.agentId).toBe(unnamed.blueprint.identity.ensName.split(".")[0]);
  });

  it("the create route refuses a name that is not a lowercase .eth name", async () => {
    const ctx = buildServer({ db: testDb(), agents: scriptedAgents(), sandboxProviderId: provider(new RecordingSandbox(okExec), "rec_ens") });
    const res = await ctx.app.inject({ method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "u" }, payload: { prompt: "Aave guardian, repay up to $1,000.", ensName: "Guardian.ETH" } });
    expect(res.statusCode).toBe(422);
  });
});

describe("STUDIO-001c an agent is assembled from the protocol catalogue, not from one template", () => {
  const arch = (over: Partial<ArchitectureChoice>) =>
    scriptedAgents({ architecture: {
      agentId: "x", ensName: "x.test.eth", objective: "test",
      requiredModules: ["contextlock-core", "ens-identity", "cre-confidential-policy", "ledger-keyring", "ledger-escalation", "protocol-adapter", "agent-runtime", "tests"],
      allowedPermissions: [], deniedPermissions: ["withdraw collateral", "arbitrary transfer", "arbitrary token approval"],
      confidentialParameterNames: ["healthFactorFloorBps"], capabilityTtlSeconds: 45, dataRequirements: [], requiredExecutionCapabilities: [], rationale: "test",
      ...over,
    } });

  it("a Morpho permission yields a Morpho Blueprint: the singleton, the Morpho position read, the Morpho adapter module, and the lending scenarios", async () => {
    const h = harness({ agents: arch({ allowedPermissions: [{ statement: "repay Morpho debt", actionRef: "morpho-repay" }], requiredExecutionCapabilities: ["MORPHO_REPAY"] }) });
    const { blueprint } = await designed(h, "Guard my Morpho Blue position: repay up to $1,000 automatically, never withdraw collateral, $1,000-$5,000 needs a human.");
    expect(blueprint.protocols.map((p) => p.id)).toEqual(["morpho"]);
    expect(blueprint.actions.map((a) => a.kind)).toEqual(["MORPHO_REPAY"]);
    expect(blueprint.dataRequirements.map((d) => d.kind)).toContain("morpho_position_health_factor");
    expect(blueprint.generatedModules.find((m) => m.kind === "protocol-adapter")!.path).toBe("src/adapters/morpho.ts");
    expect(blueprint.simulationScenarios.map((s) => s.scenarioId)).toContain("HEALTH_FACTOR_DROP");
    // The Morpho execution adapter is bound, not Aave's.
    expect(blueprint.adapters.map((a) => a.adapterId)).toContain("morpho-blue-execution");
    expect(blueprint.adapters.map((a) => a.adapterId)).not.toContain("aave-v3-execution");
  });

  it("a Lido stake yields a staking Blueprint with no lending scenarios and no token approval", async () => {
    const h = harness({ agents: arch({ allowedPermissions: [{ statement: "stake idle ETH", actionRef: "stake-eth" }], requiredExecutionCapabilities: ["LIDO_STAKE"] }) });
    const { blueprint } = await designed(h, "Stake my idle ETH with Lido, up to 1 ETH a day automatically, never move stETH out, above 1 ETH needs a human.");
    expect(blueprint.protocols.map((p) => p.kind)).toEqual(["staking"]);
    expect(blueprint.actions[0]!.kind).toBe("LIDO_STAKE");
    expect(blueprint.actions[0]!.approvals).toEqual([]);
    expect(blueprint.simulationScenarios.map((s) => s.scenarioId)).not.toContain("HEALTH_FACTOR_DROP");
    expect(blueprint.adapters.map((a) => a.adapterId)).toContain("lido-execution");
  });

  it("several protocols in one agent: each protocol's contracts, assets and reads are present once", async () => {
    const h = harness({ agents: arch({
      allowedPermissions: [
        { statement: "repay Aave debt", actionRef: "repay-debt" }, { statement: "repay Compound debt", actionRef: "compound-repay" },
        { statement: "add Morpho collateral", actionRef: "morpho-supply-collateral" }, { statement: "stake ETH", actionRef: "stake-eth" }, { statement: "rebalance", actionRef: "swap-tokens" },
      ],
      requiredExecutionCapabilities: ["REPAY", "COMPOUND_REPAY", "MORPHO_SUPPLY_COLLATERAL", "LIDO_STAKE", "TOKEN_SWAP"],
    }) });
    const { blueprint } = await designed(h, "A treasury agent across Aave, Compound, Morpho, Lido and Uniswap; up to $1,000 automatically, $1,000-$5,000 needs a human, never withdraw.");
    expect(blueprint.protocols.map((p) => p.id).sort()).toEqual(["aave", "compound", "dex-router", "lido", "morpho"]);
    expect(blueprint.actions.map((a) => a.kind).sort()).toEqual(["AAVE_REPAY", "COMPOUND_REPAY", "LIDO_STAKE", "MORPHO_SUPPLY_COLLATERAL", "TOKEN_SWAP"]);
    expect(blueprint.assets.map((a) => a.symbol).sort()).toEqual(["ETH", "USDC", "WETH"]);
    const keys = blueprint.dataRequirements.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    const bound = blueprint.adapters.map((a) => a.adapterId);
    for (const id of ["aave-v3-execution", "compound-v3-execution", "morpho-blue-execution", "lido-execution", "uniswap-universal-router"]) expect(bound, id).toContain(id);
  });

  it("a permission naming an action the catalogue does not offer activates nothing", async () => {
    const h = harness({ agents: arch({ allowedPermissions: [{ statement: "supply to Spark", actionRef: "spark-supply" }] }) });
    const { blueprint } = await designed(h, "Supply to Spark up to $1,000 automatically, $1,000-$5,000 needs a human, never withdraw.");
    // No active action: the skeleton's defaults remain so the Blueprint validates and the review can say what is missing.
    expect(blueprint.autonomousPolicy.allowedActionRefs).toEqual([]);
  });
});

describe("STUDIO-003 an unknown critical field is not silently invented", () => {
  it("an unstated autonomous limit stays UNKNOWN and blocks the build", async () => {
    const agents = scriptedAgents({
      requirements: {
        ...scriptedAgents().requirements, // placeholder, replaced below
      } as never,
    });
    const h = harness({
      agents: scriptedAgents({
        requirements: {
          objective: "Keep me safe.",
          protocols: ["Aave"], assets: ["USDC"],
          allowedActions: ["repay debt"], forbiddenActions: [],
          autonomousLimitUsd: { known: false, reason: "The user never stated a limit.", requiredBefore: "BUILD" },
          escalationFloorUsd: { known: false, reason: "not stated", requiredBefore: "BUILD" },
          escalationCeilingUsd: { known: false, reason: "not stated", requiredBefore: "BUILD" },
          escalationMechanism: "unspecified",
          privateConditions: [], contextDependencies: [], triggers: ["unspecified"],
          deploymentNetwork: "sepolia",
          unknowns: [{ field: "autonomousLimitUsd", reason: "not stated" }],
        },
      }),
    });
    void agents;
    const b = h.pipeline.createBuild({ userId: "u1", prompt: "Just keep me safe on Aave please." });
    await h.pipeline.runToApproval(b.id);
    const after = h.pipeline.get(b.id)!;
    expect(after.status).toBe("BUILD_NEEDS_USER_REVIEW");
    expect(after.stage).not.toBe("AWAITING_APPROVAL");

    const v = validateBlueprint(h.pipeline.currentBlueprint(b.id));
    expect(v.buildable).toBe(false);
    expect(v.unknowns.map((u) => u.path)).toContain("autonomousPolicy.maxValueUsdCents");
  });
});

/* ──────────────────────── the approval boundary ───────────────────────────── */

describe("STUDIO build approval boundary", () => {
  it("stops before generating anything and creates no sandbox", async () => {
    const h = harness();
    const { id } = await designed(h);
    expect(h.pipeline.get(id)!.stage).toBe("AWAITING_APPROVAL");
    expect(h.sandbox.files.size).toBe(0);
    expect(h.sandbox.commands).toEqual([]);
  });

  it("refuses to build without approval", async () => {
    const h = harness();
    const { id } = await designed(h);
    await expect(h.pipeline.runBuild(id)).rejects.toThrow(/not been approved/);
  });

  it("refuses approval while a model-raised CRITICAL is unacknowledged, and accepts it once named", async () => {
    const h = harness({
      agents: scriptedAgents({
        security: {
          findings: [{ code: "MODEL-001", severity: "CRITICAL", path: "actions", message: "over-broad", remediation: "narrow it" }],
          modelOpinion: "concerning",
        },
      }),
    });
    const { id } = await designed(h);
    expect(() => h.pipeline.approve(id)).toThrow(/must be acknowledged/);
    // The code is prefixed when recorded, and the acknowledgement must match what was recorded.
    expect(() => h.pipeline.approve(id, ["SEC-MODEL-001"])).not.toThrow();
    expect(h.pipeline.get(id)!.approvedAt).toBeTruthy();
  });
});

/* ─────────────────────────── STUDIO-006/022 artifacts ─────────────────────── */

describe("STUDIO-006 the generated module map matches the Blueprint", () => {
  it("every declared module exists in the sandbox after a build", async () => {
    const h = harness();
    const { id, blueprint } = await designed(h);
    h.pipeline.approve(id);
    const r = await h.pipeline.runBuild(id);
    expect(r.ok).toBe(true);
    for (const m of blueprint.generatedModules) {
      const present = r.files.some((f) => f === m.path || f.startsWith(`${m.path}/`));
      expect(present, `module ${m.moduleId} at ${m.path}`).toBe(true);
    }
  });
});

/* ────────────────────────── STUDIO-007/008/009 staleness ──────────────────── */

describe("STUDIO-007/008/009 revision binding and staleness", () => {
  it("simulations record the blueprint and build revision they ran against", async () => {
    const h = harness();
    const { id } = await designed(h);
    h.pipeline.approve(id);
    const r = await h.pipeline.runBuild(id);
    for (const s of r.simulations) {
      expect(s.blueprintRevision).toBe(1);
      expect(s.buildRevision).toBe(1);
    }
  });

  it("STUDIO-008/009 editing the Blueprint makes existing simulations and code stale", async () => {
    const ctx = buildServer({ db: testDb(), agents: scriptedAgents(), sandboxProviderId: provider(new RecordingSandbox(okExec), "rec_stale") });
    const created = await ctx.app.inject({ method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "u" }, payload: { prompt: "Aave guardian, repay up to $1,000." } });
    const id = created.json().id;
    await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/design` });
    await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/approve`, payload: {} });
    await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/build` });

    const before = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json();
    expect(before.staleSimulations).toBe(0);
    expect(before.codeStale).toBe(false);
    expect(before.simulations.every((s: { stale: boolean }) => !s.stale)).toBe(true);

    // Change a safe field through the UI's edit endpoint.
    await ctx.app.inject({
      method: "PATCH", url: `/api/studio/builds/${id}/blueprint`,
      payload: { capabilityPolicy: { ttlSeconds: 60, nonceStrategy: "on-chain-sequential", bindings: before.blueprint.capabilityPolicy.bindings } },
    });

    const after = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json();
    expect(after.blueprint.revision).toBe(2);
    expect(after.staleSimulations).toBe(24);
    expect(after.simulations.every((s: { stale: boolean }) => s.stale)).toBe(true);
    // STUDIO-009: the code is stale too. It was generated from revision 1 and the design is now at
    // revision 2 — no rebuild has happened, so the Code view is showing files that no longer
    // implement the Blueprint beside it.
    expect(after.codeStale).toBe(true);
    // STUDIO-026: a stale result must not be counted as evidence for the score.
    expect(after.score.categories.find((c: { id: string }) => c.id === "simulation-coverage").points).toBe(0);
  });

  it("STUDIO-009 rebuilding clears staleness on both axes", async () => {
    const ctx = buildServer({ db: testDb(), agents: scriptedAgents(), sandboxProviderId: provider(new RecordingSandbox(okExec), "rec_rebuild") });
    const created = await ctx.app.inject({ method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "u" }, payload: { prompt: "Aave guardian, repay up to $1,000." } });
    const id = created.json().id;
    await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/design` });
    await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/approve`, payload: {} });
    await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/build` });

    const before = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json();
    await ctx.app.inject({
      method: "PATCH", url: `/api/studio/builds/${id}/blueprint`,
      payload: { capabilityPolicy: { ttlSeconds: 90, nonceStrategy: "on-chain-sequential", bindings: before.blueprint.capabilityPolicy.bindings } },
    });
    expect((await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json().codeStale).toBe(true);

    await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/build` });
    const after = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json();
    expect(after.codeStale).toBe(false);
    expect(after.build.buildRevision).toBe(2);
    // The earlier run's results are RETAINED and still marked stale -- history is not deleted to
    // make the view tidy. Every fresh result belongs to the new revision.
    const current = after.simulations.filter((s: { stale: boolean }) => !s.stale);
    const stale = after.simulations.filter((s: { stale: boolean }) => s.stale);
    expect(stale).toHaveLength(24);
    expect(current.length).toBeGreaterThan(0);
    expect(current.every((s: { blueprintRevision: number; buildRevision: number }) => s.blueprintRevision === 2 && s.buildRevision === 2)).toBe(true);

    /*
     * FND-V2-005 CLOSED. The mandatory security suite is no longer charged to the user's
     * simulation allowance, so a rebuild re-runs ALL 17 scenarios rather than the 3 that were left
     * over from the first pass.
     */
    expect(current).toHaveLength(24);
    expect(current.every((s: { passed: boolean }) => s.passed)).toBe(true);
    expect(after.build.status).toBe("COMPLETED");
    expect(ctx.bus.history(id).some((e) => e.type === "build.limit_reached")).toBe(false);
    // A complete current pass earns full simulation-coverage points.
    expect(after.score.categories.find((c: { id: string }) => c.id === "simulation-coverage").points).toBe(10);
    // And the user's own allowance was never touched by any of it.
    expect(after.usage.userSimulations).toBe(0);
    expect(after.usage.mandatorySimulations).toBe(48); // two full passes of 24
    // And the regenerated code reflects the edit.
    const core = await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${id}/files/src/contextlock/core.ts` });
    expect(core.body).toContain("CAPABILITY_TTL_SECONDS = 90");
  });
});

/* ───────────────── FND-V2-005 closure: simulation budget classes ──────────── */

describe("FND-V2-005 security simulations are not charged to the user", () => {
  it("a Blueprint edit reruns the FULL mandatory suite and leaves the user allowance intact", async () => {
    const ctx = buildServer({ db: testDb(), agents: scriptedAgents(), sandboxProviderId: provider(new RecordingSandbox(okExec), "rec_fnd005") });
    const created = await ctx.app.inject({ method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "u" }, payload: { prompt: "Aave guardian, repay up to $1,000." } });
    const id = created.json().id;
    await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/design` });
    await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/approve`, payload: {} });
    await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/build` });

    const v1 = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json();
    expect(v1.usage.mandatorySimulations).toBe(24);
    expect(v1.usage.userSimulations).toBe(0);

    // Three more edit/rebuild cycles — 68 mandatory simulations in total, far past the old limit
    // of 20 that would have truncated everything after the first pass.
    for (let i = 0; i < 3; i++) {
      const cur = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json();
      await ctx.app.inject({
        method: "PATCH", url: `/api/studio/builds/${id}/blueprint`,
        payload: { capabilityPolicy: { ttlSeconds: 40 + i, nonceStrategy: "on-chain-sequential", bindings: cur.blueprint.capabilityPolicy.bindings } },
      });
      const r = await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/build` });
      expect(r.json().ok, `rebuild ${i + 1}`).toBe(true);
    }

    const v2 = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json();
    expect(v2.usage.mandatorySimulations).toBe(24 * 4);
    // The user's allowance is untouched after four full security passes.
    expect(v2.usage.userSimulations).toBe(0);
    expect(v2.usage.limits.userRequestedSimulationsPerBuild).toBe(20);
    // Every scenario at the current revision passed and none was truncated.
    const current = v2.simulations.filter((s: { stale: boolean }) => !s.stale);
    expect(current).toHaveLength(24);
    expect(v2.score.categories.find((c: { id: string }) => c.id === "simulation-coverage").points).toBe(10);
  });

  it("the user allowance is still enforced for user-requested runs", () => {
    const db = testDb();
    const t = new Date().toISOString();
    db.prepare(`INSERT INTO studio_projects (id,user_id,name,prompt,created_at) VALUES ('p1','u1','n','p',?)`).run(t);
    db.prepare(`INSERT INTO studio_builds (id,project_id,user_id,stage,status,build_revision,repair_cycles,created_at,updated_at) VALUES ('b1','p1','u1','SIMULATE','RUNNING',1,0,?,?)`).run(t, t);
    const q = new QuotaManager(db, { ...DEFAULT_QUOTA, userRequestedSimulationsPerBuild: 2 });

    // 50 mandatory rows must not consume any of the user's two.
    for (let i = 0; i < 50; i++) {
      db.prepare(`INSERT INTO studio_simulations (build_id,scenario_id,sim_class,pass_id,blueprint_revision,build_revision,result,passed,created_at) VALUES ('b1',?, 'MANDATORY_SECURITY','p1',1,1,'{}',1,?)`).run(`M${i}`, t);
    }
    expect(() => q.assertCanSimulate("b1", "USER_REQUESTED")).not.toThrow();

    for (let i = 0; i < 2; i++) {
      db.prepare(`INSERT INTO studio_simulations (build_id,scenario_id,sim_class,pass_id,blueprint_revision,build_revision,result,passed,created_at) VALUES ('b1',?, 'USER_REQUESTED','u',1,1,'{}',1,?)`).run(`U${i}`, t);
    }
    expect(() => q.assertCanSimulate("b1", "USER_REQUESTED")).toThrow(/USER_SIMULATIONS/);
    // ...and mandatory runs still proceed after the user's allowance is spent.
    expect(() => q.assertCanSimulate("b1", "MANDATORY_SECURITY")).not.toThrow();
  });

  it("mandatory passes are bounded, not unlimited", () => {
    const db = testDb();
    const t = new Date().toISOString();
    db.prepare(`INSERT INTO studio_projects (id,user_id,name,prompt,created_at) VALUES ('p1','u1','n','p',?)`).run(t);
    db.prepare(`INSERT INTO studio_builds (id,project_id,user_id,stage,status,build_revision,repair_cycles,created_at,updated_at) VALUES ('b1','p1','u1','SIMULATE','RUNNING',1,0,?,?)`).run(t, t);
    const q = new QuotaManager(db, { ...DEFAULT_QUOTA, maxMandatoryPassesPerBuild: 3, maxMandatorySimulationsPerPass: 25 });

    // A pathological adapter scenario list is refused before the pass starts.
    expect(() => q.assertMandatoryPassSize(500)).toThrow(/MANDATORY_SIMULATION_CEILING/);
    expect(() => q.assertMandatoryPassSize(25)).not.toThrow();

    for (let p = 0; p < 4; p++) {
      db.prepare(`INSERT INTO studio_simulations (build_id,scenario_id,sim_class,pass_id,blueprint_revision,build_revision,result,passed,created_at) VALUES ('b1',?, 'MANDATORY_SECURITY',?,1,1,'{}',1,?)`).run(`S${p}`, `pass${p}`, t);
    }
    expect(() => q.assertCanSimulate("b1", "MANDATORY_SECURITY")).toThrow(/MANDATORY_PASS_CEILING/);
  });
});

/* ───────────────────────── STUDIO-017 maxTurns enforced ───────────────────── */

describe("STUDIO-017 every agent role runs with a bounded turn count", () => {
  it("declares a finite maxTurns for every role", async () => {
    const { MAX_TURNS, ROLE_REASONING, STUDIO_MODEL } = await import("../src/config.js");
    const roles = Object.keys(ROLE_REASONING) as Array<keyof typeof MAX_TURNS>;
    expect(roles.length).toBeGreaterThan(0);
    for (const r of roles) {
      expect(Number.isFinite(MAX_TURNS[r]), `${r} maxTurns`).toBe(true);
      expect(MAX_TURNS[r]).toBeGreaterThan(0);
      // A budget large enough to be effectively unbounded would defeat the point.
      expect(MAX_TURNS[r]).toBeLessThanOrEqual(30);
    }
    expect(STUDIO_MODEL).toBe("gpt-5.6-luna");
  });

  it("passes a bounded maxTurns to the SDK on every run", async () => {
    // The SDK's ESM namespace is not configurable, so the module is replaced rather than spied on
    // (see the top-of-file vi.mock). This asserts the option actually reaches `run`, so an
    // unbounded agent loop is not reachable from the Studio.
    const { runRequirements, runSecurityArchitect } = await import("../src/agents/roles.js");
    const { run } = await import("@openai/agents");
    const calls = (run as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    calls.length = 0;

    await runRequirements("hello");
    await runSecurityArchitect("hello");

    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const opts = c[2] as { maxTurns?: number };
      expect(Number.isFinite(opts?.maxTurns)).toBe(true);
      expect(opts!.maxTurns!).toBeGreaterThan(0);
      expect(opts!.maxTurns!).toBeLessThanOrEqual(30);
    }
    // Different roles get different budgets: the security review is allowed more than extraction.
    expect((calls[1]![2] as { maxTurns: number }).maxTurns).toBeGreaterThanOrEqual(
      (calls[0]![2] as { maxTurns: number }).maxTurns,
    );
  });
});

/* ────────────────────── STUDIO-020 a stopped build resumes ────────────────── */

describe("STUDIO-020 a build stopped by a limit can be resumed", () => {
  it("keeps its state, and completes once the budget allows", async () => {
    const db = testDb();
    const bus = new StudioEventBus(db);
    const sandbox = new RecordingSandbox(okExec);
    const pid = provider(sandbox, "rec_resume");

    // Budget for one call only. Requirements succeeds; the architecture call is refused and, unlike
    // the advisory security review, is not caught -- there is no Blueprint without it.
    const tight = new QuotaManager(db, { ...DEFAULT_QUOTA, modelRequestsPerBuild: 1 });
    const p1 = new StudioPipeline({ db, bus, quota: tight, agents: scriptedAgents(), sandboxProviderId: pid });
    const b = p1.createBuild({ userId: "u1", prompt: "Aave guardian, repay up to $1,000, never withdraw collateral." });
    await expect(p1.runToApproval(b.id)).rejects.toThrow(QuotaExceededError);
    expect(p1.get(b.id)!.status).toBe("BUILD_LIMIT_REACHED");

    // Nothing was destroyed to enforce the limit: the partial work is still inspectable.
    expect(bus.history(b.id).some((e) => e.type === "requirements.completed")).toBe(true);
    expect(bus.history(b.id).some((e) => e.type === "build.limit_reached")).toBe(true);
    expect(sandbox.files.size).toBe(0);

    // Budget restored (an admin override, or the next day). Same build, same database.
    const restored = new QuotaManager(db, DEFAULT_QUOTA);
    const p2 = new StudioPipeline({ db, bus, quota: restored, agents: scriptedAgents(), sandboxProviderId: pid });
    await p2.runToApproval(b.id);
    expect(p2.get(b.id)!.stage).toBe("AWAITING_APPROVAL");
    p2.approve(b.id);
    const r = await p2.runBuild(b.id);
    expect(r.ok).toBe(true);
    expect(p2.get(b.id)!.status).toBe("COMPLETED");
  });
});

/* ──────────────────────────── STUDIO-010/011 lifetime ─────────────────────── */

describe("STUDIO-010/011 the build outlives any view", () => {
  it("STUDIO-011 the whole build state is reconstructable from persistence alone", async () => {
    const db = testDb();
    const sandbox = new RecordingSandbox(okExec);
    const pid = provider(sandbox, "rec_persist");
    const ctxA = buildServer({ db, agents: scriptedAgents(), sandboxProviderId: pid });
    const created = await ctxA.app.inject({ method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "u" }, payload: { prompt: "Aave guardian, repay up to $1,000." } });
    const id = created.json().id;
    await ctxA.app.inject({ method: "POST", url: `/api/studio/builds/${id}/design` });
    await ctxA.app.inject({ method: "POST", url: `/api/studio/builds/${id}/approve`, payload: {} });
    await ctxA.app.inject({ method: "POST", url: `/api/studio/builds/${id}/build` });
    const fromA = (await ctxA.app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json();

    // A brand-new server object over the same database — the equivalent of a browser refresh
    // reaching a different process. Nothing about the build lived in the first one.
    const ctxB = buildServer({ db, agents: scriptedAgents(), sandboxProviderId: pid });
    const fromB = (await ctxB.app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json();

    expect(fromB.build).toEqual(fromA.build);
    expect(fromB.graph).toEqual(fromA.graph);
    expect(fromB.files.length).toBe(fromA.files.length);
    expect(fromB.simulations.length).toBe(fromA.simulations.length);
    expect(fromB.score.total).toBe(fromA.score.total);
    expect(ctxB.bus.history(id).length).toBe(ctxA.bus.history(id).length);
  });

  it("STUDIO-010 subscribing and unsubscribing does not touch build state", async () => {
    const h = harness();
    const { id } = await designed(h);
    const seen: string[] = [];
    const unsub1 = h.bus.subscribe(id, (e) => seen.push(e.type));
    unsub1();
    const unsub2 = h.bus.subscribe(id, (e) => seen.push(e.type));
    h.pipeline.approve(id);
    const before = h.pipeline.get(id)!;
    unsub2();
    const r = await h.pipeline.runBuild(id);
    expect(r.ok).toBe(true);
    expect(h.pipeline.get(id)!.id).toBe(before.id);
    // Events kept flowing to persistence with nobody listening.
    expect(h.bus.history(id).some((e) => e.type === "build.completed")).toBe(true);
  });
});

/* ─────────────────────────── STUDIO-018 repair bound ──────────────────────── */

describe("STUDIO-018 the repair loop is bounded", () => {
  it("stops after exactly 3 cycles and hands the build to a human", async () => {
    let vitestCalls = 0;
    const h = harness({
      exec: (cmd) => {
        if (cmd.includes("vitest")) { vitestCalls++; return { stdout: "Tests  0 passed", exitCode: 1 }; }
        return { stdout: "", exitCode: 0 };
      },
    });
    const { id } = await designed(h);
    h.pipeline.approve(id);
    const r = await h.pipeline.runBuild(id);
    expect(r.ok).toBe(false);
    expect(h.pipeline.get(id)!.repairCycles).toBe(DEFAULT_QUOTA.autoRepairLoops);
    expect(h.pipeline.get(id)!.status).toBe("BUILD_NEEDS_USER_REVIEW");
    // 1 initial run + 3 repair re-runs.
    expect(vitestCalls).toBe(DEFAULT_QUOTA.autoRepairLoops + 1);
  });

  it("a typecheck failure is reported and not silently passed", async () => {
    const h = harness({
      exec: (cmd) => (cmd.includes("tsc") ? { stdout: "error TS2322", exitCode: 2 } : { stdout: "", exitCode: 0 }),
    });
    const { id } = await designed(h);
    h.pipeline.approve(id);
    const r = await h.pipeline.runBuild(id);
    expect(r.ok).toBe(false);
    expect(h.bus.history(id).some((e) => e.type === "test.failed")).toBe(true);
  });
});

/* ────────────────────────── STUDIO-019 usage accounting ───────────────────── */

describe("STUDIO-019 usage totals come from the SDK's accounting", () => {
  it("aggregates exactly what each agent run reported", async () => {
    const h = harness();
    const { id } = await designed(h);
    const snap = h.quota.snapshot(id);
    // requirements 850/470 + architecture 960/520 + security 3000/1800
    expect(snap.requests).toBe(3);
    expect(snap.inputTokens).toBe(850 + 960 + 3000);
    expect(snap.outputTokens).toBe(470 + 520 + 1800);
    expect(snap.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("records one row per role", async () => {
    const h = harness();
    const { id } = await designed(h);
    const rows = h.db.prepare(`SELECT role, model FROM studio_usage WHERE build_id = ?`).all(id) as Array<{ role: string; model: string }>;
    expect(rows.map((r) => r.role).sort()).toEqual(["architecture", "requirements", "security"]);
    expect(rows.every((r) => r.model === "gpt-5.6-luna")).toBe(true);
  });
});

/* ──────────────────────────── STUDIO-027 event order ──────────────────────── */

describe("STUDIO-027 build event order remains valid", () => {
  it("stages are emitted in the pipeline's order, never out of sequence", async () => {
    const h = harness();
    const { id } = await designed(h);
    h.pipeline.approve(id);
    await h.pipeline.runBuild(id);
    const types = h.bus.history(id).map((e) => e.type);
    const order = [
      "build.created", "requirements.started", "requirements.completed",
      "blueprint.started", "blueprint.completed", "security.started", "security.completed",
      "approval.requested", "approval.granted", "code.started", "test.started",
      "simulation.started", "simulation.completed", "build.completed",
    ];
    let last = -1;
    for (const t of order) {
      const i = types.indexOf(t);
      expect(i, `${t} missing or out of order`).toBeGreaterThan(last);
      last = i;
    }
  });

  it("no file event precedes code.started", async () => {
    const h = harness();
    const { id } = await designed(h);
    h.pipeline.approve(id);
    await h.pipeline.runBuild(id);
    const types = h.bus.history(id).map((e) => e.type);
    expect(types.indexOf("code.file.created")).toBeGreaterThan(types.indexOf("code.started"));
  });
});

/* ───────────────────── STUDIO-031 sandbox provider fails closed ───────────── */

describe("STUDIO-031 an unregistered sandbox provider fails closed", () => {
  it("throws a named error and never falls back", () => {
    // This used to name "e2b", which did not exist when P11 was written. It does now
    // (FND-V2-002-UPDATE), so the property is tested against a provider that genuinely is not
    // registered — the property was never about E2B, it was about failing closed.
    expect(() => getSandboxProvider("some-provider-nobody-registered")).toThrow(SandboxProviderUnavailableError);
    expect(() => getSandboxProvider("some-provider-nobody-registered")).toThrow(/no such provider is registered/);
  });

  it("the docker provider cannot be silently replaced", () => {
    expect(() => registerSandboxProvider("docker", () => ({}) as never)).toThrow(/cannot be replaced/);
  });
});

/* ──────────────────────── STUDIO-023 malicious target ─────────────────────── */

describe("STUDIO-023 a malicious generated target fails policy validation", () => {
  it("an arbitrary target in the architecture output is refused before any code is written", async () => {
    const h = harness();
    const { id } = await designed(h);
    // Simulate a compromised architecture stage by editing the Blueprint to an arbitrary target.
    const bp = h.pipeline.currentBlueprint(id);
    const patched = {
      ...bp,
      actions: bp.actions.map((a, i) =>
        i === 0 ? { ...a, targetPolicy: { mode: "arbitrary" as const, justification: "x".repeat(45) } } : a,
      ),
    };
    const { issues } = h.pipeline.editBlueprint(id, patched);
    expect(issues.some((i) => i.code === "BP-001")).toBe(true);
    expect(validateBlueprint(h.pipeline.currentBlueprint(id)).buildable).toBe(false);
  });
});
