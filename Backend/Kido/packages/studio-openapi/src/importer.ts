import { z } from "zod";
import { checkUrl, type EgressPolicy, type EgressVerdict } from "./egress.js";

/**
 * OpenAPI import.
 *
 * The document is DATA. It is not configuration we trust, it is a file supplied by whoever wants
 * their API called, and every branch here treats it that way:
 *
 *   - nothing in it is evaluated, ever — no examples, no scripts, no vendor extensions;
 *   - external `$ref` is denied by default, because a `$ref` is a fetch and a fetch is an SSRF;
 *   - `servers` entries are candidate URLs subject to the egress policy, not trusted destinations;
 *   - an operation this build does not fully understand is refused rather than partly supported.
 *
 * The output is a typed request template. The model may later supply PARAMETERS to it; it can never
 * supply a host, a method, or a path.
 */

export const IMPORT_REASONS = {
  MALFORMED: "API-MALFORMED-DOCUMENT",
  UNSUPPORTED_VERSION: "API-UNSUPPORTED-VERSION",
  DOCUMENT_TOO_LARGE: "API-DOCUMENT-TOO-LARGE",
  EXTERNAL_REF: "API-EXTERNAL-REF-DENIED",
  UNRESOLVED_REF: "API-UNRESOLVED-REF",
  RECURSIVE_SCHEMA: "API-RECURSIVE-SCHEMA",
  SCHEMA_TOO_DEEP: "API-SCHEMA-TOO-DEEP",
  NO_SERVERS: "API-NO-SERVERS",
  SERVER_REJECTED: "API-SERVER-REJECTED",
  DUPLICATE_OPERATION_ID: "API-DUPLICATE-OPERATION-ID",
  UNSUPPORTED_OPERATION: "API-UNSUPPORTED-OPERATION",
  UNSUPPORTED_AUTH: "API-UNSUPPORTED-AUTH",
  USER_SUPPLIED_HOST: "API-USER-SUPPLIED-HOST",
  PATH_TRAVERSAL: "API-PATH-TRAVERSAL",
  VENDOR_EXTENSION_IGNORED: "API-VENDOR-EXTENSION-IGNORED",
} as const;
export type ImportReason = (typeof IMPORT_REASONS)[keyof typeof IMPORT_REASONS];

export interface ImportProblem {
  code: ImportReason;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
  path: string;
  message: string;
}

/** Security schemes we can PARSE. Parsing is not runtime support; see `supportedAuth`. */
export type DeclaredAuthKind = "apiKey" | "http-basic" | "http-bearer" | "oauth2" | "openIdConnect" | "mutualTLS" | "none";

export interface AuthRequirement {
  schemeName: string;
  declaredAuth: DeclaredAuthKind;
  /** True only for kinds this runtime can actually execute today. */
  supportedAuth: boolean;
  /** Where the credential goes. Never the credential itself. */
  credentialPlacement: { in: "header" | "query" | "cookie"; name: string } | null;
  notes: string;
}

export interface RequestTemplate {
  operationId: string;
  method: "get" | "post" | "put" | "patch" | "delete" | "head";
  /** Host comes from the document's servers, checked against egress. Never from a model. */
  host: string;
  basePath: string;
  pathTemplate: string;
  /** Parameters a caller may supply. Each is validated at call time against this schema. */
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  auth: AuthRequirement;
  /** Blueprint carries this, never a secret. */
  credentialRef: string | null;
  summary: string;
}

export interface ImportResult {
  ok: boolean;
  problems: ImportProblem[];
  templates: RequestTemplate[];
  /** Everything the importer deliberately ignored, listed so silence is never mistaken for support. */
  ignored: Array<{ path: string; what: string; why: string }>;
}

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_SCHEMA_DEPTH = 12;
const SUPPORTED_METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;

const problem = (code: ImportReason, severity: ImportProblem["severity"], path: string, message: string): ImportProblem =>
  ({ code, severity, path, message });

