import type { DataTrustClass } from "@contextlock/studio-adapters";

/**
 * Declarative response mapping.
 *
 * The need is ordinary — `response.price.usd` has to become a typed PRICE — and the obvious
 * solution is a snippet of JavaScript. That solution is unavailable here, and deliberately so: an
 * imported adapter running model-generated or document-supplied code is arbitrary execution inside
 * the process that decides whether money moves.
 *
 * So a transform is a path and a declared unit, interpreted by this file and nothing else. There is
 * no expression, no function, no template. Everything a mapping can do is enumerated below, and
 * adding a capability means adding a case here where it can be reviewed.
 */

export const TRANSFORM_REASONS = {
  BAD_PATH: "API-TRANSFORM-BAD-PATH",
  MISSING: "API-TRANSFORM-MISSING-VALUE",
  WRONG_TYPE: "API-TRANSFORM-WRONG-TYPE",
  OUT_OF_RANGE: "API-TRANSFORM-OUT-OF-RANGE",
  NOT_FINITE: "API-TRANSFORM-NOT-FINITE",
  TRUST_PROMOTION: "API-TRUST-PROMOTION-REFUSED",
} as const;
export type TransformReason = (typeof TRANSFORM_REASONS)[keyof typeof TRANSFORM_REASONS];

export type TransformOp = "NUMBER" | "INTEGER" | "STRING" | "BOOLEAN" | "UNIX_SECONDS" | "SCALE_TO_INTEGER";

export interface FieldMapping {
  /** Dot path into the response. Only property access — no indexing expressions, no wildcards. */
  path: string;
  op: TransformOp;
  /** For SCALE_TO_INTEGER: 1.23 at 4 decimals becomes 12300. */
  decimals?: number;
  min?: number;
  max?: number;
}

export type TransformOutcome = { ok: true; value: string | number | boolean } | { ok: false; reason: TransformReason; detail: string };

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export function applyMapping(response: unknown, m: FieldMapping): TransformOutcome {
  if (!PATH_RE.test(m.path)) {
    // Anything that is not a plain property path is refused rather than interpreted. This is where
    // an expression language would creep in one convenience at a time.
    return { ok: false, reason: TRANSFORM_REASONS.BAD_PATH, detail: m.path };
  }
  let cur: unknown = response;
  for (const seg of m.path.split(".")) {
    // hasOwnProperty, never `in`: `in` walks the prototype chain, so a mapping of "constructor"
    // or "toString" would resolve against Object.prototype and read something the API never sent.
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, seg)) {
      return { ok: false, reason: TRANSFORM_REASONS.MISSING, detail: m.path };
    }
    cur = (cur as Record<string, unknown>)[seg];
  }

  switch (m.op) {
    case "STRING":
      if (typeof cur !== "string") return { ok: false, reason: TRANSFORM_REASONS.WRONG_TYPE, detail: `${m.path} is ${typeof cur}` };
      return { ok: true, value: cur };
    case "BOOLEAN":
      if (typeof cur !== "boolean") return { ok: false, reason: TRANSFORM_REASONS.WRONG_TYPE, detail: `${m.path} is ${typeof cur}` };
      return { ok: true, value: cur };
    case "NUMBER":
    case "INTEGER":
    case "UNIX_SECONDS":
    case "SCALE_TO_INTEGER": {
      if (typeof cur !== "number") return { ok: false, reason: TRANSFORM_REASONS.WRONG_TYPE, detail: `${m.path} is ${typeof cur}` };
      if (!Number.isFinite(cur)) return { ok: false, reason: TRANSFORM_REASONS.NOT_FINITE, detail: String(cur) };
      if (m.op === "INTEGER" && !Number.isInteger(cur)) return { ok: false, reason: TRANSFORM_REASONS.WRONG_TYPE, detail: `${m.path} is not an integer` };
      if (m.min !== undefined && cur < m.min) return { ok: false, reason: TRANSFORM_REASONS.OUT_OF_RANGE, detail: `${cur} < ${m.min}` };
      if (m.max !== undefined && cur > m.max) return { ok: false, reason: TRANSFORM_REASONS.OUT_OF_RANGE, detail: `${cur} > ${m.max}` };
      if (m.op === "SCALE_TO_INTEGER") {
        const d = m.decimals ?? 0;
        // Rounded through a string so 1.005 at 2dp does not become 100 through binary float error.
        const scaled = Math.round(Number((cur * 10 ** d).toFixed(6)));
        return { ok: true, value: String(scaled) };
      }
      return { ok: true, value: cur };
    }
  }
}

/**
 * Trust for an imported API.
 *
 * An imported API is `EXTERNAL_API` and there is no argument from the document that changes that.
 * A document can assert anything about itself; a security property has to be earned by a mechanism
 * — an oracle's aggregation, an enclave's attestation — and no field in a YAML file is one.
 */
export const IMPORTED_API_TRUST: DataTrustClass = "EXTERNAL_API";

export type TrustAssertion = { requested: DataTrustClass; source: "document" | "model" | "user" };

export function resolveImportedTrust(
  assertion: TrustAssertion | null,
): { trustClass: DataTrustClass; refused: null | { reason: string; detail: string } } {
  if (!assertion || assertion.requested === IMPORTED_API_TRUST || assertion.requested === "USER_UNTRUSTED") {
    return { trustClass: assertion?.requested ?? IMPORTED_API_TRUST, refused: null };
  }
  return {
    trustClass: IMPORTED_API_TRUST,
    refused: {
      reason: TRANSFORM_REASONS.TRUST_PROMOTION,
      detail: `${assertion.source} asked for ${assertion.requested}; an imported REST API is ${IMPORTED_API_TRUST} and cannot be promoted by asserting it. Route it through a verified mechanism instead.`,
    },
  };
}
