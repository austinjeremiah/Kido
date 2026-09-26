'use client';

/**
 * Privacy & CRE: which privacy providers exist, what Kido has actually proven about each, and what
 * this agent's privacy plan uses.
 *
 * Everything on this page comes from the provider registry (status, status note, implementation
 * evidence, blocker) and the project (Blueprint privacy section, compiled privacy plan, self-model
 * protected inputs). Claims are stated separately and only as the registry states them: a
 * simulated or locally-implemented provider is never shown as live, and a blocked provider shows
 * exactly what the registry says is required to unblock it.
 */
import { useMemo } from 'react';
import Link from 'next/link';
import { EyeOff, FileCheck2, ShieldCheck, ShieldOff, ShieldQuestion } from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, Card, EmptyState, KeyValue, Section, Skeleton } from '@/components/studio/primitives';
import { WithProject } from '@/components/studio/kido';
import { useRegistry, useSelfModel } from '@/lib/kido/hooks';
import { chainLabel, valueText } from '@/lib/kido/format';
import type { ProjectSummary, ProviderRow } from '@/lib/kido/types';
import type { Tone } from '@/lib/studio/types';

/* ---------------------------------------------------------------- helpers */

/** Registry and implementation statuses, by what they claim. */
function statusTone(status: string | undefined): Tone {
  if (!status) return 'blocked';
  if (/BLOCKED|UNAVAILABLE|UNSATISFIABLE/.test(status)) return 'blocked';
  if (/LIVE|VERIFIED|SATISFIED$/.test(status)) return 'pass';
  if (/SIMULATED|PLANNING/.test(status)) return 'sim';
  if (/LOCAL|IMPLEMENTED/.test(status)) return 'data';
  if (/DEPRECATED|STALE|FAIL/.test(status)) return 'warn';
  return 'neutral';
}
const S = (s: string) => s.replace(/_/g, ' ');
const camel = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

type Impl = ProviderRow['implementation'] & { facts?: Record<string, unknown> };

interface PlanValue {
  valueId: string;
  chain: string | null;
  requiredCapabilities: string[];
  selected: string[];
  status: string;
  reasons: string[];
  trust?: Array<{ providerId: string; protects?: string[]; verifies?: string[]; requiresTrustIn?: string[]; doesNotProtectAgainst?: string[] }>;
  plaintextBoundary?: string;
  allowedDisclosure?: string;
}
interface PlanShape {
  required?: boolean;
  values?: PlanValue[];
  providers?: Array<{ providerId: string; chain: string | null; capabilities: string[]; satisfies: string[] }>;
  liveBlockers?: string[];
}

function List({ items, empty, tone }: { items: string[]; empty: string; tone?: 'pass' | 'warn' | 'deny' }) {
  if (!items.length) return <p className="cl-meta" style={{ margin: 0 }}>{empty}</p>;
  const color = tone ? `var(--cl-${tone})` : 'var(--cl-ink-3)';
  return (
    <ul className="cl-col" style={{ gap: 6, margin: 0, padding: 0, listStyle: 'none' }}>
      {items.map((i) => (
        <li key={i} className="cl-row" style={{ gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.45 }}>
          <span style={{ color, flex: '0 0 auto' }}>{tone === 'pass' ? '✓' : tone === 'deny' ? '✕' : '·'}</span>
          <span>{i}</span>
        </li>
      ))}
    </ul>
  );
}

function Chips({ items, tone = 'neutral' }: { items: string[]; tone?: Tone }) {
  if (!items.length) return <span className="cl-meta">—</span>;
  return (
    <span className="cl-row cl-row-wrap" style={{ gap: 4 }}>
      {items.map((i) => <Badge key={i} tone={tone}>{S(i)}</Badge>)}
    </span>
  );
}

/* --------------------------------------------------------------- sections */

