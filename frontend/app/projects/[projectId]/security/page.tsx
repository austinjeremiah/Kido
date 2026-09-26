'use client';

/** Permissions & Security: what the agent can and can never do, and the deterministic review. */
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, Card, EmptyState, SeverityBadge, StaleBanner } from '@/components/studio/primitives';
import { GateButton, NotYet, WithProject } from '@/components/studio/kido';
import { amount, chainLabel, windowLabel } from '@/lib/kido/format';
import type { Severity } from '@/lib/studio/types';

export default function SecurityPage() {
  return (
    <StudioPage segment="security" actions={<GateButton gate="securityReview" primary />}>
      <WithProject>
        {(s) => {
          const bp = s.blueprint;
          if (!bp) return <NotYet what="blueprint" where="composer" id={s.projectId} />;
          const a = bp.authority;
          return (
            <>
              {s.security?.freshness === 'STALE' ? <StaleBanner what="security review" builtAgainst={s.security.blueprintRevision} current={bp.revision} /> : null}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 16 }}>
                <Card title="Can do">
                  {a.allowedActions.length ? a.allowedActions.map((x) => <p key={x} className="cl-body" style={{ margin: '4px 0' }}>✓ {x}</p>) : <p className="cl-meta">Nothing: read-only.</p>}
                  {a.limits.map((l) => (
                    <p key={`${l.chain}${l.asset}`} className="cl-meta" style={{ margin: '4px 0' }}>
                      {chainLabel(l.chain)}: at most {amount(l.perAction, l.asset, l.chain, bp.assets)} per action, {amount(l.perWindow, l.asset, l.chain, bp.assets)} per {windowLabel(l.windowSeconds)}
                    </p>
                  ))}
                </Card>
                <Card title="Can never do">
                  {a.forbiddenActions.map((x) => <p key={x} className="cl-body" style={{ margin: '4px 0' }}>✕ {x}</p>)}
                  <p className="cl-meta">Pay anyone who is not a pinned payee; widen its own limits; hold a root key.</p>
                </Card>
                <Card title="Who it can pay">
                  {[...a.payees, ...a.beneficiaries].length ? [...a.payees, ...a.beneficiaries].map((p) => (
                    <p key={`${p.chain}${p.address}`} className="cl-body" style={{ margin: '4px 0' }}>{p.label} <span className="cl-meta">· {chainLabel(p.chain)} · {p.address}</span></p>
                  )) : <p className="cl-meta">No one.</p>}
                </Card>
              </div>
              <Card title={`Security review${s.security ? ` · revision ${s.security.blueprintRevision}` : ''}`} actions={s.security ? <Badge tone={s.security.blocking ? 'deny' : 'pass'}>{s.security.blocking ? 'blocking' : 'not blocking'}</Badge> : null}>
                {!s.security ? (
                  <EmptyState title="Not reviewed yet" body="Run the security review for this revision." />
                ) : s.security.findings.length === 0 ? (
                  <p className="cl-body">No findings for this revision.</p>
                ) : (
                  <table className="cl-table">
                    <thead>
                      <tr><th>Finding</th><th>Class</th><th>Severity</th><th>Evidence</th></tr>
                    </thead>
                    <tbody>
                      {s.security.findings.map((f) => (
                        <tr key={f.id}>
                          <td className="cl-mono">{f.id}{f.blocking ? ' · blocking' : ''}</td>
                          <td>{f.class}</td>
                          <td><SeverityBadge severity={f.severity as Severity} /></td>
                          <td>{f.evidence}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </>
          );
        }}
      </WithProject>
    </StudioPage>
  );
}
