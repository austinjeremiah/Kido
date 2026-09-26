import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "@kido/registry";
import { KnowledgeBase, KnowledgeDriftError, assertNoSecurityDrift } from "../src/index.js";

const kb = KnowledgeBase.load();
const reg = new ProviderRegistry();

function fixture(packs: { pack: string; providerId: string | null; version: string; facts: string; deployments?: Record<string, Record<string, string>> }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "kido-break-kb-"));
  for (const p of packs) {
    const d = join(dir, p.pack);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ schemaVersion: "kido.knowledge-pack/v1", pack: p.pack, providerId: p.providerId, displayName: p.pack, version: p.version, researchDate: "2026-09-26", status: "VERIFIED_LIVE", statusNote: "", chains: [], sdk: [], capabilities: [], deployments: p.deployments ?? {}, limitations: [], failureModes: [], sources: [], execution: [] }));
    writeFileSync(join(d, "facts.md"), p.facts);
  }
  return dir;
}

describe("BREAK: knowledge drift", () => {
  it("break_F0530_amane_pack_version_drift_not_detected", () => {
    // A platform/amane pack at version "1" while the registry pins the current Amane release.
    const amane = reg.get("amane")!;
    const stale = KnowledgeBase.load(fixture([{ pack: amane.knowledgePack, providerId: null, version: "1", facts: "" }]));
    expect(stale.drift(reg).filter((i) => i.source === "registry").map((i) => i.pack)).toContain("platform/amane");
    // the shipped pack matches the registry
    expect(kb.drift(reg).filter((i) => i.pack === "platform/amane")).toEqual([]);
  });

  it("break_F0530_adapter_drift_ignored_when_pack_lacks_provider_id", () => {
    const issues = kb.drift(reg, { amane: "testnet release v2" });
    expect(() => assertNoSecurityDrift(issues)).toThrow(KnowledgeDriftError);
  });

  it("break_F0530_missing_pack_is_not_drift", () => {
    const empty = KnowledgeBase.load(fixture([]));
    expect(empty.drift(reg, { "aave-v3": "v4" }).length).toBeGreaterThan(0);
  });

  it("break_F0531_deployment_address_drift_not_detected", () => {
    const aave = reg.get("aave-v3")!;
    const dir = fixture([{ pack: aave.knowledgePack, providerId: "aave-v3", version: aave.version, facts: "", deployments: { "ethereum-sepolia": { ...aave.deployments["ethereum-sepolia"], pool: `0x${"de".repeat(20)}` } } }]);
    const issues = KnowledgeBase.load(dir).drift(reg);
    expect(issues.some((i) => i.securityRelevant)).toBe(true);
  });
});

describe("BREAK: secrets in knowledge", () => {
  it("break_F0532_secret_in_pack_reaches_role_context", () => {
    const secrets = [
      "OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      "suiprivkey1qzv8m0example0example0example0example0example0example0",
      `deployer key 0x${"4f".repeat(32)}`,
    ];
    const kb2 = KnowledgeBase.load(fixture([{ pack: "protocols/aave-v3", providerId: "aave-v3", version: "v3", facts: `# facts\n${secrets.join("\n")}\n` }]));
    let text = "";
    try {
      text = kb2.contextFor(["protocols/aave-v3"]).text;
    } catch {
      return; // refusing to load/serve a secret-bearing pack is acceptable
    }
    for (const s of secrets) expect(text, s).not.toContain(s.split(/[= ]/).pop()!);
  });
});
