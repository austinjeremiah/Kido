import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceStore } from "../src/evidence.js";

/** Evidence citations open as read-only files inside the configured roots, redacted, never key material. */
const root = mkdtempSync(join(tmpdir(), "kido-evidence-"));
const kido = join(root, "kido"), amane = join(root, "amane"), gauntlet = join(root, "gauntlet");
for (const d of [join(kido, "packages/privacy/test"), join(amane, "scripts"), join(gauntlet, "evidence/run-1"), join(gauntlet, "keys")]) mkdirSync(d, { recursive: true });
writeFileSync(join(kido, "packages/privacy/test/nautilus.test.ts"), "it('verifies', () => {});\n");
writeFileSync(join(kido, ".env"), "OPENAI_API_KEY=sk-live-not-for-you-0000000000000000\n");
writeFileSync(join(amane, "scripts/live.ts"), 'const privateKey = "0xabcdefabcdefabcdefabcdef";\nconst k = "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";\n');
writeFileSync(join(gauntlet, "evidence/run-1/evidence.json"), '{"step":"ok"}');
writeFileSync(join(gauntlet, "evidence/run-2.json"), '{"step":"ok"}');
writeFileSync(join(gauntlet, "keys/demo.json"), '{"secret":"x"}');
const store = new EvidenceStore({ kido, amane, gauntlet });

describe("evidence store", () => {
  it("opens a cited file by its repository", () => {
    const r = store.resolve("Kido packages/privacy/test/nautilus.test.ts");
    expect(r.files.map((f) => f.path)).toEqual(["packages/privacy/test/nautilus.test.ts"]);
    expect(store.read(r.files[0]!.id).content).toContain("verifies");
  });

  it("expands a glob to matching files and run directories", () => {
    const r = store.resolve(".gauntlet/evidence/run-*.json");
    expect(r.files.map((f) => f.path).sort()).toEqual(["evidence/run-1/evidence.json", "evidence/run-2.json"]);
  });

  it("reports a citation that names no file as a statement", () => {
    expect(store.resolve("BE-NAUT-1: no Nitro host available")).toMatchObject({ files: [], note: expect.stringMatching(/statement/) });
  });

  it("redacts secret-shaped values", () => {
    const f = store.resolve("Amane scripts/live.ts").files[0]!;
    const r = store.read(f.id);
    expect(r.content).not.toMatch(/abcdefabcdef|suiprivkey1q/);
    expect(r.redactions).toBe(2);
  });

  it("never serves key material, environment files or paths outside a root", () => {
    expect(store.resolve(".gauntlet/keys/demo.json").files).toEqual([]);
    expect(store.resolve(".gauntlet/keys").files).toEqual([]);
    expect(store.resolve("Kido .env").files).toEqual([]);
    const forged = (root: string, p: string) => Buffer.from(`${root}:${p}`).toString("base64url");
    expect(() => store.read(forged("gauntlet", "keys/demo.json"))).toThrow();
    expect(() => store.read(forged("kido", ".env"))).toThrow();
    expect(() => store.read(forged("kido", "../amane/scripts/live.ts"))).toThrow();
  });
});
