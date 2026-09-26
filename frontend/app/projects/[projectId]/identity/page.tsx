'use client';

/**
 * Identity: the agent's names as ENSv2 holds them on Sepolia — the published name tree with records
 * and multichain addresses, a verification of the agent from its name alone, and the live name whose
 * state Kido serves through CCIP-read. SuiNS names follow. Names are discovery; they never grant authority.
 */
import Link from 'next/link';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, Card, EmptyState, Skeleton } from '@/components/studio/primitives';
import { NotYet, WithProject } from '@/components/studio/kido';
import { LivePanel, NameTree, VerifyPanel, useIdentityLive } from '@/components/studio/EnsIdentity';
import { useRegistry } from '@/lib/kido/hooks';
import type { ProjectSummary } from '@/lib/kido/types';

function Body({ s }: { s: ProjectSummary }) {
  const live = useIdentityLive(s.projectId);
  const reg = useRegistry();
  const root = s.identityPlan.find((b) => b.providerId === 'ens' && !b.role);
  const suins = s.identityPlan.filter((b) => b.providerId === 'suins');
  const suinsProvider = reg.data?.find((p) => p.providerId === 'suins');
  const published = live.data?.names.find((n) => !n.role)?.published;
  const liveName = live.data?.names.find((n) => !n.role)?.records['kido-live'];
  return (
    <div className="cl-stack" style={{ gap: 16 }}>
      <Card title="KidoAgentId" actions={root ? <Link className="cl-btn cl-btn-sm" href={`/verify?name=${encodeURIComponent(root.name)}`}>Public verify page</Link> : null}>
        <p className="cl-mono" style={{ margin: 0 }}>{s.kidoAgentId}</p>
        <p className="cl-meta">One agent id; every name below is a binding to it, and its records say so. Authority comes from the Amane policy, never from a name.</p>
      </Card>
      {live.loading ? <Skeleton height={160} /> : live.error ? <p className="cl-meta" style={{ color: 'var(--cl-deny)' }}>{live.error}</p> : live.data ? <NameTree live={live.data} /> : null}
      {root && published ? <VerifyPanel name={root.name} /> : root ? <Card title="Not published yet"><p className="cl-meta" style={{ margin: 0 }}>Deploy the agent, then publish its names (scripts/identity-publish.ts) so they resolve to its accounts.</p></Card> : null}
      {liveName ? <LivePanel name={liveName} /> : null}
      {suins.length ? (
        <Card title="SuiNS" actions={<Badge tone="blocked">{suinsProvider?.implementation.status ?? 'planned'}</Badge>}>
          {suins.map((b) => <p key={b.name} className="cl-mono" style={{ margin: '2px 0' }}>{b.name}</p>)}
          <p className="cl-meta" style={{ whiteSpace: 'normal' }}>{suinsProvider?.implementation.blocker ? `${suinsProvider.implementation.blocker.actionRequired} (${suinsProvider.implementation.blocker.evidence})` : suinsProvider?.statusNote}</p>
        </Card>
      ) : null}
    </div>
  );
}

export default function IdentityPage() {
  return (
    <StudioPage segment="identity">
      <WithProject>
        {(s) => {
          if (!s.blueprint) return <NotYet what="identity plan" where="composer" id={s.projectId} />;
          if (!s.identityPlan.length) return <EmptyState title="No public identity" body="This agent was designed without a public name. Edit identity.public in the Composer to add one." />;
          return <Body s={s} />;
        }}
      </WithProject>
    </StudioPage>
  );
}
