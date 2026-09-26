'use client';

/** Activity: every deployment step and owner control recorded for this agent, with transactions. */
import { StudioPage } from '@/components/studio/PageScaffold';
import { Card, EmptyState, Skeleton } from '@/components/studio/primitives';
import { WithProject } from '@/components/studio/kido';
import { useActivity } from '@/lib/kido/hooks';
import { chainLabel, explorerTx } from '@/lib/kido/format';

function Events({ id }: { id: string }) {
  const q = useActivity(id);
  if (q.isLoading) return <Skeleton height={80} />;
  const events = [...(q.data ?? [])].reverse();
  if (!events.length) return <EmptyState title="No activity yet" body="Deployment steps and owner controls appear here." />;
  return (
    <Card title={`${events.length} event${events.length === 1 ? '' : 's'}`}>
      <table className="cl-table">
        <thead>
          <tr><th>When</th><th>Event</th><th>Chain</th><th>Detail</th><th>Transaction</th></tr>
        </thead>
        <tbody>
          {events.map((e, i) => (
            <tr key={`${e.at}-${i}`}>
              <td>{new Date(e.at).toLocaleString()}</td>
              <td className="cl-mono">{e.type}</td>
              <td>{e.chain ? chainLabel(e.chain) : '—'}</td>
              <td>{e.detail}</td>
              <td>{e.tx && e.chain ? <a href={explorerTx(e.chain, e.tx)} target="_blank" rel="noreferrer">{e.tx.slice(0, 10)}…</a> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export default function ActivityPage() {
  return (
    <StudioPage segment="activity">
      <WithProject>{(s) => <Events id={s.projectId} />}</WithProject>
    </StudioPage>
  );
}
