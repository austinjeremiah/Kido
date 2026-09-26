'use client';

/**
 * Control Plane: the owner's emergency controls on every chain the agent is deployed to, the live
 * health of each Amane account, alerts derived from real problems and the command log.
 *
 * Rules encoded here:
 *  - "Pause everywhere" asks the backend for one PauseAccount message per chain, the owner's wallet
 *    signs each, the backend relays Sui and returns the EVM transactions for the wallet to send.
 *    "Revoke lease" is one RevokeLease signature honoured on every chain.
 *  - Each chain reports its own outcome. A partial result is shown as partial, never rounded up.
 *  - Nothing is signed without a confirmation that states current state → requested state →
 *    network → resource → consequence, and only with the deployment's owner wallet.
 *  - Alerts are computed from the runtime, the deployment record, the project summary and the
 *    self-model. Nothing here is a stored alert; an alert clears when the problem does.
 */
import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, OctagonPause, RefreshCw, Wallet } from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, Card, EmptyState, KeyValue, Section, SeverityBadge, Skeleton, StatusBadge, TimeAgo, shortHash } from '@/components/studio/primitives';
import { SecurityConfirmation } from '@/components/studio/dialogs';
import { WithProject, useKido } from '@/components/studio/kido';
import { useOwnerWallet } from '@/components/studio/kido-wallet';
import { useWalletSession } from '@/lib/studio/wallet-session';
import { useControlRequest } from '@/lib/studio/control-bridge';
import { segmentForPageKind } from '@/lib/studio/nav';
import { kido } from '@/lib/kido/api';
import { keys, useActivity, useDeployment, useRuntime, useSelfModel } from '@/lib/kido/hooks';
import { LEASE_STATUS, chainLabel, explorerAccount, explorerTx } from '@/lib/kido/format';
import type { DeploymentStatus, ProjectEvent, ProjectSummary, Runtime, RuntimeChain, SelfModel } from '@/lib/kido/types';
import type { PageKind, Severity, Status } from '@/lib/studio/types';

type Op = 'pause' | 'revoke';

const OP_LABEL: Record<Op, string> = { pause: 'Pause everywhere', revoke: 'Revoke lease' };

/** What the page needs from the owner's wallet; null until the wallet runtime is mounted. */
type OwnerWallet = ReturnType<typeof useOwnerWallet>;

interface StepResult {
  chain: string;
  label: string;
  status: Status;
  detail: string;
  tx?: string;
  /** A signature alone changes nothing on chain; it does not count toward success. */
  signature?: boolean;
}
interface ControlRun {
  op: Op;
  at: string;
  outcome: 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'RUNNING';
  steps: StepResult[];
  error: string | null;
}

const chainName = (c: string) => (c === 'all' ? 'Every chain' : chainLabel(c));
const isSui = (c: string) => c.startsWith('sui');

