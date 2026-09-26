import { describe, expect, it } from "vitest";
import { applyResolutions, buildBlockers, ConfirmedRequirementError } from "@kido/blueprint";
import { DesignInterview, RuleBasedInterviewModel, compileBlueprint, type Question } from "../src/index.js";
import { ProviderRegistry } from "@kido/registry";
const FACTS = new ProviderRegistry().gateFacts();

const model = new RuleBasedInterviewModel();
const PAYEE_SUI = `0x${"ab".repeat(32)}`;

/** Drives an interview with a scripted user who answers by requirement key. */
async function drive(objective: string, answers: Record<string, string>, maxQuestions = 14) {
  const iv = await DesignInterview.start("proj", "salt", objective, model, { maxQuestions });
  const asked: Question[] = [];
  let q = iv.next();
  while (q) {
    asked.push(q);
    const a = answers[q.key];
    if (a === undefined) throw new Error(`unexpected question ${q.key}: ${q.text}`);
    q = (await iv.answer(a)).next;
  }
  iv.finalizeResolutions();
  return { iv, asked, bp: compileBlueprint(iv.resolutionsBlueprint()) };
}

describe("design interview", () => {
  it("never builds a vague prompt immediately; asks the highest-value question first", async () => {
    const iv = await DesignInterview.start("p", "s", "Build me an agent that protects my Aave position.", model);
    const q = iv.next()!;
    expect(q.key).toBe("authority.mode");
    expect(q.text).not.toMatch(/maxPerEpoch|AuthorizationMode|provider|framework/i);
    expect(buildBlockers(compileBlueprint(iv.resolutionsBlueprint()), FACTS).length).toBeGreaterThan(0);
    expect(iv.ctx["chains"]).toEqual(["ethereum-sepolia"]); // inferred from Aave, never asked
    expect(iv.ctx["protocols"]).toEqual(["aave-v3"]);
  });

  it("Scenario A: the full Aave guardian dialogue compiles into a buildable, bounded blueprint", async () => {
    const { asked, bp } = await drive("Build me an agent that protects my Aave position.", {
      "authority.mode": "Act on its own within limits I set",
      "authority.withdraw": "No, never",
      "actions.allowed": "It may repay my debt",
      beneficiary: `the loan is on my wallet 0x${"cd".repeat(20)}`,
      "authority.autonomy": "Only when a condition it can prove on-chain occurs",
      "limits.window": "500 USDC",
      "limits.total": "2,000",
      "identity.public": "yes",
      "identity.name": "repay acme",
      "privacy.required": "no",
      "monitor.condition": "health factor below 1.5",
      "recovery.partial": "stop and notify me",
    });
    const keys = asked.map((q) => q.key);
    expect(keys.slice(0, 2)).toEqual(["authority.mode", "authority.withdraw"]);
    expect(keys).not.toContain("chains");
    expect(keys).not.toContain("assets.spend"); // inferred: Aave on Sepolia only spends its listed USDC
    expect(asked.length).toBeLessThanOrEqual(14);
    expect(buildBlockers(bp, FACTS)).toEqual([]);
    expect(bp.authority).toMatchObject({ mode: "BOUNDED_AUTONOMOUS_FINANCE", provider: "AMANE", allowedActions: ["REPAY"], forbiddenActions: ["BORROW", "WITHDRAW"] });
    expect(bp.authority.limits).toEqual([{ chain: "ethereum-sepolia", asset: "USDC", perAction: "250000000", perWindow: "500000000", windowSeconds: 3600, total: "2000000000" }]);
    expect(bp.authority.beneficiaries).toEqual([{ label: "owner position", chain: "ethereum-sepolia", address: `0x${"cd".repeat(20)}` }]);
    expect(bp.monitors[0]).toMatchObject({ metric: "HEALTH_FACTOR", op: "LT", threshold: "1.5", response: "DETERMINISTIC_ACTION", action: "REPAY" });
    expect(bp.identity.bindings).toEqual([{ provider: "ens", chain: "ethereum-sepolia", name: null, status: "PLANNED" }]);
    expect(bp.privacy).toEqual({ required: false, values: [], providers: [] });
    expect(bp.amane).toBeDefined();
    expect(bp.agents.map((a) => a.role)).toEqual(["RepayDebtAgent"]);
  });

  it("does not invent identity: an unanswered identity question defaults to no public identity", async () => {
    const { bp } = await drive("Watch my Aave position and alert me", { "authority.mode": "only watch and alert me", "identity.public": "not sure", "privacy.required": "no", "monitor.condition": "health factor below 1.3" });
    expect(bp.identity.public).toBe(false);
    expect(bp.identity.bindings).toEqual([]);
    expect(buildBlockers(bp, FACTS)).toEqual([]);
  });

  it("a read-only agent is never asked about limits, payees or bridges", async () => {
    const { asked, bp } = await drive("Watch my Aave health factor and alert me", {
      "authority.mode": "only watch and alert me",
      "identity.public": "no",
      "privacy.required": "no",
      "monitor.condition": "below 1.4",
    });
    expect(asked.map((q) => q.key)).toEqual(["authority.mode", "identity.public", "privacy.required", "monitor.condition"]);
    expect(bp.authority.mode).toBe("READ_ONLY");
    expect(bp.amane).toBeUndefined();
    expect(bp.monitors[0]!.response).toBe("NOTIFY");
  });

  it("'no sensitive data' in the objective adds no privacy questions or providers", async () => {
    const iv = await DesignInterview.start("p", "s", "Watch my Aave position. No sensitive data is involved.", model);
    expect(iv.ctx["privacy.required"]).toBe(false);
    const keys: string[] = [];
    for (let q = iv.next(); q; q = (await iv.answer(q.key === "authority.mode" ? "only watch and alert me" : q.key === "identity.public" ? "no" : "below 1.2")).next) keys.push(q.key);
    expect(keys.filter((k) => k.startsWith("privacy"))).toEqual([]);
  });

  it("'I want it private' starts the privacy sequence and selects no provider by itself", async () => {
    const { asked, bp } = await drive("I want a private agent that watches my Aave health factor", {
      "authority.mode": "only watch and alert me",
      "identity.public": "no",
      "privacy.required": "yes",
      "privacy.values": "the risk threshold",
      "privacy.hidden_from": "the public and the AI agent",
      "privacy.plaintext": "a verified secure enclave",
      "privacy.disclosure": "only the decision",
      "monitor.condition": "health factor below 1.6",
    });
    // "private agent" in the request is the user's own decision; only the details are asked.
    expect(asked.map((q) => q.key)).not.toContain("privacy.required");
    expect(asked.map((q) => q.key)).toEqual(expect.arrayContaining(["privacy.values", "privacy.hidden_from", "privacy.plaintext", "privacy.disclosure"]));
    expect(bp.requirements.find((r) => r.key === "privacy.required")).toMatchObject({ value: true, provenance: { kind: "USER_ANSWER", quote: "private" } });
    expect(bp.privacy.values).toEqual([
      { id: "risk-threshold", description: "risk threshold", kind: "PRIVATE_POLICY", hiddenFrom: ["PUBLIC_CHAIN", "AI_AGENT"], plaintextBoundary: "APPROVED_ENCLAVE", allowedDisclosure: "DECISION_ONLY", failurePolicy: "FAIL_CLOSED" },
    ]);
    expect(bp.privacy.providers).toEqual([]);
    expect(bp.monitors[0]).toMatchObject({ threshold: null, thresholdPrivateRef: "risk-threshold" });
    expect(buildBlockers(bp, FACTS).map((b) => b.code)).toContain("KIDO_BLUEPRINT_PRIVACY_UNSATISFIED"); // until the privacy compiler selects a provider
  });

  it("cross-chain: asks about bridging and recovery, never assumes a bridge", async () => {
    const { asked, bp } = await drive("I want an agent that manages liquidity between Sui and Ethereum", {
      "authority.mode": "act on its own within limits",
      "authority.withdraw": "no",
      "authority.bridge": "no, each chain uses its own funds",
      "protocols": "Cetus",
      "actions.allowed": "swap tokens",
      "authority.autonomy": "automatically",
      "assets.spend": "AMUSD",
      "limits.window": "100",
      "limits.total": "400",
      "limits.swap_floor": "at least 0.95 AMSUI for each AMUSD",
      "identity.public": "no",
      "privacy.required": "no",
      "monitor.condition": "drift above 5%",
      "recovery.partial": "stop and notify me",
    });
    const keys = asked.map((q) => q.key);
    expect(keys.indexOf("authority.bridge")).toBeLessThan(keys.indexOf("limits.window"));
    expect(bp.authority.bridgeAllowed).toBe(false);
    expect(bp.crossChain).toBeUndefined();
    expect([...bp.chains].sort()).toEqual(["ethereum-sepolia", "sui-testnet"]);
  });

  it("an impossible grant is UNSATISFIABLE and blocks the build", async () => {
    const iv = await DesignInterview.start("p", "s", "Protect my Aave position", model);
    iv.next();
    await iv.answer("act on its own within limits");
    const r = await iv.answer("yes, it may withdraw collateral");
    expect(r.note).toMatch(/never receive withdrawal authority/);
    const bp = compileBlueprint(iv.resolutionsBlueprint());
    expect(buildBlockers(bp, FACTS).map((b) => b.code)).toContain("KIDO_BLUEPRINT_UNSATISFIABLE");
  });

  it("the interview always finishes: unknown critical items become explicit blockers", async () => {
    const iv = await DesignInterview.start("p", "s", "Build me an agent that protects my Aave position.", model, { maxQuestions: 2 });
    for (let q = iv.next(); q; q = (await iv.answer(q.key === "authority.mode" ? "act on its own within limits" : "no")).next);
    iv.finalizeResolutions();
    const codes = buildBlockers(compileBlueprint(iv.resolutionsBlueprint()), FACTS);
    expect(codes.filter((c) => c.code === "KIDO_BLUEPRINT_UNRESOLVED").map((c) => c.detail)).toEqual(expect.arrayContaining(["actions.allowed", "limits.window", "limits.total"]));
  });

  it("an unclear answer is re-asked once with options, then recorded as unknown", async () => {
    const iv = await DesignInterview.start("p", "s", "Protect my Aave position", model);
    iv.next();
    const r1 = await iv.answer("hmm, not sure");
    expect(r1.accepted).toBe(false);
    expect(r1.next).toMatchObject({ key: "authority.mode", reask: true });
    const r2 = await iv.answer("still thinking");
    expect(r2.next?.key).not.toBe("authority.mode");
    expect(iv.state.resolutions["authority.mode"]!.status).toBe("UNKNOWN");
  });

  it("a confirmed answer cannot be silently changed by a re-run; only an explicit edit changes it", async () => {
    const iv = await DesignInterview.start("p", "s", "Protect my Aave position; it must never withdraw collateral", model);
    expect(iv.state.resolutions["authority.withdraw"]).toMatchObject({ value: false, confirmed: true });
    const bp = iv.resolutionsBlueprint();
    const tampered = { ...iv.state.resolutions["authority.withdraw"]!, value: true };
    expect(() => applyResolutions(bp, [{ resolution: tampered }])).toThrow(ConfirmedRequirementError);
    await iv.edit("authority.withdraw", "no");
    expect(iv.state.resolutions["authority.withdraw"]!.value).toBe(false);
  });

  it("interview state survives persistence as plain JSON", async () => {
    const iv = await DesignInterview.start("p", "s", "Protect my Aave position", model);
    iv.next();
    await iv.answer("only watch and alert me");
    const restored = DesignInterview.restore(JSON.parse(JSON.stringify(iv.state)), model);
    expect(restored.next()!.key).toBe(iv.next()!.key);
  });

  it("payments agent pins payees and refuses arbitrary recipients", async () => {
    const { bp, asked } = await drive("Build a Sui agent that pays my supplier invoices", {
      "authority.mode": "act on its own within limits",
      "authority.withdraw": "no",
      "actions.allowed": "pay approved recipients",
      "authority.arbitrary_recipients": "no, only approved ones",
      "authority.autonomy": "automatically",
      "payees": `acme supplies: ${PAYEE_SUI}`,
      "limits.window": "50",
      "limits.total": "500",
      "identity.public": "no",
      "privacy.required": "no",
      "recovery.partial": "stop and notify me",
    });
    expect(asked.map((q) => q.key)).toContain("authority.arbitrary_recipients");
    expect(bp.authority.payees).toEqual([{ label: "acme-supplies", chain: "sui-testnet", address: PAYEE_SUI }]);
    expect(bp.authority.limits[0]).toMatchObject({ chain: "sui-testnet", asset: "AMUSD", perWindow: "50000000" });
    expect(buildBlockers(bp, FACTS)).toEqual([]);
  });
});
