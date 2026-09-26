import type React from "react";
import { useEffect, useState } from "react";
import { PanelProblem } from "./Absent";
import type { SimulationCenterView, SimulationLayerView } from "../lab-api";

/**
 * The Simulation Center (§P28.12).
 *
 * Four layers on one screen, and the design problem is entirely the second half of the requirement:
 * *keep their meanings distinct*. Four ticks in a row read as "everything was simulated", which is
 * false in a specific way — the CRE simulator never saw mainnet liquidity and the reality test never
 * ran a workflow.
 *
 * So every card renders what its layer proves AND what it does not, at the same size. The second
 * line is not small print; it is the line that stops the row of ticks meaning more than it should.
 */

const TONE: Record<SimulationLayerView["status"], string> = {
  PASS: "pass",
  FAIL: "fail",
  NOT_RUN: "notrun",
  BLOCKED: "blocked",
};

export function SimulationLayerCard({ layer }: { layer: SimulationLayerView }): React.ReactElement {
  return (
    <article className={`sim-layer sim-${TONE[layer.status]}`}>
      <header>
        <h4>{layer.title}</h4>
        <span className="sim-status">{layer.status.replace("_", " ")}</span>
      </header>
      <p className="sim-engine">{layer.engine}</p>
      <p className="sim-detail">
        {layer.detail}
        {layer.passed !== null && layer.total !== null && (
          <span className="sim-count"> · {layer.passed} / {layer.total}</span>
        )}
      </p>
      <dl className="sim-meaning">
        <dt>Proves</dt>
        <dd>{layer.proves}</dd>
        <dt>Does not prove</dt>
        <dd className="sim-negative">{layer.doesNotProve}</dd>
      </dl>
      {layer.blocker && <p className="sim-blocker"><code>{layer.blocker}</code></p>}
      {layer.optional && <p className="sim-optional">Optional — this layer is extra evidence, never a gate.</p>}
    </article>
  );
}

export interface SimulationCenterProps {
  projectId: string;
  fetchCenter: (projectId: string) => Promise<SimulationCenterView>;
}

export function SimulationCenterView_({ projectId, fetchCenter }: SimulationCenterProps): React.ReactElement {
  const [data, setData] = useState<SimulationCenterView | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let live = true;
    fetchCenter(projectId)
      .then((d) => { if (live) setData(d); })
      .catch((e: Error) => { if (live) setError(e); });
    return () => { live = false; };
  }, [projectId, fetchCenter]);

  if (error) return <PanelProblem error={error} absent="No simulation results for this project yet." />;
  if (!data) return <p className="loading">Reading simulation results…</p>;

  return (
    <div className="simulation-center">
      <h3>Simulation</h3>
      <p className="lede">
        Four things ran. They are shown together because they belong to one agent, and kept apart
        because they answer different questions.
      </p>
      <div className="sim-layers">
        {data.layers.map((l) => <SimulationLayerCard key={l.key} layer={l} />)}
      </div>
      <p className={data.requiredPassed ? "sim-summary ok" : "sim-summary outstanding"}>
        {data.requiredPassed
          ? "Every required layer passed. The optional fork layer is excluded from that statement."
          : `Outstanding: ${data.outstanding.join(", ")}`}
      </p>
    </div>
  );
}
