'use client';

/**
 * The creation pipeline, across the top of the pane it drives: describe the agent (or pick a
 * template), answer what only you can answer, name it, review what it will be, let the checks run,
 * and see what it costs before you continue. A step already reached is a button back to it; Checks
 * is something that happens rather than a place to stand, so it is never navigable.
 */
import { Check } from 'lucide-react';

export const CREATE_STEPS = [
  { id: 'DESCRIBE', label: 'Describe' },
  { id: 'QUESTIONS', label: 'Questions' },
  { id: 'IDENTITY', label: 'Identity' },
  { id: 'REVIEW', label: 'Review' },
  { id: 'CHECKS', label: 'Checks' },
  { id: 'COSTS', label: 'Costs' },
] as const;

export type CreateStepId = (typeof CREATE_STEPS)[number]['id'];

/** Stages that are places to stand rather than things that happen. */
const NAVIGABLE = new Set<CreateStepId>(['DESCRIBE', 'QUESTIONS', 'IDENTITY', 'REVIEW', 'COSTS']);

export function CreateSteps({
  current,
  furthest,
  onSelect,
}: {
  current: CreateStepId;
  /** The furthest step reached, which is as far back as one can jump from. */
  furthest: CreateStepId;
  onSelect: (id: CreateStepId) => void;
}) {
  const index = CREATE_STEPS.findIndex((s) => s.id === current);
  const reached = CREATE_STEPS.findIndex((s) => s.id === furthest);

  return (
    <nav className="kc-rail" aria-label="Build progress">
      <ol className="kc-rail__list">
        {CREATE_STEPS.map((step, i) => {
          const state = i < index ? 'done' : i === index ? 'current' : 'todo';
          const canGo = i <= reached && i !== index && NAVIGABLE.has(step.id);

          const body = (
            <>
              <span className="kc-rail__dot" aria-hidden>
                {state === 'done' ? <Check size={12} strokeWidth={3} /> : i + 1}
              </span>
              <span className="kc-rail__label">{step.label}</span>
            </>
          );

          return (
            <li
              key={step.id}
              className="kc-rail__step"
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              {canGo ? (
                <button
                  type="button"
                  className="kc-rail__go"
                  onClick={() => onSelect(step.id)}
                  title={`Back to ${step.label}`}
                >
                  {body}
                </button>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