function formatUnits(v: string, d: number) {
  if (!/^\d+$/.test(v)) return v;
  const s = v.padStart(d + 1, '0');
  const frac = d ? s.slice(-d).replace(/0+$/, '') : '';
  return `${s.slice(0, s.length - d).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
}

/* ------------------------------------------------------------------ alerts */

interface Alert {
  id: string;
  severity: Severity;
  type: string;
  resource: string;
  detail: string;
  /** Page that owns the fix. */
  page: PageKind;
}

const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

function deriveAlerts(s: ProjectSummary, rt: Runtime | undefined, rtError: string | null, dep: DeploymentStatus | undefined, sm: SelfModel | undefined): Alert[] {
  const out: Alert[] = [];
  const add = (a: Alert) => out.push(a);

  if (rtError) add({ id: 'runtime-read', severity: 'HIGH', type: 'RUNTIME_UNREADABLE', resource: 'Runtime', detail: rtError, page: 'runtime' });
  for (const c of rt?.chains ?? []) {
    if (c.error) add({ id: `rt-err-${c.chain}`, severity: 'HIGH', type: 'CHAIN_READ_FAILED', resource: chainLabel(c.chain), detail: c.error, page: 'runtime' });
    if (c.paused) add({ id: `paused-${c.chain}`, severity: 'HIGH', type: 'ACCOUNT_PAUSED', resource: chainLabel(c.chain), detail: `The Amane account is paused (epoch ${c.pauseEpoch ?? '—'}); every agent action is refused until the owners unpause it.`, page: 'runtime' });
    if (c.leaseStatus === 2) add({ id: `revoked-${c.chain}`, severity: 'CRITICAL', type: 'LEASE_REVOKED', resource: chainLabel(c.chain), detail: 'The agent lease is revoked; the agent key has no authority on this chain. A new lease is needed to resume.', page: 'policies' });
    else if (rt?.deployed && rt.status === 'ACTIVE' && c.leaseStatus === 0) add({ id: `nolease-${c.chain}`, severity: 'HIGH', type: 'NO_ACTIVE_LEASE', resource: chainLabel(c.chain), detail: 'The deployment is active but this chain reports no lease for the agent.', page: 'policies' });
  }
  if (rt?.deployed && rt.status !== 'ACTIVE') add({ id: 'dep-incomplete', severity: 'MEDIUM', type: 'DEPLOYMENT_INCOMPLETE', resource: 'Deployment', detail: `The deployment stopped at ${rt.status ?? 'an unknown step'}; the policy is not active on every chain.`, page: 'deploy' });

  const d = dep?.deployment;
  if (d && s.revision !== null && d.blueprintRevision !== s.revision) add({ id: 'stale-dep', severity: 'MEDIUM', type: 'STALE_DEPLOYMENT', resource: `Blueprint r${d.blueprintRevision}`, detail: `The deployed policy was compiled from blueprint r${d.blueprintRevision}; the project is now at r${s.revision}. Redeploy to install the current policy.`, page: 'deploy' });
  if (dep && !dep.issuerConfigured) add({ id: 'env-issuer', severity: 'MEDIUM', type: 'ISSUER_NOT_CONFIGURED', resource: 'Kido backend', detail: 'No lease issuer key is configured, so a new lease cannot be issued.', page: 'deploy' });
  if (dep && !dep.suiRelayer && s.chains.some(isSui)) add({ id: 'env-sui', severity: 'MEDIUM', type: 'SUI_RELAYER_MISSING', resource: 'Kido backend', detail: 'No Sui relayer is configured, so signed Sui controls cannot be relayed.', page: 'deploy' });
  if (dep && !dep.evmRpc && s.chains.some((c) => !isSui(c))) add({ id: 'env-evm', severity: 'MEDIUM', type: 'EVM_RPC_MISSING', resource: 'Kido backend', detail: 'No EVM RPC is configured, so EVM account state cannot be read.', page: 'deploy' });

  for (const b of s.blockers) add({ id: `blocker-${b.code}`, severity: 'HIGH', type: b.code, resource: 'Blueprint', detail: b.detail, page: 'blueprint' });
  for (const f of s.security?.findings.filter((x) => x.blocking) ?? []) add({ id: `sec-${f.id}`, severity: 'HIGH', type: f.class, resource: `Finding ${f.id}`, detail: f.evidence, page: 'permissions' });
  if (s.security?.freshness === 'STALE') add({ id: 'sec-stale', severity: 'MEDIUM', type: 'STALE_SECURITY_REVIEW', resource: `Review r${s.security.blueprintRevision}`, detail: 'The security review predates the current blueprint revision.', page: 'permissions' });
  for (const r of s.simulation?.results.filter((x) => !x.passed) ?? []) add({ id: `sim-${r.id}`, severity: 'HIGH', type: 'SIMULATION_FAILED', resource: r.id, detail: `${r.family}: expected ${r.expected}, got ${r.actual}${r.code ? ` (${r.code})` : ''}. ${r.note}`, page: 'simulation' });
  if (s.simulation?.freshness === 'STALE') add({ id: 'sim-stale', severity: 'MEDIUM', type: 'STALE_SIMULATION', resource: `Simulation r${s.simulation.blueprintRevision}`, detail: 'The simulation predates the current blueprint revision.', page: 'simulation' });
  if (s.build?.freshness === 'STALE') add({ id: 'build-stale', severity: 'MEDIUM', type: 'STALE_BUILD', resource: `Build ${s.build.buildRevision}`, detail: `The build was compiled from blueprint r${s.build.blueprintRevision}; rebuild before deploying.`, page: 'composer' });
  for (const m of s.build?.agents.filter((a) => a.missingPacks.length) ?? []) add({ id: `packs-${m.role}`, severity: 'LOW', type: 'MISSING_KNOWLEDGE_PACKS', resource: m.role, detail: `Missing: ${m.missingPacks.join(', ')}`, page: 'code' });

  for (const p of sm?.providers.filter((x) => !x.live) ?? []) add({ id: `prov-${p.providerId}`, severity: p.role === 'authority' ? 'HIGH' : 'MEDIUM', type: 'PROVIDER_NOT_LIVE', resource: `${p.providerId} (${p.role})`, detail: `${p.status}: ${p.blocker ?? p.statusMeaning}`, page: 'integrations' });

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/* -------------------------------------------------------------------- page */

export default function ControlPlanePage() {
  const { s } = useKido();
  if (!s) {
    return (
      <StudioPage segment="control-plane">
        <WithProject>{() => null}</WithProject>
      </StudioPage>
    );
  }
  return <ControlPlane s={s} />;
}

function ControlPlane({ s }: { s: ProjectSummary }) {
  const id = s.projectId;
  const qc = useQueryClient();
  const { activated, requestConnect } = useWalletSession();
  const rt = useRuntime(id);
  const dep = useDeployment(id);
  const act = useActivity(id);
  const sm = useSelfModel(id, Boolean(s.blueprint));

  const [confirm, setConfirm] = useState<Op | null>(null);
  const [run, setRun] = useState<ControlRun | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useControlRequest('EMERGENCY_LOCK', () => setConfirm('pause'));
  useControlRequest('PAUSE_RUNTIME', () => setConfirm('pause'));
  useControlRequest('REVOKE_AGENT', () => setConfirm('revoke'));

  const runtime = rt.data;
  const deployed = Boolean(runtime?.deployed);
  const rtError = rt.isError ? (rt.error as Error).message : null;
  const alerts = useMemo(() => deriveAlerts(s, runtime, rtError, dep.data, sm.data), [s, runtime, rtError, dep.data, sm.data]);
  const critical = alerts.filter((a) => a.severity === 'CRITICAL' || a.severity === 'HIGH');
  const anyPaused = runtime?.chains.some((c) => c.paused) ?? false;
  const allRevoked = deployed && (runtime?.chains.length ?? 0) > 0 && runtime!.chains.every((c) => c.leaseStatus === 2);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([
      qc.invalidateQueries({ queryKey: keys.runtime(id) }),
      qc.invalidateQueries({ queryKey: keys.deployment(id) }),
      qc.invalidateQueries({ queryKey: keys.activity(id) }),
      qc.invalidateQueries({ queryKey: keys.project(id) }),
      qc.invalidateQueries({ queryKey: keys.selfModel(id) }),
    ]);
    setRefreshing(false);
  };

  const controlsDisabledReason = !deployed ? 'The agent is not deployed, so there is nothing to pause or revoke.' : !runtime?.leaseId ? 'No lease has been issued yet.' : null;

  return (
    <StudioPage
      segment="control-plane"
      live
      badges={
        <>
          {deployed ? <StatusBadge status={runtime?.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING'} label={runtime?.status ?? 'unknown'} /> : <Badge tone="blocked">Not deployed</Badge>}
          {deployed ? <span className="cl-meta">{runtime!.chains.length} chain{runtime!.chains.length === 1 ? '' : 's'}</span> : null}
          {anyPaused ? <Badge tone="warn">paused</Badge> : null}
          {allRevoked ? <Badge tone="deny">lease revoked</Badge> : null}
          {alerts.length ? <Badge tone={critical.length ? 'deny' : 'warn'}>{alerts.length} alert{alerts.length === 1 ? '' : 's'}</Badge> : <Badge tone="pass">No alerts</Badge>}
          {rt.dataUpdatedAt ? <span className="cl-meta">read <TimeAgo iso={new Date(rt.dataUpdatedAt).toISOString()} /></span> : null}
        </>
      }
      actions={
        <>
          <button type="button" className="cl-btn" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw size={13} aria-hidden />
            {refreshing ? 'Re-reading…' : 'Re-read chains'}
          </button>
          <button type="button" className="cl-btn cl-btn-danger" onClick={() => setConfirm('revoke')} disabled={Boolean(controlsDisabledReason) || allRevoked} title={controlsDisabledReason ?? undefined}>
            <Ban size={13} aria-hidden />
            Revoke lease
          </button>
          <button type="button" className="cl-btn cl-btn-emergency" onClick={() => setConfirm('pause')} disabled={Boolean(controlsDisabledReason)} title={controlsDisabledReason ?? undefined}>
            <OctagonPause size={13} aria-hidden />
            Pause everywhere
          </button>
        </>
      }
      banners={
        <>
          {run && run.outcome !== 'RUNNING' ? (
            <BlockerBanner tone={run.outcome === 'COMPLETE' ? 'pass' : run.outcome === 'PARTIAL' ? 'warn' : 'deny'} title={`${OP_LABEL[run.op]}: ${run.outcome.toLowerCase()}`}>
              {run.error ?? 'Each chain is reported separately below — a partial result is not presented as a success.'}
            </BlockerBanner>
          ) : null}
          {critical.length ? (
            <BlockerBanner tone="deny" title={`${critical.length} high-severity alert${critical.length === 1 ? '' : 's'}`}>
              {critical.slice(0, 4).map((a) => `${a.type} · ${a.resource}`).join(' · ')}
              {critical.length > 4 ? ` · +${critical.length - 4} more` : ''}
            </BlockerBanner>
          ) : null}
        </>
      }
    >
      {/* emergency controls */}
      <Section label="Emergency controls">
        <div className="cl-grid cl-grid-2">
          <Card title="Pause everywhere" actions={anyPaused ? <Badge tone="warn">paused</Badge> : deployed ? <Badge tone="pass">running</Badge> : null}>
            <p style={{ fontSize: 13, lineHeight: 1.55 }}>
              Pauses the agent&apos;s Amane account on every chain. The owner signs one PauseAccount message per chain; Sui is relayed by Kido
              and EVM chains are sent from your wallet. Every agent action is refused while paused; unpausing needs the owners&apos; threshold.
            </p>
            <div className="cl-row cl-row-wrap" style={{ gap: 8, marginTop: 12 }}>
              <button type="button" className="cl-btn cl-btn-emergency" onClick={() => setConfirm('pause')} disabled={Boolean(controlsDisabledReason)}>
                <OctagonPause size={13} aria-hidden />
                Pause everywhere
              </button>
              {deployed ? <span className="cl-meta">{runtime!.chains.map((c) => chainLabel(c.chain)).join(' · ')}</span> : null}
            </div>
          </Card>
          <Card title="Revoke lease" actions={allRevoked ? <Badge tone="deny">revoked</Badge> : runtime?.leaseId ? <Badge tone="pass">lease issued</Badge> : null}>
            <p style={{ fontSize: 13, lineHeight: 1.55 }}>
              Revokes the agent key&apos;s lease with one owner signature honoured on every chain. The agent loses all authority immediately
              and permanently; resuming needs a new lease from a fresh deployment.
            </p>
            <div className="cl-row cl-row-wrap" style={{ gap: 8, marginTop: 12 }}>
              <button type="button" className="cl-btn cl-btn-danger" onClick={() => setConfirm('revoke')} disabled={Boolean(controlsDisabledReason) || allRevoked}>
                <Ban size={13} aria-hidden />
                Revoke lease
              </button>
              {runtime?.leaseId ? <span className="cl-meta cl-mono">{shortHash(runtime.leaseId, 10, 6)}</span> : null}
            </div>
          </Card>
        </div>
        <OwnerStrip activated={activated} requestConnect={requestConnect} owner={runtime?.owner ?? null} />
        {controlsDisabledReason ? (
          <p className="cl-meta" style={{ marginTop: 10 }}>
            {controlsDisabledReason} <Link href={`/projects/${id}/deploy`}>Open Deploy</Link>
          </p>
        ) : null}
      </Section>

      {run ? <RunResult run={run} /> : null}

      {/* live status */}
      <Section label="Live status" actions={<Link className="cl-btn cl-btn-sm" href={`/projects/${id}/runtime`}>Open Runtime</Link>}>
        {rt.isLoading ? (
          <Skeleton height={120} />
        ) : rtError ? (
          <BlockerBanner tone="deny" title="The runtime could not be read">{rtError}</BlockerBanner>
        ) : !deployed ? (
          <EmptyState title="Not deployed" body="The control plane observes the agent's Amane accounts. Deploy the built agent to create them." action={<Link className="cl-btn cl-btn-primary" href={`/projects/${id}/deploy`}>Open Deploy</Link>} />
        ) : (
          <>
            <div className="cl-grid cl-grid-auto">
              <DeploymentTile runtime={runtime!} dep={dep.data} s={s} />
              {runtime!.chains.map((c) => <ChainTile key={c.chain} c={c} />)}
            </div>
          </>
        )}
      </Section>

      {/* alerts */}
      <Section label="Alerts" actions={<span className="cl-meta">derived from the chains, the deployment record, the lifecycle and the self-model</span>}>
        {alerts.length === 0 ? (
          <Card>
            <p className="cl-meta">Nothing needs attention: every chain reads cleanly, the deployment matches the blueprint and every lifecycle artifact is current.</p>
          </Card>
        ) : (
          <Card flush>
            <div className="cl-table-scroll">
              <table className="cl-table" style={{ minWidth: 700 }}>
                <thead>
                  <tr>
                    <th style={{ width: 104 }}>Severity</th>
                    <th style={{ width: 190 }}>Alert</th>
                    <th style={{ width: 120 }}>Resource</th>
                    <th>Detail</th>
                    <th style={{ width: 72 }} />
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((a) => (
                    <tr key={a.id}>
                      <td><SeverityBadge severity={a.severity} /></td>
                      <td className="cl-mono" style={{ fontSize: 11.5 }}>{a.type}</td>
                      <td className="cl-mono" style={{ fontSize: 11.5 }}>{a.resource}</td>
                      <td className="cl-meta" style={{ whiteSpace: 'normal' }}>{a.detail}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Link className="cl-btn cl-btn-sm" href={`/projects/${id}/${segmentForPageKind(a.page)}`}>Open</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </Section>

      {/* command log */}
      <CommandLog events={act.data ?? []} loading={act.isLoading} error={act.isError ? (act.error as Error).message : null} />

      {activated ? (
        <WalletRunner id={id} s={s} runtime={runtime} op={confirm} onClose={() => setConfirm(null)} onRun={setRun} requestConnect={requestConnect} />
      ) : (
        <ControlConfirm id={id} s={s} runtime={runtime} op={confirm} onClose={() => setConfirm(null)} onRun={setRun} wallet={null} requestConnect={requestConnect} />
      )}
    </StudioPage>
  );
}

/* ----------------------------------------------------------- owner wallet */

function OwnerStrip({ activated, requestConnect, owner }: { activated: boolean; requestConnect: () => void; owner: string | null }) {
  if (!activated) {
    return (
      <div className="cl-row cl-row-wrap" style={{ gap: 10, marginTop: 12 }}>
        <button type="button" className="cl-btn cl-btn-primary" onClick={requestConnect}>
          <Wallet size={13} aria-hidden />
          Connect the owner wallet
        </button>
        <span className="cl-meta">Controls are signed in the owner&apos;s wallet. Kido never holds the owner key.</span>
      </div>
    );
  }
  return <ConnectedOwner owner={owner} />;
}

function ConnectedOwner({ owner }: { owner: string | null }) {
  const w = useOwnerWallet();
  const match = owner && w.address ? owner.toLowerCase() === w.address.toLowerCase() : null;
  return (
    <div className="cl-row cl-row-wrap" style={{ gap: 10, marginTop: 12 }}>
      <span className="cl-meta">Wallet</span>
      <span className="cl-mono" style={{ fontSize: 12 }}>{w.address ?? 'not connected'}</span>
      {match === true ? <Badge tone="pass">deployment owner</Badge> : match === false ? <Badge tone="deny" title={`Owner is ${owner}`}>not the owner</Badge> : null}
    </div>
  );
}

function WalletRunner(props: Omit<ConfirmProps, 'wallet'>) {
  const w = useOwnerWallet();
  return <ControlConfirm {...props} wallet={w} />;
}

interface ConfirmProps {
  id: string;
  s: ProjectSummary;
  runtime: Runtime | undefined;
  op: Op | null;
  onClose: () => void;
  onRun: (run: ControlRun) => void;
  wallet: OwnerWallet | null;
  requestConnect: () => void;
}

/** The confirmation and, on confirm, the prepare → sign → submit → send flow. */
function ControlConfirm({ id, runtime, op, onClose, onRun, wallet, requestConnect }: ConfirmProps) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const chains = runtime?.chains ?? [];
  const owner = runtime?.owner ?? null;
  const ownerMatch = Boolean(owner && wallet?.address && owner.toLowerCase() === wallet.address.toLowerCase());
  const network = chains.length ? chains.map((c) => chainLabel(c.chain)).join(' + ') : '—';

  const execute = async (o: Op) => {
    if (!wallet) return;
    setBusy(true);
    const steps: StepResult[] = [];
    const at = new Date().toISOString();
    const push = (st: StepResult) => {
      steps.push(st);
      onRun({ op: o, at, outcome: 'RUNNING', steps: [...steps], error: null });
    };
    let error: string | null = null;
    try {
      const prep = await kido.controlPrepare(id, o);
      const signed: { chain: string; message: Record<string, unknown>; signature: string }[] = [];
      for (const m of prep.messages) {
        const signature = await wallet.sign(m.typedData);
        signed.push({ chain: m.chain, message: m.message, signature });
        push({ chain: m.chain, label: `Signed ${m.primaryType}`, status: 'PASS', detail: `owner signature ${shortHash(signature, 10, 6)}`, signature: true });
      }
      const r = await kido.controlSubmit(id, o, signed);
      for (const raw of r.results) {
        const res = raw as { chain?: string; kind?: string; tx?: string };
        const ok = res.kind === 'EXECUTED';
        push({ chain: res.chain ?? '—', label: ok ? 'Relayed and executed' : 'Refused on chain', status: ok ? 'PASS' : 'FAIL', detail: ok ? `${o} executed by the relayer` : JSON.stringify(raw), ...(res.tx ? { tx: res.tx } : {}) });
      }
      if (r.transactions.length) {
        const evm = chains.filter((c) => !isSui(c.chain)).map((c) => c.chain);
        const evmChain = evm[0] ?? chains[0]?.chain ?? 'unknown';
        await wallet.send(r.transactions, async (tx, hash) => {
          push({ chain: evmChain, label: tx.label, status: 'PASS', detail: 'sent from the owner wallet and confirmed', tx: hash });
          await kido.recordTx(id, evmChain, tx.label, hash);
        });
      }
    } catch (e) {
      error = (e as Error).message.split('\n')[0] ?? 'failed';
    } finally {
      const failed = steps.some((x) => x.status === 'FAIL');
      const passed = steps.some((x) => x.status === 'PASS' && !x.signature);
      const outcome: ControlRun['outcome'] = error || failed ? (passed ? 'PARTIAL' : 'FAILED') : 'COMPLETE';
      onRun({ op: o, at, outcome, steps: [...steps], error });
      setBusy(false);
      void qc.invalidateQueries({ queryKey: keys.runtime(id) });
      void qc.invalidateQueries({ queryKey: keys.activity(id) });
    }
  };

  if (!op) return null;

  const preconditions: { id: string; label: string; status: Status; detail: string }[] = [
    { id: 'deployed', label: 'Deployment', status: runtime?.deployed && runtime.leaseId ? 'PASS' : 'FAIL', detail: runtime?.deployed ? `status ${runtime.status}; lease ${runtime.leaseId ? shortHash(runtime.leaseId, 8, 4) : 'not issued'}` : 'not deployed' },
    { id: 'wallet', label: 'Owner wallet', status: wallet?.ready ? 'PASS' : 'FAIL', detail: wallet?.ready ? (wallet.address ?? '') : 'connect the wallet that owns the deployment' },
    { id: 'owner', label: 'Signer is the owner', status: ownerMatch ? 'PASS' : 'FAIL', detail: owner ? `owner ${shortHash(owner, 8, 6)}` : 'owner unknown' },
  ];

  return (
    <SecurityConfirmation
      open
      onClose={onClose}
      onConfirm={() => {
        onClose();
        void execute(op);
      }}
      action={op === 'pause' ? 'Pause the agent on every chain' : 'Revoke the agent lease'}
      currentState={
        <span className="cl-row cl-row-wrap" style={{ gap: 6 }}>
          {chains.length
            ? chains.map((c) => (
                <StatusBadge key={c.chain} status={op === 'pause' ? (c.paused ? 'PAUSED' : 'ACTIVE') : c.leaseStatus === 1 ? 'ACTIVE' : c.leaseStatus === 2 ? 'REVOKED' : 'UNKNOWN'} label={`${chainLabel(c.chain)} · ${op === 'pause' ? (c.paused ? 'paused' : 'running') : (LEASE_STATUS[c.leaseStatus ?? 0] ?? 'unknown')}`} />
              ))
            : '—'}
        </span>
      }
      requestedState={op === 'pause' ? <StatusBadge status="PAUSED" label="Paused on every chain" /> : <StatusBadge status="REVOKED" label="Lease revoked on every chain" />}
      network={network}
      resource={op === 'pause' ? <span className="cl-mono">Amane account {runtime?.accountId ? shortHash(runtime.accountId, 10, 6) : '—'}</span> : <span className="cl-mono">Lease {runtime?.leaseId ? shortHash(runtime.leaseId, 10, 6) : '—'}</span>}
      extraRows={[{ label: 'Signatures', value: op === 'pause' ? `${chains.length} PauseAccount message${chains.length === 1 ? '' : 's'}, one per chain` : 'One RevokeLease message for every chain' }]}
      consequence={op === 'pause' ? 'Every agent action is refused on every chain until the owners sign an unpause.' : 'The agent key loses its authority on every chain immediately. This cannot be undone; a new lease requires a new deployment.'}
      actionLabel={op === 'pause' ? 'Sign and pause' : 'Sign and revoke'}
      preconditions={preconditions}
      busy={busy}
      disabledReason={!wallet ? 'Connect the owner wallet first.' : !ownerMatch ? 'The connected wallet is not the deployment owner.' : undefined}
    >
      {!wallet ? (
        <button type="button" className="cl-btn cl-btn-primary" onClick={requestConnect}>
          <Wallet size={13} aria-hidden />
          Connect the owner wallet
        </button>
      ) : null}
    </SecurityConfirmation>
  );
}

/* ----------------------------------------------------------------- result */

function RunResult({ run }: { run: ControlRun }) {
  return (
    <Section label={`Last control · ${OP_LABEL[run.op]}`} actions={<span className="cl-meta"><TimeAgo iso={run.at} /></span>}>
      {run.steps.length === 0 ? (
        <Card><p className="cl-meta">{run.outcome === 'RUNNING' ? 'Waiting for the owner wallet…' : run.error ?? 'Nothing was signed.'}</p></Card>
      ) : (
        <div className="cl-steps">
          {run.steps.map((st, i) => (
            <div className="cl-step" key={`${st.chain}-${i}`} style={{ cursor: 'default' }}>
              <span className="cl-step-index">{i + 1}</span>
              <span className="cl-step-name">{chainName(st.chain)}</span>
              <span className="cl-step-status"><StatusBadge status={st.status} label={st.label} /></span>
              <span className="cl-step-detail">
                {st.detail}
                {st.tx && st.chain !== 'all' ? <> · <a href={explorerTx(st.chain, st.tx)} target="_blank" rel="noreferrer">{shortHash(st.tx, 10, 6)}</a></> : null}
              </span>
            </div>
          ))}
          {run.outcome === 'RUNNING' ? <div className="cl-step"><span className="cl-meta">Working… confirm each request in your wallet.</span></div> : null}
        </div>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ tiles */

function Tile({ title, status, statusLabel, tint, children }: { title: string; status: Status | string; statusLabel?: string; tint?: 'warn' | 'deny'; children: ReactNode }) {
  return (
    <div className="cl-card" style={{ borderColor: tint ? `var(--cl-${tint})` : undefined }}>
      <div className="cl-card-head" style={{ background: tint ? `var(--cl-${tint}-bg)` : undefined }}>
        <div className="cl-card-title">{title}</div>
        <StatusBadge status={status} label={statusLabel} />
      </div>
      <div className="cl-card-body">{children}</div>
    </div>
  );
}

function DeploymentTile({ runtime, dep, s }: { runtime: Runtime; dep: DeploymentStatus | undefined; s: ProjectSummary }) {
  const d = dep?.deployment;
  const stale = d && s.revision !== null && d.blueprintRevision !== s.revision;
  return (
    <Tile title="Deployment" status={runtime.status === 'ACTIVE' ? (stale ? 'STALE' : 'ACTIVE') : 'PENDING'} statusLabel={stale ? 'stale' : (runtime.status ?? undefined)?.toLowerCase()} tint={stale ? 'warn' : undefined}>
      <KeyValue
        rows={[
          { label: 'Account id', value: runtime.accountId ? <span style={{ whiteSpace: 'nowrap' }}>{shortHash(runtime.accountId, 6, 4)}</span> : '—', mono: true },
          { label: 'Owner', value: runtime.owner ? <span style={{ whiteSpace: 'nowrap' }}>{shortHash(runtime.owner, 6, 4)}</span> : '—', mono: true },
          { label: 'Lease', value: runtime.leaseId ? <span style={{ whiteSpace: 'nowrap' }}>{shortHash(runtime.leaseId, 6, 4)}</span> : 'not issued', mono: true },
          { label: 'Deployed from', value: d ? `blueprint r${d.blueprintRevision}` : '—' },
          { label: 'Current blueprint', value: s.revision !== null ? `r${s.revision}` : '—' },
        ]}
      />
    </Tile>
  );
}

function ChainTile({ c }: { c: RuntimeChain }) {
  const lease = LEASE_STATUS[c.leaseStatus ?? -1] ?? 'unknown';
  const status: Status | string = c.error ? 'UNAVAILABLE' : c.paused ? 'PAUSED' : c.leaseStatus === 2 ? 'REVOKED' : c.leaseStatus === 1 ? 'HEALTHY' : 'DEGRADED';
  const tint = c.error || c.leaseStatus === 2 ? 'deny' : c.paused || c.leaseStatus !== 1 ? 'warn' : undefined;
  return (
    <Tile title={chainLabel(c.chain)} status={status} tint={tint}>
      {c.error ? <p className="cl-meta" style={{ whiteSpace: 'normal', marginBottom: 8, color: 'var(--cl-deny)' }}>{c.error}</p> : null}
      <KeyValue
        rows={[
          { label: 'Account', value: c.account ? <a href={explorerAccount(c.chain, c.account)} target="_blank" rel="noreferrer" style={{ whiteSpace: 'nowrap' }}>{shortHash(c.account, 6, 4)}</a> : 'pending', mono: true },
          { label: 'Paused', value: c.paused === null ? '—' : c.paused ? <Badge tone="warn">yes</Badge> : 'no' },
          { label: 'Pause epoch', value: c.pauseEpoch ?? '—', mono: true },
          { label: 'Lease', value: c.leaseStatus === null ? '—' : <Badge tone={c.leaseStatus === 1 ? 'pass' : c.leaseStatus === 2 ? 'deny' : 'blocked'}>{lease}</Badge> },
          { label: 'Policy version', value: c.policyVersion ?? '—', mono: true },
          ...c.balances.map((b) => ({ label: b.symbol, value: formatUnits(b.amount, b.decimals), mono: true })),
        ]}
      />
    </Tile>
  );
}

/* ------------------------------------------------------------ command log */

function CommandLog({ events, loading, error }: { events: ProjectEvent[]; loading: boolean; error: string | null }) {
  const [type, setType] = useState('');
  const [chain, setChain] = useState('');
  const [q, setQ] = useState('');
  const types = useMemo(() => [...new Set(events.map((e) => e.type))].sort(), [events]);
  const chains = useMemo(() => [...new Set(events.map((e) => e.chain).filter((c): c is string => Boolean(c)))].sort(), [events]);
  const rows = useMemo(
    () =>
      [...events]
        .reverse()
        .filter((e) => (!type || e.type === type) && (!chain || e.chain === chain) && (!q || `${e.type} ${e.detail} ${e.tx ?? ''}`.toLowerCase().includes(q.toLowerCase()))),
    [events, type, chain, q],
  );
  const controls = events.filter((e) => e.type.startsWith('control.')).length;

  return (
    <Section label="Command log" actions={<span className="cl-meta">{events.length} event{events.length === 1 ? '' : 's'} · {controls} owner control{controls === 1 ? '' : 's'}</span>}>
      {loading ? (
        <Skeleton height={80} />
      ) : error ? (
        <BlockerBanner tone="deny" title="The activity log could not be read">{error}</BlockerBanner>
      ) : events.length === 0 ? (
        <EmptyState title="No commands yet" body="Deployment steps, owner controls and wallet transactions are recorded here as they happen." />
      ) : (
        <Card flush>
          <div className="cl-row cl-row-wrap" style={{ gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--cl-line)' }}>
            <select className="cl-select" value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type" style={{ width: 'auto' }}>
              <option value="">All types</option>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="cl-select" value={chain} onChange={(e) => setChain(e.target.value)} aria-label="Filter by chain" style={{ width: 'auto' }}>
              <option value="">All chains</option>
              {chains.map((c) => <option key={c} value={c}>{chainLabel(c)}</option>)}
            </select>
            <input className="cl-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search detail or tx" aria-label="Search the log" style={{ flex: '1 1 200px', width: 'auto' }} />
            {type || chain || q ? <button type="button" className="cl-btn cl-btn-sm" onClick={() => { setType(''); setChain(''); setQ(''); }}>Clear</button> : null}
            <span className="cl-meta">{rows.length} shown</span>
          </div>
          <div className="cl-table-scroll">
            <table className="cl-table" style={{ minWidth: 700 }}>
              <thead>
                <tr>
                  <th style={{ width: 100 }}>When</th>
                  <th style={{ width: 180 }}>Type</th>
                  <th style={{ width: 130 }}>Chain</th>
                  <th>Detail</th>
                  <th style={{ width: 130 }}>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e, i) => (
                  <tr key={`${e.at}-${i}`}>
                    <td className="cl-meta" title={new Date(e.at).toLocaleString()}><TimeAgo iso={new Date(e.at).toISOString()} /></td>
                    <td className="cl-mono" style={{ fontSize: 11.5 }}>
                      {e.type.startsWith('control.') ? <Badge tone="warn">{e.type}</Badge> : e.type}
                    </td>
                    <td>{e.chain ? chainLabel(e.chain) : '—'}</td>
                    <td style={{ whiteSpace: 'normal' }}>{e.detail}</td>
                    <td>{e.tx && e.chain ? <a className="cl-mono" href={explorerTx(e.chain, e.tx)} target="_blank" rel="noreferrer">{shortHash(e.tx, 8, 6)}</a> : '—'}</td>
                  </tr>
                ))}
                {rows.length === 0 ? <tr><td colSpan={5} className="cl-meta">No event matches the filter.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </Section>
  );
}
