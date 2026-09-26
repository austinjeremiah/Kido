import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildServer } from "../src/api.js";
import { openStudioDb, type DB } from "../src/db.js";
import type { LabApiDeps } from "../src/lab/api.js";
import type { LabInputs, SafetyReport, DecisionInputs } from "@contextlock/studio-lab";
import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";
import { MarketSnapshotSchema, ShadowDecisionSchema, ForkDescriptorSchema, ForkTransactionSchema } from "@contextlock/studio-reality";

/**
 * The Testnet Lab HTTP surface.
 *
 * The routes are thin — they project state the backend already computed — and that is exactly why
 * they need their own tests. A thin route can still return the wrong project's state, drop a field
 * the UI depends on, or serve the private report where the public one was asked for, and none of
 * those would fail a unit test of the projection.
 *
 * Every harness below opens `:memory:`. `LIVE-023d` in P25 found a test passing for the wrong
 * reason because suites shared the on-disk `studio.db`, and that lesson applies to every suite since.
 */

const BLUEPRINT = JSON.parse(
  readFileSync(new URL("../../../reports/phase-28/evidence/p28-blueprint.json", import.meta.url).pathname, "utf8"),
) as ContextLockAgentBlueprint;

const REPORT = JSON.parse(
  readFileSync(new URL("../../../reports/phase-28/evidence/p28-safety-report.json", import.meta.url).pathname, "utf8"),
) as SafetyReport;

const PROJECT = "proj-treasury-guardian";

/** The real P27 snapshot and fork run. The routes serve recorded evidence, so the tests drive it. */
const SNAPSHOT = MarketSnapshotSchema.parse(
  JSON.parse(readFileSync(new URL("../../../reports/phase-27/evidence/p27-market-snapshot.json", import.meta.url).pathname, "utf8")),
);

const P27_DEMO = JSON.parse(
  readFileSync(new URL("../../../reports/phase-27/evidence/p27-demo.json", import.meta.url).pathname, "utf8"),
) as { shadowDecision: unknown; forkBlock: string; forkBlockHash: string; anvilVersion: string; swapHash: string; usdcOut: number };

const SHADOW = (() => {
  const decision = ShadowDecisionSchema.parse(P27_DEMO.shadowDecision);
  return {
    decision,
    fork: ForkDescriptorSchema.parse({
      forkId: decision.environmentId, sourceChainId: 1, chainId: 31337,
      forkBlock: P27_DEMO.forkBlock, forkBlockHash: P27_DEMO.forkBlockHash,
      sourceProviderId: "mainnet-read-only-rpc", anvilVersion: P27_DEMO.anvilVersion,
      endpoint: "http://127.0.0.1:8749", createdAtMs: decision.decidedAtMs,
      expiresAtMs: decision.decidedAtMs + 1_800_000, state: "DESTROYED",
    }),
    tx: ForkTransactionSchema.parse({
      hash: P27_DEMO.swapHash, forkId: decision.environmentId, chainId: 31337, forkedFrom: 1,
      forkBlock: P27_DEMO.forkBlock, blockNumber: String(Number(P27_DEMO.forkBlock) + 3),
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      to: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      status: "success", gasUsed: "145593", label: "LOCAL FORK TRANSACTION", impersonated: false,
    }),
    protocol: "Uniswap V3",
    input: "1 WETH",
    output: `${P27_DEMO.usdcOut} USDC`,
  };
})();

const DECISION: DecisionInputs = {
  correlationId: "demo-25948265",
  verdict: "ALLOW",
  reasonCode: "ALLOW_POLICY_MATCH",
  amount: "1000 USDC",
  policyRef: "contextlock-lab-policy v1",
  marketSnapshotHash: SHADOW.decision.marketSnapshotHash,
  scenarioHash: null,
  verifiedPrice: { metric: "weth/usd:price", value: "$2,438.62", sourceId: "chainlink-feed-eth-usd-mainnet", trustClass: "VERIFIED_ORACLE" },
  executionChainId: 11155111,
  recipient: null,
  recipientPolicy: "self-only",
  creMode: "OFFICIAL CLI SIMULATION",
};

