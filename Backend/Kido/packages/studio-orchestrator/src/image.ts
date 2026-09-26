import { z } from "zod";

/**
 * The runtime image artifact.
 *
 * P23 builds it; P24 runs it. The rule that connects them is that the DeploymentManifest pins a
 * DIGEST, and the digest is what the runtime provider is handed.
 *
 * A tag is a convenience label — a mutable pointer that can be moved by anyone with push access,
 * including by a later build of a different commit. Pinning a tag would mean the manifest describes
 * whatever that tag last pointed at, which is not necessarily what was reviewed, scanned or
 * approved. So the tag is carried for humans and never used to launch anything.
 */

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const VULN_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "NEGLIGIBLE", "UNKNOWN"] as const;
export const VulnSeveritySchema = z.enum(VULN_SEVERITIES);
export type VulnSeverity = z.infer<typeof VulnSeveritySchema>;

export const VulnerabilityReportSchema = z.object({
  /** Which scanner, and which version. A report with no provenance is an opinion. */
  scanner: z.string().min(1),
  scannerVersion: z.string().min(1),
  scannedAtMs: z.number().int().positive(),
  /** The digest scanned. If it is not the digest being deployed, the report is about another image. */
  imageDigest: sha256,
  counts: z.record(VulnSeveritySchema, z.number().int().nonnegative()),
  findings: z.array(z.object({ id: z.string(), severity: VulnSeveritySchema, package: z.string(), installedVersion: z.string(), fixedVersion: z.string().nullable() })),
  /**
   * True when the scan genuinely ran.
   *
   * A scanner that is not installed must not produce a report of zero findings — that is a green
   * light manufactured out of an absence. `ran: false` fails the gate.
   */
  ran: z.boolean(),
  unavailableReason: z.string().nullable(),
});
export type VulnerabilityReport = z.infer<typeof VulnerabilityReportSchema>;

export const ImagePolicySchema = z.object({
  /** Severities that block promotion. CRITICAL always; HIGH by default, configurable. */
  blockOn: z.array(VulnSeveritySchema),
  /** Specific advisory IDs a human has accepted, each with a reason and an expiry. */
  acceptedRisks: z.array(z.object({ id: z.string(), reason: z.string().min(1), acceptedBy: z.string().min(1), expiresAtMs: z.number().int().positive() })),
  requireSbom: z.boolean(),
  requireProvenance: z.boolean(),
  requireNonRoot: z.boolean(),
  requirePinnedBaseDigest: z.boolean(),
});
export type ImagePolicy = z.infer<typeof ImagePolicySchema>;

export const DEFAULT_IMAGE_POLICY: ImagePolicy = {
  blockOn: ["CRITICAL", "HIGH"],
  acceptedRisks: [],
  requireSbom: true,
  requireProvenance: true,
  requireNonRoot: true,
  requirePinnedBaseDigest: true,
};

export const RuntimeImageArtifactSchema = z.object({
  agentId: z.string().min(1),
  tag: z.string().min(1),
  imageDigest: sha256,
  /** The base image, pinned by digest. A base pinned by tag is an unpinned image with extra steps. */
  baseImageDigest: sha256,
  sbomDigest: sha256.nullable(),
  sbomFormat: z.string().nullable(),
  provenanceDigest: sha256.nullable(),
  provenanceFormat: z.string().nullable(),
  vulnerabilityReportDigest: sha256.nullable(),
  /** OCI labels, so a running container can be traced back to what produced it. */
  labels: z.object({
    "org.opencontainers.image.revision": z.string().min(1),
    "org.opencontainers.image.created": z.string().min(1),
    "com.contextlock.build-id": z.string().min(1),
    "com.contextlock.blueprint-hash": sha256,
    "com.contextlock.strategy-hash": sha256,
    "com.contextlock.agent-id": z.string().min(1),
  }),
  runsAsUser: z.string().min(1),
  runsAsRoot: z.boolean(),
  builtAtMs: z.number().int().positive(),
  /** How the attestations were produced, honestly. See RUNTIME_IMAGE.md and drift D-1. */
  attestationMethod: z.enum(["BUILDKIT_INTOTO_OCI", "EXTERNAL_SYFT", "NONE"]),
});
export type RuntimeImageArtifact = z.infer<typeof RuntimeImageArtifactSchema>;

export const IMAGE_REASONS = {
  VULNERABLE: "IMAGE-VULNERABILITY-GATE-FAILED",
  SCAN_NOT_RUN: "IMAGE-SCAN-NOT-RUN",
  SCAN_WRONG_DIGEST: "IMAGE-SCAN-DIGEST-MISMATCH",
  NO_SBOM: "IMAGE-SBOM-MISSING",
  NO_PROVENANCE: "IMAGE-PROVENANCE-MISSING",
  ROOT_USER: "IMAGE-RUNS-AS-ROOT",
  UNPINNED_BASE: "IMAGE-BASE-NOT-PINNED",
  DIGEST_MISMATCH: "IMAGE-DIGEST-DOES-NOT-MATCH-MANIFEST",
  EXPIRED_ACCEPTANCE: "IMAGE-RISK-ACCEPTANCE-EXPIRED",
} as const;
export type ImageReason = (typeof IMAGE_REASONS)[keyof typeof IMAGE_REASONS];

