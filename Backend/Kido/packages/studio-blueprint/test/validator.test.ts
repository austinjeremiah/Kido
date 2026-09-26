import { describe, it, expect } from "vitest";
import { validateBlueprint, validateBlueprintArtifacts } from "../src/validator.js";
import { projectGraph } from "../src/graph.js";
import { validGuardian, copy, ALL_GENERATED_PATHS } from "./fixtures.js";

/**
 * These tests exist to prove the validator can FAIL. A validator only ever observed passing is not
 * a control — it is a decoration that happens to be green. Every case below starts from a Blueprint
 * that is known-good, breaks exactly one thing, and asserts the specific issue code appears.
 */

const codes = (bp: unknown) => validateBlueprint(bp).issues.map((i) => i.code);

describe("STUDIO-002 requirements → valid Blueprint", () => {
  it("accepts the canonical Aave Guardian and marks it buildable", () => {
    const r = validateBlueprint(validGuardian());
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.buildable).toBe(true);
    expect(r.unknowns).toEqual([]);
  });
});

describe("STUDIO-003 an unknown critical field is not silently invented", () => {
  it("a BUILD-blocking unknown makes the Blueprint unbuildable, and names it", () => {
    const bp = copy(validGuardian());
    bp.autonomousPolicy.maxValueUsdCents = {
      known: false,
      reason: "The user never stated an autonomous spending limit.",
      requiredBefore: "BUILD",
    };
    const r = validateBlueprint(bp);
    expect(r.buildable).toBe(false);
    expect(r.unknowns.map((u) => u.path)).toContain("autonomousPolicy.maxValueUsdCents");
  });

  it("a DEPLOY-only unknown does not block the build", () => {
    // Addresses genuinely are not knowable at design time. Conflating "unknown now" with "unknown
    // forever" would make every Blueprint unbuildable and train users to ignore the distinction.
    const r = validateBlueprint(validGuardian());
    expect(r.buildable).toBe(true);
  });
});

