import type { AdapterType } from "@contextlock/studio-adapters";

/**
 * Adapter scaffolding.
 *
 * The generated adapter is deliberately incomplete in one specific way: every place where a real
 * adapter must make a security decision is a `throw` with a comment, not a plausible default. An
 * author who ships the scaffold unchanged gets a loud failure; an author who gets a working stub
 * that quietly permits everything ships that instead.
 */

export type ScaffoldKind = "execution" | "state-data" | "verified-market-data" | "external-api" | "trigger" | "cross-chain";

export const KIND_TO_ADAPTER_TYPE: Record<ScaffoldKind, AdapterType> = {
  execution: "EXECUTION",
  "state-data": "STATE_DATA",
  "verified-market-data": "VERIFIED_MARKET_DATA",
  "external-api": "EXTERNAL_CONTEXT",
  trigger: "TRIGGER",
  "cross-chain": "CROSS_CHAIN",
};

/** The trust class a scaffold of each kind may honestly start from. */
const DEFAULT_TRUST: Record<ScaffoldKind, string> = {
  execution: "USER_UNTRUSTED",
  "state-data": "DIRECT_CHAIN_DATA",
  // NOT VERIFIED_ORACLE. A scaffold has verified nothing yet, and starting it at a class it has
  // not earned is how an overclaim gets into a manifest by default rather than by decision.
  "verified-market-data": "EXTERNAL_API",
  "external-api": "EXTERNAL_API",
  trigger: "DIRECT_CHAIN_DATA",
  "cross-chain": "USER_UNTRUSTED",
};

export interface ScaffoldInput {
  id: string;
  kind: ScaffoldKind;
  provider: string;
  chains: number[];
}

export interface ScaffoldFile {
  path: string;
  content: string;
}

const isExecutionish = (k: ScaffoldKind) => k === "execution" || k === "cross-chain";

