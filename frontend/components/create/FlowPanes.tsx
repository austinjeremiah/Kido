'use client';

/**
 * The create flow's later panes, all from what the backend holds: interview templates, the agent's
 * identity plan (the agent's names and one subname per specialist), the review of agents, names,
 * policies and rates, the lifecycle checks, and the mainnet running cost per provider.
 */
import { Check, ExternalLink, Loader, Minus, X } from 'lucide-react';
import type { CostEstimate, CostLine, InterviewTemplateInfo, ProjectSummary } from '@/lib/kido/types';
import { amount, chainLabel, windowLabel } from '@/lib/kido/format';

const usd = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: n < 10 ? 2 : 0 });

/* ── describe: templates ── */
export function TemplatePicker({ templates, onUse, busy }: { templates: InterviewTemplateInfo[]; onUse: (t: InterviewTemplateInfo) => void; busy: boolean }) {
  return (
    <div className="kf-stack">
      <p className="kc-boxes__count">Start from a template</p>
      {templates.map((t) => (
        <div key={t.id} className="kf-card kf-template">
          <div className="kf-card__head">
            <span className="kf-card__title">{t.name}</span>
            <span className="kf-chip" data-tone="pass">{t.questions.length} questions</span>
          </div>
          <p className="kf-body">{t.description}</p>
          <div className="kf-chips">{t.highlights.map((h) => <span key={h} className="kf-chip">{h}</span>)}</div>
          <ol className="kf-questions">{t.questions.map((q) => <li key={q}>{q}</li>)}</ol>
          <button type="button" className="cl-btn cl-btn-primary" disabled={busy} onClick={() => onUse(t)}>Use this template</button>
        </div>
      ))}
      <p className="kf-meta">Or describe your own agent on the left; Kido interviews you for anything it needs.</p>
    </div>
  );
}

/* ── identity ── */
export function IdentityPane({ s, plan: override }: { s: ProjectSummary; plan?: ProjectSummary['identityPlan'] }) {
  const plan = override ?? s.identityPlan;
  const roots = plan.filter((b) => !b.role);
  const roles = [...new Set(plan.filter((b) => b.role).map((b) => b.role!))];
  if (!plan.length) return <p className="kf-meta">This agent has no public identity. Give it one on the left to publish ENS and SuiNS names.</p>;
  return (
    <div className="kf-stack">
      <p className="kc-boxes__count">What people will look up</p>
      <div className="kf-card">
        <div className="kf-card__head"><span className="kf-card__title">The agent</span></div>
        {roots.map((b) => <NameRow key={b.name} name={b.name} provider={b.providerId} blocked={b.liveCapable === false} />)}
      </div>
      <div className="kf-grid">
        {roles.map((r) => (
          <div key={r} className="kf-card">
            <div className="kf-card__head"><span className="kf-card__title">{r}</span></div>
            {plan.filter((b) => b.role === r).map((b) => <NameRow key={b.name} name={b.name} provider={b.providerId} blocked={b.liveCapable === false} />)}
          </div>
        ))}
      </div>
      <p className="kf-meta">Names are discovery only: each carries the agent id and its role, never authority. Authority comes from the owner policy.</p>
    </div>
  );
}

function NameRow({ name, provider, blocked }: { name: string; provider: string; blocked?: boolean }) {
  return (
    <div className="kf-name">
      <span className="kf-chip" data-tone={provider === 'ens' ? 'data' : 'sim'}>{provider === 'ens' ? 'ENS' : 'SuiNS'}</span>
      <span className="kf-mono">{name}</span>
      {blocked ? <span className="kf-chip" data-tone="warn">registration blocked on testnet</span> : null}
    </div>
  );
}

