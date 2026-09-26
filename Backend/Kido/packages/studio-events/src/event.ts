import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * The RuntimeEvent.
 *
 * Not a UI notification. This is the product's canonical operational and financial audit record,
 * and everything about its shape follows from that:
 *
 *   IT IS PERSISTED, AND OLD EVENTS ARE NOT MUTATED. A correction is a NEW event pointing at the
 *   one it corrects. An audit log you can edit is a log that tells you what its most recent writer
 *   wanted you to believe.
 *
 *   ITS IDENTITY IS DERIVED, NOT ASSIGNED. `eventId` is a hash of what happened, so the same
 *   observation ingested twice — by a retry, a resumed cursor, a duplicated webhook — is the same
 *   row. Idempotency is a property of the identity rather than a discipline applied by callers.
 *
 *   IT IS PUBLIC-SAFE BY CONSTRUCTION. The only free-form field is `publicMetadata`, and every
 *   value entering it goes through a recursive scanner. §25.4's list is long and the interesting
 *   entries are the non-obvious ones: a private policy threshold and a raw confidential response
 *   are not credentials, and leaking either would still be a breach.
 *
 * It is deliberately independent of OpenTelemetry. Traces and metrics are infrastructure
 * observability and may be dropped, sampled or exported to a vendor that is down. A financial audit
 * record may not. See OPENTELEMETRY.md and LIVE-047.
 */

export const RUNTIME_EVENT_VERSION = "contextlock.runtime-event/v1" as const;

/**
 * Where an observation came from.
 *
 * The source is the observer, never the subject. A CHAIN event about a runtime's transaction is
 * `CHAIN`, because the chain is what was read — and if the runtime and the chain disagree, the
 * difference is only visible when their events are attributed separately.
 */
export const EVENT_SOURCES = [
  "AGENT",
  "MODEL_GATEWAY",
  "ADAPTER",
  "CRE",
  "CONTEXTLOCK",
  "CHAIN",
  "RUNTIME",
  "OPERATOR",
  "SYSTEM",
] as const;
export const EventSourceSchema = z.enum(EVENT_SOURCES);
export type EventSource = z.infer<typeof EventSourceSchema>;

export const EVENT_SEVERITIES = ["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL"] as const;
export const EventSeveritySchema = z.enum(EVENT_SEVERITIES);
export type EventSeverity = z.infer<typeof EventSeveritySchema>;

/**
 * The event vocabulary.
 *
 * Closed, like the bridge's operation list and the deployment plan's step types, and for the same
 * reason: an open vocabulary means a reader has to decide what to do with a type it has never seen,
 * and the safe answer is always "nothing", so it may as well be unrepresentable.
 */
export const EVENT_TYPES = [
  /* agent lifecycle */
  "AGENT_TRIGGERED", "AGENT_RUN_STARTED", "AGENT_RUN_COMPLETED", "AGENT_RUN_FAILED",
  /* decisions */
  "STRATEGY_EVALUATED", "DECISION_NO_ACTION", "DECISION_ALLOW", "DECISION_ESCALATE", "DECISION_DENY",
  /* model */
  "MODEL_REQUESTED", "MODEL_COMPLETED", "MODEL_REFUSED", "MODEL_FAILED",
  /* data */
  "ADAPTER_READ", "ADAPTER_FAILED", "ADAPTER_HEALTH_CHANGED",
  /* CRE */
  "CRE_EXECUTION_STARTED", "CRE_CAPABILITY_EVENT", "CRE_EXECUTION_COMPLETED", "CRE_EXECUTION_FAILED",
  "CRE_STATUS_CHANGED", "CRE_TELEMETRY_STALE", "CRE_LOG",
  /* authorization */
  "CAPABILITY_REQUESTED", "CAPABILITY_ISSUED", "CAPABILITY_REJECTED", "AUTHORIZATION_RECORDED",
  /* chain */
  "EXECUTION_SUBMITTED", "EXECUTION_MINED", "EXECUTION_CONFIRMING", "EXECUTION_FINALIZED",
  "EXECUTION_REVERTED", "EXECUTION_REORGED",
  /* observed state */
  "POLICY_STATE_OBSERVED", "POLICY_CHANGED", "IDENTITY_STATE_OBSERVED", "IDENTITY_CHANGED",
  "STATE_DRIFT_DETECTED", "STATE_DRIFT_RECONCILED",
  /* runtime */
  "RUNTIME_STATE_CHANGED", "RUNTIME_HEALTH_CHANGED", "RUNTIME_REVISION_CHANGED", "RUNTIME_CREDENTIAL_FENCED",
  /* operator */
  "CONTROL_COMMAND_ISSUED", "CONTROL_COMMAND_APPLIED", "CONTROL_COMMAND_REJECTED", "CONTROL_COMMAND_FAILED",
  "EMERGENCY_LOCK_STARTED", "EMERGENCY_LOCK_STEP", "EMERGENCY_LOCK_COMPLETED", "EMERGENCY_LOCK_PARTIAL",
  /* alerts and corrections */
  "ALERT_RAISED", "ALERT_ACKNOWLEDGED", "ALERT_RESOLVED",
  /* the correction record; see `correctsEventId` */
  "EVENT_CORRECTED",
] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);

