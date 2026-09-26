import {
  ContextLockAdapterManifestSchema,
  DATA_ADAPTER_TYPES,
  EXECUTION_ADAPTER_TYPES,
  type ContextLockAdapterManifest,
} from "@contextlock/studio-adapters";
import { artifactHash, type ArtifactFile } from "./artifact.js";

/**
 * The conformance kit.
 *
 * A third-party adapter author runs this and finds out whether their adapter is safe to register,
 * before ContextLock ever loads it. The checks are the ones whose absence would let a
 * well-meaning adapter quietly weaken the system: a version range instead of a version, a
 * self-declared trust class it has not earned, a secret in its config, a fixture that "passes" by
 * failing for the wrong reason.
 *
 * Every finding names a code, because "your adapter failed conformance" helps nobody.
 */

export const CONFORMANCE = {
  MANIFEST_INVALID: "CONF-MANIFEST-INVALID",
  VERSION_RANGE: "CONF-VERSION-RANGE",
  IDENTITY_MISMATCH: "CONF-IDENTITY-MISMATCH",
  KIND_MISMATCH: "CONF-KIND-MISMATCH",
  TRUST_OVERCLAIM: "CONF-TRUST-OVERCLAIM",
  SECRET_IN_MANIFEST: "CONF-SECRET-IN-MANIFEST",
  SECRET_IN_CONFIG: "CONF-SECRET-IN-CONFIG",
  NO_PROVENANCE: "CONF-NO-PROVENANCE",
  NO_DECODE: "CONF-NO-DECODE",
  DECODE_READS_SUMMARY: "CONF-DECODE-READS-SUMMARY",
  DECODE_NOT_PROVEN: "CONF-DECODE-NOT-PROVEN",
  NO_FIXTURES: "CONF-NO-FIXTURES",
  FIXTURE_NO_QUERY: "CONF-FIXTURE-NO-QUERY",
  FIXTURE_NO_EXPECTATION: "CONF-FIXTURE-NO-EXPECTATION",
  NO_ASSERTIONS: "CONF-NO-ASSERTIONS",
  MODULE_NOT_DECLARED: "CONF-MODULE-NOT-DECLARED",
  ARTIFACT_UNSTABLE: "CONF-ARTIFACT-UNSTABLE",
} as const;
export type ConformanceCode = (typeof CONFORMANCE)[keyof typeof CONFORMANCE];

export interface ConformanceFinding {
  code: ConformanceCode;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  message: string;
  remediation: string;
}

export interface ConformanceResult {
  ok: boolean;
  findings: ConformanceFinding[];
  artifactHash: string | null;
}

/**
 * Trust classes an adapter may declare for itself.
 *
 * An adapter can honestly say it reads a chain or calls an API. It cannot say it is a verified
 * oracle or confidential compute, because those are properties of a MECHANISM — aggregation,
 * attestation — not of an assertion. Claiming one is the single highest-leverage thing a hostile
 * adapter could do, since it would let untrusted data satisfy a policy that requires verified data.
 */
const SELF_DECLARABLE = new Set(["USER_UNTRUSTED", "EXTERNAL_API", "DIRECT_CHAIN_DATA", "INDEXED_CHAIN_DATA"]);
const EARNED_ONLY = new Set(["VERIFIED_ORACLE", "CONFIDENTIAL_VERIFIED_COMPUTE"]);

/** Providers ContextLock has itself verified, and may therefore declare an earned class. */
const FIRST_PARTY_PROVIDERS = new Set(["chainlink", "contextlock"]);

const SECRET_LIKE = /(^|_)(api[_-]?key|secret|token|password|private[_-]?key|bearer|credential)s?($|_)/i;
const SECRET_VALUE = /\b(sk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|0x[a-fA-F0-9]{64})\b/;

/** Security-relevant fields a decode must derive from calldata alone. */
const DECODED_SECURITY_FIELDS = ["actionType", "target", "recipient", "value", "inputs", "outputs", "allowanceChanges", "calldata", "chainId"] as const;

export interface SummaryProbe {
  /** A prepared transaction with an honest summary. */
  prepared: Record<string, unknown>;
  /** The same prepared transaction with a summary that lies about what the calldata does. */
  lying: Record<string, unknown>;
}

export interface AdapterUnderTest {
  manifest: unknown;
  /** The adapter instance, so the kit can check the contract it actually implements. */
  adapter: Record<string, unknown>;
  /** Files that make up the installed package, for the artifact hash. */
  files: ArtifactFile[];
  /** What `generateTemplateConfig()` returns. Checked for secrets. */
  templateConfig?: Record<string, unknown>;
  /** Two preparations differing ONLY in the provider's summary. See DECODE_READS_SUMMARY. */
  summaryProbe?: SummaryProbe;
}

