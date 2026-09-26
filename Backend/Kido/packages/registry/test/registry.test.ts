import { describe, expect, it } from "vitest";
import { CAPABILITIES, PLANNING, ProviderRegistry } from "../src/index.js";

const reg = new ProviderRegistry();

describe("provider registry", () => {
  it("every manifest uses only its kind's closed capability vocabulary and has a trust profile", () => {
    for (const p of reg.providers) {
      for (const c of p.capabilities) expect(CAPABILITIES[p.kind] as readonly string[], `${p.providerId}:${c}`).toContain(c);
      expect(p.trust.providerId).toBe(p.providerId);
      expect(p.trust.requiresTrustIn.length).toBeGreaterThan(0);
      expect(p.knowledgePack).toMatch(/^[a-z]+\/[a-z0-9-]+$/);
    }
  });

  it("KIDO-REG-001 capability lookup returns chain-appropriate providers without protocol branching", () => {
    expect(reg.find("protocol", "sui-testnet", "DEX_SWAP").map((p) => p.providerId)).toEqual(["cetus-clmm"]);
    expect(reg.find("protocol", "ethereum-sepolia", "DEX_SWAP").map((p) => p.providerId)).toEqual(["uniswap-v3"]);
    expect(reg.find("protocol", "ethereum-sepolia", "LENDING_REPAY").map((p) => p.providerId)).toEqual(["aave-v3"]);
    expect(reg.find("identity", "sui-testnet", "RESOLVE").map((p) => p.providerId)).toEqual(["suins"]);
    expect(reg.find("identity", "ethereum-sepolia", "RESOLVE").map((p) => p.providerId)).toEqual(["ens"]);
  });

  it("ENS is never selected for a Sui name and SuiNS never for an Ethereum name", () => {
    const s = reg.select({ kind: "identity", chain: "sui-testnet", capabilities: ["RESOLVE"], acceptStatus: PLANNING });
    expect(s.selected.map((p) => p.providerId)).toEqual(["suins"]);
    expect(s.rejected).toContainEqual({ providerId: "ens", reason: "not available on sui-testnet" });
  });

  it("a live claim refuses unverified providers and says why", () => {
    const s = reg.select({ kind: "privacy", chain: "sui-testnet", capabilities: ["CONFIDENTIAL_COMPUTE"], acceptStatus: ["VERIFIED_LIVE"] });
    expect(s.selected).toEqual([]);
    expect(s.uncovered).toEqual(["CONFIDENTIAL_COMPUTE"]);
    expect(s.rejected.find((r) => r.providerId === "nautilus")!.reason).toMatch(/^status BLOCKED_ENV/);
  });

  it("per-capability status: SuiNS resolves live but live registration is refused with the blocker", () => {
    expect(reg.select({ kind: "identity", chain: "sui-testnet", capabilities: ["RESOLVE"], acceptStatus: ["VERIFIED_LIVE"] }).selected.map((p) => p.providerId)).toEqual(["suins"]);
    const r = reg.select({ kind: "identity", chain: "sui-testnet", capabilities: ["REGISTER"], acceptStatus: ["VERIFIED_LIVE"] });
    expect(r.uncovered).toEqual(["REGISTER"]);
    expect(r.rejected.find((x) => x.providerId === "suins")!.reason).toMatch(/BC-SUINS-1/);
  });

  it("selection prefers the smallest covering set", () => {
    const s = reg.select({ kind: "privacy", chain: "ethereum-sepolia", capabilities: ["SECRET_STORAGE"], acceptStatus: PLANNING });
    expect(s.selected.map((p) => p.providerId)).toEqual(["kido-secret-store"]);
  });

  it("the asset graph never conflates tickers across chains", () => {
    const amusd = reg.assets.filter((a) => a.symbol === "AMUSD");
    expect(new Set(amusd.map((a) => a.ref)).size).toBe(2);
    expect(reg.assetsOn("ethereum-sepolia").find((a) => a.symbol === "USDC")!.ref).toBe("0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8");
  });

  it("execution mappings never point at a generic call adapter", () => {
    for (const p of reg.providers) for (const e of p.execution ?? []) expect(e.adapter).not.toMatch(/generic|arbitrary|call/);
  });
});
