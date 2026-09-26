import { describe, expect, it } from "vitest";
import {
  LAB_PROJECT_STATES, projectLabState, labStateLabel, AUTHORITY_STATES,
  PRODUCT_MODES, PRODUCT_MODE, productModeDescriptor, assertProductMode, ProductModeError,
  HEADLINE_CLAIM, FORBIDDEN_PRODUCT_CLAIMS,
  buildSummary, capabilityReview, unestablishedBoundaries, assertBoundariesEstablished, SummaryError,
  realityModes, graphStatus, badgeTone, networkBadge, realityDisplay, BadgeError, BADGE_REASONS,
  creStatus, assertCreDisplayHonest, defaultCreMode, platformModeAvailability,
  CRE_LAB_REASONS, CreLabError, CRE_DISPLAY_FIELDS, NEVER_REQUESTED,
  assertNoCreSession, CreConnectionInfoSchema, promotionAvailability,
  assertRegistryAllowed, PERMITTED_REGISTRIES, assertArtifactUnchanged, assertNoSilentFailover,
  assertPromotionKeepsBoundary, PromotionArtifactSchema,
  deployReadiness, costBreakdown, DEPLOY_PHASES, FORBIDDEN_COST_FIELDS, CONTROL_SEMANTICS,
  activate, ACTIVATION_CHECKS, ActivationError, ACTIVATION_REASONS, assertPauseNotDescribedAsSecure,
  ATTACKS, applicableAttacks, buildSecurityPath, assembleAttackRun, assertDefensesExercised,
  attackSummary, SECURITY_LAYERS, AttackLabError, ATTACK_REASONS,
  markStale, securityDiff, authorityExpansions, assertNotLiveMutation, assertNoStaleArtifacts,
  assertCurrentRevision, RevisionError, REVISION_REASONS, REVISION_KINDS,
  sealSafetyReport, publicSafetyView, scanForSecrets, assertReportSecretFree,
  assertPrivacyClaimsEvidenced, SafetyReportError, REPORT_REASONS, PRIVACY_CLAIMS, PUBLIC_VIEW_FORBIDDEN,
  type ActivationCheck, type SecurityLayer,
} from "../src/index.js";
import { executionNetworks, lookupNetwork } from "@contextlock/studio-network";
import { guardian, treasuryGuardian, labInputs, activeLab, safetyReportInput, privacyClaims, sourceLines, isComment } from "./fixtures.js";

/**
 * The Testnet Lab.
 *
 * The standing rule from FND-V2-25-002 governs every multi-guard function here: **a fixture that
 * trips two independent guards proves neither guard.** Where a function has N guards there are N
 * tests, each differing from a valid input in exactly one way.
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

/* ═════════════════════════ LAB-001 … 002 : lifecycle ═════════════════════════ */

describe("LAB-001 the lifecycle state is deterministic", () => {
  it("LAB-001 the projection is a pure function of the underlying states", () => {
    const inputs = labInputs();
    const a = projectLabState(inputs);
    const b = projectLabState(inputs);
    expect(b).toEqual(a);
    // Nothing is stored: same inputs, same answer, no clock and no I/O.
    expect(a.state).toBe("READY_TO_ACTIVATE");
    expect(a.because).toMatch(/policy is disabled/);
  });

  it("LAB-001b every state is reachable from real underlying states", () => {
    const cases: Array<[string, ReturnType<typeof labInputs>]> = [
      ["DRAFT", labInputs({ build: null, deployment: null })],
      ["REVIEW_REQUIRED", labInputs({ build: { stage: "AWAITING_APPROVAL", status: "AWAITING_APPROVAL" }, deployment: null })],
      ["BUILDING", labInputs({ build: { stage: "BUILD", status: "RUNNING" }, deployment: null })],
      ["ARCHITECTURE_READY", labInputs({ build: { stage: "BLUEPRINT", status: "RUNNING" }, deployment: null })],
      ["BUILD_READY", labInputs({ deterministicSimulationsPassed: false, deployment: null })],
      ["PREFLIGHT_REQUIRED", labInputs({ preflightPassed: false, deployment: null })],
      ["READY_TO_DEPLOY", labInputs({ deployment: null })],
      ["DEPLOYING", labInputs({ deployment: "DEPLOYING_CHAIN_COMPONENTS" })],
      ["READY_TO_ACTIVATE", labInputs()],
      ["LAB_ACTIVE", activeLab()],
      ["PAUSED", activeLab({ runtime: "PAUSED" })],
      ["DEGRADED", activeLab({ runtime: "DEGRADED" })],
      ["EMERGENCY_LOCKED", labInputs({ emergencyLockActive: true })],
      ["FAILED", labInputs({ deployment: "DEPLOYMENT_FAILED_TERMINAL" })],
    ];
    for (const [expected, inputs] of cases) {
      expect(projectLabState(inputs).state, expected).toBe(expected);
    }
    // Every state in the union is either produced above or is SIMULATION_READY, the pass-through.
    const produced = new Set(cases.map(([s]) => s));
    const unproduced = LAB_PROJECT_STATES.filter((s) => !produced.has(s));
    expect(unproduced).toEqual(["SIMULATION_READY"]);
  });

  it("LAB-001c the most alarming true statement wins", () => {
    /*
     * An emergency lock over a perfectly healthy active lab. A projection that reported the most
     * flattering true statement would be accurate and useless.
     */
    const healthyButLocked = activeLab({ emergencyLockActive: true });
    expect(projectLabState(healthyButLocked).state).toBe("EMERGENCY_LOCKED");
    expect(projectLabState(healthyButLocked).hasFinancialAuthority).toBe(false);

    const passingButFailed = labInputs({ deployment: "DEPLOYMENT_FAILED_TERMINAL", deterministicSimulationsPassed: true });
    expect(projectLabState(passingButFailed).state).toBe("FAILED");
  });

  it("LAB-001d a paused runtime keeps financial authority, and says so", () => {
    /*
     * The distinction §P28.45 exists for. A projection reporting PAUSED as safe would teach exactly
     * the misunderstanding the control panel is built to prevent — the container is stopped and the
     * policy is one unpause away from acting.
     */
    const p = projectLabState(activeLab({ runtime: "PAUSED" }));
    expect(p.state).toBe("PAUSED");
    expect(p.hasFinancialAuthority).toBe(true);
    expect(p.because).toMatch(/policy is still ENABLED/);
    expect(labStateLabel("PAUSED").detail).toMatch(/operational stop, not a financial one/);
  });

  it("LAB-001e a paused runtime BEFORE activation is not PAUSED, it is not-yet-activated", () => {
    // The same runtime state means different things either side of activation.
    const p = projectLabState(labInputs({ runtime: "PAUSED" }));
    expect(p.state).toBe("READY_TO_ACTIVATE");
    expect(p.hasFinancialAuthority).toBe(false);
  });

  it("LAB-001f only three states carry financial authority, and the projection agrees", () => {
    expect([...AUTHORITY_STATES].sort()).toEqual(["DEGRADED", "LAB_ACTIVE", "PAUSED"]);
    for (const state of LAB_PROJECT_STATES) {
      const label = labStateLabel(state);
      expect(label.headline.length, state).toBeGreaterThan(0);
      expect(label.detail.length, state).toBeGreaterThan(0);
    }
  });

  it("LAB-001g a degraded dependency does not silently keep the lab green", () => {
    const p = projectLabState(activeLab({ degradedDependencies: ["chainlink-feed-eth-usd-mainnet"] }));
    expect(p.state).toBe("DEGRADED");
    expect(p.hasFinancialAuthority).toBe(true);
    expect(p.because).toMatch(/chainlink-feed-eth-usd-mainnet/);
  });
});

