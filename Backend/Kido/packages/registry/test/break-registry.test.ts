import { describe, expect, it } from "vitest";
import { PLANNING, ProviderRegistry, type SelectionRequest } from "../src/index.js";

const reg = new ProviderRegistry();
const LIVE = ["VERIFIED_LIVE" as const];

describe("BREAK: status honesty", () => {
  it("fixed_F0527_wormhole_counted_live_only_with_a_live_transfer_on_record", () => {
    // Live since the 2026-09-26 Amane round trip; the same provider without that record is not live.
    const s = reg.select({ kind: "transport", chain: "sui-testnet", capabilities: ["TOKEN_TRANSFER"], acceptStatus: LIVE });
    expect(s.selected.map((p) => p.providerId)).toContain("wormhole");
    expect(reg.get("wormhole")!.implementation.evidence.length).toBeGreaterThan(0);
    const unproven = new ProviderRegistry(reg.providers.map((p) => (p.providerId === "wormhole" ? { ...p, status: "VERIFIED_DOCS" as const, implementation: { status: "NOT_IMPLEMENTED" as const, proven: [], notProven: ["any transfer"], evidence: [] } } : p)));
    expect(unproven.select({ kind: "transport", chain: "sui-testnet", capabilities: ["TOKEN_TRANSFER"], acceptStatus: LIVE }).selected.map((p) => p.providerId)).not.toContain("wormhole");
  });

  it("break_F0528_unshipped_execution_adapter_counted_as_live_capability", () => {
    // An execution capability whose adapter is not shipped is never live, whatever the provider status.
    const unshipped = new ProviderRegistry(reg.providers.map((p) => (p.execution ? { ...p, execution: p.execution.map((e) => ({ ...e, shipped: false })) } : p)));
    for (const [chain, cap] of [["ethereum-sepolia", "LENDING_REPAY"], ["ethereum-sepolia", "DEX_SWAP"], ["sui-testnet", "DEX_SWAP"]] as const) {
      const s = unshipped.select({ kind: "protocol", chain, capabilities: [cap], acceptStatus: LIVE });
      expect(s.selected, `${chain}:${cap}`).toEqual([]);
      expect(reg.select({ kind: "protocol", chain, capabilities: [cap], acceptStatus: LIVE }).selected.length, `${chain}:${cap} shipped`).toBe(1);
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
