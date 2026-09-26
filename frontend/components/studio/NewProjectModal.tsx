'use client';

/**
 * New-agent modal: a name, the objective in plain words and an optional template that pre-fills the
 * objective. Creating a project on the Kido backend starts its design interview; nothing about
 * authority, identity or deployment exists yet. On success it opens the project's Composer, where
 * the interview's first question is waiting.
 *
 * A template only pre-fills text. It never states a financial ceiling on the user's behalf beyond
 * what its own wording says, and the interview still asks for anything the objective leaves open.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from './dialogs';
import { Badge } from './primitives';
import { PROJECT_TEMPLATES } from '@/lib/studio/content/templates';
import { kido } from '@/lib/kido/api';
import { keys, useHealth } from '@/lib/kido/hooks';

/** The backend rejects anything shorter as not describing an agent. */
const MIN_OBJECTIVE = 10;
const BLANK = PROJECT_TEMPLATES.find((t) => !t.prompt)?.id ?? '';

export function NewProjectModal({ open, onClose, templateId: initialTemplate }: { open: boolean; onClose: () => void; templateId?: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const health = useHealth();
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [templateId, setTemplateId] = useState(initialTemplate ?? BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* A template chosen elsewhere arrives with the modal open. */
  useEffect(() => {
    if (!open || !initialTemplate) return;
    pick(initialTemplate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTemplate]);

  const pick = (id: string) => {
    setTemplateId(id);
    const t = PROJECT_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setObjective(t.prompt);
    if (t.prompt && !name.trim()) setName(t.name);
  };

  const trimmed = objective.trim();
  const canCreate = trimmed.length >= MIN_OBJECTIVE && !busy;

  const create = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await kido.create(trimmed, name.trim() || undefined);
      await qc.invalidateQueries({ queryKey: keys.projects });
      onClose();
      setName('');
      setObjective('');
      setTemplateId(BLANK);
      router.push(`/projects/${r.projectId}/build`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chosen = PROJECT_TEMPLATES.find((t) => t.id === templateId);

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="New agent"
      subtitle="Starts Kido's design interview. No policy, lease, identity or deployment is created yet."
      wide
      footer={
        <>
          <span className="cl-meta" style={{ marginRight: 'auto' }}>
            {health.data ? `Interview: ${health.data.interviewModel === 'openai' ? 'live model' : 'rule-based'}` : null}
          </span>
          <button type="button" className="cl-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="cl-btn cl-btn-primary" onClick={() => void create()} disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create and open Composer'}
          </button>
        </>
      }
    >
      {error ? (
        <p className="cl-meta" role="alert" style={{ color: 'var(--cl-deny)', whiteSpace: 'normal', marginBottom: 10 }}>
          {error}
        </p>
      ) : null}

      <div className="cl-field">
        <label className="cl-field-label" htmlFor="np-name">
          Name <span className="cl-dim">(optional)</span>
        </label>
        <input id="np-name" className="cl-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Kido names it from the objective when left empty" autoComplete="off" />
      </div>

      <div className="cl-field">
        <span className="cl-field-label">Template <span className="cl-dim">(optional)</span></span>
        <div className="cl-grid cl-grid-2" role="radiogroup" aria-label="Template">
          {PROJECT_TEMPLATES.map((t) => {
            const active = t.id === templateId;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={active}
                className="cl-card"
                onClick={() => pick(t.id)}
                style={{ textAlign: 'left', cursor: 'pointer', padding: 0, borderColor: active ? 'var(--cl-ink)' : 'var(--cl-line)', background: active ? 'var(--cl-wash)' : undefined }}
              >
                <div className="cl-card-body">
                  <div className="cl-strong" style={{ fontSize: 12.5 }}>{t.name}</div>
                  <p className="cl-meta" style={{ margin: '5px 0 8px', whiteSpace: 'normal' }}>{t.description}</p>
                  <div className="cl-row cl-row-wrap" style={{ gap: 5 }}>
                    {t.protocols.length === 0 ? <Badge tone="neutral">No preset protocols</Badge> : t.protocols.map((x) => <Badge key={x} tone="neutral">{x}</Badge>)}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <span className="cl-field-hint">
          A template pre-fills the objective below; edit it freely. Kido selects providers from its registry, and anything it cannot support
          becomes a blocker rather than a guess.
        </span>
      </div>

      <div className="cl-field" style={{ marginBottom: 0 }}>
        <label className="cl-field-label" htmlFor="np-objective">
          Objective
        </label>
        <textarea
          id="np-objective"
          className="cl-textarea"
          rows={5}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canCreate) {
              e.preventDefault();
              void create();
            }
          }}
          placeholder="Pay my contractors: a ceiling per payment, a daily ceiling, and only to the payees I list…"
        />
        <span className="cl-field-hint">
          {trimmed.length < MIN_OBJECTIVE ? `At least ${MIN_OBJECTIVE} characters. ` : chosen?.prompt && trimmed === chosen.prompt.trim() ? `From “${chosen.name}”. ` : ''}
          Say what the agent should do, its limits and who it may pay. The interview asks for anything left open. Do not paste secrets or
          private keys.
        </span>
      </div>
    </Modal>
  );
}
