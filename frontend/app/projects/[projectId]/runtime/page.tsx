'use client';

/**
 * Runtime: the agent's Amane accounts as the chains report them (policy version, pause state,
 * lease, balances), and the owner's controls. Pause needs one owner signature; revoking the lease
 * stops the agent key immediately. Both are signed in the owner's wallet.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, Card, EmptyState, KeyValue, Skeleton } from '@/components/studio/primitives';
import { WithProject } from '@/components/studio/kido';
import { useOwnerWallet } from '@/components/studio/kido-wallet';
import { useWalletSession } from '@/lib/studio/wallet-session';
import { kido } from '@/lib/kido/api';
import { keys, useRuntime } from '@/lib/kido/hooks';
import { LEASE_STATUS, chainLabel, explorerAccount } from '@/lib/kido/format';

function formatUnits(v: string, d: number) {
  const s = v.padStart(d + 1, '0');
  const frac = s.slice(-d).replace(/0+$/, '');
  return `${s.slice(0, s.length - d)}${frac ? `.${frac}` : ''}`;
}

function Controls({ id }: { id: string }) {
  const qc = useQueryClient();
  const w = useOwnerWallet();
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (op: 'pause' | 'revoke') => {
    setMsg(null);
    try {
      const prep = await kido.controlPrepare(id, op);
      const signed = [];
      for (const m of prep.messages) signed.push({ chain: m.chain, message: m.message, signature: await w.sign(m.typedData) });
      const r = await kido.controlSubmit(id, op, signed);
      if (r.transactions.length) await w.send(r.transactions, (tx, hash) => kido.recordTx(id, 'ethereum-sepolia', tx.label, hash).then(() => undefined));
      setMsg(op === 'pause' ? 'Paused.' : 'Lease revoked; the agent key can no longer act.');
    } catch (e) {
      setMsg((e as Error).message.split('\n')[0] ?? 'failed');
    } finally {
      void qc.invalidateQueries({ queryKey: keys.runtime(id) });
      void qc.invalidateQueries({ queryKey: keys.activity(id) });
    }
  };
  return (
    <Card title="Owner controls">
      <div className="cl-row" style={{ gap: 8 }}>
        <button type="button" className="cl-btn" onClick={() => run('pause')} disabled={!w.ready}>Pause the agent</button>
        <button type="button" className="cl-btn" onClick={() => run('revoke')} disabled={!w.ready}>Revoke its lease</button>
      </div>
      {msg ? <p className="cl-meta">{msg}</p> : null}
      <p className="cl-meta">Pausing stops every action until the owner signs an unpause. Revoking the lease removes the agent key's authority for good; a new lease is needed to resume.</p>
    </Card>
  );
}

export default function RuntimePage() {
  const { activated, requestConnect } = useWalletSession();
  return (
    <StudioPage segment="runtime">
      <WithProject>
        {(s) => <RuntimeBody id={s.projectId} activated={activated} requestConnect={requestConnect} />}
      </WithProject>
    </StudioPage>
  );
}

function RuntimeBody({ id, activated, requestConnect }: { id: string; activated: boolean; requestConnect: () => void }) {
  const rt = useRuntime(id);
  if (rt.isLoading) return <Skeleton height={120} />;
  if (rt.isError) return <EmptyState title="Runtime unavailable" body={(rt.error as Error).message} />;
  if (!rt.data?.deployed) return <EmptyState title="Not deployed" body="Deploy the built agent to create its Amane accounts." />;
  return (
    <div className="cl-stack" style={{ gap: 16 }}>
      <Card title="Account" actions={<Badge tone={rt.data.status === 'ACTIVE' ? 'pass' : 'data'}>{rt.data.status}</Badge>}>
        <KeyValue rows={[{ label: 'Account id', value: rt.data.accountId ?? '—', mono: true }, { label: 'Owner', value: rt.data.owner ?? '—', mono: true }, { label: 'Lease', value: rt.data.leaseId ?? '—', mono: true }]} />
      </Card>
      {rt.data.chains.map((c) => (
        <Card key={c.chain} title={chainLabel(c.chain)} actions={c.paused ? <Badge tone="warn">paused</Badge> : c.leaseStatus === 1 ? <Badge tone="pass">active</Badge> : <Badge tone="blocked">{LEASE_STATUS[c.leaseStatus ?? 0] ?? 'unknown'}</Badge>}>
          {c.error ? <p className="cl-meta">Could not read: {c.error}</p> : null}
          <KeyValue
            rows={[
              { label: 'Amane account', value: c.account ? <a href={explorerAccount(c.chain, c.account)} target="_blank" rel="noreferrer">{c.account}</a> : 'pending', mono: true },
              { label: 'Policy version', value: c.policyVersion ?? '—' },
              { label: 'Paused', value: c.paused === null ? '—' : c.paused ? `yes (epoch ${c.pauseEpoch})` : 'no' },
              { label: 'Lease', value: LEASE_STATUS[c.leaseStatus ?? 0] ?? '—' },
              ...c.balances.map((b) => ({ label: `Balance · ${b.symbol}`, value: formatUnits(b.amount, b.decimals) })),
            ]}
          />
        </Card>
      ))}
      {activated ? (
        <Controls id={id} />
      ) : (
        <Card title="Owner controls">
          <button type="button" className="cl-btn cl-btn-primary" onClick={requestConnect}>Connect the owner wallet</button>
        </Card>
      )}
    </div>
  );
}
