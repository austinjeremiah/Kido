import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assertPublicSafe } from "@contextlock/studio-events";
import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";
import { buildServer } from "../src/api.js";
import { openStudioDb, type DB } from "../src/db.js";
import { devLabDeps, deterministicFromDb } from "../src/lab/dev-wiring.js";
import { beginLabRun, finishLabRun, latestLabRun, parseCreOutput, recordedCommandLine, reconcileOrphanedLabRuns, CRE_TRIGGER } from "../src/lab/cre-sim.js";
import { ForkLabService } from "../src/fork/service.js";
import { ForkKeyring, FORK_ROLES } from "../src/fork/chain.js";
import { forkPolicyFor, policyHashOf, prepareRecord, repayCalldata, approveCalldata, ACTION_KINDS } from "../src/fork/deployer.js";
import { driversFor } from "../src/fork/drivers.js";
import { PROTOCOL_CATALOGUE, swapAction } from "@contextlock/studio-blueprint";
import { ForkDeploymentRecordSchema, FORK_DEPLOY_PHASES } from "../src/fork/record.js";

/**
 * The fork lab and the runnable CRE simulation.
 *
 * What the live flow proved by hand — deploy, activate, stress, repay, escalate, lock — needs a
 * fork, a mainnet RPC and a minute; it is gated behind `CONTEXTLOCK_FORK_E2E` at the bottom. What
 * runs every time is everything that decides those outcomes without a chain: the CLI transcript
 * parser, the readiness gates, the repayment arithmetic, the policy derivation, the persistence
 * and reconciliation rules, and the wiring that makes a locally-built project's Simulation Center
 * read its own results rather than the demo's.
 */

const BLUEPRINT = JSON.parse(
  readFileSync(new URL("../../../reports/phase-28/evidence/p28-blueprint.json", import.meta.url).pathname, "utf8"),
) as ContextLockAgentBlueprint;

/* Recorded shapes of `cre workflow simulate` output. */
const PASSING = `Initializing...
Compiling workflow...
✓ Workflow compiled
✓ Simulation limits enabled
  HTTP: req=120kb resp=250kb timeout=10s
  Binary hash: 800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0
  Config hash: 5f3a3f47563339a7a8c1717956e3975934c758c95ecbf72ba99a559505944539
2026-09-11T11:42:03Z [SIMULATION] Simulator Initialized
Simulation Result:
"DENY:DENY_CONTEXT_STALE:HIGH"
│ Simulation complete! Ready to deploy your workflow?  │
`;
const STOPPED_AT_TRIGGER = `Initializing...
✓ Workflow compiled
✓ Simulation limits enabled
  Binary hash: 800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0
Fetching transaction receipt for 0x6275...
2026-09-11T11:42:03Z [SIMULATION] Simulator Initialized

✗ failed to get evm trigger data: failed to fetch transaction receipt: 429 Too Many Requests
`;

function seedProject(db: DB, projectId = "prj_test", buildId = "bld_test", opts: { blueprintRevision?: number; sims?: Array<{ passed: boolean; blueprintRevision?: number }> } = {}): void {
  const t = new Date().toISOString();
  db.prepare(`INSERT INTO studio_projects (id,user_id,name,prompt,created_at) VALUES (?,?,'n','p',?)`).run(projectId, "u1", t);
  db.prepare(
    `INSERT INTO studio_builds (id,project_id,user_id,stage,status,blueprint_revision,build_revision,repair_cycles,created_at,updated_at)
     VALUES (?,?,?,'EXPORT_READY','COMPLETED',?,1,0,?,?)`,
  ).run(buildId, projectId, "u1", opts.blueprintRevision ?? 1, t, t);
  db.prepare(`INSERT INTO studio_blueprints (build_id,revision,document,validation,created_at) VALUES (?,?,?,?,?)`)
    .run(buildId, opts.blueprintRevision ?? 1, JSON.stringify({ ...BLUEPRINT, revision: opts.blueprintRevision ?? 1 }), "{}", t);
  (opts.sims ?? []).forEach((s, i) => {
    db.prepare(
      `INSERT INTO studio_simulations (build_id,scenario_id,sim_class,pass_id,blueprint_revision,build_revision,result,passed,created_at)
       VALUES (?,?,'MANDATORY_SECURITY','pass-1',?,1,'{}',?,?)`,
    ).run(buildId, `S${i}`, s.blueprintRevision ?? opts.blueprintRevision ?? 1, s.passed ? 1 : 0, t);
  });
}

