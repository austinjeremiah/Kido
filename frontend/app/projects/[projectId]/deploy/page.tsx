'use client';

/**
 * Deploy: create the built agent's Amane accounts and install the owner policy.
 *
 * The connected wallet is the owner and the only root controller. It deploys the Ethereum account
 * and sends the Ethereum install/activate transactions (paying their gas), and it signs the one
 * owner policy every chain installs. Kido issues the agent lease (bounded by that policy) and its
 * relayer submits the Sui transactions. The flow resumes from wherever the backend says it is.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, Card, KeyValue, StatusBadge } from '@/components/studio/primitives';
import { NotYet, WithProject } from '@/components/studio/kido';
import { useOwnerWallet } from '@/components/studio/kido-wallet';
import { useWalletSession } from '@/lib/studio/wallet-session';
import { kido } from '@/lib/kido/api';
import { keys, useDeployment } from '@/lib/kido/hooks';
import { chainLabel, explorerAccount, explorerTx } from '@/lib/kido/format';
import type { ProjectSummary } from '@/lib/kido/types';

type Step = { at: number; text: string; ok: boolean };

function Flow({ s }: { s: ProjectSummary }) {
  const qc = useQueryClient();
  const dep = useDeployment(s.projectId);
  const w = useOwnerWallet();
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<Step[]>([]);
  const note = (text: string, ok = true) => setLog((l) => [...l, { at: Date.now(), text, ok }]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.deployment(s.projectId) });
    void qc.invalidateQueries({ queryKey: keys.runtime(s.projectId) });
    void qc.invalidateQueries({ queryKey: keys.activity(s.projectId) });
  };

  const deploy = async () => {
    if (!w.address) return;
    setRunning(true);
    try {
      let d = dep.data?.deployment ?? null;
      if (d && d.owner.toLowerCase() !== w.address.toLowerCase()) throw new Error(`This agent is being deployed with owner ${d.owner}; connect that wallet to continue.`);
      if (!d) {
        note('Creating the accounts…');
        const r = await kido.deployStart(s.projectId, w.address);
        d = r.deployment;
        for (const [chain, c] of Object.entries(d.chains)) if (c.account) note(`${chainLabel(chain)} account created by the Kido relayer: ${c.account}`);
        if (r.transactions.length) {
          note('Approve the Ethereum account deployment in your wallet…');
          const [hash] = await w.send(r.transactions);
          d = (await kido.deployEvmAccount(s.projectId, hash!)).deployment;
          note(`Ethereum account deployed: ${Object.entries(d.chains).find(([c]) => c === 'ethereum-sepolia')?.[1].account}`);
        }
      }
      if (d.status === 'STARTED' || d.status === 'ACCOUNTS_READY') {
        note('Sign the owner policy in your wallet (one signature for every chain)…');
        const pol = await kido.deployPolicy(s.projectId);
        const sig = await w.sign(pol.typedData);
        const r = await kido.deploySubmitPolicy(s.projectId, sig);
        d = r.deployment;
        note('Policy signed; Kido issued the agent lease.');
        if (r.transactions.length) {
          note('Approve the Ethereum policy install and lease activation…');
          await w.send(r.transactions, async (tx, hash) => {
            await kido.recordTx(s.projectId, 'ethereum-sepolia', tx.label, hash);
            note(`${tx.label}: ${hash}`);
          });
        }
      }
      const c = await kido.deployConfirm(s.projectId);
      note(c.active ? 'Every endpoint has the owner policy and an active lease.' : 'Not every endpoint is active yet; check Runtime.', c.active);
    } catch (e) {
      note((e as Error).message.split('\n')[0] ?? 'failed', false);
    } finally {
      setRunning(false);
      refresh();
    }
  };

  const d = dep.data?.deployment;
  return (
    <>
      <Card title="Deployment" actions={d ? <Badge tone={d.status === 'ACTIVE' ? 'pass' : 'data'}>{d.status}</Badge> : null}>
        <KeyValue
          rows={[
            { label: 'Owner (your wallet)', value: w.address ?? 'not connected', mono: true },
            { label: 'Chains', value: s.chains.map(chainLabel).join(' · ') },
            { label: 'Lease issuer (Kido)', value: d?.issuer ?? (dep.data?.issuerConfigured ? 'configured' : 'not configured on the backend'), mono: true },
            { label: 'Agent key', value: d?.agent ?? '—', mono: true },
          ]}
        />
        <div className="cl-row" style={{ marginTop: 12, gap: 8 }}>
          <button type="button" className="cl-btn cl-btn-primary" onClick={deploy} disabled={running || !w.ready || d?.status === 'ACTIVE'}>
            {running ? 'Deploying…' : d?.status === 'ACTIVE' ? 'Deployed' : d ? 'Continue deployment' : 'Deploy'}
          </button>
          {!w.ready ? <span className="cl-meta">Waiting for the wallet…</span> : null}
        </div>
      </Card>
      {d ? (
        <Card title="Accounts">
          <table className="cl-table">
            <thead>
              <tr><th>Chain</th><th>Amane account</th><th>Created</th><th>Policy</th><th>Lease</th></tr>
            </thead>
            <tbody>
              {Object.entries(d.chains).map(([chain, c]) => (
                <tr key={chain}>
                  <td>{chainLabel(chain)}</td>
                  <td className="cl-mono">{c.account ? <a href={explorerAccount(chain, c.account)} target="_blank" rel="noreferrer">{c.account.slice(0, 10)}…</a> : 'pending'}</td>
                  <td>{c.deployTx ? <a href={explorerTx(chain, c.deployTx)} target="_blank" rel="noreferrer">tx</a> : '—'}</td>
                  <td>{c.install ? <a href={explorerTx(chain, c.install)} target="_blank" rel="noreferrer">installed</a> : d.status === 'ACTIVE' ? 'installed' : '—'}</td>
                  <td>{c.activate ? <a href={explorerTx(chain, c.activate)} target="_blank" rel="noreferrer">active</a> : d.status === 'ACTIVE' ? 'active' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      {log.length ? (
        <Card title="This session">
          {log.map((l) => (
            <p key={l.at + l.text} className="cl-body" style={{ margin: '4px 0', color: l.ok ? undefined : 'var(--cl-deny, #e5484d)' }}>{l.text}</p>
          ))}
        </Card>
      ) : null}
    </>
  );
}

function Readiness({ s }: { s: ProjectSummary }) {
  const dep = useDeployment(s.projectId);
  const needsSui = s.chains.includes('sui-testnet');
  const rows = [
    { label: 'Built for the current revision', ok: s.build?.freshness === 'CURRENT' },
    { label: 'Enforced by Amane', ok: s.blueprint?.authority.provider === 'AMANE' },
    { label: 'Kido lease issuer configured', ok: Boolean(dep.data?.issuerConfigured) },
    ...(needsSui ? [{ label: 'Kido Sui relayer configured', ok: Boolean(dep.data?.suiRelayer) }] : []),
  ];
  return (
    <Card title="Readiness">
      {rows.map((r) => (
        <div key={r.label} className="cl-row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
          <span className="cl-body">{r.label}</span>
          <StatusBadge status={r.ok ? 'PASS' : 'BLOCKED'} />
        </div>
      ))}
      <p className="cl-meta">Deploying creates one Amane account per chain. Your wallet signs one owner policy for all of them; on Ethereum it also pays the gas (about 0.005 ETH for the account, plus two small transactions).</p>
    </Card>
  );
}

export default function DeployPage() {
  const { activated, requestConnect } = useWalletSession();
  return (
    <StudioPage segment="deploy">
      <WithProject>
        {(p) => {
          if (!p.build) return <NotYet what="build" where="composer" id={p.projectId} />;
          return (
            <div className="cl-stack" style={{ gap: 16 }}>
              {p.build.freshness !== 'CURRENT' ? <BlockerBanner tone="warn" title="The build is stale">Rebuild the current revision in the Composer before deploying.</BlockerBanner> : null}
              <Readiness s={p} />
              {activated ? (
                <Flow s={p} />
              ) : (
                <Card title="Owner wallet">
                  <p className="cl-body" style={{ marginTop: 0 }}>Your wallet becomes the agent's only root controller. Kido never holds that key.</p>
                  <button type="button" className="cl-btn cl-btn-primary" onClick={requestConnect}>
                    Connect wallet
                  </button>
                </Card>
              )}
            </div>
          );
        }}
      </WithProject>
    </StudioPage>
  );
}
