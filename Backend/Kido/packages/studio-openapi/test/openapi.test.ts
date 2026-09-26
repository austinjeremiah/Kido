import { describe, expect, it } from "vitest";
import {
  importOpenApi, checkUrl, checkRedirectChain, isPrivateAddress, isMetadataAddress,
  readResponse, applyMapping, resolveImportedTrust, IMPORTED_API_TRUST,
  EGRESS_REASONS, IMPORT_REASONS, RESPONSE_REASONS, TRANSFORM_REASONS,
  DEFAULT_RESPONSE_LIMITS, MAX_DOCUMENT_BYTES,
} from "../src/index.js";
import { CORPUS, ACME_RISK_SPEC, ACME_RISK_HOST, dnsPolicy, deeplyNestedSpec, recursiveSpec } from "./corpus.js";

const policy = dnsPolicy([ACME_RISK_HOST, "public.example.test", "rebind.example.test", "internal.example.test", "metadata.example.test", "mapped.example.test", "cgnat.example.test", "localhost", "127.0.0.1", "169.254.169.254"]);

const imp = (spec: string, over = {}) => importOpenApi(spec, { egress: policy, credentialRef: "local://acme-risk-api", ...over });

/** Every rejection names its exact code. "Import failed" is true of a typo and of an SSRF alike. */
const expectProblem = async (spec: string, code: string) => {
  const r = await imp(spec);
  const codes = r.problems.map((p) => p.code);
  expect(codes, `expected ${code}, got ${codes.join(", ") || "none"}`).toContain(code);
  return r;
};

