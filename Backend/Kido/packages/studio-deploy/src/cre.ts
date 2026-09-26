import { z } from "zod";
import { ENVIRONMENT_REASONS, EnvironmentError, type DeploymentEnvironment } from "./environment.js";
import { sha256Hex } from "./hash.js";

/**
 * CRE deployment preflight.
 *
 * Three decisions are frozen here, each because the alternative is a security or honesty failure.
 *
 * 1. THERE IS NO "SIGN IN WITH CHAINLINK". Chainlink publishes no third-party authorization
 *    protocol, so ContextLock does not pretend to have one. The user authenticates with the
 *    official `cre login` on their own machine and `~/.cre/cre.yaml` never leaves it. The button
 *    says "Connect Chainlink CRE" and the web app receives status FIELDS, never a token. A hosted
 *    service that asked for a CRE password would be a phishing page that happens to be ours.
 *
 * 2. THE PRIVATE REGISTRY IS THE TESTNET DEFAULT. The onchain registry's lifecycle operations are
 *    Ethereum MAINNET transactions — even for a workflow that only ever touches Sepolia. Selecting
 *    it before P27 is refused with MAINNET_CONTROL_PLANE_PROHIBITED. "Private" here means the
 *    registry is Chainlink-hosted rather than onchain; it says nothing about confidential
 *    execution, and the two must not be described as one feature.
 *
 * 3. QUOTAS ARE CAPTURED, NOT ASSUMED. The documented limits are explicitly subject to change, so
 *    they are read at preflight into a capability snapshot with the moment they were read. Hard
 *    coding "3 workflows" would turn a Chainlink policy change into a ContextLock bug that only
 *    appears at deploy time.
 */

export const CRE_REASONS = {
  NOT_CONNECTED: "CRE-NOT-CONNECTED",
  BRIDGE_OFFLINE: "CRE-BRIDGE-OFFLINE",
  DEPLOY_ACCESS_REQUIRED: "CRE_DEPLOY_ACCESS_REQUIRED",
  REGISTRY_NOT_ALLOWED: "CRE-REGISTRY-NOT-ALLOWED",
  MAINNET_CONTROL_PLANE_PROHIBITED: "MAINNET_CONTROL_PLANE_PROHIBITED",
  QUOTA_EXCEEDED: "CRE-QUOTA-EXCEEDED",
  LIMITS_VIOLATED: "CRE-PRODUCTION-LIMITS-VIOLATED",
  LIMITS_NOT_SIMULATED: "CRE-PRODUCTION-LIMITS-NOT-SIMULATED",
  ARTIFACT_DRIFT: "DEPLOYMENT_ARTIFACT_DRIFT",
  BUILD_FAILED: "CRE-BUILD-FAILED",
  CHAIN_UNSUPPORTED: "CRE-CHAIN-UNSUPPORTED",
  CREDENTIAL_LEAK: "CRE-CREDENTIAL-LEAK",
} as const;
export type CreReason = (typeof CRE_REASONS)[keyof typeof CRE_REASONS];

export class CreError extends Error {
  constructor(readonly reason: CreReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "CreError";
  }
}

/* ───────────────────────────── connection modes ───────────────────────────── */

export const CreConnectionModeSchema = z.enum([
  /** Default. `cre` runs on the user's machine via the Local Bridge; credentials stay there. */
  "LOCAL_SESSION",
  /** Advanced/CI. An organization API key held in a dedicated encrypted secret manager. */
  "MANAGED_API_KEY",
]);
export type CreConnectionMode = z.infer<typeof CreConnectionModeSchema>;

/**
 * What the web app is allowed to see.
 *
 * A whitelist, not a redaction pass. The difference matters: a redactor has to recognise every
 * secret to remove it, and a field added upstream tomorrow arrives unredacted. This type simply has
 * nowhere to put a token.
 */
