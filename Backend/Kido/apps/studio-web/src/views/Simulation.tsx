import { useState } from "react";
import type { SimulationView } from "../api";

/**
 * Simulation view.
 *
 * Two things this view refuses to do.
 *
 * It never shows a stale result as current. A result is bound to a blueprint revision and a build
 * revision; if either has moved on, the result is marked stale and visually demoted, because a
 * green row next to an edited design is a claim about something that is no longer being built.
 *
 * And it never shows a confidential threshold. The private-context panel is the strongest thing
 * this project demonstrates precisely because the viewer can see the verdict change without
 * learning what changed it.
 */
export function SimulationView_({ sims }: { sims: SimulationView[] }) {
  const [open, setOpen] = useState<string | null>(sims[0]?.scenarioId ?? null);

  if (sims.length === 0) {
    return <div className="empty">Simulations run automatically once the agent is built.</div>;
  }

  const trio = sims.filter((s) => s.scenarioId.startsWith("PRIVATE_CONTEXT"));
  const stale = sims.filter((s) => s.stale).length;

  return (
    <div className="sim">
      {stale > 0 && (
        <div className="banner warn">
          {stale} of these results were produced against an earlier revision and are <b>stale</b>.
          They are not evidence about the current design. Rebuild to refresh them.
        </div>
      )}

      {trio.length === 3 && !trio.some((t) => t.stale) && (
        <div className="card private-context">
          <h3>Same transaction. Different confidential context. Different verdict.</h3>
          <p className="note">
            Identical amount, agent, target and policy version in all three. Only data the
            transaction does not reveal is different.
          </p>
          <div className="trio">
            {trio.map((t) => (
              <div key={t.scenarioId} className={`verdict v-${t.verdict.toLowerCase()}`}>
                <span className="v">{t.verdict}</span>
                <span className="r">{t.reasonCode}</span>
                <span className="ctx">confidential context withheld</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <table className="sims">
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Verdict</th>
            <th>Outcome</th>
            <th>Stopped at</th>
            <th>Reason</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {sims.map((s) => (
            <>
              <tr
                key={s.scenarioId}
                className={`${s.stale ? "stale" : ""} ${open === s.scenarioId ? "open" : ""}`}
                onClick={() => setOpen(open === s.scenarioId ? null : s.scenarioId)}
              >
                <td>{s.scenarioId}</td>
                <td>
                  <span className={`badge v-${String(s.verdict).toLowerCase()}`}>{s.verdict}</span>
                </td>
                <td>{s.outcome}</td>
                <td className="mono">{s.stoppedAt}</td>
                <td className="mono">{s.reasonCode}</td>
                <td className={s.passed ? "ok" : "bad"}>
                  {s.stale ? "STALE" : s.passed ? "PASS" : "FAIL"}
                </td>
              </tr>
              {open === s.scenarioId && (
                <tr key={`${s.scenarioId}-detail`} className="detail-row">
                  <td colSpan={6}>
                    <div className="stages">
                      {s.stages.map((st) => (
                        <div key={st.stage} className={`stage st-${st.status.toLowerCase()}`}>
                          <span className="mark">{st.status === "PASS" ? "OK" : st.status === "STOP" ? "STOP" : "—"}</span>
                          <span className="name">{st.stage}</span>
                          <span className="d">
                            {st.detail}
                            {st.reason && <b className="reason"> {st.reason}</b>}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="assertions">
                      {s.assertions.map((a) => (
                        <div key={a.id} className={a.held ? "held" : "broken"}>
                          {a.held ? "✓" : "✗"} {a.statement} <span className="muted">— {a.detail}</span>
                        </div>
                      ))}
                    </div>
                    <div className="timeline">
                      {s.timeline.map((t) => (
                        <span key={t.t} className="tl">
                          T+{t.t} {t.label}
                        </span>
                      ))}
                    </div>
                    <div className="revs muted">
                      blueprint rev {s.blueprintRevision} · build rev {s.buildRevision}
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}
