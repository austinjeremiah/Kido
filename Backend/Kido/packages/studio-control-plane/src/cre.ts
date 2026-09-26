import { z } from "zod";
import { observed, unavailable, presentable, DEFAULT_TTLS, type Observation } from "./freshness.js";

/**
 * CRE monitoring.
 *
 * One narrow provider interface, so `cre` invocations do not get scattered around the Studio
 * (§25.7). Everything below it speaks structured JSON — §25.12 forbids scraping the CRE web UI, and
 * the installed CLI offers `--output json` on every command this needs.
 *
 * The part that took the most care is not the happy path. This account has no deploy access, so
 * there is no workflow and there never has been. The temptation is to render that as a health
 * problem or, worse, as nothing at all. §25.10 is explicit: NOT_DEPLOYED is a legitimate state,
 * distinct from unhealthy and distinct from active, and the UI must say which.
 */

export const CRE_STATES = [
  /** No CRE integration is configured for this deployment. */
  "NOT_CONFIGURED",
  /** Configured, but a precondition is missing — deploy access, for instance. Not a fault. */
  "BLOCKED",
  /** Access exists, nothing deployed yet. */
  "NOT_DEPLOYED",
  /** Deployed and paused. Exactly where a P23 deployment leaves it. */
  "PAUSED",
  /** Deployed, active, responding to triggers. */
  "ACTIVE",
  /** Deployed and failing. */
  "DEGRADED",
  "FAILED",
  /** We used to know. We no longer do. */
  "STALE",
] as const;
export const CreStateSchema = z.enum(CRE_STATES);
export type CreState = z.infer<typeof CreStateSchema>;

export const CreConnectionSchema = z.object({
  connected: z.boolean(),
  organizationId: z.string().nullable(),
  organizationName: z.string().nullable(),
  accountLabel: z.string().nullable(),
  deployAccess: z.boolean(),
  availableRegistryIds: z.array(z.string()),
  cliVersion: z.string().nullable(),
});
export type CreConnection = z.infer<typeof CreConnectionSchema>;

export const CreWorkflowSchema = z.object({
  workflowId: z.string().min(1),
  workflowName: z.string().min(1),
  registry: z.string().min(1),
  status: z.string().min(1),
  binaryHash: z.string().nullable(),
  lastExecutionAtMs: z.number().int().positive().nullable(),
  totalRuns: z.number().int().nonnegative().nullable(),
  successCount: z.number().int().nonnegative().nullable(),
  failureCount: z.number().int().nonnegative().nullable(),
  /**
   * Provenance of this record.
   *
   * `LIVE` means it came from the user's authenticated CLI. `FIXTURE` means it came from a captured
   * example. The two must never mix in a deployment record, and `assertNotFixture` is what stops it
   * (§25.47, LIVE-040).
   */
  provenance: z.enum(["LIVE", "FIXTURE"]),
});
export type CreWorkflow = z.infer<typeof CreWorkflowSchema>;

export const CreExecutionSchema = z.object({
  executionId: z.string().min(1),
  workflowId: z.string().min(1),
  status: z.enum(["TRIGGERED", "IN_PROGRESS", "SUCCESS", "FAILURE"]),
  startedAtMs: z.number().int().positive(),
  endedAtMs: z.number().int().positive().nullable(),
  provenance: z.enum(["LIVE", "FIXTURE"]),
});
export type CreExecution = z.infer<typeof CreExecutionSchema>;

export const CreExecutionEventSchema = z.object({
  executionId: z.string().min(1),
  capabilityId: z.string().nullable(),
  nodeId: z.string().nullable(),
  status: z.string(),
  timestampMs: z.number().int().positive(),
  message: z.string(),
});
export type CreExecutionEvent = z.infer<typeof CreExecutionEventSchema>;

/**
 * Metrics that exist only in Chainlink's web UI.
 *
 * §25.12 and §25.5 both say the same thing about these: show "not available through current
 * integration", never a fabricated zero. A zero for spend is a number an operator will act on.
 */
