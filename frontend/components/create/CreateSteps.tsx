'use client';

/**
 * The pipeline, named in the top bar.
 *
 * These are the backend's real stages, not a decorative progress bar: INTAKE
 * through EXPORT_READY, collapsed to the seven a person cares about. REPAIR is
 * folded into Build because it is a loop back into it rather than a step
 * forward, and SIMULATE and FINAL_VERIFY sit under Tests for the same reason.
 *
 * Approve is listed as its own step deliberately. It is the one place the build
 * stops and waits for a human, and burying it inside Build would hide the only
 * gate in the pipeline.
 *
 * Sized like the workbench's own .cl-badge (21px tall, 10.5px text) rather than
 * as hero-scale pills — this rides inside a 44px chrome bar next to the mark,
 * the same bar the product uses everywhere else.
 */
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
    <nav className="kc-steps" aria-label="Agent creation progress">
      <ol className="kc-steps__list">
        {CREATE_STEPS.map((step, i) => {
          const state = i < index ? 'done' : i === index ? 'current' : 'todo';
          return (
            <li key={step.id} className="kc-steps__item" data-state={state}>
              <span className="kc-steps__num" aria-hidden>
                {i + 1}
              </span>
              <span className="kc-steps__label">{step.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="kc-steps__compact">
        {index + 1}/{CREATE_STEPS.length} · {CREATE_STEPS[index]?.label}
      </p>
    </nav>
  );
}
