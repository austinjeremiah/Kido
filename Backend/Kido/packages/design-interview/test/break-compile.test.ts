import { describe, expect, it } from "vitest";
import { blueprintHash, buildBlockers } from "@kido/blueprint";
import { ProviderRegistry } from "@kido/registry";
import { DesignInterview, compileBlueprint } from "../src/index.js";
import { drive, model } from "./break-helpers.js";
const FACTS = new ProviderRegistry().gateFacts();

describe("BREAK: requirements compiler", () => {
  it("break_F0521_limit_invented_in_asset_user_never_chose", async () => {
    // The user sets a budget in AMSUI only. The Ethereum endpoint must not receive a budget in a
    // different asset (AMUSD) that the user never named (bible §2.16, §10.3.3 "larger budgets").
    const { bp } = await drive("Rebalance my portfolio when allocation drifts on Ethereum and Sui", {
      protocols: "Uniswap and Cetus",
      "actions.allowed": "swap tokens",
      "assets.spend": "AMSUI",
      "limits.window": "500",
      "limits.total": "1000",
    });
    const eth = bp.authority.limits.filter((l) => l.chain === "ethereum-sepolia");
    expect(eth.filter((l) => l.asset !== "AMSUI")).toEqual([]);
  });

  it("break_F0522_actions_bound_to_first_chain_and_protocol", async () => {
    // Bible §45.1 rescue shape: repay on Aave (Ethereum), swap on Cetus (Sui).
    const { bp } = await drive("Protect my Aave position, swapping on Cetus, using liquidity on Ethereum and Sui", {
      "actions.allowed": "repay my debt and swap tokens",
      "assets.spend": "AMUSD",
      "authority.autonomy": "Only when a condition it can prove on-chain occurs",
      "monitor.condition": "health factor below 1.5",
    });
    expect(bp.protocols.map((p) => p.providerId).sort()).toEqual(["aave-v3", "cetus-clmm"]);
    const swap = bp.actions.find((a) => a.action === "SWAP")!;
    expect(swap).toMatchObject({ chain: "sui-testnet", providerId: "cetus-clmm" });
  });

  it("break_F0522_action_without_a_capable_protocol_is_buildable", async () => {
    // Only Aave is selected, the question offers REPAY/SUPPLY, yet "swap" is accepted and bound to Aave.
    const reg = new ProviderRegistry();
    const { bp } = await drive("Build me an agent that protects my Aave position.", {
      "actions.allowed": "repay my debt and swap tokens",
      "authority.autonomy": "Only when a condition it can prove on-chain occurs",
      "monitor.condition": "health factor below 1.5",
    });
    const need: Record<string, string> = { SWAP: "DEX_SWAP", REPAY: "LENDING_REPAY", SUPPLY: "LENDING_SUPPLY", PAY: "BOUNDED_EXECUTION" };
    const unserved = bp.actions.filter((a) => {
      const m = reg.get(a.providerId);
      return !m || !m.chains.includes(a.chain) || !m.capabilities.includes(need[a.action] ?? a.action);
    });
    expect(unserved.length === 0 || buildBlockers(bp, FACTS).length > 0).toBe(true);
  });
});

describe("BREAK: interview edits and revisions", () => {
  it("break_F0523_edit_does_not_produce_a_new_chained_revision", async () => {
    const { iv, bp: before } = await drive("Rebalance my portfolio on Ethereum when allocation drifts", { protocols: "Uniswap" });
    await iv.edit("limits.window", "50");
    const after = compileBlueprint(iv.resolutionsBlueprint());
    expect(blueprintHash(after)).not.toBe(blueprintHash(before));
    // §9.2 / §10.3.5: an explicit edit creates a NEW revision that commits to the one it replaces.
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it("break_F0525_edit_leaves_dependent_inferred_resolutions_stale", async () => {
    const iv = await DesignInterview.start("p", "s", "Build me an agent that protects my Aave position.", model);
    expect(iv.ctx["chains"]).toEqual(["ethereum-sepolia"]); // inferred from Aave
    await iv.edit("protocols", "Cetus");
    // chains was inferred from the old protocol; it must be re-derived (or dropped), not kept.
    expect(iv.ctx["chains"]).not.toEqual(["ethereum-sepolia"]);
  });

  it("break_F0526_lease_lifetime_edit_parsed_as_token_amount", async () => {
    const { iv } = await drive("Rebalance my portfolio on Ethereum when allocation drifts", { protocols: "Uniswap" });
    await iv.edit("authority.lease_lifetime", "7200");
    const bp = (() => {
      try {
        return compileBlueprint(iv.resolutionsBlueprint());
      } catch (e) {
        return String(e);
      }
    })();
    expect(typeof bp === "string" ? bp : bp.authority.leaseLifetimeSeconds).toBe(7200);
  });
});

describe("BREAK: role-scoped knowledge", () => {
  it("break_F0533_specialist_receives_unrelated_protocol_packs", async () => {
    const { bp } = await drive("Protect my Aave position, swapping on Cetus, using liquidity on Ethereum and Sui", {
      "actions.allowed": "repay my debt and swap tokens",
      "assets.spend": "AMUSD",
      "authority.autonomy": "Only when a condition it can prove on-chain occurs",
      "monitor.condition": "health factor below 1.5",
    });
    const swap = bp.agents.find((a) => a.role === "SwapAgent")!;
    // §13.1: relevant knowledge pack(s) only — a swap specialist has no use for the Aave lending pack.
    expect(swap.knowledgePacks).not.toContain("protocols/aave-v3");
  });
});
