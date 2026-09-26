import type React from "react";
import { useEffect, useState } from "react";
import { PanelProblem } from "./Absent";

/**
 * The Attack Lab.
 *
 * §P28.36's requirement is the one this component exists to satisfy: **the UI must distinguish where
 * an attack was stopped.** "Denied" is reassuring and nearly useless; the layer that refused is what
 * tells a reader which control they are relying on.
 *
 * Every value rendered here comes from the backend's `AttackRun`. The component composes no verdict,
 * derives no reason code and decides no outcome — a screen that computed "denied" from its own
 * reading of a response would be reporting what the frontend believes.
 */

export type LayerOutcome = "PASS" | "DENY" | "NOT_REACHED" | "NOT_APPLICABLE";

export interface SecurityPathStep {
  layer: string;
  outcome: LayerOutcome;
  reasonCode: string | null;
  detail: string | null;
}

export interface MutationDiff { field: string; original: string; mutated: string }

export interface AttackRun {
  scenario: string;
  title: string;
  result: "DENIED" | "ALLOWED" | "NOT_RUN";
  stoppedBy: string | null;
  reasonCode: string | null;
  stoppedWhereExpected: boolean;
  diffs: MutationDiff[];
  path: SecurityPathStep[];
  capabilityIssued: boolean;
  transactionSubmitted: boolean;
  additionalDefenses: Array<{ layer: string; reasonCode: string }>;
}

export interface AttackDefinition {
  scenario: string;
  title: string;
  description: string;
  mutatedField: string | null;
  expectedStoppedBy: string;
  expectedReasonCode: string;
}

export interface AttackCatalogue {
  applicable: AttackDefinition[];
  notApplicable: Array<{ scenario: string; title: string; requires: string }>;
}

const OUTCOME_LABEL: Record<LayerOutcome, string> = {
  PASS: "PASS",
  DENY: "DENY",
  // Deliberately not "skipped" or blank. A layer that was never consulted did not approve anything.
  NOT_REACHED: "NOT REACHED",
  NOT_APPLICABLE: "N/A",
};

function SecurityPath({ path }: { path: SecurityPathStep[] }): React.ReactElement {
  return (
    <ol className="security-path">
      {path.map((s) => (
        <li key={s.layer} className={`path-${s.outcome.toLowerCase()}`}>
          <span className="layer">{s.layer.replace(/_/g, " ")}</span>
          <span className="outcome">{OUTCOME_LABEL[s.outcome]}</span>
          {s.reasonCode && <code className="reason">{s.reasonCode}</code>}
        </li>
      ))}
    </ol>
  );
}

function Diffs({ diffs }: { diffs: MutationDiff[] }): React.ReactElement | null {
  if (diffs.length === 0) return null;
  return (
    <table className="mutation-diff">
      <thead>
        <tr><th>Field</th><th>Original</th><th>Mutated</th></tr>
      </thead>
      <tbody>
        {diffs.map((d) => (
          <tr key={d.field}>
            <td><code>{d.field}</code></td>
            <td className="original">{d.original}</td>
            <td className="mutated">{d.mutated}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AttackRunCard({ run }: { run: AttackRun }): React.ReactElement {
  return (
    <article className={`attack-run attack-${run.result.toLowerCase()}`}>
      <header>
        <h4>{run.title}</h4>
        <span className="result">{run.result}</span>
      </header>

      {run.result === "DENIED" ? (
        <dl className="attack-detail">
          <dt>Stopped by</dt>
          <dd>{run.stoppedBy?.replace(/_/g, " ")}</dd>
          <dt>Reason</dt>
          <dd><code>{run.reasonCode}</code></dd>
          <dt>Capability</dt>
          <dd>{run.capabilityIssued ? "ISSUED" : "NOT ISSUED"}</dd>
          <dt>Transaction</dt>
          <dd>{run.transactionSubmitted ? "SUBMITTED" : "NOT SUBMITTED"}</dd>
        </dl>
      ) : (
        <p className="not-stopped">
          No layer refused this. That is the alarming case, and it is shown as loudly as a denial.
        </p>
      )}

      {!run.stoppedWhereExpected && run.result === "DENIED" && (
        <p className="unexpected-layer">
          Stopped by a different layer than expected. An upstream control may have stopped working,
          leaving the deeper one to carry it alone.
        </p>
      )}

      <Diffs diffs={run.diffs} />
      <SecurityPath path={run.path} />

      {run.additionalDefenses.length > 0 && (
        <section className="additional-defenses">
          <h5>Also refused by, exercised in this run</h5>
          <ul>
            {run.additionalDefenses.map((d) => (
              <li key={d.layer}><span>{d.layer.replace(/_/g, " ")}</span> <code>{d.reasonCode}</code></li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

export interface AttackLabProps {
  projectId: string;
  fetchCatalogue: (projectId: string) => Promise<AttackCatalogue>;
  runAttack: (projectId: string, scenario: string) => Promise<AttackRun>;
}

export function AttackLabView({ projectId, fetchCatalogue, runAttack }: AttackLabProps): React.ReactElement {
  const [catalogue, setCatalogue] = useState<AttackCatalogue | null>(null);
  const [runs, setRuns] = useState<Record<string, AttackRun>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let live = true;
    fetchCatalogue(projectId)
      .then((c) => { if (live) setCatalogue(c); })
      .catch((e: Error) => { if (live) setError(e); });
    return () => { live = false; };
  }, [projectId, fetchCatalogue]);

  const run = async (scenario: string): Promise<void> => {
    setBusy(scenario);
    setError(null);
    try {
      const result = await runAttack(projectId, scenario);
      setRuns((prev) => ({ ...prev, [scenario]: result }));
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(null);
    }
  };

  if (error) return <PanelProblem error={error} absent="No compiled Blueprint for this project, so no attack scenario applies to it yet." />;
  if (!catalogue) return <p className="loading">Loading attack scenarios…</p>;

  return (
    <div className="attack-lab">
      <p className="lede">
        Every scenario below is refused by something. What this screen shows is <em>which layer</em>,
        and how far the attack got before it was.
      </p>

      <ul className="attack-list">
        {catalogue.applicable.map((a) => (
          <li key={a.scenario}>
            <div className="attack-summary">
              <h4>{a.title}</h4>
              <p>{a.description}</p>
              {a.mutatedField && <p className="mutated-field">Changes: <code>{a.mutatedField}</code></p>}
              <button onClick={() => void run(a.scenario)} disabled={busy !== null}>
                {busy === a.scenario ? "Running…" : "Run attack"}
              </button>
            </div>
            {runs[a.scenario] && <AttackRunCard run={runs[a.scenario]!} />}
          </li>
        ))}
      </ul>

      {catalogue.notApplicable.length > 0 && (
        <section className="not-applicable">
          <h4>Not applicable to this agent</h4>
          {/*
            * Shown rather than hidden. §P28.35 asks that only applicable scenarios be offered — a
            * CCIP attack against an agent with no cross-chain capability would pass and prove
            * nothing. Listing them with the reason explains the absence instead of leaving the set
            * looking arbitrary.
            */}
          <ul>
            {catalogue.notApplicable.map((a) => (
              <li key={a.scenario}>
                {a.title} <span className="requires">requires {a.requires.replace(/_/g, " ").toLowerCase()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
