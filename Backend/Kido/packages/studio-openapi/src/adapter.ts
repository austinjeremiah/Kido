import type {
  DataAdapter, DataObservation, DataReadContext, ValidationProblem, ValidationResult,
  ContextLockAdapterManifest,
} from "@contextlock/studio-adapters";
import { ADAPTER_MANIFEST_VERSION } from "@contextlock/studio-adapters";
import type { RequestTemplate } from "./importer.js";
import { readResponse, DEFAULT_RESPONSE_LIMITS, type RawResponse, type ResponseLimits } from "./response.js";
import { applyMapping, IMPORTED_API_TRUST, type FieldMapping } from "./transform.js";

/**
 * An imported OpenAPI operation, as a generic DataAdapter.
 *
 * The point of building it this way rather than as a special case: once an imported API is an
 * adapter, everything the kernel already does applies to it unchanged — trust enforcement, the
 * resolver's refusal to substitute a weaker source, provenance, freshness, version pinning. No part
 * of the Studio needs to know that this particular adapter came from a YAML file someone uploaded.
 */

export const IMPORTED_REASONS = {
  UNKNOWN_PARAMETER: "API-UNKNOWN-PARAMETER",
  MISSING_PARAMETER: "API-MISSING-PARAMETER",
  PARAMETER_TYPE: "API-PARAMETER-TYPE",
  HOST_OVERRIDE: "API-HOST-OVERRIDE-REFUSED",
  NO_PROVENANCE: "API-NO-PROVENANCE",
} as const;

export interface ImportedApiQuery {
  operationId: string;
  /** Values for the operation's declared parameters. Nothing else is accepted. */
  parameters: Record<string, string | number | boolean>;
}

export interface ImportedApiConfig {
  template: RequestTemplate;
  /**
   * The one field this adapter observes.
   *
   * The kernel's contract is one typed value per observation, and this adapter conforms to it
   * rather than widening it: a bag of loosely-typed fields cannot be aged, unit-checked or
   * compared, which is exactly what an observation exists to make possible. An API that supplies
   * several interesting values becomes several adapters.
   */
  primary: { name: string; mapping: FieldMapping; unit: string; decimals: number };
  /** Additional fields, carried as context only. Never the thing a policy compares. */
  mappings: Record<string, FieldMapping>;
  /**
   * Where this call runs.
   *
   * `cre-confidential` when the credential or the response must stay private; otherwise the
   * Adapter Broker. The generated agent never calls out directly in either case — see
   * `placementFor`.
   */
  placement: "cre-confidential" | "studio-backend";
  limits?: ResponseLimits;
}

/**
 * Decide where an imported API call must execute.
 *
 * The rule is about who may SEE things, not about convenience. If the credential is confidential,
 * or the response feeds a private policy threshold, the call belongs inside the CRE enclave — the
 * one place where the credential, the request, the response and the threshold are all invisible to
 * everything outside, and only a verdict leaves.
 *
 * Everything else goes through the Adapter Broker. In neither case does the generated agent get
 * outbound networking: network access is not a capability an agent needs in order to be given an
 * answer.
 */
export function placementFor(opts: {
  credentialIsConfidential: boolean;
  responseFeedsPrivatePolicy: boolean;
}): ImportedApiConfig["placement"] {
  return opts.credentialIsConfidential || opts.responseFeedsPrivatePolicy ? "cre-confidential" : "studio-backend";
}

