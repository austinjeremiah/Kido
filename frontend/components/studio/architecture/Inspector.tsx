'use client';

/**
 * Architecture node inspector. Every fact comes from the node's blueprint entry, the build, the
 * agent's self-model (execution facts, provider evidence, monitor health) and — once deployed —
 * the chains' own readings via the runtime endpoint. A value that is not known is left out rather
 * than shown as a dash.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Badge, Spec, StatusBadge } from '@/components/studio/primitives';
import { LEASE_STATUS, amount, chainLabel, explorerAccount, valueText, windowLabel } from '@/lib/kido/format';
import type { ProjectSummary, ProviderRow, Runtime, SelfModel } from '@/lib/kido/types';
import type { Status } from '@/lib/studio/types';
import { EDGE_KIND, type GEdge, type GNode, type Graph } from './graph';

type Row = { key: string; label: string; value: ReactNode; note?: ReactNode };

function List({ items, tone }: { items: string[]; tone?: 'pass' | 'warn' | 'deny' | 'neutral' | 'data' }) {
  if (!items.length) return <span className="cl-meta">none</span>;
  return (
    <span className="cl-row cl-row-wrap" style={{ gap: 6 }}>
      {items.map((i) => (
        <Badge key={i} tone={tone ?? 'neutral'}>{i}</Badge>
      ))}
    </span>
  );
}

function Bullets({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="cl-label" style={{ marginBottom: 6 }}>{label}</div>
      <ul style={{ margin: 0, paddingLeft: 18 }} className="cl-meta">
        {items.map((i) => (
          <li key={i} style={{ whiteSpace: 'normal', marginBottom: 3 }}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

const ext = (href: string, text: string) => (
  <a className="cl-mono" href={href} target="_blank" rel="noreferrer">{text}</a>
);

export function NodeInspector({
  node,
  graph,
  status,
  s,
  sm,
  rt,
  registry,
  onSelect,
}: {
  node: GNode;
  graph: Graph;
  status: Status;
  s: ProjectSummary;
  sm: SelfModel | undefined;
  rt: Runtime | undefined;
  registry: ProviderRow[];
  onSelect: (id: string) => void;
}) {
  const bp = s.blueprint!;
  const id = s.projectId;
  const ref = node.ref;
  const rows: Row[] = [];
  const extra: ReactNode[] = [];
  const links: Array<{ href: string; label: string }> = [{ href: `/projects/${id}/blueprint`, label: 'Blueprint' }];
  const deployed = rt?.deployed === true;
  const rc = (chain: string) => rt?.chains.find((c) => c.chain === chain);
  const providerFacts = (pid: string) => {
    const r = registry.find((x) => x.providerId === pid);
    const p = sm?.providers.find((x) => x.providerId === pid);
    if (r) {
      rows.push({ key: 'reg-kind', label: 'Provider kind', value: r.kind });
      rows.push({ key: 'reg-status', label: 'Registry status', value: <StatusBadge status={r.status} />, note: r.statusNote });
      rows.push({ key: 'reg-chains', label: 'Chains', value: r.chains.map(chainLabel).join(', ') });
      const caps = Object.entries(r.capabilityStatus);
      if (caps.length) rows.push({ key: 'reg-caps', label: 'Capabilities', value: <span className="cl-row cl-row-wrap" style={{ gap: 6 }}>{caps.map(([k, v]) => <Badge key={k} tone={v.includes('LIVE') ? 'pass' : 'neutral'}>{`${k} · ${v}`}</Badge>)}</span> });
    }
    const proven = p?.proven ?? r?.implementation.proven ?? [];
    const notProven = p?.notProven ?? r?.implementation.notProven ?? [];
    const dnp = p?.doesNotProvide ?? r?.implementation.doesNotProvide ?? [];
    if (p) rows.push({ key: 'sm-role', label: 'Role in this agent', value: p.role, note: p.statusMeaning });
    const blocker = p?.blocker ?? (r?.implementation.blocker ? `${r.implementation.blocker.type}: ${r.implementation.blocker.actionRequired}` : null);
    if (blocker) rows.push({ key: 'blocker', label: 'Blocker', value: <span style={{ color: 'var(--cl-deny)' }}>{blocker}</span> });
    extra.push(<Bullets key="proven" label="Proven" items={proven} />, <Bullets key="notp" label="Not proven" items={notProven} />, <Bullets key="dnp" label="Does not provide" items={dnp} />);
    links.push({ href: `/projects/${id}/integrations`, label: 'Integrations' });
  };
  const limitRows = (chain: string) => {
    bp.authority.limits.filter((l) => l.chain === chain).forEach((l, i) => {
      const readable = sm?.authority.limits.find((x) => x.chain === l.chain && x.asset === l.asset)?.readable;
      rows.push({
        key: `limit-${i}`,
        label: `Limit · ${l.asset}`,
        value: readable ?? `${amount(l.perAction, l.asset, chain, bp.assets)} per action · ${amount(l.perWindow, l.asset, chain, bp.assets)} per ${windowLabel(l.windowSeconds)} · ${amount(l.total, l.asset, chain, bp.assets)} total`,
      });
    });
  };
  const chainReadings = (chain: string) => {
    const c = rc(chain);
    if (!deployed) {
      rows.push({ key: 'deployed', label: 'On-chain', value: <span className="cl-meta">Not deployed; readings appear once the agent is deployed.</span> });
      return;
    }
    if (!c) return;
    if (c.error) rows.push({ key: 'rerr', label: 'Read error', value: <span style={{ color: 'var(--cl-deny)' }}>{c.error}</span> });
    if (c.policyVersion !== null) rows.push({ key: 'pv', label: 'Policy version', value: `v${c.policyVersion}` });
    if (c.paused !== null) rows.push({ key: 'paused', label: 'Paused', value: c.paused ? <Badge tone="warn">paused</Badge> : <Badge tone="pass">running</Badge>, note: c.pauseEpoch !== null ? `pause epoch ${c.pauseEpoch}` : undefined });
    if (c.leaseStatus !== null) rows.push({ key: 'lease', label: 'Lease', value: LEASE_STATUS[c.leaseStatus] ?? String(c.leaseStatus) });
  };

  switch (ref.type) {
    case 'owner': {
      rows.push({ key: 'mode', label: 'Authority mode', value: bp.authority.mode ?? '—' });
      rows.push({ key: 'autonomy', label: 'Autonomy', value: bp.authority.autonomy ?? '—' });
      if (rt?.owner) rows.push({ key: 'owner', label: 'Owner wallet', value: <span className="cl-mono">{rt.owner}</span> });
      if (rt?.accountId) rows.push({ key: 'acct', label: 'Account id', value: <span className="cl-mono">{rt.accountId}</span> });
      if (!deployed) rows.push({ key: 'nd', label: 'Owner wallet', value: <span className="cl-meta">Set when the owner deploys.</span> });
      rows.push({ key: 'recovery', label: 'Recovery', value: valueText(bp.recovery) });
      links.push({ href: `/projects/${id}/deploy`, label: 'Deploy' });
      break;
    }
    case 'policy': {
      rows.push({ key: 'chain', label: 'Chain', value: chainLabel(ref.chain) });
      rows.push({ key: 'allowed', label: 'Allowed actions', value: <List items={bp.authority.allowedActions} tone="pass" /> });
      rows.push({ key: 'forbidden', label: 'Forbidden actions', value: <List items={bp.authority.forbiddenActions} tone="deny" /> });
      if (s.build?.authority.excludedActions.length) rows.push({ key: 'excluded', label: 'Excluded at build', value: <List items={s.build.authority.excludedActions} tone="warn" /> });
      limitRows(ref.chain);
      const payees = bp.authority.payees.filter((p) => p.chain === ref.chain);
      if (payees.length) rows.push({ key: 'payees', label: 'Payees', value: <span className="cl-stack" style={{ gap: 2 }}>{payees.map((p) => <span key={p.address}>{p.label} <span className="cl-mono cl-meta">{p.address}</span></span>)}</span> });
      bp.authority.swapFloors.filter((f) => f.chain === ref.chain).forEach((f, i) => rows.push({ key: `floor-${i}`, label: 'Swap floor', value: `${f.assetIn} → ${f.assetOut} ≥ ${f.minOutPerIn} per unit` }));
      rows.push({ key: 'bridge', label: 'Bridging', value: bp.authority.bridgeAllowed ? 'allowed (bound by cross-chain policy)' : 'not allowed' });
      if (s.build?.authority.crossChainTotal && Object.keys(s.build.authority.crossChainTotal).length) {
        rows.push({ key: 'cct', label: 'Cross-chain total', value: Object.entries(s.build.authority.crossChainTotal).map(([a, v]) => amount(v, a, ref.chain, bp.assets)).join(', ') });
      }
      if (sm) rows.push({ key: 'active', label: 'Amane active', value: sm.authority.amaneActive ? <Badge tone="pass">yes</Badge> : <Badge tone="neutral">not yet</Badge> });
      chainReadings(ref.chain);
      links.push({ href: `/projects/${id}/policies`, label: 'Policies' });
      break;
    }
    case 'lease': {
      rows.push({ key: 'chain', label: 'Chain', value: chainLabel(ref.chain) });
      rows.push({ key: 'life', label: 'Lifetime', value: windowLabel(bp.authority.leaseLifetimeSeconds) });
      rows.push({ key: 'grants', label: 'Granted to', value: <List items={bp.agents.filter((a) => graph.edges.some((e) => e.source === node.id && e.target === `agent:${a.role}`)).map((a) => a.role)} /> });
      if (rt?.leaseId) rows.push({ key: 'lid', label: 'Lease id', value: <span className="cl-mono">{rt.leaseId}</span> });
      if (sm && typeof sm.authority.lease === 'string') rows.push({ key: 'smlease', label: 'Self-model lease', value: sm.authority.lease });
      chainReadings(ref.chain);
      links.push({ href: `/projects/${id}/runtime`, label: 'Runtime' });
      break;
    }
    case 'agent': {
      const a = bp.agents.find((x) => x.role === ref.role)!;
      const b = s.build?.agents.find((x) => x.role === ref.role);
      rows.push({ key: 'owns', label: 'Owns', value: <List items={a.owns} tone="pass" /> });
      rows.push({ key: 'may', label: 'May request', value: <List items={a.mayRequest} tone="warn" /> });
      rows.push({ key: 'by', label: 'Requested by', value: <List items={bp.agents.filter((x) => x.mayRequest.includes(a.role)).map((x) => x.role)} /> });
      rows.push({ key: 'packs', label: 'Knowledge packs', value: <List items={a.knowledgePacks} /> });
      if (b) {
        rows.push({ key: 'ctx', label: 'Context size', value: `${b.contextChars.toLocaleString()} chars` });
        rows.push({ key: 'missing', label: 'Missing packs', value: b.missingPacks.length ? <List items={b.missingPacks} tone="deny" /> : <Badge tone="pass">none</Badge> });
      } else rows.push({ key: 'nb', label: 'Build', value: <span className="cl-meta">Not built yet.</span> });
      links.push({ href: `/projects/${id}/code?role=${encodeURIComponent(a.role)}`, label: 'Exact context' }, { href: `/projects/${id}/organization`, label: 'Organization' });
      break;
    }
    case 'account': {
      const c = rc(ref.chain);
      rows.push({ key: 'chain', label: 'Chain', value: chainLabel(ref.chain) });
      if (c?.account) rows.push({ key: 'addr', label: 'Account', value: ext(explorerAccount(ref.chain, c.account), c.account) });
      chainReadings(ref.chain);
      if (c?.balances.length) rows.push({ key: 'bal', label: 'Balances', value: <span className="cl-stack" style={{ gap: 2 }}>{c.balances.map((x) => <span key={x.symbol}>{amount(x.amount, x.symbol, ref.chain, bp.assets)}</span>)}</span> });
      const assets = bp.assets.filter((x) => x.chain === ref.chain);
      if (assets.length) rows.push({ key: 'assets', label: 'Assets', value: <span className="cl-stack" style={{ gap: 2 }}>{assets.map((x) => <span key={String(x.symbol)}>{String(x.symbol)} <span className="cl-mono cl-meta">{String(x.ref ?? '')}</span></span>)}</span> });
      limitRows(ref.chain);
      links.push({ href: `/projects/${id}/runtime`, label: 'Runtime' });
      break;
    }
    case 'action': {
      const x = sm?.execution.find((e) => e.action === ref.action && e.chain === ref.chain);
      rows.push({ key: 'chain', label: 'Chain', value: chainLabel(ref.chain) });
      rows.push({ key: 'provider', label: 'Provider', value: ref.providerId });
      rows.push({ key: 'det', label: 'Deterministic', value: ref.deterministic ? 'yes' : 'no' });
      rows.push({ key: 'owners', label: 'Owned by', value: <List items={bp.agents.filter((a) => a.owns.includes(ref.action)).map((a) => a.role)} /> });
      if (x) {
        rows.push({ key: 'adapter', label: 'Adapter', value: x.adapter ? `${x.adapter.name} v${x.adapter.version}` : <span className="cl-meta">no adapter pinned</span> });
        rows.push({ key: 'pver', label: 'Provider version', value: x.providerVersion });
        Object.entries(x.upstream).forEach(([k, v]) => rows.push({ key: `up-${k}`, label: `Upstream · ${k}`, value: <span className="cl-mono">{valueText(v)}</span> }));
        extra.push(<Bullets key="enf" label="Enforcement" items={x.enforcement} />);
      } else if (!sm) rows.push({ key: 'nosm', label: 'Execution facts', value: <span className="cl-meta">Self-model unavailable.</span> });
      limitRows(ref.chain);
      links.push({ href: `/projects/${id}/policies`, label: 'Policies' }, { href: `/projects/${id}/simulation`, label: 'Simulation' });
      break;
    }
    case 'protocol': {
      const p = bp.protocols.find((x) => x.providerId === ref.providerId && x.chain === ref.chain);
      rows.push({ key: 'chain', label: 'Chain', value: chainLabel(ref.chain) });
      if (p?.version) rows.push({ key: 'ver', label: 'Version', value: valueText(p.version) });
      if (Array.isArray(p?.capabilities)) rows.push({ key: 'caps', label: 'Used capabilities', value: <List items={p!.capabilities as string[]} /> });
      sm?.execution.filter((e) => e.providerId === ref.providerId && e.chain === ref.chain).forEach((e, i) => {
        rows.push({ key: `ex-${i}`, label: `Action · ${e.action}`, value: e.adapter ? `${e.adapter.name} v${e.adapter.version}` : 'no adapter pinned', note: e.enforcement.join(' · ') });
      });
      const ds = bp.dataSources.filter((d) => d.providerId === ref.providerId);
      if (ds.length) rows.push({ key: 'ds', label: 'Feeds data sources', value: <List items={ds.map((d) => String(d.id))} tone="data" /> });
      providerFacts(ref.providerId);
      if (sm?.upstreamChangePolicy) rows.push({ key: 'ucp', label: 'Upstream changes', value: <span style={{ whiteSpace: 'normal' }}>{sm.upstreamChangePolicy}</span> });
      break;
    }
    case 'payee': {
      rows.push({ key: 'label', label: ref.beneficiary ? 'Beneficiary' : 'Payee', value: ref.label });
      rows.push({ key: 'chain', label: 'Chain', value: chainLabel(ref.chain) });
      rows.push({ key: 'addr', label: 'Address', value: ext(explorerAccount(ref.chain, ref.address), ref.address) });
      links.push({ href: `/projects/${id}/policies`, label: 'Policies' });
      break;
    }
    case 'data': {
      const d = bp.dataSources.find((x) => String(x.id) === ref.id) ?? {};
      Object.entries(d).filter(([k]) => k !== 'id').forEach(([k, v]) => rows.push({ key: k, label: k, value: k === 'chain' && v ? chainLabel(String(v)) : valueText(v) }));
      rows.push({ key: 'mons', label: 'Monitors', value: <List items={bp.monitors.filter((m) => m.dataSource === ref.id).map((m) => m.id)} tone="data" /> });
      if (sm?.failureBehaviour.oracleFailure) rows.push({ key: 'fail', label: 'On failure', value: sm.failureBehaviour.oracleFailure });
      break;
    }
    case 'monitor': {
      const m = bp.monitors.find((x) => x.id === ref.id)!;
      const h = sm?.monitors.find((x) => x.id === ref.id);
      rows.push({ key: 'src', label: 'Data source', value: m.dataSource });
      rows.push({ key: 'cond', label: 'Condition', value: `${m.metric} ${m.op} ${m.threshold ?? (m.thresholdPrivateRef ? `private (${m.thresholdPrivateRef})` : '—')}` });
      rows.push({ key: 'resp', label: 'Response', value: m.response });
      if (m.action) rows.push({ key: 'act', label: 'Action', value: m.action });
      if (m.target) rows.push({ key: 'tgt', label: 'Target', value: `${m.target.share} of ${m.target.asset}` });
      const trig = bp.triggers.filter((t) => t.monitor === m.id);
      if (trig.length) rows.push({ key: 'trig', label: 'Triggers', value: <List items={trig.map((t) => `${t.id} (${t.kind})`)} /> });
      if (h) rows.push({ key: 'health', label: 'Health', value: <StatusBadge status={h.health} /> });
      break;
    }
    case 'identity': {
      const b = bp.identity.bindings.find((x) => x.provider === ref.provider && x.chain === ref.chain);
      const planned = s.build?.identity.find((x) => x.providerId === ref.provider && x.chain === ref.chain) ?? s.identityPlan.find((x) => x.providerId === ref.provider && x.chain === ref.chain);
      rows.push({ key: 'name', label: 'Name', value: <span className="cl-mono">{ref.name ?? 'not chosen'}</span> });
      if (b) rows.push({ key: 'status', label: 'Binding', value: <StatusBadge status={b.status} /> });
      if (planned?.parent) rows.push({ key: 'parent', label: 'Parent', value: <span className="cl-mono">{planned.parent}</span> });
      const records = planned?.records as Record<string, unknown> | undefined;
      if (records) rows.push({ key: 'records', label: 'Records', value: <List items={Object.keys(records)} tone="data" /> });
      if (typeof planned?.liveCapable === 'boolean') rows.push({ key: 'live', label: 'Live-capable', value: planned.liveCapable ? 'yes' : 'no' });
      if (Array.isArray(planned?.blockers) && planned.blockers.length) extra.push(<Bullets key="ib" label="Blockers" items={(planned.blockers as unknown[]).map(valueText)} />);
      providerFacts(ref.provider);
      links.push({ href: `/projects/${id}/identity`, label: 'Identity' });
      break;
    }
    case 'privacy': {
      const p = bp.privacy.providers.find((x) => x.providerId === ref.providerId && x.chain === ref.chain);
      rows.push({ key: 'chain', label: 'Chain', value: chainLabel(ref.chain) });
      if (p) {
        rows.push({ key: 'caps', label: 'Capabilities', value: <List items={p.capabilities} /> });
        rows.push({ key: 'sat', label: 'Satisfies', value: <List items={p.satisfies} tone="pass" /> });
      }
      sm?.privacy.protectedInputs.filter((x) => x.protectedBy.includes(ref.providerId)).forEach((x) => rows.push({ key: `pi-${x.id}`, label: `Protects · ${x.id}`, value: `${x.kind}; hidden from ${x.hiddenFrom.join(', ')}`, note: `plaintext only in ${x.plaintextMayExistIn}; may leave: ${x.mayLeave}` }));
      providerFacts(ref.providerId);
      break;
    }
    case 'transport': {
      const cc = (bp.crossChain ?? {}) as { maxAmountPerIntent?: Array<{ asset: string; amount: string }>; recoveryDeadlineSeconds?: number };
      rows.push({ key: 'chains', label: 'Between', value: bp.chains.map(chainLabel).join(' ⇄ ') });
      (cc.maxAmountPerIntent ?? []).forEach((m, i) => rows.push({ key: `max-${i}`, label: `Max per intent · ${m.asset}`, value: amount(m.amount, m.asset, bp.chains[0] ?? '', bp.assets) }));
      if (cc.recoveryDeadlineSeconds) rows.push({ key: 'rec', label: 'Recovery deadline', value: windowLabel(cc.recoveryDeadlineSeconds) });
      if (sm?.failureBehaviour.bridgeTimeout) rows.push({ key: 'bt', label: 'On timeout', value: sm.failureBehaviour.bridgeTimeout });
      providerFacts(ref.providerId);
      break;
    }
  }
  links.push({ href: `/projects/${id}/activity`, label: 'Activity' }, { href: `/projects/${id}/reality`, label: 'Reality' });

  const labelFor = (nid: string) => graph.nodes.find((n) => n.id === nid)?.data.label ?? nid;
  const outgoing = graph.edges.filter((e) => e.source === node.id);
  const incoming = graph.edges.filter((e) => e.target === node.id);
  const conn = (e: GEdge, dir: 'in' | 'out') => {
    const other = dir === 'out' ? e.target : e.source;
    return (
      <button key={`${dir}-${e.id}`} type="button" className="cl-conn" data-incoming={dir === 'in' ? '' : undefined} onClick={() => onSelect(other)} style={{ background: 'none', border: 0, textAlign: 'left', cursor: 'pointer', width: '100%' }}>
        <span className="cl-conn-dir" aria-label={dir === 'out' ? 'to' : 'from'}>{dir === 'out' ? '→' : '←'}</span>
        <span className="cl-conn-verb" style={{ color: EDGE_KIND[e.kind].tone }}>{e.label}</span>
        <span className="cl-conn-node">{labelFor(other)}</span>
      </button>
    );
  };

  return (
    <div className="cl-col" style={{ gap: 18 }}>
      <div>
        <div className="cl-h1">{node.data.label}</div>
        <p className="cl-meta" style={{ marginTop: 6, whiteSpace: 'normal' }}>{node.data.purpose}</p>
        <div className="cl-row cl-row-wrap" style={{ gap: 8, marginTop: 10 }}>
          <StatusBadge status={status} />
          <Badge tone="neutral">{ref.type}</Badge>
          {node.data.chainTag ? <Badge tone="sim">{node.data.chainTag}</Badge> : null}
        </div>
      </div>
      {rows.length ? <Spec rows={rows} /> : null}
      {extra}
      {outgoing.length || incoming.length ? (
        <div>
          <div className="cl-label" style={{ marginBottom: 7 }}>Connections</div>
          <div className="cl-conns">
            {outgoing.map((e) => conn(e, 'out'))}
            {incoming.map((e) => conn(e, 'in'))}
          </div>
        </div>
      ) : null}
      <div className="cl-row cl-row-wrap" style={{ gap: 6 }}>
        {links.map((l) => (
          <Link key={l.href} className="cl-btn cl-btn-sm" href={l.href}>{l.label}</Link>
        ))}
      </div>
    </div>
  );
}
