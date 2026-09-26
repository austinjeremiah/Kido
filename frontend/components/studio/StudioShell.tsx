'use client';

/**
 * Assembles the workbench live-state envelope from the backend and renders the shell.
 *
 * The shell only consumes typed data. Everything here is a projection of what the project context
 * already read — the Lab lifecycle, the build, the fork deployment and the control-plane overview —
 * so the title bar, the badges and the status bar cannot disagree with the page beneath them.
 */
import { useMemo, type ReactNode } from 'react';
import { Workbench, type WorkbenchLiveState } from './shell/Workbench';
import type { NavBadge } from './shell/LeftWorkbench';
import { useStudioProject } from '@/lib/studio/api/project-context';
import { useProjects, useRuntime } from '@/lib/kido/hooks';
import { STAGE_LABEL } from '@/lib/kido/format';
import type { Project, ProjectSummary, Status } from '@/lib/studio/types';

/** A shell for the Composer before the project has loaded. */
function draftProject(id: string): Project {
  return {
    id, name: 'New agent', description: 'Describe the agent to create the project.', agentCount: 1, lifecycle: 'DRAFT', lastRevision: null,
    executionNetwork: 'Not chosen yet', creMode: 'NONE', updatedAt: new Date(0).toISOString(), alerts: 0, organization: null,
    agents: [{
      id: 'draft', name: 'New agent', slug: 'agent', role: 'Not designed yet', objective: '', status: 'RUNNING', executionClass: 'WRITE_CAPABLE',
      ensName: '—', ensNode: '', address: '', allowedAdapters: [], budget: { autonomousPerAction: 0, windowLimit: 0, windowUsed: 0, window: 'per action' },
      orgBudgetImpact: 0, policyHash: '', runtimeRevision: null, parentId: null, projectId: null, buildId: null,
    }],
    revisions: { requirements: null, blueprint: null, blueprintDraft: null, strategy: null, build: null, deployment: null, runtime: null, policy: null, creArtifactHash: null },
    environment: { executionNetwork: 'Not chosen yet', executionChainId: 11155111, realitySource: 'Testnet', realityMode: 'LIVE_MAINNET_MIRROR', mainnetWrites: 'PROHIBITED', creMode: 'NONE', label: 'TESTNET LAB' },
    blockers: [],
  };
}

export function StudioShell({ children }: { children: ReactNode }) {
  const ctx = useStudioProject();
  const list = useProjects();
  const runtime = useRuntime(ctx.isDraft ? null : ctx.routeProjectId, ctx.kido?.stage === 'BUILT');

  const projects = useMemo<ProjectSummary[]>(
    () =>
      (list.data ?? []).map((p) => ({
        id: p.projectId, name: p.name, description: p.objective, agentCount: Math.max(1, p.agents.length), lifecycle: p.stage === 'BUILT' ? 'BUILT' : p.stage === 'INTERVIEW' ? 'DRAFT' : 'BUILDING',
        lastRevision: p.revision, executionNetwork: p.chains.join(' + ') || '—', creMode: 'NONE', updatedAt: new Date(p.createdAt).toISOString(), alerts: 0, organization: null,
      })),
    [list.data],
  );

  const project = ctx.project ?? draftProject(ctx.routeProjectId);

  const live = useMemo<WorkbenchLiveState>(() => {
    const s = ctx.kido;
    const navBadges: Record<string, NavBadge[]> = {};
    const blocking = s?.security?.findings.filter((f) => f.blocking).length ?? 0;
    const failed = s?.simulation?.results.filter((r) => !r.passed).length ?? 0;
    if (s?.blockers.length) navBadges.blueprint = [{ label: `${s.blockers.length}`, tone: 'deny', title: `${s.blockers.length} build blocker(s)` }];
    if (blocking) navBadges.security = [{ label: `${blocking}`, tone: 'deny', title: `${blocking} blocking finding(s)` }];
    else if (s?.security?.freshness === 'STALE') navBadges.security = [{ label: 'STALE', tone: 'warn', title: 'The review predates the current revision' }];
    if (failed) navBadges.simulation = [{ label: `${failed}`, tone: 'deny', title: `${failed} failing scenario(s)` }];
    else if (s?.simulation?.freshness === 'STALE') navBadges.simulation = [{ label: 'STALE', tone: 'warn', title: 'The simulation predates the current revision' }];
    else if (s?.simulation?.passed) navBadges.simulation = [{ label: 'PASS', tone: 'pass', title: 'Every scenario behaved as expected' }];
    if (s?.stage === 'BUILT') navBadges.deploy = [{ label: 'READY', tone: 'pass', title: 'Built; ready to deploy' }];
    const buildStatus = s
      ? { label: `${STAGE_LABEL[s.stage]}${s.revision !== null ? ` · r${s.revision}` : ''}`, status: s.stage === 'BUILT' ? 'PASS' : blocking || failed || s.blockers.length ? 'FAIL' : 'RUNNING' }
      : { label: ctx.isDraft ? 'No project yet' : 'Loading', status: 'UNKNOWN' };
    return {
      policyState: (s?.stage === 'BUILT' ? 'READY' : 'UNKNOWN') as Status,
      policyFreshness: { source: 'kido api', observedAt: new Date().toISOString(), ttlSeconds: 30, state: 'FRESH' } as WorkbenchLiveState['policyFreshness'],
      runtimeState: (!runtime.data?.deployed
        ? 'STOPPED'
        : runtime.data.chains.some((c) => c.paused)
          ? 'PAUSED'
          : runtime.data.status === 'ACTIVE' && runtime.data.chains.every((c) => c.leaseStatus === 1)
            ? 'READY'
            : 'DEGRADED') as Status,
      creStatus: 'UNKNOWN' as Status,
      syncSeconds: 0,
      buildStatus,
      navBadges,
      events: [],
      problemCount: ctx.problems.length,
    };
  }, [ctx, runtime.data]);

  return (
    <Workbench project={project} projects={projects} live={live}>
      {children}
    </Workbench>
  );
}
