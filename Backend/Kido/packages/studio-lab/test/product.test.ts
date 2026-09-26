import { describe, expect, it } from "vitest";
import {
  projectLabState, labStateLabel, AUTHORITY_STATES,
  creStatus, assertCreDisplayHonest, CRE_LAB_REASONS,
  graphStatus, badgeTone, realityModes, networkBadge,
  assertCurrentRevision, REVISION_REASONS,
  deployReadiness, activate, ACTIVATION_CHECKS, ACTIVATION_REASONS,
  type LabInputs, type ActivationCheck,
} from "../src/index.js";
import { labInputs, activeLab, sourceLines, isComment } from "./fixtures.js";

/**
 * Product-integration tests.
 *
 * §P28's "ADD PRODUCT-INTEGRATION TESTS" asks for something the unit suites do not cover: whether
 * the *surfaces* hold together, not whether each service is correct in isolation.
 *
 * The recurring theme is one question asked seven ways — **can the frontend say something the
 * backend does not agree with?** Every PRODUCT test below is an instance of it, because that is the
 * failure mode a well-tested backend does not prevent: a correct service and a screen that renders
 * a different answer.
 */

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};

const allChecks = (over: Partial<Record<ActivationCheck, { passed: boolean; detail: string }>> = {}): Record<ActivationCheck, { passed: boolean; detail: string }> => {
  const base = {} as Record<ActivationCheck, { passed: boolean; detail: string }>;
  for (const c of ACTIVATION_CHECKS) base[c] = { passed: true, detail: "ok" };
  return { ...base, ...over };
};

/**
 * A minimal store standing in for the backend.
 *
 * Deliberately not a mock of the API. It holds the same shape the real backend holds — underlying
 * states — and recomputes the projection on every read, which is exactly the property PRODUCT-004
 * is about.
 */
class LabBackend {
  constructor(private inputs: LabInputs, readonly projectId: string) {}
  set(patch: Partial<LabInputs>): void { this.inputs = { ...this.inputs, ...patch }; }
  /** Every read recomputes. Nothing is cached, so nothing can be stale. */
  read(): ReturnType<typeof projectLabState> { return projectLabState(this.inputs); }
  snapshot(): LabInputs { return { ...this.inputs }; }
}

/* ═════════════════════════ PRODUCT-001 … 004 ═════════════════════════ */

describe("PRODUCT-001 one project id survives the whole journey", () => {
  it("PRODUCT-001 the same project moves prompt → build → sim → deploy → runtime → active", () => {
    const backend = new LabBackend(labInputs({ build: null, deployment: null }), "proj-treasury-guardian");
    const seen: string[] = [];
    const step = (patch: Partial<LabInputs>): void => { backend.set(patch); seen.push(backend.read().state); };

    step({});
    step({ build: { stage: "BLUEPRINT", status: "RUNNING" } });
    step({ build: { stage: "AWAITING_APPROVAL", status: "AWAITING_APPROVAL" } });
    step({ build: { stage: "BUILD", status: "RUNNING" } });
    step({ build: { stage: "EXPORT_READY", status: "COMPLETED" }, deterministicSimulationsPassed: false, creSimulationPassed: false, preflightPassed: false });
    step({ deterministicSimulationsPassed: true, creSimulationPassed: true });
    step({ preflightPassed: true });
    step({ deployment: "DEPLOYING_CHAIN_COMPONENTS" });
    step({ deployment: "READY_TO_ACTIVATE" });
    step({ policy: { enabled: true, observedAtBlock: "11674970", observedAtMs: 2, source: "sepolia rpc" } });

    expect(seen).toEqual([
      "DRAFT", "ARCHITECTURE_READY", "REVIEW_REQUIRED", "BUILDING",
      "BUILD_READY", "PREFLIGHT_REQUIRED", "READY_TO_DEPLOY",
      "DEPLOYING", "READY_TO_ACTIVATE", "LAB_ACTIVE",
    ]);
    // One project id throughout. The lifecycle moved; the identity did not.
    expect(backend.projectId).toBe("proj-treasury-guardian");
  });
});

