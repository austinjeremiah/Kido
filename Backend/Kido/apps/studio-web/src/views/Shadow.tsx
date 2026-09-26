import type React from "react";
import { useEffect, useState } from "react";
import type { ShadowView } from "../lab-api";

/**
 * Shadow mode (§P28.40) and the fork action detail (§P28.41).
 *
 * The whole panel exists to hold two things apart that a screen naturally merges: what the agent
 * decided *about mainnet*, and where the action actually happened. A verdict rendered above a
 * transaction hash, with nothing between them, describes a mainnet trade.
 *
 * So the decision and the execution are separate blocks with the execution environment named in
 * both, `PUBLIC MAINNET TRANSACTION: NONE` is a row rather than an omission, and the fork block
 * ends with an explicit statement that no explorer exists — because the hash cannot tell you.
 */

export function ShadowRunPanel({ run }: { run: ShadowView["run"] }): React.ReactElement {
  return (
    <section className="shadow-run">
      <h4>Shadow agent</h4>
      <div className="shadow-grid">
        <div className="shadow-watching">
          <span className="shadow-label">Watching</span>
          <strong>{run.watching.name}</strong>
          <span className="badge badge-readonly">{run.watching.roleLabel}</span>
        </div>
        <div className="shadow-decision">
          <span className="shadow-label">Decision</span>
          <strong className={`verdict verdict-${run.decision.toLowerCase()}`}>{run.decision}</strong>
          <code>{run.reasonCode}</code>
        </div>
        <div className="shadow-proposed">
          <span className="shadow-label">Would have</span>
          <strong>{run.proposedAction.kind} {run.proposedAction.amount} {run.proposedAction.asset.toUpperCase()}</strong>
          <span>via {run.proposedAction.protocol}</span>
        </div>
        <div className="shadow-actual">
          <span className="shadow-label">Actual execution</span>
          <strong>{run.actualExecution.label}</strong>
        </div>
        {/* A row, not an absence. §P28.40's last line, rendered. */}
        <div className="shadow-public">
          <span className="shadow-label">Public mainnet transaction</span>
          <strong className="none">{run.publicMainnetTransaction}</strong>
        </div>
      </div>
      <p className="shadow-provenance">
        Decided against snapshot <code>{run.marketSnapshotHash.slice(0, 20)}…</code>
        {run.scenarioHash && <> with scenario <code>{run.scenarioHash.slice(0, 20)}…</code> — SYNTHETIC OVERLAY</>}
      </p>
    </section>
  );
}

export function ForkActionPanel({ fork }: { fork: ShadowView["fork"] }): React.ReactElement {
  return (
    <section className="fork-action">
      <h4>{fork.heading}</h4>
      <dl>
        <dt>Source chain</dt><dd>{fork.sourceChain}</dd>
        <dt>Source block</dt><dd>{fork.sourceBlock}</dd>
        <dt>Source block hash</dt><dd><code>{fork.sourceBlockHash}</code></dd>
        <dt>Protocol</dt><dd>{fork.protocol}</dd>
        <dt>Input</dt><dd>{fork.input}</dd>
        <dt>Output</dt><dd>{fork.output}</dd>
        <dt>Transaction</dt><dd><code>{fork.transactionHash}</code> <span className="fork-label">{fork.transaction}</span></dd>
        <dt>Status</dt><dd>{fork.status} · gas {fork.gasUsed}</dd>
        {/*
          * Never a link. A local Anvil hash pasted into Etherscan produces "unable to locate this
          * TxnHash", which reads as "not indexed yet" rather than "this never happened".
          */}
        <dt>Public explorer</dt><dd className="none">{fork.publicExplorer}</dd>
      </dl>
      <p className="fork-explorer-note">{fork.explorerNote}</p>
    </section>
  );
}

export interface ShadowProps {
  projectId: string;
  fetchShadow: (projectId: string) => Promise<ShadowView>;
}

export function ShadowPanel({ projectId, fetchShadow }: ShadowProps): React.ReactElement {
  const [data, setData] = useState<ShadowView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchShadow(projectId)
      .then((d) => { if (live) setData(d); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [projectId, fetchShadow]);

  if (error) return <p className="empty">No shadow run recorded for this project. {error}</p>;
  if (!data) return <p className="loading">Reading shadow run…</p>;

  return (
    <div className="shadow">
      <ShadowRunPanel run={data.run} />
      <ForkActionPanel fork={data.fork} />
    </div>
  );
}
