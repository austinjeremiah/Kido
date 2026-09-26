import { describe, expect, it } from "vitest";
import {
  BlueprintSchema,
  ConfirmedRequirementError,
  applyResolutions,
  bindTo,
  blueprintHash,
  buildBlockers,
  canonicalJson,
  deriveKidoAgentId,
  emptyBlueprint,
  isStale,
  nextRevision,
  type RequirementResolution,
} from "../src/index.js";

const r = (key: string, value: unknown, o: Partial<RequirementResolution> = {}): RequirementResolution => ({
  key, topic: "AUTHORITY", class: "USER_REQUIRED", critical: true, status: "RESOLVED", value, confirmed: true,
  provenance: { kind: "USER_ANSWER", quote: String(value), turn: 1 }, ...o,
});

describe("canonical blueprint", () => {
  it("empty blueprint is schema-valid and restrictive", () => {
    const bp = emptyBlueprint("p1", "salt", "protect my Aave position");
    expect(BlueprintSchema.parse(bp)).toBeTruthy();
    expect(bp.authority.forbiddenActions).toEqual(["BORROW", "WITHDRAW"]);
    expect(bp.authority.mode).toBeNull();
  });

  it("hash is independent of key order and changes with content", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    const bp = emptyBlueprint("p1", "salt", "x");
    expect(blueprintHash(bp)).toBe(blueprintHash(structuredClone(bp)));
    expect(blueprintHash({ ...bp, objective: { statement: "y", summary: null } })).not.toBe(blueprintHash(bp));
  });

  it("KidoAgentId is stable, well-formed and independent of chain identities", () => {
    const id = deriveKidoAgentId("p1", "salt");
    expect(id).toMatch(/^kido:agent:[a-z2-7]{16}$/);
    const bp = emptyBlueprint("p1", "salt", "x");
    const rebound = nextRevision(bp, { identity: { ...bp.identity, public: true, bindings: [{ provider: "ens", chain: "ethereum-sepolia", name: "repay.agents.acme.eth", status: "ACTIVE" }] } });
    expect(rebound.kidoAgentId).toBe(id);
  });

  it("revisions chain to their parent and mark old artifacts stale", () => {
    const bp = emptyBlueprint("p1", "salt", "x");
    const sim = bindTo(bp);
    const next = nextRevision(bp, { chains: ["sui-testnet"] });
    expect(next.revision).toBe(1);
    expect(next.parentRevisionHash).toBe(blueprintHash(bp));
    expect(isStale(sim, next)).toBe(true);
    expect(isStale(bindTo(next), next)).toBe(false);
  });

  it("a confirmed requirement cannot be changed by a model re-run, only by an explicit edit", () => {
    const bp = applyResolutions(emptyBlueprint("p1", "s", "x"), [{ resolution: r("authority.withdraw", false) }]);
    expect(() => applyResolutions(bp, [{ resolution: r("authority.withdraw", true) }])).toThrow(ConfirmedRequirementError);
    expect(applyResolutions(bp, [{ resolution: r("authority.withdraw", false) }]).revision).toBe(bp.revision + 1);
    const edited = applyResolutions(bp, [{ resolution: r("authority.withdraw", true), explicitUserEdit: true }]);
    expect(edited.requirements.find((x) => x.key === "authority.withdraw")!.value).toBe(true);
  });
});

describe("buildability", () => {
  it("an underspecified draft is not buildable and says why", () => {
    const codes = buildBlockers(emptyBlueprint("p1", "s", "protect my position")).map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining(["KIDO_BLUEPRINT_NO_AUTHORITY_MODE", "KIDO_BLUEPRINT_NO_CHAIN", "KIDO_BLUEPRINT_PRIVACY_UNDECIDED"]));
  });

  it("an unresolved critical USER_REQUIRED item blocks", () => {
    const bp = applyResolutions(emptyBlueprint("p1", "s", "x"), [{ resolution: r("limits.window", undefined, { status: "UNKNOWN", confirmed: false }) }]);
    expect(buildBlockers(bp).map((b) => b.code)).toContain("KIDO_BLUEPRINT_UNRESOLVED");
  });

  it("a read-only agent needs no limits, payees, Amane or bridge decision", () => {
    const bp = nextRevision(emptyBlueprint("p1", "s", "watch my health factor"), {
      chains: ["ethereum-sepolia"],
      authority: { ...emptyBlueprint("p1", "s", "x").authority, mode: "READ_ONLY" },
      privacy: { required: false, values: [], providers: [] },
    });
    expect(buildBlockers(bp)).toEqual([]);
  });

  it("autonomous finance requires Amane, per-chain limits, ordered caps, payees for PAY and a recovery decision", () => {
    const base = emptyBlueprint("p1", "s", "x");
    const bp = nextRevision(base, {
      chains: ["ethereum-sepolia", "sui-testnet"],
      authority: { ...base.authority, mode: "BOUNDED_AUTONOMOUS_FINANCE", allowedActions: ["PAY"], limits: [{ chain: "ethereum-sepolia", asset: "AMUSD", perAction: "30", perWindow: "20", windowSeconds: 3600, total: "100" }] },
      privacy: { required: false, values: [], providers: [] },
    });
    const codes = buildBlockers(bp).map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining([
      "KIDO_BLUEPRINT_NO_AUTHORITY_PROVIDER", "KIDO_BLUEPRINT_NO_LIMITS", "KIDO_BLUEPRINT_LIMIT_ORDER",
      "KIDO_BLUEPRINT_NO_PAYEES", "KIDO_BLUEPRINT_BRIDGE_UNDECIDED", "KIDO_BLUEPRINT_RECOVERY_UNDECIDED",
    ]));
  });
});