describe("the official CRE simulation runner", () => {
  it("FORK-001 a full transcript is a run that passed under production limits, with the workflow's own verdict", () => {
    const r = parseCreOutput(PASSING, 0);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.productionLimits).toBe(true);
    expect(r.binaryHash).toBe("800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0");
    expect(r.verdict).toBe("DENY:DENY_CONTEXT_STALE:HIGH");
    expect(r.failure).toBeNull();
  });

  it("FORK-002 a run that compiled but never fetched its trigger did not simulate, and says why in the CLI's words", () => {
    const r = parseCreOutput(STOPPED_AT_TRIGGER, 1);
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(false);
    // The binary hash is still recorded: it is a fact about the artifact, not about the run.
    expect(r.binaryHash).toMatch(/^800d/);
    expect(r.failure).toContain("429 Too Many Requests");
  });

  it("FORK-003 a clean exit with no verdict is not a pass", () => {
    const r = parseCreOutput(PASSING.replace(/"DENY[^"]*"\n/, ""), 0);
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(false);
  });

  it("FORK-004 the recorded command line names the trigger and the env override by role, and the result is public-safe", () => {
    const cl = recordedCommandLine("/x/cre", true);
    expect(cl).not.toContain(CRE_TRIGGER.txHash);
    expect(cl).toContain("<trigger-tx>");
    expect(cl).toContain("<studio-env-override>");
    const result = { ...parseCreOutput(PASSING, 0), durationMs: 1, commandLine: cl, triggerTxHash: CRE_TRIGGER.txHash, cliVersion: "1.32.0" };
    expect(() => assertPublicSafe({ runs: [{ result }] }, "api-response")).not.toThrow();
  });

  it("FORK-005 runs are recorded, the latest wins, and a run left RUNNING by a dead process is reconciled to FAILED", () => {
    const db = openStudioDb(":memory:");
    const a = beginLabRun(db, { projectId: "p", buildId: null, blueprintRevision: null, kind: "CRE_SIMULATION" });
    finishLabRun(db, a, "PASSED", { passed: true });
    const b = beginLabRun(db, { projectId: "p", buildId: null, blueprintRevision: null, kind: "CRE_SIMULATION" });
    expect(latestLabRun(db, "p", "CRE_SIMULATION")?.id).toBe(b);
    expect(reconcileOrphanedLabRuns(db)).toEqual([b]);
    const latest = latestLabRun(db, "p", "CRE_SIMULATION")!;
    expect(latest.status).toBe("FAILED");
    expect((latest.result as { passed: boolean }).passed).toBe(false);
  });
});