describe("LAB-002 a project starts from a prompt", () => {
  it("LAB-002 an unbuilt project is DRAFT and says what to do next", () => {
    const p = projectLabState(labInputs({ build: null, deployment: null }));
    expect(p.state).toBe("DRAFT");
    expect(p.nextAction).toMatch(/Describe the agent/);
  });

  it("LAB-002b there is one product mode and no production mode to switch into", () => {
    expect([...PRODUCT_MODES]).toEqual(["CONTEXTLOCK_TESTNET_LAB"]);
    expect(assertProductMode(PRODUCT_MODE)).toBe(PRODUCT_MODE);
    for (const invented of ["PRODUCTION", "MAINNET", "CONTEXTLOCK_MAINNET", "LIVE"]) {
      expect(() => assertProductMode(invented), invented).toThrow(ProductModeError);
    }
  });

  it("LAB-002c the mode descriptor is derived from the enforcing modules", () => {
    const d = productModeDescriptor();
    expect(d.execution.networks.map((n) => n.chainId).sort((a, b) => a - b)).toEqual(executionNetworks().map((n) => n.chainId).sort((a, b) => a - b));
    expect(d.mainnet.access).toBe("READ_ONLY");
    expect(d.productionChainExecution).toBe("DISABLED");
    for (const n of d.execution.networks) expect(n.role, n.name).not.toBe("READ_ONLY_SOURCE");
  });
});

/* ═════════════════════════ LAB-003 … 006 : derivation ═════════════════════════ */

describe("LAB-003 the permissions view derives from the Blueprint", () => {
  it("LAB-003 every CAN line traces to a Blueprint field", () => {
    const bp = guardian();
    const lines = capabilityReview(bp, 11155111);
    const cans = lines.filter((l) => l.kind === "CAN");
    expect(cans.length).toBeGreaterThan(0);
    for (const l of cans) {
      expect(l.derivedFrom, l.statement).toMatch(/^(permissions\.allowed|autonomousPolicy|contextSources|adapters)/);
    }
    // Every allowed permission appears, verbatim.
    for (const p of bp.permissions.allowed) {
      expect(cans.some((l) => l.statement === p.statement), p.statement).toBe(true);
    }
  });

  it("LAB-003b the summary reads its numbers from the Blueprint, not from prose", () => {
    const bp = treasuryGuardian();
    const s = buildSummary(bp, 11155111, 1);
    expect(s.autonomous).toBe("≤ $1,000");
    expect(s.humanApproval).toBe("$1,000 – $5,000");
    expect(s.hardDeny).toBe("> $5,000");
    expect(s.blueprintRevision).toBe(bp.revision);
  });

  it("LAB-003c an unestablished limit is reported as UNKNOWN, never defaulted", () => {
    /*
     * §P28.4: the system may infer required categories and must not invent financial boundaries.
     * A default here would be a limit nobody chose.
     */
    const bp = guardian({ autonomousPolicy: { maxValueUsdCents: { known: false, reason: "the user did not say", requiredBefore: "DEPLOY" }, allowedActionRefs: [] } });
    const s = buildSummary(bp, 11155111, 1);
    expect(s.autonomous).toMatch(/UNKNOWN/);
    expect(unestablishedBoundaries(bp)).toContain("autonomous limit");
    expect(reasonOf(() => assertBoundariesEstablished(bp, "deploy"))).toBe("FINANCIAL_BOUNDARY_NOT_ESTABLISHED");
  });

  it("LAB-003d a complete Blueprint passes the boundary check", () => {
    expect(() => assertBoundariesEstablished(treasuryGuardian(), "deploy")).not.toThrow();
    expect(unestablishedBoundaries(treasuryGuardian())).toEqual([]);
  });
});

describe("LAB-004 forbidden abilities derive from the Blueprint", () => {
  it("LAB-004 every explicit denial appears verbatim", () => {
    const bp = guardian();
    const cannots = capabilityReview(bp, 11155111).filter((l) => l.kind === "CANNOT");
    for (const d of bp.permissions.denied) {
      expect(cannots.some((l) => l.statement === d.statement), d.statement).toBe(true);
    }
  });

  it("LAB-004b the CANNOT list is not the complement of the CAN list", () => {
    /*
     * The design point. "We never mentioned withdrawals" and "withdrawals are forbidden" produce
     * identical allow lists and very different agents; a screen computing denials by subtraction
     * would show the same reassuring text for both.
     */
    const bp = guardian();
    const lines = capabilityReview(bp, 11155111);
    const cans = lines.filter((l) => l.kind === "CAN").map((l) => l.statement);
    const cannots = lines.filter((l) => l.kind === "CANNOT").map((l) => l.statement);
    // No CANNOT is merely a negated CAN.
    for (const c of cannots) {
      expect(cans.some((a) => c.includes(a)), `"${c}" looks derived from an allow entry`).toBe(false);
    }
    expect(bp.permissions.denied.length).toBeGreaterThan(0);
  });

  it("LAB-004c three denials come from the product boundary, not the Blueprint", () => {
    const cannots = capabilityReview(guardian(), 11155111).filter((l) => l.kind === "CANNOT");
    expect(cannots.some((l) => /production chain/i.test(l.statement))).toBe(true);
    expect(cannots.some((l) => /hard deny, not a higher approval tier/.test(l.statement))).toBe(true);
    expect(cannots.some((l) => /Change its own limits/.test(l.statement))).toBe(true);
  });

  it("LAB-004d no capability line is produced by a model", () => {
    // Structural: the module imports nothing that could call one.
    const src = sourceLines(/from "@contextlock\/studio-agents"|openai|anthropic/i, "packages/studio-lab/src");
    expect(src.map((l) => `${l.file}:${l.text.trim()}`)).toEqual([]);
  });
});

describe("LAB-005 the architecture uses the canonical Blueprint", () => {
  it("LAB-005 the summary's protocols and adapters come from the Blueprint", () => {
    const bp = guardian();
    const s = buildSummary(bp, 11155111, 1);
    expect(s.protocols).toEqual(bp.protocols.map((p) => p.displayName));
    for (const v of s.verifiedMarketData) {
      expect(bp.adapters.some((a) => `${a.adapterId}@${a.adapterVersion}` === v), v).toBe(true);
    }
  });
});

describe("LAB-006 market reality and execution network stay separate", () => {
  it("LAB-006 the two badges are distinct fields, never one list", () => {
    const d = realityDisplay({ marketChainId: 1, executionChainId: 11155111 });
    expect(d.marketSource.purpose).toBe("MARKET_SOURCE");
    expect(d.marketSource.role).toBe("READ_ONLY_SOURCE");
    expect(d.marketSource.roleLabel).toMatch(/READ ONLY/);
    expect(d.executionTarget.purpose).toBe("EXECUTION_TARGET");
    expect(d.executionTarget.role).toBe("TESTNET_EXECUTION");
    expect(d.marketSource.chainId).not.toBe(d.executionTarget.chainId);
  });

  it("LAB-006b a network cannot be displayed without its role", () => {
    // §P28.9: never "Network: Ethereum" with no role. There is no way to build such a badge.
    expect(reasonOf(() => networkBadge(999_999, "MARKET_SOURCE"))).toBe(BADGE_REASONS.ROLELESS);
    const b = networkBadge(1, "MARKET_SOURCE");
    expect(b.roleLabel.length).toBeGreaterThan(0);
    expect(b.role).toBe("READ_ONLY_SOURCE");
  });

  it("LAB-006c mainnet cannot be displayed as an execution target", () => {
    /*
     * The mandatory mutation "merge mainnet data network and execution network". The merge is not
     * refused by a label check — it is refused because a READ_ONLY_SOURCE has no execution badge.
     */
    expect(reasonOf(() => networkBadge(1, "EXECUTION_TARGET"))).toBe(BADGE_REASONS.MERGED);
  });

  it("LAB-006d a local fork's badge says local only, and names what it forked", () => {
    const b = networkBadge(31337, "EXECUTION_TARGET", 1);
    expect(b.roleLabel).toMatch(/LOCAL MAINNET FORK/);
    expect(b.roleLabel).toMatch(/NO PUBLIC TRANSACTIONS/);
  });

  it("LAB-006e the headline claim is enforceable rather than merely true", () => {
    // §P28.32: "Real capital at risk: $0" is a statement about the world; this is about the system.
    expect(HEADLINE_CLAIM).toMatch(/PRODUCTION-CHAIN EXECUTION: DISABLED/);
    expect([...FORBIDDEN_PRODUCT_CLAIMS]).toContain("Real capital at risk: $0");
    expect([...FORBIDDEN_PRODUCT_CLAIMS]).toContain("Live Mainnet Agent");
  });

  it("LAB-006f no forbidden product claim appears in code outside the lists that forbid it", () => {
    /*
     * The strings necessarily exist in the two files that DECLARE them — a forbidden-label list has
     * to contain the labels. Those files are excluded by name rather than by a pattern that would
     * also excuse a genuine occurrence, and LAB-006e separately asserts the lists still contain the
     * entries, so excluding them here cannot hide a deletion.
     */
    const DECLARING_FILES = ["packages/studio-network/src/roles.ts", "packages/studio-lab/src/mode.ts"];
    for (const claim of ["Live Mainnet Agent", "Real capital at risk", "Mainnet Execution"]) {
      const hits = sourceLines(new RegExp(claim))
        .filter((l) => !isComment(l.text))
        .filter((l) => !DECLARING_FILES.includes(l.file));
      expect(hits.map((h) => `${h.file}:${h.text.trim()}`), claim).toEqual([]);
    }
    // Not vacuous: the scan does find the declarations.
    expect(sourceLines(/Live Mainnet Agent/).length).toBeGreaterThan(0);
  });
});

