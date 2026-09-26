/**
 * The deployed-agent Overview.
 *
 * Everything on this screen came from an observation with a timestamp, and every panel shows that
 * timestamp. The two rules the design turns on:
 *
 *   A PANEL IS GREEN ONLY WHEN ITS READING IS CURRENT. Colour is derived from `isCurrent`, not from
 *   the value — so a stale HEALTHY reads amber with "last confirmed …", never green. §25.11.
 *
 *   NOTHING IS HIDDEN. A missing integration, a blocked one and a broken one look different from
 *   each other and all three are shown. §25.49 — a screen that hides the gaps is not evidence that
 *   the monitoring is honest.
 */

export interface Freshness {
  observedAtMs: number;
  ageMs: number;
  isCurrent: boolean;
  source: string;
  state: string;
  reason: string | null;
}

export interface OverviewData {
  deploymentId: string;
  badge: "LIVE" | "INACTIVE";
  notLiveBecause: string[];
  currentRevision: string;
  panels: {
    policy: (Freshness & { value: { enabled: boolean; bindingVersion: string; policyAdmin: string } | null }) | null;
    runtime: { state: string; reasons: string[]; note: string };
    cre: { state: string; headline: string; detail?: string; blockedBy: string | null; lastSyncedAtMs?: number | null; unavailable?: Record<string, string> };
    identity: (Freshness & { value: { boundAgent: string | null; revoked: boolean } | null }) | null;
    adapters: Array<{ adapterId: string; state: string; reason?: string | null }>;
  };
  drift: Array<{ kind: string; severity: string; subject: string; expected: string; observed: string; detail: string }>;
  alerts: { open: number; critical: number; rows: Array<{ alertId: string; rule: string; severity: string; subject: string; reason: string; occurrences: number; requiresReconciliation: boolean }> };
  note: string;
}

const ago = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

/**
 * The dot.
 *
 * Deliberately not a function of the VALUE. A policy that is disabled is not a problem, and a
 * policy whose reading expired is — so `isCurrent` decides the colour and the value decides the
 * label. Getting this backwards is how a dashboard reports a system it stopped watching as fine.
 */
function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "off" }) {
  return <span className={`dot dot-${tone}`} aria-hidden="true">●</span>;
}

function Stamp({ f }: { f: Freshness | null | undefined }) {
  if (!f) return <span className="stamp stamp-none">never read</span>;
  return (
    <span className={`stamp ${f.isCurrent ? "stamp-fresh" : "stamp-stale"}`}>
      {f.isCurrent ? "verified" : "LAST CONFIRMED"} {ago(f.ageMs)} · {f.source}
      {!f.isCurrent && <strong> · NOT CURRENT</strong>}
    </span>
  );
}

function Panel({ title, tone, value, detail, stamp, children }: { title: string; tone: "ok" | "warn" | "bad" | "off"; value: string; detail?: string | null; stamp?: Freshness | null; children?: React.ReactNode }) {
  return (
    <div className={`panel panel-${tone}`}>
      <div className="panel-head">
        <span className="panel-title">{title}</span>
        <span className="panel-value"><Dot tone={tone} /> {value}</span>
      </div>
      {detail && <p className="panel-detail">{detail}</p>}
      {stamp !== undefined && <Stamp f={stamp} />}
      {children}
    </div>
  );
}

