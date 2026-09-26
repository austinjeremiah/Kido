import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";

export interface TemplateFile {
  path: string;
  content: string;
}

export interface StudioTemplate {
  id: string;
  version: number;
  /** Which Blueprint module kind this satisfies. */
  moduleKind: string;
  /**
   * True when the emitted file composes the audited ContextLock implementation instead of
   * reimplementing it. The Blueprint validator refuses a design where the core is regenerated.
   */
  reusesContextLockCore: boolean;
  render(bp: ContextLockAgentBlueprint): TemplateFile[];
}
