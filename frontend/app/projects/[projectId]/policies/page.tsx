'use client';

/**
 * Authority: the owner policy and agent lease Kido compiles for each chain. After a build the
 * self-model is the source (it adds how each action is enforced); before, the blueprint.
 */
import { StudioPage } from '@/components/studio/PageScaffold';
import { Card, KeyValue } from '@/components/studio/primitives';
import { NotYet, WithProject, useKido } from '@/components/studio/kido';
import { useSelfModel } from '@/lib/kido/hooks';
import { amount, chainLabel, windowLabel } from '@/lib/kido/format';

export default function AuthorityPage() {
  const { s, id } = useKido();
  const sm = useSelfModel(id, Boolean(s?.blueprint));
  return (
    <StudioPage segment="policies">
      <WithProject>
        {(s) => {
          const bp = s.blueprint;
          if (!bp) return <NotYet what="authority" where="composer" id={s.projectId} />;
          const a = bp.authority;
          return (
            <div className="cl-stack" style={{ gap: 16 }}>
              {bp.chains.map((c) => (
                <Card key={c} title={`${chainLabel(c)} · owner policy and lease`}>
                  <KeyValue
                    rows={[
                      { label: 'Allowed actions', value: a.allowedActions.join(', ') || 'None' },
                      ...a.limits.filter((l) => l.chain === c).map((l) => ({ label: `Limit · ${l.asset}`, value: `${amount(l.perAction, l.asset, c, bp.assets)} per action · ${amount(l.perWindow, l.asset, c, bp.assets)} per ${windowLabel(l.windowSeconds)} · ${amount(l.total, l.asset, c, bp.assets)} total` })),
                      { label: 'Payees', value: a.payees.filter((p) => p.chain === c).map((p) => `${p.label} ${p.address}`).join('\n') || 'None' },
                      { label: 'Beneficiaries', value: a.beneficiaries.filter((p) => p.chain === c).map((p) => `${p.label} ${p.address}`).join('\n') || 'None' },
                      { label: 'Swap floors', value: a.swapFloors.filter((f) => f.chain === c).map((f) => `${f.assetIn} → ${f.assetOut} ≥ ${f.minOutPerIn}`).join(', ') || 'None' },
                      { label: 'Lease lifetime', value: windowLabel(a.leaseLifetimeSeconds) },
                    ]}
                  />
                </Card>
              ))}
              {sm.data ? (
                <Card title="How each action is enforced">
                  <table className="cl-table">
                    <thead>
                      <tr><th>Action</th><th>Chain</th><th>Provider</th><th>Adapter</th><th>Enforcement</th></tr>
                    </thead>
                    <tbody>
                      {sm.data.execution.map((e) => (
                        <tr key={`${e.action}${e.chain}`}>
                          <td>{e.action}</td>
                          <td>{chainLabel(e.chain)}</td>
                          <td>{e.providerId} {e.providerVersion}</td>
                          <td>{e.adapter ? `${e.adapter.name} v${e.adapter.version}` : 'core'}</td>
                          <td>{e.enforcement.join('; ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {sm.data.capabilitiesNotAvailable.length ? <p className="cl-meta">Not available: {sm.data.capabilitiesNotAvailable.join(', ')}</p> : null}
                </Card>
              ) : null}
            </div>
          );
        }}
      </WithProject>
    </StudioPage>
  );
}
