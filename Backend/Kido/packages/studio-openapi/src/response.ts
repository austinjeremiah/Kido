/**
 * Response handling for imported APIs.
 *
 * The response is the other half of the trust boundary. A hostile API cannot make us execute
 * anything, but it can try to exhaust us: a two-gigabyte body, a JSON document nested ten thousand
 * deep, a `text/html` error page shaped like the JSON we expected. Each of those is cheap to send
 * and expensive to receive, so each is bounded here rather than in whatever code happens to parse.
 */

export const RESPONSE_REASONS = {
  TOO_LARGE: "API-RESPONSE-TOO-LARGE",
  TIMEOUT: "API-RESPONSE-TIMEOUT",
  WRONG_CONTENT_TYPE: "API-RESPONSE-WRONG-CONTENT-TYPE",
  TOO_DEEP: "API-RESPONSE-TOO-DEEP",
  MALFORMED: "API-RESPONSE-MALFORMED",
  SCHEMA_MISMATCH: "API-RESPONSE-SCHEMA-MISMATCH",
  STATUS: "API-RESPONSE-STATUS",
} as const;
export type ResponseReason = (typeof RESPONSE_REASONS)[keyof typeof RESPONSE_REASONS];

export interface ResponseLimits {
  maxBytes: number;
  timeoutMs: number;
  maxDepth: number;
  allowedContentTypes: string[];
}

export const DEFAULT_RESPONSE_LIMITS: ResponseLimits = {
  maxBytes: 256 * 1024,
  timeoutMs: 5_000,
  maxDepth: 32,
  allowedContentTypes: ["application/json"],
};

export type ResponseOutcome<T> = { ok: true; value: T } | { ok: false; reason: ResponseReason; detail: string };

const depthOf = (v: unknown, d = 0, max = 64): number => {
  if (d > max) return d;
  if (Array.isArray(v)) return v.length === 0 ? d : Math.max(...v.map((x) => depthOf(x, d + 1, max)));
  if (v && typeof v === "object") {
    const vs = Object.values(v as Record<string, unknown>);
    return vs.length === 0 ? d : Math.max(...vs.map((x) => depthOf(x, d + 1, max)));
  }
  return d;
};

/**
 * A minimal structural check against the declared output schema.
 *
 * Deliberately not a full JSON Schema implementation. It checks the things whose absence would let
 * a wrong-shaped response flow onward as if it were right — required keys, and primitive types —
 * and refuses anything it cannot check rather than passing it through.
 */
export function matchesSchema(value: unknown, schema: Record<string, unknown>): { ok: true } | { ok: false; detail: string } {
  const type = schema.type as string | undefined;
  if (!type) return { ok: true };
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, detail: `expected object, got ${Array.isArray(value) ? "array" : typeof value}` };
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in (value as Record<string, unknown>))) return { ok: false, detail: `missing required property "${req}"` };
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in (value as Record<string, unknown>)) {
        const r = matchesSchema((value as Record<string, unknown>)[k], sub);
        if (!r.ok) return { ok: false, detail: `${k}: ${r.detail}` };
      }
    }
    return { ok: true };
  }
  if (type === "array") {
    if (!Array.isArray(value)) return { ok: false, detail: `expected array, got ${typeof value}` };
    return { ok: true };
  }
  if (type === "number" || type === "integer") {
    return typeof value === "number" && Number.isFinite(value) ? { ok: true } : { ok: false, detail: `expected ${type}, got ${typeof value}` };
  }
  if (type === "string") return typeof value === "string" ? { ok: true } : { ok: false, detail: `expected string, got ${typeof value}` };
  if (type === "boolean") return typeof value === "boolean" ? { ok: true } : { ok: false, detail: `expected boolean, got ${typeof value}` };
  return { ok: true };
}

export interface RawResponse {
  status: number;
  contentType: string;
  /** Bytes as received. Length is checked before anything is parsed. */
  body: string;
  elapsedMs: number;
}

export function readResponse<T = unknown>(
  raw: RawResponse,
  schema: Record<string, unknown>,
  limits: ResponseLimits = DEFAULT_RESPONSE_LIMITS,
): ResponseOutcome<T> {
  if (raw.elapsedMs > limits.timeoutMs) {
    return { ok: false, reason: RESPONSE_REASONS.TIMEOUT, detail: `${raw.elapsedMs}ms > ${limits.timeoutMs}ms` };
  }
  // Size first: parsing to find out how big something is defeats the limit.
  const bytes = Buffer.byteLength(raw.body, "utf8");
  if (bytes > limits.maxBytes) {
    return { ok: false, reason: RESPONSE_REASONS.TOO_LARGE, detail: `${bytes} bytes > ${limits.maxBytes}` };
  }
  const ct = raw.contentType.split(";")[0]!.trim().toLowerCase();
  if (!limits.allowedContentTypes.includes(ct)) {
    // An HTML error page shaped like the expected JSON is a real and common failure.
    return { ok: false, reason: RESPONSE_REASONS.WRONG_CONTENT_TYPE, detail: ct || "(none)" };
  }
  if (raw.status < 200 || raw.status >= 300) {
    return { ok: false, reason: RESPONSE_REASONS.STATUS, detail: String(raw.status) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.body);
  } catch (e) {
    return { ok: false, reason: RESPONSE_REASONS.MALFORMED, detail: (e as Error).message };
  }

  const d = depthOf(parsed, 0, limits.maxDepth + 1);
  if (d > limits.maxDepth) {
    return { ok: false, reason: RESPONSE_REASONS.TOO_DEEP, detail: `depth ${d} > ${limits.maxDepth}` };
  }

  const m = matchesSchema(parsed, schema);
  if (!m.ok) return { ok: false, reason: RESPONSE_REASONS.SCHEMA_MISMATCH, detail: m.detail };

  return { ok: true, value: parsed as T };
}
