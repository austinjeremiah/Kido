import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as edSign, verify as edVerify } from "node:crypto";
import { z } from "zod";

/**
 * The scoped runtime credential.
 *
 * What the runtime gets instead of secrets. It authenticates the container to four gateways and it
 * can do nothing else — most importantly:
 *
 *     THIS TOKEN CANNOT AUTHORIZE BLOCKCHAIN MONEY MOVEMENT.
 *
 * Not "is not supposed to". There is no field in it a broker could interpret as authority, no
 * signature over a transaction, and no capability. Financial authorization is a separate onchain
 * mechanism with a separate issuer, and a compromised runtime holding a valid runtime token has
 * obtained the ability to talk to four services under policy — not the ability to move value.
 *
 * The binding is what makes it scoped. It names the deployment, the agent, the Blueprint hash and
 * the IMAGE DIGEST, so a token minted for one agent presented by another does not verify, and a
 * token minted for one image presented from a different image does not verify either. That second
 * one matters: it means stealing a token from a running container does not let an attacker use it
 * from a container they built.
 *
 * Ed25519 rather than an HMAC, so gateways verify with a public key and only the control plane can
 * mint. A shared HMAC secret would have to live in every gateway, and any gateway compromise would
 * become the ability to mint runtime identities.
 */

export const RUNTIME_TOKEN_VERSION = "contextlock.runtime-token/v1" as const;

export const RuntimeTokenClaimsSchema = z.object({
  v: z.literal(RUNTIME_TOKEN_VERSION),
  deploymentId: z.string().min(1),
  agentId: z.string().min(1),
  organizationId: z.string().nullable(),
  blueprintHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** The exact image this token is valid from. */
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** Which gateways will accept it. A token good everywhere is a token good for the wrong thing. */
  audiences: z.array(z.enum(["MODEL", "ADAPTER", "CONTEXTLOCK", "TELEMETRY"])).min(1),
  issuedAtMs: z.number().int().positive(),
  expiresAtMs: z.number().int().positive(),
  /** Session identity, so a specific token can be revoked without revoking the agent. */
  sessionId: z.string().min(8),
  nonce: z.string().min(16),
  /** Which control-plane key signed it, so keys can rotate without invalidating verification. */
  kid: z.string().min(1),
});
export type RuntimeTokenClaims = z.infer<typeof RuntimeTokenClaimsSchema>;

/**
 * Claims that are NOT in this token, named so their absence is testable.
 *
 * Every one of them is something a token could plausibly be extended to carry, and every one would
 * turn an authentication credential into an authorization one.
 */
export const FORBIDDEN_TOKEN_CLAIMS = [
  "capability",
  "capabilityScope",
  "signature",
  "signingKey",
  "privateKey",
  "walletAddress",
  "issuerKey",
  "spendLimit",
  "maxValueUsdCents",
  "policyOverride",
  "adminRole",
  "canSign",
] as const;

export const TOKEN_REASONS = {
  MALFORMED: "TOKEN-MALFORMED",
  BAD_SIGNATURE: "TOKEN-BAD-SIGNATURE",
  EXPIRED: "TOKEN-EXPIRED",
  NOT_YET_VALID: "TOKEN-NOT-YET-VALID",
  WRONG_AGENT: "TOKEN-WRONG-AGENT",
  WRONG_DEPLOYMENT: "TOKEN-WRONG-DEPLOYMENT",
  WRONG_IMAGE: "TOKEN-WRONG-IMAGE-DIGEST",
  WRONG_AUDIENCE: "TOKEN-WRONG-AUDIENCE",
  REVOKED: "TOKEN-REVOKED",
  REPLAYED: "TOKEN-REPLAYED",
  UNKNOWN_KEY: "TOKEN-UNKNOWN-SIGNING-KEY",
  FORBIDDEN_CLAIM: "TOKEN-FORBIDDEN-CLAIM",
} as const;
export type TokenReason = (typeof TOKEN_REASONS)[keyof typeof TOKEN_REASONS];

