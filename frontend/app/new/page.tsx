'use client';

/**
 * Agent creation.
 *
 * Same frame as the entry screen — the project's blue as the ground with a flat
 * cream canvas inset inside it — split down the middle. The conversation runs
 * in the left half; the right half reports what has been captured so far.
 *
 * Everything inside the canvas is wrapped in .cl-studio so it renders in the
 * workbench's own theme: studio.css is scoped under that class, and its canvas
 * token is the same cream this frame is painted in, so the primitives land on
 * it without a single colour restated here.
 *
 * The stage is explicit state rather than something derived from whether other
 * fields happen to be filled. Derivation was fine for two stages and would have
 * become a source of ambiguous in-between states at seven — the run is linear,
 * so it is stored as a position in that run.
 *
 * Placeholder throughout: no build is created and nothing is sent anywhere. The
 * questions, their rules and the review's checks are real, so when the backend
 * is ready this wires to it rather than being rewritten.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { PromptComposer } from '@/components/create/PromptComposer';
import { CreateSteps, type CreateStepId } from '@/components/create/CreateSteps';
import { RequirementBoxes } from '@/components/create/RequirementBoxes';
import { BlueprintBoxes } from '@/components/create/BlueprintBoxes';
import { FindingList, ApprovalList, BuildProgress, TestResults, type Suite } from '@/components/create/StagePanes';
import { EmptyState } from '@/components/studio/primitives';
import { CLARIFYING_QUESTIONS } from '@/lib/studio/content/composer';
import { reviewOf, type Finding } from '@/lib/create/review';

type Stage = 'DESCRIBE' | 'REQUIREMENTS' | 'BLUEPRINT' | 'SECURITY' | 'APPROVE' | 'BUILD' | 'TEST' | 'DONE';
type Turn = { from: 'you' | 'kido'; text: string; note?: string };

/** The run, in order — used to work out how far back one may jump. */
const ORDER: Stage[] = ['DESCRIBE', 'REQUIREMENTS', 'BLUEPRINT', 'SECURITY', 'APPROVE', 'BUILD', 'TEST', 'DONE'];

/** Which stage a rail step goes back to. Build and Tests are not navigable. */
const STAGE_FOR: Partial<Record<CreateStepId, Stage>> = {
  DESCRIBE: 'DESCRIBE',
  REQUIREMENTS: 'REQUIREMENTS',
  BLUEPRINT: 'BLUEPRINT',
  SECURITY_REVIEW: 'SECURITY',
  AWAITING_APPROVAL: 'APPROVE',
};

/** Which rail step each stage lights. */
const RAIL: Record<Stage, CreateStepId> = {
  DESCRIBE: 'DESCRIBE',
  REQUIREMENTS: 'REQUIREMENTS',
  BLUEPRINT: 'BLUEPRINT',
  SECURITY: 'SECURITY_REVIEW',
  APPROVE: 'AWAITING_APPROVAL',
  BUILD: 'BUILD',
  TEST: 'TEST',
  DONE: 'TEST',
};

const FILES = [
  'agent/guardian.ts',
  'agent/policy.ts',
  'adapters/aave.ts',
  'kido/authority.ts',
  'tests/policy.spec.ts',
  'tests/simulation.spec.ts',
];

const SUITES: Suite[] = [
  { name: 'Policy boundaries', passed: 9, failed: 0 },
  { name: 'Escalation path', passed: 4, failed: 0 },
  { name: 'Refusal on stale data', passed: 3, failed: 0 },
];

