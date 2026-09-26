'use client';

/**
 * The project every workbench page reads, loaded from the Kido backend.
 *
 * One request (`GET /api/projects/:id`) returns the whole lifecycle state: interview, blueprint,
 * security review, simulation and build. The shell's view models (`Project`, `Agent`, problems,
 * tests) are projections of that summary, so the title bar, badges and status bar cannot disagree
 * with the page beneath them. Fields that belonged to the earlier studio backend are kept on the
 * interface as null so shell components compile unchanged; Kido pages read `kido`.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import type { Agent, ProblemItem, Project, Severity, TestResult } from '../types';
import type { LogLine } from '../log';
import type { StudioEvent } from './events';
import { useDeployment, useProject } from '@/lib/kido/hooks';
import type { DeploymentWire, ProjectSummary } from '@/lib/kido/types';
import { chainLabel } from '@/lib/kido/format';

export const DRAFT_PROJECT_ID = 'new';

export interface StudioProjectValue {
  routeProjectId: string;
  isDraft: boolean;
  isOrganization: boolean;
  project: Project | null;
  agents: Agent[];
  agent: Agent | null;
  dataProjectId: string | null;
  buildId: string | null;
  /** The Kido project summary; null while loading or for the draft route. */
  kido: ProjectSummary | null;
  row: null;
  organization: null;
  orgView: null;
  buildView: null;
  labState: null;
  deployment: null;
  deploymentId: string | null;
  overview: null;
  problems: ProblemItem[];
  tests: TestResult[];
  buildLog: LogLine[];
  buildEvents: StudioEvent[];
  loading: boolean;
  error: string | null;
  refetchProject: () => void;
}

const Ctx = createContext<StudioProjectValue | null>(null);

export function useStudioProject(): StudioProjectValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStudioProject must be used inside <StudioProjectProvider>');
  return v;
}

const LIFECYCLE: Record<ProjectSummary['stage'], Project['lifecycle']> = { INTERVIEW: 'DRAFT', BLUEPRINT: 'BUILDING', REVIEWED: 'BUILDING', SIMULATED: 'BUILDING', BUILT: 'BUILT' };

function projectOf(s: ProjectSummary, dep: DeploymentWire | null = null): Project {
  const bp = s.blueprint;
  const network = bp?.chains.map(chainLabel).join(' + ') || 'Not chosen yet';
  const agents: Agent[] = (bp?.agents.length ? bp.agents : [{ role: 'agent', owns: [], mayRequest: [], knowledgePacks: [] }]).map((a, i) => ({
    id: `${s.projectId}:${a.role}`,
    name: i === 0 ? s.name : a.role,
    slug: a.role,
    role: a.role,
    objective: bp?.objective.summary ?? s.objective,
    status: s.stage === 'BUILT' ? 'READY' : 'RUNNING',
    executionClass: bp && bp.authority.allowedActions.length === 0 ? 'READ_ONLY' : 'WRITE_CAPABLE',
    ensName: bp?.identity.bindings.find((b) => b.provider === 'ens')?.name ?? '—',
    ensNode: '',
    address: '',
    allowedAdapters: a.owns,
    budget: { autonomousPerAction: 0, windowLimit: 0, windowUsed: 0, window: 'per action' },
    orgBudgetImpact: 0,
    policyHash: s.blueprintHash ?? '',
    runtimeRevision: s.build?.buildRevision ?? null,
    parentId: null,
    projectId: s.projectId,
    buildId: null,
  }));
  return {
    id: s.projectId,
    name: s.name,
    description: s.objective,
    agentCount: agents.length,
    lifecycle: LIFECYCLE[s.stage],
    lastRevision: s.revision,
    executionNetwork: network,
    creMode: 'NONE',
    updatedAt: new Date(s.build?.generatedAt ?? s.simulation?.generatedAt ?? s.security?.generatedAt ?? s.createdAt).toISOString(),
    alerts: 0,
    organization: null,
    agents,
    revisions: { requirements: s.interview.questionsAsked, blueprint: s.revision, blueprintDraft: null, strategy: null, build: s.build?.buildRevision ?? null, deployment: dep?.blueprintRevision ?? null, runtime: dep?.status === 'ACTIVE' ? dep.blueprintRevision : null, policy: null, creArtifactHash: null },
    environment: { executionNetwork: network, executionChainId: 11155111, realitySource: 'Testnet', realityMode: 'LIVE_MAINNET_MIRROR' as Project['environment']['realityMode'], mainnetWrites: 'PROHIBITED', creMode: 'NONE', label: 'TESTNET LAB' },
    blockers: s.blockers.map((b, i) => ({ id: `${b.code}-${i}`, title: b.code, detail: b.detail, severity: 'HIGH' as Severity, surface: 'blueprint' as Project['blockers'][number]['surface'], actionLabel: 'Open the composer', actionHref: `/projects/${s.projectId}/build` })),
  };
}