const inputs = (over: Partial<LabInputs> = {}): LabInputs => ({
  build: { stage: "EXPORT_READY", status: "COMPLETED" },
  deterministicSimulationsPassed: true,
  creSimulationPassed: true,
  preflightPassed: true,
  deployment: "READY_TO_ACTIVATE",
  runtime: "HEALTHY",
  cre: "NOT_DEPLOYED",
  policy: { enabled: false, observedAtBlock: "11676531", observedAtMs: 1_789_000_000_000, source: "sepolia rpc" },
  emergencyLockActive: false,
  degradedDependencies: [],
  ...over,
});

function harness(over: Partial<{ inputs: LabInputs; blueprint: ContextLockAgentBlueprint | null; report: SafetyReport | null; archive: "ARCHIVE" | "RECENT_STATE_ONLY" | null; fork: boolean; graphKey: boolean; deployAccess: boolean; snapshot: unknown; shadow: unknown }> = {}) {
  const db: DB = openStudioDb(":memory:");
  const lab = (): LabApiDeps => ({
    db,
    executionChainId: 11155111,
    realityChainId: 1,
    readInputs: async (id) => (id === PROJECT ? (over.inputs ?? inputs()) : null),
    readBlueprint: async (id) => (id === PROJECT ? (over.blueprint === undefined ? BLUEPRINT : over.blueprint) : null),
    readCapabilities: async () => ({
      mainnetReadAvailable: true,
      archiveDepth: over.archive === undefined ? "RECENT_STATE_ONLY" : over.archive,
      forkAvailable: over.fork ?? true,
      // What the real probe reports: the secret name, and the source id it unlocks.
      availableCredentials: new Set(over.graphKey ? ["THEGRAPH_API_KEY", "thegraph-uniswap-v3-mainnet"] : []),
    }),
    readCre: async (id) =>
      id === PROJECT
        ? {
            connection: {
              connected: true, organizationId: "org_test", organizationName: "ContextLock",
              userEmail: null, deployAccess: over.deployAccess ?? false, registries: ["private"], cliVersion: "1.32.0",
              credentialLocation: "local user CRE directory",
            },
            workflowBinaryHash: "800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0",
            productionLimits: true,
            officialSimulationRan: true,
          }
        : null,
    readSafetyReport: async (id) => (id === PROJECT ? (over.report === undefined ? REPORT : over.report) : null),
    readDeterministic: async () => null,
    readSnapshot: async (id) =>
      id === PROJECT ? ((over.snapshot === undefined ? SNAPSHOT : over.snapshot) as typeof SNAPSHOT | null) : null,
    readShadow: async (id) =>
      id === PROJECT ? ((over.shadow === undefined ? SHADOW : over.shadow) as typeof SHADOW | null) : null,
    readDecision: async (id, correlationId) =>
      id === PROJECT && correlationId === DECISION.correlationId ? DECISION : null,
  });

  const { app } = buildServer({ db, lab });
  return { app, db };
}

/* ═════════════════════════ the lifecycle route ═════════════════════════ */

