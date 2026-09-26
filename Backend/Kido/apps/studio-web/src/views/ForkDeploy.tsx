import type React from "react";
import { useCallback, useEffect, useState } from "react";
import type { ForkDeploymentView, ForkReadiness } from "../lab-api";

/**
 * Deploying to a local mainnet fork.
 *
 * The same discipline as the testnet Deploy screen (§P28.29): every gate is shown with its reason,
 * every phase is listed before the button — including `Configuring policy DISABLED` — and the
 * deployment ends at READY TO ACTIVATE. What is different is said plainly at the top: this chain
 * exists on this machine only, its keys are generated for this run, and nothing it does can be
 * seen from outside.
 *
 * Progress is polled from the deployment record, not held here. A reload mid-deployment rebuilds
 * the screen from where the backend actually is.
 */

const POLL_MS = 2_500;

export interface ForkDeployProps {
  projectId: string;
  buildId: string | null;
  fetchReadiness: (projectId: string) => Promise<ForkReadiness>;
  deploy: (projectId: string, buildId: string | null) => Promise<ForkDeploymentView>;
  fetchDeployment: (deploymentId: string) => Promise<ForkDeploymentView>;
  stop: (deploymentId: string) => Promise<ForkDeploymentView>;
  /** The host moves the workspace to the deployed-agent console. */
  onOpenDeployment: (deploymentId: string) => void;
  /** Called whenever the deployment's state changes, so the lifecycle header can refetch. */
  onStateChange?: () => void;
}

const phaseTone = (s: string): string => s === "DONE" ? "phase-done" : s === "RUNNING" ? "phase-current" : s === "FAILED" ? "phase-failed" : "";

