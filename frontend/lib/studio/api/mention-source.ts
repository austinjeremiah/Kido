'use client';

/**
 * The @mention surface, from what the Kido project currently holds: its agents, the providers it
 * binds, its simulation scenarios and its open problems. Nothing secret is ever mentionable.
 */
import { useMemo } from 'react';
import { useStudioProject } from './project-context';
import type { MentionSource } from '../mentions';

export function useMentionSource(): MentionSource {
  const ctx = useStudioProject();
  return useMemo<MentionSource>(() => {
    const s = ctx.kido;
    const bp = s?.blueprint ?? null;
    return {
      agents: ctx.agents,
      policy: bp ? { version: bp.revision, observed: s?.stage === 'BUILT' ? 'BUILT' : 'DRAFT', network: bp.chains.join(' + ') } : null,
      adapters: (bp?.protocols ?? []).map((p) => ({ id: `${p.providerId}:${p.chain}`, adapterId: p.providerId, name: p.providerId, trustClass: String(p.chain), status: 'SELECTED' })),
      scenarios: (s?.simulation?.results ?? []).map((r) => ({ id: r.id, name: r.id, group: r.family, result: r.passed ? 'PASS' : 'FAIL' })),
      attacks: [],
      deployments: [],
      events: [],
      alerts: [],
      files: [],
      problems: ctx.problems,
    };
  }, [ctx]);
}