describe("ROUTE-001 the lifecycle route", () => {
  it("ROUTE-001 returns the projection and the inputs it was computed from", async () => {
    const { app } = harness();
    const res = await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/state` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("READY_TO_ACTIVATE");
    expect(body.hasFinancialAuthority).toBe(false);
    // The evidence travels with the answer, so a client that disagrees can see why.
    expect(body.computedFrom).toBeTruthy();
    expect(body.computedFrom.policy.enabled).toBe(false);
    expect(body.headlineClaim).toMatch(/PRODUCTION-CHAIN EXECUTION: DISABLED/);
  });

  it("ROUTE-001b an unknown project is 404, not an empty projection", async () => {
    const { app } = harness();
    const res = await app.inject({ method: "GET", url: "/api/lab/projects/nope/state" });
    expect(res.statusCode).toBe(404);
  });

  it("ROUTE-001c the state follows the inputs, not a stored value", async () => {
    const active = harness({ inputs: inputs({ policy: { enabled: true, observedAtBlock: "1", observedAtMs: 1, source: "chain" } }) });
    const body = (await active.app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/state` })).json();
    expect(body.state).toBe("LAB_ACTIVE");
    expect(body.hasFinancialAuthority).toBe(true);
  });

  it("ROUTE-001d a paused runtime is reported as still holding authority", async () => {
    const paused = harness({
      inputs: inputs({ runtime: "PAUSED", policy: { enabled: true, observedAtBlock: "1", observedAtMs: 1, source: "chain" } }),
    });
    const body = (await paused.app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/state` })).json();
    expect(body.state).toBe("PAUSED");
    expect(body.hasFinancialAuthority).toBe(true);
    expect(body.label.detail).toMatch(/operational stop, not a financial one/);
  });
});

/* ═════════════════════════ summary and permissions ═════════════════════════ */

describe("ROUTE-002 the summary route", () => {
  it("ROUTE-002 derives every figure from the Blueprint", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/summary` })).json();
    expect(body.summary.autonomous).toBe("≤ $1,000");
    expect(body.summary.hardDeny).toBe("> $5,000");
    expect(body.unestablishedBoundaries).toEqual([]);
    // Both halves of the canonical prompt.
    expect(body.summary.perActionLimits.length).toBeGreaterThan(0);
    expect(body.summary.perActionLimits[0].autonomous).toBe("≤ $500");
  });

  it("ROUTE-002b every capability line names the Blueprint field it came from", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/summary` })).json();
    for (const line of body.capabilities) {
      expect(line.derivedFrom.length, line.statement).toBeGreaterThan(0);
    }
    expect(body.capabilities.some((l: { kind: string; statement: string }) => l.kind === "CANNOT" && /production chain/i.test(l.statement))).toBe(true);
  });

  it("ROUTE-002c the two networks come back as separate fields", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/summary` })).json();
    expect(body.networks.marketSource.role).toBe("READ_ONLY_SOURCE");
    expect(body.networks.executionTarget.role).toBe("TESTNET_EXECUTION");
    expect(body.networks.marketSource.roleLabel).toMatch(/READ ONLY/);
  });

  it("ROUTE-002d a project with no Blueprint is 404", async () => {
    const { app } = harness({ blueprint: null });
    expect((await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/summary` })).statusCode).toBe(404);
  });
});

/* ═════════════════════════ reality ═════════════════════════ */

describe("ROUTE-003 the reality route", () => {
  it("ROUTE-003 returns every mode, including the unavailable ones", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: "/api/lab/reality/modes" })).json();
    expect(body.modes.length).toBe(4);
    for (const m of body.modes) {
      if (m.availability !== "AVAILABLE") expect(m.reason, m.mode).toBeTruthy();
    }
  });

  it("ROUTE-003b availability follows real capability, not a flag", async () => {
    const pruned = harness({ archive: "RECENT_STATE_ONLY" });
    const withArchive = harness({ archive: "ARCHIVE" });
    const a = (await pruned.app.inject({ method: "GET", url: "/api/lab/reality/modes" })).json();
    const b = (await withArchive.app.inject({ method: "GET", url: "/api/lab/reality/modes" })).json();
    expect(a.modes.find((m: { mode: string }) => m.mode === "HISTORICAL_REPLAY").availability).toBe("LIMITED");
    expect(b.modes.find((m: { mode: string }) => m.mode === "HISTORICAL_REPLAY").availability).toBe("AVAILABLE");
  });

  it("ROUTE-003c a blocked source never comes back green", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: "/api/lab/reality/modes" })).json();
    const graph = body.sources.find((s: { displayName: string }) => s.displayName === "The Graph");
    expect(graph.status).toBe("UNAVAILABLE");
    expect(graph.tone).not.toBe("GREEN");
    expect(graph.securityImpact).toBe("No fallback substitution occurred");
  });

  it("ROUTE-003d a configured Graph credential changes the answer", async () => {
    const { app } = harness({ graphKey: true });
    const body = (await app.inject({ method: "GET", url: "/api/lab/reality/modes" })).json();
    const graph = body.sources.find((s: { displayName: string }) => s.displayName === "The Graph");
    // The source was verified live with a key (its lifecycle is ACTIVE), so the key is what
    // decides: with it the source is HEALTHY and green, without it UNAVAILABLE (ROUTE-003c).
    expect(graph.status).toBe("HEALTHY");
    expect(graph.tone).toBe("GREEN");
    expect(graph.blocker).toBeNull();
  });

  it("ROUTE-003e the route names configured secrets, never their values or a 'credentials' field", async () => {
    const withKey = (await harness({ graphKey: true }).app.inject({ method: "GET", url: "/api/lab/reality/modes" })).json();
    const without = (await harness().app.inject({ method: "GET", url: "/api/lab/reality/modes" })).json();
    expect(withKey.configuredSecretNames).toEqual(["THEGRAPH_API_KEY"]);
    expect(without.configuredSecretNames).toEqual([]);
    expect(JSON.stringify(withKey)).not.toMatch(/"credentials"/);
  });
});

/* ═════════════════════════ CRE ═════════════════════════ */

describe("ROUTE-004 the CRE route", () => {
  it("ROUTE-004 returns six fields and never a tick", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/cre` })).json();
    for (const f of ["mode", "account", "workflowBinary", "productionLimits", "donDeployment", "hardwareTee"]) {
      expect(Object.keys(body.status), f).toContain(f);
    }
    expect(body.status.donDeployment).toBe("NO");
    expect(body.status.hardwareTee).toBe("NO");
  });

  it("ROUTE-004b absent deploy access reads as a complete state, not an error", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/cre` })).json();
    expect(body.promotion.available).toBe(false);
    expect(body.promotion.message).toMatch(/optional/);
    expect(body.promotion.message).not.toMatch(/error|failed/i);
  });

  it("ROUTE-004c the connection payload carries no session material", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/cre` })).json();
    const json = JSON.stringify(body.connection);
    for (const forbidden of ["sessionToken", "accessToken", "creYaml", "cookie", "password"]) {
      expect(json, forbidden).not.toContain(forbidden);
    }
    expect(body.connection.credentialLocation).toBe("local user CRE directory");
  });
});

