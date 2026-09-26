'use client';

/**
 * Agent creation, live against the Kido backend.
 *
 * The left half is the conversation: the objective, then Kido's design interview one question at a
 * time (the backend decides what to ask and records the answer). The right half shows what the
 * backend now holds: captured requirements, the compiled blueprint, the security review, the
 * simulation and the build. Every step is a Kido lifecycle gate, in Kido's order:
 * describe → requirements → blueprint → security review → simulation → build.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PromptComposer } from '@/components/create/PromptComposer';
import { CreateSteps, type CreateStepId } from '@/components/create/CreateSteps';
import { KidoBlueprintBoxes, KidoBuildPane, KidoFindingList, KidoRequirementBoxes, KidoSimulation } from '@/components/create/KidoPanes';
import { EmptyState } from '@/components/studio/primitives';
import { COMPOSER_EXAMPLES } from '@/lib/studio/content/composer';
import { PROJECT_TEMPLATES } from '@/lib/studio/content/templates';
import { kido, KidoApiError } from '@/lib/kido/api';
import type { ProjectSummary, Question } from '@/lib/kido/types';

type Stage = 'DESCRIBE' | 'REQUIREMENTS' | 'BLUEPRINT' | 'SECURITY' | 'SIMULATION' | 'BUILD' | 'DONE';
type Turn = { from: 'you' | 'kido'; text: string; note?: string };

const ORDER: Stage[] = ['DESCRIBE', 'REQUIREMENTS', 'BLUEPRINT', 'SECURITY', 'SIMULATION', 'BUILD', 'DONE'];
const STAGE_FOR: Partial<Record<CreateStepId, Stage>> = { DESCRIBE: 'DESCRIBE', REQUIREMENTS: 'REQUIREMENTS', BLUEPRINT: 'BLUEPRINT', SECURITY_REVIEW: 'SECURITY', SIMULATION: 'SIMULATION' };
const RAIL: Record<Stage, CreateStepId> = { DESCRIBE: 'DESCRIBE', REQUIREMENTS: 'REQUIREMENTS', BLUEPRINT: 'BLUEPRINT', SECURITY: 'SECURITY_REVIEW', SIMULATION: 'SIMULATION', BUILD: 'BUILD', DONE: 'BUILD' };

const message = (e: unknown) => (e instanceof KidoApiError || e instanceof Error ? e.message : String(e));

function CreateFlow() {
  const [stage, setStage] = useState<Stage>('DESCRIBE');
  const [furthest, setFurthest] = useState<Stage>('DESCRIBE');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');

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

  /* Each step runs one backend call; a gate refusal is shown as Kido's own words. */
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

  /* ── describe → requirements ── */
  const start = (text: string) =>
    step(async () => {
      setPrompt(text);
      say({ from: 'you', text });
      const r = await kido.create(text);
      setProjectId(r.projectId);
      await refresh(r.projectId);
      setQuestion(r.question);
      goTo('REQUIREMENTS');
      if (r.question) say({ from: 'kido', text: r.question.text });
      else await toBlueprint(r.projectId);
    });

  /* ── requirements: one backend question at a time ── */
  const answer = (text: string) =>
    step(async () => {
      if (!projectId) return;
      say({ from: 'you', text });
      const r = await kido.answer(projectId, text);
      await refresh(projectId);
      setQuestion(r.next);
      if (!r.accepted) say({ from: 'kido', text: r.next?.text ?? 'I could not use that answer.', note: r.note });
      else if (r.next) say({ from: 'kido', text: r.next.text, note: r.note });
      else await toBlueprint(projectId);
    });

  const toBlueprint = async (id: string) => {
    const f = await kido.finalize(id);
    await refresh(id);
    goTo('BLUEPRINT');
    say({
      from: 'kido',
      text: f.blockers.length
        ? `The blueprint is compiled, but it cannot be built yet: ${f.blockers.map((b) => b.detail).join('; ')}.`
        : 'Every requirement is captured and the blueprint is compiled. Read it on the right.',
      note: 'Continue to the security review.',
    });
  };

  /* ── security review ── */
  const review = () =>
    step(async () => {
      if (!projectId) return;
      const r = await kido.securityReview(projectId);
      await refresh(projectId);
      goTo('SECURITY');
      const blocking = r.findings.filter((f) => f.blocking);
      say({
        from: 'kido',
        text: blocking.length
          ? `The review found ${blocking.length} blocking issue${blocking.length === 1 ? '' : 's'}; the agent cannot be built until the requirements change.`
          : `The review is done: ${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}, none blocking.`,
        note: blocking.length ? 'Open the workbench to edit the requirements.' : 'Continue to the simulation.',
      });
    });

  /* ── simulation ── */
  const simulate = () =>
    step(async () => {
      if (!projectId) return;
      goTo('SIMULATION');
      const r = await kido.simulate(projectId);
      await refresh(projectId);
      const failed = r.results.filter((x) => !x.passed).length;
      say({
        from: 'kido',
        text: failed ? `${failed} scenario${failed === 1 ? '' : 's'} did not behave as expected; the build is blocked.` : `All ${r.results.length} scenarios behaved as expected, including the attacks.`,
        note: failed ? 'Read the failures on the right.' : 'Continue to build.',
      });
    });

  /* ── build ── */
  const build = () =>
    step(async () => {
      if (!projectId) return;
      goTo('BUILD');
      await kido.build(projectId);
      await refresh(projectId);
      goTo('DONE');
      say({ from: 'kido', text: 'Built. The agent, its monitors, authority and identity plan are ready in the workbench.', note: 'Deploying it creates its Amane accounts; your wallet signs the owner policy.' });
    });

  const HEAD: Record<Stage, { title: string; body: string }> = {
    DESCRIBE: { title: 'What should this agent do?', body: 'Say it in your own words. Kido asks about anything that matters and never invents authority you did not give.' },
    REQUIREMENTS: { title: 'A few things it needs to know', body: 'Answer in your own words, or pick one of the options.' },
    BLUEPRINT: { title: 'Here is what it will be', body: 'This is the compiled blueprint. Continue to the security review.' },
    SECURITY: { title: 'What the review found', body: 'A deterministic review of this blueprint revision.' },
    SIMULATION: { title: 'Simulation', body: 'Allowed actions, and attacks that must be refused.' },
    BUILD: { title: 'Building', body: 'Assembling agents, monitors, authority and identity.' },
    DONE: { title: 'It exists', body: 'The agent is built and ready to open in the workbench.' },
  };
  const head = HEAD[stage];
  const s = summary;
  const reviewBlocking = Boolean(s?.security?.blocking);
  const simFailed = s?.simulation ? !s.simulation.passed : false;
  const workbench = projectId ? `/projects/${projectId}/build` : '/projects';

  const Continue = ({ label, onClick, disabled, note }: { label: string; onClick: () => void; disabled?: boolean; note: string }) => (
    <div className="kc-composer">
      <div className="kc-composer__row">
        <span className="cl-meta">{busy ? 'Working…' : note}</span>
        <button type="button" className="cl-btn cl-btn-primary" onClick={onClick} disabled={busy || disabled}>
          {label}
        </button>
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

          {stage === 'DONE' ? (
            <div className="kc-composer">
              <Link href={projectId ? `/projects/${projectId}/overview` : '/projects'} className="cl-btn cl-btn-primary kc-open">
                Open the workbench
              </Link>
            </div>
          ) : stage === 'BLUEPRINT' ? (
            <Continue label="Run the security review" onClick={review} note={s?.blockers.length ? 'Blocked, but the review will explain' : 'Blueprint compiled'} />
          ) : stage === 'SECURITY' ? (
            reviewBlocking ? (
              <div className="kc-composer">
                <div className="kc-composer__row">
                  <span className="cl-meta">Blocking findings</span>
                  <Link href={workbench} className="cl-btn cl-btn-primary">
                    Edit in the workbench
                  </Link>
                </div>
              </div>
            ) : (
              <Continue label="Run the simulation" onClick={simulate} note="Review passed" />
            )
          ) : stage === 'SIMULATION' ? (
            simFailed ? (
              <div className="kc-composer">
                <div className="kc-composer__row">
                  <span className="cl-meta">Scenarios failed</span>
                  <Link href={workbench} className="cl-btn cl-btn-primary">
                    Open the workbench
                  </Link>
                </div>
              </div>
            ) : (
              <Continue label="Build the agent" onClick={build} disabled={!s?.simulation} note={s?.simulation ? 'Every scenario passed' : 'Running'} />
            )
          ) : stage === 'BUILD' ? null : (
            <PromptComposer
              onSubmit={stage === 'REQUIREMENTS' ? answer : start}
              placeholder={stage === 'REQUIREMENTS' ? 'Your answer' : undefined}
              suggestions={stage === 'REQUIREMENTS' ? question?.choices?.map((c) => c.label) : undefined}
              starters={stage === 'DESCRIBE'}
              initialValue={stage === 'DESCRIBE' ? prompt || seeded : ''}
            />
          )}
        </section>

        <section className="kc-half kc-half--right">
          <CreateSteps
            current={RAIL[stage]}
            furthest={RAIL[furthest]}
            onSelect={(id) => {
              const target = STAGE_FOR[id];
              if (target && ORDER.indexOf(target) <= ORDER.indexOf(furthest)) setStage(target);
            }}
          />
          <div className="kc-stage">
            {stage === 'DESCRIBE' || !s ? (
              <EmptyState title="Nothing built yet" body="Describe the agent on the left and it takes shape here." />
            ) : stage === 'REQUIREMENTS' ? (
              <KidoRequirementBoxes requirements={s.interview.requirements} pendingKey={question?.key} />
            ) : stage === 'BLUEPRINT' && s.blueprint ? (
              <KidoBlueprintBoxes blueprint={s.blueprint} blockers={s.blockers} />
            ) : stage === 'SECURITY' && s.security ? (
              <KidoFindingList report={s.security} />
            ) : stage === 'SIMULATION' ? (
              <KidoSimulation report={s.simulation} running={busy} />
            ) : (
              <KidoBuildPane build={s.build} running={busy} />
            )}
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
