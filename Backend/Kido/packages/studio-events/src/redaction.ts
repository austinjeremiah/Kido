import { z } from "zod";

/**
 * The recursive secret scanner for everything that leaves the control plane.
 *
 * §25.4 lists what a RuntimeEvent must never contain, and the list has two halves that get
 * different attention.
 *
 * The obvious half — API keys, private keys, CRE sessions — is what everyone checks. The other half
 * is what actually gets leaked by monitoring code:
 *
 *   A PRIVATE POLICY THRESHOLD. Not a credential. Leaking it tells an attacker exactly how much
 *   they can move without triggering an escalation, which is worth more than most API keys.
 *
 *   A RAW CONFIDENTIAL RESPONSE. The whole point of a confidential computation is that its inputs
 *   and intermediates are not public. Attaching one to a timeline row "for explainability" undoes
 *   it, and it will look helpful in review.
 *
 *   CHAIN-OF-THOUGHT. §25.5 says it plainly: reasoning text is not tracing data. It is the field
 *   most likely to contain a repeated secret, because the model saw everything.
 *
 * `scanForSecrets` walks keys AND values, at every depth, through arrays, and is applied to
 * RuntimeEvents, structured logs, OTel attributes, alert payloads and frontend API responses — the
 * five surfaces named in §25.4, none of which is only-top-level.
 */

export interface RedactionHit {
  path: string;
  kind: string;
  /** Never the value. A finding that quotes the secret has copied it somewhere new. */
  excerpt: string;
}

/**
 * Field names that must not appear anywhere, at any depth.
 *
 * Presence of the NAME is the finding, whatever the value looks like — an empty `apiKey` in a
 * public payload is a field that will one day be populated.
 */
export const FORBIDDEN_FIELD_NAMES: ReadonlySet<string> = new Set([
  // credentials
  "apiKey", "api_key", "API_KEY", "OPENAI_API_KEY", "CRE_API_KEY", "E2B_API_KEY", "THEGRAPH_API_KEY",
  "accessToken", "access_token", "refreshToken", "refresh_token", "sessionToken", "session_token",
  "bearer", "authorization", "Authorization", "credentials", "credential", "password", "passphrase",
  "clientSecret", "client_secret", "AWS_SECRET_ACCESS_KEY", "secret", "secrets",
  // keys
  "privateKey", "private_key", "PRIVATE_KEY", "signingKey", "signing_key", "issuerKey",
  "capabilityIssuerKey", "adminKey", "mnemonic", "seed", "seedPhrase", "keystore",
  "ledgerPin", "ledgerSeed", "runtimeToken", "gatewaySecret",
  // the non-obvious half
  "privateThreshold", "confidentialThreshold", "secretThreshold", "hiddenLimit",
  "rawConfidentialResponse", "confidentialPayload", "privatePolicyValue",
  "chainOfThought", "reasoningTrace", "modelReasoning", "rawPrompt", "systemPrompt",
]);

/**
 * Value patterns, each named.
 *
 * The 32-byte-hex rule is the subtle one. A private key and a keccak hash are both 64 hex
 * characters, and a monitoring payload legitimately contains hashes everywhere. So the key name
 * decides, exactly as it does in the deployment secret scanner: the same bytes under `codeHash` are
 * evidence and under `signerKey` are a breach.
 */
const VALUE_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: "openai-api-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: "pem-private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "e2b-api-key", re: /\be2b_[A-Za-z0-9]{20,}/ },
  { kind: "bip39-mnemonic", re: /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/ },
  { kind: "cre-session-path", re: /\.cre\/cre\.ya?ml/ },
  { kind: "aws-credentials-path", re: /\.aws\/credentials/ },
];

/** Key names under which a 32-byte hex value is legitimate. Everything else is suspect. */
const HASH_LIKE_KEY = /(hash|digest|node|labelhash|txhash|tx|receipt|root|selector|commit|sha|bytecode|code|salt|ids?$)/i;

