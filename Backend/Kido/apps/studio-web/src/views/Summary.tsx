import type React from "react";
import { useEffect, useState } from "react";
import { PanelProblem } from "./Absent";
import type { LabSummaryView, CapabilityLine } from "../lab-api";
import { NetworkBadges } from "./Reality";

/**
 * The build summary (§P28.5) and the security review (§P28.6).
 *
 * Everything on this screen comes from the canonical Blueprint through
 * `GET /api/lab/projects/:id/summary`. §P28.5 is explicit that there is to be **no independent
 * frontend interpretation**, and §P28.6 says the same thing about the review: *Luna may explain
 * these rules. Luna does not decide them.*
 *
 * So this component composes no sentence. Every CAN and CANNOT line arrives with the Blueprint path
 * it was derived from, and the path is rendered — a claim about what an agent cannot do is worth
 * exactly as much as the field it came from, and showing the field is what lets a reader check it.
 */

function CapabilityList({ kind, lines }: { kind: "CAN" | "CANNOT"; lines: CapabilityLine[] }): React.ReactElement {
  return (
    <section className={`capability-list capability-${kind.toLowerCase()}`}>
      <h4>{kind === "CAN" ? "What this agent can do" : "What this agent cannot do"}</h4>
      <ul>
        {lines.map((l) => (
          <li key={`${l.kind}-${l.statement}`}>
            <span className="mark" aria-hidden="true">{kind === "CAN" ? "✓" : "✕"}</span>
            <span className="statement">{l.statement}</span>
            {/* Where it came from. A derived claim with no source is an assertion. */}
            <code className="derived">{l.derivedFrom}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function BuildSummaryCard({ view }: { view: LabSummaryView }): React.ReactElement {
  const s = view.summary;
  return (
    <section className="build-summary">
      <header>
        <h3>Your agent</h3>
        <span className="revision">Blueprint revision {s.blueprintRevision}</span>
      </header>

      <p className="goal">{s.goal}</p>

      {/*
        * The two networks, as separate labelled blocks with their roles attached. §P28.9 forbids
        * showing a network without its role, and the summary is the first place a user meets both.
        */}
      <NetworkBadges networks={view.networks} />

      <dl className="summary-fields">
        <dt>Identity</dt><dd>{s.name}</dd>
        <dt>Protocols</dt><dd>{s.protocols.join(", ") || "—"}</dd>
        <dt>Verified market data</dt><dd>{s.verifiedMarketData.join(", ") || "—"}</dd>
        <dt>CRE</dt><dd>{s.cre.required ? s.cre.mode : "not required"}</dd>
      </dl>

      <table className="limits">
        <caption>Financial limits, from the Blueprint. Nothing here is a default.</caption>
        <thead>
          <tr><th>Applies to</th><th>Autonomous</th><th>Human approval</th><th>Hard deny</th></tr>
        </thead>
        <tbody>
          <tr className="limit-global">
            <th scope="row">Every action</th>
            <td>{s.autonomous}</td><td>{s.humanApproval}</td><td>{s.hardDeny}</td>
          </tr>
          {/*
            * §P28.57's second half. A per-action row may only ever be tighter than the global one —
            * the validator raises BP-PERACTION at CRITICAL if it is not, because a per-action
            * *expansion* is how an agent ends up acting autonomously above the cap its owner set.
            */}
          {s.perActionLimits.map((p) => (
            <tr key={p.action} className="limit-action">
              <th scope="row">
                {p.action}
                <span className="tightened">tighter than the global limit</span>
              </th>
              <td>{p.autonomous}</td><td>{p.humanApproval}</td><td>{p.hardDeny}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {s.perActionLimits.map((p) => (
        <p key={p.action} className="limit-quote">“{p.sourceQuote}”</p>
      ))}

      <section className="forbidden">
        <h4>Forbidden</h4>
        <ul>{s.forbidden.map((f) => <li key={f}>{f}</li>)}</ul>
      </section>

      {/*
        * A boundary the prompt never established is shown, not defaulted. §P28.4: the system must
        * infer the categories an agent needs and must NOT invent a financial boundary.
        */}
      {view.unestablishedBoundaries.length > 0 && (
        <section className="unestablished">
          <h4>Not established by your description</h4>
          <ul>{view.unestablishedBoundaries.map((u) => <li key={u}>{u}</li>)}</ul>
          <p>These were not inferred. An agent cannot be deployed with a financial boundary nobody set.</p>
        </section>
      )}
    </section>
  );
}

export interface SummaryProps {
  projectId: string;
  fetchSummary: (projectId: string) => Promise<LabSummaryView>;
}

export function SummaryView({ projectId, fetchSummary }: SummaryProps): React.ReactElement {
  const [view, setView] = useState<LabSummaryView | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let live = true;
    setView(null);
    setError(null);
    fetchSummary(projectId)
      .then((v) => { if (live) setView(v); })
      .catch((e: Error) => { if (live) setError(e); });
    return () => { live = false; };
  }, [projectId, fetchSummary]);

  if (error) return <PanelProblem error={error} absent="This project has no compiled Blueprint yet. The design step produces one — until it runs, there is nothing to review." />;
  if (!view) return <p className="loading">Reading the Blueprint…</p>;

  return (
    <div className="summary-view">
      <BuildSummaryCard view={view} />
      <div className="capability-review">
        <CapabilityList kind="CAN" lines={view.capabilities.filter((c) => c.kind === "CAN")} />
        <CapabilityList kind="CANNOT" lines={view.capabilities.filter((c) => c.kind === "CANNOT")} />
      </div>
      <p className="review-note">
        Every line above is derived from a Blueprint field, named beside it. The model wrote the
        Blueprint; it did not write this list, and it cannot add a permission to it.
      </p>
    </div>
  );
}
