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
 * Not tabs: you cannot click ahead to a stage that has not happened. It reports
 * where the build is, which is why it renders as a rail rather than as a
 * TabStrip.
 */
import { Check } from 'lucide-react';

export const CREATE_STEPS = [
  { id: 'DESCRIBE', label: 'Describe' },
  { id: 'REQUIREMENTS', label: 'Requirements' },
  { id: 'BLUEPRINT', label: 'Blueprint' },
  { id: 'SECURITY_REVIEW', label: 'Security' },
  { id: 'AWAITING_APPROVAL', label: 'Approve' },
  { id: 'BUILD', label: 'Build' },
  { id: 'TEST', label: 'Tests' },
] as const;

export type CreateStepId = (typeof CREATE_STEPS)[number]['id'];

export function CreateSteps({ current }: { current: CreateStepId }) {
  const index = CREATE_STEPS.findIndex((s) => s.id === current);

  return (
    <nav className="kc-rail" aria-label="Build progress">
      <ol className="kc-rail__list">
        {CREATE_STEPS.map((step, i) => {
          const state = i < index ? 'done' : i === index ? 'current' : 'todo';
          return (
            <li key={step.id} className="kc-rail__step" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="kc-rail__dot" aria-hidden>
                {state === 'done' ? <Check size={12} strokeWidth={3} /> : i + 1}
              </span>
              <span className="kc-rail__label">{step.label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