export const NOT_PROGRAMMATICALLY_AVAILABLE = [
  "credits",
  "spend",
  "billingBalance",
  "monthlyCost",
] as const;
export const NOT_AVAILABLE_TEXT = "Not available through current integration" as const;

/* ─────────────────────────── the provider interface ─────────────────────────── */

export interface CreOperationsProvider {
  readonly id: string;
  getConnectionStatus(): Promise<CreConnection>;
  listWorkflows(): Promise<CreWorkflow[]>;
  getWorkflow(name: string): Promise<CreWorkflow | null>;
  listExecutions(workflowIdOrName: string, opts?: { limit?: number; status?: string }): Promise<CreExecution[]>;
  getExecutionStatus(executionId: string): Promise<CreExecution | null>;
  getExecutionEvents(executionId: string): Promise<CreExecutionEvent[]>;
  getExecutionLogs(executionId: string): Promise<Array<{ nodeId: string | null; timestampMs: number; message: string }>>;
  activateWorkflow(name: string): Promise<{ status: string }>;
  pauseWorkflow(name: string): Promise<{ status: string }>;
  /**
   * Destructive. Separately privileged, and separately confirmed (§25.7, §25.14, LIVE-018).
   *
   * It is on this interface rather than in a general "lifecycle" method precisely so that a caller
   * has to name it, and so an authorization check can be attached to the name.
   */
  deleteWorkflow(name: string, confirmation: DestructiveConfirmation): Promise<{ deleted: true }>;
}

/**
 * What it takes to delete a workflow.
 *
 * A typed object rather than a boolean. `confirm: true` is something a caller passes by accident;
 * re-typing the workflow's own name is not. `understoodConsequence` is stored on the resulting
 * audit event, so the record shows what the operator was told.
 */
export const DestructiveConfirmationSchema = z.object({
  /** Must equal the workflow name exactly. */
  typedWorkflowName: z.string().min(1),
  understoodConsequence: z.literal("This permanently deletes all versions of the workflow from the registry."),
  actorId: z.string().min(1),
  confirmedAtMs: z.number().int().positive(),
});
export type DestructiveConfirmation = z.infer<typeof DestructiveConfirmationSchema>;

export const CRE_REASONS = {
  NOT_CONNECTED: "CRE-NOT-CONNECTED",
  DEPLOY_ACCESS_REQUIRED: "CRE_DEPLOY_ACCESS_REQUIRED",
  NO_WORKFLOW: "CRE-NO-WORKFLOW",
  TELEMETRY_STALE: "CRE_TELEMETRY_STALE",
  BRIDGE_OFFLINE: "CRE-BRIDGE-OFFLINE",
  FIXTURE_IN_LIVE: "CRE-FIXTURE-IN-LIVE-RECORD",
  CONFIRMATION_MISMATCH: "CRE-DESTRUCTIVE-CONFIRMATION-MISMATCH",
  NOT_AVAILABLE: "CRE-NOT-AVAILABLE-THROUGH-INTEGRATION",
} as const;
export type CreReason = (typeof CRE_REASONS)[keyof typeof CRE_REASONS];

export class CreMonitorError extends Error {
  constructor(readonly reason: CreReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "CreMonitorError";
  }
}

export function assertDestructiveConfirmation(workflowName: string, c: DestructiveConfirmation): void {
  if (c.typedWorkflowName !== workflowName) {
    throw new CreMonitorError(
      CRE_REASONS.CONFIRMATION_MISMATCH,
      `deleting "${workflowName}" requires typing its name exactly; "${c.typedWorkflowName}" was given`,
    );
  }
}

/**
 * A fixture identifier must never reach a live deployment record.
 *
 * The whole reason fixtures exist in this phase is that no live workflow can be created. That makes
 * this the single most likely way for a false claim to enter the evidence — a fixture workflow id
 * copied into a deployment row, read back later, and reported as a live deployment.
 */
