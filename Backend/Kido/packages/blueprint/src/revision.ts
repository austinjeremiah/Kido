import { blueprintHash } from "./hash.js";
import { BlueprintSchema, type KidoAgentBlueprint, type RequirementResolution } from "./schema.js";

export class ConfirmedRequirementError extends Error {
  constructor(readonly key: string) {
    super(`requirement ${key} is confirmed; only an explicit user edit may change it`);
    this.name = "ConfirmedRequirementError";
  }
}

export type ResolutionUpdate = { resolution: RequirementResolution; explicitUserEdit?: boolean };

/**
 * Applies requirement updates and produces the next revision. A confirmed resolution can only be
 * replaced by an explicit user edit; a model re-run proposing a different value is refused, so
 * re-running the model can never silently change a confirmed critical requirement (bible §9.2).
 */
export function applyResolutions(bp: KidoAgentBlueprint, updates: ResolutionUpdate[]): KidoAgentBlueprint {
  const byKey = new Map(bp.requirements.map((r) => [r.key, r]));
  for (const { resolution, explicitUserEdit } of updates) {
    const existing = byKey.get(resolution.key);
    if (existing?.confirmed && !explicitUserEdit) {
      const same = JSON.stringify(existing.value) === JSON.stringify(resolution.value) && existing.status === resolution.status;
      if (!same) throw new ConfirmedRequirementError(resolution.key);
      continue;
    }
    byKey.set(resolution.key, resolution);
  }
  const edited = updates.filter((u) => u.explicitUserEdit).map((u) => u.resolution.key);
  return nextRevision(bp, { requirements: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)) }, { allowConfirmedChange: edited });
}

/** Every change is a new, immutable revision that commits to its parent. */
export function nextRevision(bp: KidoAgentBlueprint, patch: Partial<KidoAgentBlueprint>, opts: { allowConfirmedChange?: string[] } = {}): KidoAgentBlueprint {
  if (patch.requirements) {
    // Confirmed requirements survive every revision unless the user explicitly edited them (BREAK F-0524).
    const allow = new Set(opts.allowConfirmedChange ?? []);
    const after = new Map(patch.requirements.map((r) => [r.key, r]));
    for (const r of bp.requirements) {
      if (!r.confirmed || allow.has(r.key)) continue;
      const n = after.get(r.key);
      if (!n || JSON.stringify(n.value) !== JSON.stringify(r.value) || n.status !== r.status) throw new ConfirmedRequirementError(r.key);
    }
  }
  const next = { ...bp, ...patch, revision: bp.revision + 1, parentRevisionHash: blueprintHash(bp) };
  return BlueprintSchema.parse(next);
}

export interface RevisionBound {
  projectId: string;
  blueprintRevision: number;
  blueprintHash: string;
}

/** An artifact built from another revision is stale and must never be shown as current. */
export function isStale(artifact: RevisionBound, bp: KidoAgentBlueprint): boolean {
  return artifact.projectId !== bp.projectId || artifact.blueprintRevision !== bp.revision || artifact.blueprintHash !== blueprintHash(bp);
}

export function bindTo(bp: KidoAgentBlueprint): RevisionBound {
  return { projectId: bp.projectId, blueprintRevision: bp.revision, blueprintHash: blueprintHash(bp) };
}
