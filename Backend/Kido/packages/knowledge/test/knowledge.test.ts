import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "@kido/registry";
import { KnowledgeBase, KnowledgeDriftError, assertNoSecurityDrift } from "../src/index.js";

const kb = KnowledgeBase.load();
const reg = new ProviderRegistry();

describe("platform knowledge system", () => {
  it("every registry provider has a pack and every platform pack exists", () => {
    for (const p of reg.providers) expect(kb.get(p.knowledgePack), p.knowledgePack).toBeDefined();
    for (const id of ["platform/kido", "platform/actions", "platform/blueprint", "platform/identity", "platform/privacy", "platform/amane", "chains/ethereum-sepolia", "chains/sui-testnet"]) expect(kb.get(id), id).toBeDefined();
  });

  it("pack versions match the registry (no drift today)", () => {
    expect(kb.drift(reg)).toEqual([]);
  });

  it("a security-relevant version mismatch fails closed", () => {
    const issues = kb.drift(reg, { "cetus-clmm": "testnet package_version 2" });
    expect(issues).toEqual([expect.objectContaining({ pack: "protocols/cetus-clmm", source: "adapter", securityRelevant: true })]);
    expect(() => assertNoSecurityDrift(issues)).toThrow(KnowledgeDriftError);
  });

  it("packs contain no secret-shaped strings", () => {
    const secretish = /(alchemy\.com\/v2\/[A-Za-z0-9_-]{8,}|infura\.io\/v3\/[a-f0-9]{8,}|sk-[A-Za-z0-9]{16,}|-----BEGIN|suiprivkey1|0x[0-9a-f]{64}\s*#\s*private)/i;
    for (const p of kb.packs.values()) expect(secretish.test(p.facts + JSON.stringify(p.manifest)), p.id).toBe(false);
  });

  it("role context includes only the requested packs and names missing ones", () => {
    const c = kb.contextFor(["platform/kido", "protocols/aave-v3", "protocols/does-not-exist"]);
    expect(c.included).toEqual(["platform/kido", "protocols/aave-v3"]);
    expect(c.missing).toEqual(["protocols/does-not-exist"]);
    expect(c.text).toContain("KNOWLEDGE PACK protocols/aave-v3");
    expect(c.text).not.toContain("KNOWLEDGE PACK protocols/cetus-clmm");
    expect(c.text).toContain("treat as unknown");
  });

  it("the Aave pack carries the facts a repay specialist needs", () => {
    const f = kb.get("protocols/aave-v3")!;
    expect(f.facts).toMatch(/onBehalfOf/);
    expect(f.facts).toMatch(/variableDebtToken|vDebt/);
    expect(f.manifest.deployments["ethereum-sepolia"]!.pool).toBe("0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951");
  });
});