describe("a locally-built project's Lab readers", () => {
  it("FORK-010 the deterministic suite is counted from the pipeline's rows, for the current revision only", () => {
    const db = openStudioDb(":memory:");
    seedProject(db, "prj_a", "bld_a", { blueprintRevision: 2, sims: [{ passed: true }, { passed: true }, { passed: false, blueprintRevision: 1 }] });
    expect(deterministicFromDb(db, "prj_a")).toEqual({ passed: 2, total: 2 });
    expect(deterministicFromDb(db, "prj_none")).toBeNull();
  });

  it("FORK-011 the Simulation Center reads a locally-built project's own suite instead of reporting NOT RUN", async () => {
    const db = openStudioDb(":memory:");
    seedProject(db, "prj_b", "bld_b", { sims: [{ passed: true }, { passed: true }, { passed: true }] });
    const { app } = buildServer({ db, lab: devLabDeps });
    const res = await app.inject({ method: "GET", url: "/api/lab/projects/prj_b/simulation-center" });
    expect(res.statusCode).toBe(200);
    const layers = (res.json() as { layers: Array<{ key: string; status: string; passed: number | null; total: number | null }> }).layers;
    const det = layers.find((l) => l.key === "SECURITY_SIMULATION")!;
    expect(det.status).toBe("PASS");
    expect(det.passed).toBe(3);
    expect(det.total).toBe(3);
    // The CRE layer is honestly NOT RUN until a run is recorded.
    expect(layers.find((l) => l.key === "CRE_WORKFLOW_SIMULATION")!.status).toBe("NOT_RUN");
  });

  it("FORK-012 a failed suite does not pass the lifecycle, and a recorded CRE run moves it", async () => {
    const db = openStudioDb(":memory:");
    seedProject(db, "prj_c", "bld_c", { sims: [{ passed: true }, { passed: false }] });
    const { app } = buildServer({ db, lab: devLabDeps });
    let state = (await app.inject({ method: "GET", url: "/api/lab/projects/prj_c/state" })).json() as { state: string; computedFrom: { deterministicSimulationsPassed: boolean; creSimulationPassed: boolean } };
    expect(state.computedFrom.deterministicSimulationsPassed).toBe(false);
    expect(state.computedFrom.creSimulationPassed).toBe(false);

    const run = beginLabRun(db, { projectId: "prj_c", buildId: "bld_c", blueprintRevision: 1, kind: "CRE_SIMULATION" });
    finishLabRun(db, run, "PASSED", { ...parseCreOutput(PASSING, 0), durationMs: 1, commandLine: [], triggerTxHash: CRE_TRIGGER.txHash, cliVersion: "1.32.0" });
    state = (await app.inject({ method: "GET", url: "/api/lab/projects/prj_c/state" })).json() as typeof state;
    expect(state.computedFrom.creSimulationPassed).toBe(true);

    // The CRE card renders for a local project: a connection to the local CLI, and the run's facts.
    const cre = await app.inject({ method: "GET", url: "/api/lab/projects/prj_c/cre" });
    expect(cre.statusCode).toBe(200);
    expect((cre.json() as { status: { workflowBinary: string | null } }).status.workflowBinary).toMatch(/^800d/);
  });

  it("FORK-013 the simulate route records a run through the injected runner", async () => {
    const db = openStudioDb(":memory:");
    seedProject(db, "prj_d", "bld_d");
    const lab = devLabDeps(db);
    lab.runCreSimulation = async (projectId) => {
      const id = beginLabRun(db, { projectId, buildId: "bld_d", blueprintRevision: 1, kind: "CRE_SIMULATION" });
      const result = { ...parseCreOutput(STOPPED_AT_TRIGGER, 1), durationMs: 5, commandLine: recordedCommandLine("cre", false), triggerTxHash: CRE_TRIGGER.txHash, cliVersion: "1.32.0" };
      finishLabRun(db, id, "FAILED", result);
      return { run: latestLabRun(db, projectId, "CRE_SIMULATION"), result };
    };
    const { app } = buildServer({ db, lab: () => lab });
    const res = await app.inject({ method: "POST", url: "/api/lab/projects/prj_d/cre/simulate" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { result: { failure: string } }).result.failure).toContain("429");
    const list = await app.inject({ method: "GET", url: "/api/lab/projects/prj_d/cre/simulations" });
    expect((list.json() as { runs: unknown[] }).runs).toHaveLength(1);
  });
});

