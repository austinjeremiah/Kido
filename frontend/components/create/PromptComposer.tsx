'use client';

/**
 * The input, for both the description and every answer after it.
 *
 * Built from the project's own input and button classes (.cl-input, .cl-btn)
 * rather than a bespoke set, so it inherits the workbench's cream theme, focus
 * treatment and disabled state without restating any of it here.
 *
 * It carries three kinds of affordance above the box, and only ever one at a
 * time: the starters on the first screen, suggestion chips where a question has
 * them, and the refusal note where a question is a financial boundary. The
 * refusal is stated rather than implied, because a question arriving with no
 * suggestions looks like an oversight unless it says it is deliberate.
 */
import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Lock } from 'lucide-react';
import { COMPOSER_EXAMPLES } from '@/lib/studio/content/composer';

/** Below this the description cannot describe an agent, and the backend agrees. */
const MIN = 10;

/* One line each, summarising the example's own text — the bodies themselves are
   the full prompts and far too long to hover. Keyed to the real example ids so
   a change to the catalogue cannot silently leave a stale summary behind. */
const GIST: Record<string, string> = {
  ex_guardian: 'Watches an Aave v3 health factor and repays USDC debt before the position liquidates.',
  ex_rebalancer: 'Keeps a collateral ratio inside a band by rebalancing through Uniswap v3.',
  ex_reporter: 'Reports the treasury position daily, with no authority to submit a transaction at all.',
};

const STARTERS = COMPOSER_EXAMPLES.filter((e) => e.id in GIST);

export function PromptComposer({
  onSubmit,
  placeholder,
  suggestions,
  refuses,
  starters,
  allowEmpty,
  initialValue,
}: {
  onSubmit: (text: string) => void;
  placeholder?: string;
  suggestions?: readonly string[];
  refuses?: boolean;
  starters?: boolean;
  /** Where an empty box is a valid answer in itself — "nothing to change". */
  allowEmpty?: boolean;
  /** Text to open with, so returning to a step shows what was written there. */
  initialValue?: string;
}) {
  const [value, setValue] = useState(initialValue ?? '');
  const ref = useRef<HTMLTextAreaElement | null>(null);

  /* Keyed on the value so it only ever runs forward: returning to a step
     restores what was written there, and typing afterwards is not overwritten
     by the prop on the next render. */
  useEffect(() => {
    setValue(initialValue ?? '');
  }, [initialValue]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  /* An answer to a question can be short — "$5,000" is a complete one. Only the
     opening description has to clear the backend's minimum. */
  const min = starters ? MIN : allowEmpty ? 0 : 1;
  const ready = value.trim().length >= min;

  const send = () => {
    if (!ready) return;
    onSubmit(value.trim());
    setValue('');
  };

  return (
    <div className="kc-composer">
      {starters ? (
        <div className="kc-starters">
          {STARTERS.map((ex) => (
            <span key={ex.id} className="kc-starter">
              <button
                type="button"
                className="cl-btn kc-starter__btn"
                onClick={() => {
                  setValue(ex.body);
                  ref.current?.focus();
                }}
              >
                {ex.title}
              </button>
              <span className="kc-starter__tip" role="tooltip">
                {GIST[ex.id]}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      {suggestions?.length ? (
        <div className="kc-starters">
          {suggestions.map((s) => (
            <button key={s} type="button" className="cl-btn kc-starter__btn" onClick={() => onSubmit(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : null}

      {refuses ? (
        <p className="kc-refusal">
          <Lock size={12} aria-hidden />
          This is a financial boundary. Kido will not propose a figure, infer one from the other
          limits, or offer a typical value — it is yours to set.
        </p>
      ) : null}

      <textarea
        ref={ref}
        className="cl-input kc-composer__input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          /* Enter sends, Shift+Enter breaks the line — the convention every
             chat box has trained people to expect. */
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={placeholder ?? 'Describe the agent. What should it watch, when should it act, and what must it never do?'}
        rows={3}
        aria-label={starters ? 'Describe the agent' : 'Your answer'}
      />

      <div className="kc-composer__row">
        <span className="cl-meta">
          {ready ? (
            <>
              <CornerDownLeft size={12} aria-hidden /> to continue
            </>
          ) : starters ? (
            `${MIN} characters minimum`
          ) : allowEmpty ? (
            'Leave empty to accept it as drafted'
          ) : (
            'Type an answer, or pick one above'
          )}
        </span>
        <button type="button" className="cl-btn cl-btn-primary" onClick={send} disabled={!ready}>
          Continue
        </button>
      </div>
    </div>
  );
}
