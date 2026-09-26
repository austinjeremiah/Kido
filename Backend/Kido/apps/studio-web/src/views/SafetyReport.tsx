import type React from "react";
import { useEffect, useState } from "react";
import type { SafetyReportView, PublicSafetyView, PrivacyClaim } from "../lab-api";

/**
 * The Agent Safety Report (§P28.50–P28.52).
 *
 * > Do not bundle all this into "Private ✓".
 *
 * Confidentiality is six separate claims and usually half of them are "no". A single tick is true of
 * something and tells a reader nothing about which — so each claim renders on its own line with its
 * evidence or its blocker.
 *
 * The public view is fetched from its own endpoint rather than filtered here. A frontend filter is a
 * deny-list, and a field added to the report later would be public by default; the backend builds
 * the public object from an allow-list, so a new field is private until someone adds it on purpose.
 */

function PrivacyRow({ claim }: { claim: PrivacyClaim }): React.ReactElement {
  return (
    <tr className={`privacy-${claim.answer.toLowerCase()}`}>
      <td className="privacy-claim">{claim.claim}</td>
      <td className="privacy-answer">{claim.answer}</td>
      <td className="privacy-evidence">
        {claim.evidence ?? (claim.blocker ? <code>{claim.blocker}</code> : "—")}
      </td>
    </tr>
  );
}

export function PrivacyTable({ privacy }: { privacy: PrivacyClaim[] }): React.ReactElement {
  return (
    <table className="privacy-table">
      <caption>
        Six claims, answered separately. A single "Private ✓" would be true of something and silent
        about which.
      </caption>
      <thead>
        <tr><th>Claim</th><th>Answer</th><th>Evidence</th></tr>
      </thead>
      <tbody>{privacy.map((c) => <PrivacyRow key={c.claim} claim={c} />)}</tbody>
    </table>
  );
}

export interface SafetyReportProps {
  projectId: string;
  fetchReport: (projectId: string) => Promise<SafetyReportView>;
  fetchPublic: (projectId: string) => Promise<PublicSafetyView>;
}

export function SafetyReportPanel({ projectId, fetchReport, fetchPublic }: SafetyReportProps): React.ReactElement {
  const [report, setReport] = useState<SafetyReportView | null>(null);
  const [pub, setPub] = useState<PublicSafetyView | null>(null);
  const [showPublic, setShowPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([fetchReport(projectId), fetchPublic(projectId)])
      .then(([r, p]) => { if (live) { setReport(r); setPub(p); } })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [projectId, fetchReport, fetchPublic]);

  if (error) return <p className="error">{error}</p>;
  if (!report || !pub) return <p className="loading">Loading safety report…</p>;

  return (
    <div className="safety-report">
      <header className="report-header">
        <h3>ContextLock Agent Safety Report</h3>
        <code className="report-hash">{report.reportHash}</code>
        <label className="public-toggle">
          <input type="checkbox" checked={showPublic} onChange={(e) => setShowPublic(e.target.checked)} />
          Show what a public viewer receives
        </label>
      </header>

      {showPublic ? (
        <section className="public-view">
          <p className="public-note">
            Built by the backend from an allow-list — not filtered from the private report. It carries
            no deployments, no runtime digest, no reality sources and no blocker detail.
          </p>
          <dl>
            <dt>Goal</dt><dd>{pub.agent.goal}</dd>
            <dt>Identity</dt><dd>{pub.agent.ensIdentity ?? "—"}</dd>
            <dt>Execution</dt>
            <dd>{pub.execution.networks.map((n) => `${n.name} (${n.role.replace(/_/g, " ")})`).join(", ")}</dd>
            <dt>Production-chain execution</dt><dd>{pub.execution.productionChainExecution}</dd>
            <dt>CRE</dt><dd>{pub.cre.mode} — DON {pub.cre.donDeployment}, TEE {pub.cre.hardwareTee}</dd>
          </dl>
          <PrivacyTable privacy={pub.privacy} />
        </section>
      ) : (
        <>
          <section>
            <h4>Execution boundary</h4>
            <dl>
              <dt>Networks</dt>
              <dd>{report.execution.networks.map((n) => `${n.name} (${n.role.replace(/_/g, " ")})`).join(", ")}</dd>
              <dt>Production-chain execution</dt>
              <dd className="boundary-claim">{report.execution.productionChainExecution}</dd>
            </dl>
            <ul className="evidence-list">
              {report.execution.productionWriteEvidence.map((e) => <li key={e}>{e}</li>)}
            </ul>
          </section>

          <section>
            <h4>CRE</h4>
            <dl>
              <dt>Mode</dt><dd>{report.cre.mode}</dd>
              <dt>WASM</dt><dd>{report.cre.wasmHash ? <code>{report.cre.wasmHash.slice(0, 16)}…</code> : "—"}</dd>
              <dt>Production limits</dt><dd>{report.cre.productionLimits}</dd>
              <dt>DON / TEE / attestation</dt>
              <dd>{report.cre.donDeployment} / {report.cre.hardwareTee} / {report.cre.teeAttestation}</dd>
            </dl>
          </section>

          <section>
            <h4>Reality sources</h4>
            <ul className="source-list">
              {report.reality.sources.map((s) => (
                <li key={s.sourceId} className={s.status === "HEALTHY" ? "ok" : "degraded"}>
                  <span>{s.sourceId}</span> <span>{s.trustClass}</span> <span>{s.status}</span>
                  {s.blocker && <code>{s.blocker}</code>}
                </li>
              ))}
            </ul>
            <p>{report.reality.theGraphState}</p>
            <p>{report.reality.archiveReplayState}</p>
          </section>

          <section>
            <h4>Testing</h4>
            <p>
              Security simulations: {report.testing.securitySimulations.passed}/{report.testing.securitySimulations.total}
            </p>
            <table className="attack-results">
              <thead><tr><th>Attack</th><th>Result</th><th>Stopped by</th><th>Reason</th></tr></thead>
              <tbody>
                {report.testing.attacks.map((a) => (
                  <tr key={a.scenario}>
                    <td>{a.scenario.replace(/_/g, " ")}</td>
                    <td>{a.result}</td>
                    <td>{a.stoppedBy?.replace(/_/g, " ") ?? "—"}</td>
                    <td>{a.reasonCode ? <code>{a.reasonCode}</code> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h4>Privacy</h4>
            <PrivacyTable privacy={report.privacy} />
          </section>

          <section>
            <h4>Known blockers</h4>
            <ul className="blocker-list">
              {report.knownBlockers.map((b) => (
                <li key={b.id}><code>{b.id}</code> — {b.effect}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