export class RuntimeTokenError extends Error {
  constructor(readonly reason: TokenReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "RuntimeTokenError";
  }
}

const b64u = (b: Buffer): string => b.toString("base64url");
const unb64u = (s: string): Buffer => Buffer.from(s, "base64url");

/** Deterministic serialization, so the signed bytes are the bytes that get verified. */
const canonical = (v: unknown): string => {
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x !== "object") return x === undefined ? null : x;
    if (Array.isArray(x)) return x.map(walk);
    const o = x as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, walk(o[k])]));
  };
  return JSON.stringify(walk(v));
};

export interface SigningKey {
  kid: string;
  privateKeyPem: string;
  publicKeyPem: string;
  createdAtMs: number;
}

export function generateSigningKey(kid = `k_${randomUUID().slice(0, 8)}`, nowMs = Date.now()): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    kid,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    createdAtMs: nowMs,
  };
}

/**
 * The control plane's minting side.
 *
 * Holds private keys. Lives nowhere near the runtime; the runtime receives only the finished token.
 */
export class RuntimeTokenIssuer {
  private readonly keys = new Map<string, SigningKey>();
  private active: string | null = null;

  addKey(key: SigningKey, makeActive = true): void {
    this.keys.set(key.kid, key);
    if (makeActive || this.active === null) this.active = key.kid;
  }

  publicKeys(): Map<string, string> {
    return new Map([...this.keys].map(([kid, k]) => [kid, k.publicKeyPem]));
  }

  issue(args: Omit<RuntimeTokenClaims, "v" | "kid" | "sessionId" | "nonce" | "issuedAtMs" | "expiresAtMs"> & { nowMs: number; ttlMs: number }): string {
    if (!this.active) throw new RuntimeTokenError(TOKEN_REASONS.UNKNOWN_KEY, "the issuer has no active signing key");
    const key = this.keys.get(this.active)!;
    const claims: RuntimeTokenClaims = {
      v: RUNTIME_TOKEN_VERSION,
      deploymentId: args.deploymentId,
      agentId: args.agentId,
      organizationId: args.organizationId,
      blueprintHash: args.blueprintHash,
      imageDigest: args.imageDigest,
      audiences: args.audiences,
      issuedAtMs: args.nowMs,
      expiresAtMs: args.nowMs + args.ttlMs,
      sessionId: randomUUID(),
      nonce: randomUUID().replace(/-/g, ""),
      kid: key.kid,
    };
    // Belt and braces, but the cheap kind: a caller that managed to smuggle an extra field into the
    // claims object is caught before it is signed rather than after it is trusted.
    for (const forbidden of FORBIDDEN_TOKEN_CLAIMS) {
      if (forbidden in (args as Record<string, unknown>)) {
        throw new RuntimeTokenError(TOKEN_REASONS.FORBIDDEN_CLAIM, `"${forbidden}" is not a runtime-token claim; this token authenticates, it does not authorize`);
      }
    }
    const payload = Buffer.from(canonical(claims), "utf8");
    const signature = edSign(null, payload, createPrivateKey(key.privateKeyPem));
    return `${b64u(payload)}.${b64u(signature)}`;
  }
}

export interface VerificationContext {
  expectedAgentId: string;
  expectedDeploymentId: string;
  expectedImageDigest: string;
  audience: "MODEL" | "ADAPTER" | "CONTEXTLOCK" | "TELEMETRY";
  nowMs: number;
}

/**
 * The gateway's verifying side.
 *
 * Holds public keys and a revocation list, and nothing that could mint. A compromised gateway
 * therefore cannot issue runtime identities — it can only fail to reject them, which is bounded by
 * what that one gateway does.
 */
export class RuntimeTokenVerifier {
  private readonly revokedSessions = new Set<string>();
  private readonly seenNonces = new Map<string, number>();

  constructor(private readonly publicKeys: Map<string, string>) {}

  revokeSession(sessionId: string): void {
    this.revokedSessions.add(sessionId);
  }

