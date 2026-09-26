import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "@kido/registry";
import { BlockedEnvError, ChainlinkCreDecisionAdapter, NautilusDecisionAdapter, SimulatedDecisionAdapter, readiness, sealSettings } from "../src/index.js";

const reg = new ProviderRegistry();
const req = { key: `0x${"11".repeat(32)}` as const, blueprintHash: `0x${"22".repeat(32)}` as const };

describe("privacy adapters", () => {
  it("Nautilus reports BLOCKED_ENV and refuses to produce a decision", async () => {
    const n = new NautilusDecisionAdapter(reg);
    expect(n.readiness()).toMatchObject({ status: "BLOCKED_ENV", live: false });
    await expect(n.decide()).rejects.toBeInstanceOf(BlockedEnvError);
  });

  it("CRE readiness follows the registry, not configuration", () => {
    const cre = new ChainlinkCreDecisionAdapter(reg, "0x41032ee6b7a635b16ead62d0bcc20a9be05a5164");
    expect(cre.readiness()).toMatchObject({ status: "BLOCKED_ENV", live: false });
    expect(cre.readiness().blockers[0]).toMatch(/BE-CRE/);
  });

  it("Seal is live for access-controlled encrypted state", () => {
    expect(readiness(reg, "seal", "ENCRYPTED_STATE")).toMatchObject({ status: "VERIFIED_LIVE", live: true });
  });

  it("simulated decisions are always labelled SIMULATED", async () => {
    const s = new SimulatedDecisionAdapter("nautilus", () => true, () => 7);
    expect(await s.decide(req)).toMatchObject({ act: true, trust: "SIMULATED", evaluatedAt: 7 });
    expect(s.readiness().live).toBe(false);
  });

  it("Seal settings come from the registry", () => {
    const s = sealSettings(reg);
    expect(s.keyServers).toHaveLength(2);
    expect(s.threshold).toBe(2);
    expect(s.packageId).toBe(reg.get("seal")!.deployments["sui-testnet"]!.kidoReaderPolicyPackage);
    expect(() => sealSettings(reg, "ethereum-sepolia")).toThrow(/not configured/);
  });
});
