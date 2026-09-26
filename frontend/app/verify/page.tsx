'use client';

/**
 * Public agent verification by ENS name. Anyone pastes an agent's name; Kido reads its ENSv2
 * records, resolves its multichain addresses, and checks each Amane account on its own chain —
 * and, when the agent publishes one, resolves its live name through CCIP-read.
 */
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LivePanel, VerifyPanel } from '@/components/studio/EnsIdentity';
import { kido } from '@/lib/kido/api';

function Verify() {
  const params = useSearchParams();
  const [input, setInput] = useState(params.get('name') ?? '');
  const [name, setName] = useState<string | null>(params.get('name'));
  const [live, setLive] = useState<string | null>(null);
  const go = (n: string) => {
    const v = n.trim().toLowerCase();
    if (v.endsWith('.eth')) setName(v);
  };
  // The live name comes from the agent's own records (kido-live).
  useEffect(() => {
    setLive(null);
    if (name) kido.verify(name).then((r) => setLive(r.agent?.live ?? null)).catch(() => setLive(null));
  }, [name]);
  return (
    <div className="cl-studio cl-dark ens-page">
      <main className="ens-page__main">
        <a href="/" className="ens-brand">Kido</a>
        <h1 className="ens-page__title">Verify an agent by its ENS name</h1>
        <p className="ens-meta" style={{ maxWidth: 620 }}>A name is how you find an agent, never what gives it power. Paste one and Kido checks, on-chain, that it points at a real Kido agent and which Amane accounts enforce what it may do.</p>
        <form className="ens-search" onSubmit={(e) => { e.preventDefault(); go(input); }}>
          <input className="cl-input ens-mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="treasury.kidomuhsw6k2.eth" spellCheck={false} />
          <button type="submit" className="cl-btn cl-btn-primary">Verify</button>
        </form>
        {name ? <VerifyPanel key={name} name={name} /> : null}
        {live ? <LivePanel key={live} name={live} /> : null}
      </main>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={null}>
      <Verify />
    </Suspense>
  );
}
