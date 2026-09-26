/**
 * The Activity timeline.
 *
 * Every row is a persisted RuntimeEvent. Nothing here is derived, animated or inferred — if a row
 * is on screen, an observer wrote it down, and clicking it leads to the whole action it belonged
 * to via its correlation id.
 *
 * The filter set is §25.28's: agent, source, verdict, severity, time, adapter, chain, transaction
 * and correlation id. A transaction hash is the important one, because it is the only identifier a
 * user arrives with when they come from a block explorer.
 */

export interface ActivityEvent {
  eventId: string;
  timestamp: number;
  source: string;
  type: string;
  severity: string;
  agentId: string | null;
  correlationId: string;
  txHash: string | null;
  adapterId: string | null;
  chainId: number | null;
  blockNumber: string | null;
  correctsEventId: string | null;
  publicMetadata: Record<string, unknown>;
}

/** `| undefined` explicitly, because the project sets `exactOptionalPropertyTypes`: clearing a
 *  filter sets it to undefined rather than deleting the key. */
export interface ActivityFilters {
  source?: string | undefined;
  minSeverity?: string | undefined;
  correlationId?: string | undefined;
  txHash?: string | undefined;
  adapterId?: string | undefined;
}

const SOURCES = ["AGENT", "MODEL_GATEWAY", "ADAPTER", "CRE", "CONTEXTLOCK", "CHAIN", "RUNTIME", "OPERATOR", "SYSTEM"];
const SEVERITIES = ["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL"];

/** A verdict is the part of a decision worth seeing at a glance. */
const VERDICT_OF: Record<string, string> = {
  DECISION_ALLOW: "ALLOW",
  DECISION_DENY: "DENY",
  DECISION_ESCALATE: "ESCALATE",
  DECISION_NO_ACTION: "NO_ACTION",
  EXECUTION_SUBMITTED: "SUBMITTED",
  EXECUTION_MINED: "MINED",
  EXECUTION_FINALIZED: "FINALIZED",
  EXECUTION_REVERTED: "FAILED",
  EXECUTION_REORGED: "REORGED",
};

export function ActivityView({
  events, filters, onFilter, onSelectCorrelation,
}: {
  events: ActivityEvent[];
  filters: ActivityFilters;
  onFilter: (f: ActivityFilters) => void;
  onSelectCorrelation: (correlationId: string) => void;
}) {
  return (
    <div className="activity">
      <div className="activity-filters">
        <select value={filters.source ?? ""} onChange={(e) => onFilter({ ...filters, source: e.target.value || undefined })}>
          <option value="">every source</option>
          {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filters.minSeverity ?? ""} onChange={(e) => onFilter({ ...filters, minSeverity: e.target.value || undefined })}>
          <option value="">every severity</option>
          {SEVERITIES.map((s) => <option key={s} value={s}>{s} and above</option>)}
        </select>
        <input
          placeholder="transaction hash, from a block explorer"
          value={filters.txHash ?? ""}
          onChange={(e) => onFilter({ ...filters, txHash: e.target.value || undefined })}
          spellCheck={false}
        />
        <input
          placeholder="correlation id"
          value={filters.correlationId ?? ""}
          onChange={(e) => onFilter({ ...filters, correlationId: e.target.value || undefined })}
          spellCheck={false}
        />
        {Object.values(filters).some(Boolean) && (
          <button type="button" onClick={() => onFilter({})}>clear</button>
        )}
      </div>

      {events.length === 0 && (
        <p className="empty">
          No events. This deployment has never run — it reached READY_TO_ACTIVATE and was not activated.
        </p>
      )}

      <table className="timeline">
        <tbody>
          {events.map((e) => (
            <tr key={e.eventId} className={`row-${e.severity.toLowerCase()} ${e.correctsEventId ? "row-correction" : ""}`}>
              <td className="t-time">{new Date(e.timestamp).toISOString().replace("T", " ").slice(0, 19)}</td>
              <td className="t-source">{e.source}</td>
              <td className="t-type">
                {VERDICT_OF[e.type] ?? e.type.replace(/_/g, " ").toLowerCase()}
                {/* A correction is shown as a correction, not as a replacement. The row it
                    supersedes stays in the table above it. */}
                {e.correctsEventId && <span className="corrects">corrects an earlier record</span>}
              </td>
              <td className="t-detail">
                {e.adapterId && <code>{e.adapterId}</code>}
                {e.txHash && <code className="tx">{e.txHash.slice(0, 10)}…{e.txHash.slice(-6)}</code>}
                {e.blockNumber && <span className="block">block {e.blockNumber}</span>}
                {Object.entries(e.publicMetadata).slice(0, 3).map(([k, v]) => (
                  <span key={k} className="meta"><em>{k}</em> {String(v)}</span>
                ))}
              </td>
              <td className="t-trace">
                <button type="button" onClick={() => onSelectCorrelation(e.correlationId)} title="show the whole action this belonged to">
                  trace
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One attempted action, stage by stage.
 *
 * Stages are ordered by the action's own sequence rather than by when each observer noticed —
 * observers lag by different amounts, and sorting by observation time routinely shows a receipt
 * before the submission that caused it.
 */
export function TraceView({ trace, onClose }: { trace: { correlationId: string; reached: string | null; corrected: boolean; stages: Array<{ stage: string; events: ActivityEvent[] }>; identifiers: Record<string, string[]> } | null; onClose: () => void }) {
  if (!trace) return null;
  return (
    <div className="trace">
      <header>
        <h3>{trace.correlationId}</h3>
        <button type="button" onClick={onClose}>close</button>
      </header>
      <p className="trace-reached">
        reached <strong>{trace.reached ?? "nothing"}</strong>
        {trace.corrected && <span className="corrected"> · contains a correction</span>}
      </p>
      <ol className="trace-stages">
        {trace.stages.map((s) => (
          <li key={s.stage}>
            <span className="stage">{s.stage.replace(/_/g, " ").toLowerCase()}</span>
            <ul>
              {s.events.map((e) => (
                <li key={e.eventId}>
                  <span className="t-source">{e.source}</span> {e.type.replace(/_/g, " ").toLowerCase()}
                  <span className="t-time">{new Date(e.timestamp).toISOString().slice(11, 19)}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <dl className="trace-ids">
        {Object.entries(trace.identifiers).filter(([, v]) => v.length > 0).map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v.join(", ")}</dd></div>
        ))}
      </dl>
    </div>
  );
}
