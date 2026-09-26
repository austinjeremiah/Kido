'use client';

/**
 * The blueprint, as boxes.
 *
 * Shallow on purpose, like the requirements before it: the workbench has a real
 * blueprint page, and this is not a second copy of it.
 *
 * What it shows is what was actually captured. The authority rows are the
 * answers themselves, not a restatement of them, so a reader can see their own
 * figures land in the document. The rows the backend derives are marked as
 * pending rather than filled with a plausible guess — inventing a trigger the
 * user never stated is exactly the failure this product exists to prevent.
 */
import type { ReactNode } from 'react';

/** A slug from the opening description, for the proposed name. */
function slug(description: string): string {
  const stop = new Set([
    'build', 'an', 'a', 'the', 'my', 'for', 'me', 'please', 'create', 'make',
    'agent', 'that', 'this', 'it', 'and', 'with', 'on', 'to', 'of', 'in',
  ]);
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w))
    .slice(0, 2);
  return words.length ? words.join('-') : 'agent';
}

export function BlueprintBoxes({
  description,
  answers,
}: {
  description: string;
  answers: Record<string, string>;
}) {
  const rows: { label: string; value: ReactNode; pending?: boolean }[] = [
    {
      label: 'Identity',
      value: (
        <>
          {slug(description)}.kido.eth
          <span className="kc-box__tag">Proposed · registered at build</span>
        </>
      ),
    },
    {
      label: 'Trigger',
      value: 'Read from your description when the blueprint is generated.',
      pending: true,
    },
    {
      label: 'Actions',
      value: 'Derived from the protocols named in your description.',
      pending: true,
    },
    {
      label: 'Authority',
      value: (
        <>
          Autonomous to {answers.req_autonomous ?? '—'}
          <br />
          Ceiling {answers.req_ceiling ?? '—'}
          <br />
          Window {answers.req_window ?? '—'}
        </>
      ),
    },
    { label: 'Recipients', value: answers.req_recipients ?? '—' },
    { label: 'Data source', value: answers.req_data ?? '—' },
    { label: 'Never', value: answers.req_forbidden ?? '—' },
  ];

  return (
    <div className="kc-boxes">
      <p className="kc-boxes__count">Blueprint · drafted from what you said</p>
      <div className="kc-boxes__grid">
        {rows.map((r) => (
          <div key={r.label} className="kc-box" data-state={r.pending ? 'open' : 'set'}>
            <div className="kc-box__head">
              <span className="kc-box__label">{r.label}</span>
              <span className="kc-box__state">{r.pending ? 'Pending' : 'Drafted'}</span>
            </div>
            <p className={r.pending ? 'kc-box__wants' : 'kc-box__value'}>{r.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