/* ═════════════════════════ attacks ═════════════════════════ */

describe("ROUTE-005 the attack routes", () => {
  it("ROUTE-005 the catalogue separates applicable from inapplicable, with the reason", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/attacks` })).json();
    expect(body.applicable.length).toBeGreaterThan(0);
    for (const n of body.notApplicable) expect(n.requires.length).toBeGreaterThan(0);
  });

  it("ROUTE-005b running a scenario drives the real guards", async () => {
    const { app } = harness();
    const res = await app.inject({ method: "POST", url: `/api/lab/projects/${PROJECT}/attacks/MAINNET_WRITE_ATTEMPT/run` });
    expect(res.statusCode).toBe(200);
    const run = res.json();
    expect(run.result).toBe("DENIED");
    expect(run.reasonCode).toBe("PRODUCTION_NETWORK_WRITE_PROHIBITED");
    // The additional defences were exercised, not listed.
    expect(run.additionalDefenses.length).toBeGreaterThan(0);
  });

  it("ROUTE-005c an unknown scenario is 422, not a fabricated pass", async () => {
    const { app } = harness();
    const res = await app.inject({ method: "POST", url: `/api/lab/projects/${PROJECT}/attacks/NOT_A_SCENARIO/run` });
    expect(res.statusCode).toBe(422);
  });

  it("ROUTE-005d an inapplicable scenario is refused rather than run", async () => {
    /*
     * Running one would produce a pass that proves nothing about this agent, and a list of green
     * ticks containing meaningless entries is worse than a shorter honest list.
     */
    const { app } = harness();
    const catalogue = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/attacks` })).json();
    const inapplicable = catalogue.notApplicable[0];
    if (!inapplicable) return;
    const res = await app.inject({ method: "POST", url: `/api/lab/projects/${PROJECT}/attacks/${inapplicable.scenario}/run` });
    expect(res.statusCode).toBe(409);
  });

  it("ROUTE-005e a chain-enforced scenario returns NOT_RUN naming its suite", async () => {
    const { app } = harness();
    const run = (await app.inject({ method: "POST", url: `/api/lab/projects/${PROJECT}/attacks/REPLAY/run` })).json();
    expect(run.result).toBe("NOT_RUN");
    expect(run.path[0].detail).toMatch(/contracts\/test/);
  });
});