export const FIXTURE_MARKER = "fixture-" as const;

export function assertNotFixture(record: { provenance: "LIVE" | "FIXTURE"; workflowId?: string }, where: string): void {
  if (record.provenance === "FIXTURE") {
    throw new CreMonitorError(CRE_REASONS.FIXTURE_IN_LIVE, `a FIXTURE-provenance CRE record cannot be written to ${where}`);
  }
  if (record.workflowId?.startsWith(FIXTURE_MARKER)) {
    throw new CreMonitorError(CRE_REASONS.FIXTURE_IN_LIVE, `workflow id "${record.workflowId}" is a fixture identifier and cannot be written to ${where}`);
  }
}

/* ─────────────────────────────── the monitor ─────────────────────────────── */

export interface CreStatusView {
  state: CreState;
  connection: CreConnection | null;
  workflow: CreWorkflow | null;
  /** Honest text for the panel. Never "unhealthy" when the truth is "not deployed". */
  headline: string;
  detail: string;
  blockedBy: string | null;
  /** Everything the CLI cannot tell us, named rather than zeroed. */
  unavailable: Record<string, string>;
  lastSyncedAtMs: number | null;
  isCurrent: boolean;
}

export interface CreMonitorDeps {
  provider: CreOperationsProvider | null;
  nowMs: () => number;
  ttlMs?: number;
}

export class CreMonitor {
  private last: Observation<{ connection: CreConnection; workflow: CreWorkflow | null }> | null = null;

  constructor(private readonly deps: CreMonitorDeps) {}

  /** The cached observation, exposed so callers can see its AGE. Never its value alone. */
  lastObservation(): Observation<{ connection: CreConnection; workflow: CreWorkflow | null }> | null {
    return this.last;
  }

  async sync(workflowName: string | null): Promise<Observation<{ connection: CreConnection; workflow: CreWorkflow | null }>> {
    const ttlMs = this.deps.ttlMs ?? DEFAULT_TTLS.cre;
    const nowMs = this.deps.nowMs();
    if (!this.deps.provider) {
      this.last = unavailable("NOT_CONFIGURED", { atMs: nowMs, source: "cre", ttlMs, reason: "no CRE provider is configured for this deployment" });
      return this.last;
    }
    try {
      const connection = await this.deps.provider.getConnectionStatus();
      const workflow = workflowName ? await this.deps.provider.getWorkflow(workflowName) : null;
      this.last = observed({ connection, workflow }, { atMs: nowMs, source: `cre:${this.deps.provider.id}`, ttlMs });
      return this.last;
    } catch (e) {
      // The bridge is down. Crucially, the PREVIOUS observation is kept — but it is returned
      // through `view()`, which will mark it STALE. What must not happen is the last successful
      // response being handed back as current (§25.11, LIVE-006).
      const failed = unavailable<{ connection: CreConnection; workflow: CreWorkflow | null }>("FAILED", {
        atMs: nowMs, source: `cre:${this.deps.provider.id}`, ttlMs,
        reason: `CRE could not be reached: ${(e as Error).message}`,
      });
      if (!this.last) this.last = failed;
      return failed;
    }
  }

