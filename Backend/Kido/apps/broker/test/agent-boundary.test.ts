import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * P5.4 — automated proof that the untrusted agent holds no privileged key.
 *
 * This is a structural check on the source tree, not a runtime assertion, because the property
 * must hold by construction: the demo agent package must not even be able to *reach* a privileged
 * key, regardless of what it is prompted to do.
 */
const ROOT = join(import.meta.dirname, "../../..");
const AGENT_DIR = join(ROOT, "apps/demo-agent");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === "dist") return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const agentFiles = walk(join(AGENT_DIR, "src"));
const agentSource = agentFiles.map((f) => readFileSync(f, "utf8")).join("\n");

/** Every key the agent must never hold. */
const FORBIDDEN_KEYS = [
  "CAPABILITY_ISSUER_PRIVATE_KEY",
  "DEPLOYER_PRIVATE_KEY",
  "RELAYER_PRIVATE_KEY",
  "FUNDER_PRIVATE_KEY",
  "CRE_ETH_PRIVATE_KEY",
  "WALLET_PASS",
];

describe("P5.4 untrusted agent boundary", () => {
  it("the agent package has source files to check (guards against a vacuous pass)", () => {
    expect(agentFiles.length).toBeGreaterThan(0);
    expect(agentSource.length).toBeGreaterThan(200);
  });

  it("the agent references no privileged key name", () => {
    for (const k of FORBIDDEN_KEYS) {
      expect(agentSource, `demo agent must never reference ${k}`).not.toContain(k);
    }
  });

  it("the agent never imports a signing library or touches process.env for keys", () => {
    expect(agentSource).not.toMatch(/privateKeyToAccount|mnemonicToAccount|signTypedData|signMessage/);
    expect(agentSource).not.toMatch(/process\.env\.[A-Z_]*PRIVATE_KEY/);
    expect(agentSource).not.toMatch(/process\.env\.WALLET_PASS/);
  });

  it("the agent declares no dependency that could sign or reach the key ring", () => {
    const pkg = JSON.parse(readFileSync(join(AGENT_DIR, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).not.toContain("@contextlock/protocol"); // would expose signing helpers
    expect(deps.filter((d) => d.startsWith("@ledgerhq/"))).toHaveLength(0);
    expect(deps).not.toContain("better-sqlite3"); // no direct access to the audit/authority store
  });

  it("the agent cannot read the broker database or the .env file", () => {
    expect(agentSource).not.toMatch(/\.env\b/);
    expect(agentSource).not.toMatch(/contextlock\.db|better-sqlite3|Database\(/);
  });

  it("the agent contains no refusal logic - security must not depend on it declining", () => {
    // Match CODE, not prose. hostile-corpus.ts legitimately uses words like "refused" and
    // "sanitized" when documenting which ContextLock control stops each attack; a plain word
    // search would flag its own explanation. What must not exist is a guardrail that makes the
    // agent decline, because that would silently stop the demo proving anything.
    const code = agentSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/if\s*\([^)]*\b(malicious|forbidden|blocked)\b[^)]*\)\s*(return|throw)/i);
    expect(code).not.toMatch(/function\s+(sanitize|blockRequest|refuse|guard)\s*\(/i);
    expect(code).not.toMatch(/\bthrow new Error\(['"`](refus|not allowed|forbidden)/i);
    // The hostile corpora must still be present and non-trivial.
    expect(agentSource).toContain("maliciousCorpus");
    expect(agentSource).toContain("hostileCorpus");
  });
});
