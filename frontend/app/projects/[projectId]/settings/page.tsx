'use client';

/** Settings: the project name, the backend's configuration, and identifiers. */
import { useEffect, useState } from 'react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Card, CopyButton, KeyValue } from '@/components/studio/primitives';
import { WithProject, useKido } from '@/components/studio/kido';
import { useHealth } from '@/lib/kido/hooks';

function Rename({ name }: { name: string }) {
  const { lifecycle } = useKido();
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  return (
    <div className="cl-row" style={{ gap: 8 }}>
      <input className="cl-input" style={{ flex: 1 }} value={v} onChange={(e) => setV(e.target.value)} aria-label="Project name" />
      <button type="button" className="cl-btn cl-btn-primary" disabled={!v.trim() || v === name || lifecycle.rename.isPending} onClick={() => lifecycle.rename.mutate([v])}>
        Save
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const health = useHealth();
  return (
    <StudioPage segment="settings">
      <WithProject>
        {(s) => (
          <div className="cl-stack" style={{ gap: 16 }}>
            <Card title="Project name"><Rename name={s.name} /></Card>
            <Card title="Identifiers">
              <KeyValue rows={[{ label: 'Project', value: <span>{s.projectId} <CopyButton value={s.projectId} /></span>, mono: true }, { label: 'Agent id', value: s.kidoAgentId ?? '—', mono: true }, { label: 'Blueprint hash', value: s.blueprintHash ?? '—', mono: true }]} />
            </Card>
            <Card title="Backend">
              <KeyValue
                rows={[
                  { label: 'API', value: health.data?.ok ? 'reachable' : health.isError ? 'unreachable' : '…' },
                  { label: 'Interview model', value: health.data?.interviewModel === 'openai' ? 'live model (OpenAI)' : 'rule-based' },
                  { label: 'Signer addresses', value: health.data?.simulationSigners ? 'throwaway (simulation only): set KIDO_CONTROLLER_ADDRESSES, KIDO_ISSUER_ADDRESS, KIDO_AGENT_ADDRESS' : 'configured' },
                ]}
              />
            </Card>
          </div>
        )}
      </WithProject>
    </StudioPage>
  );
}