export const CreStatusSchema = z.object({
  connected: z.boolean(),
  mode: CreConnectionModeSchema,
  organizationId: z.string().nullable(),
  organizationName: z.string().nullable(),
  /** The account identifier as CRE reports it. Shown so the user can confirm which account. */
  accountLabel: z.string().nullable(),
  deployAccess: z.boolean(),
  availableRegistryIds: z.array(z.string()),
  supportedChains: z.array(z.object({ chainName: z.string(), chainSelector: z.string(), forwarder: z.string() })),
  cliVersion: z.string().nullable(),
  /** Set when the Local Bridge is unreachable. Cached telemetry is then shown as STALE, not current. */
  staleness: z.enum(["CURRENT", "STALE_BRIDGE_OFFLINE"]),
  checkedAtMs: z.number().int().nonnegative(),
});
export type CreStatus = z.infer<typeof CreStatusSchema>;

/**
 * Fields that must never appear in anything derived from a CRE response.
 *
 * Checked by `assertNoCreSecret` on every object crossing outward. Named rather than pattern
 * matched so the test that proves their absence can be specific (DEP-PRE-013, DEP-PRE-014).
 */
export const FORBIDDEN_CRE_FIELDS = [
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "idToken",
  "id_token",
  "apiKey",
  "api_key",
  "CRE_API_KEY",
  "sessionToken",
  "session",
  "credentials",
  "cre.yaml",
  "privateKey",
  "CRE_ETH_PRIVATE_KEY",
  "password",
  "otp",
  "bearer",
] as const;

/**
 * Assert no CRE credential material is present anywhere in a value.
 *
 * Walks keys AND string values: a token can arrive as a value under an innocuous key just as
 * easily as under `accessToken`, and the JWT shape is recognisable enough to catch.
 */
export function assertNoCreSecret(value: unknown, where: string): void {
  const jwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      if (jwt.test(v)) throw new CreError(CRE_REASONS.CREDENTIAL_LEAK, `${where}: a JWT-shaped value at ${path}`);
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v)) throw new CreError(CRE_REASONS.CREDENTIAL_LEAK, `${where}: a PEM private key at ${path}`);
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    for (const [k, x] of Object.entries(v)) {
      if ((FORBIDDEN_CRE_FIELDS as readonly string[]).includes(k)) {
        throw new CreError(CRE_REASONS.CREDENTIAL_LEAK, `${where}: forbidden field "${k}" at ${path}`);
      }
      walk(x, `${path}.${k}`);
    }
  };
  walk(value, "$");
}

/**
 * A managed API key reference.
 *
 * The key itself is never in this object, never in the database row that stores a deployment, never
 * in a Blueprint, never in generated source, never in a log line and never in the runtime
 * container. What travels is an opaque handle the CRE Broker can exchange, inside the control
 * plane, for the real value.
 */
export const CredentialRefSchema = z.object({
  credentialRef: z.string().regex(/^cred_[0-9a-f]{16,}$/),
  /** Which secret manager holds it. Recorded so an operator can find it; not a way to read it. */
  manager: z.string().min(1),
  createdAtMs: z.number().int().positive(),
  /** Where it may be used. A ref usable everywhere is a key with extra steps. */
  audience: z.literal("cre-broker"),
});
export type CredentialRef = z.infer<typeof CredentialRefSchema>;

/** Places a CRE credential must never be written. Enumerated so their absence is testable. */
export const CRE_KEY_FORBIDDEN_SINKS = [
  "blueprint",
  "generated-source",
  "build-sandbox",
  "runtime-container",
  "logs",
  "traces",
  "export",
  "deployment-receipt",
] as const;

/* ───────────────────────────── capability snapshot ───────────────────────────── */

