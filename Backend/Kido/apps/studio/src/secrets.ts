/**
 * The backend's protected secrets.
 *
 * A generated agent never receives a credential. It names a query template or an action; the
 * backend holds the credential, performs the call, and returns an observation. Secrets come from the
 * host environment only (a dedicated secret store or enclave provider is selected per blueprint by
 * the privacy compiler, never assumed here).
 *
 * Neither source is exposed as `getSecret()`: callers get `withValue(use)`, which hands the value to
 * a callback and returns only what the callback returns. Values are never logged, never placed in an
 * event, and never leave this process.
 */

export type SecretSource = "env" | "absent";

export interface SecretSourceView {
  name: string;
  source: SecretSource;
}

export interface ProtectedSecret {
  readonly name: string;
  readonly source: SecretSource;
  /** Hand the value to `use`; the value itself is never returned. */
  withValue<T>(use: (value: string) => Promise<T>): Promise<T>;
  view(): Promise<SecretSourceView>;
}

export class SecretUnavailableError extends Error {
  constructor(readonly secretName: string) {
    super(`secret ${secretName} is not configured`);
    this.name = "SecretUnavailableError";
  }
}

export function protectedSecret(name: string, env: NodeJS.ProcessEnv = process.env): ProtectedSecret {
  const source: SecretSource = env[name] ? "env" : "absent";
  return {
    name,
    source,
    async withValue<T>(use: (value: string) => Promise<T>): Promise<T> {
      const value = env[name];
      if (!value) throw new SecretUnavailableError(name);
      return use(value);
    },
    async view() {
      return { name, source };
    },
  };
}

export const STUDIO_SECRET_NAMES = ["THEGRAPH_API_KEY"] as const;

const cache = new Map<string, ProtectedSecret>();

export function studioSecret(name: (typeof STUDIO_SECRET_NAMES)[number]): ProtectedSecret {
  let s = cache.get(name);
  if (!s) {
    s = protectedSecret(name);
    cache.set(name, s);
  }
  return s;
}

export function resetStudioSecrets(): void {
  cache.clear();
}

export async function studioSecretSources(): Promise<SecretSourceView[]> {
  return Promise.all(STUDIO_SECRET_NAMES.map((n) => studioSecret(n).view()));
}

export function describeSource(v: SecretSourceView): string {
  return v.source === "env" ? `${v.name}: host environment` : `${v.name}: not configured`;
}