export class ImageGateError extends Error {
  constructor(readonly reason: ImageReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ImageGateError";
  }
}

/**
 * The promotion gate.
 *
 * Runs between building an image and publishing it. Everything it checks is a property the image
 * either has or does not, verified against the artifact rather than asserted by the build script.
 */
export function assertPromotable(
  artifact: RuntimeImageArtifact,
  report: VulnerabilityReport | null,
  policy: ImagePolicy = DEFAULT_IMAGE_POLICY,
  nowMs: number = Date.now(),
): void {
  if (policy.requireNonRoot && artifact.runsAsRoot) {
    throw new ImageGateError(IMAGE_REASONS.ROOT_USER, `${artifact.tag} runs as root; the runtime image must declare a non-root user`);
  }
  if (policy.requirePinnedBaseDigest && !/^sha256:[0-9a-f]{64}$/.test(artifact.baseImageDigest)) {
    throw new ImageGateError(IMAGE_REASONS.UNPINNED_BASE, `${artifact.tag} does not pin its base image by digest`);
  }
  if (policy.requireSbom && !artifact.sbomDigest) {
    throw new ImageGateError(IMAGE_REASONS.NO_SBOM, `${artifact.tag} has no SBOM`);
  }
  if (policy.requireProvenance && !artifact.provenanceDigest) {
    throw new ImageGateError(IMAGE_REASONS.NO_PROVENANCE, `${artifact.tag} has no build provenance attestation`);
  }

  if (!report) {
    throw new ImageGateError(IMAGE_REASONS.SCAN_NOT_RUN, `${artifact.tag} has not been scanned`);
  }
  if (!report.ran) {
    // The important case. A missing scanner produces an empty findings list, which looks identical
    // to a clean image unless "did it run?" is a field.
    throw new ImageGateError(
      IMAGE_REASONS.SCAN_NOT_RUN,
      `the vulnerability scan for ${artifact.tag} did not run (${report.unavailableReason ?? "no reason given"}); an unrun scan is not a clean scan`,
    );
  }
  if (report.imageDigest !== artifact.imageDigest) {
    throw new ImageGateError(
      IMAGE_REASONS.SCAN_WRONG_DIGEST,
      `the scan covers ${report.imageDigest} but the artifact is ${artifact.imageDigest}`,
    );
  }

  const accepted = new Map(policy.acceptedRisks.map((r) => [r.id, r]));
  const blocking = report.findings.filter((f) => policy.blockOn.includes(f.severity));
  const unaccepted: string[] = [];
  for (const f of blocking) {
    const a = accepted.get(f.id);
    if (!a) { unaccepted.push(`${f.severity} ${f.id} in ${f.package}@${f.installedVersion}${f.fixedVersion ? ` (fixed in ${f.fixedVersion})` : " (no fix available)"}`); continue; }
    if (a.expiresAtMs <= nowMs) {
      // An acceptance that never expires is a permanent exception nobody revisits.
      throw new ImageGateError(
        IMAGE_REASONS.EXPIRED_ACCEPTANCE,
        `the accepted risk for ${f.id} expired at ${new Date(a.expiresAtMs).toISOString()}; re-accept it explicitly or fix it`,
      );
    }
  }
  if (unaccepted.length > 0) {
    throw new ImageGateError(
      IMAGE_REASONS.VULNERABLE,
      `${artifact.tag} has ${unaccepted.length} unaccepted finding(s) at or above the blocking severity:\n  ${unaccepted.join("\n  ")}`,
    );
  }
}

/** The image the manifest pins must be the image that was built. */
export function assertDigestMatchesManifest(artifact: RuntimeImageArtifact, manifestDigest: string | null): void {
  if (manifestDigest === null) {
    throw new ImageGateError(IMAGE_REASONS.DIGEST_MISMATCH, `the manifest pins no digest for ${artifact.agentId}`);
  }
  if (artifact.imageDigest !== manifestDigest) {
    throw new ImageGateError(
      IMAGE_REASONS.DIGEST_MISMATCH,
      `manifest pins ${manifestDigest} for ${artifact.agentId}, but the built image is ${artifact.imageDigest}`,
    );
  }
}

/** An SBOM and provenance must describe the digest that is running, not a sibling build. */
export function assertAttestationsCorrespond(artifact: RuntimeImageArtifact, runningDigest: string): void {
  if (artifact.imageDigest !== runningDigest) {
    throw new ImageGateError(
      IMAGE_REASONS.DIGEST_MISMATCH,
      `the SBOM and provenance describe ${artifact.imageDigest}, but ${runningDigest} is running`,
    );
  }
}
