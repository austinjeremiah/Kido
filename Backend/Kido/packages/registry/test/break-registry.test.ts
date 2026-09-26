import { describe, expect, it } from "vitest";
import { PLANNING, ProviderRegistry, type SelectionRequest } from "../src/index.js";

const reg = new ProviderRegistry();
const LIVE = ["VERIFIED_LIVE" as const];

describe("BREAK: status honesty", () => {
  it("break_F0527_wormhole_token_transfer_counted_live_without_a_live_transfer", () => {
    // Its own statusNote says "no live transfer run yet (BE-WH-1)".
    const s = reg.select({ kind: "transport", chain: "sui-testnet", capabilities: ["TOKEN_TRANSFER"], acceptStatus: LIVE });
    expect(s.selected.map((p) => p.providerId)).not.toContain("wormhole");
  });

  it("break_F0528_unshipped_execution_adapter_counted_as_live_capability", () => {
    // Aave REPAY / Uniswap and Cetus SWAP adapters are shipped:false (Amane v1 ships PAY only).
    for (const [chain, cap] of [["ethereum-sepolia", "LENDING_REPAY"], ["ethereum-sepolia", "DEX_SWAP"], ["sui-testnet", "DEX_SWAP"]] as const) {
      const s = reg.select({ kind: "protocol", chain, capabilities: [cap], acceptStatus: LIVE });
      expect(s.selected, `${chain}:${cap}`).toEqual([]);
    }
  });

  it("break_F0528_isLive_ignores_per_capability_status", () => {
    // SuiNS REGISTER and SUBNAME are BLOCKED_ENV; a capability-blind isLive() overclaims.
    const isLive = reg.isLive as unknown as (id: string, capability?: string) => boolean;
    expect(isLive.call(reg, "suins", "REGISTER")).toBe(false);
  });

  it("break_F0528_find_ignores_status_used_for_identity_bindings", () => {
    // compileBlueprint binds identity providers via find(); a BLOCKED_ENV provider must not be returned as usable.
    const blocked = new ProviderRegistry(reg.providers.map((p) => (p.providerId === "ens" ? { ...p, status: "BLOCKED_ENV" as const } : p)));
    expect(blocked.find("identity", "ethereum-sepolia", "RESOLVE").map((p) => p.providerId)).not.toContain("ens");
  });
});

describe("BREAK: trust-aware selection", () => {
  it("break_F0529_secret_store_selected_for_secret_hidden_from_kido_backend", () => {
    // §27.3: an API key hidden from the normal backend needs SECRET_ACCESS_CONTROL/CONFIDENTIAL_COMPUTE,
    // never the Kido host secret store whose trust profile requires trusting the Kido backend.
    const req = { kind: "privacy", chain: "sui-testnet", capabilities: ["SECRET_STORAGE"], acceptStatus: PLANNING, hiddenFrom: ["NORMAL_KIDO_BACKEND"] } as SelectionRequest;
    const s = reg.select(req);
    expect(s.selected.map((p) => p.providerId)).not.toContain("kido-secret-store");
    expect(s.rejected.find((r) => r.providerId === "kido-secret-store")?.reason ?? "").toMatch(/trust/i);
  });
});
