/**
 * The security review, derived from the answers themselves.
 *
 * Every finding here is a real check against what was actually captured, not a
 * fixed list dressed up as analysis. If a check does not fire, its finding does
 * not appear — which is the point: a review that always returns the same three
 * items is decoration, and a reader learns to skip it.
 *
 * Placeholder only in the sense that the backend runs a far broader review than
 * this. The shape of the output, and the rule that each finding is acknowledged
 * individually by id, is the real one.
 */
import type { Severity } from '@/lib/studio/types';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  body: string;
}

/** Pulls the first number out of an answer, ignoring separators. */
function amount(text: string | undefined): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export function reviewOf(answers: Record<string, string>): Finding[] {
  const found: Finding[] = [];

  const ceiling = amount(answers.req_ceiling);
  const autonomous = amount(answers.req_autonomous);
  const window = amount(answers.req_window);

  if (ceiling !== null && autonomous !== null && ceiling === autonomous) {
    found.push({
      id: 'no-escalation-band',
      severity: 'MEDIUM',
      title: 'No escalation band',
      body:
        'The autonomous limit and the hard ceiling are the same figure, so there is no range in ' +
        'which an action stops for your approval. Every action either executes or is refused.',
    });
  }

  if (ceiling !== null && autonomous !== null && autonomous > ceiling) {
    found.push({
      id: 'autonomous-above-ceiling',
      severity: 'HIGH',
      title: 'Autonomous limit exceeds the ceiling',
      body:
        'The agent is permitted to act alone above the amount it may never exceed. The ceiling ' +
        'holds, so the autonomous limit above it can never be reached — one of the two is wrong.',
    });
  }

  if (window !== null && autonomous !== null && window < autonomous) {
    found.push({
      id: 'window-below-action',
      severity: 'MEDIUM',
      title: 'Window total is below the per-action limit',
      body:
        'The rolling window allows less in total than a single autonomous action is permitted to ' +
        'spend, so the first action of the window will exhaust it.',
    });
  }

  /* Always reported. Not a defect — a statement of what the policy is resting
     on, which is worth acknowledging explicitly before anything is generated. */
  found.push({
    id: 'allowlist-is-load-bearing',
    severity: 'INFO',
    title: 'The recipient allowlist is load-bearing',
    body:
      'Payment to an address outside the allowlist is refused at the policy layer rather than ' +
      'on-chain. That allowlist is the only thing standing between this agent and an arbitrary ' +
      'recipient, so it is worth reading once more before you approve.',
  });

  return found;
}