describe("the fork deployment's pure parts", () => {
  const keyring = ForkKeyring.generate();

  it("FORK-020 the fork policy is the Blueprint's, plus the bounded approval its approvals field declares, and hashes deterministically", () => {
    const p = forkPolicyFor(BLUEPRINT);
    expect(p.allowedActionKinds).toContain(ACTION_KINDS.approve);
    for (const a of BLUEPRINT.actions) expect(p.allowedActionKinds).toContain(a.kind);
    expect(p.allowedTargets).toHaveLength(2);
    expect(p.restoreHealthFactorBps).toBeGreaterThan(p.targetHealthFactorBps);
    expect(policyHashOf(p)).toBe(policyHashOf(forkPolicyFor(BLUEPRINT)));
    expect(policyHashOf(p)).not.toBe(policyHashOf({ ...p, policyVersion: p.policyVersion + 1 }));
  });

  it("FORK-021 a fresh keyring: five distinct roles, none of them an Anvil dev account, and the record keeps only addresses", () => {
    const addrs = keyring.addresses();
    expect(new Set(Object.values(addrs).map((a) => a.toLowerCase())).size).toBe(FORK_ROLES.length);
    expect(Object.values(addrs).map((a) => a.toLowerCase())).not.toContain("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    expect(Object.values(addrs).map((a) => a.toLowerCase())).not.toContain("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    const record = prepareRecord({ bp: BLUEPRINT, projectId: "prj_x", buildId: "bld_x", upstreamProviderId: "test", keyring });
    expect(JSON.stringify(record)).not.toMatch(/privateKey/);
    expect(ForkDeploymentRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toBeTruthy();
    expect(record.phases.map((p) => p.key)).toEqual(FORK_DEPLOY_PHASES.map((p) => p.key));
    expect(record.phases.every((p) => p.status === "PENDING")).toBe(true);
    // The record is a public surface: it must pass the scanner as it is served.
    expect(() => assertPublicSafe(record, "api-response")).not.toThrow();
  });

  it("FORK-022 the fork policy's targets follow the scenario drivers, and an agent with no driver is refused", () => {
    const multi = { ...BLUEPRINT, actions: [...BLUEPRINT.actions, ...PROTOCOL_CATALOGUE.flatMap((p) => p.actions.filter((a) => a.protocolRef !== "aave")), swapAction("dex-router")] } as ContextLockAgentBlueprint;
    const policy = forkPolicyFor(multi);
    const { drivers, unexercised } = driversFor(multi.actions.map((a) => a.kind));
    expect(drivers.map((d) => d.protocol).sort()).toEqual(["aave", "compound", "dex-router", "lido", "morpho"]);
    // Kinds the catalogue offers but the fork has no scenario for are named, not silently dropped.
    expect(unexercised.sort()).toEqual(["AAVE_SUPPLY", "COMPOUND_SUPPLY", "MORPHO_SUPPLY_COLLATERAL", "UNISWAP_SWAP"]);
    for (const d of drivers) for (const t of d.targets) expect(policy.allowedTargets).toContain(t);
    expect(policy.allowedActionKinds).toContain(ACTION_KINDS.approve);
    const none = { ...BLUEPRINT, actions: [{ ...BLUEPRINT.actions[0]!, kind: "SPARK_SUPPLY" }] } as ContextLockAgentBlueprint;
    expect(forkPolicyFor(none).allowedTargets).toEqual([]);
    expect(() => prepareRecord({ bp: none, projectId: "p", buildId: null, upstreamProviderId: "t", keyring })).toThrow(/no scenario/);
  });

  it("FORK-023 the calldata the executor is asked to run is exactly Aave's repay and an exact-amount approve", () => {
    const user = keyring.addresses().user;
    expect(repayCalldata(1_000_000n, user).slice(0, 10)).toBe("0x573ade81");
    expect(approveCalldata(1_000_000n).slice(0, 10)).toBe("0x095ea7b3");
    expect(approveCalldata(1_000_000n)).toContain((1_000_000n).toString(16).padStart(64, "0"));
  });
});

describe("the fork lab service", () => {
  function service(db: DB, anvilBinary = "definitely-not-a-binary-xyz"): ForkLabService {
    return new ForkLabService({ db, anvilBinary, readBlueprint: async () => BLUEPRINT, upstreamRpcUrl: "http://127.0.0.1:9/", upstreamProviderId: "unreachable" });
  }

  it("FORK-030 readiness names every gate with its reason, and blocks when anvil or mainnet is missing", async () => {
    const db = openStudioDb(":memory:");
    const svc = service(db);
    const r = await svc.readiness("prj_y", { architecturePassed: true, securityTestsPassed: true, creSimulationPassed: false, creSimulationDetail: "not run" });
    const by = Object.fromEntries(r.gates.map((g) => [g.label, g]));
    expect(by["Fork provider"]!.status).toBe("BLOCKED");
    expect(by["Fork provider"]!.blocker).toBe("BLK-V2-NO-ANVIL");
    expect(by["Mainnet read source"]!.status).toBe("BLOCKED");
    expect(by["CRE simulation"]!.status).toBe("FAIL");
    expect(by["Mainnet writes"]!.detail).toContain("PROHIBITED");
    expect(by["Policy"]!.detail).toContain("DISABLED");
    expect(r.canDeploy).toBe(false);
    expect(r.blockedBy).toEqual(expect.arrayContaining(["Fork provider", "Mainnet read source", "CRE simulation"]));
    expect(r.executionNetwork).toEqual({ chainId: 31337, name: "Local Anvil fork of Ethereum mainnet", role: "LOCAL_FORK", forkedFrom: 1 });
    expect(by["Fork scenario"]!.status).toBe("PASS");
  });

  it("FORK-030b an agent with no Aave repayment has no fork scenario, and the gate says which actions it does have", async () => {
    const db = openStudioDb(":memory:");
    const bp = { ...BLUEPRINT, actions: BLUEPRINT.actions.map((a) => ({ ...a, kind: "UNISWAP_SWAP" })) } as unknown as ContextLockAgentBlueprint;
    const svc = new ForkLabService({ db, anvilBinary: "definitely-not-a-binary-xyz", readBlueprint: async () => bp, upstreamRpcUrl: "http://127.0.0.1:9/" });
    const r = await svc.readiness("prj_u", { architecturePassed: true, securityTestsPassed: true, creSimulationPassed: true, creSimulationDetail: "ok" });
    const gate = r.gates.find((g) => g.label === "Fork scenario")!;
    expect(gate.status).toBe("BLOCKED");
    expect(gate.blocker).toBe("BLK-V2-FORK-SCENARIO");
    expect(gate.detail).toContain("UNISWAP_SWAP");
    expect(r.canDeploy).toBe(false);
  });

  it("FORK-031 the deploy route re-checks the gates rather than trusting the screen", async () => {
    const db = openStudioDb(":memory:");
    seedProject(db, "prj_z", "bld_z", { sims: [{ passed: true }] });
    const { app } = buildServer({ db, lab: devLabDeps, fork: (d) => service(d) });
    const res = await app.inject({ method: "POST", url: "/api/fork/projects/prj_z/deploy", payload: { buildId: "bld_z" } });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { blockedBy: string[] }).blockedBy).toContain("Fork provider");
    expect((await app.inject({ method: "GET", url: "/api/studio/health" })).json()).toMatchObject({ controlPlane: "attached", lab: "attached", fork: "attached" });
  });

  it("FORK-032 a deployment row whose process died is reconciled to STOPPED with the reason, and its fork to DESTROYED", () => {
    const db = openStudioDb(":memory:");
    const record = prepareRecord({ bp: BLUEPRINT, projectId: "prj_r", buildId: null, upstreamProviderId: "test", keyring: ForkKeyring.generate() });
    record.fork = {
      forkId: "fork-0123456789ab", sourceChainId: 1, chainId: 31337, forkBlock: "1", forkBlockHash: `0x${"a".repeat(64)}`, sourceProviderId: "test",
      anvilVersion: "anvil/test", endpoint: "http://127.0.0.1:8765", createdAtMs: 1, expiresAtMs: 2, state: "READY",
    };
    db.prepare(`INSERT INTO studio_fork_deployments (id,project_id,build_id,blueprint_revision,state,phase,revision,record,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(record.deploymentId, "prj_r", null, 1, "READY_TO_ACTIVATE", "READY_TO_ACTIVATE", "rev_1", JSON.stringify(record), "t", "t");
    const svc = service(db);
    expect(svc.reconcileOrphaned()).toEqual([record.deploymentId]);
    const after = svc.get(record.deploymentId)!;
    expect(after.state).toBe("STOPPED");
    expect(after.record.stoppedReason).toMatch(/server that held this fork stopped/);
    expect(after.record.fork?.state).toBe("DESTROYED");
    expect(after.live).toEqual({ fork: false, runtime: false });
    // A stopped deployment is not the project's current one for the lifecycle.
    expect(svc.currentForProject("prj_r")?.state).toBe("STOPPED");
  });

  it("FORK-033 the control plane over a stopped deployment reports the policy as unreadable, never as disabled", async () => {
    const db = openStudioDb(":memory:");
    const record = prepareRecord({ bp: BLUEPRINT, projectId: "prj_s", buildId: null, upstreamProviderId: "test", keyring: ForkKeyring.generate() });
    db.prepare(`INSERT INTO studio_fork_deployments (id,project_id,build_id,blueprint_revision,state,phase,revision,record,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(record.deploymentId, "prj_s", null, 1, "STOPPED", "READY_TO_ACTIVATE", "rev_1", JSON.stringify({ ...record, stoppedReason: "stopped by the operator" }), "t", "t");
    const { app } = buildServer({ db, lab: devLabDeps, fork: (d) => service(d) });
    const res = await app.inject({ method: "GET", url: `/api/control/deployments/${record.deploymentId}/overview` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { badge: string; panels: { policy: { value: unknown; state: string }; runtime: { state: string } } };
    expect(body.badge).toBe("INACTIVE");
    expect(body.panels.policy.value).toBeNull();
    expect(body.panels.policy.state).toBe("NOT_CONFIGURED");
    expect(body.panels.runtime.state).toBe("STOPPED");
    const cmd = await app.inject({
      method: "POST", url: `/api/control/deployments/${record.deploymentId}/commands`,
      headers: { "x-contextlock-capabilities": "VIEW,POLICY_CONTROL" }, payload: { operation: "ENABLE_POLICY", expectedRevision: "rev_1" },
    });
    expect(cmd.statusCode).toBe(200);
    expect((cmd.json() as { ok: boolean; detail: string }).ok).toBe(false);
    expect((cmd.json() as { detail: string }).detail).toMatch(/fork is not running/);
  });
});

/*
 * The live loop, opt-in.
 *
 * Needs anvil, the compiled contracts and a reachable mainnet RPC, and takes about a minute. Run
 * with `CONTEXTLOCK_FORK_E2E=1 npx vitest run apps/studio/test/fork-lab.test.ts`.
 */
describe.skipIf(!process.env.CONTEXTLOCK_FORK_E2E)("the live fork loop", () => {
  it("FORK-E2E deploys five protocols, activates, acts on each, escalates, and executes an escalation only after a human approves", async () => {
    const db = openStudioDb(":memory:");
    seedProject(db, "prj_live", "bld_live", { sims: [{ passed: true }] });
    const run = beginLabRun(db, { projectId: "prj_live", buildId: "bld_live", blueprintRevision: 1, kind: "CRE_SIMULATION" });
    finishLabRun(db, run, "PASSED", { ...parseCreOutput(PASSING, 0), durationMs: 1, commandLine: [], triggerTxHash: CRE_TRIGGER.txHash, cliVersion: "1.32.0" });
    const bp = { ...BLUEPRINT, revision: 1, actions: [BLUEPRINT.actions[0]!, ...PROTOCOL_CATALOGUE.flatMap((p) => p.actions.filter((a) => a.protocolRef !== "aave" && !a.kind.includes("SUPPLY"))), swapAction("dex-router")] } as ContextLockAgentBlueprint;
    const svc = new ForkLabService({ db, readBlueprint: async () => bp, repoRoot: new URL("../../..", import.meta.url).pathname, basePort: 8790, tickMs: 3_000 });
    const { app } = buildServer({ db, lab: devLabDeps, fork: () => svc });
    try {
      const started = await app.inject({ method: "POST", url: "/api/fork/projects/prj_live/deploy", payload: { buildId: "bld_live" } });
      expect(started.statusCode).toBe(200);
      const id = (started.json() as { deploymentId: string }).deploymentId;
      for (let i = 0; i < 120 && svc.get(id)!.state === "DEPLOYING"; i++) await new Promise((r) => setTimeout(r, 2_000));
      const dep = svc.get(id)!;
      expect(dep.record.failure).toBeNull();
      expect(dep.state).toBe("READY_TO_ACTIVATE");
      expect(dep.record.position!.scenarios.map((x) => x.protocol).sort()).toEqual(["aave", "compound", "dex-router", "lido", "morpho"]);

      const on = await app.inject({ method: "POST", url: `/api/control/deployments/${id}/commands?projectId=prj_live`, headers: { "x-contextlock-capabilities": "VIEW,POLICY_CONTROL,EMERGENCY_CONTROL" }, payload: { operation: "ENABLE_POLICY", expectedRevision: "rev_1" } });
      expect((on.json() as { ok: boolean }).ok).toBe(true);

      // The Lido stake is proposed by the runtime as soon as the policy is on: 0.3 idle ETH is under the limit.
      let pos = (await svc.position(id))!;
      for (let i = 0; i < 10 && !pos.executions.some((e) => e.driverId === "lido-stake"); i++) { await svc.tickNow(id); pos = (await svc.position(id))!; }
      expect(pos.executions.some((e) => e.driverId === "lido-stake" && !e.approvedByHuman)).toBe(true);

      // Each lending position is stressed to 1.50; the agent repays each within its limit.
      for (const driverId of ["aave-repay", "compound-repay", "morpho-repay"]) {
        await svc.stress(id, driverId, "borrow-more", 15_000);
        for (let i = 0; i < 10 && !pos.executions.some((e) => e.driverId === driverId); i++) { await svc.tickNow(id); pos = (await svc.position(id))!; }
        const e = pos.executions.find((x) => x.driverId === driverId)!;
        expect(e, driverId).toBeTruthy();
        expect(e.healthFactorAfterBps!).toBeGreaterThan(e.healthFactorBeforeBps!);
      }

      // A large USDC arrival unbalances the vault; the rebalance is over the auto limit → ESCALATE.
      await svc.stress(id, "uniswap-rebalance", "usdc-arrives", 6_000);
      for (let i = 0; i < 6 && pos.pending.length === 0; i++) { await svc.tickNow(id); pos = (await svc.position(id))!; }
      const esc = pos.pending.find((p) => p.driverId === "uniswap-rebalance")!;
      expect(esc).toBeTruthy();
      expect(pos.executions.some((e) => e.driverId === "uniswap-rebalance")).toBe(false);

      // A human signs; the executor consumes the approval and the swap runs.
      const approved = await app.inject({ method: "POST", url: `/api/fork/deployments/${id}/approvals/${esc.correlationId}` });
      expect(approved.statusCode, approved.body).toBe(200);
      pos = (await svc.position(id))!;
      const swap = pos.executions.find((e) => e.driverId === "uniswap-rebalance")!;
      expect(swap.approvedByHuman).toBe(true);
      expect(pos.decisions.find((d) => d.correlationId === esc.correlationId)!.executed).toBe(true);

      const lock = await app.inject({ method: "POST", url: `/api/control/deployments/${id}/commands?projectId=prj_live`, headers: { "x-contextlock-capabilities": "VIEW,EMERGENCY_CONTROL" }, payload: { operation: "EMERGENCY_LOCK", expectedRevision: "rev_1", confirmation: { includeIdentityRevocation: false } } });
      expect((lock.json() as { ok: boolean }).ok).toBe(true);
      expect((await svc.position(id))!.policyEnabled).toBe(false);
    } finally {
      await svc.stopAll("test finished");
    }
  }, 900_000);
});