  /**
   * The panel.
   *
   * Every branch here exists because the alternative is a screen that lies. In particular: an
   * organization without deploy access is BLOCKED, not FAILED — the integration works, Chainlink
   * has not enabled the feature, and telling an operator their CRE is broken sends them debugging
   * something that is fine.
   */
  view(nowMs: number): CreStatusView {
    const unavailableMetrics = Object.fromEntries(NOT_PROGRAMMATICALLY_AVAILABLE.map((k) => [k, NOT_AVAILABLE_TEXT]));

    if (!this.last) {
      return {
        state: "NOT_CONFIGURED", connection: null, workflow: null,
        headline: "Not configured", detail: "CRE has not been synchronized for this deployment.",
        blockedBy: null, unavailable: unavailableMetrics, lastSyncedAtMs: null, isCurrent: false,
      };
    }

    const p = presentable(this.last, nowMs);
    const base = { lastSyncedAtMs: this.last.observedAtMs, unavailable: unavailableMetrics };

    if (p.state === "NOT_CONFIGURED") {
      return { ...base, state: "NOT_CONFIGURED", connection: null, workflow: null, headline: "Not configured", detail: p.reason ?? "", blockedBy: null, isCurrent: false };
    }
    if (p.state === "STALE") {
      const v = p.value;
      return {
        ...base, state: "STALE", connection: v?.connection ?? null, workflow: v?.workflow ?? null,
        headline: "Status unknown — telemetry stale",
        detail: `Last confirmed ${new Date(p.observedAtMs).toISOString()}. ${p.reason ?? ""}`,
        blockedBy: CRE_REASONS.TELEMETRY_STALE, isCurrent: false,
      };
    }
    if (p.state === "FAILED" || !p.value) {
      return { ...base, state: "FAILED", connection: null, workflow: null, headline: "Unreachable", detail: p.reason ?? "CRE could not be reached.", blockedBy: CRE_REASONS.BRIDGE_OFFLINE, isCurrent: false };
    }

    const { connection, workflow } = p.value;
    if (!connection.connected) {
      return { ...base, state: "NOT_CONFIGURED", connection, workflow: null, headline: "Not connected", detail: "No CRE session. Connect Chainlink CRE to continue.", blockedBy: CRE_REASONS.NOT_CONNECTED, isCurrent: p.isCurrent };
    }
    if (!connection.deployAccess) {
      return {
        ...base, state: "BLOCKED", connection, workflow,
        headline: "Waiting for deployment access",
        detail: `Connected to ${connection.organizationName ?? connection.organizationId ?? "the organization"}. Chainlink has not enabled workflow deployment for this organization, so no workflow can exist yet. This is not a fault in the integration.`,
        blockedBy: CRE_REASONS.DEPLOY_ACCESS_REQUIRED, isCurrent: p.isCurrent,
      };
    }
    if (!workflow) {
      return { ...base, state: "NOT_DEPLOYED", connection, workflow: null, headline: "Not deployed", detail: "Deployment access is enabled and no workflow has been deployed for this agent.", blockedBy: CRE_REASONS.NO_WORKFLOW, isCurrent: p.isCurrent };
    }

    const s = workflow.status.toUpperCase();
    const state: CreState = s === "ACTIVE" ? "ACTIVE" : s === "PAUSED" ? "PAUSED" : s === "FAILED" ? "FAILED" : "DEGRADED";
    return {
      ...base, state, connection, workflow,
      headline: s === "ACTIVE" ? "Active" : s === "PAUSED" ? "Paused" : `Status ${workflow.status}`,
      detail: `Workflow ${workflow.workflowId} in the ${workflow.registry} registry.`,
      blockedBy: null, isCurrent: p.isCurrent,
    };
  }
}

/**
 * Normalize CRE execution events into the shape RuntimeEvents are built from.
 *
 * Provider payloads are stored only when safe, necessary, redacted and bounded (§25.13), so what
 * comes out here is a normalized record and a bounded message rather than the raw object.
 */
export const MAX_LOG_MESSAGE_CHARS = 2_000;

export function normalizeExecutionEvent(e: CreExecutionEvent): { capabilityId: string | null; nodeId: string | null; status: string; timestampMs: number; message: string; truncated: boolean } {
  const truncated = e.message.length > MAX_LOG_MESSAGE_CHARS;
  return {
    capabilityId: e.capabilityId,
    nodeId: e.nodeId,
    status: e.status,
    timestampMs: e.timestampMs,
    message: truncated ? `${e.message.slice(0, MAX_LOG_MESSAGE_CHARS)}… [truncated ${e.message.length - MAX_LOG_MESSAGE_CHARS} chars]` : e.message,
    truncated,
  };
}