/* ═════════════════════════ LAB-007 … 008 : honest degraded states ═════════════════════════ */

const caps = (over: Partial<Parameters<typeof realityModes>[0]> = {}): Parameters<typeof realityModes>[0] => ({
  mainnetReadAvailable: true,
  archiveDepth: "RECENT_STATE_ONLY",
  forkAvailable: true,
  availableCredentials: new Set<string>(),
  ...over,
});

describe("LAB-007 The Graph's unavailable state is honest", () => {
  it("LAB-007 an unavailable Graph reports why, what is lost, and that nothing replaced it", () => {
    const s = graphStatus(caps());
    expect(s.status).toBe("UNAVAILABLE");
    expect(s.reason).toBe("API authentication required");
    expect(s.effect).toBe("Historical indexed context not included");
    // The claim that matters when a source is missing.
    expect(s.securityImpact).toBe("No fallback substitution occurred");
    expect(s.blocker).toBe("BLK-V2-GRAPH-KEY");
  });

  it("LAB-007b an unavailable source never renders green", () => {
    /*
     * The mandatory mutation "treat missing Graph key as empty successful result". A missing source
     * that renders as healthy-with-no-data is the substitution failure wearing a different coat.
     */
    expect(badgeTone(graphStatus(caps()).status)).not.toBe("GREEN");
    expect(badgeTone("UNAVAILABLE")).toBe("AMBER");
    expect(badgeTone("STALE")).toBe("AMBER");
    expect(badgeTone("HEALTHY")).toBe("GREEN");
  });

  it("LAB-007c the mirror stays available and states what is missing from it", () => {
    const mirror = realityModes(caps()).find((m) => m.mode === "LIVE_MAINNET_MIRROR");
    expect(mirror?.availability).toBe("AVAILABLE");
    expect(mirror?.effect).toMatch(/nothing was substituted for it/);
    expect(mirror?.blocker).toBe("BLK-V2-GRAPH-KEY");
  });
});

describe("LAB-008 archive replay's unavailable state is honest", () => {
  it("LAB-008 a pruned endpoint makes replay LIMITED, with the reason and the remedy", () => {
    const replay = realityModes(caps()).find((m) => m.mode === "HISTORICAL_REPLAY");
    expect(replay?.availability).toBe("LIMITED");
    expect(replay?.blocker).toBe("BLK-V2-ARCHIVE-RPC");
    expect(replay?.reason).toMatch(/RECENT_STATE_ONLY/);
    expect(replay?.remedy).toMatch(/archive RPC/);
    expect(replay?.effect).toMatch(/not run and labelled replay/);
  });

  it("LAB-008b an unknown depth is LIMITED too — never checked is not the same as fine", () => {
    const replay = realityModes(caps({ archiveDepth: null })).find((m) => m.mode === "HISTORICAL_REPLAY");
    expect(replay?.availability).toBe("LIMITED");
    expect(replay?.reason).toMatch(/not configured/);
  });

  it("LAB-008c an archive endpoint makes it AVAILABLE — so the check is not always-refuse", () => {
    const replay = realityModes(caps({ archiveDepth: "ARCHIVE" })).find((m) => m.mode === "HISTORICAL_REPLAY");
    expect(replay?.availability).toBe("AVAILABLE");
    expect(replay?.blocker).toBeNull();
  });

  it("LAB-008d no mode is hidden — every one is returned, including the unavailable", () => {
    // §P28.8: do not hide disabled options, explain them. A hidden option carries no reason.
    const modes = realityModes(caps({ forkAvailable: false, mainnetReadAvailable: false }));
    expect(modes.map((m) => m.mode).sort()).toEqual(["HISTORICAL_REPLAY", "LIVE_MAINNET_MIRROR", "LOCAL_MAINNET_FORK", "SYNTHETIC"]);
    for (const m of modes) {
      if (m.availability !== "AVAILABLE") expect(m.reason, m.mode).not.toBeNull();
    }
  });

  it("LAB-008e the synthetic mode is available and says it is weaker", () => {
    const synth = realityModes(caps()).find((m) => m.mode === "SYNTHETIC");
    expect(synth?.availability).toBe("AVAILABLE");
    expect(synth?.effect).toMatch(/USER_UNTRUSTED/);
  });
});

/* ═════════════════════════ LAB-010 … 017 : CRE ═════════════════════════ */

const status = (over: Partial<Parameters<typeof creStatus>[0]> = {}) =>
  creStatus({
    mode: "SIMULATED_USER",
    organizationId: "org_ENDgZRZzalm3d3So",
    workflowBinaryHash: "800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0",
    productionLimits: true,
    deployAccess: false,
    registries: ["private"],
    officialSimulationRan: true,
    ...over,
  });

describe("LAB-010 official CRE simulation is integrated", () => {
  it("LAB-010 the status names the mode, the account and the artifact", () => {
    const s = status();
    expect(s.mode).toBe("OFFICIAL CLI SIMULATION");
    expect(s.account).toBe("Local user session");
    expect(s.workflowBinary).toMatch(/^800d0d56/);
  });

  it("LAB-011 production limits are displayed, not assumed", () => {
    expect(status().productionLimits).toBe("ENABLED");
    expect(status({ productionLimits: false }).productionLimits).toBe("DISABLED");
  });

  it("LAB-010b the status has six fields and cannot collapse to a tick", () => {
    // §P28.14: never "CRE Connected ✓" without semantics.
    const s = status();
    for (const field of CRE_DISPLAY_FIELDS) expect(Object.keys(s), field).toContain(field);
    expect(CRE_DISPLAY_FIELDS.length).toBe(6);
  });
});

describe("LAB-012 no false DON claim", () => {
  it("LAB-012 a simulated mode reports DON deployment NO", () => {
    expect(status().donDeployment).toBe("NO");
    expect(status({ mode: "SIMULATED_PLATFORM" }).donDeployment).toBe("NO");
  });

  it("LAB-012b guard one alone: a simulated status claiming a DON is refused", () => {
    /*
     * The mandatory mutation "turn CRE simulation label into DON deployed". The TEE fields are
     * honest here, so only the DON guard can fire.
     */
    const bad = { ...status(), donDeployment: "YES" as const };
    expect(reasonOf(() => assertCreDisplayHonest(bad))).toBe(CRE_LAB_REASONS.FALSE_DON);
  });

  it("LAB-012c an honest status passes, so the guard is not always-refuse", () => {
    expect(() => assertCreDisplayHonest(status())).not.toThrow();
  });
});

