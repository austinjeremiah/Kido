import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  LedgerKeyRing, KeyRingError, classifyFailure, LedgerKeyRingSecretProvider,
  startProtectedService, type ProtectedServiceHandle,
} from "../src/index.js";

/**
 * Phase 6 LED-* Key Ring suite.
 *
 * LED-001/002/003 require a provisioned ring, which requires a physical Ledger. No device is
 * attached (BLK-002), so those are the only tests deferred; everything else — every failure mode,
 * every leak path, and the whole exfiltration gauntlet — runs here.
 *
 * The canary is a TEST value. It is not a credential and never was.
 */
const CANARY = "CTXLOCK_DEMO_SECRET_4d81ba7f2c9e";
const CLI = process.env.LEDGER_WALLET_CLI ?? "/nonexistent/wallet-cli";
const HAS_RING = process.env.CONTEXTLOCK_KEYRING_READY === "1";

let dir: string;
let ct: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctxlock-krtest-"));
  ct = join(dir, "secret.enc");
  writeFileSync(ct, "not-real-ciphertext");
});

const ring = () => new LedgerKeyRing({ cliPath: CLI, keyName: "contextlock-demo", ciphertextPath: ct, timeoutMs: 8000 });

describe("LED-004: the provider exposes no way to retrieve the secret", () => {
  it("has no getSecret-shaped method anywhere on the public surface", () => {
    const p = new LedgerKeyRingSecretProvider({ cliPath: CLI, keyName: "k", ciphertextPath: ct });
    const names = [
      ...Object.getOwnPropertyNames(p),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(p)),
    ];
    for (const n of names) {
      expect(n, `public surface must not expose ${n}`).not.toMatch(/getSecret|readSecret|reveal|decryptTo|exportSecret|secretValue/i);
    }
    expect(names).toContain("performProtectedAction");
  });

  it("the source declares no method returning a secret to a caller", () => {
    // Strip comments first: this must test the CODE, not the prose. The doc comment in
    // key-ring.ts legitimately says "There is no getSecret()", and a naive text scan would
    // match its own explanation and fail for the wrong reason.
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const src = strip(readFileSync(new URL("../src/secret-provider.ts", import.meta.url), "utf8")) +
                strip(readFileSync(new URL("../src/key-ring.ts", import.meta.url), "utf8"));
    expect(src).not.toMatch(/\bgetSecret\s*\(/);
    expect(src).not.toMatch(/return\s+secret\s*;/);

    // And prove the stripper actually removed something, so this cannot pass vacuously.
    expect(strip("/* getSecret() */ const x = 1;")).not.toContain("getSecret");
  });
});