/* ═════════════════════════ the safety report ═════════════════════════ */

describe("ROUTE-006 the safety report routes", () => {
  it("ROUTE-006 the private report carries the sections the spec names", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/safety-report` })).json();
    for (const section of ["agent", "execution", "reality", "cre", "runtime", "testing", "deployments", "privacy", "knownBlockers"]) {
      expect(Object.keys(body), section).toContain(section);
    }
    expect(body.privacy.length).toBe(6);
  });

  it("ROUTE-006b the public view is a strict subset, served from its own route", async () => {
    /*
     * The route matters as much as the shape. A UI that filtered the private report client-side
     * would still have fetched it, and the private payload would already be in the browser.
     */
    const { app } = harness();
    const pub = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/safety-report/public` })).json();
    for (const forbidden of ["deployments", "runtime", "reality", "knownBlockers"]) {
      expect(Object.keys(pub), forbidden).not.toContain(forbidden);
    }
    expect(pub.execution.productionChainExecution).toBe("DISABLED");
    expect(pub.privacy.length).toBe(6);
  });

  it("ROUTE-006c a project with no report is 404 on both routes", async () => {
    const { app } = harness({ report: null });
    expect((await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/safety-report` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/safety-report/public` })).statusCode).toBe(404);
  });
});

/* ═════════════════════════ mounting ═════════════════════════ */

describe("ROUTE-007 the routes are attached only when configured", () => {
  it("ROUTE-007 health reports whether the lab is attached", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: "/api/studio/health" })).json();
    expect(body.lab).toBe("attached");
  });

  it("ROUTE-007b without readers the routes are absent rather than answering emptily", async () => {
    /*
     * Mounting them with stubs would produce a lifecycle that answers questions about a project
     * nobody is tracking — worse than a 404, because it looks like an answer.
     */
    const db = openStudioDb(":memory:");
    const { app } = buildServer({ db });
    const health = (await app.inject({ method: "GET", url: "/api/studio/health" })).json();
    expect(health.lab).toBe("not configured");
    expect((await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/state` })).statusCode).toBe(404);
  });
});

/* ═════════════════════════ the P28 product surfaces ═════════════════════════ */

describe("ROUTE-008 the simulation center", () => {
  it("ROUTE-008 returns four layers, each with what it does not prove", async () => {
    const { app } = harness();
    const res = await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/simulation-center` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.layers).toHaveLength(4);
    for (const l of body.layers) expect(l.doesNotProve.length).toBeGreaterThan(20);
    // The count comes from the report's own testing block, not a literal in the route.
    expect(body.layers[0].total).toBe(REPORT.testing.securitySimulations.total);
  });

  it("ROUTE-008b a machine without a fork provider reports BLOCKED and still passes the required set", async () => {
    const { app } = harness({ fork: false });
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/simulation-center` })).json();
    const forkLayer = body.layers.find((l: { key: string }) => l.key === "FORK_EXECUTION");
    expect(forkLayer.status).toBe("BLOCKED");
    expect(body.requiredPassed).toBe(true);
  });

  it("ROUTE-008c an unrun CRE simulation makes the required set outstanding", async () => {
    const { app } = harness({ inputs: inputs({ creSimulationPassed: false }) });
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/simulation-center` })).json();
    expect(body.requiredPassed).toBe(false);
    expect(body.outstanding).toContain("CRE workflow simulation");
  });
});

