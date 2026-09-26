'use client';

/**
 * Deployments: the deployment record of this agent and its receipts.
 *
 * A deployment records what was true when it was made — the owner, the Amane account on every
 * chain, the lease Kido issued and the Blueprint revision the owner policy was signed for. It is
 * evidence about that revision, not a claim about the current one, so a Blueprint that has moved on
 * is flagged. Below the record: the deployment event timeline, the backend services a deployment
 * needs, and the shared Amane infrastructure (adapters per action and chain) the agent executes
 * through, from its self-model. All data comes from the Kido deployment and self-model endpoints.
 */
import Link from 'next/link';
import { Activity, ExternalLink, Rocket } from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, Card, CopyButton, EmptyState, KeyValue, Section, Skeleton, StatusBadge, TimeAgo, shortHash } from '@/components/studio/primitives';
import { WithProject, useKido } from '@/components/studio/kido';
import { useDeployment, useSelfModel } from '@/lib/kido/hooks';
import { chainLabel, explorerAccount, explorerTx } from '@/lib/kido/format';
import type { DeploymentStatus, DeploymentWire, ProjectEvent, ProjectSummary } from '@/lib/kido/types';
import type { Tone } from '@/lib/studio/types';

/** The backend's deployment state machine, in order. */
const STAGES: { id: DeploymentWire['status']; label: string; detail: string }[] = [
  { id: 'STARTED', label: 'Started', detail: 'Owner recorded; Kido began creating the per-chain accounts.' },
  { id: 'ACCOUNTS_READY', label: 'Accounts ready', detail: 'An Amane account exists on every chain.' },
  { id: 'POLICY_SIGNED', label: 'Policy signed', detail: 'The owner signed the root policy; Kido issued the agent lease.' },
  { id: 'ACTIVE', label: 'Active', detail: 'Policy installed and lease active on every endpoint.' },
];

const iso = (at: number) => new Date(at).toISOString();
const statusTone = (st: DeploymentWire['status']): Tone => (st === 'ACTIVE' ? 'pass' : 'data');

function Mono({ value, href }: { value: string; href?: string }) {
  return (
    <span className="cl-row" style={{ gap: 6 }}>
      <span className="cl-mono" title={value}>{shortHash(value, 10, 6)}</span>
      {href ? (
        <a className="cl-ref-copy" href={href} target="_blank" rel="noreferrer" aria-label="Open in block explorer" title="Open in block explorer">
          <ExternalLink size={12} aria-hidden />
        </a>
      ) : null}
      <CopyButton value={value} label="" />
    </span>
  );
}

function TxCell({ chain, tx, fallback }: { chain: string; tx?: string; fallback: string }) {
  if (!tx) return <span className="cl-meta">{fallback}</span>;
  return (
    <a className="cl-mono" href={explorerTx(chain, tx)} target="_blank" rel="noreferrer" title={tx}>
      {shortHash(tx, 8, 6)} <ExternalLink size={11} aria-hidden />
    </a>
  );
}

function Progress({ d }: { d: DeploymentWire }) {
  const at = STAGES.findIndex((x) => x.id === d.status);
  return (
    <div className="cl-steps">
      {STAGES.map((st, i) => (
        <div className="cl-step" key={st.id} style={{ cursor: 'default' }}>
          <span className="cl-step-index">{i + 1}</span>
          <span className="cl-step-name">{st.label}</span>
          <span className="cl-step-status">
            <StatusBadge status={i <= at ? 'PASS' : i === at + 1 ? 'PENDING' : 'BLOCKED'} label={i <= at ? 'done' : i === at + 1 ? 'next' : 'not yet'} />
          </span>
          <span className="cl-step-detail">{st.detail}</span>
        </div>
      ))}
    </div>
  );
}

