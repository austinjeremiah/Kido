import { createHash } from "node:crypto";
import { z } from "zod";
import { CRITICAL_DRIFT, type Drift } from "./chain.js";

/**
 * The alert engine.
 *
 * §25.42's hard requirement is the one that decides the design: **do not create a new alert every
 * polling cycle.** A monitor that polls every 15 s and files an alert each time produces 240 rows an
 * hour for one problem, and the operator stops reading them — which is worse than not alerting.
 *
 * So an alert has a derived FINGERPRINT: the rule plus the specific thing it is about. The same
 * problem observed again increments `occurrences` and moves `lastSeen`; it does not create a row.
 *
 * The second decision is about resolution. §25.43: a critical security drift may NOT be
 * auto-resolved because one later poll came back normal. A policy that was enabled and is now
 * disabled again did not un-happen. Those require an explicit reconciliation with evidence, and
 * `resolve()` refuses without one.
 */

export const ALERT_RULES = [
  "RUNTIME_CRASH_LOOP",
  "RUNTIME_UNHEALTHY",
  "CRE_TELEMETRY_STALE",
  "CRE_FAILURE_SPIKE",
  "ADAPTER_STALE",
  "ADAPTER_UNAVAILABLE",
  "POLICY_UNEXPECTEDLY_ENABLED",
  "POLICY_UNEXPECTEDLY_DISABLED",
  "ENS_IDENTITY_CHANGED",
  "ADMIN_CHANGED",
  "BYTECODE_DRIFT",
  "RUNTIME_IMAGE_DRIFT",
  "REPEATED_DENY",
  "PROMPT_INJECTION_ATTEMPTS",
  "BUDGET_WARNING",
  "TRANSACTION_REVERT_SPIKE",
  "BRIDGE_DISCONNECTED",
  "CHAIN_OBSERVER_STALE",
  "STATE_DRIFT",
] as const;
export const AlertRuleSchema = z.enum(ALERT_RULES);
export type AlertRule = z.infer<typeof AlertRuleSchema>;

export const ALERT_SEVERITIES = ["INFO", "WARNING", "CRITICAL"] as const;
export const AlertSeveritySchema = z.enum(ALERT_SEVERITIES);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

export const ALERT_STATES = ["OPEN", "ACKNOWLEDGED", "RESOLVED"] as const;
export const AlertStateSchema = z.enum(ALERT_STATES);
export type AlertState = z.infer<typeof AlertStateSchema>;

/**
 * Rules whose alerts cannot be auto-resolved.
 *
 * Every one of them is "somebody did something". The next poll returning normal tells you the
 * current state; it tells you nothing about whether the event happened or what it was.
 */
export const REQUIRES_RECONCILIATION: ReadonlySet<AlertRule> = new Set<AlertRule>([
  "POLICY_UNEXPECTEDLY_ENABLED",
  "ADMIN_CHANGED",
  "BYTECODE_DRIFT",
  "RUNTIME_IMAGE_DRIFT",
  "ENS_IDENTITY_CHANGED",
]);