describe("ROUTE-009 connecting a CRE account", () => {
  it("ROUTE-009 the connect route describes a flow and accepts nothing", async () => {
    const { app } = harness();
    const res = await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/cre/connect` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.flow.steps.length).toBeGreaterThan(2);
    expect(body.flow.neverRequested).toContain("CRE session token");
    // There is no POST counterpart: nothing here could receive a credential.
    const post = await app.inject({ method: "POST", url: `/api/lab/projects/${PROJECT}/cre/connect`, payload: { sessionToken: "x" } });
    expect(post.statusCode).toBe(404);
  });

  it("ROUTE-009b no response field carries a session, a token or a file path", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/cre/connect` })).json();
    /*
     * Scanned with the never-requested list removed, because that list mentions `cre.yaml` on
     * purpose — it is the enumeration of what ContextLock refuses to ask for. Everything else must
     * not mention it at all.
     */
    const { neverRequested, ...flowRest } = body.flow as { neverRequested: string[] };
    const blob = JSON.stringify({ flow: flowRest, account: body.account });
    expect(blob).not.toMatch(/sessionToken|accessToken|refreshToken|cre\.ya?ml|\/\.cre\//i);
    expect(neverRequested).toContain("cre.yaml");
    expect(body.account.credentialLocation).toBe("local user CRE directory");
  });

  it("ROUTE-009c absent deploy access is a complete state with a note, not an error", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/cre/connect` })).json();
    expect(body.account.deployAccess).toBe("NOT ENABLED");
    expect(body.account.note).toMatch(/official CRE simulator/);
    expect(body.account.simulation).toBe("AVAILABLE");
  });
});

describe("ROUTE-010 promotion parity", () => {
  it("ROUTE-010 with nothing deployed, every fixture is NOT RUN rather than a match", async () => {
    /*
     * §P28.24 through the HTTP surface. The failure mode is a green table certifying a workflow
     * that was never invoked, and it would look exactly like a passing test if the route counted
     * an absent deployed result as agreement.
     */
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/cre/parity` })).json();
    expect(body.result.matched).toBe(0);
    expect(body.result.semanticParity).toBe(false);
    for (const row of body.result.rows) {
      expect(row.notRun).toBe("DEPLOYED");
      expect(row.match).toBe(false);
    }
    expect(body.blocker).toBe("BLK-V2-CRE-DEPLOY");
  });

  it("ROUTE-010b the compared and ignored field sets travel with the result", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/cre/parity` })).json();
    expect(body.result.comparedFields).toContain("verdict");
    expect(body.result.ignoredFields).toContain("providerTimestamp");
  });

  it("ROUTE-010c deploy access flips deployedAvailable without inventing results", async () => {
    const { app } = harness({ deployAccess: true });
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/cre/parity` })).json();
    expect(body.deployedAvailable).toBe(true);
    // Still nothing deployed: availability is not evidence.
    expect(body.result.semanticParity).toBe(false);
  });
});