function DeploymentRecord({ s, dep }: { s: ProjectSummary; dep: DeploymentStatus & { deployment: DeploymentWire } }) {
  const d = dep.deployment;
  const stale = s.revision !== null && d.blueprintRevision !== s.revision;
  const chains = Object.entries(d.chains);
  return (
    <>
      {stale ? (
        <BlockerBanner
          tone="warn"
          title={`Deployed Blueprint r${d.blueprintRevision} · current Blueprint is r${s.revision}`}
          actions={<Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/deploy`}>Open Deploy</Link>}
        >
          The on-chain policy was signed for an older revision. It keeps enforcing r{d.blueprintRevision} until the owner deploys the current one.
        </BlockerBanner>
      ) : null}

      <Section label="Deployment record">
        <div className="cl-grid cl-grid-wide-narrow" style={{ gap: 16 }}>
          <Card title="Receipt" actions={<Badge tone={statusTone(d.status)} chip>{d.status.replace(/_/g, ' ')}</Badge>}>
            <KeyValue
              rows={[
                { label: 'Owner (root controller)', value: <Mono value={d.owner} /> },
                { label: 'Account id', value: <Mono value={d.accountId} /> },
                { label: 'Lease issuer (Kido)', value: <Mono value={d.issuer} /> },
                { label: 'Agent key', value: <Mono value={d.agent} /> },
                { label: 'Lease', value: d.leaseId ? <Mono value={d.leaseId} /> : <span className="cl-meta">not issued yet</span> },
                {
                  label: 'Blueprint revision',
                  value: (
                    <span className="cl-row" style={{ gap: 6 }}>
                      <span className="cl-mono">r{d.blueprintRevision}</span>
                      {stale ? <Badge tone="warn">STALE · current r{s.revision}</Badge> : <Badge tone="pass">current</Badge>}
                    </span>
                  ),
                },
                { label: 'Chains', value: chains.map(([c]) => chainLabel(c)).join(' · ') || '—' },
              ]}
            />
          </Card>
          <Card title="Progress">
            <Progress d={d} />
          </Card>
        </div>
      </Section>

      <Section label="Endpoints">
        <Card flush>
          <div className="cl-table-scroll">
            <table className="cl-table" style={{ minWidth: 820 }}>
              <thead>
                <tr><th>Chain</th><th>Amane account</th><th>Account deployment</th><th>Policy install</th><th>Lease activation</th></tr>
              </thead>
              <tbody>
                {chains.map(([chain, c]) => (
                  <tr key={chain}>
                    <td className="cl-strong">{chainLabel(chain)}</td>
                    <td>{c.account ? <Mono value={c.account} href={explorerAccount(chain, c.account)} /> : <span className="cl-meta">pending</span>}</td>
                    <td><TxCell chain={chain} tx={c.deployTx} fallback={c.account ? 'no receipt recorded' : '—'} /></td>
                    <td><TxCell chain={chain} tx={c.install} fallback={d.status === 'ACTIVE' ? 'installed (no receipt recorded)' : '—'} /></td>
                    <td><TxCell chain={chain} tx={c.activate} fallback={d.status === 'ACTIVE' ? 'active (no receipt recorded)' : '—'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </Section>
    </>
  );
}

function Timeline({ events }: { events: ProjectEvent[] }) {
  if (!events.length) return <p className="cl-meta">No deployment events recorded.</p>;
  const rows = [...events].sort((a, b) => b.at - a.at);
  return (
    <Card flush>
      <div className="cl-table-scroll">
        <table className="cl-table" style={{ minWidth: 860 }}>
          <thead>
            <tr><th style={{ width: 170 }}>When</th><th style={{ width: 190 }}>Event</th><th style={{ width: 150 }}>Chain</th><th>Detail</th><th style={{ width: 150 }}>Transaction</th></tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={`${e.at}:${e.type}:${i}`}>
                <td className="cl-meta">
                  <div><TimeAgo iso={iso(e.at)} /></div>
                  <div className="cl-mono" style={{ fontSize: 11 }}>{iso(e.at).replace('T', ' ').slice(0, 19)}Z</div>
                </td>
                <td><Badge tone={/refused|fail/i.test(e.detail) ? 'deny' : e.type === 'deploy.active' ? 'pass' : e.type.startsWith('control') ? 'warn' : 'neutral'}>{e.type}</Badge></td>
                <td>{e.chain ? chainLabel(e.chain) : <span className="cl-meta">all</span>}</td>
                <td style={{ whiteSpace: 'normal' }}>{e.detail}</td>
                <td>{e.tx && e.chain ? <TxCell chain={e.chain} tx={e.tx} fallback="—" /> : e.tx ? <span className="cl-mono">{shortHash(e.tx)}</span> : <span className="cl-meta">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Readiness({ s, dep }: { s: ProjectSummary; dep: DeploymentStatus }) {
  const sui = s.chains.filter((c) => c.startsWith('sui'));
  const evm = s.chains.filter((c) => !c.startsWith('sui'));
  const rows = [
    { label: 'Lease issuer', ok: dep.issuerConfigured, note: 'Kido signs the agent lease inside the owner policy.', needed: true },
    { label: 'Sui relayer', ok: dep.suiRelayer, note: sui.length ? `Creates accounts and submits transactions on ${sui.map(chainLabel).join(', ')}.` : 'Not needed: this agent has no Sui chain.', needed: sui.length > 0 },
    { label: 'EVM RPC', ok: dep.evmRpc, note: evm.length ? `Reads and confirms state on ${evm.map(chainLabel).join(', ')}.` : 'Not needed: this agent has no EVM chain.', needed: evm.length > 0 },
  ];
  return (
    <Card title="Backend readiness">
      {rows.map((r) => (
        <div key={r.label} className="cl-row" style={{ justifyContent: 'space-between', padding: '6px 0', gap: 12, borderBottom: '1px solid var(--cl-line)' }}>
          <span>
            <span className="cl-strong">{r.label}</span>
            <div className="cl-meta">{r.note}</div>
          </span>
          <StatusBadge status={r.ok ? 'PASS' : r.needed ? 'BLOCKED' : 'DISABLED'} label={r.ok ? 'configured' : 'not configured'} />
        </div>
      ))}
    </Card>
  );
}

function Infrastructure({ s }: { s: ProjectSummary }) {
  const sm = useSelfModel(s.projectId, Boolean(s.blueprint));
  if (!s.blueprint) return <p className="cl-meta">The execution plan exists once a Blueprint is compiled.</p>;
  if (sm.isLoading) return <Skeleton height={80} />;
  if (sm.error || !sm.data) return <BlockerBanner tone="deny" title="Could not load the self-model">{(sm.error as Error | null)?.message ?? 'no data'}</BlockerBanner>;
  const authority = sm.data.providers.filter((p) => p.role === 'authority');
  return (
    <div className="cl-stack" style={{ gap: 16 }}>
      {authority.map((p) => (
        <Card key={p.providerId} title={<span className="cl-mono">{p.providerId}</span>} actions={<Badge tone={p.live ? 'pass' : 'warn'}>{p.status.replace(/_/g, ' ')}</Badge>}>
          <p className="cl-body" style={{ marginTop: 0 }}>{p.statusMeaning}</p>
          {p.blocker ? <BlockerBanner tone="warn" title="Blocked">{p.blocker}</BlockerBanner> : null}
          {p.notProven.length ? <p className="cl-meta" style={{ margin: 0 }}>Not proven: {p.notProven.join('; ')}</p> : null}
        </Card>
      ))}
      <Card flush>
        {sm.data.execution.length ? (
          <div className="cl-table-scroll">
            <table className="cl-table" style={{ minWidth: 900 }}>
              <thead>
                <tr><th>Action</th><th>Chain</th><th>Provider</th><th>Adapter</th><th>Enforced on-chain</th></tr>
              </thead>
              <tbody>
                {sm.data.execution.map((x) => (
                  <tr key={`${x.action}:${x.chain}:${x.providerId}`}>
                    <td className="cl-strong cl-mono">{x.action}</td>
                    <td>{chainLabel(x.chain)}</td>
                    <td>
                      <div className="cl-mono">{x.providerId}</div>
                      <div className="cl-meta">{x.providerVersion}</div>
                    </td>
                    <td>{x.adapter ? <span>{x.adapter.name} <Badge tone="neutral">v{x.adapter.version}</Badge></span> : <Badge tone="blocked">no adapter</Badge>}</td>
                    <td style={{ whiteSpace: 'normal' }}>
                      {x.enforcement.length ? (
                        <ul style={{ margin: 0, paddingLeft: 16 }}>
                          {x.enforcement.map((e) => <li key={e} style={{ fontSize: 12.5 }}>{e}</li>)}
                        </ul>
                      ) : (
                        <span className="cl-meta">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 16 }} className="cl-meta">The agent has no executable actions.</div>
        )}
      </Card>
      <p className="cl-meta" style={{ margin: 0 }}>
        These contracts and adapters are shared Amane infrastructure: a deployment creates this agent&apos;s own account on each chain and installs its policy, but executes through the same adapters every
        Kido agent uses. {sm.data.upstreamChangePolicy}
      </p>
    </div>
  );
}

function Body({ s }: { s: ProjectSummary }) {
  const dep = useDeployment(s.projectId);
  if (dep.isLoading) return <Skeleton height={160} />;
  if (dep.error || !dep.data) return <BlockerBanner tone="deny" title="Could not load the deployment">{(dep.error as Error | null)?.message ?? 'no data'}</BlockerBanner>;
  const d = dep.data.deployment;
  return (
    <>
      {d ? (
        <DeploymentRecord s={s} dep={{ ...dep.data, deployment: d }} />
      ) : (
        <EmptyState
          title="Not deployed"
          body={
            s.build
              ? 'This agent is built but has no deployment. Deploying creates its Amane account on every chain and installs the owner-signed policy.'
              : 'Build the agent first; then deploy it to create its Amane accounts and install the owner policy.'
          }
          action={
            <Link className="cl-btn cl-btn-primary" href={`/projects/${s.projectId}/${s.build ? 'deploy' : 'build'}`}>
              <Rocket size={13} aria-hidden /> {s.build ? 'Open Deploy' : 'Open the Composer'}
            </Link>
          }
        />
      )}

      <Section label="Deployment events">
        <Timeline events={dep.data.events} />
      </Section>

      <Section label="Readiness">
        <Readiness s={s} dep={dep.data} />
      </Section>

      <Section label="Shared Amane infrastructure">
        <Infrastructure s={s} />
      </Section>
    </>
  );
}

function HeaderBadges({ s }: { s: ProjectSummary }) {
  const dep = useDeployment(s.projectId);
  const d = dep.data?.deployment;
  if (!dep.data) return null;
  return (
    <>
      {d ? <Badge tone={statusTone(d.status)} chip>{d.status.replace(/_/g, ' ')}</Badge> : <Badge tone="blocked">Not deployed</Badge>}
      {d ? <Badge tone={d.blueprintRevision === s.revision ? 'neutral' : 'warn'}>Deployed r{d.blueprintRevision}{d.blueprintRevision === s.revision ? '' : ` · current r${s.revision}`}</Badge> : null}
      <Badge tone="neutral">{dep.data.events.length} events</Badge>
    </>
  );
}

export default function DeploymentsPage() {
  const { s, id } = useKido();
  return (
    <StudioPage
      segment="deployments"
      badges={s ? <HeaderBadges s={s} /> : null}
      actions={
        <>
          <Link className="cl-btn" href={`/projects/${id}/runtime`}>
            <Activity size={13} aria-hidden /> Runtime
          </Link>
          <Link className="cl-btn cl-btn-primary" href={`/projects/${id}/deploy`}>
            <Rocket size={13} aria-hidden /> Deploy
          </Link>
        </>
      }
    >
      <WithProject>{(p) => <Body s={p} />}</WithProject>
    </StudioPage>
  );
}
