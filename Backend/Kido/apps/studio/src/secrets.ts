import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LedgerKeyRing, KeyRingError, type KeyRingStatus } from "@contextlock/ledger";

/**
 * The Studio's protected secrets.
 *
 * A generated agent never receives a credential. It names a query template or an action; the
 * Studio backend holds the credential, performs the call, and returns an observation. This module
 * is where the backend gets the credential from, and it offers two sources with one interface:
 *
 *   ledger-key-ring  the value is a `wallet-cli ring encrypt` ciphertext on disk, decrypted through
 *                    the Ledger Key Ring (LKRP) when it is needed. The ring is provisioned once on
 *                    the operator's Ledger (`ring init`, device required); decryption is headless but
 *                    needs the network and `WALLET_PASS` from the operator's own environment. Any
 *                    failure is a failure — there is no fall back to a plaintext copy.
 *   env              a plain environment variable on the Studio host. Honest, lower assurance, and
 *                    every screen that shows the credential says which of the two it is.
 *
 * Neither source is ever exposed as `getSecret()`: callers get `withValue(use)`, which hands the
 * value to a callback and returns only what the callback returns. Values are never logged, never
 * placed in an event, and never leave this process.
 */

export type SecretSource = "ledger-key-ring" | "env" | "absent";

export interface SecretSourceView {
  name: string;
  source: SecretSource;
  /** For the ring source: the key name and the ring's local status, never the value. */
  ring: { keyName: string; ciphertextPath: string; status: KeyRingStatus } | null;
}

export interface ProtectedSecret {
  readonly name: string;
  readonly source: SecretSource;
  /** Hand the value to `use`; the value itself is never returned. */
  withValue<T>(use: (value: string) => Promise<T>): Promise<T>;
  /** What a screen may know: the source and the ring's status. */
  view(): Promise<SecretSourceView>;
}

/** `secrets/` at the repository root; gitignored. `STUDIO_SECRETS_DIR` overrides it. */
export function secretsDir(): string {
  return resolve(process.env.STUDIO_SECRETS_DIR ?? "secrets");
}

/** `THEGRAPH_API_KEY` → `secrets/thegraph-api-key.ring`. */
export function ciphertextPathFor(name: string): string {
  return resolve(secretsDir(), `${name.toLowerCase().replace(/_/g, "-")}.ring`);
}

/** The scoped key name every Studio secret is encrypted under. One ring key per Studio install. */
export function ringKeyName(): string {
  return process.env.STUDIO_RING_KEY?.trim() || "contextlock-studio";
}

/**
 * The wallet-cli binary: `LEDGER_WALLET_CLI` when set, otherwise the one npm installed. The
 * scoped package is resolved by name so the unrelated `wallet-cli@0.1.8` can never be picked up
 * (FND-011).
 */
export function walletCliPath(): string | null {
  const fromEnv = process.env.LEDGER_WALLET_CLI?.trim();
  if (fromEnv) return fromEnv;
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("@ledgerhq/wallet-cli/package.json");
    return resolve(pkg, "..", "bin", "wallet-cli");
  } catch {
    return null;
  }
}

/**
 * How long a decrypted value may be reused in this process before the ring is asked again.
 * Every use is a network call to LKRP otherwise; a short cache keeps a burst of gateway requests
 * from becoming a burst of trustchain restores. The value lives only in this closure.
 */
const RING_VALUE_TTL_MS = Number(process.env.STUDIO_RING_CACHE_MS ?? 5 * 60_000);
const RING_STATUS_TTL_MS = 30_000;

class RingSecret implements ProtectedSecret {
  readonly source = "ledger-key-ring" as const;
  private readonly ring: LedgerKeyRing;
  private cached: { value: string; until: number } | null = null;
  private status: { value: KeyRingStatus; until: number } | null = null;

  constructor(readonly name: string, private readonly cliPath: string, private readonly ciphertextPath: string, private readonly keyName: string) {
    this.ring = new LedgerKeyRing({ cliPath, keyName, ciphertextPath });
  }

