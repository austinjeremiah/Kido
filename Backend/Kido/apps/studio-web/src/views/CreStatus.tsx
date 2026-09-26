import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { PanelProblem } from "./Absent";
import type { CreSimulationResult, CreSimulationRun, CreView } from "../lab-api";

/**
 * The CRE status card (§P28.14, §P28.17–P28.19).
 *
 * > Never collapse to "CRE Connected ✓" without semantics.
 *
 * A green tick summarises six independent facts and five of them are usually "no". Collapsing them
 * produces a badge that is true of *something* and tells the reader nothing about which — and the
 * reader has no way to ask. So this renders six fields, always, in the shape the spec names.
 *
 * Absent Deploy Access is a **complete state**, not an error. It gets no red banner and no retry
 * button, because there is nothing wrong and nothing for the user to fix.
 */

const YESNO = (v: string): React.ReactElement => (
  <span className={v === "YES" ? "yes" : "no"}>{v}</span>
);

export interface CreStatusProps {
  projectId: string;
  fetchCre: (projectId: string) => Promise<CreView>;
  /**
   * Run the official simulation now, and the runs so far.
   *
   * Optional: the recorded demo project's run is committed evidence and cannot be re-run from here.
   * When present, the card gains the one control this screen has.
   */
  runSimulation?: (projectId: string) => Promise<{ run: CreSimulationRun | null; result?: CreSimulationResult; note?: string }>;
  fetchSimulations?: (projectId: string) => Promise<CreSimulationRun[]>;
  /** Called after a run finishes, so the screens that read `creSimulationPassed` refetch. */
  onSimulated?: () => void;
}

/**
 * One recorded run.
 *
 * The verdict is the workflow's own string. A DENY here is not a failure of the simulation — it is
 * the policy refusing the replayed trigger under the conditions it saw — and the card says which
 * of the two it is looking at.
 */
function RunRow({ run }: { run: CreSimulationRun }): React.ReactElement {
  const r = run.result;
  return (
    <li className={`cre-run cre-run-${run.status.toLowerCase()}`}>
      <span className="cre-run-status">{run.status}</span>
      <span className="cre-run-when">{new Date(run.startedAt).toLocaleTimeString()}</span>
      <span className="cre-run-detail">
        {run.status === "RUNNING"
          ? "compiling and simulating…"
          : r.failure
            ? `stopped: ${r.failure}`
            : `binary ${r.binaryHash?.slice(0, 12) ?? "?"}… · limits ${r.productionLimits ? "ENABLED" : "not confirmed"} · workflow returned ${r.verdict ?? "none"}`}
      </span>
    </li>
  );
}

export function CreStatusView({ projectId, fetchCre, runSimulation, fetchSimulations, onSimulated }: CreStatusProps): React.ReactElement {
  const [data, setData] = useState<CreView | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [runs, setRuns] = useState<CreSimulationRun[]>([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const load = useCallback(() => {
    let live = true;
    fetchCre(projectId)
      .then((d) => { if (live) setData(d); })
      .catch((e: Error) => { if (live) setError(e); });
    if (fetchSimulations) {
      fetchSimulations(projectId)
        .then((r) => { if (live) setRuns(r); })
        .catch(() => { /* the run list is informative; the card renders without it */ });
    }
    return () => { live = false; };
  }, [projectId, fetchCre, fetchSimulations]);

  useEffect(load, [load]);

  const run = async (): Promise<void> => {
    if (!runSimulation) return;
    setRunning(true);
    setRunError(null);
    try {
      const out = await runSimulation(projectId);
      if (out.result?.failure) setRunError(out.result.failure);
      load();
      onSimulated?.();
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  if (error) return <PanelProblem error={error} absent="No CRE configuration for this project. The recorded demo project has one." />;
  if (!data) return <p className="loading">Reading CRE status…</p>;

  const { status, connection, promotion } = data;

  return (
    <div className="cre-status">
      {runSimulation && (
        <section className="cre-simulate">
          <h3>Official CRE simulation</h3>
          <p className="cre-simulate-lede">
            Runs <code>cre workflow simulate</code> on this machine against the ContextLock policy
            workflow — the one binary every agent uses; this agent's configuration is in its generated
            <code> workflows/cre/policy.ts</code>. It proves the real workflow evaluates under the
            CLI's production limits. It does not prove a DON ran it, or a TEE.
          </p>
          <button type="button" className="primary" onClick={() => void run()} disabled={running || !connection.connected}>
            {running ? "Simulating… (compiles the workflow; a minute or so)" : "Run official CRE simulation"}
          </button>
          {!connection.connected && <p className="cre-simulate-blocked">The CRE CLI is not installed on this machine, so there is nothing to run.</p>}
          {runError && <p className="error">{runError}</p>}
          {runs.length > 0 && (
            <ul className="cre-runs">
              {runs.slice(0, 5).map((r) => <RunRow key={r.id} run={r} />)}
            </ul>
          )}
        </section>
      )}

      <section className="cre-card">
        <h3>Chainlink CRE</h3>
        <dl className="cre-fields">
          <dt>Mode</dt><dd>{status.mode}</dd>
          <dt>Account</dt><dd>{status.account}</dd>
          <dt>Workflow binary</dt>
          <dd>{status.workflowBinary ? <code>{status.workflowBinary.slice(0, 16)}…</code> : "none"}</dd>
          <dt>Production limits</dt><dd>{status.productionLimits}</dd>
          <dt>DON deployment</dt><dd>{YESNO(status.donDeployment)}</dd>
          <dt>Hardware TEE</dt><dd>{YESNO(status.hardwareTee)}</dd>
        </dl>
      </section>

      <section className="cre-account">
        <h3>CRE account</h3>
        <dl>
          <dt>Connected</dt><dd>{connection.connected ? "YES" : "NO"}</dd>
          <dt>Organization</dt><dd>{connection.organizationName ?? connection.organizationId ?? "—"}</dd>
          <dt>Deploy Access</dt><dd>{status.deployAccess.replace(/_/g, " ")}</dd>
          <dt>Registries</dt><dd>{connection.registries.join(", ") || "—"}</dd>
          <dt>Simulation</dt><dd>AVAILABLE</dd>
          <dt>CLI version</dt><dd>{connection.cliVersion ?? "—"}</dd>
        </dl>
        {/*
          * Where the credential is. Stated so the user can see it did not move — §P28.16's whole
          * point is that only sanitized connection information travels.
          */}
        <p className="credential-location">
          Your CRE session stays in your {connection.credentialLocation}. ContextLock never receives
          it, and never asks for a password, an OTP or a session token.
        </p>
      </section>

      <section className={`cre-promotion ${promotion.available ? "available" : "unavailable"}`}>
        <h3>Real DON deployment</h3>
        <p className="promotion-message">{promotion.message}</p>
        {promotion.available ? (
          <button type="button" className="primary">Promote to Chainlink CRE</button>
        ) : (
          <>
            <button type="button" className="primary" disabled aria-disabled="true">
              Promote to Chainlink CRE
            </button>
            {promotion.blocker && <p className="promotion-blocker"><code>{promotion.blocker}</code></p>}
          </>
        )}
        <p className="promotion-note">
          Promotion changes where the policy is evaluated. It does not change where the agent
          executes — that stays an approved testnet, and mainnet writes remain prohibited.
        </p>
      </section>
    </div>
  );
}