export const CreQuotaSnapshotSchema = z.object({
  /** When these values were read from the tenant. Displayed; a snapshot with no age is a claim. */
  capturedAtMs: z.number().int().positive(),
  source: z.enum(["TENANT_API", "CLI_LIMITS_EXPORT", "DOCUMENTED_DEFAULT"]),
  maxWorkflowsPrivateRegistry: z.number().int().nonnegative(),
  workflowsInUse: z.number().int().nonnegative(),
  concurrentExecutionsPerOwner: z.number().int().nonnegative(),
  concurrentExecutionsPerWorkflow: z.number().int().nonnegative(),
  maxWasmBytes: z.number().int().positive(),
  maxCompressedWasmBytes: z.number().int().positive(),
  maxConfigBytes: z.number().int().positive(),
  maxTriggerSubscriptions: z.number().int().positive(),
  executionTimeoutMs: z.number().int().positive(),
  maxMemoryBytes: z.number().int().positive(),
  transactionGasLimit: z.number().int().positive(),
});
export type CreQuotaSnapshot = z.infer<typeof CreQuotaSnapshotSchema>;

/**
 * The documented defaults as of 2026-09-10, used ONLY as a labelled fallback.
 *
 * `source: DOCUMENTED_DEFAULT` travels with them so a snapshot built from this constant is
 * distinguishable, in the manifest and on screen, from one read live. Chainlink states plainly that
 * these are subject to change; a product that treated them as facts would be wrong silently.
 */
export const DOCUMENTED_CRE_DEFAULTS: Omit<CreQuotaSnapshot, "capturedAtMs" | "workflowsInUse"> = {
  source: "DOCUMENTED_DEFAULT",
  maxWorkflowsPrivateRegistry: 3,
  concurrentExecutionsPerOwner: 5,
  concurrentExecutionsPerWorkflow: 10,
  maxWasmBytes: 100 * 1024 * 1024,
  maxCompressedWasmBytes: 20 * 1024 * 1024,
  maxConfigBytes: 50 * 1024,
  maxTriggerSubscriptions: 10,
  executionTimeoutMs: 5 * 60_000,
  maxMemoryBytes: 100 * 1024 * 1024,
  transactionGasLimit: 5_000_000,
};

/* ────────────────────────────── registry selection ────────────────────────────── */

export const TESTNET_DEFAULT_REGISTRY = "private" as const;

/**
 * Choose a registry, refusing the one that costs mainnet gas.
 *
 * The rejection is not "mainnet is expensive". It is that registering a workflow on the onchain
 * registry is an Ethereum Mainnet write, and this product's environment model says mainnet writes
 * do not happen before P27 — including control-plane ones, which are the easiest to overlook
 * precisely because the workflow they manage is on a testnet.
 */
export function selectRegistry(env: DeploymentEnvironment, requested?: string): string {
  const wanted = requested ?? (env.kind === "TESTNET" ? TESTNET_DEFAULT_REGISTRY : TESTNET_DEFAULT_REGISTRY);
  if (wanted.startsWith("onchain:")) {
    throw new EnvironmentError(
      ENVIRONMENT_REASONS.MAINNET_CONTROL_PLANE_PROHIBITED,
      `registry "${wanted}" is an onchain registry; its lifecycle operations are Ethereum Mainnet transactions, which are prohibited until P27`,
    );
  }
  if (!env.allowedCreRegistries.includes(wanted)) {
    throw new CreError(
      CRE_REASONS.REGISTRY_NOT_ALLOWED,
      `environment "${env.environmentId}" allows [${env.allowedCreRegistries.join(", ")}], not "${wanted}"`,
    );
  }
  return wanted;
}

/* ──────────────────────────────── the CLI surface ──────────────────────────────── */

/**
 * The `cre` commands ContextLock is allowed to invoke.
 *
 * Closed, and every entry is a read or a reviewed lifecycle action. There is no passthrough, no
 * "run this cre command" — Luna never executes arbitrary CRE lifecycle commands with the user's
 * credentials (§23.6), and the way to guarantee that is for the vocabulary to have no member that
 * would let it.
 */
export const CRE_COMMANDS = [
  "whoami",
  "account-access",
  "registry-list",
  "supported-chains",
  "limits-export",
  "workflow-build",
  "workflow-hash",
  "workflow-simulate",
  "workflow-deploy",
  "workflow-get",
  "workflow-list",
  "workflow-pause",
  "workflow-activate",
] as const;
export type CreCommand = (typeof CRE_COMMANDS)[number];