export function ForkDeployPanel(props: ForkDeployProps): React.ReactElement {
  const { projectId, buildId, fetchReadiness, deploy, fetchDeployment, stop, onOpenDeployment, onStateChange } = props;
  const [readiness, setReadiness] = useState<ForkReadiness | null>(null);
  const [deployment, setDeployment] = useState<ForkDeploymentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadReadiness = useCallback(() => {
    let live = true;
    fetchReadiness(projectId)
      .then((r) => { if (live) { setReadiness(r); if (r.existing) setDeployment(r.existing); } })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [projectId, fetchReadiness]);

  useEffect(loadReadiness, [loadReadiness]);

  /* Poll while a deployment is in flight; stop when it settles. */
  useEffect(() => {
    if (!deployment || deployment.state !== "DEPLOYING") return;
    const id = deployment.deploymentId;
    const t = setInterval(() => {
      fetchDeployment(id)
        .then((d) => {
          setDeployment(d);
          if (d.state !== "DEPLOYING") { clearInterval(t); onStateChange?.(); loadReadiness(); }
        })
        .catch(() => { /* a missed poll is retried on the next tick */ });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [deployment?.deploymentId, deployment?.state, fetchDeployment, onStateChange, loadReadiness]);

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const d = await deploy(projectId, buildId);
      setDeployment(d);
      onStateChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const halt = async (): Promise<void> => {
    if (!deployment) return;
    setBusy(true);
    try {
      setDeployment(await stop(deployment.deploymentId));
      onStateChange?.();
      loadReadiness();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !readiness) return <p className="error">{error}</p>;
  if (!readiness) return <p className="loading">Checking fork readiness…</p>;

  const phases = deployment?.record.phases ?? readiness.phases.map((p) => ({ key: p.key, status: "PENDING" as const, startedAtMs: null, finishedAtMs: null, detail: null }));
  const labelOf = (key: string): string => readiness.phases.find((p) => p.key === key)?.label ?? key;
  const settled = deployment && deployment.state !== "DEPLOYING";

  return (
    <div className="deploy-view fork-deploy">
      <section className="boundary fork-boundary">
        <h3>Local mainnet fork</h3>
        <dl>
          <dt>Execution network</dt>
          <dd>{readiness.executionNetwork.name} — chain {readiness.executionNetwork.chainId}, forked from chain {readiness.executionNetwork.forkedFrom}</dd>
          <dt>Mainnet writes</dt>
          <dd>{readiness.mainnetWrites} — the fork lives in an Anvil process on this machine; its transactions have no explorer and no public existence</dd>
          <dt>Keys</dt>
          <dd>Generated for this deployment, funded on the fork only, never written to disk. Not your wallet.</dd>
          <dt>Policy</dt>
          <dd>WILL START {readiness.policyInitialState} — activation is a separate decision</dd>
        </dl>
      </section>

      <section className="gates">
        <h3>Before deploying</h3>
        <table>
          <tbody>
            {readiness.gates.map((g) => (
              <tr key={g.label} className={`gate-${g.status.toLowerCase()}`}>
                <td className="gate-status">{g.status}</td>
                <td className="gate-label">{g.label}</td>
                <td className="gate-detail">
                  {g.detail}
                  {g.blocker && <span className="blocker"> ({g.blocker})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="phases">
        <h3>{deployment ? "Deployment" : "What happens when you deploy"}</h3>
        {deployment && (
          <p className="fork-deployment-id">
            <code>{deployment.deploymentId}</code> · {deployment.state.replace(/_/g, " ")}
            {deployment.record.fork && <> · fork <code>{deployment.record.fork.forkId}</code> at mainnet block {deployment.record.fork.forkBlock}</>}
          </p>
        )}
        <ol>
          {phases.map((p) => (
            <li key={p.key} className={phaseTone(p.status)}>
              <span className="phase-label">{labelOf(p.key)}</span>
              {p.detail && <span className="phase-detail">{p.detail}</span>}
            </li>
          ))}
        </ol>
        {deployment?.record.failure && <p className="error">{deployment.record.failure}</p>}
        {deployment?.record.stoppedReason && <p className="blocked-by">{deployment.record.stoppedReason}</p>}
        {!deployment && (
          <p className="phase-note">
            The deployment ends at <strong>READY TO ACTIVATE</strong>. The agent then observes the position
            it guards on the fork, but the ContextLock policy is DISABLED until you activate it — and the
            executor contract refuses every capability while it is.
          </p>
        )}
      </section>

      {deployment?.record.position && (
        <section className="fork-position-summary">
          <h3>What the agent guards on the fork</h3>
          <dl>
            <dt>Owner (the agent's identity)</dt><dd><code>{deployment.record.position.user}</code></dd>
            <dt>Vault (the executor)</dt><dd><code>{deployment.record.position.vault}</code> — holds the tokens actions are paid from</dd>
            {deployment.record.position.scenarios.map((sc) => (
              <div key={sc.driverId} className="fork-scenario-row"><dt>{sc.protocol}</dt><dd>{sc.detail} <span className="muted">({sc.actionKind})</span></dd></div>
            ))}
            {deployment.record.position.unexercisedActionKinds.length > 0 && (
              <div className="fork-scenario-row"><dt>no fork scenario</dt><dd>{deployment.record.position.unexercisedActionKinds.join(", ")} — granted by the Blueprint, not exercised here</dd></div>
            )}
          </dl>
        </section>
      )}

      {!deployment || deployment.state === "FAILED" || deployment.state === "STOPPED" ? (
        <>
          <button className="primary deploy-cta" disabled={!readiness.canDeploy || busy} onClick={() => void start()}>
            {busy ? "Starting…" : "DEPLOY TO LOCAL MAINNET FORK"}
          </button>
          {!readiness.canDeploy && <p className="blocked-by">Blocked by: {readiness.blockedBy.join(", ")}</p>}
        </>
      ) : (
        <div className="fork-actions">
          {settled && deployment.state === "READY_TO_ACTIVATE" && (
            <button className="primary deploy-cta" onClick={() => onOpenDeployment(deployment.deploymentId)}>
              OPEN THE DEPLOYED AGENT
            </button>
          )}
          <button className="deploy-cta" disabled={busy} onClick={() => void halt()}>
            {busy ? "…" : "Stop the fork"}
          </button>
          {deployment.state === "DEPLOYING" && <p className="loading">Deploying… the record is re-read every few seconds.</p>}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