/**
 * Decode both preparations and compare the security-relevant fields.
 *
 * Async because `decodeTransaction` is. Returns the findings rather than pushing, so the caller
 * stays a pure function for the synchronous checks.
 */
export async function proveDecodeIndependence(input: AdapterUnderTest): Promise<ConformanceFinding[]> {
  const probe = input.summaryProbe;
  const decode = input.adapter.decodeTransaction as ((p: unknown) => Promise<Record<string, unknown>>) | undefined;
  if (!probe || typeof decode !== "function") return [];

  const pick = (n: Record<string, unknown>) =>
    JSON.stringify(Object.fromEntries(DECODED_SECURITY_FIELDS.map((f) => [f, n[f] ?? null])));

  let honest: string;
  let lying: string;
  try {
    honest = pick(await decode.call(input.adapter, probe.prepared));
    lying = pick(await decode.call(input.adapter, probe.lying));
  } catch (e) {
    return [{
      code: CONFORMANCE.DECODE_NOT_PROVEN,
      severity: "HIGH",
      message: `decodeTransaction threw while probing: ${(e as Error).message}`,
      remediation: "Make the probe's prepared transactions decodable, or fix the decode.",
    }];
  }

  if (honest !== lying) {
    return [{
      code: CONFORMANCE.DECODE_READS_SUMMARY,
      severity: "CRITICAL",
      message: "the same calldata decoded differently when only the provider's summary changed",
      remediation: "Re-derive every security-relevant field from calldata. A provider that wanted to mislead would supply a benign summary beside hostile calldata.",
    }];
  }
  return [];
}

