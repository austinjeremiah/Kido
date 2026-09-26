import type React from "react";
import { useEffect, useState } from "react";
import { PanelProblem } from "./Absent";
import type { CreConnectView, ParityView } from "../lab-api";

/**
 * Connect My Chainlink CRE (§P28.15, §P28.17), and promotion parity (§P28.24).
 *
 * The screen's job is to make an absence visible. ContextLock never sees the CRE credential, and
 * the way to show that is to render the path — ContextLock, Local Bridge, the CLI, Chainlink's own
 * browser login — and say at each step what crosses. A reassuring sentence claiming the same thing
 * would be worth nothing, because a product that *did* take the password could print it too.
 *
 * There is deliberately no form here. Not a disabled one, not a hidden one: the flow has no step at
 * which ContextLock could accept a credential, and a rendered input would contradict that.
 */

const KIND_LABEL: Record<string, string> = {
  CONTEXTLOCK: "ContextLock",
  LOCAL_BRIDGE: "Local Bridge",
  CRE_CLI: "CRE CLI",
  CHAINLINK_BROWSER: "Chainlink",
};

export function ConnectFlowSteps({ flow }: { flow: CreConnectView["flow"] }): React.ReactElement {
  return (
    <section className="cre-connect-flow">
      <ol>
        {flow.steps.map((s, i) => (
          <li key={`${s.kind}-${i}`} className={`step-${s.kind.toLowerCase()}`}>
            <span className="step-where">{KIND_LABEL[s.kind] ?? s.kind}</span>
            <h5>{s.label}</h5>
            <p className="step-detail">{s.detail}</p>
            <p className="step-carries"><em>carries</em> {s.carries}</p>
            {s.bridgeOperation && <code className="step-op">{s.bridgeOperation}</code>}
          </li>
        ))}
      </ol>
      <div className="never-requested">
        <h5>ContextLock never asks you for</h5>
        <ul>{flow.neverRequested.map((n) => <li key={n}>{n}</li>)}</ul>
      </div>
      <p className="connect-claim">{flow.claim}</p>
    </section>
  );
}

export function ParityTable({ view }: { view: ParityView }): React.ReactElement {
  return (
    <section className="cre-parity">
      <h4>Promotion parity</h4>
      <p className="parity-note">{view.note}</p>
      <table>
        <thead>
          <tr><th>Fixture</th><th>Simulator</th><th>Deployed</th><th>Result</th></tr>
        </thead>
        <tbody>
          {view.result.rows.map((r) => (
            <tr key={r.fixture} className={r.match ? "row-match" : r.notRun ? "row-notrun" : "row-mismatch"}>
              <td><code>{r.fixture}</code><span className="parity-desc">{r.description}</span></td>
              <td>{r.simulator ? `${r.simulator.verdict} · ${r.simulator.reasonCode}` : "—"}</td>
              <td>{r.deployed ? `${r.deployed.verdict} · ${r.deployed.reasonCode}` : "—"}</td>
              {/*
                * A fixture that ran on one side is NOT RUN, never a match. Five green rows against
                * a workflow that was never deployed would certify something that never executed.
                */}
              <td className="parity-result">
                {r.match ? "MATCH" : r.notRun ? `NOT RUN — ${r.notRun.toLowerCase()} side` : r.differences.join("; ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="parity-fields">
        Compared: {view.result.comparedFields.join(", ")}. Not compared: {view.result.ignoredFields.join(", ")} —
        a timestamp differing is not a decision differing.
      </p>
      <p className="parity-verdict">
        {view.result.semanticParity
          ? `Semantic parity across all ${view.result.total} fixtures.`
          : `Parity not established: ${view.result.matched} of ${view.result.total} fixtures agree.`}
        {view.blocker && <> <code>{view.blocker}</code></>}
      </p>
    </section>
  );
}

export interface CreConnectProps {
  projectId: string;
  fetchConnect: (projectId: string) => Promise<CreConnectView>;
  fetchParity: (projectId: string) => Promise<ParityView>;
}

export function CreConnectPanel({ projectId, fetchConnect, fetchParity }: CreConnectProps): React.ReactElement {
  const [data, setData] = useState<CreConnectView | null>(null);
  const [parity, setParity] = useState<ParityView | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [showFlow, setShowFlow] = useState(false);

  useEffect(() => {
    let live = true;
    fetchConnect(projectId)
      .then((d) => { if (live) setData(d); })
      .catch((e: Error) => { if (live) setError(e); });
    fetchParity(projectId)
      .then((d) => { if (live) setParity(d); })
      .catch(() => { /* parity is optional evidence; its absence is not this panel's failure */ });
    return () => { live = false; };
  }, [projectId, fetchConnect, fetchParity]);

  if (error) return <PanelProblem error={error} absent="No CRE connection for this project. The recorded demo project has one." />;
  if (!data) return <p className="loading">Reading CRE connection…</p>;

  const { account } = data;
  return (
    <div className="cre-connect">
      <section className="cre-account-panel">
        <h3>CRE account</h3>
        <dl>
          <dt>Connected</dt><dd>{account.connected}</dd>
          <dt>Organization</dt><dd>{account.organization}</dd>
          <dt>Deploy Access</dt><dd className={account.deployAccess === "ENABLED" ? "yes" : "no"}>{account.deployAccess}</dd>
          <dt>Registries</dt><dd>{account.registries.join(", ") || "—"}</dd>
          <dt>Simulation</dt><dd>{account.simulation}</dd>
          <dt>CLI version</dt><dd>{account.cliVersion}</dd>
        </dl>
        {/* §P28.18: a complete state, not an error. No red banner, nothing to retry. */}
        {account.note && <p className="account-note">{account.note}</p>}
        <button type="button" onClick={() => setShowFlow((v) => !v)} aria-expanded={showFlow}>
          {showFlow ? "Hide how this connects" : "Connect My Chainlink CRE"}
        </button>
      </section>

      {showFlow && <ConnectFlowSteps flow={data.flow} />}
      {parity && <ParityTable view={parity} />}
    </div>
  );
}