function problemsOf(s: ProjectSummary): ProblemItem[] {
  const base = `/projects/${s.projectId}`;
  return [
    ...s.blockers.map((b, i) => ({ id: `blocker-${i}`, severity: 'HIGH' as Severity, message: b.code, detail: b.detail, resource: 'blueprint', href: `${base}/blueprint` })),
    ...(s.security?.findings ?? []).filter((f) => f.blocking || f.severity === 'CRITICAL' || f.severity === 'HIGH').map((f) => ({ id: f.id, severity: f.severity as Severity, message: `${f.id} · ${f.class}`, detail: f.evidence, resource: 'security review', href: `${base}/security` })),
    ...(s.simulation?.results ?? []).filter((r) => !r.passed).map((r) => ({ id: r.id, severity: 'HIGH' as Severity, message: `Scenario ${r.id} failed`, detail: `expected ${r.expected}, got ${r.actual}. ${r.note}`, resource: 'simulation', href: `${base}/simulation` })),
    ...(s.security?.freshness === 'STALE' ? [{ id: 'stale-review', severity: 'MEDIUM' as Severity, message: 'Security review is stale', detail: 'The blueprint changed after the last review; run it again.', resource: 'security review', href: `${base}/security` }] : []),
    ...(s.simulation?.freshness === 'STALE' ? [{ id: 'stale-sim', severity: 'MEDIUM' as Severity, message: 'Simulation is stale', detail: 'The blueprint changed after the last simulation; run it again.', resource: 'simulation', href: `${base}/simulation` }] : []),
  ];
}

function testsOf(s: ProjectSummary): TestResult[] {
  return (s.simulation?.results ?? []).map((r) => ({ id: r.id, suite: r.family, name: r.id, status: r.passed ? 'PASS' : 'FAIL', durationMs: 0, ...(r.passed ? {} : { failure: `expected ${r.expected}, got ${r.actual}${r.code ? ` (${r.code})` : ''}` }) }));
}

function logOf(s: ProjectSummary): LogLine[] {
  const time = new Date(s.createdAt).toLocaleTimeString();
  return s.interview.transcript.map((t): LogLine => ({ time, scope: t.role === 'kido' ? 'kido' : 'you', message: t.text, level: 'info' }));
}

export function StudioProjectProvider({ children }: { children: ReactNode }) {
  const params = useParams<{ projectId: string }>();
  const routeProjectId = params.projectId;
  const isDraft = routeProjectId === DRAFT_PROJECT_ID;
  const q = useProject(isDraft ? null : routeProjectId);
  const d = useDeployment(isDraft ? null : routeProjectId);

  const value = useMemo<StudioProjectValue>(() => {
    const s = q.data ?? null;
    const project = s ? projectOf(s, d.data?.deployment ?? null) : null;
    return {
      routeProjectId,
      isDraft,
      isOrganization: false,
      project,
      agents: project?.agents ?? [],
      agent: project?.agents[0] ?? null,
      dataProjectId: isDraft ? null : routeProjectId,
      buildId: null,
      kido: s,
      row: null,
      organization: null,
      orgView: null,
      buildView: null,
      labState: null,
      deployment: null,
      deploymentId: null,
      overview: null,
      problems: s ? problemsOf(s) : [],
      tests: s ? testsOf(s) : [],
      buildLog: s ? logOf(s) : [],
      buildEvents: [],
      loading: q.isLoading,
      error: q.error ? (q.error as Error).message : null,
      refetchProject: () => void q.refetch(),
    };
  }, [q.data, d.data, q.isLoading, q.error, routeProjectId, isDraft, q]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