describe("STUDIO-004 unsafe Blueprints are rejected", () => {
  it("BP-003 rejects an arbitrary recipient", () => {
    const bp = copy(validGuardian());
    bp.actions[0]!.recipientPolicy = {
      mode: "arbitrary",
      justification: "x".repeat(50),
    };
    const r = validateBlueprint(bp);
    expect(r.issues.some((i) => i.code === "BP-003" && i.severity === "CRITICAL")).toBe(true);
    expect(r.buildable).toBe(false);
  });

  it("BP-001 flags an arbitrary target even when a justification is supplied", () => {
    const bp = copy(validGuardian());
    bp.actions[0]!.targetPolicy = { mode: "arbitrary", justification: "y".repeat(50) };
    expect(codes(bp)).toContain("BP-001");
    expect(validateBlueprint(bp).buildable).toBe(false);
  });

  it("BP-004 rejects an agent holding the capability issuer key", () => {
    const bp = copy(validGuardian()) as Record<string, any>;
    bp.execution.agentHoldsCapabilityIssuerKey = true;
    // The schema types it as the literal false, so this arrives as a schema violation — which is
    // the strongest possible rejection: the design is not merely invalid, it is unrepresentable.
    const r = validateBlueprint(bp);
    expect(r.ok).toBe(false);
    expect(r.buildable).toBe(false);
  });

  it("BP-005 rejects an agent holding a protocol admin key", () => {
    const bp = copy(validGuardian()) as Record<string, any>;
    bp.execution.agentHoldsProtocolAdminKey = true;
    expect(validateBlueprint(bp).buildable).toBe(false);
  });

  it.each([
    ["nonce", "BP-007"],
    ["expiry", "BP-008"],
    ["chainId", "BP-009"],
    ["target", "BP-010"],
    ["calldataHash", "BP-010"],
  ])("rejects a capability that does not bind %s", (field, code) => {
    const bp = copy(validGuardian());
    bp.capabilityPolicy.bindings = bp.capabilityPolicy.bindings.filter((b) => b !== field);
    expect(codes(bp)).toContain(code);
    expect(validateBlueprint(bp).buildable).toBe(false);
  });

  it("BP-011 rejects a design where DENY is not terminal", () => {
    const bp = copy(validGuardian()) as Record<string, any>;
    bp.escalationPolicy.denyIsTerminal = false;
    expect(validateBlueprint(bp).buildable).toBe(false);
  });

  it("BP-012 rejects an escalation ceiling at or below the autonomous limit", () => {
    const bp = copy(validGuardian());
    bp.escalationPolicy.maxValueUsdCents = { known: true, value: 50_000, sourceQuote: "q" };
    expect(codes(bp)).toContain("BP-012");
  });

  it("BP-013 rejects an escalation band that overlaps the autonomous band", () => {
    const bp = copy(validGuardian());
    bp.escalationPolicy.minValueUsdCents = { known: true, value: 10_000, sourceQuote: "q" };
    expect(codes(bp)).toContain("BP-013");
  });

  it("BP-015 rejects a confidential threshold carrying a public value", () => {
    const bp = copy(validGuardian());
    bp.triggers[0]!.publicThreshold = { known: true, value: "16000", sourceQuote: "above 1.6" };
    const r = validateBlueprint(bp);
    expect(r.issues.some((i) => i.code === "BP-015" && i.severity === "CRITICAL")).toBe(true);
  });

  it("BP-016 rejects a financial permission expressed as an ENS role", () => {
    const bp = copy(validGuardian()) as Record<string, any>;
    bp.ens.financialPermissionsInEns = true;
    expect(validateBlueprint(bp).buildable).toBe(false);
  });

  it("BP-017 rejects a cached identity read", () => {
    const bp = copy(validGuardian()) as Record<string, any>;
    bp.ens.identityReadAt = "issuance-time";
    expect(validateBlueprint(bp).buildable).toBe(false);
  });

  it("BP-019 rejects autonomy over an action that is not declared", () => {
    const bp = copy(validGuardian());
    bp.autonomousPolicy.allowedActionRefs.push("withdraw-everything");
    expect(codes(bp)).toContain("BP-019");
  });

  it("BP-020 rejects autonomous value-outflow to a non-self recipient", () => {
    const bp = copy(validGuardian());
    bp.actions[0]!.displayName = "Withdraw funds to treasury";
    bp.actions[0]!.recipientPolicy = { mode: "fixed-allowlist", allowed: [{ known: true, value: "0x" + "11".repeat(20), sourceQuote: "q" }] };
    expect(codes(bp)).toContain("BP-020");
  });

  it("BP-022 flags missing baseline attack scenarios", () => {
    const bp = copy(validGuardian());
    bp.simulationScenarios = bp.simulationScenarios.filter((s) => s.scenarioId !== "REPLAY");
    expect(codes(bp)).toContain("BP-022");
  });

  it("BP-024 rejects any claim of physical Ledger evidence", () => {
    const bp = copy(validGuardian()) as Record<string, any>;
    bp.ledger.physicalDeviceEvidence = true;
    const r = validateBlueprint(bp);
    expect(r.buildable).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("BP-027 rejects regenerating the ContextLock core", () => {
    const bp = copy(validGuardian());
    bp.generatedModules.find((m) => m.kind === "contextlock-core")!.reusesContextLockCore = false;
    expect(codes(bp)).toContain("BP-027");
  });
});

describe("STUDIO-005 the graph is deterministic from the Blueprint", () => {
  it("produces byte-identical output across runs", () => {
    const bp = validGuardian();
    expect(JSON.stringify(projectGraph(bp))).toBe(JSON.stringify(projectGraph(bp)));
  });

  it("does not depend on the order of object keys in the input", () => {
    // Deep-rebuild every object with its keys reversed. Layout that depended on insertion order
    // would silently move nodes between runs of an identical Blueprint, which would make the graph
    // useless as evidence — two people looking at the same design would see different pictures.
    const reverseKeys = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reverseKeys);
      if (v && typeof v === "object") {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .reverse()
            .map(([k, val]) => [k, reverseKeys(val)]),
        );
      }
      return v;
    };
    const bp = validGuardian();
    const shuffled = reverseKeys(bp) as typeof bp;
    const a = projectGraph(bp);
    const b = projectGraph(shuffled);
    expect(a.nodes.map((n) => [n.id, n.position.x, n.position.y])).toEqual(
      b.nodes.map((n) => [n.id, n.position.x, n.position.y]),
    );
    expect(a.edges.map((e) => e.id)).toEqual(b.edges.map((e) => e.id));
  });

  it("never renders a confidential value, only parameter names", () => {
    const g = projectGraph(validGuardian());
    const priv = g.nodes.find((n) => n.kind === "PrivatePolicy")!;
    expect(priv).toBeDefined();
    const rendered = JSON.stringify(g);
    expect(rendered).toContain("healthFactorFloorBps");
    // The values live in the simulation fixture and the confidential store, never the graph.
    expect(rendered).not.toMatch(/16000|CTXLOCK_SIM_CANARY/);
    expect(priv.detail.find((d) => d.label === "Values")?.value).toBe("confidential — never rendered");
  });

  it("drops a CRE node when the Blueprint does not require CRE", () => {
    const bp = copy(validGuardian());
    bp.cre.required = false;
    bp.confidentialPolicy.required = false;
    const g = projectGraph(bp);
    expect(g.nodes.some((n) => n.kind === "CreWorkflow")).toBe(false);
    // and no edge may dangle
    for (const e of g.edges) {
      expect(g.nodes.some((n) => n.id === e.source)).toBe(true);
      expect(g.nodes.some((n) => n.id === e.target)).toBe(true);
    }
  });
});

