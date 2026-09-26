'use client';

/**
 * Providers: every provider Kido can select, with its implementation status and what it has
 * actually proven. Providers this blueprint uses are listed first.
 */
import { useState } from 'react';
import { EvidenceList } from '@/components/studio/Evidence';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, Card, Skeleton, TabStrip } from '@/components/studio/primitives';
import { useKido } from '@/components/studio/kido';
import { useRegistry } from '@/lib/kido/hooks';
import { chainLabel } from '@/lib/kido/format';
import type { ProviderRow } from '@/lib/kido/types';
import type { Tone } from '@/lib/studio/types';

const TONE: Record<string, Tone> = { TESTNET_LIVE: 'pass', LIVE_ATTESTED: 'pass', IMPLEMENTED_LOCAL: 'data', SIMULATED: 'sim', NOT_IMPLEMENTED: 'neutral', BLOCKED_ENV: 'blocked', BLOCKED_AUTH: 'blocked', BLOCKED_UPSTREAM: 'blocked' };

function Provider({ p, used }: { p: ProviderRow; used: boolean }) {
  const i = p.implementation;
  return (
    <Card title={<span>{p.providerId} <span className="cl-meta">· {p.kind} · {p.chains.map(chainLabel).join(', ')}</span></span>} actions={<span className="cl-row" style={{ gap: 6 }}>{used ? <Badge tone="data">used here</Badge> : null}<Badge tone={TONE[i.status] ?? 'neutral'}>{i.status}</Badge></span>}>
      {p.statusNote ? <p className="cl-meta" style={{ marginTop: 0 }}>{p.statusNote}</p> : null}
      {i.proven.length ? (
        <>
          <p className="cl-label">Proven</p>
          <ul className="cl-body" style={{ marginTop: 4 }}>{i.proven.map((x) => <li key={x}>{x}</li>)}</ul>
        </>
      ) : null}
      {i.notProven.length ? (
        <>
          <p className="cl-label">Not proven</p>
          <ul className="cl-body" style={{ marginTop: 4 }}>{i.notProven.map((x) => <li key={x}>{x}</li>)}</ul>
        </>
      ) : null}
      {i.blocker ? <p className="cl-meta">Blocked ({i.blocker.type}): {i.blocker.actionRequired}</p> : null}
      {i.evidence.length || i.blocker?.evidence ? (
        <>
          <p className="cl-label">Evidence</p>
          <EvidenceList items={[...i.evidence, ...(i.blocker?.evidence ? [i.blocker.evidence] : [])]} />
        </>
      ) : null}
      {Object.keys(p.capabilityStatus).length ? (
        <p className="cl-meta">{Object.entries(p.capabilityStatus).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>
      ) : null}
    </Card>
  );
}

export default function ProvidersPage() {
  const { s } = useKido();
  const reg = useRegistry();
  const [tab, setTab] = useState<'all' | 'used'>('all');
  const used = new Set([...(s?.blueprint?.protocols.map((p) => p.providerId) ?? []), ...(s?.blueprint?.privacy.providers.map((p) => p.providerId) ?? []), ...(s?.blueprint?.identity.bindings.map((b) => b.provider) ?? []), ...(s?.blueprint?.authority.provider === 'AMANE' ? ['amane'] : [])]);
  const rows = [...(reg.data ?? [])].sort((a, b) => Number(used.has(b.providerId)) - Number(used.has(a.providerId)));
  return (
    <StudioPage segment="integrations">
      <TabStrip tabs={[{ id: 'all', label: `All providers (${rows.length})` }, { id: 'used', label: `Used by this agent (${rows.filter((r) => used.has(r.providerId)).length})` }]} active={tab} onChange={setTab} />
      {reg.isLoading ? <Skeleton height={120} /> : null}
      <div className="cl-stack" style={{ gap: 12 }}>
        {rows.filter((r) => tab === 'all' || used.has(r.providerId)).map((p) => <Provider key={p.providerId} p={p} used={used.has(p.providerId)} />)}
      </div>
    </StudioPage>
  );
}
