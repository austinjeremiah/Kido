import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";
import type { StudioTemplate, TemplateFile } from "./types.js";
import {
  contextlockCoreTemplate,
  ensIdentityTemplate,
  creConfidentialPolicyTemplate,
  ledgerKeyRingTemplate,
  ledgerEscalationTemplate,
} from "./modules/core.js";
import { protocolAdapterTemplate, agentRuntimeTemplate, testsTemplate } from "./modules/agent.js";
import { renderAdapter, renderAdapterKernel } from "./adapters/index.js";

export * from "./types.js";

export const TEMPLATES: StudioTemplate[] = [
  contextlockCoreTemplate,
  ensIdentityTemplate,
  creConfidentialPolicyTemplate,
  ledgerKeyRingTemplate,
  ledgerEscalationTemplate,
  protocolAdapterTemplate,
  agentRuntimeTemplate,
  testsTemplate,
];

export function templateFor(moduleKind: string): StudioTemplate | undefined {
  return TEMPLATES.find((t) => t.moduleKind === moduleKind);
}

/**
 * Render every module the Blueprint declares.
 *
 * Only declared modules are rendered, so the generated tree and the architecture graph are the same
 * list of components by construction — and `validateBlueprintArtifacts` then checks that they
 * really are, rather than trusting this function.
 */
export function renderProject(bp: ContextLockAgentBlueprint): TemplateFile[] {
  const files: TemplateFile[] = [];
  const seen = new Set<string>();

  /*
   * Adapter modules first, and generically. The renderer reads the Blueprint's bindings; it has no
   * knowledge of which providers exist. A new provider is a new manifest, never a new branch here.
   */
  if (bp.adapters.length > 0) {
    for (const f of renderAdapterKernel()) {
      seen.add(f.path);
      files.push(f);
    }
    for (const b of bp.adapters) {
      const req = bp.dataRequirements.find((r) => r.key === b.configRef);
      for (const f of renderAdapter({
        adapterId: b.adapterId,
        adapterVersion: b.adapterVersion,
        role: b.role,
        configRef: b.configRef,
        config: { adapterId: b.adapterId },
        ...(req
          ? {
              requirement: {
                kind: req.kind,
                minimumTrustClass: req.minimumTrustClass,
                maxAgeMs: req.maxAgeMs,
                unit: req.unit,
                confidential: req.confidential,
                fallback: req.fallback,
              },
            }
          : {}),
      })) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        files.push(f);
      }
    }
  }

  for (const mod of bp.generatedModules) {
    const tpl = templateFor(mod.kind);
    if (!tpl) continue;
    for (const f of tpl.render(bp)) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      files.push(f);
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export * from "./adapters/index.js";
