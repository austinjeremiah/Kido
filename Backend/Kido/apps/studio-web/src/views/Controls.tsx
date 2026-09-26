/**
 * The control surface.
 *
 * §25's control-UX rule: do not put every stop into one generic button. The categories below are
 * ordered by what they actually stop, and each control states its own consequence — because the
 * intuitive action (stop the container) is the one that stops the least.
 *
 * Nothing here calls a control directly. Each button emits a typed intent that the backend turns
 * into a `ControlCommand` and validates. The browser is not the control plane.
 */

export type Operation =
  | "PAUSE_RUNTIME" | "RESUME_RUNTIME" | "ROLLBACK_RUNTIME"
  | "PAUSE_CRE" | "ACTIVATE_CRE" | "DELETE_CRE"
  | "DISABLE_POLICY" | "ENABLE_POLICY"
  | "REVOKE_IDENTITY" | "EMERGENCY_LOCK";

export interface OperationInfo {
  operation: Operation;
  capability: string;
  affects: string;
  destructive: boolean;
  isFinancialStop: boolean;
}

const CATEGORIES: Array<{ title: string; note: string; operations: Operation[] }> = [
  {
    title: "Operational",
    note: "Affects the agent process. Does NOT withdraw financial authority — a paused runtime whose policy is enabled can still have live capabilities.",
    operations: ["PAUSE_RUNTIME", "RESUME_RUNTIME", "ROLLBACK_RUNTIME"],
  },
  {
    title: "Workflow",
    note: "Affects whether the CRE workflow responds to triggers. Pausing CRE is not a kill switch; it switches off one input.",
    operations: ["PAUSE_CRE", "ACTIVATE_CRE", "DELETE_CRE"],
  },
  {
    title: "Financial security",
    note: "The primary financial control. Disabling the policy stops execution whatever the runtime, the model or the DON decides.",
    operations: ["DISABLE_POLICY", "ENABLE_POLICY"],
  },
  {
    title: "Identity",
    note: "Revoking the agent's identity stops future capability issuance. Capabilities already issued remain valid until they expire.",
    operations: ["REVOKE_IDENTITY"],
  },
];

/** The consequence text a confirmation must show. Never "are you sure?". */
const CONSEQUENCE: Record<Operation, string> = {
  PAUSE_RUNTIME: "The agent process stops. The ContextLock policy is unchanged, and any capability already issued remains valid. This is an operational control, not a financial one.",
  RESUME_RUNTIME: "The agent process starts again with its current revision.",
  ROLLBACK_RUNTIME: "The previous image revision becomes active. The current revision's credential is fenced immediately, so a container still running from it becomes powerless.",
  PAUSE_CRE: "The workflow stops responding to triggers on the DON. Financial execution by any other path is unaffected.",
  ACTIVATE_CRE: "The workflow begins responding to triggers again.",
  DELETE_CRE: "This permanently deletes all versions of the workflow from the registry. It cannot be undone.",
  DISABLE_POLICY: "This agent loses its authority to move value. The executor will refuse, whatever the runtime, the model or the DON does. This is the strongest financial control.",
  ENABLE_POLICY: "This agent gains authority to move value, within its policy limits. Preconditions are checked first: verified deployment, healthy runtime, valid identity, acceptable adapters and any required CRE workflow.",
  REVOKE_IDENTITY: "The agent's onchain identity binding is revoked. Future capability issuance fails; capabilities already issued remain valid until they expire.",
  EMERGENCY_LOCK: "",
};

export function ControlsView({
  operations, currentRevision, busy, onIssue, onEmergency,
}: {
  operations: OperationInfo[];
  currentRevision: string;
  busy: string | null;
  onIssue: (op: Operation, consequence: string) => void;
  onEmergency: () => void;
}) {
  const info = Object.fromEntries(operations.map((o) => [o.operation, o]));

  return (
    <div className="controls">
      {CATEGORIES.map((c) => (
        <section key={c.title} className={`control-category cat-${c.title.toLowerCase().replace(/\s+/g, "-")}`}>
          <h3>{c.title}</h3>
          <p className="category-note">{c.note}</p>
          <div className="control-buttons">
            {c.operations.map((op) => {
              const meta = info[op];
              return (
                <button
                  key={op}
                  type="button"
                  disabled={busy !== null || !meta}
                  className={meta?.destructive ? "destructive" : meta?.isFinancialStop ? "financial" : ""}
                  onClick={() => onIssue(op, CONSEQUENCE[op])}
                  title={meta ? `affects ${meta.affects} · requires ${meta.capability}` : "unavailable"}
                >
                  {op.replace(/_/g, " ").toLowerCase()}
                  {meta && <span className="affects">{meta.affects}</span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}

      <section className="control-category cat-emergency">
        <h3>Emergency</h3>
        <p className="category-note">
          A single ordered sequence. The strongest financial control is attempted first, so a later
          step failing does not mean the treasury is exposed.
        </p>
        <button type="button" className="emergency" disabled={busy !== null} onClick={onEmergency}>
          EMERGENCY LOCK
        </button>
      </section>

      <p className="revision-note">Commands are issued against deployment revision <code>{currentRevision}</code>. If it changes, an in-flight command is rejected rather than applied to something else.</p>
    </div>
  );
}

/**
 * The emergency confirmation.
 *
 * States the order, because the order is the security property. No animation delays the backend
 * call — §25's emergency UX rule — so the modal's job is to inform, then get out of the way.
 */
export function EmergencyModal({ onCancel, onConfirm, busy }: { onCancel: () => void; onConfirm: (includeIdentity: boolean) => void; busy: boolean }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Emergency lock">
      <div className="modal emergency-modal">
        <h3>Emergency Lock</h3>
        <p>This will attempt, in order:</p>
        <ol>
          <li><strong>Disable the financial policy</strong> — the agent loses authority to move value</li>
          <li>Block new capability issuance</li>
          <li>Pause the CRE workflow</li>
          <li>Stop the agent runtime</li>
          <li>Optionally revoke the agent identity</li>
        </ol>
        <p className="modal-note">
          The strongest financial control is attempted first. If a later step fails, the result is
          recorded as PARTIAL with the policy still disabled — the money is safe either way.
        </p>
        <label className="modal-option">
          <input type="checkbox" id="include-identity" />
          also revoke the agent identity
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="emergency"
            disabled={busy}
            onClick={() => onConfirm((document.getElementById("include-identity") as HTMLInputElement | null)?.checked ?? false)}
          >
            {busy ? "running…" : "Emergency Lock"}
          </button>
        </div>
      </div>
    </div>
  );
}
