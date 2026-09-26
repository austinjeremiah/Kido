'use client';

/**
 * The description box.
 *
 * Built from the project's own input and button classes (.cl-input, .cl-btn)
 * rather than a bespoke set, so it inherits the workbench's cream theme, focus
 * treatment and disabled state without restating any of it here.
 */
import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft } from 'lucide-react';

/** Below this the description cannot describe an agent, and the backend agrees. */
const MIN = 10;

export function PromptComposer({ onSubmit }: { onSubmit: (prompt: string) => void }) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  const ready = value.trim().length >= MIN;
  const send = () => {
    if (ready) onSubmit(value.trim());
  };

  return (
    <div className="kc-composer">
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
        placeholder="Describe the agent. What should it watch, when should it act, and what must it never do?"
        rows={3}
        aria-label="Describe the agent"
      />
      <div className="kc-composer__row">
        <span className="cl-meta">
          {ready ? (
            <>
              <CornerDownLeft size={12} aria-hidden /> to continue
            </>
          ) : (
            `${MIN} characters minimum`
          )}
        </span>
        <button type="button" className="cl-btn cl-btn-primary" onClick={send} disabled={!ready}>
          Continue
        </button>
      </div>
    </div>
  );
}