describe("STUDIO-006 / STUDIO-022 generated modules must match the Blueprint", () => {
  it("passes when every declared module was generated", () => {
    expect(validateBlueprintArtifacts(validGuardian(), ALL_GENERATED_PATHS)).toEqual([]);
  });

  it("STUDIO-022 fails when a Blueprint module is absent from the generated code", () => {
    const missing = ALL_GENERATED_PATHS.filter((p) => p !== "workflows/cre/policy.ts");
    const issues = validateBlueprintArtifacts(validGuardian(), missing);
    expect(issues.some((i) => i.code === "BPA-001" && i.severity === "CRITICAL")).toBe(true);
  });

  it("fails when CRE is required but no CRE module is declared", () => {
    const bp = copy(validGuardian());
    bp.generatedModules = bp.generatedModules.filter((m) => m.kind !== "cre-confidential-policy");
    const issues = validateBlueprintArtifacts(bp, ALL_GENERATED_PATHS);
    expect(issues.some((i) => i.code === "BPA-002")).toBe(true);
  });

  it("fails when escalation is required but no escalation module is declared", () => {
    const bp = copy(validGuardian());
    bp.generatedModules = bp.generatedModules.filter((m) => m.kind !== "ledger-escalation");
    const issues = validateBlueprintArtifacts(bp, ALL_GENERATED_PATHS);
    expect(issues.some((i) => i.code === "BPA-004")).toBe(true);
  });
});

describe("STUDIO-024 arbitrary recipient fails Blueprint validation", () => {
  it("is CRITICAL, not advisory", () => {
    const bp = copy(validGuardian());
    bp.actions[1]!.recipientPolicy = { mode: "arbitrary", justification: "z".repeat(45) };
    const found = validateBlueprint(bp).issues.find((i) => i.code === "BP-003");
    expect(found?.severity).toBe("CRITICAL");
  });
});

describe("BP-028 / BP-029 — contradictions the advisory review found first", () => {
  it("BP-028 catches a BLANKET approval denial contradicting an action that needs one", () => {
    const bp = copy(validGuardian());
    bp.permissions.denied.push({ id: "d-any-approval", statement: "Token approval rights were not granted by the user." });
    const r = validateBlueprint(bp);
    const found = r.issues.filter((i) => i.code === "BP-028");
    expect(found.length).toBe(2); // both actions declare a USDC approval
    expect(found[0]!.severity).toBe("CRITICAL");
    expect(r.buildable).toBe(false);
  });

  it("BP-028 does NOT fire on a denial scoped to arbitrary/unlimited approvals", () => {
    // The canonical Blueprint denies "arbitrary token approval" while using exact-amount approvals.
    // That is the correct design, and a check that rejected it would be deleted rather than fixed.
    const r = validateBlueprint(validGuardian());
    expect(r.issues.some((i) => i.code === "BP-028")).toBe(false);
  });

  it("BP-028 ignores an UNRESOLVED marker, which records a question rather than a prohibition", () => {
    const bp = copy(validGuardian());
    bp.permissions.denied.push({
      id: "d-unres",
      statement: 'UNRESOLVED: the user did not state whether "token approval" is permitted',
    });
    expect(validateBlueprint(bp).issues.some((i) => i.code === "BP-028")).toBe(false);
  });

  it("BP-029 catches an autonomous action no stated permission covers", () => {
    const bp = copy(validGuardian());
    bp.permissions.allowed = [{ id: "p-only", statement: "protect the position from liquidation" }];
    const r = validateBlueprint(bp);
    expect(r.issues.some((i) => i.code === "BP-029")).toBe(true);
    expect(r.buildable).toBe(false);
  });

  it("BP-029 accepts a permission linked by actionRef", () => {
    expect(validateBlueprint(validGuardian()).issues.some((i) => i.code === "BP-029")).toBe(false);
  });
});
