/**
 * The deployment-artifact secret scanner.
 *
 * DEP-PRE-030 and DEP-018 both come down to one property: nothing ContextLock writes down about a
 * deployment — manifest, plan, receipt, export, report — may contain a credential.
 *
 * This is deliberately a scanner over the OUTPUT rather than a discipline applied at every write
 * site. Discipline works until someone adds a field. A scanner run over the serialized artifact
 * catches the field nobody thought about, which is the only kind that ever leaks.
 */

export interface SecretHit {
  path: string;
  kind: string;
  /** Never the value. A finding that quotes the secret has copied it into the report. */
  excerpt: string;
}

/**
 * Patterns, each named.
 *
 * A private key is 64 hex characters, and so is a keccak hash — which is why the private-key
 * pattern requires the `0x` and the KEY-ish context, and why transaction hashes and code hashes are
 * matched separately and allowed. Getting this wrong in the other direction would make the scanner
 * fire on every manifest and be switched off within a week.
 */
const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "openai-api-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: "pem-private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "e2b-api-key", re: /\be2b_[A-Za-z0-9]{20,}/ },
  { kind: "bip39-mnemonic", re: /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/ },
  { kind: "cre-session-path", re: /\.cre\/cre\.yaml/ },
];

/** Field names whose presence is itself the finding, whatever the value looks like. */
const FORBIDDEN_KEYS = new Set([
  "privateKey", "private_key", "PRIVATE_KEY", "mnemonic", "seed", "seedPhrase",
  "apiKey", "api_key", "API_KEY", "OPENAI_API_KEY", "CRE_API_KEY", "E2B_API_KEY",
  "accessToken", "access_token", "refreshToken", "refresh_token", "sessionToken",
  "password", "passphrase", "secret", "clientSecret", "AWS_SECRET_ACCESS_KEY",
  "DEPLOYER_PRIVATE_KEY", "CAPABILITY_ISSUER_PRIVATE_KEY", "FUNDER_PRIVATE_KEY",
  "CRE_ETH_PRIVATE_KEY", "AGENT_PRIVATE_KEY", "RELAYER_PRIVATE_KEY", "ledgerPin",
]);

/**
 * A bare 32-byte hex value that is NOT one of the things a manifest legitimately contains.
 *
 * The legitimate ones are hashes and transaction identifiers, and they are all reached through keys
 * whose names say so. A 32-byte hex under `deployerKey` is a private key; the same value under
 * `codeHash` is a code hash. The key name is the only thing that distinguishes them, so the key
 * name is what this checks.
 */
const HASHY_KEY = /(hash|digest|node|labelhash|txhash|tx|receipt|root|selector|commit|id|sha|bytecode|code|salt)/i;

export function scanForSecrets(value: unknown, rootPath = "$"): SecretHit[] {
  const hits: SecretHit[] = [];
  const walk = (v: unknown, path: string, keyName: string): void => {
    if (typeof v === "string") {
      for (const p of PATTERNS) {
        if (p.re.test(v)) hits.push({ path, kind: p.kind, excerpt: `${v.slice(0, 4)}…(${v.length} chars)` });
      }
      if (/^0x[0-9a-fA-F]{64}$/.test(v) && !HASHY_KEY.test(keyName)) {
        hits.push({ path, kind: "possible-32-byte-key", excerpt: `0x…(${v.length} chars) under key "${keyName}"` });
      }
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`, keyName));
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k)) hits.push({ path: `${path}.${k}`, kind: "forbidden-field-name", excerpt: `field "${k}" must not appear in a deployment artifact` });
      walk(x, `${path}.${k}`, k);
    }
  };
  walk(value, rootPath, rootPath);
  return hits;
}

export class DeploymentSecretError extends Error {
  constructor(readonly hits: SecretHit[]) {
    super(
      `DEPLOY-SECRET-PRESENT: ${hits.length} secret-shaped value(s) in a deployment artifact:\n  ` +
        hits.map((h) => `${h.path} [${h.kind}] ${h.excerpt}`).join("\n  "),
    );
    this.name = "DeploymentSecretError";
  }
}

/** Called on every artifact before it is persisted, exported or shown. */
export function assertNoSecrets(value: unknown, what: string): void {
  const hits = scanForSecrets(value, what);
  if (hits.length > 0) throw new DeploymentSecretError(hits);
}
