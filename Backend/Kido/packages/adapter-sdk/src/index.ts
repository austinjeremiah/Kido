/**
 * The public ContextLock adapter SDK.
 *
 * This is the whole surface a third-party adapter author needs, and deliberately no more. It
 * re-exports the adapter CONTRACTS and the manifest schema; it exports nothing about the Studio's
 * database, its pipeline, its quota manager or its sandbox. An adapter that could reach those would
 * be a plugin with the run of the host, which is the opposite of what an adapter is.
 *
 * The contracts themselves are the security story. An adapter cannot widen its own limits — the
 * Blueprint's constraints are passed IN — and an execution adapter must implement
 * `decodeTransaction` separately from `buildTransaction`, so the thing that says what a transaction
 * does is never the thing that built it.
 */

export type {
  ExecutionAdapter,
  DataAdapter,
  ExecutionConstraints,
  AdapterExecutionContext,
  DataReadContext,
  NormalizedAction,
  DataObservation,
  ValidationProblem,
  ValidationResult,
  AdapterSimulationFixture,
} from "@contextlock/studio-adapters";

export {
  ContextLockAdapterManifestSchema,
  ADAPTER_MANIFEST_VERSION,
  AdapterTypeSchema,
  DATA_ADAPTER_TYPES,
  EXECUTION_ADAPTER_TYPES,
  type ContextLockAdapterManifest,
  type AdapterType,
  type DataTrustClass,
  adapterRef,
} from "@contextlock/studio-adapters";

export * from "./artifact.js";
