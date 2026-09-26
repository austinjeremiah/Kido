import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { protectedSecret, resetStudioSecrets, ciphertextPathFor } from "../src/secrets.js";
import { gatewayTransport, TheGraphSubgraphAdapter } from "@contextlock/studio-adapters";

/*
 * A stand-in wallet-cli: the same command surface (`ring keys`, `ring decrypt --key --input --out`),
 * the same JSON error shapes, no device. It "decrypts" by copying the ciphertext file, which is
 * enough to prove the Studio side never reads the value except through the ring and never falls
 * back to the environment. The real binary is exercised by the hardware suite (BLK-002).
 */
function fakeCli(dir: string, opts: { initialized: boolean; failDecrypt?: string }): string {
  const p = join(dir, "wallet-cli");
  writeFileSync(p, `#!/usr/bin/env bash
if [ "$1 $2" = "ring keys" ]; then
  ${opts.initialized ? `echo '{"ok":true,"data":{"keys":["contextlock-studio"]}}'; exit 0` : `echo '{"ok":false,"error":{"command":"ring keys","message":"Ledger Key Ring not initialized. Run \`wallet-cli ring init\` first."}}'; exit 1`}
fi
if [ "$1 $2" = "ring decrypt" ]; then
  [ -z "$WALLET_PASS" ] && { echo '{"ok":false,"error":{"message":"password required"}}'; exit 1; }
  ${opts.failDecrypt ? `echo '{"ok":false,"error":{"message":"${opts.failDecrypt}"}}'; exit 1` : `while [ $# -gt 0 ]; do case "$1" in --input) in="$2"; shift;; --out) out="$2"; shift;; esac; shift; done; cp "$in" "$out"; exit 0`}
fi
echo '{"ok":false,"error":{"message":"unknown"}}'; exit 1
`);
  chmodSync(p, 0o755);
  return p;
}

const NAME = "THEGRAPH_API_KEY";
const VALUE = "test-graph-key-0123456789abcdef";
let dir: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["STUDIO_SECRETS_DIR", "LEDGER_WALLET_CLI", "WALLET_PASS", "STUDIO_SECRETS", "STUDIO_RING_KEY", NAME];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctx-secrets-"));
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.STUDIO_SECRETS_DIR = join(dir, "secrets");
  resetStudioSecrets();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true });
});

const putCiphertext = () => { const p = ciphertextPathFor(NAME); require("node:fs").mkdirSync(join(dir, "secrets"), { recursive: true }); writeFileSync(p, VALUE); return p; };

describe("Studio protected secrets — SEC", () => {
  it("SEC-001 a ring ciphertext makes the source the Ledger Key Ring, and the value only reaches a callback", async () => {
    process.env.LEDGER_WALLET_CLI = fakeCli(dir, { initialized: true });
    process.env.WALLET_PASS = "from-the-operator-keychain";
    putCiphertext();
    const s = protectedSecret(NAME);
    expect(s.source).toBe("ledger-key-ring");
    const seen = await s.withValue(async (v) => v.length);
    expect(seen).toBe(VALUE.length);
    const view = await s.view();
    expect(view.ring?.status).toBe("READY");
    expect(JSON.stringify(view)).not.toContain(VALUE);
  });

  it("SEC-002 the ring wins over a plaintext env var, and a ring failure never falls back to it", async () => {
    process.env.LEDGER_WALLET_CLI = fakeCli(dir, { initialized: true, failDecrypt: "Ledger Key Ring rotated" });
    process.env.WALLET_PASS = "x";
    process.env[NAME] = "plaintext-that-must-not-be-used";
    putCiphertext();
    const s = protectedSecret(NAME);
    expect(s.source).toBe("ledger-key-ring");
    // A typed message, never the CLI output and never the env value.
    await expect(s.withValue(async (v) => v)).rejects.toThrow(/Protected credential could not be decrypted/);
  });

  it("SEC-003 without WALLET_PASS the ring refuses; the password is never defaulted", async () => {
    process.env.LEDGER_WALLET_CLI = fakeCli(dir, { initialized: true });
    putCiphertext();
    await expect(protectedSecret(NAME).withValue(async (v) => v)).rejects.toThrow(/WALLET_PASS/);
  });

  it("SEC-004 a ring that is not initialised reports so, by status, without a value", async () => {
    process.env.LEDGER_WALLET_CLI = fakeCli(dir, { initialized: false });
    process.env.WALLET_PASS = "x";
    putCiphertext();
    const view = await protectedSecret(NAME).view();
    expect(view.source).toBe("ledger-key-ring");
    expect(view.ring?.status).toBe("NOT_INITIALIZED");
  });

  it("SEC-005 no ciphertext: the env var is used and labelled as such; nothing: absent", async () => {
    process.env.LEDGER_WALLET_CLI = fakeCli(dir, { initialized: true });
    process.env[NAME] = VALUE;
    const s = protectedSecret(NAME);
    expect(s.source).toBe("env");
    expect(await s.withValue(async (v) => v === VALUE)).toBe(true);
    delete process.env[NAME];
    expect(protectedSecret(NAME).source).toBe("absent");
  });

  it("SEC-006 STUDIO_SECRETS=ledger-key-ring never reads the environment", async () => {
    process.env.STUDIO_SECRETS = "ledger-key-ring";
    process.env[NAME] = VALUE;
    const s = protectedSecret(NAME);
    expect(s.source).toBe("absent");
    await expect(s.withValue(async (v) => v)).rejects.toThrow(/not configured/);
  });

  it("SEC-007 the Graph transport asks the source per request and reports a refusal as a failed request, never as a request without a key", async () => {
    process.env.LEDGER_WALLET_CLI = fakeCli(dir, { initialized: true, failDecrypt: "network error restoring trustchain" });
    process.env.WALLET_PASS = "x";
    putCiphertext();
    const s = protectedSecret(NAME);
    const calls: string[] = [];
    const send = gatewayTransport({
      apiKey: () => s.withValue(async (v) => v),
      fetchImpl: (async (url: string) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ data: {} }), text: async () => "" } as unknown as Response; }) as unknown as typeof fetch,
    });
    const r = await send({ templateId: "pool-liquidity", variables: { pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640" }, subgraphId: "S" });
    expect(calls).toHaveLength(0);
    expect(r.errors?.[0]?.message).toMatch(/credential unavailable: Ledger Key Ring is unreachable/);
    expect(() => new TheGraphSubgraphAdapter(send).normalize(r, { templateId: "pool-liquidity", variables: {}, subgraphId: "S" }, { chainId: 1, nowMs: Date.now() })).toThrow(/GRAPH-QUERY-ERROR/);
  });
});