describe("ROUTE-011 testnet assets and activation", () => {
  it("ROUTE-011 every token requirement says NONE and is not auto-requested", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/token-requirements` })).json();
    expect(body.requirements.length).toBeGreaterThan(0);
    for (const r of body.requirements) {
      expect(r.realWorldValue).toBe("NONE");
      expect(r.automaticallyRequested).toBe(false);
    }
    expect(JSON.stringify(body)).not.toMatch(/usdValue|usdEquivalent|\$\d/);
  });

  it("ROUTE-011b activation readiness returns six rows and the lifecycle state agrees", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/activation-readiness` })).json();
    expect(body.readiness.rows).toHaveLength(6);
    expect(body.readiness.canActivate).toBe(true);
    expect(body.state).toBe("READY_TO_ACTIVATE");
  });

  it("ROUTE-011c an unhealthy runtime blocks activation and names the row", async () => {
    const { app } = harness({ inputs: inputs({ runtime: null }) });
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/activation-readiness` })).json();
    expect(body.readiness.canActivate).toBe(false);
    expect(body.readiness.blockedBy).toContain("Runtime");
  });

  it("ROUTE-011d there is no route that enables the policy", async () => {
    // §P28.29/31: activation runs through the control plane, and the Lab surface has no shortcut.
    const { app } = harness();
    const res = await app.inject({ method: "POST", url: `/api/lab/projects/${PROJECT}/activate` });
    expect(res.statusCode).toBe(404);
  });
});

describe("ROUTE-012 shadow mode and the fork", () => {
  it("ROUTE-012 the run separates what was watched from where it executed", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/shadow` })).json();
    expect(body.run.watching.roleLabel).toMatch(/READ ONLY/);
    expect(body.run.actualExecution.environment).toBe("LOCAL_FORK");
    expect(body.run.publicMainnetTransaction).toBe("NONE");
  });

  it("ROUTE-012b the fork detail carries no explorer URL anywhere in the payload", async () => {
    const { app } = harness();
    const res = await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/shadow` });
    expect(res.body).not.toMatch(/etherscan|blockscout|basescan/i);
    expect(res.json().fork.publicExplorer).toBe("NONE");
  });

  it("ROUTE-012c a project with no recorded shadow run is 404, not an empty panel", async () => {
    const { app } = harness({ shadow: null });
    expect((await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/shadow` })).statusCode).toBe(404);
  });
});

describe("ROUTE-013 market shocks", () => {
  it("ROUTE-013 the base row is real and every other row is synthetic", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/scenarios` })).json();
    expect(body.rows[0].scenario).toBe("BASE");
    expect(body.rows[0].synthetic).toBe(false);
    for (const row of body.rows.slice(1)) expect(row.synthetic).toBe(true);
  });

  it("ROUTE-013b unavailable presets are returned with the reason, not omitted", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/scenarios` })).json();
    expect(body.presets).toHaveLength(6);
    const unavailable = body.presets.filter((p: { applicable: boolean }) => !p.applicable);
    expect(unavailable.length).toBeGreaterThan(0);
    for (const p of unavailable) expect(p.unavailableReason).toBeTruthy();
  });

  it("ROUTE-013c the verdicts come from the policy engine and differ across scenarios", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/scenarios` })).json();
    const verdicts = body.rows.map((r: { verdict: string }) => r.verdict);
    expect(new Set(verdicts).size).toBeGreaterThan(1);
    expect(verdicts).toContain("DENY");
  });

  it("ROUTE-013d the neutralised context fields are disclosed", async () => {
    const { app } = harness();
    const body = (await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/scenarios` })).json();
    expect(body.basis.neutralised).toHaveLength(4);
  });

  it("ROUTE-013e a project with no snapshot is 404 rather than a synthetic base", async () => {
    const { app } = harness({ snapshot: null });
    expect((await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/scenarios` })).statusCode).toBe(404);
  });
});

describe("ROUTE-014 the decision detail", () => {
  it("ROUTE-014 returns the deterministic reason and its plain reading", async () => {
    const { app } = harness();
    const res = await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/decisions/demo-25948265` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reasonCode).toBe("ALLOW_POLICY_MATCH");
    expect(body.reasonPlain).toMatch(/matched the policy/);
  });

  it("ROUTE-014b no private policy value appears in the response", async () => {
    const { app } = harness();
    const res = await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/decisions/demo-25948265` });
    expect(res.body).not.toMatch(/autoLimit|escalationLimit|proprietaryRiskThreshold|CONTEXTLOCK_LAB_CANARY/);
    expect(res.json().withheld).toHaveLength(1);
  });

  it("ROUTE-014c an unknown correlation id is 404, not an empty decision", async () => {
    const { app } = harness();
    expect((await app.inject({ method: "GET", url: `/api/lab/projects/${PROJECT}/decisions/nope` })).statusCode).toBe(404);
  });
});
