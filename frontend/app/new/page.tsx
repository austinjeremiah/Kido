'use client';

/**
 * Agent creation.
 *
 * Same frame as the entry screen — the project's blue as the ground with a flat
 * cream canvas inset inside it — split down the middle. The conversation runs
 * in the left half; the right half is where the agent takes shape.
 *
 * Everything inside the canvas is wrapped in .cl-studio so it renders in the
 * workbench's own theme: studio.css is scoped under that class, and its canvas
 * token is the same cream this frame is painted in, so the primitives land on
 * it without a single colour restated here.
 */
import { useState } from 'react';
import { PromptComposer } from '@/components/create/PromptComposer';
import { CreateSteps, type CreateStepId } from '@/components/create/CreateSteps';
import { EmptyState } from '@/components/studio/primitives';

export default function CreatePage() {
  const [prompt, setPrompt] = useState<string | null>(null);
  const step: CreateStepId = prompt ? 'REQUIREMENTS' : 'DESCRIBE';

  return (
    <div className="kc">
      <div className="kc-canvas cl-studio">
        <section className="kc-half kc-half--left">
          <header className="kc-chat__head">
            <p className="cl-meta">New agent</p>
            <h1 className="kc-chat__title">What should this agent do?</h1>
            <p className="cl-body">
              Say it in your own words. Every limit you state becomes a rule it cannot
              break — anything you leave out, it will ask about before it builds.
            </p>
          </header>

          <div className="kc-chat__scroll">
            {prompt ? <div className="kc-bubble">{prompt}</div> : null}
          </div>

          <PromptComposer onSubmit={setPrompt} />
        </section>

        <section className="kc-half kc-half--right">
          <CreateSteps current={step} />
          <div className="kc-stage">
            {prompt ? (
              <EmptyState
                title="Reading the description"
                body="Requirements, blueprint and policy will appear here as they are derived."
              />
            ) : (
              <EmptyState
                title="Nothing built yet"
                body="Describe the agent on the left and it takes shape here."
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