/**
 * `publicMetadata`.
 *
 * The only free-form field, and the one the scanner exists for. JSON-ish values only: no functions,
 * no class instances, nothing whose serialization depends on the runtime that produced it.
 */
export const PublicMetadataSchema = z.record(z.string(), z.unknown());

export const RuntimeEventSchema = z.object({
  schemaVersion: z.literal(RUNTIME_EVENT_VERSION),
  /** Derived from content; see `deriveEventId`. Never assigned by a caller. */
  eventId: sha256,

  organizationId: z.string().min(1).nullable(),
  projectId: z.string().min(1),
  deploymentId: z.string().min(1),
  agentId: z.string().min(1).nullable(),

  source: EventSourceSchema,
  type: EventTypeSchema,
  severity: EventSeveritySchema,

  /** When the OBSERVED thing happened, in epoch ms. */
  timestamp: z.number().int().positive(),
  /** When we recorded it. Different from `timestamp` whenever an observer lags, which is always. */
  observedAtMs: z.number().int().positive(),

  /* ── correlation: separate IDs, never one overloaded field (P25.6) ── */
  correlationId: z.string().min(1),
  agentRunId: z.string().min(1).nullable(),
  modelRunId: z.string().min(1).nullable(),
  strategyEvaluationId: z.string().min(1).nullable(),
  creExecutionId: z.string().min(1).nullable(),
  authorizationId: z.string().min(1).nullable(),
  capabilityId: z.string().min(1).nullable(),

  chainId: z.number().int().positive().nullable(),
  blockNumber: z.string().regex(/^\d+$/).nullable(),
  txHash: hex32.nullable(),

  creWorkflowId: z.string().min(1).nullable(),

  adapterId: z.string().min(1).nullable(),
  /** Which immutable runtime revision produced or was subject to this. */
  runtimeRevision: z.string().min(1).nullable(),
  /** The build/deployment revisions this event belongs to, so a timeline is version-aware. */
  buildRevision: z.number().int().nonnegative().nullable(),
  deploymentRevision: z.string().min(1).nullable(),

  /**
   * The event this one corrects, if any.
   *
   * Corrections are new records. `EXECUTION_MINED` followed by `EXECUTION_REORGED` leaves both in
   * the log, and the second names the first — so the history shows what was believed and when it
   * stopped being true, rather than quietly becoming a log that was always right.
   */
  correctsEventId: sha256.nullable(),

  publicMetadata: PublicMetadataSchema,
});
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

/** Deterministic serialization. Keys sorted at every level so identity does not depend on order. */
export function canonicalize(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "bigint") throw new Error("EVENT-BIGINT: encode large integers as decimal strings");
    if (v === undefined) return null;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = walk(o[k]);
      return out;
    }
    throw new Error(`EVENT-UNSERIALIZABLE: ${typeof v}`);
  };
  return JSON.stringify(walk(value));
}

/**
 * Derive an event's identity from what it says happened.
 *
 * `observedAtMs` is excluded. Two observers seeing the same chain event at different moments must
 * produce the SAME id, or a restarted cursor with reorg overlap would duplicate everything it
 * re-read. `timestamp` is the moment the thing happened and IS included, because two genuinely
 * different occurrences of the same type differ by when they occurred.
 */
export function deriveEventId(e: Omit<RuntimeEvent, "eventId" | "observedAtMs">): string {
  const { publicMetadata, ...rest } = e;
  return `sha256:${createHash("sha256").update(canonicalize({ ...rest, publicMetadata })).digest("hex")}`;
}

export const newCorrelationId = (): string => `corr_${randomUUID()}`;
export const newRunId = (prefix: string): string => `${prefix}_${randomUUID().slice(0, 12)}`;
