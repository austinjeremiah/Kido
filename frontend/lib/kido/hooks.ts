'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { kido } from './api';

export const keys = {
  projects: ['kido', 'projects'] as const,
  project: (id: string) => ['kido', 'project', id] as const,
  selfModel: (id: string) => ['kido', 'self-model', id] as const,
  registry: ['kido', 'registry'] as const,
  health: ['kido', 'health'] as const,
  deployment: (id: string) => ['kido', 'deployment', id] as const,
  runtime: (id: string) => ['kido', 'runtime', id] as const,
  activity: (id: string) => ['kido', 'activity', id] as const,
  reality: (id: string) => ['kido', 'reality', id] as const,
  portfolio: (id: string) => ['kido', 'portfolio', id] as const,
  context: (id: string, role: string) => ['kido', 'context', id, role] as const,
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

export const useDeployment = (id: string | null) => useQuery({ queryKey: keys.deployment(id ?? ''), queryFn: () => kido.deployment(id!), enabled: Boolean(id) });
export const useRuntime = (id: string | null, enabled = true) => useQuery({ queryKey: keys.runtime(id ?? ''), queryFn: () => kido.runtime(id!), enabled: Boolean(id) && enabled, refetchInterval: 15_000 });
export const useActivity = (id: string | null) => useQuery({ queryKey: keys.activity(id ?? ''), queryFn: () => kido.activity(id!), enabled: Boolean(id), refetchInterval: 10_000 });
export const useReality = (id: string | null) => useQuery({ queryKey: keys.reality(id ?? ''), queryFn: () => kido.reality(id ?? undefined), staleTime: 30_000, retry: false });
export const useAgentContext = (id: string | null, role: string | null) =>
  useQuery({ queryKey: keys.context(id ?? '', role ?? ''), queryFn: () => kido.context(id!, role!), enabled: Boolean(id && role), retry: false });
export const usePortfolio = (id: string | null) => useQuery({ queryKey: keys.portfolio(id ?? ''), queryFn: () => kido.portfolio(id!), enabled: Boolean(id), refetchInterval: 20_000, retry: false });