export function scanForSecrets(value: unknown, rootPath = "$"): RedactionHit[] {
  const hits: RedactionHit[] = [];
  const seen = new WeakSet<object>();

  const walk = (v: unknown, path: string, keyName: string): void => {
    if (typeof v === "string") {
      for (const p of VALUE_PATTERNS) {
        if (p.re.test(v)) hits.push({ path, kind: p.kind, excerpt: `${v.slice(0, 3)}…(${v.length} chars)` });
      }
      if (/^0x[0-9a-fA-F]{64}$/.test(v) && !HASH_LIKE_KEY.test(keyName)) {
        hits.push({ path, kind: "possible-32-byte-key", excerpt: `0x…(${v.length} chars) under key "${keyName}"` });
      }
      return;
    }
    if (v === null || typeof v !== "object") return;
    // A cycle would otherwise hang the scanner, and a payload that hangs the scanner is a payload
    // that ships unscanned the moment someone adds a timeout.
    if (seen.has(v as object)) return;
    seen.add(v as object);
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`, keyName));
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_FIELD_NAMES.has(k)) {
        hits.push({ path: `${path}.${k}`, kind: "forbidden-field-name", excerpt: `field "${k}" must not appear in a public surface` });
      }
      walk(x, `${path}.${k}`, k);
    }
  };

  walk(value, rootPath, rootPath);
  return hits;
}

export class RedactionError extends Error {
  constructor(readonly surface: string, readonly hits: RedactionHit[]) {
    super(
      `EVENT-SECRET-PRESENT: ${hits.length} secret-shaped value(s) in ${surface}:\n  ` +
        hits.map((h) => `${h.path} [${h.kind}] ${h.excerpt}`).join("\n  "),
    );
    this.name = "RedactionError";
  }
}

/**
 * The five surfaces §25.4 names. Enumerated as a type so a new one has to be added deliberately.
 */
export const REDACTED_SURFACES = [
  "runtime-event",
  "structured-log",
  "otel-attributes",
  "alert-payload",
  "api-response",
] as const;
export type RedactedSurface = (typeof REDACTED_SURFACES)[number];

/** Called on every value crossing outward. Throws rather than redacting silently. */
export function assertPublicSafe(value: unknown, surface: RedactedSurface): void {
  const hits = scanForSecrets(value, surface);
  if (hits.length > 0) throw new RedactionError(surface, hits);
}

/**
 * Redact rather than refuse.
 *
 * For surfaces where dropping the whole payload would lose more than it protects — a sanitized
 * provider log line, say. The replacement names the reason, so a reader sees that something was
 * removed rather than seeing a field that was never there.
 */
export function redact<T>(value: T, surface: RedactedSurface = "runtime-event"): T {
  const hits = scanForSecrets(value, surface);
  if (hits.length === 0) return value;
  const paths = new Set(hits.map((h) => h.path));

  const walk = (v: unknown, path: string, keyName: string): unknown => {
    if (paths.has(path)) return `[redacted: ${hits.find((h) => h.path === path)!.kind}]`;
    if (v === null || typeof v !== "object") {
      if (typeof v === "string") {
        let out = v;
        for (const p of VALUE_PATTERNS) out = out.replace(new RegExp(p.re, "g"), `[redacted: ${p.kind}]`);
        if (/^0x[0-9a-fA-F]{64}$/.test(out) && !HASH_LIKE_KEY.test(keyName)) return "[redacted: possible-32-byte-key]";
        return out;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, keyName));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_FIELD_NAMES.has(k)) { out[k] = "[redacted: forbidden-field-name]"; continue; }
      out[k] = walk(x, `${path}.${k}`, k);
    }
    return out;
  };
  return walk(value, surface, surface) as T;
}

/**
 * The canary strings.
 *
 * Planted in fixtures so a scanner that silently stopped working is detectable. Group D's lesson,
 * applied to a new surface: a check that cannot fail is not evidence.
 */
export const CANARIES = {
  /*
   * The value carries the repository scanner's own fake marker.
   *
   * `scripts/secret-scan.sh` keys on `NOT-A-REAL-KEY`, and the alternative — widening its exclusion
   * list to admit a new marker — is how a tripwire quietly dies. The canary still matches
   * `scanForSecrets`, which is the only thing it needs to do.
   */
  openaiKey: "sk-proj-NOT-A-REAL-KEY-CANARY-000000000",
  privateKey: `0x${"c0ffee".repeat(10)}abcd`,
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJjYW5hcnkiOnRydWV9.CANARYCANARYCANARY",
  cresession: "/Users/someone/.cre/cre.yaml",
} as const;

export const RedactionHitSchema = z.object({ path: z.string(), kind: z.string(), excerpt: z.string() });