export function scaffoldAdapter(input: ScaffoldInput): ScaffoldFile[] {
  const { id, kind, provider, chains } = input;
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(id)) throw new Error(`SCAFFOLD-BAD-ID: "${id}" must be lowercase kebab`);
  if (chains.length === 0) throw new Error("SCAFFOLD-NO-CHAINS: an adapter must declare at least one chain");

  const type = KIND_TO_ADAPTER_TYPE[kind];
  const trust = DEFAULT_TRUST[kind];
  const camel = id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  const Class = camel.charAt(0).toUpperCase() + camel.slice(1) + "Adapter";

  const manifest = `import { ADAPTER_MANIFEST_VERSION, type ContextLockAdapterManifest } from "@contextlock/adapter-sdk";

/**
 * ${id} — ${type}
 *
 * Trust starts at ${trust}. Raising it is not an edit to this file: a higher class is a property of
 * a mechanism, and the conformance kit refuses a third-party manifest that declares one.
 */
export const manifest: ContextLockAdapterManifest = {
  schemaVersion: ADAPTER_MANIFEST_VERSION,
  id: ${JSON.stringify(id)},
  version: "0.1.0",
  adapterType: ${JSON.stringify(type)},
  name: ${JSON.stringify(id)},
  description: "TODO: describe what this adapter does, in a sentence someone reviewing it can check.",
  provider: ${JSON.stringify(provider)},
  supportedChains: ${JSON.stringify(chains)},
  capabilities: [{ name: "TODO_CAPABILITY", description: "TODO" }],
  inputSchema: {},
  outputSchema: {},
  trustClass: ${JSON.stringify(trust)},
  freshnessSemantics: { kind: "request-time", typicalStalenessMs: 0, exposesBlockLag: false },
  auth: { mode: "none", requiredSecretNames: [], placement: "never-client" },
  permissionsRequired: [],
  executionPlacement: "studio-backend",
  safety: {
    decodesPreparedTransactions: ${isExecutionish(kind)},
    supportsDryRun: false,
    allowsArbitraryTarget: false,
    allowsArbitraryRecipient: false,
    independentlyValidatesProviderOutput: ${isExecutionish(kind)},
  },
  generatedModules: [{ path: "src/adapters/${id}/adapter.ts", kind: "adapter-runtime" }],
  simulationProviders: ["${id.toUpperCase().replace(/-/g, "_")}_NORMAL"],
  securityAssertions: [
    { id: "AS-TODO-1", statement: "TODO: what does this adapter guarantee?", provenBy: ["TODO-001"] },
  ],
  documentation: {
    officialDocs: ["https://example.com/docs"],
    verifiedOn: ${JSON.stringify(new Date().toISOString().slice(0, 10))},
  },
};
`;

  const executionBody = `import { manifest } from "./manifest.js";
import type { ExecutionAdapter, NormalizedAction, ValidationResult, ExecutionConstraints } from "@contextlock/adapter-sdk";

export class ${Class} implements ExecutionAdapter {
  manifest() { return manifest; }
  supportedActions(): string[] { return ["TODO_ACTION"]; }

  normalizeIntent(intent: unknown) {
    throw new Error("TODO: reject a malformed or out-of-scope intent before any provider is contacted");
  }

  async buildTransaction(intent: unknown, ctx: unknown): Promise<unknown> {
    throw new Error("TODO: ask the provider to construct the action. The result is NOT authorization.");
  }

  /**
   * Re-derive every security-relevant field FROM CALLDATA.
   *
   * Do not read the provider's summary of what it built. A provider that wanted to mislead would
   * produce a benign summary beside hostile calldata, and reading it would defeat this method's
   * entire purpose. The conformance kit fails an adapter whose decode touches the summary.
   */
  async decodeTransaction(prepared: unknown): Promise<NormalizedAction> {
    throw new Error("TODO: decode the calldata independently");
  }

  validateTransaction(n: NormalizedAction, intent: unknown, c: ExecutionConstraints): ValidationResult {
    // Compare the DECODED action against the intent and the Blueprint's constraints. Constraints
    // are passed in, never read from your own config: an adapter must not widen its own limits.
    throw new Error("TODO: validate, and return an exact reason code for every rejection");
  }

  createSimulationFixtures() {
    // Contribute your own failure modes. Each fixture must declare its expected outcome; a fixture
    // without one is checked by guessing, and a guess that matches is not evidence.
    return [];
  }

  generateTemplateConfig(): Record<string, unknown> {
    // A credential REFERENCE, never a credential.
    return {};
  }
}
`;

  const dataBody = `import { manifest } from "./manifest.js";
import type { DataAdapter, DataObservation, ValidationResult, DataReadContext } from "@contextlock/adapter-sdk";

export class ${Class} implements DataAdapter {
  manifest() { return manifest; }

  validateQuery(query: unknown) {
    throw new Error("TODO: refuse a query this adapter cannot answer, rather than answering something else");
  }

  async fetch(query: unknown): Promise<unknown> {
    throw new Error("TODO: call the provider");
  }

  /**
   * Attach provenance to every observation.
   *
   * A reading without provenance cannot be aged, corroborated or attributed, and the resolver
   * refuses to use one. Record where it came from, when, and at what block if applicable.
   */
  normalize(raw: unknown, query: unknown, ctx: DataReadContext): DataObservation {
    throw new Error("TODO: normalize and attach provenance");
  }

  validate(observation: DataObservation, ctx: DataReadContext): ValidationResult {
    throw new Error("TODO: check freshness and shape, with an exact reason code");
  }

  /** The query your fixtures answer. Without it the harness guesses, and your rejection fixtures pass for the wrong reason. */
  fixtureQuery(): unknown {
    throw new Error("TODO: declare the fixture query");
  }

  createSimulationFixtures() { return []; }
  generateTemplateConfig(): Record<string, unknown> { return {}; }
}
`;

  const test = `import { describe, it, expect } from "vitest";
import { runConformance } from "@contextlock/adapter-sdk/testkit";
import { manifest } from "../src/manifest.js";
import { ${Class} } from "../src/adapter.js";
import { readFileSync } from "node:fs";

/**
 * The conformance gate. Run this before asking ContextLock to register your adapter.
 *
 * It is not a formality: it checks the properties whose absence would let a well-meaning adapter
 * weaken the system that loads it.
 */
describe("${id} conformance", () => {
  const files = ["src/manifest.ts", "src/adapter.ts"].map((path) => ({
    path,
    content: readFileSync(new URL(\`../\${path}\`, import.meta.url), "utf8"),
  }));

  it("passes the ContextLock conformance kit", () => {
    const r = runConformance({ manifest, adapter: new ${Class}() as never, files });
    const critical = r.findings.filter((f) => f.severity === "CRITICAL");
    expect(critical.map((f) => \`\${f.code}: \${f.message}\`).join("\\n")).toBe("");
    expect(r.ok).toBe(true);
  });

  it("has a stable artifact hash", () => {
    const a = runConformance({ manifest, adapter: new ${Class}() as never, files }).artifactHash;
    const b = runConformance({ manifest, adapter: new ${Class}() as never, files: [...files].reverse() }).artifactHash;
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
`;

  const readme = `# ${id}

A ContextLock ${type} adapter for ${provider}.

## Before you ship

\`\`\`bash
npm test          # runs the ContextLock conformance kit
\`\`\`

Everything in \`src/\` currently throws. That is deliberate — each throw marks a place where a real
adapter must make a security decision, and a scaffold that returned a plausible default would let
you ship one you never made.

## What ContextLock will and will not let this adapter do

- Its trust class starts at \`${trust}\`. A third-party manifest cannot declare \`VERIFIED_ORACLE\`
  or \`CONFIDENTIAL_VERIFIED_COMPUTE\`; those are properties of a mechanism, not of a declaration.
- Its version must be exact. A range would let a registry update change what a pinned Blueprint runs.
- The Blueprint's constraints are passed **in**. An adapter cannot widen its own limits.
${isExecutionish(kind) ? "- `decodeTransaction` must re-derive fields from calldata. Reading the provider's own summary fails conformance.\n" : "- Every observation must carry provenance. The resolver refuses a reading without it.\n"}`;

  return [
    { path: "src/manifest.ts", content: manifest },
    { path: "src/adapter.ts", content: isExecutionish(kind) ? executionBody : dataBody },
    { path: "test/conformance.test.ts", content: test },
    { path: "README.md", content: readme },
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: `contextlock-adapter-${id}`,
          version: "0.1.0",
          type: "module",
          scripts: { test: "vitest run", verify: "vitest run" },
          dependencies: { "@contextlock/adapter-sdk": "*" },
        },
        null,
        2,
      ) + "\n",
    },
  ];
}
