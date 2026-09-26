import type React from "react";
import { useEffect, useState } from "react";

/**
 * The Deploy screen.
 *
 * Two rules from §P28 shape this component, and both are about what the user is told before they
 * press a button:
 *
 * §P28.29 — never enable financial policy as part of opaque deployment progress. The phase list is
 * shown in full, including `Configuring policy DISABLED`, because that step is the most reassuring
 * one and it is invisible if the phases are summarised into a spinner.
 *
 * §P28.27 — never merge testnet faucet assets with real dollar capital. Every figure is rendered in
 * the asset it is denominated in. The backend does not return a dollar equivalent and this
 * component does not compute one.
 */

export interface DeployGate {
  label: string;
  status: "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
  detail: string;
  blocker: string | null;
}

export interface DeployReadiness {
  gates: DeployGate[];
  canDeploy: boolean;
  blockedBy: string[];
  executionNetwork: { chainId: number; name: string; role: string };
  mainnetWrites: "PROHIBITED";
  policyInitialState: "DISABLED";
}

export interface CostBreakdown {
  deployment: {
    estimatedGas: string;
    estimatedWei: string;
    safetyBufferPercent: number;
    recommendedWei: string;
    currentBalanceWei: string | null;
    asset: string;
    note: string;
  };
  agentExecutionGas: { perActionEstimateWei: string | null; asset: string; note: string };
  modelUsage: { note: string };
  hostingAndCre: { note: string };
}

export interface DeployPhase { key: string; label: string }

export interface DeployViewProps {
  projectId: string;
  fetchReadiness: (projectId: string) => Promise<{ readiness: DeployReadiness; phases: readonly DeployPhase[] }>;
  fetchCost: (projectId: string) => Promise<CostBreakdown | null>;
  onDeploy: (projectId: string) => Promise<void>;
  /** Set while a deployment is running, so the phase list can show where it is. */
  currentPhase?: string | null;
}

const eth = (wei: string): string => `${(Number(wei) / 1e18).toFixed(6)}`;

export function DeployView({ projectId, fetchReadiness, fetchCost, onDeploy, currentPhase }: DeployViewProps): React.ReactElement {
  const [data, setData] = useState<{ readiness: DeployReadiness; phases: readonly DeployPhase[] } | null>(null);
  const [cost, setCost] = useState<CostBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([fetchReadiness(projectId), fetchCost(projectId)])
      .then(([r, c]) => { if (live) { setData(r); setCost(c); } })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [projectId, fetchReadiness, fetchCost]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="loading">Checking deployment readiness…</p>;

  const { readiness, phases } = data;

  return (
    <div className="deploy-view">
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

      <section className="boundary">
        <dl>
          <dt>Execution network</dt>
          <dd>{readiness.executionNetwork.name} — {readiness.executionNetwork.role.replace(/_/g, " ")}</dd>
          <dt>Mainnet writes</dt>
          <dd>{readiness.mainnetWrites}</dd>
          <dt>Policy</dt>
          <dd>WILL START {readiness.policyInitialState} — activation is a separate decision</dd>
        </dl>
      </section>

      {cost && (
        <section className="cost">
          <h3>One-time testnet deployment</h3>
          <dl>
            <dt>Estimated gas</dt>
            <dd>{cost.deployment.estimatedGas}</dd>
            <dt>Estimated</dt>
            <dd>{eth(cost.deployment.estimatedWei)} {cost.deployment.asset}</dd>
            <dt>Safety buffer</dt>
            <dd>{cost.deployment.safetyBufferPercent}%</dd>
            <dt>Recommended balance</dt>
            <dd>{eth(cost.deployment.recommendedWei)} {cost.deployment.asset}</dd>
            <dt>Current balance</dt>
            <dd>{cost.deployment.currentBalanceWei ? `${eth(cost.deployment.currentBalanceWei)} ${cost.deployment.asset}` : "not read"}</dd>
          </dl>
          <p className="cost-note">{cost.deployment.note}</p>

          {/*
            * The other three cost categories, kept separate. Merging them is how a testnet gas
            * figure acquires a dollar sign.
            */}
          <ul className="other-costs">
            <li><strong>Agent execution gas</strong> — {cost.agentExecutionGas.note}</li>
            <li><strong>Model usage</strong> — {cost.modelUsage.note}</li>
            <li><strong>Hosting and CRE</strong> — {cost.hostingAndCre.note}</li>
          </ul>
        </section>
      )}

      <section className="phases">
        <h3>What happens when you deploy</h3>
        <ol>
          {phases.map((p) => (
            <li key={p.key} className={currentPhase === p.key ? "phase-current" : ""}>
              {p.label}
            </li>
          ))}
        </ol>
        <p className="phase-note">
          The deployment ends at <strong>READY TO ACTIVATE</strong>. Enabling the ContextLock policy
          is a separate decision, taken after you have seen the verified deployment.
        </p>
      </section>

      <button
        className="primary deploy-cta"
        disabled={!readiness.canDeploy || deploying}
        onClick={() => { setDeploying(true); void onDeploy(projectId).catch((e: Error) => setError(e.message)).finally(() => setDeploying(false)); }}
      >
        {deploying ? "Deploying…" : "DEPLOY TO TESTNET LAB"}
      </button>

      {!readiness.canDeploy && (
        <p className="blocked-by">
          Blocked by: {readiness.blockedBy.join(", ")}
        </p>
      )}
    </div>
  );
}
