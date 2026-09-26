import type React from "react";
import { useEffect, useState } from "react";
import { PanelProblem } from "./Absent";
import type { ActivationView, TokenRequirementsView } from "../lab-api";

/**
 * The Ready to Activate screen (§P28.30), and the testnet assets it needs (§P28.28).
 *
 * This is the screen between a finished deployment and an agent that can move money. It exists
 * because §P28.29 forbids enabling financial policy inside deployment progress: the two are
 * separate decisions taken by a person who has seen different evidence, and a progress bar that
 * ended with an active agent would collapse them.
 *
 * The two rows that matter are the last two. The policy is DISABLED and mainnet execution is
 * IMPOSSIBLE — both true right now, and one of them is about to change.
 */

export function TokenRequirementsTable({ view }: { view: TokenRequirementsView }): React.ReactElement {
  return (
    <section className="token-requirements">
      <h4>Test assets this agent needs</h4>
      <table>
        <thead><tr><th>Asset</th><th>Why</th><th>Where from</th><th>Value</th></tr></thead>
        <tbody>
          {view.requirements.map((r) => (
            <tr key={r.symbol}>
              <td><code>{r.symbol}</code></td>
              <td>{r.purpose}</td>
              <td>{r.source}</td>
              {/*
                * §P28.28: no requirement may imply the tokens are worth anything, and ContextLock
                * never calls a faucet for you. Both are rendered rather than assumed.
                */}
              <td className="no-value">{r.realWorldValue}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="testnet-note">{view.note}</p>
    </section>
  );
}

export interface ActivateProps {
  projectId: string;
  fetchActivation: (projectId: string) => Promise<ActivationView>;
  fetchTokens: (projectId: string) => Promise<TokenRequirementsView>;
  onActivate: (projectId: string) => Promise<void>;
}

export function ActivateView({ projectId, fetchActivation, fetchTokens, onActivate }: ActivateProps): React.ReactElement {
  const [data, setData] = useState<ActivationView | null>(null);
  const [tokens, setTokens] = useState<TokenRequirementsView | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetchActivation(projectId)
      .then((d) => { if (live) setData(d); })
      .catch((e: Error) => { if (live) setError(e); });
    fetchTokens(projectId)
      .then((d) => { if (live) setTokens(d); })
      .catch(() => { /* the asset list is informative; its absence does not block this screen */ });
    return () => { live = false; };
  }, [projectId, fetchActivation, fetchTokens]);

  if (error) return <PanelProblem error={error} absent="No deployment state for this project, so there is nothing to activate." />;
  if (!data) return <p className="loading">Checking activation readiness…</p>;

  const { readiness } = data;
  const activate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onActivate(projectId);
      setData(await fetchActivation(projectId));
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="activate">
      <h3>Testnet agent ready</h3>
      <table className="activation-rows">
        <tbody>
          {readiness.rows.map((r) => (
            <tr key={r.label} className={`act-${r.status.toLowerCase()}`}>
              <th scope="row">{r.label}</th>
              <td className="act-value">{r.value}</td>
              <td className="act-detail">{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {tokens && <TokenRequirementsTable view={tokens} />}

      <section className="activation-action">
        {/*
          * The consequence, before the button. Not "are you sure?" — the question a user needs
          * answered is what this grants, and it is answered above the control that grants it.
          */}
        <p className="activation-consequence">{readiness.consequence}</p>
        {!readiness.canActivate && (
          <p className="activation-blocked">Blocked by: {readiness.blockedBy.join(", ")}</p>
        )}
        {confirming ? (
          <div className="activation-confirm" role="group" aria-label="confirm activation">
            <p>
              This enables the ContextLock policy on chain. It is read back from the chain
              afterwards, and the agent is not active until that read says so.
            </p>
            <button type="button" className="primary" onClick={() => void activate()} disabled={busy}>
              {busy ? "Activating…" : `Yes — ${readiness.buttonLabel}`}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
          </div>
        ) : (
          <button
            type="button"
            className="primary"
            onClick={() => setConfirming(true)}
            disabled={!readiness.canActivate}
            aria-disabled={!readiness.canActivate}
          >
            {readiness.buttonLabel}
          </button>
        )}
      </section>
    </div>
  );
}
