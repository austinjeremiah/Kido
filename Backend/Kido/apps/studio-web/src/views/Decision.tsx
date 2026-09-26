import type React from "react";
import { useEffect, useState } from "react";
import type { DecisionDetailView } from "../lab-api";

/**
 * Why did it act? (§P28.34)
 *
 * Every value comes from the deterministic record — the reason code the engine emitted, the hash of
 * the snapshot the decision cited, the network the capability was bound to. None of it is narrated.
 * A generated explanation is a plausible story about a decision rather than the decision, and the
 * two diverge exactly when someone needs the truth.
 *
 * The withheld block is the other half. The confidential policy's parameter values stay in the CRE
 * workflow, and naming what is not shown is more honest than omitting it silently: a reader who can
 * see that thresholds exist and are not displayed understands the boundary.
 */

export function DecisionDetailPanel({ detail, onClose }: { detail: DecisionDetailView; onClose?: () => void }): React.ReactElement {
  return (
    <section className={`decision-detail decision-${detail.verdict.toLowerCase()}`}>
      <header>
        <h4>Decision</h4>
        <strong className={`verdict verdict-${detail.verdict.toLowerCase()}`}>{detail.verdict}</strong>
        {onClose && <button type="button" onClick={onClose}>close</button>}
      </header>

      <p className="decision-reason">
        <code>{detail.reasonCode}</code> — {detail.reasonPlain}
      </p>
      {detail.synthetic && (
        <p className="decision-synthetic">
          This decision was made against a scenario overlay, not a live reading. SYNTHETIC OVERLAY.
        </p>
      )}

      <dl className="decision-fields">
        {detail.fields.map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd>
              {f.value}
              <span className="decision-source">{f.source}</span>
            </dd>
          </div>
        ))}
      </dl>

      <section className="decision-withheld">
        <h5>Not shown</h5>
        {detail.withheld.map((w) => (
          <p key={w.what}><strong>{w.what}</strong> — {w.why}</p>
        ))}
      </section>

      <p className="decision-correlation">correlation <code>{detail.correlationId}</code></p>
    </section>
  );
}

export interface DecisionProps {
  projectId: string;
  correlationId: string;
  fetchDecision: (projectId: string, correlationId: string) => Promise<DecisionDetailView>;
  onClose?: () => void;
}

export function DecisionView({ projectId, correlationId, fetchDecision, onClose }: DecisionProps): React.ReactElement {
  const [detail, setDetail] = useState<DecisionDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    fetchDecision(projectId, correlationId)
      .then((d) => { if (live) setDetail(d); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [projectId, correlationId, fetchDecision]);

  if (error) return <p className="empty">No deterministic decision record for this correlation id. {error}</p>;
  if (!detail) return <p className="loading">Reading the decision…</p>;
  return onClose ? <DecisionDetailPanel detail={detail} onClose={onClose} /> : <DecisionDetailPanel detail={detail} />;
}