export function runConformance(input: AdapterUnderTest): ConformanceResult {
  const findings: ConformanceFinding[] = [];
  const add = (code: ConformanceCode, severity: ConformanceFinding["severity"], message: string, remediation: string) =>
    findings.push({ code, severity, message, remediation });

  const parsed = ContextLockAdapterManifestSchema.safeParse(input.manifest);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      add(CONFORMANCE.MANIFEST_INVALID, "CRITICAL", `${i.path.join(".")}: ${i.message}`, "Correct the manifest against contextlock.adapter.manifest/v1.");
    }
    return { ok: false, findings, artifactHash: null };
  }
  const m: ContextLockAdapterManifest = parsed.data;

  if (!/^\d+\.\d+\.\d+$/.test(m.version)) {
    add(CONFORMANCE.VERSION_RANGE, "CRITICAL", `version "${m.version}" is not exact`, "Use an exact version. A range lets a registry update change what a pinned Blueprint runs.");
  }

  const declared = (input.adapter.manifest as (() => ContextLockAdapterManifest) | undefined)?.call(input.adapter);
  if (!declared || declared.id !== m.id || declared.version !== m.version) {
    add(CONFORMANCE.IDENTITY_MISMATCH, "CRITICAL", `the implementation reports ${declared?.id}@${declared?.version}, the manifest says ${m.id}@${m.version}`, "Return the same manifest from the adapter that you register.");
  }

  const isExecution = EXECUTION_ADAPTER_TYPES.includes(m.adapterType);
  const isData = DATA_ADAPTER_TYPES.includes(m.adapterType);

  if (isExecution) {
    for (const fn of ["normalizeIntent", "buildTransaction", "decodeTransaction", "validateTransaction"]) {
      if (typeof input.adapter[fn] !== "function") {
        add(CONFORMANCE.NO_DECODE, "CRITICAL", `execution adapter is missing ${fn}()`, "An execution adapter must decode and validate independently of building.");
      }
    }
    /*
     * Whether decode reads the provider's summary is checked by BEHAVIOUR, not by reading source.
     *
     * A source scan cannot tell "decides on the summary" from "records the summary for display",
     * and both real first-party adapters do the latter — they carry it into providerMetadata so a
     * reviewer can compare the claim against the decoded truth. Flagging that is a false positive
     * that would teach authors to hide the field rather than stop trusting it.
     *
     * So the kit decodes the SAME calldata twice with two different summaries, one of them a lie,
     * and requires every security-relevant decoded field to be identical.
     */
    if (!input.summaryProbe) {
      add(CONFORMANCE.DECODE_NOT_PROVEN, "MEDIUM", "no summaryProbe supplied, so decode independence was not exercised", "Supply { prepared, lyingSummary } so the kit can prove your decode ignores the provider's description.");
    }
    if (!m.safety.decodesPreparedTransactions) {
      add(CONFORMANCE.NO_DECODE, "HIGH", "safety.decodesPreparedTransactions is false for an execution adapter", "Set it, and implement it.");
    }
  }

  if (isData) {
    if (typeof input.adapter.normalize !== "function") {
      add(CONFORMANCE.NO_PROVENANCE, "CRITICAL", "data adapter is missing normalize()", "A data adapter must attach provenance to every observation.");
    }
    if (typeof input.adapter.fixtureQuery !== "function") {
      // FND-V2-008: without this the harness guesses a query, and every rejection fixture then
      // passes for the wrong reason.
      add(CONFORMANCE.FIXTURE_NO_QUERY, "CRITICAL", "data adapter is missing fixtureQuery()", "Declare the query your fixtures answer, or the harness guesses one and your rejection fixtures pass for the wrong reason.");
    }
  }

  if (EARNED_ONLY.has(m.trustClass) && !FIRST_PARTY_PROVIDERS.has(m.provider)) {
    add(CONFORMANCE.TRUST_OVERCLAIM, "CRITICAL", `manifest declares ${m.trustClass}`, "That class is a property of a mechanism — aggregation, attestation — not of a declaration. Use a class you can support, or route through a verified adapter.");
  }
  if (!SELF_DECLARABLE.has(m.trustClass) && !EARNED_ONLY.has(m.trustClass)) {
    add(CONFORMANCE.TRUST_OVERCLAIM, "HIGH", `unknown trust class ${m.trustClass}`, "Use one of the declared classes.");
  }

  const manifestText = JSON.stringify(m);
  if (SECRET_VALUE.test(manifestText)) {
    add(CONFORMANCE.SECRET_IN_MANIFEST, "CRITICAL", "the manifest contains something shaped like a live credential", "Manifests carry secret NAMES. Never a value.");
  }
  for (const name of m.auth.requiredSecretNames) {
    if (SECRET_VALUE.test(name)) add(CONFORMANCE.SECRET_IN_MANIFEST, "CRITICAL", `requiredSecretNames contains a value, not a name: ${name.slice(0, 8)}…`, "List the NAME of the secret.");
  }
  if (input.templateConfig) {
    const cfg = JSON.stringify(input.templateConfig);
    if (SECRET_VALUE.test(cfg)) {
      add(CONFORMANCE.SECRET_IN_CONFIG, "CRITICAL", "generateTemplateConfig() emits something shaped like a live credential", "Emit a credential REFERENCE. The generated project resolves it at runtime.");
    }
    for (const k of Object.keys(input.templateConfig)) {
      if (SECRET_LIKE.test(k) && typeof input.templateConfig[k] === "string" && String(input.templateConfig[k]).length > 8) {
        add(CONFORMANCE.SECRET_IN_CONFIG, "HIGH", `template config key "${k}" looks like it holds a credential`, "Emit a reference instead of a value.");
      }
    }
  }

  const fixtures = (input.adapter.createSimulationFixtures as (() => unknown[]) | undefined)?.call(input.adapter) ?? [];
  if (m.simulationProviders.length === 0) {
    add(CONFORMANCE.NO_FIXTURES, "HIGH", "the manifest contributes no simulation scenarios", "Declare the failure modes your adapter is responsible for.");
  }
  for (const [i, f] of (fixtures as Array<Record<string, unknown>>).entries()) {
    if (!f || typeof f !== "object" || !("expected" in f)) {
      add(CONFORMANCE.FIXTURE_NO_EXPECTATION, "CRITICAL", `fixture ${i} declares no expected outcome`, "A fixture without a stated expectation is checked by guessing, and a guess that matches is not evidence.");
    }
  }

  if (m.securityAssertions.length === 0) {
    add(CONFORMANCE.NO_ASSERTIONS, "HIGH", "the manifest states no security assertions", "State what your adapter guarantees, and which tests prove it.");
  }

  // The manifest promises files; the package must actually contain them.
  const paths = new Set(input.files.map((f) => f.path));
  for (const mod of m.generatedModules) {
    if (!paths.has(mod.path) && !input.files.some((f) => f.path.endsWith(mod.path.split("/").pop()!))) {
      add(CONFORMANCE.MODULE_NOT_DECLARED, "MEDIUM", `manifest declares ${mod.path}, which the package does not contain`, "Declare what you ship, and ship what you declare.");
    }
  }

  let hash: string | null = null;
  try {
    hash = artifactHash(input.files);
    if (artifactHash([...input.files].reverse()) !== hash) {
      add(CONFORMANCE.ARTIFACT_UNSTABLE, "CRITICAL", "the artifact hash depends on file order", "This is a ContextLock bug, not yours — please report it.");
    }
  } catch {
    hash = null;
  }

  const blocking = findings.some((f) => f.severity === "CRITICAL");
  return { ok: !blocking, findings, artifactHash: hash };
}
