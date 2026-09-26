'use client';

/**
 * Attack Lab: try to make the agent do something it should not, and see which layer stops it.
 *
 *  - Catalogue: every scenario of the simulation report, grouped by family, expected vs actual.
 *  - What-if: a hand-built action (or a preset attack derived from the blueprint's own limits,
 *    payees and lease) judged by the same compiler and Amane subset rules the chain enforces.
 *  - Prompt injection: an injected instruction turned into a proposal and run through the plan
 *    validator, the compiler and the Amane rules, stage by stage.
 *
 * Nothing on this page signs or submits a transaction; every verdict is what the rules say.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, TabStrip } from '@/components/studio/primitives';
import { GateButton, NotYet, WithProject } from '@/components/studio/kido';
import { Catalogue } from '@/components/studio/attack-lab/Catalogue';
import { WhatIfTester } from '@/components/studio/attack-lab/WhatIfTester';
import { InjectionTester } from '@/components/studio/attack-lab/InjectionTester';
import { useReality } from '@/lib/kido/hooks';
import type { ProjectSummary } from '@/lib/kido/types';

type Tab = 'catalogue' | 'what-if' | 'injection';

export default function AttackLabPage() {
  return (
    <StudioPage segment="attacks" actions={<GateButton gate="simulate" label="Re-run simulation" />}>
      <WithProject>{(s) => <AttackLab s={s} />}</WithProject>
    </StudioPage>
  );
}

function AttackLab({ s }: { s: ProjectSummary }) {
  const params = useSearchParams();
  const initial = params.get('tab');
  const [tab, setTab] = useState<Tab>(initial === 'what-if' || initial === 'injection' ? initial : 'catalogue');
  // Assets the Amane deployment has on the blueprint's chains but the blueprint does not list:
  // the "unlisted asset" preset uses one of them rather than an invented symbol.
  const reality = useReality(s.projectId);
  const unlisted = useMemo(() => {
    const listed = new Set((s.blueprint?.assets ?? []).map((a) => `${String(a.chain)}:${String(a.symbol)}`));
    return (reality.data?.probes ?? [])
      .map((p) => ({ chain: p.chain, m: /^assets\.([^.]+)\.address$/.exec(p.label) }))
      .filter((x): x is { chain: string; m: RegExpExecArray } => Boolean(x.m))
      .map((x) => ({ chain: x.chain, symbol: x.m[1]! }))
      .filter((x) => !listed.has(`${x.chain}:${x.symbol}`));
  }, [reality.data, s.blueprint]);

  const bp = s.blueprint;
  const sim = s.simulation;
  const attacks = sim?.results.filter((r) => r.expected === 'REJECT') ?? [];
  const held = attacks.filter((r) => r.passed).length;

  return (
    <>
      <div className="cl-row cl-row-wrap" style={{ gap: 6, marginBottom: 12 }}>
        {bp ? <Badge tone="neutral">Blueprint r{bp.revision}</Badge> : null}
        {bp?.authority.provider ? <Badge tone="neutral">Authority: {bp.authority.provider}</Badge> : null}
        {sim ? <Badge tone={held === attacks.length ? 'pass' : 'deny'}>{held}/{attacks.length} attacks refused in simulation</Badge> : <Badge tone="blocked">not simulated</Badge>}
        <Badge tone="sim">Dry run · nothing is signed or sent</Badge>
      </div>
      {bp && bp.authority.provider !== 'AMANE' ? (
        <BlockerBanner tone="warn" title="No Amane authority on this blueprint">
          The what-if and injection testers judge actions against the Amane account the blueprint compiles to. This blueprint’s authority is {bp.authority.provider ?? 'not set'}, so they will report that no on-chain authority exists.
        </BlockerBanner>
      ) : null}
      <TabStrip
        tabs={[
          { id: 'catalogue', label: 'Attack catalogue', badge: sim ? <span className="cl-meta" style={{ marginLeft: 6 }}>{sim.results.length}</span> : undefined },
          { id: 'what-if', label: 'What-if tester' },
          { id: 'injection', label: 'Prompt injection' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {/* All three stay mounted so the what-if history and the forms survive switching tabs. */}
      <div hidden={tab !== 'catalogue'}><Catalogue s={s} /></div>
      {!bp ? (
        tab !== 'catalogue' ? <NotYet what="blueprint" where="composer" id={s.projectId} /> : null
      ) : (
        <>
          <div hidden={tab !== 'what-if'}><WhatIfTester key={bp.revision} bp={bp} id={s.projectId} unlisted={unlisted} /></div>
          <div hidden={tab !== 'injection'}><InjectionTester key={bp.revision} bp={bp} id={s.projectId} /></div>
        </>
      )}
    </>
  );
}
