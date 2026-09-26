'use client';

/** Identity: the agent's planned public names. Names are discovery; they never grant authority. */
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, Card, EmptyState, KeyValue } from '@/components/studio/primitives';
import { NotYet, WithProject } from '@/components/studio/kido';
import { useRegistry } from '@/lib/kido/hooks';
import { chainLabel } from '@/lib/kido/format';

export default function IdentityPage() {
  const reg = useRegistry();
  const status = (id: string) => reg.data?.find((p) => p.providerId === id)?.implementation.status ?? '—';
  return (
    <StudioPage segment="identity">
      <WithProject>
        {(s) => {
          if (!s.blueprint) return <NotYet what="identity plan" where="composer" id={s.projectId} />;
          const plan = s.identityPlan;
          if (!plan.length) return <EmptyState title="No public identity" body="This agent was designed without a public name. Edit identity.public in the Composer to add one." />;
          return (
            <div className="cl-stack" style={{ gap: 16 }}>
              <Card title="KidoAgentId">
                <p className="cl-mono" style={{ margin: 0 }}>{s.kidoAgentId}</p>
                <p className="cl-meta">One id; each name below is a binding to it. Neither name is the root identity.</p>
              </Card>
              {plan.map((b) => (
                <Card key={`${b.providerId}${b.chain}`} title={b.name} actions={<Badge tone={status(String(b.providerId)) === 'TESTNET_LIVE' ? 'pass' : 'blocked'}>{String(b.providerId).toUpperCase()} · {status(String(b.providerId))}</Badge>}>
                  <KeyValue rows={[{ label: 'Chain', value: chainLabel(b.chain) }, { label: 'Parent', value: String(b.parent ?? '—') }, { label: 'Label', value: String(b.label ?? '—') }, { label: 'State', value: 'Planned; published when the agent is deployed' }]} />
                </Card>
              ))}
            </div>
          );
        }}
      </WithProject>
    </StudioPage>
  );
}
