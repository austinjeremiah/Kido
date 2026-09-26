import { createHash } from "node:crypto";

/**
 * Adapter artifact hashing.
 *
 * A Blueprint pins `adapterId@version`. That is necessary and not sufficient: a version is a label
 * an author controls, and republishing different code under the same version is both possible and
 * — for anyone trying to slip past a review that happened once — the obvious move.
 *
 * So the Blueprint also pins an `artifactHash` over the adapter's actual files. If the code changes
 * without the version changing, resolution fails with `ADAPTER_ARTIFACT_MISMATCH` rather than
 * quietly running something nobody approved.
 */

export const ARTIFACT_REASONS = {
  MISMATCH: "ADAPTER_ARTIFACT_MISMATCH",
  MISSING_FILE: "ADAPTER_ARTIFACT_MISSING_FILE",
  EMPTY: "ADAPTER_ARTIFACT_EMPTY",
} as const;
export type ArtifactReason = (typeof ARTIFACT_REASONS)[keyof typeof ARTIFACT_REASONS];

export interface ArtifactFile {
  /** Package-relative path, forward slashes. */
  path: string;
  content: string;
}

/**
 * Hash a set of files.
 *
 * Sorted by path and length-prefixed. The length prefix is what stops two different file sets
 * hashing the same: without it, `{a: "xy"}` and `{ax: "y"}` concatenate identically.
 */
export function artifactHash(files: ArtifactFile[]): string {
  if (files.length === 0) throw new Error(`${ARTIFACT_REASONS.EMPTY}: an adapter with no files has nothing to pin`);
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`${f.path.length}:${f.path}\n${Buffer.byteLength(f.content, "utf8")}:`);
    h.update(f.content, "utf8");
    h.update("\n");
  }
  return `sha256:${h.digest("hex")}`;
}

export interface PinnedAdapter {
  adapterId: string;
  version: string;
  artifactHash: string;
}

export type ArtifactVerdict =
  | { ok: true }
  | { ok: false; reason: ArtifactReason; detail: string };

/**
 * Check installed files against what a Blueprint pinned.
 *
 * Deliberately compares the hash rather than the version: a matching version with different code is
 * exactly the case this exists for, and it is the case a semver check reports as fine.
 */
export function verifyArtifact(pinned: PinnedAdapter, installed: ArtifactFile[]): ArtifactVerdict {
  let actual: string;
  try {
    actual = artifactHash(installed);
  } catch (e) {
    return { ok: false, reason: ARTIFACT_REASONS.EMPTY, detail: (e as Error).message };
  }
  if (actual !== pinned.artifactHash) {
    return {
      ok: false,
      reason: ARTIFACT_REASONS.MISMATCH,
      detail: `${pinned.adapterId}@${pinned.version} pinned ${pinned.artifactHash} but the installed files hash to ${actual}. Same version, different code.`,
    };
  }
  return { ok: true };
}
