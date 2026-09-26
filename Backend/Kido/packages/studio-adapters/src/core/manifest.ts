import { z } from "zod";
import { DataTrustClassSchema } from "./trust.js";

export const ADAPTER_MANIFEST_VERSION = "contextlock.adapter.manifest/v1" as const;

/**
 * Adapter classes.
 *
 * Deliberately six, not one. Merging them into a single `DataAdapter` would be tidier and would
 * erase the distinction that matters: an EXECUTION adapter constructs something that moves money,
 * and its output must be decoded and re-validated before anyone signs it. A VERIFIED_MARKET_DATA
 * adapter reports a number. Both "return data"; only one of them can drain a treasury if it lies.
 */
export const AdapterTypeSchema = z.enum([
  "EXECUTION",
  "STATE_DATA",
  "VERIFIED_MARKET_DATA",
  "EXTERNAL_CONTEXT",
  "TRIGGER",
  "CROSS_CHAIN",
]);
export type AdapterType = z.infer<typeof AdapterTypeSchema>;

/** Data-producing classes. Execution adapters are held to a different contract. */
export const DATA_ADAPTER_TYPES: AdapterType[] = [
  "STATE_DATA",
  "VERIFIED_MARKET_DATA",
  "EXTERNAL_CONTEXT",
];

/**
 * Classes that build and validate transactions.
 *
 * CROSS_CHAIN belongs here, and the reason is worth stating: a cross-chain send is an execution
 * that happens to name a second chain. It constructs calldata, it moves value, and it must be
 * decoded and validated by exactly the contract every other execution goes through. Filing it
 * under "data" because it is not literally named EXECUTION would put a money-moving adapter on the
 * contract meant for readings — no decodeTransaction, no validateTransaction, no recipient check.
 *
 * TRIGGER is deliberately absent: a trigger observes, it does not transact. It joins
 * DATA_ADAPTER_TYPES when it is implemented.
 */
export const EXECUTION_ADAPTER_TYPES: AdapterType[] = ["EXECUTION", "CROSS_CHAIN"];

const semver = z.string().regex(/^\d+\.\d+\.\d+$/, "must be exact semver, e.g. 1.0.0");
const adapterId = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/, "lowercase kebab id");

/** What an adapter can do, as a capability name a Blueprint can require. */
export const AdapterCapabilitySchema = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  description: z.string().min(1),
  /**
   * The kind of data this capability produces, for requirement matching. Absent for execution
   * capabilities, which produce transactions rather than observations.
   */
  dataKind: z.string().optional(),
  /** Trust of THIS capability. A provider may offer capabilities at different trust levels. */
  trustClass: DataTrustClassSchema.optional(),
});
export type AdapterCapability = z.infer<typeof AdapterCapabilitySchema>;

/**
 * How fresh a value from this adapter can be, and how freshness is known.
 *
 * `unknown` is a legitimate answer and is treated as failing every `maxAgeMs` requirement — an
 * adapter that cannot say how old its value is cannot be used where age matters.
 */
export const FreshnessSemanticsSchema = z.object({
  kind: z.enum(["source-timestamp", "block-height", "report-timestamp", "request-time", "unknown"]),
  /** Best-case staleness under normal operation, for resolver ranking. Not a guarantee. */
  typicalStalenessMs: z.number().int().nonnegative().optional(),
  /** True when the adapter reports the indexed block and the chain head, so lag is measurable. */
  exposesBlockLag: z.boolean().default(false),
});

export const AdapterAuthSchema = z.object({
  mode: z.enum(["none", "api-key", "bearer", "oauth", "x402", "local-session", "ledger", "cre-secret", "custom"]),
  /** Secret NAMES only. A manifest never carries a value. */
  requiredSecretNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/)).default([]),
  /**
   * Where the credential is resolved. Anything a browser bundle could read is refused by the
   * registry: a generated frontend must never be a place a key can live.
   */
  placement: z.enum(["studio-backend", "generated-agent-server", "cre-confidential", "never-client"]),
});

/**
 * Safety properties the registry checks rather than trusts.
 *
 * `allowsArbitraryTarget` / `allowsArbitraryRecipient` exist so an execution adapter has to *say*
 * it is dangerous. The Blueprint validator can then refuse it, instead of discovering the property
 * at execution time.
 */
export const AdapterSafetySchema = z.object({
  decodesPreparedTransactions: z.boolean().default(false),
  supportsDryRun: z.boolean().default(false),
  allowsArbitraryTarget: z.boolean().default(false),
  allowsArbitraryRecipient: z.boolean().default(false),
  /** True when provider output is independently re-derived rather than taken at face value. */
  independentlyValidatesProviderOutput: z.boolean().default(false),
});

export const ContextLockAdapterManifestSchema = z
  .object({
    schemaVersion: z.literal(ADAPTER_MANIFEST_VERSION),

    id: adapterId,
    version: semver,
    adapterType: AdapterTypeSchema,

    name: z.string().min(1),
    description: z.string().min(20),
    provider: z.string().min(1),

    supportedChains: z.array(z.number().int().positive()).min(1),

    capabilities: z.array(AdapterCapabilitySchema).min(1),

    /** JSON-schema-ish descriptors, kept as opaque records so the registry stays schema-agnostic. */
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()),

    trustClass: DataTrustClassSchema,
    freshnessSemantics: FreshnessSemanticsSchema,

    auth: AdapterAuthSchema,
    permissionsRequired: z.array(z.string()).default([]),

    executionPlacement: z.enum([
      "studio-backend",
      "generated-agent",
      "cre-confidential",
      "chainlink-functions",
      "onchain",
    ]),

    safety: AdapterSafetySchema,

    /** Files this adapter contributes to a generated project. Checked against the real output. */
    generatedModules: z
      .array(
        z.object({
          path: z.string().min(1),
          kind: z.enum(["adapter-runtime", "adapter-types", "adapter-tests", "adapter-config"]),
        }),
      )
      .min(1),

    /** Scenario ids this adapter contributes to the mandatory security pass. */
    simulationProviders: z.array(z.string().regex(/^[A-Z][A-Z0-9_-]{2,63}$/)).min(1),

    securityAssertions: z
      .array(
        z.object({
          id: z.string().regex(/^AS-[A-Z0-9-]{2,32}$/),
          statement: z.string().min(1),
          provenBy: z.array(z.string()).min(1),
        }),
      )
      .min(1),

    documentation: z.object({
      officialDocs: z.array(z.string().url()).min(1),
      verifiedOn: z.string(),
      notes: z.string().optional(),
    }),
  })
  .strict();

export type ContextLockAdapterManifest = z.infer<typeof ContextLockAdapterManifestSchema>;

export const adapterRef = (m: { id: string; version: string }) => `${m.id}@${m.version}`;