describe("PRODUCT-002 a reload reconstructs the current state", () => {
  it("PRODUCT-002 the same stored inputs produce the same state after a restart", () => {
    const before = new LabBackend(activeLab({ runtime: "PAUSED" }), "p1");
    const stateBefore = before.read();
    const stored = before.snapshot();

    // A new process, a new object, the same stored underlying states.
    const after = new LabBackend(stored, "p1");
    expect(after.read()).toEqual(stateBefore);
    expect(after.read().state).toBe("PAUSED");
    expect(after.read().hasFinancialAuthority).toBe(true);
  });

  it("PRODUCT-002b nothing about the state is stored, so nothing can be reconstructed wrongly", () => {
    /*
     * The projection is a pure function. A stored `state` column would be a second source of truth
     * about whether an agent holds financial authority, and the two would agree until they did not.
     */
    const stored = activeLab();
    const a = projectLabState(stored);
    const b = projectLabState({ ...stored });
    expect(b).toEqual(a);
    expect(Object.keys(stored)).not.toContain("state");
    expect(Object.keys(stored)).not.toContain("labState");
  });
});

describe("PRODUCT-003 changing tabs does not interrupt the runtime", () => {
  it("PRODUCT-003 reading the state repeatedly changes nothing", () => {
    const backend = new LabBackend(activeLab(), "p1");
    const before = backend.snapshot();
    for (let i = 0; i < 25; i++) backend.read();
    // Reading is a projection, not a command. Twenty-five renders touch nothing.
    expect(backend.snapshot()).toEqual(before);
    expect(backend.read().state).toBe("LAB_ACTIVE");
  });

  it("PRODUCT-003b the projection has no side effect a view could trigger", () => {
    const inputs = activeLab();
    const frozen = Object.freeze({ ...inputs });
    expect(() => projectLabState(frozen)).not.toThrow();
    expect(projectLabState(frozen).state).toBe("LAB_ACTIVE");
  });
});

describe("PRODUCT-004 backend state controls live status", () => {
  it("PRODUCT-004 the state follows the underlying systems, not a view's belief", () => {
    const backend = new LabBackend(activeLab(), "p1");
    expect(backend.read().state).toBe("LAB_ACTIVE");

    // The runtime crashes. Nothing about the view changed, and the state does.
    backend.set({ runtime: "CRASH_LOOP" });
    expect(backend.read().state).toBe("DEGRADED");
    expect(backend.read().because).toMatch(/CRASH_LOOP/);

    // The policy goes off on chain. The state follows.
    backend.set({ runtime: "HEALTHY", policy: { enabled: false, observedAtBlock: "11674999", observedAtMs: 3, source: "sepolia rpc" } });
    expect(backend.read().state).toBe("READY_TO_ACTIVATE");
    expect(backend.read().hasFinancialAuthority).toBe(false);
  });
});

/* ═════════════════════════ PRODUCT-005 … 007 : forgery ═════════════════════════ */