export default function CreatePage() {
  const [stage, setStage] = useState<Stage>('DESCRIBE');
  /* How far the run has got, which is as far back as the rail can jump from.
     Going back never rewinds it — the work already done still exists. */
  const [furthest, setFurthest] = useState<Stage>('DESCRIBE');
  const [prompt, setPrompt] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [turns, setTurns] = useState<Turn[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [suites, setSuites] = useState<Suite[]>([]);

  const scroller = useRef<HTMLDivElement | null>(null);

  /* Every stage change goes through here so the high-water mark can never be
     missed, and so going back cannot lower it. */
  const goTo = useCallback((next: Stage) => {
    setStage(next);
    setFurthest((f) => (ORDER.indexOf(next) > ORDER.indexOf(f) ? next : f));
  }, []);

  /* Follow the conversation down as it grows. Without this the newest turn is
     appended below the fold and the pane simply looks like it stopped
     responding. Smooth unless the reader has asked for less motion, where
     jumping is the correct behaviour rather than a degraded one. */
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  }, [turns]);

  const say = useCallback((...next: Turn[]) => setTurns((t) => [...t, ...next]), []);

  /* The interview is a queue: the current question is the first still
     unanswered, so answering simply shortens it. */
  const openQuestions = CLARIFYING_QUESTIONS.filter((q) => !answers[q.requirementId]);
  const current = stage === 'REQUIREMENTS' ? openQuestions[0] : undefined;
  /* Revisiting the interview once every question is closed: there is nothing
     left to ask, so the pane becomes a read-back with a way forward rather than
     a composer wired to a question that does not exist. */
  const reviewingAnswers = stage === 'REQUIREMENTS' && !current;

  /* ── 01 → 02 ───────────────────────────────────────────────────────── */
  const start = (text: string) => {
    setPrompt(text);
    goTo('REQUIREMENTS');

    /* Coming back to edit the description does not re-ask what has already been
       answered. The next question is the first still open, and if none are, the
       interview is simply already done. */
    const next = CLARIFYING_QUESTIONS.find((q) => !answers[q.requirementId]);
    say(
      { from: 'you', text },
      next
        ? { from: 'kido', text: next.question, note: next.why }
        : { from: 'kido', text: 'Noted. Every requirement is still captured, so nothing needs asking again.' },
    );
  };

  /* ── 02 ────────────────────────────────────────────────────────────── */
  const answer = (text: string) => {
    if (!current) return;
    const next = { ...answers, [current.requirementId]: text };
    setAnswers(next);

    const remaining = CLARIFYING_QUESTIONS.filter((q) => !next[q.requirementId]);
    if (remaining[0]) {
      say({ from: 'you', text }, { from: 'kido', text: remaining[0].question, note: remaining[0].why });
      return;
    }

    goTo('BLUEPRINT');
    say(
      { from: 'you', text },
      {
        from: 'kido',
        text:
          'That closes every requirement. I have drafted the blueprint on the right — your limits ' +
          'are in it verbatim, and the trigger and actions are read from your description when it ' +
          'is generated.',
        note: 'Tell me what to change, or continue to the security review.',
      },
    );
  };

  /* ── 03 → 04 ───────────────────────────────────────────────────────── */
  const fromBlueprint = (text: string) => {
    if (text) {
      say(
        { from: 'you', text },
        { from: 'kido', text: 'Noted. That will be applied before the security review.' },
      );
      return;
    }
    const review = reviewOf(answers);
    setFindings(review);
    goTo('SECURITY');
    say({
      from: 'kido',
      text: `The review is done: ${review.length} finding${review.length === 1 ? '' : 's'}, none of them blocking.`,
      note: 'Read them on the right. Continue when you have.',
    });
  };

  /* ── 04 → 05 ───────────────────────────────────────────────────────── */
  const fromSecurity = () => {
    goTo('APPROVE');
    say({
      from: 'kido',
      text:
        'Nothing is generated until you approve, and approval is per finding — each one is ' +
        'acknowledged on its own rather than by a single button that covers all of them.',
      note: 'Tick each finding on the right, then approve.',
    });
  };

  /* ── 05 → 06 ───────────────────────────────────────────────────────── */
  const approve = () => {
    if (acknowledged.length !== findings.length) return;
    goTo('BUILD');
    say({ from: 'you', text: 'Approved.' }, { from: 'kido', text: 'Generating the agent now.' });
  };

  /* Build and test both play out over time. One effect per stage, each
     cancelling its own timers on unmount, so nothing writes to state after the
     page is gone. */
  useEffect(() => {
    if (stage !== 'BUILD') return;
    setFiles([]);
    const timers = FILES.map((f, i) =>
      window.setTimeout(() => setFiles((prev) => [...prev, f]), (i + 1) * 420),
    );
    const finish = window.setTimeout(() => {
      goTo('TEST');
      say({ from: 'kido', text: 'Generated. Running the policy and simulation suites.' });
    }, (FILES.length + 1) * 420);
    return () => {
      timers.forEach(window.clearTimeout);
      window.clearTimeout(finish);
    };
  }, [stage, say, goTo]);

  useEffect(() => {
    if (stage !== 'TEST') return;
    setSuites([]);
    const timers = SUITES.map((s, i) =>
      window.setTimeout(() => setSuites((prev) => [...prev, s]), (i + 1) * 520),
    );
    const finish = window.setTimeout(() => {
      goTo('DONE');
      say({
        from: 'kido',
        text: 'Every suite passed. The agent exists — the workbench is open.',
        note: 'From here you can deploy it, watch it run, and revoke it.',
      });
    }, (SUITES.length + 1) * 520);
    return () => {
      timers.forEach(window.clearTimeout);
      window.clearTimeout(finish);
    };
  }, [stage, say, goTo]);

  /* ── the left column's copy, per stage ─────────────────────────────── */
  const HEAD: Record<Stage, { title: string; body: string }> = {
    DESCRIBE: {
      title: 'What should this agent do?',
      body: 'Say it in your own words. Every limit you state becomes a rule it cannot break — anything you leave out, it will ask about before it builds.',
    },
    REQUIREMENTS: {
      title: 'A few things it needs to know',
      body: 'Answer in your own words, or pick one of the suggestions where there is one.',
    },
    BLUEPRINT: {
      title: 'Here is what it will be',
      body: 'Read it over. Describe anything you want changed, or continue.',
    },
    SECURITY: {
      title: 'What the review found',
      body: 'None of it blocks the build. All of it is worth reading before you approve.',
    },
    APPROVE: {
      title: 'Your approval',
      body: 'Acknowledge each finding on the right. Nothing is generated until every one is ticked.',
    },
    BUILD: { title: 'Generating', body: 'Writing the agent, its policy and its tests.' },
    TEST: { title: 'Testing', body: 'Running the policy boundaries and the simulations against it.' },
    DONE: { title: 'It exists', body: 'The agent is built, tested and ready to open in the workbench.' },
  };

  const head = HEAD[stage];
  const running = stage === 'BUILD' || stage === 'TEST';
  const allAcked = findings.length > 0 && acknowledged.length === findings.length;

  return (
    <div className="kc">
      <div className="kc-canvas cl-studio">
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

          {/* The composer only exists where there is something to say. During
              generation and testing there is nothing to type, and a live box
              with a disabled button reads as a broken one. */}
          {running ? null : stage === 'DONE' ? (
            <div className="kc-composer">
              <Link href="/projects" className="cl-btn cl-btn-primary kc-open">
                Open the workbench
              </Link>
            </div>
          ) : reviewingAnswers ? (
            <div className="kc-composer">
              <div className="kc-composer__row">
                <span className="cl-meta">Every requirement is captured</span>
                <button type="button" className="cl-btn cl-btn-primary" onClick={() => goTo('BLUEPRINT')}>
                  Continue
                </button>
              </div>
            </div>
          ) : stage === 'SECURITY' ? (
            <div className="kc-composer">
              <div className="kc-composer__row">
                <span className="cl-meta">Read the findings on the right</span>
                <button type="button" className="cl-btn cl-btn-primary" onClick={fromSecurity}>
                  Continue
                </button>
              </div>
            </div>
          ) : stage === 'APPROVE' ? (
            <div className="kc-composer">
              <div className="kc-composer__row">
                <span className="cl-meta">
                  {allAcked
                    ? 'Every finding acknowledged'
                    : `${findings.length - acknowledged.length} still to acknowledge`}
                </span>
                <button type="button" className="cl-btn cl-btn-primary" onClick={approve} disabled={!allAcked}>
                  Approve and generate
                </button>
              </div>
            </div>
          ) : (
            <PromptComposer
              onSubmit={stage === 'BLUEPRINT' ? fromBlueprint : stage === 'REQUIREMENTS' ? answer : start}
              placeholder={
                stage === 'BLUEPRINT'
                  ? 'Describe a change — or leave this empty and continue'
                  : current?.placeholder
              }
              suggestions={current && !current.userMustDecide ? current.suggestions : undefined}
              refuses={current?.userMustDecide}
              starters={stage === 'DESCRIBE'}
              allowEmpty={stage === 'BLUEPRINT'}
              initialValue={stage === 'DESCRIBE' ? prompt : ''}
            />
          )}
        </section>

        <section className="kc-half kc-half--right">
          <CreateSteps
            current={RAIL[stage]}
            furthest={RAIL[furthest]}
            onSelect={(id) => {
              const target = STAGE_FOR[id];
              if (target) setStage(target);
            }}
          />
          <div className="kc-stage">
            {stage === 'DESCRIBE' ? (
              <EmptyState
                title="Nothing built yet"
                body="Describe the agent on the left and it takes shape here."
              />
            ) : stage === 'REQUIREMENTS' ? (
              <RequirementBoxes answers={answers} currentId={current?.requirementId} />
            ) : stage === 'BLUEPRINT' ? (
              <BlueprintBoxes description={prompt} answers={answers} />
            ) : reviewingAnswers ? (
            <div className="kc-composer">
              <div className="kc-composer__row">
                <span className="cl-meta">Every requirement is captured</span>
                <button type="button" className="cl-btn cl-btn-primary" onClick={() => goTo('BLUEPRINT')}>
                  Continue
                </button>
              </div>
            </div>
          ) : stage === 'SECURITY' ? (
              <FindingList findings={findings} />
            ) : stage === 'APPROVE' ? (
              <ApprovalList
                findings={findings}
                acknowledged={acknowledged}
                onToggle={(id) =>
                  setAcknowledged((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]))
                }
              />
            ) : stage === 'BUILD' ? (
              <BuildProgress files={files} done={false} />
            ) : (
              <TestResults suites={suites} done={stage === 'DONE'} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
