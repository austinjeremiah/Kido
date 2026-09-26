'use client';

/**
 * The pipeline, across the top of the pane it drives.
 *
 * These are the backend's real stages, not a decorative progress bar: INTAKE
 * through EXPORT_READY, collapsed to the seven a person cares about. REPAIR is
 * folded into Build because it is a loop back into it rather than a step
 * forward, and SIMULATE and FINAL_VERIFY sit under Tests for the same reason.
 *
 * Approve is listed on its own deliberately. It is the one place the build
 * stops and waits for a human, and folding it into Build would hide the only
 * gate in the pipeline.
 *
 * A step you have already reached is a button back to it. One you have not is
 * inert — not a disabled button, which invites a click and then refuses it, but
 * plain text that was never offered. Build and Tests are never navigable: they
 * are things that happen rather than places to stand, and going "back" to one
 * would only mean watching it again.
 */
import { Check } from 'lucide-react';

export const CREATE_STEPS = [
  { id: 'DESCRIBE', label: 'Describe' },
  { id: 'REQUIREMENTS', label: 'Requirements' },
  { id: 'BLUEPRINT', label: 'Blueprint' },
  { id: 'SECURITY_REVIEW', label: 'Security' },
  { id: 'SIMULATION', label: 'Simulation' },
  { id: 'BUILD', label: 'Build' },
] as const;

export type CreateStepId = (typeof CREATE_STEPS)[number]['id'];

/** Stages that are places to stand rather than things that happen. */
const NAVIGABLE = new Set<CreateStepId>([
  'DESCRIBE',
  'REQUIREMENTS',
  'BLUEPRINT',
  'SECURITY_REVIEW',
  'SIMULATION',
]);

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