function TruthMatrix({ providers }: { providers: ProviderRow[] }) {
  const rows = providers.flatMap((p) =>
    Object.entries((p.implementation as Impl).facts ?? {})
      .filter(([, v]) => typeof v === 'boolean')
      .map(([k, v]) => ({ provider: p.providerId, fact: k, value: v as boolean })),
  );
  return (
    <Card>
      <div className="cl-path">
        {providers.map((p) => (
          <div className="cl-path-step" key={p.providerId}>
            <span className="cl-path-step-name cl-mono">{p.providerId}</span>
            <span className="cl-step-status">
              <Badge tone={statusTone(p.implementation.status)} large>{S(p.implementation.status)}</Badge>
            </span>
            <span className="cl-path-step-detail">
              {p.implementation.proven.length} proven · {p.implementation.notProven.length} not proven
              {p.implementation.doesNotProvide?.length ? ` · ${p.implementation.doesNotProvide.length} out of scope` : ''}
              {p.implementation.blocker ? ` · blocked: ${S(p.implementation.blocker.type)}` : ''}
            </span>
          </div>
        ))}
        {rows.map((r) => (
          <div className="cl-path-step" key={`${r.provider}.${r.fact}`}>
            <span className="cl-path-step-name">{camel(r.fact)}</span>
            <span className="cl-step-status">
              <Badge tone={r.value ? 'pass' : 'blocked'} large>{r.value ? 'YES' : 'NO'}</Badge>
            </span>
            <span className="cl-path-step-detail cl-mono">{r.provider}</span>
          </div>
        ))}
      </div>
      <p className="cl-meta" style={{ marginTop: 12 }}>
        The implementation status is what Kido has demonstrated about its own integration, which can be weaker than the provider&apos;s registry status. Each YES/NO above is a fact the registry records for that
        integration; a simulated run is never counted as a live one.
      </p>
    </Card>
  );
}

