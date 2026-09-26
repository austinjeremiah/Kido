import type React from "react";
import { useEffect, useState } from "react";
import { PanelProblem } from "./Absent";
import type { ScenarioView, ShockPreset, ComparisonRow } from "../lab-api";

/**
 * Market shocks (§P28.42) and the comparison they produce (§P28.43).
 *
 * Two rules shape this screen. The overlay never rewrites the base snapshot — the base row is
 * always present, always first, and always the real reading. And every derived row is labelled
 * SYNTHETIC, because a shocked price is a question rather than a measurement, and an unlabelled
 * "$1,707" on this screen would be a market price no source ever reported.
 *
 * Unavailable presets are shown with their reason rather than hidden, for the same reason the
 * reality selector shows blocked modes: an absent option teaches nothing, and a listed one with a
 * reason explains the shape of what this snapshot can actually answer.
 */

export function PresetList({ presets }: { presets: ShockPreset[] }): React.ReactElement {
  return (
    <ul className="shock-presets">
      {presets.map((p) => (
        <li key={p.overlayId} className={p.applicable ? "preset-available" : "preset-unavailable"}>
          <h5>{p.name}</h5>
          <p>{p.description}</p>
          <p className="preset-mutates">changes {p.mutates.join(", ")}</p>
          <span className="badge badge-synthetic">{p.label}</span>
          {!p.applicable && <p className="preset-reason">Unavailable — {p.unavailableReason}</p>}
        </li>
      ))}
    </ul>
  );
}

export function ComparisonTable({ rows, action }: { rows: ComparisonRow[]; action: string }): React.ReactElement {
  return (
    <table className="scenario-compare">
      <caption>{action}, ruled on by the same policy engine the workflow runs.</caption>
      <thead>
        <tr><th>Market</th><th>Decision</th><th>Reason</th><th>Change</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.scenario} className={r.synthetic ? "row-synthetic" : "row-base"}>
            <th scope="row">
              {r.label}
              {r.synthetic && <span className="badge badge-synthetic">SYNTHETIC OVERLAY</span>}
            </th>
            <td className={`verdict verdict-${r.verdict.toLowerCase()}`}>{r.verdict}</td>
            <td><code>{r.reasonCode}</code></td>
            <td className="scenario-change">{r.changedFromBase ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface MarketShockProps {
  projectId: string;
  fetchScenarios: (projectId: string) => Promise<ScenarioView>;
}

export function MarketShockPanel({ projectId, fetchScenarios }: MarketShockProps): React.ReactElement {
  const [data, setData] = useState<ScenarioView | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [showBasis, setShowBasis] = useState(false);

  useEffect(() => {
    let live = true;
    fetchScenarios(projectId)
      .then((d) => { if (live) setData(d); })
      .catch((e: Error) => { if (live) setError(e); });
    return () => { live = false; };
  }, [projectId, fetchScenarios]);

  if (error) return <PanelProblem error={error} absent="No market snapshot for this project. Shocks are applied to a sealed snapshot, and this project has not taken one." />;
  if (!data) return <p className="loading">Reading scenarios…</p>;

  return (
    <div className="market-shock">
      <h3>Market shock</h3>
      <p className="lede">
        Every row below starts from the sealed snapshot at mainnet block {data.anchorBlock}
        {data.baseValuedAt && <> — where {data.action} is worth {data.baseValuedAt}</>}. The base
        snapshot is never rewritten; each shock produces a new one with its own hash.
      </p>

      <PresetList presets={data.presets} />
      <ComparisonTable rows={data.rows} action={data.action} />

      <button type="button" onClick={() => setShowBasis((v) => !v)} aria-expanded={showBasis}>
        {showBasis ? "Hide how these were decided" : "How were these decided?"}
      </button>
      {showBasis && (
        <div className="scenario-basis">
          <h5>From the snapshot</h5>
          <ul>{data.basis.fromSnapshot.map((f) => <li key={f}>{f}</li>)}</ul>
          {/*
            * The honest half. The policy engine needs four context values a price snapshot does not
            * carry, and filling them with plausible numbers would let an invented value decide the
            * verdict. They are set so they cannot bind, and each says so.
            */}
          <h5>Set so they cannot influence the verdict</h5>
          <ul>{data.basis.neutralised.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