export function OverviewView({ data }: { data: OverviewData | null }) {
  if (!data) return <div className="empty">No deployment selected.</div>;
  const p = data.panels;

  // A policy panel: colour from freshness, label from the value, and UNKNOWN when it could not be
  // read — never "disabled", which would be a green light for an agent that may be able to act.
  const policyTone: "ok" | "warn" | "bad" | "off" =
    !p.policy || !p.policy.value ? "bad" : !p.policy.isCurrent ? "warn" : p.policy.value.enabled ? "ok" : "off";
  const policyLabel = !p.policy || !p.policy.value ? "UNKNOWN" : p.policy.value.enabled ? "ENABLED" : "DISABLED";

  const runtimeTone: "ok" | "warn" | "bad" | "off" =
    p.runtime.state === "HEALTHY" ? "ok" : p.runtime.state === "DEGRADED" || p.runtime.state === "STARTING" ? "warn"
    : p.runtime.state === "CRASH_LOOP" || p.runtime.state === "FAILED" ? "bad" : "off";

  const creTone: "ok" | "warn" | "bad" | "off" =
    p.cre.state === "ACTIVE" ? "ok" : p.cre.state === "STALE" || p.cre.state === "DEGRADED" ? "warn"
    : p.cre.state === "FAILED" ? "bad" : "off";

  return (
    <div className="overview">
      <header className="overview-head">
        <h2>{data.deploymentId}</h2>
        <span className={`badge badge-${data.badge.toLowerCase()}`}>
          <Dot tone={data.badge === "LIVE" ? "ok" : "off"} /> {data.badge}
        </span>
      </header>

      {data.badge === "INACTIVE" && data.notLiveBecause.length > 0 && (
        <div className="not-live">
          <strong>Not live because:</strong>
          <ul>{data.notLiveBecause.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      {data.drift.length > 0 && (
        <div className="drift">
          <strong>STATE DRIFT — the deployment record and the chain disagree</strong>
          {data.drift.map((d) => (
            <div key={d.kind + d.subject} className={`drift-row drift-${d.severity.toLowerCase()}`}>
              <span className="drift-kind">{d.severity} {d.kind}</span>
              <span className="drift-subject">{d.subject}</span>
              <p>{d.detail}</p>
              <code>expected {d.expected} · observed {d.observed}</code>
            </div>
          ))}
        </div>
      )}

      <div className="panels">
        <Panel
          title="ContextLock policy"
          tone={policyTone}
          value={policyLabel}
          detail={
            !p.policy?.value
              ? "The policy could not be read from chain. Its state is UNKNOWN — it is not assumed disabled."
              : `binding version ${p.policy.value.bindingVersion} · admin ${p.policy.value.policyAdmin}`
          }
          stamp={p.policy}
        >
          <p className="panel-note">This is the financial control. It is read from the chain on every refresh.</p>
        </Panel>

        <Panel title="Agent runtime" tone={runtimeTone} value={p.runtime.state} stamp={null}>
          {p.runtime.reasons.length > 0 && <ul className="reasons">{p.runtime.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          <p className="panel-note">{p.runtime.note}</p>
        </Panel>

        <Panel
          title="Chainlink CRE"
          tone={creTone}
          value={p.cre.state.replace(/_/g, " ")}
          detail={p.cre.detail ?? p.cre.headline}
          stamp={null}
        >
          {p.cre.blockedBy && <code className="blocked">{p.cre.blockedBy}</code>}
          {p.cre.lastSyncedAtMs && <span className="stamp">last synced {ago(Date.now() - p.cre.lastSyncedAtMs)}</span>}
          {p.cre.unavailable && Object.keys(p.cre.unavailable).length > 0 && (
            <details className="unavailable">
              <summary>Metrics not available through this integration</summary>
              <ul>{Object.entries(p.cre.unavailable).map(([k, v]) => <li key={k}><code>{k}</code> — {v}</li>)}</ul>
            </details>
          )}
        </Panel>

        <Panel
          title="ENS identity"
          tone={!p.identity?.value ? "off" : p.identity.value.revoked ? "bad" : p.identity.isCurrent ? "ok" : "warn"}
          value={!p.identity?.value ? "NOT REGISTERED" : p.identity.value.revoked ? "REVOKED" : "ACTIVE"}
          detail={p.identity?.value?.boundAgent ?? "No identity is registered for this agent."}
          stamp={p.identity}
        />
      </div>

      <div className="adapters">
        <h3>Adapters</h3>
        {p.adapters.length === 0 && <p className="empty">No adapters configured.</p>}
        {p.adapters.map((a) => (
          <div key={a.adapterId} className={`adapter adapter-${a.state.toLowerCase()}`}>
            <Dot tone={a.state === "HEALTHY" ? "ok" : a.state === "DEGRADED" ? "warn" : a.state === "DISABLED" ? "off" : "warn"} />
            <span className="adapter-id">{a.adapterId}</span>
            <span className="adapter-state">{a.state}</span>
            {a.reason && <span className="adapter-reason">{a.reason}</span>}
          </div>
        ))}
      </div>

      {data.alerts.open > 0 && (
        <div className="alerts">
          <h3>{data.alerts.open} open alert{data.alerts.open === 1 ? "" : "s"}{data.alerts.critical > 0 && ` · ${data.alerts.critical} critical`}</h3>
          {data.alerts.rows.map((a) => (
            <div key={a.alertId} className={`alert alert-${a.severity.toLowerCase()}`}>
              <span className="alert-rule">{a.severity} {a.rule}</span>
              <span className="alert-subject">{a.subject}</span>
              <p>{a.reason}</p>
              <span className="alert-meta">
                seen {a.occurrences}×
                {a.requiresReconciliation && <strong> · requires reconciliation evidence to resolve</strong>}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="freshness-note">{data.note}</p>
    </div>
  );
}