export interface CreCliResult {
  ok: boolean;
  /** Structured output where the command offers `--output json`; raw text otherwise. */
  json: unknown;
  stdoutSummary: string;
  exitCode: number;
}

/**
 * The CRE CLI, as this package is permitted to see it.
 *
 * Implemented over the Local Bridge in LOCAL_SESSION mode and over the CRE Broker in
 * MANAGED_API_KEY mode. Both return sanitized results; neither returns credentials.
 */
export interface CreCli {
  readonly mode: CreConnectionMode;
  readonly available: boolean;
  run(cmd: CreCommand, args: Record<string, string | number | boolean>): Promise<CreCliResult>;
}

/* ────────────────────────────── artifact prebuild ────────────────────────────── */

/**
 * The built CRE artifact.
 *
 * Built ONCE, before approval, and deployed exactly. §1.4: do not silently recompile a different
 * workflow after the approval screen. A rebuild between review and deploy is a different binary
 * even when the source is identical — compilers are not required to be reproducible — so the
 * approved thing is this file, and P23 passes it with `--wasm`.
 */
export const CreArtifactSchema = z.object({
  workflowName: z.string().min(1),
  /** Absolute path to the built binary, on whichever machine built it. */
  wasmPath: z.string().min(1),
  wasmBytes: z.number().int().positive(),
  /** sha256 of the file we hold. Ours, and independent of the CLI's own hash. */
  wasmSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** From `cre workflow hash` — the CLI's own binary/config/workflow hashes. */
  binaryHash: z.string().min(16),
  configHash: z.string().min(16),
  workflowHash: z.string().min(16),
  /** sha256 over the reviewed source tree, so a source edit invalidates approval even if unbuilt. */
  sourceTreeHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  configSha256: z.string().regex(/^[0-9a-f]{64}$/),
  creCliVersion: z.string().min(1),
  builtAtMs: z.number().int().positive(),
});
export type CreArtifact = z.infer<typeof CreArtifactSchema>;

/** Hash a source tree deterministically: sorted relative paths, each with its content digest. */
export function sourceTreeHash(files: Array<{ path: string; content: string | Buffer }>): string {
  const rows = files
    .map((f) => `${f.path}:${sha256Hex(typeof f.content === "string" ? f.content : f.content)}`)
    .sort();
  return `sha256:${sha256Hex(rows.join("\n"))}`;
}

/**
 * Has the approved artifact drifted?
 *
 * Compared field by field so the answer names WHAT changed. "The artifact changed" sends someone
 * hunting; "the config hash changed, the binary did not" tells them where to look.
 */
export function artifactDrift(approved: CreArtifact, current: CreArtifact): string[] {
  const drift: string[] = [];
  const cmp = (field: keyof CreArtifact, label: string) => {
    if (approved[field] !== current[field]) drift.push(`${label}: approved ${String(approved[field])}, now ${String(current[field])}`);
  };
  cmp("wasmSha256", "WASM sha256");
  cmp("binaryHash", "CRE binary hash");
  cmp("configHash", "CRE config hash");
  cmp("workflowHash", "CRE workflow hash");
  cmp("sourceTreeHash", "source tree hash");
  cmp("configSha256", "config file sha256");
  return drift;
}

export function assertNoArtifactDrift(approved: CreArtifact, current: CreArtifact): void {
  const drift = artifactDrift(approved, current);
  if (drift.length > 0) {
    throw new CreError(
      CRE_REASONS.ARTIFACT_DRIFT,
      `the workflow no longer matches what was approved and must be re-approved:\n  ${drift.join("\n  ")}`,
    );
  }
}

/* ───────────────────────── limits and quota evaluation ───────────────────────── */

export interface LimitSimulationResult {
  ran: boolean;
  /** Which limits were enforced. `default` means CRE's current production defaults. */
  limitsProfile: string;
  violations: string[];
  cliVersion: string;
  ranAtMs: number;
}

