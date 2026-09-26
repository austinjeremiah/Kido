import { createHash } from "node:crypto";
import { z } from "zod";
import { assertNoCreSession, CreLabError } from "./cre-lab.js";
import type { AttackRun } from "./attack-lab.js";

/**
 * The shareable safety report.
 *
 * This is the artefact that leaves the machine, which makes it the one place where every honesty
 * rule in the product has to hold simultaneously — and the one place where a comfortable summary
 * would do the most damage, because a report is read by people who were not there.
 *
 * §P28.51 names the specific failure:
 *
 *     Do not bundle all this into "Private ✓".
 *
 * Confidentiality is six separate claims and usually four of them are "no". A single tick is true
 * of something and tells the reader nothing about which — and the reader has no way to ask.
 */

export const SAFETY_REPORT_SCHEMA_VERSION = "contextlock.safety-report/v1" as const;

/* ─────────────────────────── privacy, unbundled ─────────────────────────── */

export const PrivacyClaimSchema = z.object({
  claim: z.string().min(1),
  answer: z.enum(["VERIFIED", "NO", "NOT_ESTABLISHED"]),
  /** How it was established. Required for VERIFIED — an unevidenced verification is an assertion. */
  evidence: z.string().nullable(),
  blocker: z.string().nullable(),
});
export type PrivacyClaim = z.infer<typeof PrivacyClaimSchema>;

export const PRIVACY_CLAIMS = [
  "Agent cannot access CRE credential",
  "Private policy absent from agent prompt",
  "CRE official simulation",
  "CRE DON execution",
  "CRE hardware TEE",
  "Physical Ledger",
] as const;

export const REPORT_REASONS = {
  UNEVIDENCED_CLAIM: "PRIVACY_CLAIM_VERIFIED_WITHOUT_EVIDENCE",
  COLLAPSED: "PRIVACY_CLAIMS_COLLAPSED",
  SECRET_PRESENT: "SAFETY_REPORT_CONTAINS_A_SECRET",
  MISSING_SECTION: "SAFETY_REPORT_MISSING_REQUIRED_SECTION",
} as const;

export class SafetyReportError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "SafetyReportError";
  }
}

/** A `VERIFIED` claim with no evidence is an assertion wearing a verification's clothes. */
export function assertPrivacyClaimsEvidenced(claims: ReadonlyArray<PrivacyClaim>): void {
  const unevidenced = claims.filter((c) => c.answer === "VERIFIED" && (c.evidence === null || c.evidence.trim().length < 10));
  if (unevidenced.length > 0) {
    throw new SafetyReportError(
      REPORT_REASONS.UNEVIDENCED_CLAIM,
      `${unevidenced.map((c) => `"${c.claim}"`).join(", ")} ${unevidenced.length > 1 ? "are" : "is"} marked VERIFIED with no evidence. A verification nobody can check is an assertion.`,
    );
  }
  const missing = PRIVACY_CLAIMS.filter((name) => !claims.some((c) => c.claim === name));
  if (missing.length > 0) {
    throw new SafetyReportError(
      REPORT_REASONS.COLLAPSED,
      `the report omits ${missing.join(", ")}. Each claim is answered separately or the report is silent about which of them is true.`,
    );
  }
}

/* ─────────────────────────── the report ─────────────────────────── */