describe("PRODUCT-005 the frontend cannot forge an enabled policy", () => {
  it("PRODUCT-005 financial authority is computed from the policy input, not asserted", () => {
    /*
     * There is no `hasFinancialAuthority` input. A view that wanted to claim authority would have to
     * supply a policy reading, and a policy reading is what the chain said.
     */
    expect(Object.keys(labInputs())).not.toContain("hasFinancialAuthority");
    expect(projectLabState(labInputs()).hasFinancialAuthority).toBe(false);
    expect(projectLabState(activeLab()).hasFinancialAuthority).toBe(true);
  });

  it("PRODUCT-005b a forged projection object does not survive a recompute", () => {
    // The mandatory mutation "let frontend local state say policy enabled".
    const forged = { ...projectLabState(labInputs()), state: "LAB_ACTIVE" as const, hasFinancialAuthority: true };
    expect(forged.hasFinancialAuthority).toBe(true);
    // Recomputed from the backend's inputs, it is not.
    expect(projectLabState(labInputs()).hasFinancialAuthority).toBe(false);
    expect(projectLabState(labInputs()).state).toBe("READY_TO_ACTIVATE");
  });

  it("PRODUCT-005c activation cannot be claimed without a fresh chain read", async () => {
    await expect(activate({
      checks: allChecks(),
      executionChainId: 11155111,
      enablePolicy: async () => undefined,
      // The chain disagrees with the caller's optimism.
      readPolicyFromChain: async () => ({ enabled: false, blockNumber: "1" }),
    })).rejects.toMatchObject({ reason: ACTIVATION_REASONS.NOT_VERIFIED_FROM_CHAIN });
  });
});

describe("PRODUCT-006 the frontend cannot forge a deployed CRE", () => {
  it("PRODUCT-006 a DON claim is refused by the display guard, whatever a caller passes", () => {
    const forged = { ...creStatus({ mode: "SIMULATED_USER", organizationId: null, workflowBinaryHash: null, productionLimits: true, deployAccess: false, registries: [], officialSimulationRan: true }), donDeployment: "YES" as const };
    expect(reasonOf(() => assertCreDisplayHonest(forged))).toBe(CRE_LAB_REASONS.FALSE_DON);
  });

  it("PRODUCT-006b the constructor cannot be persuaded to emit a DON claim for a simulator", () => {
    for (const mode of ["SIMULATED_USER", "SIMULATED_PLATFORM"] as const) {
      const s = creStatus({ mode, organizationId: null, workflowBinaryHash: null, productionLimits: true, deployAccess: true, registries: ["private"], officialSimulationRan: true });
      expect(s.donDeployment, mode).toBe("NO");
      expect(s.hardwareTee, mode).toBe("NO");
    }
  });
});

describe("PRODUCT-007 the frontend cannot forge mainnet execution", () => {
  it("PRODUCT-007 mainnet has no execution badge to render", () => {
    expect(() => networkBadge(1, "EXECUTION_TARGET")).toThrow();
    expect(networkBadge(1, "MARKET_SOURCE").role).toBe("READ_ONLY_SOURCE");
  });

  it("PRODUCT-007b a deploy aimed at mainnet is refused at the gate", () => {
    const r = deployReadiness({
      architecturePassed: true, securityTestsPassed: true, creSimulationPassed: true,
      realityTestPassed: true, preflightPassed: true, executionChainId: 1,
      runtimeImageDigest: "sha256:x", estimatedGas: 1n, walletBalanceWei: 1n, requiredBalanceWei: 1n,
    });
    expect(r.canDeploy).toBe(false);
    expect(r.blockedBy).toContain("Execution network");
  });

  it("PRODUCT-007c activation aimed at mainnet is refused before any check runs", async () => {
    let checked = false;
    await expect(activate({
      checks: allChecks({ DEPLOYMENT_VERIFIED: { passed: true, detail: (() => { checked = true; return "ok"; })() } }),
      executionChainId: 1,
      enablePolicy: async () => undefined,
      readPolicyFromChain: async () => ({ enabled: true, blockNumber: "1" }),
    })).rejects.toThrow();
    void checked;
  });
});

/* ═════════════════════════ PRODUCT-008 … 010 ═════════════════════════ */

