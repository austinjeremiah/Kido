import { describe, expect, it } from "vitest";
import { buildBlockers } from "@kido/blueprint";
import { CATALOG, DesignInterview, parseActions, parseAmount, parseByType, parseChains, parsePayees, parsePlaintext, parseThreshold, parseYesNo, ruleBasedCandidates } from "../src/index.js";
import { EVM_A, EVM_B, drive, model } from "./break-helpers.js";

const choicesOf = (key: string) => CATALOG.find((d) => d.key === key)!.question({}).choices;
const codes = (bp: Parameters<typeof buildBlockers>[0]) => buildBlockers(bp).map((b) => b.code);

describe("BREAK: yes/no parser", () => {
  it("break_F0500_yesno_refusal_read_as_yes", () => {
    // Plain refusals must never be read as consent.
    for (const s of ["Absolutely not", "It's not allowed", "Bridging is not allowed", "Okay, but no", "Right now I'd say no"]) {
      const p = parseYesNo(s);
      expect(p.ok && p.value === true, s).toBe(false);
    }
  });

  it("break_F0500_bridge_refusal_grants_bridge_authority", async () => {
    const { bp } = await drive("I want an agent that manages liquidity between Sui and Ethereum", {
      "authority.bridge": "Absolutely not",
      protocols: "Cetus",
      "actions.allowed": "swap tokens",
    });
    expect(bp.authority.bridgeAllowed).not.toBe(true);
    expect(bp.crossChain).toBeUndefined();
  });

  it("break_F0500_identity_refusal_publishes_identity", async () => {
    const { bp } = await drive("Watch my Aave health factor and alert me", {
      "authority.mode": "only watch and alert me",
      "identity.public": "Absolutely not",
      "monitor.condition": "below 1.4",
    });
    expect(bp.identity.public).not.toBe(true);
    expect(bp.identity.bindings).toEqual([]);
  });
});

describe("BREAK: amount parser", () => {
  it("break_F0501_amount_k_suffix_without_word_boundary", () => {
    const ctx = { "assets.spend": "USDC" };
    // "100, keep it small" means 100 USDC, not 100,000.
    expect(parseAmount("100, keep it small", ctx)).toEqual({ ok: true, value: "100000000" });
    expect(parseAmount("50 kind of", ctx)).toEqual({ ok: true, value: "50000000" });
  });

  it("break_F0501_compromised_hour_budget_inflated_1000x", async () => {
    const { bp } = await drive("Build me an agent that protects my Aave position.", {
      "actions.allowed": "It may repay my debt",
      "authority.autonomy": "Only when a condition it can prove on-chain occurs",
      "limits.window": "100, keep it small",
      "limits.total": "1000000",
      "monitor.condition": "health factor below 1.5",
    });
    const lim = bp.authority.limits.find((l) => l.chain === "ethereum-sepolia")!;
    expect(lim.perWindow).toBe("100000000"); // 100 USDC
    expect(codes(bp)).toEqual([]);
  });

  it("break_F0502_amount_malformed_numerals_accepted", () => {
    const ctx = { "assets.spend": "USDC" };
    for (const s of ["-500", "1e30", "0x10", "1,5"]) {
      expect(parseAmount(s, ctx).ok, s).toBe(false);
    }
    // an absurd amount is a parse rejection, not an exception that escapes the interview
    expect(() => parseAmount("999999999999999999999k", ctx)).not.toThrow();
  });
});

describe("BREAK: action parser negation", () => {
  it("break_F0503_actions_negated_bridge_and_borrow_granted", () => {
    const a = (s: string) => (parseActions(s) as { ok: true; value: string[] }).value;
    expect(a("swap but never bridge")).not.toContain("BRIDGE");
    expect(a("repay; it cannot borrow")).not.toContain("BORROW");
    expect(a("repay, and it must never be allowed to borrow")).not.toContain("BORROW");
  });

  it("break_F0503_never_bridge_answer_yields_buildable_bridge_action", async () => {
    const { bp } = await drive("Rebalance my portfolio on Ethereum when allocation drifts", {
      protocols: "Uniswap",
      "actions.allowed": "swap tokens, but never bridge anything",
    });
    expect(bp.authority.allowedActions).not.toContain("BRIDGE");
    expect(bp.agents.map((x) => x.role)).not.toContain("BridgeAgent");
  });
});

