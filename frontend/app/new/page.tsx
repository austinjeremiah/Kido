'use client';

/**
 * Agent creation, live against the Kido backend.
 *
 * Describe the agent in your own words (Kido interviews you) or pick a template (Kido asks only what
 * is personal to you: who to pay, whose loan, how much). Then name it — the agent and every
 * specialist get ENS and SuiNS names — review the agents, names, policies and rates, let the
 * security review, simulation and build run, and see the monthly running cost of every provider
 * before the final Continue. Every step is a backend call; nothing is decided on the client.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PromptComposer } from '@/components/create/PromptComposer';
import { CreateSteps, type CreateStepId } from '@/components/create/CreateSteps';
import { KidoRequirementBoxes } from '@/components/create/KidoPanes';
import { ChecksPane, CostsPane, IdentityPane, ReviewPane, TemplatePicker, type CheckState } from '@/components/create/FlowPanes';
import { EnsProfile, NameCheck, TemplateSetup, type SetupAnswers } from '@/components/create/EnsFlow';
import { EmptyState } from '@/components/studio/primitives';
import { COMPOSER_EXAMPLES } from '@/lib/studio/content/composer';
import { PROJECT_TEMPLATES } from '@/lib/studio/content/templates';
import { kido, KidoApiError } from '@/lib/kido/api';
import type { CostEstimate, InterviewTemplateInfo, ProjectSummary, Question } from '@/lib/kido/types';

type Stage = CreateStepId;
type Turn = { from: 'you' | 'kido'; text: string; note?: string };
const ORDER: Stage[] = ['DESCRIBE', 'QUESTIONS', 'IDENTITY', 'REVIEW', 'CHECKS', 'COSTS'];
const message = (e: unknown) => (e instanceof KidoApiError || e instanceof Error ? e.message : String(e));
const usd = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function CreateFlow() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('DESCRIBE');
  const [furthest, setFurthest] = useState<Stage>('DESCRIBE');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [label, setLabel] = useState('');
  const [org, setOrg] = useState('');
  const [checks, setChecks] = useState<Record<'security' | 'simulation' | 'build', CheckState>>({ security: 'todo', simulation: 'todo', build: 'todo' });
  const [costs, setCosts] = useState<CostEstimate | null>(null);
  const [actions, setActions] = useState<Record<string, number>>({});
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [templates, setTemplates] = useState<InterviewTemplateInfo[]>([]);
  const [setup, setSetup] = useState<InterviewTemplateInfo | null>(null);
  const [setupAnswers, setSetupAnswers] = useState<SetupAnswers | null>(null);
  useEffect(() => {
    kido.templates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  const params = useSearchParams();
  const seeded = (() => {
    const id = params.get('template');
    if (!id) return '';
    const t = PROJECT_TEMPLATES.find((x) => x.id === id);
    if (t?.prompt) return t.prompt;
    return COMPOSER_EXAMPLES.find((x) => x.id === id)?.body ?? '';
  })();

  const scroller = useRef<HTMLDivElement | null>(null);
  const goTo = useCallback((next: Stage) => {
    setStage(next);
    setFurthest((f) => (ORDER.indexOf(next) > ORDER.indexOf(f) ? next : f));
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  }, [turns]);
  const say = useCallback((...next: Turn[]) => setTurns((t) => [...t, ...next]), []);
  const refresh = useCallback(async (id: string) => {
    const s = await kido.project(id);
    setSummary(s);
    return s;
  }, []);

  const step = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        say({ from: 'kido', text: message(e), note: e instanceof KidoApiError && e.isGate ? 'This is a gate, not an error: resolve it and try again.' : undefined });
      } finally {
        setBusy(false);
      }
    },
    [say],
  );

  /* ── describe → questions ── */
  const begin = async (r: { projectId: string; question: Question | null }, quiet = false) => {
    setProjectId(r.projectId);
    await refresh(r.projectId);
    setQuestion(r.question);
    goTo('QUESTIONS');
    if (!r.question) await toIdentity(r.projectId);
    else if (!quiet) say({ from: 'kido', text: r.question.text });
  };
  const start = (text: string) =>
    step(async () => {
      setPrompt(text);
      say({ from: 'you', text });
      await begin(await kido.create(text));
    });
  const applyTemplate = (t: InterviewTemplateInfo) =>
    step(async () => {
      say({ from: 'you', text: `Use the "${t.name}" template.` }, { from: 'kido', text: `The template fills in everything else. On the right are the ${t.questions.length} things only you know, already filled with suggestions: suppliers (ENS names work), the loan to protect and the spending limits. Change what you like, then continue.` });
      setSetup(t);
      await begin(await kido.create('', t.name, t.id), true);
    });

  /* ── template setup: submit the form as the template's answers, in the order the backend asks ── */
  const submitSetup = () =>
    step(async () => {
      if (!projectId || !setupAnswers) return;
      const byKey: Record<string, string> = { payees: setupAnswers.payees, beneficiary: setupAnswers.beneficiary, 'limits.window': setupAnswers.limits };
      let q = question;
      while (q) {
        const text = byKey[q.key];
        if (!text) break;
        say({ from: 'you', text });
        const r = await kido.answer(projectId, text);
        if (!r.accepted) {
          await refresh(projectId);
          setQuestion(r.next);
          say({ from: 'kido', text: `That was not accepted: ${r.note ?? 'unreadable'}. Fix it on the right and continue.` });
          return;
        }
        q = r.next;
      }
      setQuestion(q);
      await refresh(projectId);
      if (q) say({ from: 'kido', text: q.text });
      else await toIdentity(projectId);
    });

  /* ── questions: one backend question at a time ── */
  const answer = (text: string) =>
    step(async () => {
      if (!projectId) return;
      say({ from: 'you', text });
      const r = await kido.answer(projectId, text);
      await refresh(projectId);
      setQuestion(r.next);
      // Nothing left to ask (answered, or re-asked as far as the interview goes): move on; the
      // review shows anything still unresolved rather than leaving the chat stuck.
      if (!r.next) {
        if (!r.accepted) say({ from: 'kido', text: 'I could not use that answer; it is left open for you to review.', note: r.note });
        await toIdentity(projectId);
      } else say({ from: 'kido', text: r.next.text, note: r.note });
    });

  /* ── identity: the agent's name and a subname per specialist ── */
  const toIdentity = async (id: string) => {
    await kido.finalize(id);
    const s = await refresh(id);
    const root = s.identityPlan.find((b) => !b.role)?.name;
    if (root) {
      const parts = root.split('.');
      setLabel(parts[0] ?? '');
      setOrg(parts.slice(1, -1).join('.'));
    }
    goTo('IDENTITY');
    say({ from: 'kido', text: s.identityPlan.length ? 'Name your agent. It and each of its specialists get an ENS and a SuiNS name.' : 'This agent has no public identity yet. Give it one to publish ENS and SuiNS names, or continue without.' });
  };
  const saveNames = () =>
    step(async () => {
      if (!projectId) return;
      const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      const name = `${slug(label)}.${slug(org)}`;
      if (!slug(label) || !slug(org)) throw new Error('Give both an agent name and an organization.');
      if (!summary?.blueprint?.identity.public) {
        const r = await kido.edit(projectId, 'identity.public', 'yes');
        if (!r.accepted) throw new Error(r.note ?? 'could not make the identity public');
      }
      const r = await kido.edit(projectId, 'identity.name', name);
      if (!r.accepted) throw new Error(r.note ?? 'that name was not accepted');
      await kido.finalize(projectId);
      const s = await refresh(projectId);
      say({ from: 'you', text: name }, { from: 'kido', text: `Names planned: ${s.identityPlan.filter((b) => !b.role).map((b) => b.name).join(' and ')}, plus one per specialist.` });
    });
  const toReview = () =>
    step(async () => {
      if (!projectId) return;
      const s = await refresh(projectId);
      goTo('REVIEW');
      say({
        from: 'kido',
        text: s.blockers.length
          ? `Here is the agent, but it cannot be built yet: ${s.blockers.map((b) => b.detail).join('; ')}.`
          : `Here is everything: ${s.blueprint?.agents.length ?? 0} agents, their names, the policy they act under and the rates they may spend at. Do you want to continue?`,
      });
    });

  /* ── checks: security review → simulation → build ── */
  const runChecks = () =>
    step(async () => {
      if (!projectId) return;
      goTo('CHECKS');
      say({ from: 'you', text: 'Continue.' });
      setChecks({ security: 'running', simulation: 'todo', build: 'todo' });
      const r = await kido.securityReview(projectId);
      await refresh(projectId);
      if (r.blocking) {
        setChecks((c) => ({ ...c, security: 'fail' }));
        say({ from: 'kido', text: `The review found ${r.findings.filter((f) => f.blocking).length} blocking issue(s); change the requirements in the workbench.` });
        return;
      }
      setChecks((c) => ({ ...c, security: 'pass', simulation: 'running' }));
      const sim = await kido.simulate(projectId);
      await refresh(projectId);
      if (!sim.passed) {
        setChecks((c) => ({ ...c, simulation: 'fail' }));
        say({ from: 'kido', text: `${sim.results.filter((x) => !x.passed).length} scenario(s) did not behave as expected; the build is blocked.` });
        return;
      }
      setChecks((c) => ({ ...c, simulation: 'pass', build: 'running' }));
      await kido.build(projectId);
      await refresh(projectId);
      setChecks((c) => ({ ...c, build: 'pass' }));
      const est = await kido.costs(projectId);
      setCosts(est);
      setActions(est.assumptions.actionsPerMonth);
      goTo('COSTS');
      say({ from: 'kido', text: `Built. Here is what it would cost to run on mainnet: about ${usd(est.totals.monthlyUsd)} a month plus ${usd(est.totals.oneTimeUsd)} to set up.`, note: 'Change how often it acts to see the estimate move.' });
    });
  const recost = async (next: Record<string, number>) => {
    setActions(next);
    if (projectId) setCosts(await kido.costs(projectId, { actionsPerMonth: next }));
  };

  const HEAD: Record<Stage, { title: string; body: string }> = {
    DESCRIBE: { title: 'What should this agent do?', body: 'Say it in your own words, or start from a template that asks only three questions.' },
    QUESTIONS: { title: 'A few things only you know', body: 'Answer in your own words, or pick one of the options.' },
    IDENTITY: { title: 'Name your agent', body: 'The agent and every specialist get ENS and SuiNS names people can look up.' },
    REVIEW: { title: 'Here is what it will be', body: 'The agents, their names, the policy they act under and the rates they may spend at.' },
    CHECKS: { title: 'Checking it', body: 'Security review, simulation with attacks, then the build.' },
    COSTS: { title: 'What it costs to run', body: 'Every provider it uses, with a realistic monthly cost on mainnet.' },
  };
  const head = HEAD[stage];
  const s = summary;
  const failed = Object.values(checks).includes('fail');
  const workbench = projectId ? `/projects/${projectId}/build` : '/projects';
  const counted = costs ? costs.lines.filter((l) => !l.optional || included.has(l.id)) : [];
  const total = counted.reduce((n, l) => n + l.monthlyUsd, 0);

  const Bar = ({ note, children }: { note: string; children: React.ReactNode }) => (
    <div className="kc-composer">
      <div className="kc-composer__row">
        <span className="cl-meta">{busy ? 'Working…' : note}</span>
        <span className="cl-row" style={{ gap: 8 }}>{children}</span>
      </div>
    </div>
  );

  return (
    <div className="kc">
      <div className="kc-canvas cl-studio cl-dark">
        <section className="kc-half kc-half--left">
          <header className="kc-chat__head">
            <p className="cl-meta">New agent</p>
            <h1 className="kc-chat__title">{head.title}</h1>
            <p className="cl-body">{head.body}</p>
          </header>

          <div className="kc-chat__scroll" ref={scroller}>
            {turns.map((t, i) => (
              <div key={i} className={`kc-turn kc-turn--${t.from}`}>
                <p className="kc-turn__text">{t.text}</p>
                {t.note ? <p className="kc-turn__note">{t.note}</p> : null}
              </div>
            ))}
          </div>

          {stage === 'QUESTIONS' && setup && question ? (
            <Bar note={setupAnswers ? 'Every field checks out' : 'Fill in or fix the highlighted fields'}>
              <button type="button" className="cl-btn cl-btn-primary" onClick={submitSetup} disabled={busy || !setupAnswers}>Use these answers</button>
            </Bar>
          ) : stage === 'IDENTITY' ? (
            <div className="kc-composer">
              <div className="kf-identity-form">
                <label><span className="cl-meta">Agent name</span><input className="cl-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="treasury" /></label>
                <label><span className="cl-meta">Organization</span><input className="cl-input" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="acmecorp" /></label>
                <span className="cl-meta kf-identity-preview">{label && org ? `${label}.${org}.eth · ${label}.${org}.sui` : ' '}</span>
              </div>
              <div className="kc-composer__row">
                <button type="button" className="cl-btn" onClick={saveNames} disabled={busy}>Save names</button>
                <button type="button" className="cl-btn cl-btn-primary" onClick={toReview} disabled={busy}>Continue to review</button>
              </div>
            </div>
          ) : stage === 'REVIEW' ? (
            <Bar note={s?.blockers.length ? 'Blocked — change it in the workbench' : 'Everything above is what will be built'}>
              <button type="button" className="cl-btn" onClick={() => setStage('IDENTITY')} disabled={busy}>Back</button>
              {s?.blockers.length ? <Link href={workbench} className="cl-btn cl-btn-primary">Open the workbench</Link> : <button type="button" className="cl-btn cl-btn-primary" onClick={runChecks} disabled={busy}>Yes, continue</button>}
            </Bar>
          ) : stage === 'CHECKS' ? (
            failed ? (
              <Bar note="A check failed"><Link href={workbench} className="cl-btn cl-btn-primary">Open the workbench</Link></Bar>
            ) : null
          ) : stage === 'COSTS' ? (
            <Bar note={costs ? `About ${usd(total)} / month on mainnet · free on testnet` : 'Estimating…'}>
              <button type="button" className="cl-btn cl-btn-primary" onClick={() => projectId && router.push(`/projects/${projectId}/deploy`)} disabled={!projectId}>Continue</button>
            </Bar>
          ) : (
            <PromptComposer
              onSubmit={stage === 'QUESTIONS' ? answer : start}
              placeholder={stage === 'QUESTIONS' ? 'Your answer' : undefined}
              suggestions={stage === 'QUESTIONS' ? question?.choices?.map((c) => c.label) : undefined}
              starters={stage === 'DESCRIBE'}
              initialValue={stage === 'DESCRIBE' ? prompt || seeded : ''}
            />
          )}
        </section>

        <section className="kc-half kc-half--right">
          <CreateSteps
            current={stage}
            furthest={furthest}
            onSelect={(id) => {
              if (ORDER.indexOf(id) <= ORDER.indexOf(furthest)) setStage(id);
            }}
          />
          <div className="kc-stage">
            {stage === 'DESCRIBE' ? (
              templates.length ? <TemplatePicker templates={templates} onUse={applyTemplate} busy={busy} /> : <EmptyState title="Nothing built yet" body="Describe the agent on the left and it takes shape here." />
            ) : !s ? null : stage === 'QUESTIONS' ? (
              setup && question ? <TemplateSetup template={setup} onReady={setSetupAnswers} /> : <KidoRequirementBoxes requirements={s.interview.requirements} pendingKey={question?.key} />
            ) : stage === 'IDENTITY' ? (
              <div className="kf-stack">
                <NameCheck parent={org ? `${org.toLowerCase()}.eth` : null} full={label && org ? `${label.toLowerCase()}.${org.toLowerCase()}.eth` : null} />
                <EnsProfile plan={s.identityPlan} />
                <IdentityPane s={s} />
              </div>
            ) : stage === 'REVIEW' ? (
              <ReviewPane s={s} />
            ) : stage === 'CHECKS' ? (
              <ChecksPane s={s} states={checks} />
            ) : costs ? (
              <CostsPane est={costs} included={included} onToggle={(id) => setIncluded((x) => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n; })} actions={actions} onActions={(a) => void recost(a)} />
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

export default function CreatePage() {
  return (
    <Suspense fallback={null}>
      <CreateFlow />
    </Suspense>
  );
}