describe("importing a well-formed document", () => {
  it("API-001 the Acme Risk API imports to a typed request template", async () => {
    const r = await imp(ACME_RISK_SPEC);
    expect(r.problems.filter((p) => p.severity === "CRITICAL")).toEqual([]);
    expect(r.ok).toBe(true);
    const t = r.templates[0]!;
    expect(t.operationId).toBe("getRisk");
    expect(t.method).toBe("get");
    expect(t.host).toBe(ACME_RISK_HOST);
    expect(t.pathTemplate).toBe("/risk/{wallet}");
    expect(t.inputSchema).toMatchObject({ type: "object", required: ["wallet"], additionalProperties: false });
  });

  it("API-004 an HTTP bearer scheme is parsed and marked runtime-supported", async () => {
    const t = (await imp(ACME_RISK_SPEC)).templates[0]!;
    expect(t.auth.declaredAuth).toBe("http-bearer");
    expect(t.auth.supportedAuth).toBe(true);
    expect(t.auth.credentialPlacement).toEqual({ in: "header", name: "Authorization" });
  });

  it("API-003 an apiKey scheme is parsed with its placement", async () => {
    const t = (await imp(CORPUS.API_KEY!)).templates[0]!;
    expect(t.auth.declaredAuth).toBe("apiKey");
    expect(t.auth.credentialPlacement).toEqual({ in: "header", name: "X-Api-Key" });
  });

  it("API-005 OAuth2 is parsed but NOT claimed as runtime-supported", async () => {
    const r = await imp(CORPUS.OAUTH2!);
    const t = r.templates[0]!;
    expect(t.auth.declaredAuth).toBe("oauth2");
    // Parsing is not support. Declaring support without a token exchange would be a claim.
    expect(t.auth.supportedAuth).toBe(false);
    expect(r.problems.map((p) => p.code)).toContain(IMPORT_REASONS.UNSUPPORTED_AUTH);
  });

  it("API-005b OpenID Connect is parsed and equally not claimed", async () => {
    const t = (await imp(CORPUS.UNKNOWN_AUTH!)).templates[0]!;
    expect(t.auth.declaredAuth).toBe("openIdConnect");
    expect(t.auth.supportedAuth).toBe(false);
  });

  it("API-006 no secret ever reaches the template: only a credential reference", async () => {
    const r = await imp(ACME_RISK_SPEC);
    const s = JSON.stringify(r.templates);
    expect(r.templates[0]!.credentialRef).toBe("local://acme-risk-api");
    for (const forbidden of ["apiKey:", "token", "password", "clientSecret", "Bearer ey"]) {
      expect(s.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("API-002 an operation without an operationId is refused, not guessed at", async () => {
    await expectProblem(CORPUS.NO_OPERATION_ID!, IMPORT_REASONS.UNSUPPORTED_OPERATION);
  });

  it("a duplicate operationId is refused: an ambiguous reference is resolved by luck", async () => {
    await expectProblem(CORPUS.DUPLICATE_OPERATION_ID!, IMPORT_REASONS.DUPLICATE_OPERATION_ID);
  });

  it("an unsupported OpenAPI version is refused", async () => {
    await expectProblem(CORPUS.UNSUPPORTED_VERSION!, IMPORT_REASONS.UNSUPPORTED_VERSION);
  });
});

describe("the document is data, never code", () => {
  it("API-020 vendor extensions are recorded as ignored, never executed or honoured", async () => {
    const r = await imp(CORPUS.MALICIOUS_VENDOR_EXTENSION!);
    const ignoredPaths = r.ignored.map((i) => i.path);
    expect(ignoredPaths).toContain("$.x-startup-script");
    // Including the one that tries to talk the importer into a trust class.
    expect(ignoredPaths).toContain("$.x-contextlock-trust");
    expect(r.ignored.every((i) => i.why.includes("untrusted"))).toBe(true);
    // And the template's trust is unaffected by what the document asserted about itself.
    expect(resolveImportedTrust(null).trustClass).toBe("EXTERNAL_API");
  });

  it("API-011 an external $ref is denied", async () => {
    await expectProblem(CORPUS.EXTERNAL_REF!, IMPORT_REASONS.EXTERNAL_REF);
  });

  it("API-013 a recursive schema is bounded rather than followed", async () => {
    const r = await imp(recursiveSpec());
    const codes = r.problems.map((p) => p.code);
    expect(codes.some((c) => c === IMPORT_REASONS.RECURSIVE_SCHEMA || c === IMPORT_REASONS.SCHEMA_TOO_DEEP)).toBe(true);
  });

  it("API-013b a very deeply nested schema is refused", async () => {
    await expectProblem(deeplyNestedSpec(40), IMPORT_REASONS.SCHEMA_TOO_DEEP);
  });

  it("API-012 an oversized document is refused before it is parsed", async () => {
    const big = "x".repeat(MAX_DOCUMENT_BYTES + 1);
    const r = await imp(big);
    expect(r.problems[0]!.code).toBe(IMPORT_REASONS.DOCUMENT_TOO_LARGE);
    // Parsing a 2MB string to discover it is 2MB would defeat the limit.
    expect(r.problems).toHaveLength(1);
  });

  it("a path traversal segment is refused", async () => {
    await expectProblem(CORPUS.PATH_TRAVERSAL!, IMPORT_REASONS.PATH_TRAVERSAL);
  });
});

describe("egress control", () => {
  it("API-007 a localhost server is rejected", async () => {
    await expectProblem(CORPUS.LOCALHOST_SERVER!, IMPORT_REASONS.SERVER_REJECTED);
    const v = await checkUrl("https://localhost/v1", policy);
    expect(v).toMatchObject({ ok: false, reason: EGRESS_REASONS.DNS_FAILED });
  });

  it("API-007b a loopback literal is rejected", async () => {
    const v = await checkUrl("https://127.0.0.1/v1", policy);
    expect(v).toMatchObject({ ok: false, reason: EGRESS_REASONS.PRIVATE_ADDRESS });
  });

  it("API-008 a private address behind a public name is rejected", async () => {
    const v = await checkUrl("https://internal.example.test/v1", policy);
    expect(v).toMatchObject({ ok: false, reason: EGRESS_REASONS.PRIVATE_ADDRESS });
  });

  it("API-008b every resolved address must be safe, not merely the first", async () => {
    // The rebinding shape: one good answer beside a loopback, hoping the caller uses the second.
    const v = await checkUrl("https://rebind.example.test/v1", policy);
    expect(v).toMatchObject({ ok: false, reason: EGRESS_REASONS.PRIVATE_ADDRESS });
  });

  it("API-008c an IPv4-mapped IPv6 loopback does not slip past", async () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    const v = await checkUrl("https://mapped.example.test/v1", policy);
    expect(v).toMatchObject({ ok: false, reason: EGRESS_REASONS.PRIVATE_ADDRESS });
  });

  it("API-008d carrier-grade NAT is private", async () => {
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    const v = await checkUrl("https://cgnat.example.test/v1", policy);
    expect(v).toMatchObject({ ok: false, reason: EGRESS_REASONS.PRIVATE_ADDRESS });
  });

  it("API-009 the cloud metadata endpoint is rejected by its own reason code", async () => {
    expect(isMetadataAddress("169.254.169.254")).toBe(true);
    const v = await checkUrl("https://metadata.example.test/v1", policy);
    // Reported as METADATA rather than merely PRIVATE: it is the highest-value SSRF target there is.
    expect(v).toMatchObject({ ok: false, reason: EGRESS_REASONS.METADATA_ENDPOINT });
  });

  it("API-010 a redirect is revalidated at every hop", async () => {
    const ok = await checkRedirectChain(`https://${ACME_RISK_HOST}/v1`, ["https://public.example.test/x"], policy);
    expect(ok.ok).toBe(true);
    // A permitted host that 302s somewhere private is a fully working SSRF unless the hop is checked.
    const bad = await checkRedirectChain(`https://${ACME_RISK_HOST}/v1`, ["https://metadata.example.test/x"], policy);
    expect(bad).toMatchObject({ ok: false, reason: EGRESS_REASONS.METADATA_ENDPOINT });
  });

  it("API-010b a redirect chain longer than the limit is refused", async () => {
    const hops = ["https://public.example.test/1", "https://public.example.test/2", "https://public.example.test/3"];
    const r = await checkRedirectChain(`https://${ACME_RISK_HOST}/v1`, hops, policy);
    expect(r).toMatchObject({ ok: false, reason: EGRESS_REASONS.TOO_MANY_REDIRECTS });
  });

  it("plain HTTP is refused", async () => {
    const v = await checkUrl(`http://${ACME_RISK_HOST}/v1`, policy);
    expect(v).toMatchObject({ ok: false, reason: EGRESS_REASONS.NOT_HTTPS });
  });

  it("credentials embedded in a URL are refused", async () => {
    const v = await checkUrl(`https://user:pw@${ACME_RISK_HOST}/v1`, policy);
    expect(v).toMatchObject({ ok: false, reason: EGRESS_REASONS.CREDENTIALS_IN_URL });
  });

  it("a host not on the allow-list is refused, and the allow-list is default-deny", async () => {
    const v = await checkUrl("https://public.example.test/v1", dnsPolicy([]));
    expect(v).toMatchObject({ ok: false, reason: EGRESS_REASONS.HOST_NOT_ALLOWED });
  });

  it("an unexpected port is refused", async () => {
    const v = await checkUrl(`https://${ACME_RISK_HOST}:8080/v1`, policy);
    expect(v).toMatchObject({ ok: false, reason: EGRESS_REASONS.PORT_NOT_ALLOWED });
  });

  it("a templated server URL lets the caller choose the host, so it is refused", async () => {
    await expectProblem(CORPUS.USER_SUPPLIED_HOST!, IMPORT_REASONS.USER_SUPPLIED_HOST);
  });

  it("a document with no server yields no host rather than a default", async () => {
    await expectProblem(CORPUS.NO_SERVERS!, IMPORT_REASONS.NO_SERVERS);
  });
});

describe("responses are bounded", () => {
  const schema = { type: "object", properties: { riskScore: { type: "integer" } }, required: ["riskScore"] };
  const raw = (over = {}) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ riskScore: 37, timestamp: "t" }), elapsedMs: 10, ...over });

  it("a good response is read and validated", () => {
    const r = readResponse(raw(), schema);
    expect(r).toMatchObject({ ok: true, value: { riskScore: 37 } });
  });

  it("API-014 an oversized response is refused before parsing", () => {
    const r = readResponse(raw({ body: "x".repeat(DEFAULT_RESPONSE_LIMITS.maxBytes + 1) }), schema);
    expect(r).toMatchObject({ ok: false, reason: RESPONSE_REASONS.TOO_LARGE });
  });

  it("API-015 a slow response is a timeout", () => {
    const r = readResponse(raw({ elapsedMs: DEFAULT_RESPONSE_LIMITS.timeoutMs + 1 }), schema);
    expect(r).toMatchObject({ ok: false, reason: RESPONSE_REASONS.TIMEOUT });
  });

  it("API-016 a response that does not match the declared schema is refused", () => {
    const r = readResponse(raw({ body: JSON.stringify({ riskScore: "high" }) }), schema);
    expect(r).toMatchObject({ ok: false, reason: RESPONSE_REASONS.SCHEMA_MISMATCH });
  });

  it("API-016b a missing required field is refused", () => {
    const r = readResponse(raw({ body: JSON.stringify({ timestamp: "t" }) }), schema);
    expect(r).toMatchObject({ ok: false, reason: RESPONSE_REASONS.SCHEMA_MISMATCH });
  });

  it("HTML pretending to be JSON is refused on content type", () => {
    const r = readResponse(raw({ contentType: "text/html; charset=utf-8" }), schema);
    expect(r).toMatchObject({ ok: false, reason: RESPONSE_REASONS.WRONG_CONTENT_TYPE });
  });

  it("a recursively nested response is refused on depth", () => {
    let v: unknown = 1;
    for (let i = 0; i < 40; i++) v = { n: v };
    const r = readResponse(raw({ body: JSON.stringify(v) }), {});
    expect(r).toMatchObject({ ok: false, reason: RESPONSE_REASONS.TOO_DEEP });
  });

  it("a non-2xx status is a failure, not a value", () => {
    const r = readResponse(raw({ status: 500 }), schema);
    expect(r).toMatchObject({ ok: false, reason: RESPONSE_REASONS.STATUS });
  });
});

