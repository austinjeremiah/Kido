import { describe, expect, it } from "vitest";
import { AdapterRegistry, assertUsableObservation } from "@contextlock/studio-adapters";
import { importOpenApi, ImportedApiAdapter, manifestForImportedApi, placementFor, IMPORTED_REASONS, IMPORTED_API_TRUST } from "../src/index.js";
import { ACME_RISK_SPEC, ACME_RISK_HOST, dnsPolicy } from "./corpus.js";

/**
 * P20.17 — the Acme Risk API, end to end.
 *
 * A private risk API is imported, becomes an ordinary adapter, and feeds a policy comparison
 * against a threshold neither the agent nor the artifact ever sees.
 */

const policy = dnsPolicy([ACME_RISK_HOST]);
const OWNER = "0x0000000000000000000000000000000000005e1f";
const BEARER = "sk-live-do-not-log-this-0123456789";

const build = async (over: Record<string, unknown> = {}) => {
  const r = await importOpenApi(ACME_RISK_SPEC, { egress: policy, credentialRef: "local://acme-risk-api" });
  expect(r.ok).toBe(true);
  const template = r.templates[0]!;
  const cfg = {
    template,
    primary: { name: "riskScore", mapping: { path: "riskScore", op: "INTEGER" as const, min: 0, max: 100 }, unit: "score", decimals: 0 },
    mappings: { timestamp: { path: "timestamp", op: "STRING" as const } },
    placement: placementFor({ credentialIsConfidential: true, responseFeedsPrivatePolicy: true }),
    ...over,
  };
  return { template, cfg };
};

const raw = (body: unknown, over = {}) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body), elapsedMs: 12, ...over });
const ctx = { chainId: 11155111, nowMs: 1_700_000_000_000 };

describe("the Acme Risk API becomes an ordinary adapter", () => {
  it("API-019 a confidential credential and a private threshold route the call into CRE", async () => {
    const { cfg } = await build();
    expect(cfg.placement).toBe("cre-confidential");
    // A public API with no private policy goes through the broker instead — the rule discriminates.
    expect(placementFor({ credentialIsConfidential: false, responseFeedsPrivatePolicy: false })).toBe("studio-backend");
    expect(manifestForImportedApi(cfg, [11155111]).auth.placement).toBe("cre-confidential");
  });

  it("registers through the generic kernel with no special case", async () => {
    const { cfg } = await build();
    const adapter = new ImportedApiAdapter(cfg, [11155111]);
    const r = new AdapterRegistry();
    expect(() => r.register({ kind: "data", manifest: adapter.manifest(), adapter })).not.toThrow();
    expect(r.resolve(adapter.manifest().id, "1.0.0").kind).toBe("data");
  });

  it("produces a typed observation with mandatory provenance", async () => {
    const { cfg } = await build();
    const a = new ImportedApiAdapter(cfg, [11155111]);
    const obs = a.normalize(raw({ riskScore: 37, timestamp: "2026-09-08T00:00:00Z" }), a.fixtureQuery(), ctx);
    expect(obs.value).toBe("37");
    expect(obs.unit).toBe("score");
    expect(obs.provenance.trustClass).toBe(IMPORTED_API_TRUST);
    expect(obs.provenance.verification.verified).toBe(false);
    // The mechanism string says plainly that nothing corroborates this.
    expect(obs.provenance.verification.mechanism).toContain("none");
    // And the kernel's own gate accepts it.
    expect(() => assertUsableObservation(obs, a.manifest().id)).not.toThrow();
    expect(a.validate(obs, ctx).ok).toBe(true);
  });

  it("a response that does not match the declared schema produces no observation at all", async () => {
    const { cfg } = await build();
    const a = new ImportedApiAdapter(cfg, [11155111]);
    // A degraded value here would put an unchecked number where a policy expects a checked one.
    expect(() => a.normalize(raw({ riskScore: "high" }), a.fixtureQuery(), ctx)).toThrow(/SCHEMA-MISMATCH/);
    expect(() => a.normalize(raw({ riskScore: 999, timestamp: "t" }), a.fixtureQuery(), ctx)).toThrow(/OUT-OF-RANGE/);
  });

  it("an undeclared parameter is refused, and a caller cannot choose the host", async () => {
    const { cfg } = await build();
    const a = new ImportedApiAdapter(cfg, [11155111]);
    const bad = a.validateQuery({ operationId: "getRisk", parameters: { wallet: OWNER, host: "evil.test" } });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.problems.map((p) => p.code)).toContain(IMPORTED_REASONS.HOST_OVERRIDE);

    const missing = a.validateQuery({ operationId: "getRisk", parameters: {} });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("unreachable");
    expect(missing.problems.map((p) => p.code)).toContain(IMPORTED_REASONS.MISSING_PARAMETER);
  });

  it("the URL is built from the template and path values are encoded", async () => {
    const { cfg } = await build();
    const a = new ImportedApiAdapter(cfg, [11155111]);
    expect(a.buildUrl({ operationId: "getRisk", parameters: { wallet: OWNER } })).toBe(`https://${ACME_RISK_HOST}/v1/risk/${OWNER}`);
    // A traversal in a parameter value becomes an encoded segment, not a path.
    expect(a.buildUrl({ operationId: "getRisk", parameters: { wallet: "../../admin" } })).toContain("%2F");
  });

  it("API-006b neither the credential nor the private threshold appears in the generated config", async () => {
    const { cfg } = await build();
    const a = new ImportedApiAdapter(cfg, [11155111]);
    const generated = JSON.stringify(a.generateTemplateConfig());
    expect(generated).toContain("local://acme-risk-api");
    expect(generated).not.toContain(BEARER);
    // The threshold the risk score is compared against is a private policy value; it lives in the
    // CRE secret, not in anything the Studio writes down.
    expect(generated).not.toMatch(/threshold/i);
    expect(JSON.stringify(a.manifest())).not.toContain(BEARER);
  });

  it("the adapter never opens a socket itself", async () => {
    const { cfg } = await build();
    const a = new ImportedApiAdapter(cfg, [11155111]);
    // Without an injected transport there is nothing to call: the broker or the enclave performs
    // the request, and the generated agent gets an answer rather than a network.
    await expect(a.fetch(a.fixtureQuery())).rejects.toThrow(/API-NO-TRANSPORT/);
  });
});