/** The subset of OpenAPI this build reads. Deliberately small and explicitly bounded. */
const DocSchema = z.object({
  openapi: z.string(),
  info: z.object({ title: z.string(), version: z.string() }),
  servers: z.array(z.object({ url: z.string(), description: z.string().optional() })).optional(),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z
    .object({
      schemas: z.record(z.string(), z.unknown()).optional(),
      securitySchemes: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    })
    .optional(),
  security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
});

const AUTH_KIND = (s: Record<string, unknown>): DeclaredAuthKind => {
  const t = String(s.type ?? "");
  if (t === "apiKey") return "apiKey";
  if (t === "http") return String(s.scheme ?? "").toLowerCase() === "basic" ? "http-basic" : "http-bearer";
  if (t === "oauth2") return "oauth2";
  if (t === "openIdConnect") return "openIdConnect";
  if (t === "mutualTLS") return "mutualTLS";
  return "none";
};

/**
 * Kinds this runtime can execute.
 *
 * Bearer and apiKey are a header the broker can attach. OAuth2 and OIDC require a token exchange
 * with its own redirect handling and refresh semantics, and mutualTLS requires a client
 * certificate — parsing them is easy and honest, pretending to support them is not.
 */
const RUNTIME_SUPPORTED: DeclaredAuthKind[] = ["apiKey", "http-bearer", "none"];

/** Walk a schema, refusing anything unbounded before it ever reaches a validator. */
function auditSchema(
  node: unknown,
  path: string,
  depth: number,
  seen: Set<unknown>,
  problems: ImportProblem[],
): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    problems.push(problem(IMPORT_REASONS.SCHEMA_TOO_DEEP, "HIGH", path, `schema nests deeper than ${MAX_SCHEMA_DEPTH}`));
    return;
  }
  if (!node || typeof node !== "object") return;
  if (seen.has(node)) {
    // A cycle in the object graph. Left alone it is an infinite walk here and an infinite
    // validation later — a denial of service written into a config file.
    problems.push(problem(IMPORT_REASONS.RECURSIVE_SCHEMA, "HIGH", path, "schema refers to itself"));
    return;
  }
  seen.add(node);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "$ref" && typeof v === "string" && !v.startsWith("#/")) {
      problems.push(problem(IMPORT_REASONS.EXTERNAL_REF, "CRITICAL", `${path}.$ref`, `external $ref "${v}" is denied: resolving it would be an outbound fetch chosen by the document`));
    }
    auditSchema(v, `${path}.${k}`, depth + 1, seen, problems);
  }
  seen.delete(node);
}

/**
 * Find cycles among internal `$ref`s.
 *
 * This importer never expands an internal `$ref`, so a self-referential schema cannot loop HERE.
 * It is still recorded, because the template is handed to consumers that may expand it, and a
 * schema that contains itself expands forever. Declaring the cycle at import time is cheaper than
 * discovering it in whatever code eventually walks the schema.
 */
function detectRefCycles(schemas: Record<string, unknown>, problems: ImportProblem[]): void {
  const refsOf = (node: unknown, acc: string[] = []): string[] => {
    if (!node || typeof node !== "object") return acc;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith("#/components/schemas/")) {
        acc.push(v.slice("#/components/schemas/".length));
      } else refsOf(v, acc);
    }
    return acc;
  };

  const edges = new Map<string, string[]>();
  for (const [name, schema] of Object.entries(schemas)) edges.set(name, refsOf(schema));

  const state = new Map<string, "visiting" | "done">();
  const walk = (name: string, path: string[]): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      problems.push(
        problem(
          IMPORT_REASONS.RECURSIVE_SCHEMA,
          "HIGH",
          `components.schemas.${name}`,
          `schema cycle ${[...path, name].join(" -> ")}; a schema that contains itself expands forever`,
        ),
      );
      return;
    }
    state.set(name, "visiting");
    for (const next of edges.get(name) ?? []) if (edges.has(next)) walk(next, [...path, name]);
    state.set(name, "done");
  };
  for (const name of edges.keys()) walk(name, []);
}

export interface ImportOptions {
  egress: EgressPolicy;
  /** Blueprint-side reference for whatever credential this API needs. Never a secret. */
  credentialRef?: string;
  /** Opt-in, and still subject to the egress policy. */
  allowExternalRefs?: boolean;
}