describe("transforms are declarative", () => {
  const response = { risk: { score: 37, ratio: 1.25, name: "ok", flag: true } };

  it("a plain property path is read and typed", () => {
    expect(applyMapping(response, { path: "risk.score", op: "INTEGER" })).toEqual({ ok: true, value: 37 });
    expect(applyMapping(response, { path: "risk.name", op: "STRING" })).toEqual({ ok: true, value: "ok" });
    expect(applyMapping(response, { path: "risk.ratio", op: "SCALE_TO_INTEGER", decimals: 4 })).toEqual({ ok: true, value: "12500" });
  });

  it("API-020b anything that is not a plain property path is refused rather than interpreted", () => {
    // This is where an expression language would arrive one convenience at a time.
    for (const path of ["risk['score']", "risk.score + 1", "risk..score", "a[0].b", "()=>1", "risk.*", "$.risk"]) {
      expect(applyMapping(response, { path, op: "NUMBER" }), path).toMatchObject({ ok: false, reason: TRANSFORM_REASONS.BAD_PATH });
    }
  });

  it("API-020c a prototype property is not reachable, even though it is a valid path", () => {
    // `constructor` and `toString` are syntactically ordinary identifiers, so they get past the
    // path check. They must still not resolve: `"constructor" in {}` is true via the prototype
    // chain, and a lookup written with `in` would return Object.prototype.constructor as if the
    // API had sent it.
    for (const path of ["constructor", "toString", "risk.constructor", "__proto__"]) {
      expect(applyMapping(response, { path, op: "STRING" }), path).toMatchObject({
        ok: false,
        reason: TRANSFORM_REASONS.MISSING,
      });
    }
  });

  it("a wrong type is refused rather than coerced", () => {
    expect(applyMapping(response, { path: "risk.name", op: "NUMBER" })).toMatchObject({ ok: false, reason: TRANSFORM_REASONS.WRONG_TYPE });
  });

  it("a missing value is refused rather than defaulted", () => {
    expect(applyMapping(response, { path: "risk.absent", op: "NUMBER" })).toMatchObject({ ok: false, reason: TRANSFORM_REASONS.MISSING });
  });

  it("a value outside its declared range is refused", () => {
    expect(applyMapping(response, { path: "risk.score", op: "INTEGER", min: 0, max: 10 })).toMatchObject({ ok: false, reason: TRANSFORM_REASONS.OUT_OF_RANGE });
  });
});

describe("trust cannot be self-promoted", () => {
  it("API-017 an imported API defaults to EXTERNAL_API", () => {
    expect(IMPORTED_API_TRUST).toBe("EXTERNAL_API");
    expect(resolveImportedTrust(null).trustClass).toBe("EXTERNAL_API");
  });

  it("API-018 neither the model nor the document can promote it", () => {
    for (const source of ["document", "model", "user"] as const) {
      const r = resolveImportedTrust({ requested: "VERIFIED_ORACLE", source });
      expect(r.trustClass).toBe("EXTERNAL_API");
      expect(r.refused!.reason).toBe(TRANSFORM_REASONS.TRUST_PROMOTION);
      expect(r.refused!.detail).toContain("cannot be promoted");
    }
  });

  it("API-018b asking for something WEAKER is honoured: the floor is a ceiling, not a fixed point", () => {
    expect(resolveImportedTrust({ requested: "USER_UNTRUSTED", source: "model" })).toMatchObject({
      trustClass: "USER_UNTRUSTED",
      refused: null,
    });
  });
});