export const SafetyReportSchema = z.object({
  schemaVersion: z.literal(SAFETY_REPORT_SCHEMA_VERSION),
  reportId: z.string().min(1),
  generatedAtMs: z.number().int().positive(),

  agent: z.object({
    goal: z.string().min(1),
    ensIdentity: z.string().nullable(),
    blueprintHash: z.string().min(1),
    strategyHash: z.string().min(1),
    blueprintRevision: z.number().int().nonnegative(),
  }),

  execution: z.object({
    networks: z.array(z.object({ chainId: z.number(), name: z.string(), role: z.string() })).min(1),
    /** The claim the whole product rests on. A literal, so no report can say anything else. */
    productionChainExecution: z.literal("DISABLED"),
    productionWriteEvidence: z.array(z.string()).min(1),
  }),

  reality: z.object({
    sources: z.array(z.object({ sourceId: z.string(), kind: z.string(), trustClass: z.string(), status: z.string(), blocker: z.string().nullable() })),
    chainlinkSource: z.string().nullable(),
    theGraphState: z.string().min(1),
    archiveReplayState: z.string().min(1),
    marketSnapshotHash: z.string().nullable(),
    anchorBlock: z.string().nullable(),
  }),

  cre: z.object({
    mode: z.string().min(1),
    executionMode: z.string().min(1),
    wasmHash: z.string().nullable(),
    productionLimits: z.string().min(1),
    donDeployment: z.enum(["YES", "NO"]),
    hardwareTee: z.enum(["YES", "NO"]),
    teeAttestation: z.enum(["YES", "NO"]),
    deployAccess: z.string().min(1),
  }),

  runtime: z.object({ imageDigest: z.string().nullable(), adapterVersions: z.array(z.string()) }),

  testing: z.object({
    securitySimulations: z.object({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
    attacks: z.array(z.object({ scenario: z.string(), result: z.string(), stoppedBy: z.string().nullable(), reasonCode: z.string().nullable() })),
  }),

  deployments: z.array(z.object({ name: z.string(), address: z.string(), chainId: z.number(), txHash: z.string(), explorerUrl: z.string().nullable() })),

  privacy: z.array(PrivacyClaimSchema).min(6),

  knownBlockers: z.array(z.object({ id: z.string(), effect: z.string() })),

  reportHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type SafetyReport = z.infer<typeof SafetyReportSchema>;

/* ─────────────────────────── the secret scan ─────────────────────────── */

/**
 * Patterns that must never appear in an exported report.
 *
 * Two classes, and both matter. Named credential fields catch a config object that travelled by
 * accident; the shape patterns catch a value under a name nobody thought to list — which is the way
 * a key actually escapes.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "private key", pattern: /\b0x[0-9a-fA-F]{64}\b/ },
  { name: "OpenAI key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i },
  { name: "CRE session file", pattern: /\.cre\/cre\.ya?ml/ },
  { name: "mnemonic", pattern: /\b(?:[a-z]{3,8}\s+){11,}[a-z]{3,8}\b/ },
  { name: "The Graph API key", pattern: /gateway\.thegraph\.com\/api\/[0-9a-f]{16,}/ },
  { name: "Alchemy/Infura key", pattern: /(?:alchemy|infura)\.[a-z]+\/v\d\/[A-Za-z0-9_-]{20,}/i },
];

/**
 * Scan before export.
 *
 * A transaction hash is 32 bytes and matches the private-key pattern exactly, so the scan is run
 * against the report with its known-hash fields removed rather than against the raw text — otherwise
 * it would either fire on every deployment receipt or be relaxed until it fired on nothing.
 */
export function scanForSecrets(report: SafetyReport): Array<{ name: string; where: string }> {
  const hits: Array<{ name: string; where: string }> = [];

  const walk = (value: unknown, path: string[]): void => {
    if (typeof value === "string") {
      /*
       * Fields that legitimately hold 32 bytes of hex.
       *
       * `explorerUrl` is here because it CONTAINS a transaction hash by construction — a scan that
       * fired on every deployment receipt would be relaxed until it fired on nothing. The exemption
       * is by named field rather than by pattern, so it stays narrow and visible.
       */
      const isKnownHashField = /^(txHash|blueprintHash|strategyHash|wasmHash|reportHash|marketSnapshotHash|imageDigest|anchorBlock|explorerUrl|address)$/.test(path[path.length - 1] ?? "");
      for (const { name, pattern } of SECRET_PATTERNS) {
        if (name === "private key" && isKnownHashField) continue;
        if (pattern.test(value)) hits.push({ name, where: path.join(".") });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...path, String(i)]));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, [...path, k]);
    }
  };

  walk(report, []);
  return hits;
}

export function assertReportSecretFree(report: SafetyReport): void {
  // The CRE session gets its own check, because its failure mode is a field name rather than a shape.
  assertNoCreSession(report, "safety report");

  const hits = scanForSecrets(report);
  if (hits.length > 0) {
    throw new SafetyReportError(
      REPORT_REASONS.SECRET_PRESENT,
      `${hits.map((h) => `${h.name} at ${h.where}`).join("; ")}. The report is not exported.`,
    );
  }
}

/* ─────────────────────────── hashing and sealing ─────────────────────────── */

export function computeReportHash(report: Omit<SafetyReport, "reportHash">): string {
  // Stable key order, so the same report hashes the same however it was assembled.
  const canonical = JSON.stringify(report, Object.keys(report).sort());
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * Seal a report: validate, check the privacy claims, scan for secrets, hash.
 *
 * The scan runs before the hash so a report that fails it never acquires an identity — there is no
 * hash of a rejected report to quote later.
 */
export function sealSafetyReport(input: Omit<SafetyReport, "reportHash" | "schemaVersion">): SafetyReport {
  /*
   * Scan the RAW input, before the schema parses it.
   *
   * The schema strips unknown keys, so a caller passing a session token would have it silently
   * dropped — safe, and silent. Nobody learns they tried to export a credential, and the next
   * caller tries the same thing. Checking first turns a quiet strip into a loud refusal.
   *
   * The strip is still there underneath, and `LAB-047g` covers it: two independent guards.
   */
  assertNoCreSession(input, "safety report input");

  const body = { ...input, schemaVersion: SAFETY_REPORT_SCHEMA_VERSION } as Omit<SafetyReport, "reportHash">;
  assertPrivacyClaimsEvidenced(body.privacy);

  const sealed = SafetyReportSchema.parse({ ...body, reportHash: computeReportHash(body) });
  assertReportSecretFree(sealed);
  return Object.freeze(sealed);
}

/* ─────────────────────────── public view ─────────────────────────── */

/**
 * What a public viewer receives.
 *
 * §P28.52 lists what they must not get, and the safe way to honour that list is not to filter the
 * private report — a filter is a deny-list, and a field added later is public by default. This
 * builds a new object from an allow-list of fields, so a new field is private until someone adds it
 * here on purpose.
 */
export interface PublicSafetyView {
  schemaVersion: typeof SAFETY_REPORT_SCHEMA_VERSION;
  reportId: string;
  agent: { goal: string; ensIdentity: string | null; blueprintHash: string };
  execution: { networks: SafetyReport["execution"]["networks"]; productionChainExecution: "DISABLED" };
  cre: { mode: string; donDeployment: "YES" | "NO"; hardwareTee: "YES" | "NO" };
  testing: SafetyReport["testing"];
  privacy: PrivacyClaim[];
  reportHash: string;
}

/** Fields a public view must never carry. Enumerated so their absence is testable. */
export const PUBLIC_VIEW_FORBIDDEN = [
  "controlCommands", "privatePolicies", "credentialRefs", "privateApiOutputs",
  "infrastructureAddresses", "secretConfiguration", "localBridge", "deployments", "runtime", "reality",
] as const;

export function publicSafetyView(report: SafetyReport): PublicSafetyView {
  return {
    schemaVersion: report.schemaVersion,
    reportId: report.reportId,
    agent: { goal: report.agent.goal, ensIdentity: report.agent.ensIdentity, blueprintHash: report.agent.blueprintHash },
    execution: { networks: report.execution.networks, productionChainExecution: report.execution.productionChainExecution },
    cre: { mode: report.cre.mode, donDeployment: report.cre.donDeployment, hardwareTee: report.cre.hardwareTee },
    testing: report.testing,
    privacy: [...report.privacy],
    reportHash: report.reportHash,
  };
}

/** Summarise attack runs for the report, keeping the stopping layer. */
export function attacksForReport(runs: ReadonlyArray<AttackRun>): SafetyReport["testing"]["attacks"] {
  return runs.map((r) => ({ scenario: r.scenario, result: r.result, stoppedBy: r.stoppedBy, reasonCode: r.reasonCode }));
}

export { CreLabError };