describe("LED-008-KR / LED-009-KR / LED-010-KR: every failure fails closed", () => {
  it("missing WALLET_PASS throws MISSING_PASSWORD and never calls the CLI", async () => {
    const prev = process.env.WALLET_PASS;
    delete process.env.WALLET_PASS;
    try {
      await expect(ring().withSecret(async () => "should-not-run")).rejects.toBeInstanceOf(KeyRingError);
      await ring().withSecret(async () => "x").catch((e: KeyRingError) => {
        expect(e.code).toBe("MISSING_PASSWORD");
      });
    } finally { if (prev !== undefined) process.env.WALLET_PASS = prev; }
  });

  it("empty WALLET_PASS is treated as missing, not as a valid empty password", async () => {
    const prev = process.env.WALLET_PASS;
    process.env.WALLET_PASS = "";
    try {
      await ring().withSecret(async () => "x").catch((e: KeyRingError) => {
        expect(e.code).toBe("MISSING_PASSWORD");
      });
    } finally { if (prev !== undefined) process.env.WALLET_PASS = prev; else delete process.env.WALLET_PASS; }
  });

  it("a missing CLI fails closed rather than degrading", async () => {
    process.env.WALLET_PASS = "test-pass-not-a-real-password";
    await expect(ring().withSecret(async () => "nope")).rejects.toBeInstanceOf(KeyRingError);
  });

  it("LED-010-KR: there is NO plaintext fallback path in the source", () => {
    const raw = readFileSync(new URL("../src/key-ring.ts", import.meta.url), "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // No reading a secret from the environment or a dotenv file as a substitute for the ring.
    expect(src).not.toMatch(/process\.env\.(CONTEXTLOCK_DEMO_SECRET|SECRET_|RISK_API_KEY)/);
    expect(src).not.toMatch(/dotenv|\.env["']/);
    // The only success path goes through a real `ring decrypt` invocation.
    const decryptCalls = (src.match(/"ring",\s*"decrypt"/g) ?? []).length;
    expect(decryptCalls).toBe(1);
  });

  it("classifies each documented failure mode distinctly", () => {
    expect(classifyFailure("Ledger Key Ring not initialized. Run `wallet-cli ring init` first.")).toBe("RING_NOT_INITIALIZED");
    expect(classifyFailure("getaddrinfo ENOTFOUND api.ledger.com")).toBe("NETWORK_UNAVAILABLE");
    expect(classifyFailure("failed to restore trustchain")).toBe("NETWORK_UNAVAILABLE");
    expect(classifyFailure("incorrect password")).toBe("BAD_PASSWORD");
    expect(classifyFailure("unable to decrypt: auth tag mismatch")).toBe("CIPHERTEXT_INVALID");
    expect(classifyFailure("spawn ENOENT")).toBe("CLI_NOT_FOUND");
  });
});

describe("LED-011-KR: errors never carry the secret or the password", () => {
  it("a thrown KeyRingError message comes from a fixed table, not from CLI output", async () => {
    process.env.WALLET_PASS = "hunter2-not-a-real-password";
    try {
      await ring().withSecret(async () => "x");
    } catch (e) {
      const err = e as KeyRingError;
      const blob = `${err.message}|${err.stack ?? ""}|${JSON.stringify(err)}`;
      expect(blob).not.toContain(CANARY);
      expect(blob).not.toContain("hunter2-not-a-real-password");
    }
  });

  it("classifyFailure returns only a code, discarding the raw text", () => {
    const code = classifyFailure(`decrypt failed for secret ${CANARY} with password hunter2`);
    expect(code).not.toContain(CANARY);
    expect(typeof code).toBe("string");
    expect(code.length).toBeLessThan(40);
  });
});

describe("LED-003 / LED-005: the protected service authenticates, the caller gets only a scoped result", () => {
  let svc: ProtectedServiceHandle;
  afterEach(async () => { if (svc) await svc.close(); });

  it("rejects a call with no credential and never echoes what was presented", async () => {
    svc = await startProtectedService(CANARY);
    const res = await fetch(svc.url, { headers: { Authorization: "Bearer wrong-token" } });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain(CANARY);
    expect(body).not.toContain("wrong-token");
    expect(svc.unauthorizedCalls).toBe(1);
    expect(svc.authorizedCalls).toBe(0);
  });

  it("accepts the correct credential and returns only a coarse risk band", async () => {
    svc = await startProtectedService(CANARY);
    const res = await fetch(svc.url, { headers: { Authorization: `Bearer ${CANARY}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.riskBand).toBe("LOW");
    // The scoped response contains no credential.
    expect(JSON.stringify(body)).not.toContain(CANARY);
    expect(svc.authorizedCalls).toBe(1);
  });
});

describe("LED-012-KR: the agent cannot drive arbitrary Key Ring commands", () => {
  it("the provider exposes no command/argument passthrough", () => {
    const src = readFileSync(new URL("../src/key-ring.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // Arguments to execFile are literal arrays, never caller-supplied strings.
    expect(src).not.toMatch(/execFile\([^)]*\.\.\.\s*args/);
    expect(src).not.toMatch(/shell:\s*true/);
    expect(src).not.toMatch(/\bexecSync\b|\bspawnSync\b.*shell/);
  });

  it("the key name and ciphertext path are fixed at construction, not per call", () => {
    const p = new LedgerKeyRingSecretProvider({ cliPath: CLI, keyName: "k", ciphertextPath: ct });
    // performProtectedAction takes only a URL; there is no key/command parameter to hijack.
    expect(p.performProtectedAction.length).toBe(1);
    const src = readFileSync(new URL("../src/secret-provider.ts", import.meta.url), "utf8");
    expect(src).toMatch(/performProtectedAction\(input:\s*\{\s*url:\s*string\s*\}\)/);
  });
});

describe.skipIf(!HAS_RING)("LED-001 / LED-002 (require a provisioned ring - BLK-002)", () => {
  it("LED-002: encrypt then decrypt round-trips the protected credential", async () => {
    const plain = join(dir, "plain.txt");
    writeFileSync(plain, CANARY);
    const enc = join(dir, "round.enc");
    execFileSync(CLI, ["ring", "encrypt", "--key", "contextlock-demo", "--input", plain, "--out", enc]);
    expect(existsSync(enc)).toBe(true);
    const r = new LedgerKeyRing({ cliPath: CLI, keyName: "contextlock-demo", ciphertextPath: enc });
    const got = await r.withSecret(async (s) => s === CANARY);
    expect(got).toBe(true);
  });
});