/* ── review: agents, names, policies, rates ── */
export function ReviewPane({ s }: { s: ProjectSummary }) {
  const bp = s.blueprint;
  if (!bp) return null;
  const a = bp.authority;
  const names = (role?: string) => s.identityPlan.filter((b) => (role ? b.role === role : !b.role));
  return (
    <div className="kf-stack">
      <section>
        <p className="kc-boxes__count">{bp.agents.length} agents</p>
        <div className="kf-grid">
          {bp.agents.map((ag) => (
            <div key={ag.role} className="kf-card">
              <div className="kf-card__head"><span className="kf-card__title">{ag.role}</span><span className="kf-chip" data-tone="pass">{ag.owns.join(', ') || 'observes'}</span></div>
              {names(ag.role).map((b) => <NameRow key={b.name} name={b.name} provider={b.providerId} />)}
              <p className="kf-meta">{ag.knowledgePacks.length} knowledge packs{ag.mayRequest.length ? ` · may ask for ${ag.mayRequest.join(', ')}` : ''}</p>
            </div>
          ))}
        </div>
      </section>

      {names().length ? (
        <section>
          <p className="kc-boxes__count">Identity</p>
          <div className="kf-card">{names().map((b) => <NameRow key={b.name} name={b.name} provider={b.providerId} blocked={b.liveCapable === false} />)}</div>
        </section>
      ) : null}

      <section>
        <p className="kc-boxes__count">Policy</p>
        <div className="kf-card kf-kv">
          <Row k="Authority" v={`${(a.mode ?? '').replace(/_/g, ' ').toLowerCase()} · enforced by ${a.provider ?? '—'}`} />
          <Row k="Acts" v={a.autonomy ? a.autonomy.replace(/_/g, ' ').toLowerCase() : '—'} />
          <Row k="Chains" v={bp.chains.map(chainLabel).join(' + ')} />
          <Row k="Allowed" v={a.allowedActions.join(', ')} tone="pass" />
          <Row k="Never" v={a.forbiddenActions.join(', ')} tone="deny" />
          <Row k="Pays only" v={a.payees.map((p) => `${p.label} (${chainLabel(p.chain)})`).join(', ') || 'nobody'} />
          {a.beneficiaries.length ? <Row k="Repays only" v={a.beneficiaries.map((b) => `${b.label} ${b.address.slice(0, 6)}…${b.address.slice(-4)}`).join(', ')} /> : null}
          <Row k="Bridging" v={a.bridgeAllowed ? 'yes, only to its own account on the other chain' : 'no'} />
          <Row k="Lease" v={`${windowLabel(a.leaseLifetimeSeconds)}, renewable, revocable by you at any time`} />
          {bp.monitors.map((m) => <Row key={m.id} k="Monitor" v={`${m.metric.replace(/_/g, ' ').toLowerCase()} ${m.op === 'LT' ? 'below' : 'above'} ${m.thresholdPrivateRef ? 'your private threshold' : m.threshold} → ${m.action ?? m.response}`} />)}
          {bp.privacy.required ? <Row k="Private" v={bp.privacy.values.map((v) => `${String(v.description)} (hidden from ${(v.hiddenFrom as string[]).join(', ').toLowerCase().replace(/_/g, ' ')})`).join('; ')} /> : null}
          <Row k="If a step fails" v={String(bp.recovery.onPartialExecution ?? '—').replace(/_/g, ' ').toLowerCase()} />
        </div>
      </section>

      <section>
        <p className="kc-boxes__count">Rates</p>
        <div className="kf-card">
          <table className="kf-table">
            <thead><tr><th>Chain</th><th>Token</th><th>Per action</th><th>Per {windowLabel(a.limits[0]?.windowSeconds ?? 3600)}</th><th>Total</th></tr></thead>
            <tbody>
              {a.limits.map((l) => (
                <tr key={`${l.chain}:${l.asset}`}>
                  <td>{chainLabel(l.chain)}</td>
                  <td className="kf-mono">{l.asset}</td>
                  <td>{amount(l.perAction, l.asset, l.chain, bp.assets)}</td>
                  <td>{amount(l.perWindow, l.asset, l.chain, bp.assets)}</td>
                  <td>{amount(l.total, l.asset, l.chain, bp.assets)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {a.swapFloors.length ? (
            <>
              <p className="kf-label">Worst swap rate accepted</p>
              {a.swapFloors.map((f) => <p key={`${f.chain}${f.assetIn}${f.assetOut}`} className="kf-body">{chainLabel(f.chain)}: at least {f.minOutPerIn} {f.assetOut} per {f.assetIn}</p>)}
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: 'pass' | 'deny' }) {
  return (
    <div className="kf-row">
      <span className="kf-label">{k}</span>
      <span className="kf-body" data-tone={tone}>{v}</span>
    </div>
  );
}

/* ── checks ── */
export type CheckState = 'todo' | 'running' | 'pass' | 'fail';
export function ChecksPane({ s, states }: { s: ProjectSummary | null; states: Record<'security' | 'simulation' | 'build', CheckState> }) {
  const rows: { key: 'security' | 'simulation' | 'build'; title: string; detail: string }[] = [
    { key: 'security', title: 'Security review', detail: s?.security ? `${s.security.findings.length} findings, ${s.security.findings.filter((f) => f.blocking).length} blocking` : 'Deterministic review of every permission' },
    { key: 'simulation', title: 'Simulation', detail: s?.simulation ? `${s.simulation.results.filter((r) => r.passed).length}/${s.simulation.results.length} scenarios held, including attacks` : 'Allowed actions and attacks that must be refused' },
    { key: 'build', title: 'Build', detail: s?.build ? `${s.build.agents.length} agents built, ${s.build.agents.reduce((n, a) => n + a.contextChars, 0).toLocaleString()} context chars` : 'Agents, monitors, authority and identity' },
  ];
  return (
    <div className="kf-stack">
      {rows.map((r) => (
        <div key={r.key} className="kf-card kf-check" data-state={states[r.key]}>
          <span className="kf-check__icon">{states[r.key] === 'pass' ? <Check size={14} /> : states[r.key] === 'fail' ? <X size={14} /> : states[r.key] === 'running' ? <Loader size={14} className="kc-spin" /> : <Minus size={14} />}</span>
          <div>
            <div className="kf-card__title">{r.title}</div>
            <p className="kf-meta">{r.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── costs ── */
/** Provider logos, served from /public/logos (Nautilus and Seal are Sui-stack services). */
const LOGO: Record<string, string> = {
  'uniswap-v3': '/logos/uniswap.png', 'aave-v3': '/logos/aave.png', 'cetus-clmm': '/logos/cetus.png', ens: '/logos/ens.png', suins: '/logos/suins.png',
  'the-graph': '/logos/the-graph.png', wormhole: '/logos/wormhole.png', nautilus: '/logos/sui.jpg', seal: '/logos/sui.jpg',
  'openai-model': '/logos/openai.png', 'alchemy-rpc': '/logos/alchemy.png', 'chainlink-cre': '/logos/chainlink.png',
};

function ProviderLogo({ id, name }: { id: string; name: string }) {
  const src = LOGO[id];
  return src ? <img className="kf-logo" src={src} alt="" width={28} height={28} /> : <span className="kf-logo kf-logo--mono" aria-hidden>{name.slice(0, 1)}</span>;
}

const CATEGORY: Record<CostLine['category'], string> = { authority: 'Authority', protocol: 'Protocol', transport: 'Bridge', identity: 'Identity', privacy: 'Privacy', infrastructure: 'Infrastructure' };

export function CostsPane({ est, included, onToggle, actions, onActions, renewals, onRenewals }: { est: CostEstimate; included: Set<string>; onToggle: (id: string) => void; actions: Record<string, number>; onActions: (a: Record<string, number>) => void; renewals: number; onRenewals: (n: number) => void }) {
  const counted = est.lines.filter((l) => !l.optional || included.has(l.id));
  const monthly = counted.reduce((n, l) => n + l.monthlyUsd, 0);
  const once = counted.reduce((n, l) => n + l.oneTimeUsd, 0);
  const order: CostLine['category'][] = ['protocol', 'transport', 'identity', 'privacy', 'authority', 'infrastructure'];
  const lines = [...est.lines].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  return (
    <div className="kf-stack">
      <p className="kf-meta">{est.note}</p>
      <div className="kf-assume">
        <span className="kf-label">Actions per month</span>
        {Object.entries(actions).map(([k, v]) => (
          <label key={k} className="kf-assume__item">
            <span>{k}</span>
            <input className="cl-input" type="number" min={0} max={10000} value={v} onChange={(e) => onActions({ ...actions, [k]: Math.max(0, Number(e.target.value) || 0) })} />
          </label>
        ))}
        <label className="kf-assume__item" title="The agent acts only while its lease is active. A short lease is safer but costs a renewal each time it is re-activated; a longer lease means fewer renewals.">
          <span>lease renewals</span>
          <input className="cl-input" type="number" min={0} max={10000} value={renewals} onChange={(e) => onRenewals(Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <span className="kf-presets" role="group" aria-label="Lease presets">
          {([['1 h lease, always on', 730], ['renew daily', 30], ['7-day lease', 5], ['30-day lease', 1]] as const).map(([label, n]) => (
            <button key={label} type="button" className="kf-preset" data-on={renewals === n ? '' : undefined} onClick={() => onRenewals(n)}>{label}</button>
          ))}
        </span>
        <span className="kf-meta">Gas at {est.market.ethGasGwei} gwei, ETH ${est.market.ethUsd.toLocaleString()} ({est.market.asOf}); Amane gas as measured on Sepolia. The shared Amane contracts are already deployed; each agent only deploys its own account.</span>
      </div>
      <div className="kf-grid">
        {lines.map((l) => {
          const on = !l.optional || included.has(l.id);
          return (
            <div key={l.id} className="kf-card kf-cost" data-off={on ? undefined : ''}>
              <div className="kf-card__head">
                <span className="kf-card__who"><ProviderLogo id={l.id} name={l.name} /><span className="kf-card__title">{l.name}</span></span>
                <span className="kf-chip" data-tone={l.paid ? 'warn' : 'pass'}>{l.paid ? 'Paid' : l.monthlyUsd + l.oneTimeUsd > 0 ? 'No protocol fee · gas' : 'Free'}</span>
              </div>
              <span className="kf-cat">{CATEGORY[l.category]}{l.optional ? ' · recommended for mainnet' : ''}</span>
              <div className="kf-cost__price">
                <span className="kf-cost__big">{l.items.length === 0 && l.model === 'PROVIDER_PRICED' ? 'By quote' : usd(l.monthlyUsd)}</span>{l.items.length === 0 && l.model === 'PROVIDER_PRICED' ? null : <span className="kf-meta">/ month</span>}
                {l.oneTimeUsd ? <span className="kf-meta kf-cost__once">+ {usd(l.oneTimeUsd)} one-time</span> : null}
              </div>
              <p className="kf-body">{l.summary}</p>
              <p className="kf-meta">{l.reason}</p>
              {l.items.length ? (
                <details className="kf-items">
                  <summary>How this is calculated</summary>
                  {l.items.map((i) => (
                    <div key={i.label} className="kf-item">
                      <span>{i.label}</span>
                      <span className="kf-mono">{usd(i.usd)}{i.recurring ? '/mo' : ' once'}</span>
                      <span className="kf-meta">{i.basis}</span>
                    </div>
                  ))}
                </details>
              ) : null}
              <div className="kf-sources">
                {l.sources.filter((x) => /^https?:/.test(x.url)).map((x) => <a key={x.url} href={x.url} target="_blank" rel="noreferrer">{x.label}<ExternalLink size={10} aria-hidden /></a>)}
              </div>
              {l.optional ? (
                <label className="kf-toggle"><input type="checkbox" checked={on} onChange={() => onToggle(l.id)} /> Include in the total</label>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="kf-total">
        <div>
          <span className="kf-label">Estimated running cost</span>
          <span className="kf-total__big">{usd(monthly)}<span className="kf-meta"> / month</span></span>
        </div>
        <div>
          <span className="kf-label">One-time setup</span>
          <span className="kf-total__mid">{usd(once)}</span>
        </div>
        <div>
          <span className="kf-label">Services in the total</span>
          <span className="kf-total__mid">{counted.filter((l) => l.paid).length} paid · {counted.filter((l) => !l.paid).length} no-fee</span>
          <span className="kf-meta">{est.lines.filter((l) => l.optional && !included.has(l.id)).length ? `${est.lines.filter((l) => l.optional && !included.has(l.id)).length} optional add-ons not included` : 'every add-on included'}</span>
        </div>
      </div>
    </div>
  );
}
