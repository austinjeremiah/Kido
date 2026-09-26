import { describe, expect, it } from "vitest";
import { buildBlockers } from "@kido/blueprint";
import { ProviderRegistry } from "@kido/registry";
import { parseAmount } from "../src/index.js";
import { drive } from "./break-helpers.js";

const FACTS = new ProviderRegistry().gateFacts();
const RESCUE = {
  "authority.bridge": "no",
  "actions.allowed": "repay my debt and swap tokens",
  "authority.autonomy": "Only when a condition it can prove on-chain occurs",
  "limits.swap_floor": "at least 0.95 AMSUI for each AMUSD",
  "monitor.condition": "health factor below 1.5",
};
const OBJECTIVE = "Protect my Aave position, swapping on Cetus, using liquidity on Ethereum and Sui";

describe("spend assets per chain", () => {
  it("one amount becomes a budget in each chosen asset, in that asset's own decimals", () => {
    expect(parseAmount("500", { "assets.spend": ["USDC", "AMSUI"] })).toEqual({ ok: true, value: { USDC: "500000000", AMSUI: "500000000000" } });
  });

  it("a rescue agent budgets USDC for Aave on Ethereum and AMUSD for Cetus on Sui", async () => {
    const { bp } = await drive(OBJECTIVE, { ...RESCUE, "assets.spend": "USDC and AMUSD", "limits.window": "500", "limits.total": "2000" });
    expect(bp.authority.limits.map((l) => `${l.chain}:${l.asset}:${l.perWindow}`)).toEqual(["ethereum-sepolia:USDC:500000000", "sui-testnet:AMUSD:500000000"]);
    expect(bp.actions.map((a) => `${a.action}:${a.providerId}:${a.chain}`).sort()).toEqual(["REPAY:aave-v3:ethereum-sepolia", "SWAP:cetus-clmm:sui-testnet"]);
    expect(buildBlockers(bp, FACTS).map((b) => b.code)).not.toContain("KIDO_BLUEPRINT_ACTION_NO_BUDGET");
  });

  it("an action whose provider cannot spend any budgeted asset blocks the build", async () => {
    const { bp } = await drive(OBJECTIVE, { ...RESCUE, "assets.spend": "AMUSD", "limits.window": "500", "limits.total": "2000" });
    expect(buildBlockers(bp, FACTS)).toContainEqual({ code: "KIDO_BLUEPRINT_ACTION_NO_BUDGET", detail: "REPAY via aave-v3 on ethereum-sepolia has no budget in an asset it accepts" });
  });
});