describe("LAB-013 no false TEE claim", () => {
  it("LAB-013 both TEE fields are NO in every simulated mode", () => {
    for (const mode of ["SIMULATED_USER", "SIMULATED_PLATFORM"] as const) {
      expect(status({ mode }).hardwareTee, mode).toBe("NO");
      expect(status({ mode }).teeAttestation, mode).toBe("NO");
    }
  });

  it("LAB-013b guard one alone: a TEE claimed with no attestation", () => {
    // DEPLOYED_USER, so the simulated-mode guard cannot fire — the isolated fixture for guard one.
    const bad = { ...status({ mode: "DEPLOYED_USER" }), hardwareTee: "YES" as const, teeAttestation: "NO" as const };
    expect(reasonOf(() => assertCreDisplayHonest(bad))).toBe(CRE_LAB_REASONS.FALSE_TEE);
  });

  it("LAB-013c guard two alone: a simulator claiming a TEE, attestation and all", () => {
    // teeAttestation YES, so guard one is satisfied. A local process is still not a TEE.
    const bad = { ...status(), hardwareTee: "YES" as const, teeAttestation: "YES" as const };
    expect(reasonOf(() => assertCreDisplayHonest(bad))).toBe(CRE_LAB_REASONS.FALSE_TEE);
  });

  it("LAB-013d the generator never produces a true TEE field", () => {
    // The mandatory mutation "turn TEE false into true" cannot be made through the constructor.
    for (const mode of ["SIMULATED_USER", "SIMULATED_PLATFORM", "DEPLOYED_USER"] as const) {
      expect(status({ mode }).hardwareTee, mode).toBe("NO");
    }
  });
});

describe("LAB-014 CRE connection goes through the Local Bridge", () => {
  it("LAB-014 the connection payload has no token field to carry a session in", () => {
    const keys = Object.keys(CreConnectionInfoSchema.shape);
    for (const forbidden of ["token", "sessionToken", "accessToken", "password", "otp", "creYaml"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    expect(keys).toContain("credentialLocation");
  });

  it("LAB-014b ContextLock never asks for a credential directly", () => {
    for (const item of NEVER_REQUESTED) expect(item.length).toBeGreaterThan(0);
    expect([...NEVER_REQUESTED]).toContain("CRE session token");
    expect([...NEVER_REQUESTED]).toContain("cre.yaml");
  });
});

describe("LAB-015 CRE credentials stay on the user's machine", () => {
  it("LAB-015 guard one alone: a session-shaped FIELD NAME with a harmless value", () => {
    expect(reasonOf(() => assertNoCreSession({ project: "x", sessionToken: "not-actually-a-token" }, "export")))
      .toBe(CRE_LAB_REASONS.SESSION_EXPORTED);
  });

  it("LAB-015b guard two alone: a session PATH under an innocuous field name", () => {
    expect(reasonOf(() => assertNoCreSession({ project: "x", notes: "/Users/someone/.cre/cre.yaml" }, "export")))
      .toBe(CRE_LAB_REASONS.SESSION_EXPORTED);
  });

  it("LAB-015c nesting does not hide a session", () => {
    expect(() => assertNoCreSession({ a: { b: [{ c: { accessToken: "x" } }] } }, "container env")).toThrow(CreLabError);
  });

  it("LAB-015d each of the four destinations is checked by name", () => {
    for (const dest of ["project export", "runtime container", "build sandbox", "evidence"]) {
      try { assertNoCreSession({ creYaml: "..." }, dest); } catch (e) {
        expect((e as Error).message, dest).toContain(dest);
      }
    }
  });

  it("LAB-015e a clean payload passes", () => {
    expect(() => assertNoCreSession({ organizationId: "org_x", deployAccess: false, registries: ["private"] }, "export")).not.toThrow();
  });
});

describe("LAB-016 no Deploy Access still permits the Lab", () => {
  const connected = CreConnectionInfoSchema.parse({
    connected: true, organizationId: "org_ENDgZRZzalm3d3So", organizationName: "ContextLock",
    userEmail: null, deployAccess: false, registries: ["private"], cliVersion: "1.32.0",
    credentialLocation: "local user CRE directory",
  });

  it("LAB-016 absent deploy access is a normal state, not an error", () => {
    const a = promotionAvailability(connected);
    expect(a.available).toBe(false);
    expect(a.message).toMatch(/running with the official CRE simulator/);
    expect(a.message).toMatch(/optional/);
    // Not phrased as a failure, and not a red global error.
    expect(a.message).not.toMatch(/error|failed|cannot continue/i);
  });

  it("LAB-016b the lab reaches LAB_ACTIVE with CRE never deployed", () => {
    const p = projectLabState(activeLab({ cre: "NOT_DEPLOYED" }));
    expect(p.state).toBe("LAB_ACTIVE");
    expect(p.hasFinancialAuthority).toBe(true);
  });

  it("LAB-016c a BLOCKED CRE is not unhealthy — it is a precondition, not a fault", () => {
    const p = projectLabState(activeLab({ cre: "BLOCKED" }));
    expect(p.state).toBe("LAB_ACTIVE");
  });

  it("LAB-017 promotion is unavailable without deploy access, and available with it", () => {
    expect(promotionAvailability(connected).available).toBe(false);
    expect(promotionAvailability(connected).blocker).toBe("BLK-V2-CRE-DEPLOY");
    expect(promotionAvailability({ ...connected, deployAccess: true }).available).toBe(true);
    expect(promotionAvailability({ ...connected, connected: false, deployAccess: null }).available).toBe(false);
  });

  it("LAB-013e the platform mode stays internal while its blocker is open", () => {
    const p = platformModeAvailability();
    expect(p.availability).toBe("INTERNAL_ONLY");
    expect(p.blocker).toBe("BLK-CRE-PLATFORM-MULTITENANT");
    expect(p.publicUse).toBe(false);
    // The public default is the user's own login.
    expect(defaultCreMode(false)).toBe("SIMULATED_USER");
    expect(defaultCreMode(true)).toBe("SIMULATED_PLATFORM");
  });
});

/* ═════════════════════════ LAB-018 … 020 : promotion ═════════════════════════ */

describe("LAB-018 the onchain CRE registry is prohibited", () => {
  it("LAB-018 an onchain mainnet registry is refused with the production-write code", () => {
    /*
     * The refusal reuses PRODUCTION_NETWORK_WRITE_PROHIBITED rather than inventing a CRE-specific
     * code, because it is the same prohibition arriving through a different door.
     */
    expect(reasonOf(() => assertRegistryAllowed("onchain:ethereum-mainnet", "promotion"))).toBe("PRODUCTION_NETWORK_WRITE_PROHIBITED");
    for (const r of ["onchain:ethereum", "onchain:mainnet"]) {
      expect(() => assertRegistryAllowed(r, "promotion"), r).toThrow(CreLabError);
    }
  });

  it("LAB-018b the refusal explains why the private registry fits the boundary", () => {
    try { assertRegistryAllowed("onchain:ethereum-mainnet", "promotion"); } catch (e) {
      expect((e as Error).message).toMatch(/on-chain transaction on a production network/);
      expect((e as Error).message).toMatch(/private registry is authorized by the CRE login session/);
    }
  });

  it("LAB-018c the private registry is permitted, so the guard is not always-refuse", () => {
    expect([...PERMITTED_REGISTRIES]).toEqual(["private"]);
    expect(() => assertRegistryAllowed("private", "promotion")).not.toThrow();
  });

  it("LAB-018d an unrecognised registry is refused by default", () => {
    expect(() => assertRegistryAllowed("something-new", "promotion")).toThrow(CreLabError);
  });
});

describe("LAB-019 the prebuilt WASM hash is preserved", () => {
  const approved = PromotionArtifactSchema.parse({
    workflowSourceHash: `sha256:${"1".repeat(64)}`,
    wasmSha256: "800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0",
    workflowConfigHash: `sha256:${"2".repeat(64)}`,
    blueprintRevision: 3, strategyRevision: 7, creCliVersion: "1.32.0",
    simulatedUnderProductionLimits: true,
  });

  it("LAB-019 an unchanged artifact passes", () => {
    expect(() => assertArtifactUnchanged(approved, approved, "promotion")).not.toThrow();
  });

  it("LAB-020 guard one alone: the WASM changed", () => {
    // The mandatory mutation "replace prebuilt WASM after approval".
    const current = { ...approved, wasmSha256: "b".repeat(64) };
    const reason = reasonOf(() => assertArtifactUnchanged(approved, current, "promotion"));
    expect(reason).toBe(CRE_LAB_REASONS.ARTIFACT_CHANGED);
  });

  it("LAB-020b each of the six comparisons fails on its own", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["WASM", { wasmSha256: "c".repeat(64) }],
      ["source", { workflowSourceHash: `sha256:${"d".repeat(64)}` }],
      ["config", { workflowConfigHash: `sha256:${"e".repeat(64)}` }],
      ["Blueprint revision", { blueprintRevision: 4 }],
      ["Strategy revision", { strategyRevision: 8 }],
      ["CRE CLI", { creCliVersion: "1.33.0" }],
    ];
    for (const [what, patch] of cases) {
      const current = { ...approved, ...patch };
      expect(() => assertArtifactUnchanged(approved, current, "promotion"), what).toThrow(CreLabError);
      try { assertArtifactUnchanged(approved, current, "promotion"); } catch (e) {
        expect((e as Error).message, what).toContain(what);
      }
    }
  });

  it("LAB-020c a run without production limits cannot gate a promotion", () => {
    const current = { ...approved, simulatedUnderProductionLimits: false };
    expect(reasonOf(() => assertArtifactUnchanged(approved, current, "promotion"))).toBe(CRE_LAB_REASONS.ARTIFACT_CHANGED);
  });

  it("LAB-020d promotion does not change where the agent executes", () => {
    expect(() => assertPromotionKeepsBoundary(11155111, "promotion")).not.toThrow();
    expect(reasonOf(() => assertPromotionKeepsBoundary(1, "promotion"))).toBe("PRODUCTION_NETWORK_WRITE_PROHIBITED");
  });

  it("LAB-020e a failed deployed CRE does not silently fall back to the simulator", () => {
    // §P28.25: the fallback is legitimate and must be an explicit, labelled choice.
    expect(reasonOf(() => assertNoSilentFailover(false, "DEPLOYED_USER", false, "runtime")))
      .toBe(CRE_LAB_REASONS.DEPLOYED_UNAVAILABLE);
    expect(() => assertNoSilentFailover(false, "DEPLOYED_USER", true, "runtime")).not.toThrow();
    expect(() => assertNoSilentFailover(true, "DEPLOYED_USER", false, "runtime")).not.toThrow();
  });
});