export function manifestForImportedApi(cfg: ImportedApiConfig, chains: number[]): ContextLockAdapterManifest {
  const t = cfg.template;
  return {
    schemaVersion: ADAPTER_MANIFEST_VERSION,
    id: `imported-${t.operationId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 63),
    version: "1.0.0",
    adapterType: "EXTERNAL_CONTEXT",
    name: `Imported: ${t.operationId}`,
    description: `Imported from an OpenAPI document: ${t.method.toUpperCase()} ${t.pathTemplate} on ${t.host}. Trust is EXTERNAL_API and cannot be raised by the document.`,
    provider: t.host,
    supportedChains: chains,
    capabilities: [{ name: "IMPORTED_CONTEXT", description: t.summary || t.operationId, dataKind: `imported.${t.operationId}`, trustClass: IMPORTED_API_TRUST }],
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    // Never negotiable, and never read from the document.
    trustClass: IMPORTED_API_TRUST,
    freshnessSemantics: { kind: "request-time", typicalStalenessMs: 0, exposesBlockLag: false },
    auth: {
      mode: t.auth.declaredAuth === "apiKey" ? "api-key" : t.auth.declaredAuth === "http-bearer" ? "bearer" : "none",
      // A NAME derived from the credential reference. Never a value.
      requiredSecretNames: t.credentialRef ? [t.credentialRef.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase().slice(0, 63)] : [],
      placement: cfg.placement === "cre-confidential" ? "cre-confidential" : "studio-backend",
    },
    permissionsRequired: [],
    executionPlacement: cfg.placement,
    safety: {
      decodesPreparedTransactions: false,
      supportsDryRun: true,
      allowsArbitraryTarget: false,
      allowsArbitraryRecipient: false,
      independentlyValidatesProviderOutput: true,
    },
    generatedModules: [{ path: `src/adapters/imported-${t.operationId}/adapter.ts`, kind: "adapter-runtime" }],
    simulationProviders: ["IMPORTED-API-NORMAL", "IMPORTED-API-SCHEMA-MISMATCH", "IMPORTED-API-TIMEOUT"],
    securityAssertions: [
      { id: "AS-IMP-1", statement: "The credential is referenced, never carried; the Blueprint contains no secret.", provenBy: ["API-006"] },
      { id: "AS-IMP-2", statement: "Trust is EXTERNAL_API and cannot be promoted by the document, the model or the user.", provenBy: ["API-017", "API-018"] },
      { id: "AS-IMP-3", statement: "Response mapping is declarative; no imported code executes.", provenBy: ["API-020", "API-020b"] },
    ],
    documentation: {
      officialDocs: [`https://${t.host}/`],
      verifiedOn: new Date().toISOString().slice(0, 10),
      notes: `Host allow-listed and resolved at import; ${t.auth.declaredAuth} declared, runtime support ${t.auth.supportedAuth}.`,
    },
  };
}

export class ImportedApiAdapter implements DataAdapter<ImportedApiQuery, RawResponse> {
  constructor(
    private readonly cfg: ImportedApiConfig,
    private readonly chains: number[],
    /** Injected so the adapter never opens a socket itself. The broker or the enclave does. */
    private readonly perform?: (url: string, template: RequestTemplate) => Promise<RawResponse>,
  ) {}

  manifest(): ContextLockAdapterManifest {
    return manifestForImportedApi(this.cfg, this.chains);
  }