describe("BREAK: choice parser picks the permissive option from a refusal", () => {
  it("break_F0505_mode_never_act_on_its_own_becomes_autonomous", () => {
    const ch = choicesOf("authority.mode");
    for (const s of ["Just watch and alert me, never act on its own", "I never want it doing anything by itself"]) {
      expect(parseByType("authority_mode", s, {}, ch), s).not.toEqual({ ok: true, value: "BOUNDED_AUTONOMOUS_FINANCE" });
    }
  });

  it("break_F0506_recovery_stop_answer_wakes_recovery_agent", () => {
    const ch = choicesOf("recovery.partial");
    for (const s of ["Don't try again, just stop", "stop, do not attempt to recover"]) {
      expect(parseByType("recovery", s, {}, ch), s).toEqual({ ok: true, value: "HALT_AND_NOTIFY" });
    }
  });

  it("break_F0507_disclosure_not_full_result_becomes_full_result", () => {
    const ch = choicesOf("privacy.disclosure");
    expect(parseByType("disclosure", "not the full result, only a hash commitment", {}, ch)).not.toEqual({ ok: true, value: "FULL_RESULT" });
    expect(parseByType("disclosure", "never everything, just a rough range", {}, ch)).toEqual({ ok: true, value: "BUCKETED_RESULT" });
  });

  it("break_F0508_plaintext_negation_inverts_boundary", () => {
    expect(parsePlaintext("anywhere except the kido backend")).not.toEqual({ ok: true, value: "KIDO_SECRET_STORE" });
    expect(parsePlaintext("never on kido servers, nowhere")).not.toEqual({ ok: true, value: "KIDO_SECRET_STORE" });
    expect(parsePlaintext("not in an enclave, only on my device")).toEqual({ ok: true, value: "USER_DEVICE" });
  });
});

describe("BREAK: payee parser", () => {
  it("break_F0510_refused_address_pinned_as_payee", () => {
    const p = parsePayees(`alice ${EVM_A}, but never mallory ${EVM_B}`) as { ok: true; value: { address: string }[] };
    expect(p.value.map((x) => x.address)).not.toContain(EVM_B);
  });

  it("break_F0510_refused_address_reaches_buildable_blueprint", async () => {
    const { bp } = await drive("Build an Ethereum agent that pays my supplier invoices", {
      "actions.allowed": "pay approved recipients",
      payees: `acme ${EVM_A}; do not pay mallory ${EVM_B}`,
    });
    expect(bp.authority.payees.map((x) => x.address)).not.toContain(EVM_B);
  });
});

describe("BREAK: threshold direction", () => {
  it("break_F0511_keep_hf_above_triggers_when_healthy", () => {
    // "Keep my health factor above 1.6" (bible §45.1) means act when HF falls below 1.6.
    expect(parseThreshold("keep my health factor above 1.6", "LENDING_PROTECTION")).toEqual({ ok: true, value: { metric: "HEALTH_FACTOR", op: "LT", threshold: "1.6" } });
  });
});

describe("BREAK: objective extraction", () => {
  it("break_F0512_privacy_request_recorded_as_no_privacy", async () => {
    const objective = "Protect my Aave position and make sure no private data is ever leaked";
    expect(ruleBasedCandidates(objective).find((c) => c.key === "privacy.required")).toBeUndefined();
    const iv = await DesignInterview.start("p", "s", objective, model);
    expect(iv.state.resolutions["privacy.required"]).toBeUndefined();
  });

  it("break_F0534_negated_chain_selected", async () => {
    expect(parseChains("Ethereum only, not Sui")).toEqual({ ok: true, value: ["ethereum-sepolia"] });
    expect(parseChains("never on sui, only ethereum")).toEqual({ ok: true, value: ["ethereum-sepolia"] });
    const iv = await DesignInterview.start("p", "s", "Pay my suppliers on Ethereum only, not Sui", model);
    expect(iv.ctx["chains"]).toEqual(["ethereum-sepolia"]);
  });
});