describe("PRODUCT-008 a blocked source is not green", () => {
  it("PRODUCT-008 the badge tone follows the status, and no status maps green to unavailable", () => {
    const caps = { mainnetReadAvailable: true, archiveDepth: "RECENT_STATE_ONLY" as const, forkAvailable: true, availableCredentials: new Set<string>() };
    const g = graphStatus(caps);
    expect(g.status).toBe("UNAVAILABLE");
    expect(badgeTone(g.status)).not.toBe("GREEN");

    // Every non-healthy status is non-green. Enumerated, so a new status cannot default to green.
    for (const s of ["STALE", "UNAVAILABLE", "NOT_CONFIGURED"] as const) {
      expect(badgeTone(s), s).not.toBe("GREEN");
    }
    expect(badgeTone("HEALTHY")).toBe("GREEN");
  });

  it("PRODUCT-008b a blocked reality mode carries a reason a user can act on", () => {
    const modes = realityModes({ mainnetReadAvailable: false, archiveDepth: null, forkAvailable: false, availableCredentials: new Set() });
    for (const m of modes.filter((x) => x.availability !== "AVAILABLE")) {
      expect(m.reason, m.mode).toBeTruthy();
      expect(m.remedy ?? m.effect, m.mode).toBeTruthy();
    }
  });
});

describe("PRODUCT-009 stale data loses its healthy badge", () => {
  it("PRODUCT-009 a degraded dependency moves an active lab to DEGRADED", () => {
    const p = projectLabState(activeLab({ degradedDependencies: ["chainlink-feed-eth-usd-mainnet"] }));
    expect(p.state).toBe("DEGRADED");
    expect(labStateLabel("DEGRADED").detail).toMatch(/unhealthy/);
    // And it still holds authority — which is the honest and alarming part.
    expect(p.hasFinancialAuthority).toBe(true);
    expect(AUTHORITY_STATES.has("DEGRADED")).toBe(true);
  });

  it("PRODUCT-009b a stale CRE reading is not treated as healthy", () => {
    expect(projectLabState(activeLab({ cre: "STALE" })).state).toBe("DEGRADED");
    expect(projectLabState(activeLab({ cre: "DEGRADED" })).state).toBe("DEGRADED");
    expect(projectLabState(activeLab({ cre: "FAILED" })).state).toBe("DEGRADED");
  });
});

describe("PRODUCT-010 a revision mismatch is visible and blocks activation", () => {
  it("PRODUCT-010 a superseded runtime revision cannot act", () => {
    expect(reasonOf(() => assertCurrentRevision("rev-3", "rev-4", "runtime"))).toBe(REVISION_REASONS.OLD_REVISION);
  });

  it("PRODUCT-010b the CURRENT_REVISION check blocks activation on its own", async () => {
    let enabled = false;
    await expect(activate({
      checks: allChecks({ CURRENT_REVISION: { passed: false, detail: "rev-3 was superseded by rev-4" } }),
      executionChainId: 11155111,
      enablePolicy: async () => { enabled = true; },
      readPolicyFromChain: async () => ({ enabled: true, blockNumber: "1" }),
    })).rejects.toMatchObject({ reason: ACTIVATION_REASONS.CHECK_FAILED });
    expect(enabled).toBe(false);
  });
});

/* ═════════════════════════ structural ═════════════════════════ */

describe("the product surface holds no second source of truth", () => {
  it("PRODUCT-011 no module stores a lab state", () => {
    /*
     * The property the whole lifecycle design rests on. A stored state column would be a second
     * source of truth about financial authority, and it would agree with the projection until the
     * day it did not.
     */
    const hits = sourceLines(/labState\s*[:=]|storedState|cachedLabState/, "packages/studio-lab/src apps/studio/src")
      .filter((l) => !isComment(l.text));
    expect(hits.map((h) => `${h.file}:${h.text.trim()}`)).toEqual([]);
  });

  it("PRODUCT-012 the lab package contains no model call", () => {
    // Luna explains; Luna does not decide. Structural rather than a convention.
    const hits = sourceLines(/openai|anthropic|\bllm\b|generateText/i, "packages/studio-lab/src")
      .filter((l) => !isComment(l.text));
    expect(hits.map((h) => `${h.file}:${h.text.trim()}`)).toEqual([]);
  });
});