/**
 * A workflow that violates current tenant limits cannot be READY_TO_DEPLOY (§22.12).
 *
 * `ran: false` is also a failure, and separately named. "We did not check" and "we checked and it
 * was fine" must never produce the same readiness state.
 */
export function assertLimitsSatisfied(sim: LimitSimulationResult | null): void {
  if (!sim || !sim.ran) {
    throw new CreError(
      CRE_REASONS.LIMITS_NOT_SIMULATED,
      "production-limit simulation has not been run against this workflow; readiness cannot be asserted",
    );
  }
  if (sim.violations.length > 0) {
    throw new CreError(CRE_REASONS.LIMITS_VIOLATED, sim.violations.join("; "));
  }
}

export interface QuotaCheck {
  name: string;
  used: number;
  allowed: number;
  ok: boolean;
  unit: string;
}

/** Evaluate an artifact against a captured snapshot. Every row is reported, not just failures. */
export function checkQuotas(
  snapshot: CreQuotaSnapshot,
  artifact: { wasmBytes: number; compressedWasmBytes: number; configBytes: number; triggerCount: number },
): QuotaCheck[] {
  return [
    { name: "private-registry workflows", used: snapshot.workflowsInUse + 1, allowed: snapshot.maxWorkflowsPrivateRegistry, ok: snapshot.workflowsInUse + 1 <= snapshot.maxWorkflowsPrivateRegistry, unit: "workflows" },
    { name: "WASM binary size", used: artifact.wasmBytes, allowed: snapshot.maxWasmBytes, ok: artifact.wasmBytes <= snapshot.maxWasmBytes, unit: "bytes" },
    { name: "compressed WASM size", used: artifact.compressedWasmBytes, allowed: snapshot.maxCompressedWasmBytes, ok: artifact.compressedWasmBytes <= snapshot.maxCompressedWasmBytes, unit: "bytes" },
    { name: "workflow config size", used: artifact.configBytes, allowed: snapshot.maxConfigBytes, ok: artifact.configBytes <= snapshot.maxConfigBytes, unit: "bytes" },
    { name: "trigger subscriptions", used: artifact.triggerCount, allowed: snapshot.maxTriggerSubscriptions, ok: artifact.triggerCount <= snapshot.maxTriggerSubscriptions, unit: "subscriptions" },
  ];
}

export function assertQuotasOk(checks: QuotaCheck[]): void {
  const bad = checks.filter((c) => !c.ok);
  if (bad.length > 0) {
    throw new CreError(
      CRE_REASONS.QUOTA_EXCEEDED,
      bad.map((c) => `${c.name}: ${c.used}/${c.allowed} ${c.unit}`).join("; "),
    );
  }
}

/**
 * Deploy access.
 *
 * A BLOCKER, not a build failure (§22.13). The distinction is not pedantry: a build failure means
 * the agent is wrong and the user should change it; this means the agent is fine and Chainlink has
 * not enabled deployment for their organization yet. Telling them the first when it is the second
 * sends them to rewrite working code.
 */
export function assertDeployAccess(status: CreStatus): void {
  if (!status.connected) {
    throw new CreError(CRE_REASONS.NOT_CONNECTED, "no CRE session; connect Chainlink CRE to continue");
  }
  if (status.staleness !== "CURRENT") {
    throw new CreError(CRE_REASONS.BRIDGE_OFFLINE, "the Local Bridge is offline, so CRE status cannot be confirmed as current");
  }
  if (!status.deployAccess) {
    throw new CreError(
      CRE_REASONS.DEPLOY_ACCESS_REQUIRED,
      `organization ${status.organizationId ?? "(unknown)"} does not have CRE workflow deployment access enabled. This is a deployment blocker, not a build failure: run \`cre account access\` to request it.`,
    );
  }
}

/** Is a chain in the tenant's supported set? Selectors compared as strings, always. */
export function creSupportsChain(status: CreStatus, chainSelector: string): boolean {
  return status.supportedChains.some((c) => c.chainSelector === chainSelector);
}
