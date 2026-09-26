import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

/**
 * Ledger Key Ring (LKRP) secret provider.
 *
 * Verified against @ledgerhq/wallet-cli 2.1.0 — see docs/ledger-key-ring-current.md.
 *
 * Design rules, each of which exists because of a specific failure it prevents:
 *
 *  1. **There is no `getSecret()`.** The only public method is `withSecret`, which hands the
 *     plaintext to a callback and never returns it. An agent-reachable API that returns a
 *     credential is the exact pattern the Ledger track asks you to avoid.
 *
 *  2. **No plaintext fallback, ever.** If the ring is unavailable, the network is down, or
 *     `WALLET_PASS` is wrong, this throws. It never reads the secret from `.env`, never uses a
 *     cached copy, never degrades. A fallback would silently convert a hardware-protected
 *     credential into an environment variable.
 *
 *  3. **`WALLET_PASS` is referenced, never handled.** Ledger's own agent guidance is explicit that
 *     the agent must never choose, type, set or inject the password. This code reads it from the
 *     ambient environment and passes it through; it never generates, prompts for, logs, or
 *     defaults it.
 *
 *  4. **Plaintext is zeroized after use.** The decrypted buffer is overwritten and the temporary
 *     file unlinked, so the window in which the secret exists is as short as practical.
 *
 *  5. **Errors are sanitized.** CLI stdout/stderr can echo input; a raw error could carry
 *     plaintext into a log or an HTTP response. Every thrown error is reconstructed from a fixed
 *     set of messages, never from raw CLI output.
 */

export type KeyRingStatus = "READY" | "NOT_INITIALIZED" | "UNAVAILABLE";

export class KeyRingError extends Error {
  constructor(
    public readonly code:
      | "RING_NOT_INITIALIZED"
      | "NETWORK_UNAVAILABLE"
      | "BAD_PASSWORD"
      | "MISSING_PASSWORD"
      | "CIPHERTEXT_INVALID"
      | "CLI_NOT_FOUND"
      | "WRONG_KEY"
      | "UNKNOWN",
    message: string,
  ) {
    super(message);
    this.name = "KeyRingError";
  }
}

export type KeyRingConfig = {
  /** Absolute path to the @ledgerhq/wallet-cli binary. */
  cliPath: string;
  /** Scoped key name (`--key`). */
  keyName: string;
  /** Path to the ciphertext file produced by `ring encrypt`. */
  ciphertextPath: string;
  /** Milliseconds before a CLI invocation is abandoned. */
  timeoutMs?: number;
};

/**
 * Map raw CLI failure text onto a typed code.
 * Deliberately returns only a code — the raw text is discarded so it can never reach a log.
 */
export function classifyFailure(raw: string): KeyRingError["code"] {
  const s = raw.toLowerCase();
  if (s.includes("not initialized") || s.includes("ring init")) return "RING_NOT_INITIALIZED";
  if (s.includes("enoent") || s.includes("not found") || s.includes("spawn")) return "CLI_NOT_FOUND";
  if (s.includes("password") && (s.includes("incorrect") || s.includes("invalid") || s.includes("bad")))
    return "BAD_PASSWORD";
  if (s.includes("network") || s.includes("econnrefused") || s.includes("etimedout") ||
      s.includes("enotfound") || s.includes("trustchain") || s.includes("fetch"))
    return "NETWORK_UNAVAILABLE";
  if (s.includes("decrypt") || s.includes("cipher") || s.includes("auth tag") || s.includes("gcm"))
    return "CIPHERTEXT_INVALID";
  if (s.includes("key")) return "WRONG_KEY";
  return "UNKNOWN";
}

const MESSAGES: Record<KeyRingError["code"], string> = {
  RING_NOT_INITIALIZED: "Ledger Key Ring is not initialized on this machine",
  NETWORK_UNAVAILABLE: "Ledger Key Ring is unreachable (network required to restore the trustchain)",
  BAD_PASSWORD: "Ledger Key Ring password rejected",
  MISSING_PASSWORD: "WALLET_PASS is not present in the environment",
  CIPHERTEXT_INVALID: "Protected credential could not be decrypted",
  CLI_NOT_FOUND: "Ledger wallet-cli binary not found",
  WRONG_KEY: "Ledger Key Ring key name does not match the ciphertext",
  UNKNOWN: "Ledger Key Ring operation failed",
};

export class LedgerKeyRing {
  constructor(private readonly cfg: KeyRingConfig) {}

  /** Non-secret status probe. `ring keys` is local-cache only and needs no network or device. */
  async status(): Promise<KeyRingStatus> {
    try {
      const { stdout } = await exec(this.cfg.cliPath, ["ring", "keys", "--output", "json"], {
        timeout: this.cfg.timeoutMs ?? 30_000,
        env: process.env,
      });
      // wallet-cli 2.1.0 answers success as {"status":"success",…} and failure as {"ok":false,…};
      // an earlier build used {"ok":true}. Verified against the real binary on 2026-09-13.
      const parsed = JSON.parse(stdout) as { ok?: boolean; status?: string };
      return parsed.ok === true || parsed.status === "success" ? "READY" : "NOT_INITIALIZED";
    } catch (e) {
      const raw = String((e as { stdout?: string; stderr?: string; message?: string }).stdout ?? "") +
        String((e as { stderr?: string }).stderr ?? "") + String((e as Error).message ?? "");
      return classifyFailure(raw) === "RING_NOT_INITIALIZED" ? "NOT_INITIALIZED" : "UNAVAILABLE";
    }
  }

  /**
   * Decrypt the protected credential and hand it to `use`. The plaintext is never returned.
   *
   * @throws KeyRingError on ANY failure. There is no success path that does not involve a real
   *         Key Ring decrypt.
   */
  async withSecret<T>(use: (secret: string) => Promise<T>): Promise<T> {
    // WALLET_PASS is read from the ambient environment. It is never generated or defaulted here.
    if (!process.env.WALLET_PASS || process.env.WALLET_PASS.length === 0) {
      throw new KeyRingError("MISSING_PASSWORD", MESSAGES.MISSING_PASSWORD);
    }

    const dir = await mkdtemp(join(tmpdir(), "ctxlock-kr-"));
    const outPath = join(dir, "plain.bin");
    let plaintext: Buffer | null = null;

    try {
      try {
        await exec(
          this.cfg.cliPath,
          ["ring", "decrypt", "--key", this.cfg.keyName, "--input", this.cfg.ciphertextPath, "--out", outPath],
          { timeout: this.cfg.timeoutMs ?? 60_000, env: process.env },
        );
      } catch (e) {
        const raw =
          String((e as { stdout?: string }).stdout ?? "") +
          String((e as { stderr?: string }).stderr ?? "") +
          String((e as Error).message ?? "");
        const code = classifyFailure(raw);
        // Only the typed message escapes. Raw CLI output is discarded so it cannot carry
        // plaintext or the password into a log or an HTTP response.
        throw new KeyRingError(code, MESSAGES[code]);
      }

      plaintext = await readFile(outPath);
      const secret = plaintext.toString("utf8").trim();
      if (secret.length === 0) {
        throw new KeyRingError("CIPHERTEXT_INVALID", MESSAGES.CIPHERTEXT_INVALID);
      }
      return await use(secret);
    } finally {
      // Zeroize and remove. Best-effort: the goal is to shrink the window, not to defeat a
      // memory-forensics adversary, and this file never leaves the temp directory.
      if (plaintext) plaintext.fill(0);
      await unlink(outPath).catch(() => {});
    }
  }
}
