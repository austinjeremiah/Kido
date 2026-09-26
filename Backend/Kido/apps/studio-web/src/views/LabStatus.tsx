import type React from "react";
import type { LabStateView } from "../lab-api";

/**
 * The Testnet Lab header (§P28.32).
 *
 * Two rules shape it.
 *
 * The headline claim is `PRODUCTION-CHAIN EXECUTION: DISABLED`, not "Real capital at risk: $0". The
 * second is a statement about the world — about what tokens are worth, which nobody here controls —
 * and it is false the moment a testnet asset acquires a price. The first is a statement about this
 * system, enforced at ten named fences.
 *
 * And `PAUSED` is rendered as a state that **still holds financial authority**. A paused container
 * with an enabled policy is one unpause away from acting; a header that showed it as safe would
 * teach exactly the misunderstanding the control panel exists to prevent.
 */

const TONE: Record<string, string> = {
  LAB_ACTIVE: "state-active",
  PAUSED: "state-warn",
  DEGRADED: "state-warn",
  EMERGENCY_LOCKED: "state-alarm",
  FAILED: "state-alarm",
};

export function LabStatusHeader({ view }: { view: LabStateView }): React.ReactElement {
  const exec = view.mode.execution.networks[0];

  return (
    <section className={`lab-status ${TONE[view.state] ?? "state-neutral"}`}>
      <div className="lab-status-headline">
        <span className="dot" aria-hidden="true">●</span>
        <h2>{view.label.headline}</h2>
        {view.hasFinancialAuthority && (
          <span className="authority-badge" title="This agent can currently issue a capability">
            FINANCIAL AUTHORITY: ACTIVE
          </span>
        )}
      </div>

      <p className="lab-status-detail">{view.label.detail}</p>
      <p className="lab-status-because">
        <span className="because-label">Because</span> {view.because}
      </p>

      <dl className="lab-status-grid">
        <div>
          <dt>Execution</dt>
          <dd>{exec ? `${exec.name} — ${exec.role.replace(/_/g, " ")}` : "none"}</dd>
        </div>
        <div>
          <dt>Market reality</dt>
          <dd>{view.mode.mainnet.summary}</dd>
        </div>
        <div>
          <dt>CRE</dt>
          <dd>{view.mode.cre.summary}</dd>
        </div>
        <div>
          <dt>Financial policy</dt>
          <dd>{view.hasFinancialAuthority ? "Enabled" : "Disabled"}</dd>
        </div>
      </dl>

      {/*
        * The claim, verbatim from the backend. Not composed here — a header that assembled its own
        * safety sentence would be asserting something the frontend believes.
        */}
      <p className="headline-claim">{view.headlineClaim}</p>

      {view.degradedDependencies.length > 0 && (
        <p className="degraded-list">
          Unhealthy: {view.degradedDependencies.join(", ")}
        </p>
      )}

      {view.nextAction && <p className="next-action">Next: {view.nextAction}</p>}
    </section>
  );
}

/**
 * The inputs the state was computed from.
 *
 * Shown on purpose. A status a user can check beats a status they have to trust, and the whole
 * lifecycle design rests on the state being a projection rather than a stored flag — this is where
 * that becomes visible rather than merely true.
 */
export function LabStateEvidence({ view }: { view: LabStateView }): React.ReactElement {
  return (
    <details className="lab-evidence">
      <summary>Computed from</summary>
      <pre>{JSON.stringify(view.computedFrom, null, 2)}</pre>
      <p className="evidence-note">
        The lifecycle state is not stored. It is recomputed from these values on every read, so a
        second source of truth about financial authority cannot drift from the first.
      </p>
    </details>
  );
}