  async withValue<T>(use: (value: string) => Promise<T>): Promise<T> {
    const now = Date.now();
    if (this.cached && this.cached.until > now) return use(this.cached.value);
    // `withSecret` never returns the plaintext; we keep it only inside this object, for the TTL.
    return this.ring.withSecret(async (value) => {
      this.cached = { value, until: Date.now() + RING_VALUE_TTL_MS };
      return use(value);
    });
  }

  async ringStatus(): Promise<KeyRingStatus> {
    const now = Date.now();
    if (this.status && this.status.until > now) return this.status.value;
    const value = await this.ring.status();
    this.status = { value, until: now + RING_STATUS_TTL_MS };
    return value;
  }

  async view(): Promise<SecretSourceView> {
    return { name: this.name, source: this.source, ring: { keyName: this.keyName, ciphertextPath: this.ciphertextPath, status: await this.ringStatus() } };
  }
}

class EnvSecret implements ProtectedSecret {
  readonly source = "env" as const;
  constructor(readonly name: string) {}
  async withValue<T>(use: (value: string) => Promise<T>): Promise<T> {
    const v = process.env[this.name]?.trim();
    if (!v) throw new Error(`${this.name} is not set`);
    return use(v);
  }
  async view(): Promise<SecretSourceView> {
    return { name: this.name, source: this.source, ring: null };
  }
}

class AbsentSecret implements ProtectedSecret {
  readonly source = "absent" as const;
  constructor(readonly name: string) {}
  async withValue<T>(): Promise<T> {
    throw new Error(`${this.name} is not configured on this Studio`);
  }
  async view(): Promise<SecretSourceView> {
    return { name: this.name, source: this.source, ring: null };
  }
}

/**
 * Resolve a secret by name.
 *
 * A ring ciphertext on disk wins over an environment variable: once the operator has put a
 * credential under the Key Ring, a stray plaintext copy must not quietly take precedence. With
 * `STUDIO_SECRETS=env` the ring is ignored (a machine without the CLI); with
 * `STUDIO_SECRETS=ledger-key-ring` the environment is ignored, so a missing ciphertext is absent,
 * never silently downgraded.
 */
export function protectedSecret(name: string): ProtectedSecret {
  const mode = (process.env.STUDIO_SECRETS ?? "auto").toLowerCase();
  const ciphertext = ciphertextPathFor(name);
  const cli = walletCliPath();
  const ringPossible = mode !== "env" && cli !== null && existsSync(ciphertext);
  if (ringPossible) return new RingSecret(name, cli!, ciphertext, ringKeyName());
  if (mode === "ledger-key-ring") return new AbsentSecret(name);
  if (process.env[name]?.trim()) return new EnvSecret(name);
  return new AbsentSecret(name);
}

/** The secrets the Studio knows how to use. Values never appear here — names only. */
export const STUDIO_SECRET_NAMES = ["THEGRAPH_API_KEY"] as const;

const registry = new Map<string, ProtectedSecret>();

/** The resolved secret, memoised per process so the ring cache and status probe are shared. */
export function studioSecret(name: (typeof STUDIO_SECRET_NAMES)[number]): ProtectedSecret {
  let s = registry.get(name);
  if (!s) {
    s = protectedSecret(name);
    registry.set(name, s);
  }
  return s;
}

/** Test seam: forget resolved secrets so a changed environment is re-read. */
export function resetStudioSecrets(): void {
  registry.clear();
}

/** Every known secret's source, for the capability probe and the Integrations screen. */
export async function studioSecretSources(): Promise<SecretSourceView[]> {
  return Promise.all(STUDIO_SECRET_NAMES.map((n) => studioSecret(n).view()));
}

/** The one-line description a screen shows beside a credential. Never a value. */
export function describeSource(v: SecretSourceView): string {
  switch (v.source) {
    case "ledger-key-ring":
      return `Ledger Key Ring (LKRP) · key ${v.ring!.keyName} · ring ${v.ring!.status} — decrypted on the Studio backend when used; the agent receives observations, never the key`;
    case "env":
      return "Studio server environment — held by the backend; the agent receives observations, never the key";
    case "absent":
      return "not configured on the Studio server";
  }
}

export { KeyRingError };
