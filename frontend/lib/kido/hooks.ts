'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { kido } from './api';

export const keys = {
  projects: ['kido', 'projects'] as const,
  project: (id: string) => ['kido', 'project', id] as const,
  selfModel: (id: string) => ['kido', 'self-model', id] as const,
  registry: ['kido', 'registry'] as const,
  health: ['kido', 'health'] as const,
};

export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: kido.projects });
export const useProject = (id: string | null) => useQuery({ queryKey: keys.project(id ?? ''), queryFn: () => kido.project(id!), enabled: Boolean(id) });
export const useSelfModel = (id: string | null, enabled = true) =>
  useQuery({ queryKey: keys.selfModel(id ?? ''), queryFn: () => kido.selfModel(id!), enabled: Boolean(id) && enabled, retry: false });
export const useRegistry = () => useQuery({ queryKey: keys.registry, queryFn: kido.registry, staleTime: 60_000 });
export const useHealth = () => useQuery({ queryKey: keys.health, queryFn: kido.health });

/** A lifecycle step; every successful step refreshes the project and the list. */
export function useLifecycle(id: string) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.project(id) });
    void qc.invalidateQueries({ queryKey: keys.projects });
    void qc.invalidateQueries({ queryKey: keys.selfModel(id) });
  };
  const m = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => useMutation({ mutationFn: (a: A) => fn(...a), onSuccess: refresh });
  return {
    answer: m((text: string) => kido.answer(id, text)),
    edit: m((key: string, text: string) => kido.edit(id, key, text)),
    finalize: m(() => kido.finalize(id)),
    securityReview: m(() => kido.securityReview(id)),
    simulate: m(() => kido.simulate(id)),
    build: m(() => kido.build(id)),
    rename: m((name: string) => kido.rename(id, name)),
  };
}