/* ═════════════════════════ LAB-021 … 025 : deploy and activate ═════════════════════════ */

const deployInputs = (over: Partial<Parameters<typeof deployReadiness>[0]> = {}): Parameters<typeof deployReadiness>[0] => ({
  architecturePassed: true,
  securityTestsPassed: true,
  creSimulationPassed: true,
  realityTestPassed: true,
  preflightPassed: true,
  executionChainId: 11155111,
  runtimeImageDigest: "sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5",
  estimatedGas: 400_810n,
  walletBalanceWei: 10n ** 17n,
  requiredBalanceWei: 10n ** 15n,
  ...over,
});

describe("LAB-021 the testnet gas estimate is displayed", () => {
  it("LAB-021 the cost breakdown separates four things and merges none", () => {
    const c = costBreakdown({ estimatedGas: 400_810n, gasPriceWei: 2_000_000_000n, currentBalanceWei: 10n ** 17n, executionChainId: 11155111 });
    expect(c.deployment.estimatedGas).toBe("400810");
    expect(c.deployment.safetyBufferPercent).toBe(20);
    // Integer arithmetic: a float buffer displayed itself as 19.99% in Group E.
    expect(BigInt(c.deployment.recommendedWei)).toBe((400_810n * 2_000_000_000n * 120n) / 100n);
    expect(c.agentExecutionGas.note).toMatch(/Separate from the one-time/);
    expect(c.modelUsage.note).toMatch(/not paid in any chain asset/);
    expect(c.hostingAndCre.note).toMatch(/costs no gas/);
  });

  it("LAB-021b a testnet cost carries no dollar equivalent", () => {
    /*
     * §P28.27: never merge testnet faucet assets with real dollar capital. Testnet ETH has no price,
     * and rendering one teaches the user the balance is money.
     */
    const c = costBreakdown({ estimatedGas: 1n, gasPriceWei: 1n, currentBalanceWei: null, executionChainId: 11155111 });
    const json = JSON.stringify(c);
    for (const field of FORBIDDEN_COST_FIELDS) expect(json, field).not.toContain(field);
    expect(c.deployment.note).toMatch(/no market value/);
    expect(c.deployment.asset).toMatch(/Sepolia/);
  });
});

describe("LAB-022 the policy is disabled during deployment", () => {
  it("LAB-022 the deploy gate states the policy will start disabled", () => {
    const r = deployReadiness(deployInputs());
    expect(r.canDeploy).toBe(true);
    expect(r.policyInitialState).toBe("DISABLED");
    expect(r.mainnetWrites).toBe("PROHIBITED");
    expect(r.gates.find((g) => g.label === "Policy")?.detail).toMatch(/WILL START DISABLED/);
  });

  it("LAB-022b every failing gate is reported, not just the first", () => {
    const r = deployReadiness(deployInputs({ securityTestsPassed: false, creSimulationPassed: false, preflightPassed: false }));
    expect(r.canDeploy).toBe(false);
    expect(r.blockedBy).toEqual(expect.arrayContaining(["Security tests", "CRE simulation", "Deployment preflight"]));
  });

  it("LAB-022c a non-testnet execution network blocks deployment", () => {
    expect(deployReadiness(deployInputs({ executionChainId: 1 })).canDeploy).toBe(false);
    expect(deployReadiness(deployInputs({ executionChainId: 31337 })).canDeploy).toBe(false);
  });

  it("LAB-022d the deployment phases show the policy being configured off", () => {
    const keys = DEPLOY_PHASES.map((p) => p.key);
    expect(keys).toContain("CONFIGURING_POLICY_DISABLED");
    // It ends at READY_TO_ACTIVATE, never at "active".
    expect(keys[keys.length - 1]).toBe("READY_TO_ACTIVATE");
    expect(keys).not.toContain("ACTIVATING");
  });
});

describe("LAB-023 the runtime starts before financial activation", () => {
  it("LAB-023 the runtime phase precedes activation in the phase list", () => {
    const keys = DEPLOY_PHASES.map((p) => p.key);
    expect(keys.indexOf("STARTING_RUNTIME")).toBeLessThan(keys.indexOf("READY_TO_ACTIVATE"));
    expect(keys.indexOf("HEALTH_CHECKS")).toBeLessThan(keys.indexOf("READY_TO_ACTIVATE"));
  });

  it("LAB-023b activation refuses when the runtime is not healthy", () => {
    /*
     * The mandatory mutation "enable policy before runtime health". `enablePolicy` is injected so
     * this asserts it was NOT CALLED — a stronger statement than asserting the function threw.
     */
    let enabled = false;
    return expect(activate({
      checks: allChecks({ RUNTIME_HEALTHY: { passed: false, detail: "the container is CRASH_LOOP" } }),
      executionChainId: 11155111,
      enablePolicy: async () => { enabled = true; },
      readPolicyFromChain: async () => ({ enabled: true, blockNumber: "1" }),
    })).rejects.toMatchObject({ reason: ACTIVATION_REASONS.CHECK_FAILED }).then(() => {
      expect(enabled, "the policy must not have been enabled").toBe(false);
    });
  });
});

