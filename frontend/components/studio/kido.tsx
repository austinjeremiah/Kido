'use client';

/**
 * Shared pieces for workbench pages backed by the Kido project summary: the page context, the
 * lifecycle gate buttons (each a backend gate whose refusal reason is shown verbatim) and the
 * "not yet" states for a project that has not reached a stage.
 */
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useStudioProject } from '@/lib/studio/api/project-context';
import { useLifecycle } from '@/lib/kido/hooks';
import type { ProjectSummary } from '@/lib/kido/types';
import { BlockerBanner, EmptyState, Skeleton } from './primitives';

export function useKido() {
  const ctx = useStudioProject();
  return { ctx, s: ctx.kido, id: ctx.routeProjectId, lifecycle: useLifecycle(ctx.routeProjectId) };
}

/** Renders children only once the project has loaded; otherwise a skeleton or the error. */
export function WithProject({ children }: { children: (s: ProjectSummary) => ReactNode }) {
  const { ctx, s } = useKido();
  if (ctx.isDraft) return <EmptyState title="No project yet" body="Create an agent first." action={<Link className="cl-btn cl-btn-primary" href="/new">Create an agent</Link>} />;
  if (ctx.error) return <BlockerBanner tone="deny" title="Could not load the project">{ctx.error}</BlockerBanner>;
  if (!s) return <Skeleton height={120} />;
  return <>{children(s)}</>;
}

/** "Nothing here until <stage>" with a link to where that stage happens. */
export function NotYet({ what, where, id }: { what: string; where: 'composer' | 'deploy'; id: string }) {
  return (
    <EmptyState
      title={`No ${what} yet`}
      body={where === 'composer' ? 'Finish the interview and run the lifecycle gates in the Composer.' : 'Deploy the built agent first.'}
      action={
        <Link className="cl-btn cl-btn-primary" href={`/projects/${id}/${where === 'composer' ? 'build' : 'deploy'}`}>
          {where === 'composer' ? 'Open the Composer' : 'Open Deploy'}
        </Link>
      }
    />
  );
}

type Gate = 'finalize' | 'securityReview' | 'simulate' | 'build';
const GATE_LABEL: Record<Gate, string> = { finalize: 'Compile blueprint', securityReview: 'Run security review', simulate: 'Run simulation', build: 'Build' };

/** One lifecycle gate as a button; a refusal shows the backend's reason under it. */
export function GateButton({ gate, primary, label }: { gate: Gate; primary?: boolean; label?: string }) {
  const { lifecycle } = useKido();
  const m = lifecycle[gate];
  const [err, setErr] = useState<string | null>(null);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        className={`cl-btn${primary ? ' cl-btn-primary' : ''}`}
        disabled={m.isPending}
        onClick={() => {
          setErr(null);
          m.mutate([] as never, { onError: (e) => setErr((e as Error).message) });
        }}
      >
        {m.isPending ? 'Working…' : (label ?? GATE_LABEL[gate])}
      </button>
      {err ? <span className="cl-meta" style={{ color: 'var(--cl-deny, #e5484d)', maxWidth: 360 }}>{err}</span> : null}
    </span>
  );
}

/** The next gate a project needs, derived from its summary (the backend enforces the order). */
export function nextGate(s: ProjectSummary): Gate | null {
  if (s.interview.question) return null;
  if (!s.blueprint) return 'finalize';
  if (!s.security || s.security.freshness !== 'CURRENT') return 'securityReview';
  if (s.security.blocking) return null;
  if (!s.simulation || s.simulation.freshness !== 'CURRENT') return 'simulate';
  if (!s.simulation.passed) return null;
  if (!s.build || s.build.freshness !== 'CURRENT') return 'build';
  return null;
}