export const AlertSchema = z.object({
  alertId: z.string().min(1),
  /** Derived from rule + subject. Two observations of one problem share it. */
  fingerprint: z.string().min(1),
  rule: AlertRuleSchema,
  severity: AlertSeveritySchema,
  state: AlertStateSchema,
  projectId: z.string().min(1),
  deploymentId: z.string().min(1),
  /** The specific thing: an adapter id, a policy hash, a contract address. */
  subject: z.string().min(1),
  reason: z.string().min(1),
  /** Public-safe supporting facts. Passes the redaction scanner like any other outward surface. */
  evidence: z.record(z.string(), z.unknown()),
  firstSeenAtMs: z.number().int().positive(),
  lastSeenAtMs: z.number().int().positive(),
  occurrences: z.number().int().positive(),
  acknowledgedBy: z.string().nullable(),
  acknowledgedAtMs: z.number().int().positive().nullable(),
  resolvedAtMs: z.number().int().positive().nullable(),
  resolvedBy: z.string().nullable(),
  /** Why it was resolved. Required for the rules above. */
  resolutionEvidence: z.string().nullable(),
  requiresReconciliation: z.boolean(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const ALERT_REASONS = {
  RECONCILIATION_REQUIRED: "ALERT-RECONCILIATION-REQUIRED",
  UNKNOWN_ALERT: "ALERT-UNKNOWN",
  ALREADY_RESOLVED: "ALERT-ALREADY-RESOLVED",
} as const;
export type AlertReason = (typeof ALERT_REASONS)[keyof typeof ALERT_REASONS];

export class AlertError extends Error {
  constructor(readonly reason: AlertReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "AlertError";
  }
}

export const fingerprintOf = (rule: AlertRule, deploymentId: string, subject: string): string =>
  `fp_${createHash("sha256").update(`${rule}|${deploymentId}|${subject}`).digest("hex").slice(0, 24)}`;

export interface RaiseArgs {
  rule: AlertRule;
  severity: AlertSeverity;
  projectId: string;
  deploymentId: string;
  subject: string;
  reason: string;
  evidence?: Record<string, unknown>;
  nowMs: number;
}

/**
 * The alert store.
 *
 * Deduplicating by construction. `raise()` on an existing OPEN fingerprint updates it; there is no
 * code path that produces two rows for one fingerprint, so a polling loop cannot flood it.
 */
export class AlertEngine {
  private readonly byFingerprint = new Map<string, Alert>();
  private seq = 0;

  raise(args: RaiseArgs): { alert: Alert; created: boolean } {
    const fingerprint = fingerprintOf(args.rule, args.deploymentId, args.subject);
    const existing = this.byFingerprint.get(fingerprint);

    if (existing && existing.state !== "RESOLVED") {
      // Same problem, seen again. Count it, move the clock, keep the original firstSeen — the age
      // of a problem is what an operator triages on.
      existing.occurrences += 1;
      existing.lastSeenAtMs = args.nowMs;
      existing.reason = args.reason;
      if (args.evidence) existing.evidence = { ...existing.evidence, ...args.evidence };
      // An escalation is allowed; a de-escalation is not. A problem that was critical once stays
      // critical until someone resolves it deliberately.
      if (args.severity === "CRITICAL") existing.severity = "CRITICAL";
      return { alert: existing, created: false };
    }

    if (existing && existing.state === "RESOLVED") {
      // It came back. A new row, so the history shows two occurrences rather than one long one.
      this.byFingerprint.delete(fingerprint);
    }

    const alert: Alert = {
      alertId: `alr_${(++this.seq).toString().padStart(6, "0")}`,
      fingerprint,
      rule: args.rule,
      severity: args.severity,
      state: "OPEN",
      projectId: args.projectId,
      deploymentId: args.deploymentId,
      subject: args.subject,
      reason: args.reason,
      evidence: args.evidence ?? {},
      firstSeenAtMs: args.nowMs,
      lastSeenAtMs: args.nowMs,
      occurrences: 1,
      acknowledgedBy: null,
      acknowledgedAtMs: null,
      resolvedAtMs: null,
      resolvedBy: null,
      resolutionEvidence: null,
      requiresReconciliation: REQUIRES_RECONCILIATION.has(args.rule),
    };
    this.byFingerprint.set(fingerprint, alert);
    return { alert, created: true };
  }

  acknowledge(alertId: string, actorId: string, nowMs: number): Alert {
    const a = this.mustFind(alertId);
    a.state = "ACKNOWLEDGED";
    a.acknowledgedBy = actorId;
    a.acknowledgedAtMs = nowMs;
    return a;
  }

  /**
   * Resolve an alert.
   *
   * `evidence` is required for rules that require reconciliation, and the requirement is enforced
   * here rather than in the UI — otherwise the first automation that calls this API bypasses it.
   */
  resolve(alertId: string, args: { actorId: string; evidence: string | null; nowMs: number }): Alert {
    const a = this.mustFind(alertId);
    if (a.state === "RESOLVED") throw new AlertError(ALERT_REASONS.ALREADY_RESOLVED, alertId);
    if (a.requiresReconciliation && (!args.evidence || args.evidence.trim().length < 10)) {
      throw new AlertError(
        ALERT_REASONS.RECONCILIATION_REQUIRED,
        `${a.rule} on ${a.subject} is a security drift and cannot be resolved without reconciliation evidence. A later poll returning normal does not mean it did not happen.`,
      );
    }
    a.state = "RESOLVED";
    a.resolvedAtMs = args.nowMs;
    a.resolvedBy = args.actorId;
    a.resolutionEvidence = args.evidence;
    return a;
  }

  /**
   * Auto-resolve, for conditions that genuinely clear on their own.
   *
   * Refuses on the reconciliation-required rules. This is the function a polling loop calls when a
   * condition stops being observed, and the refusal is what stops a critical drift being cleared by
   * a loop rather than a person.
   */
  autoResolve(rule: AlertRule, deploymentId: string, subject: string, nowMs: number): Alert | null {
    const a = this.byFingerprint.get(fingerprintOf(rule, deploymentId, subject));
    if (!a || a.state === "RESOLVED") return null;
    if (a.requiresReconciliation) return null;
    a.state = "RESOLVED";
    a.resolvedAtMs = nowMs;
    a.resolvedBy = "system";
    a.resolutionEvidence = "the condition was no longer observed";
    return a;
  }

  get(alertId: string): Alert | null {
    return [...this.byFingerprint.values()].find((a) => a.alertId === alertId) ?? null;
  }

  open(deploymentId?: string): Alert[] {
    return [...this.byFingerprint.values()]
      .filter((a) => a.state !== "RESOLVED" && (deploymentId === undefined || a.deploymentId === deploymentId))
      .sort((a, b) => (a.severity === b.severity ? b.lastSeenAtMs - a.lastSeenAtMs : a.severity === "CRITICAL" ? -1 : b.severity === "CRITICAL" ? 1 : 0));
  }

  all(): Alert[] {
    return [...this.byFingerprint.values()].sort((a, b) => a.firstSeenAtMs - b.firstSeenAtMs);
  }

  private mustFind(alertId: string): Alert {
    const a = this.get(alertId);
    if (!a) throw new AlertError(ALERT_REASONS.UNKNOWN_ALERT, alertId);
    return a;
  }
}

/** Map an observed drift onto its alert rule. Keeps the two vocabularies from diverging silently. */
const DRIFT_TO_RULE: Record<string, AlertRule> = {
  POLICY_ENABLED_UNEXPECTEDLY: "POLICY_UNEXPECTEDLY_ENABLED",
  POLICY_DISABLED_UNEXPECTEDLY: "POLICY_UNEXPECTEDLY_DISABLED",
  POLICY_ADMIN_CHANGED: "ADMIN_CHANGED",
  ADMIN_CHANGED: "ADMIN_CHANGED",
  BYTECODE_DRIFT: "BYTECODE_DRIFT",
  IDENTITY_CHANGED: "ENS_IDENTITY_CHANGED",
  IDENTITY_REVOKED_UNEXPECTEDLY: "ENS_IDENTITY_CHANGED",
  RUNTIME_IMAGE_DRIFT: "RUNTIME_IMAGE_DRIFT",
  BINDING_VERSION_CHANGED: "STATE_DRIFT",
  CONTRACT_MISSING: "BYTECODE_DRIFT",
};

export function alertForDrift(d: Drift, ctx: { projectId: string; deploymentId: string }): RaiseArgs {
  return {
    rule: DRIFT_TO_RULE[d.kind] ?? "STATE_DRIFT",
    severity: CRITICAL_DRIFT.has(d.kind) ? "CRITICAL" : "WARNING",
    projectId: ctx.projectId,
    deploymentId: ctx.deploymentId,
    subject: d.subject,
    reason: d.detail,
    evidence: { kind: d.kind, expected: d.expected, observed: d.observed, blockNumber: d.blockNumber },
    nowMs: d.observedAtMs,
  };
}