describe("LAB-024 the policy is enabled last", () => {
  it("LAB-024 every check runs before the policy is enabled", async () => {
    const order: string[] = [];
    const result = await activate({
      checks: allChecks(),
      executionChainId: 11155111,
      enablePolicy: async () => { order.push("enablePolicy"); },
      readPolicyFromChain: async () => { order.push("readPolicyFromChain"); return { enabled: true, blockNumber: "11674970" }; },
    });
    expect(order).toEqual(["enablePolicy", "readPolicyFromChain"]);
    expect(result.policyEnabled).toBe(true);
    expect(result.checks.length).toBe(ACTIVATION_CHECKS.length);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("LAB-024b each of the eight checks blocks activation on its own", async () => {
    for (const check of ACTIVATION_CHECKS) {
      let enabled = false;
      await expect(activate({
        checks: allChecks({ [check]: { passed: false, detail: "failed" } } as never),
        executionChainId: 11155111,
        enablePolicy: async () => { enabled = true; },
        readPolicyFromChain: async () => ({ enabled: true, blockNumber: "1" }),
      })).rejects.toThrow(ActivationError);
      expect(enabled, check).toBe(false);
    }
  });

  it("LAB-024c activation on a production chain is refused before any check runs", async () => {
    await expect(activate({
      checks: allChecks(),
      executionChainId: 1,
      enablePolicy: async () => undefined,
      readPolicyFromChain: async () => ({ enabled: true, blockNumber: "1" }),
    })).rejects.toThrow(ActivationError);
  });
});

describe("LAB-025 a fresh chain read proves activation", () => {
  it("LAB-025 the enabled state is read back from chain", async () => {
    let read = 0;
    const r = await activate({
      checks: allChecks(),
      executionChainId: 11155111,
      enablePolicy: async () => undefined,
      readPolicyFromChain: async () => { read += 1; return { enabled: true, blockNumber: "11674970" }; },
    });
    expect(read).toBe(1);
    expect(r.verifiedAtBlock).toBe("11674970");
  });

  it("LAB-025b a submitted transaction that did not take effect is not an activation", async () => {
    /*
     * The mandatory mutation "remove fresh activation chain read". A transaction that was submitted
     * may revert, be replaced, or still be pending — the only evidence is the chain saying so.
     */
    await expect(activate({
      checks: allChecks(),
      executionChainId: 11155111,
      enablePolicy: async () => undefined,
      readPolicyFromChain: async () => ({ enabled: false, blockNumber: "11674971" }),
    })).rejects.toMatchObject({ reason: ACTIVATION_REASONS.NOT_VERIFIED_FROM_CHAIN });
  });

  it("LAB-040 a policy state with no block is not a reading", () => {
    const p = projectLabState(activeLab({ policy: { enabled: true, observedAtBlock: null, observedAtMs: 1, source: "local cache" } }));
    // Still LAB_ACTIVE — the projection reports what it was told — but the source is visible.
    expect(p.state).toBe("LAB_ACTIVE");
    expect(labInputs().policy?.source).toBeTypeOf("string");
  });
});

/* ═════════════════════════ LAB-028 … 033 : the Attack Lab ═════════════════════════ */

describe("the Attack Lab", () => {
  it("LAB-033 the security path names the layer that stopped it, and marks later layers NOT_REACHED", () => {
    /*
     * §P28.37: do not fake checks that were not exercised. A layer that was never consulted did not
     * approve anything, and rendering it green would credit a control that did no work.
     */
    const path = buildSecurityPath([
      { layer: "PROMPT", outcome: "PASS" },
      { layer: "BLUEPRINT", outcome: "PASS" },
      { layer: "CRE_SIMULATION", outcome: "PASS" },
      { layer: "CONTEXTLOCK_POLICY", outcome: "DENY", reasonCode: "RECIPIENT_NOT_ALLOWED" },
      { layer: "CAPABILITY_ISSUER", outcome: "PASS" },
      { layer: "EXECUTOR", outcome: "PASS" },
    ]);
    expect(path.find((s) => s.layer === "CONTEXTLOCK_POLICY")?.outcome).toBe("DENY");
    expect(path.find((s) => s.layer === "CAPABILITY_ISSUER")?.outcome).toBe("NOT_REACHED");
    expect(path.find((s) => s.layer === "EXECUTOR")?.outcome).toBe("NOT_REACHED");
    // NOT_REACHED carries no reason code — it is not a result.
    expect(path.find((s) => s.layer === "EXECUTOR")?.reasonCode).toBeNull();
  });

  it("LAB-029 a recipient mutation is denied, and the run says where", () => {
    const def = ATTACKS.find((a) => a.scenario === "RECIPIENT_MUTATION")!;
    const run = assembleAttackRun({
      definition: def,
      path: buildSecurityPath([
        { layer: "CRE_SIMULATION", outcome: "PASS" },
        { layer: "CONTEXTLOCK_POLICY", outcome: "DENY", reasonCode: "RECIPIENT_NOT_ALLOWED" },
        { layer: "CAPABILITY_ISSUER", outcome: "PASS" },
      ]),
      diffs: [{ field: "recipient", original: "0xTreasury", mutated: "0xAttacker" }],
      capabilityIssued: false,
      transactionSubmitted: false,
    });
    expect(run.result).toBe("DENIED");
    expect(run.stoppedBy).toBe("CONTEXTLOCK_POLICY");
    expect(run.reasonCode).toBe("RECIPIENT_NOT_ALLOWED");
    expect(run.stoppedWhereExpected).toBe(true);
    expect(run.capabilityIssued).toBe(false);
    expect(run.transactionSubmitted).toBe(false);
    expect(attackSummary(run)).toMatch(/DENIED by CONTEXTLOCK_POLICY/);
  });

  it("LAB-030 an amount mutation shows the exact changed field", () => {
    const def = ATTACKS.find((a) => a.scenario === "AMOUNT_MUTATION")!;
    const run = assembleAttackRun({
      definition: def,
      path: buildSecurityPath([{ layer: "CONTEXTLOCK_POLICY", outcome: "DENY", reasonCode: "DENY_AMOUNT_TOO_HIGH" }]),
      diffs: [{ field: "amount", original: "500000000", mutated: "50000000000" }],
      capabilityIssued: false, transactionSubmitted: false,
    });
    expect(run.diffs[0]?.field).toBe("amount");
    expect(run.diffs[0]?.original).not.toBe(run.diffs[0]?.mutated);
  });

  it("LAB-031 a replay is denied at the executor, further down than a policy denial", () => {
    const def = ATTACKS.find((a) => a.scenario === "REPLAY")!;
    const run = assembleAttackRun({
      definition: def,
      path: buildSecurityPath([
        { layer: "CONTEXTLOCK_POLICY", outcome: "PASS" },
        { layer: "CAPABILITY_ISSUER", outcome: "PASS" },
        { layer: "EXECUTOR", outcome: "DENY", reasonCode: "AuthorizationAlreadyUsed" },
      ]),
      diffs: [{ field: "nonce", original: "7", mutated: "7" }],
      capabilityIssued: true, transactionSubmitted: true,
    });
    expect(run.stoppedBy).toBe("EXECUTOR");
    expect(run.stoppedWhereExpected).toBe(true);
    // A replay legitimately gets a capability — it is a *reused* one. The path shows that.
    expect(run.capabilityIssued).toBe(true);
  });

  it("LAB-032 the mainnet write attack is denied, and only tested defenses are listed", () => {
    const def = ATTACKS.find((a) => a.scenario === "MAINNET_WRITE_ATTEMPT")!;
    const exercised = new Set<SecurityLayer>(["STRATEGY_COMPILER", "EXECUTION_PLANNER", "RELAYER", "RPC_TRANSPORT"]);
    const additional = [
      { layer: "EXECUTION_PLANNER" as const, reasonCode: "PRODUCTION_NETWORK_WRITE_PROHIBITED" },
      { layer: "RELAYER" as const, reasonCode: "PRODUCTION_NETWORK_WRITE_PROHIBITED" },
      { layer: "RPC_TRANSPORT" as const, reasonCode: "RPC_WRITE_METHOD_PROHIBITED" },
    ];
    assertDefensesExercised(additional, exercised, "mainnet write attack");

    const run = assembleAttackRun({
      definition: def,
      path: buildSecurityPath([{ layer: "STRATEGY_COMPILER", outcome: "DENY", reasonCode: "PRODUCTION_NETWORK_WRITE_PROHIBITED" }]),
      diffs: [{ field: "chainId", original: "11155111", mutated: "1" }],
      capabilityIssued: false, transactionSubmitted: false,
      additionalDefenses: additional,
    });
    expect(run.reasonCode).toBe("PRODUCTION_NETWORK_WRITE_PROHIBITED");
    expect(run.additionalDefenses.length).toBe(3);
  });

  it("LAB-033b a defence that was not exercised cannot be listed", () => {
    /*
     * §P28.39: only list defenses actually tested. It is tempting to list all ten fences; a list
     * that includes ones nobody ran leaves the reader unable to tell which.
     */
    const claimed = [{ layer: "SIGNER" as const, reasonCode: "PRODUCTION_NETWORK_WRITE_PROHIBITED" }];
    expect(reasonOf(() => assertDefensesExercised(claimed, new Set<SecurityLayer>(["RELAYER"]), "attack")))
      .toBe(ATTACK_REASONS.UNEXERCISED_DEFENSE);
  });

  it("LAB-028 an attack that nothing stopped is reported as not stopped", () => {
    const def = ATTACKS.find((a) => a.scenario === "PROMPT_INJECTION")!;
    const run = assembleAttackRun({
      definition: def,
      path: buildSecurityPath([{ layer: "CONTEXTLOCK_POLICY", outcome: "PASS" }]),
      diffs: [], capabilityIssued: true, transactionSubmitted: true,
    });
    expect(run.result).toBe("ALLOWED");
    expect(run.stoppedBy).toBeNull();
    expect(attackSummary(run)).toMatch(/NOT STOPPED/);
  });

  it("LAB-033c an inconsistent run is refused rather than displayed", () => {
    const def = ATTACKS.find((a) => a.scenario === "AMOUNT_MUTATION")!;
    // Denied, and a capability issued anyway. One of those is wrong.
    expect(reasonOf(() => assembleAttackRun({
      definition: def,
      path: buildSecurityPath([{ layer: "CONTEXTLOCK_POLICY", outcome: "DENY", reasonCode: "DENY_AMOUNT_TOO_HIGH" }]),
      diffs: [], capabilityIssued: true, transactionSubmitted: false,
    }))).toBe(ATTACK_REASONS.PATH_INCONSISTENT);
  });

  it("LAB-033d a denial with no reason code is not evidence", () => {
    const def = ATTACKS.find((a) => a.scenario === "AMOUNT_MUTATION")!;
    expect(reasonOf(() => assembleAttackRun({
      definition: def,
      path: [{ layer: "CONTEXTLOCK_POLICY", outcome: "DENY", reasonCode: null, detail: null }],
      diffs: [], capabilityIssued: false, transactionSubmitted: false,
    }))).toBe(ATTACK_REASONS.PATH_INCONSISTENT);
  });

  it("LAB-033e only attacks applicable to this Blueprint are offered", () => {
    /*
     * §P28.35. A CCIP attack against an agent with no cross-chain capability produces a passing
     * result that proves nothing, and a list of green ticks including meaningless ones is worse than
     * a shorter honest list.
     */
    const bp = guardian();
    const applicable = applicableAttacks(bp);
    expect(applicable.length).toBeGreaterThan(0);
    expect(applicable.length).toBeLessThan(ATTACKS.length);
    expect(applicable.some((a) => a.scenario === "MAINNET_WRITE_ATTEMPT")).toBe(true);
    // No CCIP adapter in this Blueprint, so no CCIP attack.
    expect(bp.adapters.some((a) => a.role === "CROSS_CHAIN")).toBe(false);
    expect(applicable.some((a) => a.scenario === "CCIP_WRONG_DESTINATION")).toBe(false);
  });

  it("LAB-033f every attack names an expected layer that exists", () => {
    for (const a of ATTACKS) {
      expect(SECURITY_LAYERS as readonly string[], a.scenario).toContain(a.expectedStoppedBy);
      expect(a.expectedReasonCode.length, a.scenario).toBeGreaterThan(0);
    }
  });
});

/* ═════════════════════════ LAB-039 … 044 : control and revisions ═════════════════════════ */

describe("LAB-039 pausing a runtime does not claim a financial stop", () => {
  it("LAB-039 the two controls have different kinds and say what they do not do", () => {
    expect(CONTROL_SEMANTICS.PAUSE_RUNTIME.kind).toBe("OPERATIONAL");
    expect(CONTROL_SEMANTICS.PAUSE_RUNTIME.doesNot).toMatch(/does NOT remove financial authority/);
    expect(CONTROL_SEMANTICS.DISABLE_POLICY.kind).toBe("FINANCIAL");
    expect(CONTROL_SEMANTICS.DISABLE_POLICY.doesNot).toMatch(/does not stop the container/);
  });

  it("LAB-039b describing a pause as securing something is refused", () => {
    // The mandatory mutation "pause runtime and mark treasury secured".
    expect(() => assertPauseNotDescribedAsSecure("Runtime paused — your treasury is secure")).toThrow();
    expect(() => assertPauseNotDescribedAsSecure("Runtime paused — funds are safe")).toThrow();
    expect(() => assertPauseNotDescribedAsSecure("Runtime paused. The ContextLock policy is still enabled")).not.toThrow();
  });

  it("LAB-041 the emergency path involves no model", () => {
    expect(CONTROL_SEMANTICS.EMERGENCY_LOCK.doesNot).toMatch(/not a model decision and involves no model/);
    // Structural: the lab package imports no agent module anywhere.
    const hits = sourceLines(/studio-agents|openai|anthropic/i, "packages/studio-lab/src");
    expect(hits.map((h) => `${h.file}:${h.text.trim()}`)).toEqual([]);
  });
});

describe("LAB-042 a live edit creates a revision", () => {
  it("LAB-042 editing a live agent in place is refused", () => {
    expect(reasonOf(() => assertNotLiveMutation(true, false, "edit autonomous limit"))).toBe(REVISION_REASONS.LIVE_MUTATION);
    expect(() => assertNotLiveMutation(true, true, "edit autonomous limit")).not.toThrow();
    expect(() => assertNotLiveMutation(false, false, "edit a draft")).not.toThrow();
  });

  it("LAB-042b a Blueprint change marks everything downstream stale", () => {
    const revisions = REVISION_KINDS.map((kind) => ({ kind, value: "1", stale: false, staleBecause: null }));
    const after = markStale(revisions, "BLUEPRINT");
    const staleKinds = after.filter((r) => r.stale).map((r) => r.kind).sort();
    expect(staleKinds).toEqual(["BUILD", "CRE_ARTIFACT", "DEPLOYMENT", "RUNTIME", "STRATEGY"]);
    // A snapshot is a reading of the world and does not depend on the design.
    expect(after.find((r) => r.kind === "MARKET_SNAPSHOT")?.stale).toBe(false);
  });

  it("LAB-042c staleness is transitive", () => {
    const revisions = REVISION_KINDS.map((kind) => ({ kind, value: "1", stale: false, staleBecause: null }));
    const after = markStale(revisions, "BUILD");
    // A stale build makes the CRE artifact stale, which makes the deployment stale.
    expect(after.find((r) => r.kind === "CRE_ARTIFACT")?.stale).toBe(true);
    expect(after.find((r) => r.kind === "DEPLOYMENT")?.stale).toBe(true);
    expect(after.find((r) => r.kind === "RUNTIME")?.stale).toBe(true);
  });

  it("LAB-042d a stale artifact blocks activation", () => {
    const stale = [{ kind: "BUILD" as const, value: "2", stale: true, staleBecause: "the blueprint changed" }];
    expect(reasonOf(() => assertNoStaleArtifacts(stale, "activate"))).toBe(REVISION_REASONS.STALE_ARTIFACT);
  });
});

describe("LAB-043 an authority increase is highlighted", () => {
  const before = treasuryGuardian();

  it("LAB-043 a raised autonomous limit is an expansion with a stated consequence", () => {
    const after = treasuryGuardian();
    after.autonomousPolicy = { ...after.autonomousPolicy, maxValueUsdCents: 200_000 };
    const changes = securityDiff(before, after);
    const limit = changes.find((c) => c.field === "autonomousPolicy.maxValueUsdCents");
    expect(limit?.impact).toBe("AUTHORITY_EXPANDED");
    expect(limit?.before).toBe("$1,000");
    expect(limit?.after).toBe("$2,000");
    expect(limit?.consequence).toMatch(/additional \$1,000 per action/);
    expect(authorityExpansions(changes).length).toBeGreaterThan(0);
  });

  it("LAB-043b a lowered limit is a reduction, not an expansion", () => {
    const after = treasuryGuardian();
    after.autonomousPolicy = { ...after.autonomousPolicy, maxValueUsdCents: 50_000 };
    const c = securityDiff(before, after).find((x) => x.field === "autonomousPolicy.maxValueUsdCents");
    expect(c?.impact).toBe("AUTHORITY_REDUCED");
    expect(authorityExpansions(securityDiff(before, after))).toEqual([]);
  });

  it("LAB-043c a removed denial is an expansion — the least obvious one on the screen", () => {
    const after = treasuryGuardian();
    after.permissions = { ...after.permissions, denied: after.permissions.denied.slice(1) };
    const changes = securityDiff(before, after);
    const removed = changes.find((c) => c.label === "Denial removed");
    expect(removed?.impact).toBe("AUTHORITY_EXPANDED");
    expect(removed?.consequence).toMatch(/no longer explicitly forbidden/);
  });

  it("LAB-043d a weakened trust requirement is an expansion", () => {
    const after = treasuryGuardian();
    const first = after.contextSources[0];
    if (first) {
      after.contextSources = [{ ...first, minimumTrustClass: "EXTERNAL_API" }, ...after.contextSources.slice(1)];
      const c = securityDiff(before, after).find((x) => x.label === "Required trust changed");
      expect(c?.impact).toBe("AUTHORITY_EXPANDED");
      expect(c?.consequence).toMatch(/weaker trust requirement admits weaker data/);
    }
  });

  it("LAB-043e an identical Blueprint produces no changes", () => {
    expect(securityDiff(before, treasuryGuardian())).toEqual([]);
  });
});

describe("LAB-044 an old runtime revision is fenced", () => {
  it("LAB-044 a superseded revision cannot authenticate", () => {
    // The mandatory mutation "let old runtime revision authenticate".
    expect(reasonOf(() => assertCurrentRevision("rev-3", "rev-4", "runtime request"))).toBe(REVISION_REASONS.OLD_REVISION);
    expect(() => assertCurrentRevision("rev-4", "rev-4", "runtime request")).not.toThrow();
  });

  it("LAB-044b the refusal acknowledges the old runtime may still be running", () => {
    try { assertCurrentRevision("rev-3", "rev-4", "runtime request"); } catch (e) {
      expect((e as Error).message).toMatch(/may still be running; it may not act/);
    }
  });
});

/* ═════════════════════════ LAB-045 … 047 : the safety report ═════════════════════════ */

describe("the safety report", () => {
  it("LAB-045 the report states the execution-network boundary with evidence", () => {
    const r = sealSafetyReport(safetyReportInput());
    expect(r.execution.productionChainExecution).toBe("DISABLED");
    expect(r.execution.productionWriteEvidence.length).toBeGreaterThan(0);
    for (const n of r.execution.networks) expect(n.role, n.name).not.toBe("READ_ONLY_SOURCE");
  });

  it("LAB-046 the report classifies CRE truthfully, in separate fields", () => {
    const r = sealSafetyReport(safetyReportInput());
    expect(r.cre.donDeployment).toBe("NO");
    expect(r.cre.hardwareTee).toBe("NO");
    expect(r.cre.teeAttestation).toBe("NO");
    expect(r.cre.wasmHash).toMatch(/^800d0d56/);
    expect(r.cre.productionLimits).toBe("ENABLED");
  });

  it("LAB-046b privacy is six separate claims, never one tick", () => {
    const r = sealSafetyReport(safetyReportInput());
    expect(r.privacy.length).toBe(PRIVACY_CLAIMS.length);
    for (const name of PRIVACY_CLAIMS) {
      expect(r.privacy.some((c) => c.claim === name), name).toBe(true);
    }
    // Four of the six are "no", which is the point of not collapsing them.
    expect(r.privacy.filter((c) => c.answer === "NO").length).toBe(3);
  });

  it("LAB-046c a VERIFIED claim with no evidence is refused", () => {
    const bad = privacyClaims().map((c) => (c.claim === "CRE official simulation" ? { ...c, evidence: null } : c));
    expect(reasonOf(() => assertPrivacyClaimsEvidenced(bad))).toBe(REPORT_REASONS.UNEVIDENCED_CLAIM);
  });

  it("LAB-046d omitting a claim is refused — silence is not an answer", () => {
    const short = privacyClaims().slice(0, 4);
    expect(reasonOf(() => assertPrivacyClaimsEvidenced(short))).toBe(REPORT_REASONS.COLLAPSED);
  });

  it("LAB-047 the report is scanned for secrets before it is sealed", () => {
    const r = sealSafetyReport(safetyReportInput());
    expect(scanForSecrets(r)).toEqual([]);
    expect(() => assertReportSecretFree(r)).not.toThrow();
    expect(r.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("LAB-047b guard one alone: a private key under an innocuous field", () => {
    const input = safetyReportInput();
    input.agent = { ...input.agent, goal: `key ${"0x" + "ab".repeat(32)}` };
    expect(() => sealSafetyReport(input)).toThrow(SafetyReportError);
  });

  it("LAB-047c guard two alone: a CRE session field name is refused loudly", () => {
    /*
     * The mandatory mutation "leak CRE session into project export". The raw input is scanned
     * BEFORE the schema parses it — the schema would strip the field, which is safe and silent, and
     * a silent strip teaches nobody that they tried to export a credential.
     */
    const input = safetyReportInput() as unknown as Record<string, unknown>;
    input["sessionToken"] = "harmless-looking";
    expect(reasonOf(() => sealSafetyReport(input as never))).toBe(CRE_LAB_REASONS.SESSION_EXPORTED);
  });

  it("LAB-047g and the schema still strips it, so both layers hold independently", () => {
    // The second guard, exercised alone: a field that reaches the parser does not survive it.
    const input = safetyReportInput() as unknown as Record<string, unknown>;
    input["someUnexpectedField"] = "0xdeadbeef";
    const sealed = sealSafetyReport(input as never);
    expect(Object.keys(sealed)).not.toContain("someUnexpectedField");
  });

  it("LAB-047d a transaction hash is not mistaken for a private key", () => {
    /*
     * A tx hash is 32 bytes and matches the key pattern exactly. A scan that fired on every
     * deployment receipt would be relaxed until it fired on nothing, so the exemption is by named
     * field and is narrow.
     */
    const r = sealSafetyReport(safetyReportInput());
    expect(r.deployments[0]?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(scanForSecrets(r)).toEqual([]);
  });

  it("LAB-047e an OpenAI key anywhere in the report is caught", () => {
    const input = safetyReportInput();
    input.knownBlockers = [{ id: "X", effect: "sk-proj-NOT-A-REAL-KEY-CANARY-000000000" }];
    expect(() => sealSafetyReport(input)).toThrow(SafetyReportError);
  });

  it("LAB-047f the public view is built from an allow-list, not filtered", () => {
    /*
     * §P28.52. A filter is a deny-list, and a field added later is public by default. Building a new
     * object means a new field is private until someone adds it here on purpose.
     */
    const r = sealSafetyReport(safetyReportInput());
    const pub = publicSafetyView(r);
    const json = JSON.stringify(pub);
    for (const forbidden of PUBLIC_VIEW_FORBIDDEN) expect(json, forbidden).not.toContain(forbidden);
    expect(Object.keys(pub)).not.toContain("deployments");
    expect(Object.keys(pub)).not.toContain("runtime");
    expect(Object.keys(pub)).not.toContain("reality");
    // What it DOES carry: enough to be useful.
    expect(pub.execution.productionChainExecution).toBe("DISABLED");
    expect(pub.privacy.length).toBe(6);
    expect(pub.reportHash).toBe(r.reportHash);
  });

  it("LAB-048 an optional blocker does not fake a healthy status", () => {
    const r = sealSafetyReport(safetyReportInput());
    expect(r.reality.theGraphState).toMatch(/UNAVAILABLE/);
    expect(r.reality.theGraphState).toMatch(/No fallback substitution occurred/);
    expect(r.reality.archiveReplayState).toMatch(/LIMITED/);
    expect(r.knownBlockers.map((b) => b.id)).toContain("BLK-V2-GRAPH-KEY");
    const graphSource = r.reality.sources.find((s) => s.kind === "THE_GRAPH");
    expect(graphSource?.status).toBe("UNAVAILABLE");
    expect(graphSource?.blocker).toBe("BLK-V2-GRAPH-KEY");
  });

  it("LAB-050 production-chain execution remains impossible, stated and enforced", () => {
    const r = sealSafetyReport(safetyReportInput());
    expect(r.execution.productionChainExecution).toBe("DISABLED");
    // And the registry agrees: no execution network is a production chain.
    for (const n of executionNetworks()) {
      expect(lookupNetwork(n.chainId)?.environment, n.name).not.toBe("PRODUCTION");
    }
    expect(productModeDescriptor().productionChainExecution).toBe("DISABLED");
  });
});