  /** Validate the caller's parameters against the imported schema. Nothing undeclared gets through. */
  validateQuery(query: unknown): { ok: true; query: ImportedApiQuery } | { ok: false; problems: ValidationProblem[] } {
    const problems: ValidationProblem[] = [];
    const P = (code: string, field: string, message: string) => problems.push({ code, severity: "CRITICAL", field, message });
    const q = query as ImportedApiQuery;
    const schema = this.cfg.template.inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] };
    const props = schema.properties ?? {};

    if (q?.operationId !== this.cfg.template.operationId) {
      P(IMPORTED_REASONS.UNKNOWN_PARAMETER, "operationId", `this adapter answers ${this.cfg.template.operationId}, not ${String(q?.operationId)}`);
    }
    for (const key of Object.keys(q?.parameters ?? {})) {
      if (!(key in props)) {
        // An undeclared parameter is how a caller reaches an operation's hidden behaviour.
        P(IMPORTED_REASONS.UNKNOWN_PARAMETER, key, `"${key}" is not a declared parameter of ${this.cfg.template.operationId}`);
      }
      if (key === "host" || key === "server" || key === "url") {
        P(IMPORTED_REASONS.HOST_OVERRIDE, key, "the host comes from the imported document and the egress policy, never from a caller");
      }
    }
    for (const req of schema.required ?? []) {
      if (!(req in (q?.parameters ?? {}))) P(IMPORTED_REASONS.MISSING_PARAMETER, req, `required parameter "${req}" is missing`);
    }
    for (const [key, value] of Object.entries(q?.parameters ?? {})) {
      const want = props[key]?.type;
      if (want === "integer" && !Number.isInteger(value)) P(IMPORTED_REASONS.PARAMETER_TYPE, key, `expected integer`);
      else if (want === "number" && typeof value !== "number") P(IMPORTED_REASONS.PARAMETER_TYPE, key, `expected number`);
      else if (want === "string" && typeof value !== "string") P(IMPORTED_REASONS.PARAMETER_TYPE, key, `expected string`);
      else if (want === "boolean" && typeof value !== "boolean") P(IMPORTED_REASONS.PARAMETER_TYPE, key, `expected boolean`);
    }
    return problems.length === 0
      ? { ok: true, query: query as ImportedApiQuery }
      : { ok: false, problems };
  }

  /** Build the URL from the TEMPLATE. Path values are encoded, never interpolated raw. */
  buildUrl(q: ImportedApiQuery): string {
    const t = this.cfg.template;
    const path = t.pathTemplate.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(String(q.parameters[name] ?? "")));
    return `https://${t.host}${t.basePath}${path}`;
  }

  async fetch(query: ImportedApiQuery): Promise<RawResponse> {
    if (!this.perform) throw new Error("API-NO-TRANSPORT: the broker or the enclave performs the call, not the adapter");
    return this.perform(this.buildUrl(query), this.cfg.template);
  }

  provenance(_raw: RawResponse, ctx: DataReadContext): DataObservation["provenance"] {
    const t = this.cfg.template;
    return {
      provider: t.host,
      adapterId: this.manifest().id,
      adapterVersion: "1.0.0",
      trustClass: IMPORTED_API_TRUST,
      requestId: `${t.operationId}@${ctx.nowMs}`,
      verification: {
        verified: false,
        // Said plainly: nothing corroborates this. An imported REST answer is one party's word.
        mechanism: `none — a single ${t.host} response, executed at ${this.cfg.placement}`,
      },
    };
  }

  /**
   * Raw response → one typed observation.
   *
   * Throws rather than returning a degraded value. A normalize that returned "something" for a
   * response it could not read would put an unchecked number where a policy expects a checked one,
   * and the kernel's whole provenance contract exists to stop exactly that.
   */
  normalize(raw: RawResponse, query: ImportedApiQuery, ctx: DataReadContext): DataObservation {
    const limits = this.cfg.limits ?? DEFAULT_RESPONSE_LIMITS;
    const read = readResponse(raw, this.cfg.template.outputSchema, limits);
    if (!read.ok) throw new Error(`${read.reason}: ${read.detail}`);

    const primary = applyMapping(read.value, this.cfg.primary.mapping);
    if (!primary.ok) throw new Error(`${primary.reason}: ${primary.detail}`);

    return {
      observationId: `${this.manifest().id}:${ctx.nowMs}`,
      dataKind: `imported.${this.cfg.template.operationId}`,
      subject: query.operationId,
      value: String(primary.value),
      unit: this.cfg.primary.unit,
      decimals: this.cfg.primary.decimals,
      observedAt: new Date(ctx.nowMs).toISOString(),
      provenance: this.provenance(raw, ctx),
    };
  }

  validate(observation: DataObservation, ctx: DataReadContext): ValidationResult {
    const problems: ValidationProblem[] = [];
    if (!observation.provenance || !observation.provenance.adapterId) {
      problems.push({ code: IMPORTED_REASONS.NO_PROVENANCE, severity: "CRITICAL", field: "provenance", message: "observation carries no provenance" });
    }
    if (observation.provenance?.trustClass !== IMPORTED_API_TRUST) {
      // A normalize that returned a stronger class than the adapter is entitled to would let an
      // imported answer satisfy a requirement that asked for a verified one.
      problems.push({ code: "API-TRUST-PROMOTION-REFUSED", severity: "CRITICAL", field: "provenance.trustClass", message: `observation claims ${observation.provenance?.trustClass}; an imported API is ${IMPORTED_API_TRUST}` });
    }
    void ctx;
    return { ok: problems.length === 0, problems };
  }

  fixtureQuery(): ImportedApiQuery {
    const schema = this.cfg.template.inputSchema as { required?: string[] };
    const parameters: Record<string, string> = {};
    for (const r of schema.required ?? []) parameters[r] = "0x0000000000000000000000000000000000005e1f";
    return { operationId: this.cfg.template.operationId, parameters };
  }

  createSimulationFixtures() {
    return [];
  }

  generateTemplateConfig(): Record<string, unknown> {
    return {
      operationId: this.cfg.template.operationId,
      host: this.cfg.template.host,
      method: this.cfg.template.method,
      pathTemplate: this.cfg.template.pathTemplate,
      placement: this.cfg.placement,
      // A REFERENCE. The generated project resolves it at runtime through the broker or the bridge.
      credentialRef: this.cfg.template.credentialRef,
      mappings: this.cfg.mappings,
    };
  }
}