function ProviderCard({ p, usedBy }: { p: ProviderRow; usedBy: string[] }) {
  const impl = p.implementation as Impl;
  const caps = Object.entries(p.capabilityStatus ?? {});
  const facts = Object.entries(impl.facts ?? {});
  return (
    <Card
      title={
        <span className="cl-row cl-row-wrap" style={{ gap: 8 }}>
          {statusTone(p.status) === 'pass' ? <ShieldCheck size={14} aria-hidden /> : statusTone(p.status) === 'blocked' ? <ShieldOff size={14} aria-hidden /> : <ShieldQuestion size={14} aria-hidden />}
          <span className="cl-mono">{p.providerId}</span>
          {usedBy.length ? <Badge tone="data">used by this agent</Badge> : null}
        </span>
      }
      actions={
        <span className="cl-row" style={{ gap: 6 }}>
          <Badge tone={statusTone(p.status)} title="Registry status">{S(p.status)}</Badge>
          <Badge tone={statusTone(impl.status)} title="Implementation status">impl · {S(impl.status)}</Badge>
        </span>
      }
    >
      <KeyValue
        rows={[
          { label: 'Chains', value: p.chains.map(chainLabel).join(' · ') || '—' },
          { label: 'Status note', value: p.statusNote ?? '—' },
          ...(usedBy.length ? [{ label: 'Satisfies here', value: <Chips items={usedBy} tone="data" /> }] : []),
          ...(facts.length ? [{ label: 'Facts', value: <span className="cl-row cl-row-wrap" style={{ gap: 4 }}>{facts.map(([k, v]) => <Badge key={k} tone={v === true ? 'pass' : v === false ? 'blocked' : 'neutral'}>{camel(k)}: {valueText(v)}</Badge>)}</span> }] : []),
        ]}
      />
      {impl.blocker ? (
        <div style={{ marginTop: 12 }}>
          <BlockerBanner tone="warn" title={`Blocked · ${S(impl.blocker.type)}`}>
            <div><strong>Required:</strong> {impl.blocker.actionRequired}</div>
            <div className="cl-mono" style={{ fontSize: 11.5, marginTop: 4 }}>Evidence: {impl.blocker.evidence}</div>
          </BlockerBanner>
        </div>
      ) : null}
      <div className="cl-grid cl-grid-3" style={{ marginTop: 14, gap: 14 }}>
        <div>
          <div className="cl-label" style={{ marginBottom: 6 }}>Proven</div>
          <List items={impl.proven} empty="Nothing proven yet." tone="pass" />
        </div>
        <div>
          <div className="cl-label" style={{ marginBottom: 6 }}>Not proven</div>
          <List items={impl.notProven} empty="No open claims." tone="deny" />
        </div>
        <div>
          <div className="cl-label" style={{ marginBottom: 6 }}>Does not provide</div>
          <List items={impl.doesNotProvide ?? []} empty="No exclusions recorded." />
        </div>
      </div>
      <div className="cl-grid cl-grid-2" style={{ marginTop: 14, gap: 14 }}>
        <div>
          <div className="cl-label" style={{ marginBottom: 6 }}>Capability status</div>
          {caps.length ? (
            <table className="cl-table">
              <tbody>
                {caps.map(([c, st]) => (
                  <tr key={c}>
                    <td className="cl-mono">{c}</td>
                    <td><Badge tone={statusTone(st)}>{S(st)}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="cl-meta" style={{ margin: 0 }}>No per-capability status recorded; the provider status applies to every capability.</p>
          )}
        </div>
        <div>
          <div className="cl-label" style={{ marginBottom: 6 }}>Evidence</div>
          {impl.evidence.length ? (
            <ul className="cl-col" style={{ gap: 4, margin: 0, padding: 0, listStyle: 'none' }}>
              {impl.evidence.map((e) => (
                <li key={e} className="cl-row" style={{ gap: 6, alignItems: 'flex-start' }}>
                  <FileCheck2 size={12} aria-hidden style={{ marginTop: 3, flex: '0 0 auto', color: 'var(--cl-ink-3)' }} />
                  <span className="cl-mono" style={{ fontSize: 11.5 }}>{e}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="cl-meta" style={{ margin: 0 }}>No evidence recorded.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function ProjectPlan({ s, registry }: { s: ProjectSummary; registry: ProviderRow[] }) {
  const sm = useSelfModel(s.projectId, Boolean(s.blueprint));
  const bp = s.blueprint;
  const plan = (s.privacyPlan ?? null) as PlanShape | null;
  if (!bp) return <EmptyState title="No privacy plan yet" body="The privacy plan is compiled with the Blueprint once the interview is finished." action={<Link className="cl-btn cl-btn-primary" href={`/projects/${s.projectId}/build`}>Open the Composer</Link>} />;
  const values = bp.privacy.values as Array<Record<string, unknown>>;
  const reg = (id: string) => registry.find((r) => r.providerId === id);
  const inputs = sm.data?.privacy.protectedInputs ?? [];

  return (
    <div className="cl-stack" style={{ gap: 16 }}>
      <Card title="Declared in the Blueprint" actions={<Badge tone={bp.privacy.required === null ? 'warn' : bp.privacy.required ? 'data' : 'neutral'}>{bp.privacy.required === null ? 'Privacy: undecided' : bp.privacy.required ? 'Privacy required' : 'No privacy required'}</Badge>}>
        {values.length ? (
          <div className="cl-table-scroll">
            <table className="cl-table" style={{ minWidth: 900 }}>
              <thead>
                <tr><th>Value</th><th>Kind</th><th>Hidden from</th><th>Plaintext boundary</th><th>Disclosure</th><th>On failure</th></tr>
              </thead>
              <tbody>
                {values.map((v) => (
                  <tr key={String(v.id)}>
                    <td>
                      <div className="cl-mono cl-strong">{String(v.id)}</div>
                      {v.description ? <div className="cl-meta">{String(v.description)}</div> : null}
                    </td>
                    <td><Badge tone="neutral">{S(String(v.kind))}</Badge></td>
                    <td><Chips items={(v.hiddenFrom as string[]) ?? []} tone="warn" /></td>
                    <td className="cl-mono">{S(String(v.plaintextBoundary ?? '—'))}</td>
                    <td className="cl-mono">{S(String(v.allowedDisclosure ?? '—'))}</td>
                    <td className="cl-mono">{S(String(v.failurePolicy ?? '—'))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="cl-body" style={{ margin: 0 }}>
            {bp.privacy.required === false
              ? 'The owner declared no private values for this agent, so no privacy provider is bound to it. Secrets that still pass through Kido are handled by the providers listed below as built in.'
              : 'No private values recorded yet.'}
          </p>
        )}
        {bp.privacy.providers.length ? (
          <>
            <div className="cl-label" style={{ margin: '16px 0 6px' }}>Provider bindings</div>
            <table className="cl-table">
              <thead>
                <tr><th>Provider</th><th>Chain</th><th>Capabilities</th><th>Satisfies</th><th>Registry status</th></tr>
              </thead>
              <tbody>
                {bp.privacy.providers.map((p) => (
                  <tr key={`${p.providerId}:${p.chain}`}>
                    <td className="cl-mono cl-strong">{p.providerId}</td>
                    <td>{p.chain ? chainLabel(p.chain) : 'any'}</td>
                    <td><Chips items={p.capabilities} /></td>
                    <td><Chips items={p.satisfies} tone="data" /></td>
                    <td>{reg(p.providerId) ? <Badge tone={statusTone(reg(p.providerId)!.status)}>{S(reg(p.providerId)!.status)}</Badge> : <Badge tone="deny">not in registry</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </Card>

      <Card title="Compiled privacy plan" actions={plan ? <Badge tone={plan.liveBlockers?.length ? 'warn' : 'neutral'}>{plan.liveBlockers?.length ? `${plan.liveBlockers.length} live blocker(s)` : 'no live blockers'}</Badge> : null}>
        {!plan ? (
          <p className="cl-meta" style={{ margin: 0 }}>No compiled plan.</p>
        ) : (
          <>
            {plan.values?.length ? (
              <div className="cl-table-scroll">
                <table className="cl-table" style={{ minWidth: 900 }}>
                  <thead>
                    <tr><th>Value</th><th>Chain</th><th>Needs</th><th>Selected</th><th>Status</th><th>Why</th></tr>
                  </thead>
                  <tbody>
                    {plan.values.map((v) => (
                      <tr key={`${v.valueId}:${v.chain}`}>
                        <td className="cl-mono cl-strong">{v.valueId}</td>
                        <td>{v.chain ? chainLabel(v.chain) : '—'}</td>
                        <td><Chips items={v.requiredCapabilities} /></td>
                        <td><Chips items={v.selected} tone="data" /></td>
                        <td><Badge tone={statusTone(v.status)}>{S(v.status)}</Badge></td>
                        <td className="cl-meta" style={{ whiteSpace: 'normal' }}>{v.reasons.join('; ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="cl-meta" style={{ margin: 0 }}>No values to compile{plan.required === false ? ' — privacy is not required for this agent' : ''}.</p>
            )}
            {plan.values?.some((v) => v.trust?.length) ? (
              <div style={{ marginTop: 14 }}>
                <div className="cl-label" style={{ marginBottom: 6 }}>Trust you accept</div>
                {plan.values.flatMap((v) => (v.trust ?? []).map((t) => ({ v: v.valueId, t }))).map(({ v, t }) => (
                  <KeyValue
                    key={`${v}:${t.providerId}`}
                    rows={[
                      { label: `${v} · ${t.providerId}`, value: '' },
                      { label: 'Protects', value: <Chips items={t.protects ?? []} tone="pass" /> },
                      { label: 'Verifies', value: <Chips items={t.verifies ?? []} /> },
                      { label: 'Requires trust in', value: <Chips items={t.requiresTrustIn ?? []} tone="warn" /> },
                      { label: 'Does not protect against', value: <Chips items={t.doesNotProtectAgainst ?? []} tone="deny" /> },
                    ]}
                  />
                ))}
              </div>
            ) : null}
            {plan.providers?.length ? (
              <div style={{ marginTop: 14 }}>
                <div className="cl-label" style={{ marginBottom: 6 }}>Providers the plan selects</div>
                <span className="cl-row cl-row-wrap" style={{ gap: 6 }}>
                  {plan.providers.map((p) => (
                    <Badge key={`${p.providerId}:${p.chain}`} tone={statusTone(reg(p.providerId)?.status)}>
                      {p.providerId}{p.chain ? ` · ${chainLabel(p.chain)}` : ''} · {p.capabilities.join(', ')}
                    </Badge>
                  ))}
                </span>
              </div>
            ) : null}
            {plan.liveBlockers?.length ? (
              <div style={{ marginTop: 14 }}>
                <BlockerBanner tone="warn" title="Live blockers">
                  <List items={plan.liveBlockers} empty="" />
                </BlockerBanner>
              </div>
            ) : null}
          </>
        )}
      </Card>

      <Card title={<span className="cl-row" style={{ gap: 6 }}><EyeOff size={14} aria-hidden /> Protected inputs (self-model)</span>}>
        {sm.isLoading ? (
          <Skeleton height={60} />
        ) : sm.error ? (
          <BlockerBanner tone="deny" title="Could not load the self-model">{(sm.error as Error).message}</BlockerBanner>
        ) : inputs.length ? (
          <div className="cl-table-scroll">
            <table className="cl-table" style={{ minWidth: 860 }}>
              <thead>
                <tr><th>Input</th><th>Kind</th><th>Hidden from</th><th>Plaintext may exist in</th><th>May leave as</th><th>Protected by</th></tr>
              </thead>
              <tbody>
                {inputs.map((i) => (
                  <tr key={i.id}>
                    <td className="cl-mono cl-strong">{i.id}</td>
                    <td><Badge tone="neutral">{S(i.kind)}</Badge></td>
                    <td><Chips items={i.hiddenFrom} tone="warn" /></td>
                    <td className="cl-mono">{S(i.plaintextMayExistIn)}</td>
                    <td className="cl-mono">{S(i.mayLeave)}</td>
                    <td>{i.protectedBy.length ? <Chips items={i.protectedBy} tone="data" /> : <Badge tone="deny">nothing</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="cl-meta" style={{ margin: 0 }}>
            The agent&apos;s self-model lists no protected inputs{sm.data?.privacy.required === false ? ': privacy is not required' : ''}. When asked, it answers that it holds no private values.
          </p>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------- page */

function Body({ s }: { s: ProjectSummary }) {
  const reg = useRegistry();
  const providers = useMemo(() => (reg.data ?? []).filter((p) => p.kind === 'privacy'), [reg.data]);
  const blocked = providers.filter((p) => /BLOCKED/.test(p.status) || p.implementation.blocker);
  const usedBy = (id: string) => [...new Set((s.blueprint?.privacy.providers ?? []).filter((b) => b.providerId === id).flatMap((b) => b.satisfies))];

  if (reg.isLoading) return <Skeleton height={200} />;
  if (reg.error) return <BlockerBanner tone="deny" title="Could not load the provider registry">{(reg.error as Error).message}</BlockerBanner>;

  return (
    <>
      {blocked.length ? (
        <div className="cl-stack" style={{ gap: 8, marginBottom: 16 }}>
          {blocked.map((p) => (
            <BlockerBanner key={p.providerId} tone="warn" title={`${p.providerId} is ${S(p.status)}${p.implementation.blocker ? ` · ${S(p.implementation.blocker.type)}` : ''}`}>
              {p.implementation.blocker ? <div><strong>Required:</strong> {p.implementation.blocker.actionRequired}</div> : null}
              {p.statusNote ? <div className="cl-meta" style={{ marginTop: 2 }}>{p.statusNote}</div> : null}
            </BlockerBanner>
          ))}
        </div>
      ) : null}

      <Section label="What is actually true">
        {providers.length ? <TruthMatrix providers={providers} /> : <EmptyState title="No privacy providers" body="The registry lists no provider of kind privacy." />}
      </Section>

      <Section label="Privacy providers">
        <div className="cl-stack" style={{ gap: 16 }}>
          {providers.map((p) => <ProviderCard key={p.providerId} p={p} usedBy={usedBy(p.providerId)} />)}
        </div>
      </Section>

      <Section label="This agent's privacy plan">
        <ProjectPlan s={s} registry={reg.data ?? []} />
      </Section>
    </>
  );
}

function Badges() {
  const reg = useRegistry();
  const providers = (reg.data ?? []).filter((p) => p.kind === 'privacy');
  if (!providers.length) return null;
  const by = (t: Tone) => providers.filter((p) => statusTone(p.status) === t).length;
  return (
    <>
      <Badge tone="neutral">{providers.length} privacy providers</Badge>
      {by('pass') ? <Badge tone="pass">{by('pass')} verified live</Badge> : null}
      {by('blocked') ? <Badge tone="blocked">{by('blocked')} blocked</Badge> : null}
      {by('sim') ? <Badge tone="sim">{by('sim')} simulated</Badge> : null}
    </>
  );
}

export default function CrePage() {
  return (
    <StudioPage segment="cre" title="Privacy & CRE" subtitle="Privacy providers as the registry proves them, and the privacy plan this agent compiled." badges={<Badges />}>
      <WithProject>{(s) => <Body s={s} />}</WithProject>
    </StudioPage>
  );
}