  verify(token: string, ctx: VerificationContext): RuntimeTokenClaims {
    const parts = token.split(".");
    if (parts.length !== 2) throw new RuntimeTokenError(TOKEN_REASONS.MALFORMED, "expected <payload>.<signature>");
    const [p, s] = parts as [string, string];

    let claims: RuntimeTokenClaims;
    try {
      claims = RuntimeTokenClaimsSchema.parse(JSON.parse(unb64u(p).toString("utf8")));
    } catch (e) {
      throw new RuntimeTokenError(TOKEN_REASONS.MALFORMED, (e as Error).message);
    }

    const pem = this.publicKeys.get(claims.kid);
    if (!pem) throw new RuntimeTokenError(TOKEN_REASONS.UNKNOWN_KEY, `no public key for kid "${claims.kid}"`);

    // Signature FIRST. Until it verifies, every field above is attacker-controlled — including the
    // ones a friendlier error message would quote back.
    const ok = edVerify(null, Buffer.from(canonical(claims), "utf8"), createPublicKey(pem), unb64u(s));
    if (!ok) throw new RuntimeTokenError(TOKEN_REASONS.BAD_SIGNATURE, "the signature does not verify");

    if (ctx.nowMs >= claims.expiresAtMs) {
      throw new RuntimeTokenError(TOKEN_REASONS.EXPIRED, `expired at ${new Date(claims.expiresAtMs).toISOString()}, ${ctx.nowMs - claims.expiresAtMs}ms ago`);
    }
    if (ctx.nowMs + 30_000 < claims.issuedAtMs) {
      throw new RuntimeTokenError(TOKEN_REASONS.NOT_YET_VALID, "issued in the future");
    }
    if (this.revokedSessions.has(claims.sessionId)) {
      throw new RuntimeTokenError(TOKEN_REASONS.REVOKED, `session ${claims.sessionId} has been revoked`);
    }
    if (claims.agentId !== ctx.expectedAgentId) {
      throw new RuntimeTokenError(TOKEN_REASONS.WRONG_AGENT, `token is for agent "${claims.agentId}", not "${ctx.expectedAgentId}"`);
    }
    if (claims.deploymentId !== ctx.expectedDeploymentId) {
      throw new RuntimeTokenError(TOKEN_REASONS.WRONG_DEPLOYMENT, `token is for deployment "${claims.deploymentId}"`);
    }
    if (claims.imageDigest !== ctx.expectedImageDigest) {
      // Stealing a token out of a running container does not make it usable from another image.
      throw new RuntimeTokenError(
        TOKEN_REASONS.WRONG_IMAGE,
        `token is bound to image ${claims.imageDigest}, but the caller is running ${ctx.expectedImageDigest}`,
      );
    }
    if (!claims.audiences.includes(ctx.audience)) {
      throw new RuntimeTokenError(TOKEN_REASONS.WRONG_AUDIENCE, `token is valid for [${claims.audiences.join(", ")}], not ${ctx.audience}`);
    }
    return claims;
  }

  /**
   * Single-use verification, for the operations that must not be replayable.
   *
   * Not applied to every call: a runtime makes many model requests with one token, and requiring a
   * fresh token per request would mean minting one per request. It is applied where a replay would
   * duplicate an effect.
   */
  verifyOnce(token: string, ctx: VerificationContext, requestNonce: string): RuntimeTokenClaims {
    const claims = this.verify(token, ctx);
    const key = `${claims.sessionId}:${requestNonce}`;
    const seenAt = this.seenNonces.get(key);
    if (seenAt !== undefined) {
      throw new RuntimeTokenError(TOKEN_REASONS.REPLAYED, `request nonce ${requestNonce} was already used at ${new Date(seenAt).toISOString()}`);
    }
    this.seenNonces.set(key, ctx.nowMs);
    return claims;
  }
}

/** Default lifetime. Short, because the mitigation for a stolen token is that it stops working. */
export const DEFAULT_RUNTIME_TOKEN_TTL_MS = 15 * 60_000;
