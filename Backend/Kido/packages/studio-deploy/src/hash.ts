import { createHash } from "node:crypto";

/**
 * Canonical hashing for deployment artifacts.
 *
 * The same discipline as the execution plan's hashing, and for the same reason: an approval is an
 * approval of one specific thing, and any change to what would actually happen must produce a
 * different hash so the approval stops matching.
 *
 * sha256 rather than keccak here because these hashes are compared against artifacts produced by
 * tools outside the EVM — `cre workflow hash`, image digests, SBOM files — and those all speak
 * sha256. Mixing hash functions inside one manifest is how a comparison quietly becomes a
 * comparison of two different things.
 */

/** Deterministic serialization: keys sorted at every level, no whitespace, bigints rejected. */
export function canonicalize(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "bigint") {
      // Gas, fees and balances are all bigints in this codebase and all of them are serialized as
      // decimal strings before they reach a hash. A bigint arriving here means someone hashed a raw
      // wei value, which would serialize differently across runtimes.
      throw new Error("DEPLOY-HASH-BIGINT: encode large integers as decimal strings before hashing");
    }
    if (v === undefined) return null;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = walk(o[k]);
      return out;
    }
    throw new Error(`DEPLOY-HASH-UNSERIALIZABLE: ${typeof v}`);
  };
  return JSON.stringify(walk(value));
}

export const sha256Hex = (data: string | Buffer | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/** `sha256:<64 hex>` — the same shape the bridge, the image digest and CRE all use. */
export const digestOf = (value: unknown): string => `sha256:${sha256Hex(canonicalize(value))}`;

export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function assertDigest(s: string, what: string): asserts s is string {
  if (!DIGEST_RE.test(s)) throw new Error(`DEPLOY-HASH-MALFORMED: ${what} is not a sha256 digest: ${s}`);
}
