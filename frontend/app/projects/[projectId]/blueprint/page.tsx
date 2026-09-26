'use client';

/** Blueprint: the canonical revision everything compiles from, as fields and as the raw document. */
import { useState } from 'react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, CopyButton, Section, Spec, TabStrip } from '@/components/studio/primitives';
import { NotYet, WithProject } from '@/components/studio/kido';
import { amount, chainLabel, windowLabel } from '@/lib/kido/format';

export default function BlueprintPage() {
  const [tab, setTab] = useState<'fields' | 'json'>('fields');
  return (
    <StudioPage segment="blueprint">
      <WithProject>
        {(s) => {
          const bp = s.blueprint;
          if (!bp) return <NotYet what="blueprint" where="composer" id={s.projectId} />;
          const a = bp.authority;
          const amt = (v: string, asset: string, chain: string) => amount(v, asset, chain, bp.assets);
          return (
            <>
              {s.blockers.length ? (
                <BlockerBanner tone="deny" title={`${s.blockers.length} build blocker${s.blockers.length === 1 ? '' : 's'}`}>
                  {s.blockers.map((b) => `${b.code}: ${b.detail}`).join(' · ')}
                </BlockerBanner>
              ) : null}
              <div className="cl-row" style={{ gap: 8, marginBottom: 12 }}>
                <Badge tone="data">revision {bp.revision}</Badge>
                <Badge tone="neutral">{bp.kidoAgentId}</Badge>
                {s.blueprintHash ? <CopyButton value={s.blueprintHash} label="Copy hash" /> : null}
              </div>
              <TabStrip tabs={[{ id: 'fields', label: 'Fields' }, { id: 'json', label: 'Document' }]} active={tab} onChange={setTab} />
              {tab === 'json' ? (
                <pre className="cl-mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: '70vh', overflow: 'auto' }} data-lenis-prevent>
                  {JSON.stringify(bp, null, 2)}
                </pre>
              ) : (
                <>
                  <Section label="Objective and scope">
                    <Spec
                      rows={[
                        { key: 'objective', label: 'Objective', value: bp.objective.statement, note: bp.objective.summary ?? undefined, ok: true },
                        { key: 'chains', label: 'Chains', value: bp.chains.map(chainLabel).join(' · ') || '—', ok: bp.chains.length > 0 },
                        { key: 'protocols', label: 'Protocols', value: bp.protocols.map((p) => `${p.providerId} (${chainLabel(p.chain)})`).join(', ') || 'None' },
                        { key: 'assets', label: 'Assets', value: bp.assets.map((x) => `${x.symbol} (${chainLabel(String(x.chain))})`).join(', ') || 'None' },
                        { key: 'agents', label: 'Agents', value: bp.agents.map((x) => `${x.role}: owns ${x.owns.join(', ') || 'nothing'}`).join(' · ') || 'None' },
                      ]}
                    />
                  </Section>
                  <Section label="Authority">
                    <Spec
                      rows={[
                        { key: 'mode', label: 'Mode', value: `${a.mode ?? '—'}${a.autonomy ? ` · ${a.autonomy.toLowerCase()}` : ''}`, ok: Boolean(a.mode) },
                        { key: 'provider', label: 'Enforced by', value: a.provider === 'AMANE' ? 'Amane (on-chain)' : a.provider === 'OWNER_WALLET' ? 'Owner wallet' : '—' },
                        { key: 'allowed', label: 'Allowed actions', value: a.allowedActions.join(', ') || 'None' },
                        { key: 'forbidden', label: 'Forbidden', value: a.forbiddenActions.join(', ') || 'None' },
                        ...a.limits.map((l, i) => ({ key: `limit-${i}`, label: `Limit · ${chainLabel(l.chain)}`, value: `${amt(l.perAction, l.asset, l.chain)} per action · ${amt(l.perWindow, l.asset, l.chain)} per ${windowLabel(l.windowSeconds)} · ${amt(l.total, l.asset, l.chain)} total`, ok: true })),
                        { key: 'payees', label: 'Payees', value: a.payees.map((p) => `${p.label} (${chainLabel(p.chain)}) ${p.address}`).join('\n') || 'None' },
                        { key: 'beneficiaries', label: 'Beneficiaries', value: a.beneficiaries.map((p) => `${p.label} (${chainLabel(p.chain)}) ${p.address}`).join('\n') || 'None' },
                        { key: 'bridge', label: 'Bridging', value: a.bridgeAllowed ? 'Allowed' : 'Not allowed' },
                        { key: 'lease', label: 'Lease lifetime', value: windowLabel(a.leaseLifetimeSeconds) },
                      ]}
                    />
                  </Section>
                  <Section label="Monitors and triggers">
                    <Spec rows={bp.monitors.length ? bp.monitors.map((m) => ({ key: m.id, label: m.id, value: `${m.metric} ${m.op} ${m.threshold ?? (m.thresholdPrivateRef ? '(private threshold)' : '—')}`, note: `${m.response.toLowerCase().replace(/_/g, ' ')}${m.action ? ` → ${m.action}` : ''}` })) : [{ key: 'none', label: 'Monitors', value: 'None' }]} />
                  </Section>
                  <Section label="Identity and privacy">
                    <Spec
                      rows={[
                        { key: 'identity', label: 'Public identity', value: bp.identity.bindings.map((b) => `${b.name ?? '(planned)'} · ${b.provider.toUpperCase()} · ${b.status.toLowerCase()}`).join('\n') || 'None' },
                        { key: 'privacy', label: 'Privacy', value: bp.privacy.required ? bp.privacy.providers.map((p) => `${p.providerId} (${chainLabel(p.chain)}): ${p.capabilities.join(', ')}`).join('\n') || 'Required' : 'Not required' },
                      ]}
                    />
                  </Section>
                </>
              )}
            </>
          );
        }}
      </WithProject>
    </StudioPage>
  );
}
