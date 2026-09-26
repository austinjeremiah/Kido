'use client';

/**
 * The six requirements, as boxes.
 *
 * Deliberately shallow: the workbench has real pages for blueprint, policy and
 * architecture, and this is not a second copy of them. It shows what has been
 * captured, what is being asked, and what is still open.
 *
 * An open box states what it wants rather than showing a bare dash, so the pane
 * is legible before a single answer exists. The refusal notice appears only on
 * the box currently being asked — repeated on all three boundaries at once it
 * stops being a statement and becomes wallpaper.
 */
import { CLARIFYING_QUESTIONS } from '@/lib/studio/content/composer';

/** Short labels; the questions themselves are a sentence each. */
const LABEL: Record<string, string> = {
  req_ceiling: 'Hard ceiling',
  req_window: 'Rolling window',
  req_autonomous: 'Autonomous limit',
  req_recipients: 'Allowed recipients',
  req_data: 'Data source',
  req_forbidden: 'Forbidden actions',
};

/** What an unanswered box is waiting for, in a few words. */
const WANTS: Record<string, string> = {
  req_ceiling: 'An amount it may never exceed',
  req_window: 'A total, and how long the window is',
  req_autonomous: 'The largest action it may take alone',
  req_recipients: 'Addresses it is allowed to pay',
  req_data: 'A feed, and how fresh it must be',
  req_forbidden: 'What it must never be able to do',
};

export function RequirementBoxes({
  answers,
  currentId,
}: {
  answers: Record<string, string>;
  currentId?: string;
}) {
  const set = CLARIFYING_QUESTIONS.filter((q) => answers[q.requirementId]).length;

  return (
    <div className="kc-boxes">
      <p className="kc-boxes__count">
        {set} of {CLARIFYING_QUESTIONS.length} captured
      </p>

      <div className="kc-boxes__grid">
        {CLARIFYING_QUESTIONS.map((q) => {
          const value = answers[q.requirementId];
          const asking = !value && q.requirementId === currentId;
          const state = value ? 'set' : asking ? 'asking' : 'open';

          return (
            <div key={q.requirementId} className="kc-box" data-state={state}>
              <div className="kc-box__head">
                <span className="kc-box__label">{LABEL[q.requirementId]}</span>
                <span className="kc-box__state">{value ? 'Set' : asking ? 'Asking' : 'Open'}</span>
              </div>

              {value ? (
                <p className="kc-box__value">{value}</p>
              ) : (
                <p className="kc-box__wants">{WANTS[q.requirementId]}</p>
              )}

              {asking && q.userMustDecide ? (
                <p className="kc-box__note">Kido will not suggest a figure for this one.</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