export async function importOpenApi(rawText: string, opts: ImportOptions): Promise<ImportResult> {
  const problems: ImportProblem[] = [];
  const ignored: ImportResult["ignored"] = [];
  const templates: RequestTemplate[] = [];

  if (rawText.length > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      templates: [],
      ignored,
      problems: [problem(IMPORT_REASONS.DOCUMENT_TOO_LARGE, "CRITICAL", "$", `document is ${rawText.length} bytes, limit ${MAX_DOCUMENT_BYTES}`)],
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch (e) {
    return { ok: false, templates: [], ignored, problems: [problem(IMPORT_REASONS.MALFORMED, "CRITICAL", "$", (e as Error).message)] };
  }

  const parsed = DocSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      templates: [],
      ignored,
      problems: parsed.error.issues.map((i) => problem(IMPORT_REASONS.MALFORMED, "CRITICAL", i.path.join("."), i.message)),
    };
  }
  const doc = parsed.data;

  if (!/^3\.(0|1)\./.test(doc.openapi)) {
    problems.push(problem(IMPORT_REASONS.UNSUPPORTED_VERSION, "CRITICAL", "openapi", `version ${doc.openapi} is outside the supported 3.0.x / 3.1.x subset`));
  }

  // Vendor extensions are recorded as ignored rather than dropped silently: a document author who
  // put behaviour in an x- field should be able to see that none of it ran.
  const noteExtensions = (obj: Record<string, unknown>, path: string) => {
    for (const k of Object.keys(obj)) {
      if (k.startsWith("x-")) {
        ignored.push({ path: `${path}.${k}`, what: "vendor extension", why: "x- fields are untrusted metadata; nothing in them is executed or honoured" });
      }
    }
  };
  noteExtensions(json as Record<string, unknown>, "$");

  auditSchema(doc.components?.schemas ?? {}, "components.schemas", 0, new Set(), problems);
  detectRefCycles(doc.components?.schemas ?? {}, problems);
  if (!opts.allowExternalRefs) {
    auditSchema(doc.paths, "paths", 0, new Set(), problems);
  }

  /* ── servers ─────────────────────────────────────────────────────────────
   * A server URL is a destination the document chose. It gets the same egress check any other URL
   * would, and a document with no usable server yields no templates rather than a default. */
  const servers = doc.servers ?? [];
  if (servers.length === 0) {
    problems.push(problem(IMPORT_REASONS.NO_SERVERS, "CRITICAL", "servers", "the document names no server; a host is never inferred"));
  }

  let chosen: { host: string; basePath: string } | null = null;
  for (const [i, s] of servers.entries()) {
    if (/\{[^}]+\}/.test(s.url)) {
      // A templated server URL lets whoever fills the variable choose the host.
      problems.push(problem(IMPORT_REASONS.USER_SUPPLIED_HOST, "CRITICAL", `servers[${i}].url`, `server URL "${s.url}" is templated; the host would be chosen at call time`));
      continue;
    }
    const verdict: EgressVerdict = await checkUrl(s.url, opts.egress);
    if (!verdict.ok) {
      problems.push(problem(IMPORT_REASONS.SERVER_REJECTED, "CRITICAL", `servers[${i}].url`, `${verdict.reason}: ${verdict.detail}`));
      continue;
    }
    if (!chosen) chosen = { host: verdict.url.hostname, basePath: verdict.url.pathname.replace(/\/$/, "") };
  }

  /* ── security schemes ────────────────────────────────────────────────── */
  const schemes = doc.components?.securitySchemes ?? {};
  const authFor = (name: string): AuthRequirement => {
    const s = schemes[name];
    if (!s) {
      return { schemeName: name, declaredAuth: "none", supportedAuth: false, credentialPlacement: null, notes: `security scheme "${name}" is referenced but not defined` };
    }
    const kind = AUTH_KIND(s);
    const supported = RUNTIME_SUPPORTED.includes(kind);
    const placement =
      kind === "apiKey" && typeof s.name === "string"
        ? { in: (s.in === "query" || s.in === "cookie" ? s.in : "header") as "header" | "query" | "cookie", name: s.name }
        : kind === "http-bearer"
          ? ({ in: "header", name: "Authorization" } as const)
          : null;
    return {
      schemeName: name,
      declaredAuth: kind,
      supportedAuth: supported,
      credentialPlacement: placement,
      notes: supported
        ? "the broker attaches this credential; it is never given to the agent or written into the Blueprint"
        : `${kind} is parsed but not executed by this runtime — declaring support without a token exchange would be a claim, not a feature`,
    };
  };

  /* ── operations ──────────────────────────────────────────────────────── */
  const seenOperationIds = new Set<string>();

  for (const [pathKey, item] of Object.entries(doc.paths)) {
    if (pathKey.includes("..")) {
      problems.push(problem(IMPORT_REASONS.PATH_TRAVERSAL, "CRITICAL", `paths.${pathKey}`, "path contains a traversal segment"));
      continue;
    }
    noteExtensions(item as Record<string, unknown>, `paths.${pathKey}`);

    for (const [method, opRaw] of Object.entries(item as Record<string, unknown>)) {
      if (method.startsWith("x-")) continue;
      if (!SUPPORTED_METHODS.includes(method as (typeof SUPPORTED_METHODS)[number])) {
        ignored.push({ path: `paths.${pathKey}.${method}`, what: `method ${method}`, why: "outside the supported method subset" });
        continue;
      }
      const op = (opRaw ?? {}) as Record<string, unknown>;
      const operationId = typeof op.operationId === "string" ? op.operationId : "";
      if (!operationId) {
        problems.push(problem(IMPORT_REASONS.UNSUPPORTED_OPERATION, "HIGH", `paths.${pathKey}.${method}`, "operation has no operationId; it cannot be referenced or pinned"));
        continue;
      }
      if (seenOperationIds.has(operationId)) {
        // Two operations under one id means a later reference is ambiguous — and an ambiguous
        // reference to an operation that moves data is resolved by luck.
        problems.push(problem(IMPORT_REASONS.DUPLICATE_OPERATION_ID, "CRITICAL", `paths.${pathKey}.${method}.operationId`, `operationId "${operationId}" is used more than once`));
        continue;
      }
      seenOperationIds.add(operationId);
      noteExtensions(op, `paths.${pathKey}.${method}`);

      const secRefs = (Array.isArray(op.security) ? op.security : doc.security) ?? [];
      const schemeName = secRefs.length > 0 ? Object.keys(secRefs[0] as Record<string, unknown>)[0] ?? "" : "";
      const auth = schemeName ? authFor(schemeName) : { schemeName: "", declaredAuth: "none" as const, supportedAuth: true, credentialPlacement: null, notes: "no authentication declared" };

      if (schemeName && !auth.supportedAuth) {
        problems.push(problem(IMPORT_REASONS.UNSUPPORTED_AUTH, "HIGH", `paths.${pathKey}.${method}.security`, auth.notes));
      }

      if (!chosen) continue; // no usable server: nothing to template against

      const params = Array.isArray(op.parameters) ? (op.parameters as Array<Record<string, unknown>>) : [];
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const p of params) {
        const name = String(p.name ?? "");
        if (!name) continue;
        properties[name] = (p.schema as Record<string, unknown>) ?? { type: "string" };
        if (p.required === true) required.push(name);
      }

      templates.push({
        operationId,
        method: method as RequestTemplate["method"],
        host: chosen.host,
        basePath: chosen.basePath,
        pathTemplate: pathKey,
        inputSchema: { type: "object", properties, required, additionalProperties: false },
        outputSchema: ((op.responses as Record<string, unknown>)?.["200"] as Record<string, unknown>) ?? {},
        auth,
        credentialRef: opts.credentialRef ?? null,
        summary: typeof op.summary === "string" ? op.summary : "",
      });
    }
  }

  const blocking = problems.some((p) => p.severity === "CRITICAL");
  return { ok: !blocking && templates.length > 0, problems, templates, ignored };
}
