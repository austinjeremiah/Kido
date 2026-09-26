import { z } from "zod";
import type { RuntimeEvent, EventType } from "./event.js";

/**
 * End-to-end correlation.
 *
 * §25.5's chain — trigger, reads, evaluation, model, CRE, decision, authorization, capability,
 * submission, receipt, finalization — has to be walkable in both directions. From a transaction on
 * a block explorer back to the trigger that caused it, and from a trigger forward to what it moved.
 *
 * Two design choices make that possible.
 *
 * SEPARATE IDS, NEVER ONE OVERLOADED FIELD (§25.6). It is tempting to put everything in
 * `correlationId` and be done. But an agent run may make several model calls, a strategy evaluation
 * may span two CRE executions, and one authorization may cover a transaction that gets replaced.
 * Overloading one field turns those into ambiguity exactly where an incident review needs
 * precision. So each identifier is its own nullable column, and the relationships are queryable.
 *
 * NO CHAIN-OF-THOUGHT. §25.5 says it and `redaction.ts` enforces it. Reasoning text is not tracing
 * data — it is the field most likely to contain a repeated secret, because the model saw
 * everything. What goes in a trace is identifiers, verdicts and reason codes.
 */

/** The stages of one attempted action, in the order they can occur. */
export const TRACE_STAGES = [
  "TRIGGER",
  "DATA_READ",
  "STRATEGY_EVALUATION",
  "MODEL_INVOCATION",
  "CRE_EVALUATION",
  "CONTEXTLOCK_DECISION",
  "AUTHORIZATION",
  "CAPABILITY",
  "SUBMISSION",
  "TRANSACTION",
  "RECEIPT",
  "FINALIZED",
] as const;
export type TraceStage = (typeof TRACE_STAGES)[number];

/** Which stage an event type belongs to. Types with no stage are not part of an action trace. */
const STAGE_OF: Partial<Record<EventType, TraceStage>> = {
  AGENT_TRIGGERED: "TRIGGER",
  AGENT_RUN_STARTED: "TRIGGER",
  ADAPTER_READ: "DATA_READ",
  ADAPTER_FAILED: "DATA_READ",
  STRATEGY_EVALUATED: "STRATEGY_EVALUATION",
  MODEL_REQUESTED: "MODEL_INVOCATION",
  MODEL_COMPLETED: "MODEL_INVOCATION",
  MODEL_REFUSED: "MODEL_INVOCATION",
  MODEL_FAILED: "MODEL_INVOCATION",
  CRE_EXECUTION_STARTED: "CRE_EVALUATION",
  CRE_CAPABILITY_EVENT: "CRE_EVALUATION",
  CRE_EXECUTION_COMPLETED: "CRE_EVALUATION",
  CRE_EXECUTION_FAILED: "CRE_EVALUATION",
  DECISION_ALLOW: "CONTEXTLOCK_DECISION",
  DECISION_DENY: "CONTEXTLOCK_DECISION",
  DECISION_ESCALATE: "CONTEXTLOCK_DECISION",
  DECISION_NO_ACTION: "CONTEXTLOCK_DECISION",
  AUTHORIZATION_RECORDED: "AUTHORIZATION",
  CAPABILITY_REQUESTED: "CAPABILITY",
  CAPABILITY_ISSUED: "CAPABILITY",
  CAPABILITY_REJECTED: "CAPABILITY",
  EXECUTION_SUBMITTED: "SUBMISSION",
  EXECUTION_MINED: "TRANSACTION",
  EXECUTION_REVERTED: "TRANSACTION",
  EXECUTION_CONFIRMING: "RECEIPT",
  EXECUTION_FINALIZED: "FINALIZED",
  EXECUTION_REORGED: "FINALIZED",
};

export const stageOf = (type: EventType): TraceStage | null => STAGE_OF[type] ?? null;

export interface TraceNode {
  stage: TraceStage;
  events: RuntimeEvent[];
  firstAtMs: number;
  lastAtMs: number;
}

export interface ActionTrace {
  correlationId: string;
  stages: TraceNode[];
  /** Identifiers observed anywhere in the trace, so any one of them finds the whole thing. */
  identifiers: {
    agentRunIds: string[];
    modelRunIds: string[];
    strategyEvaluationIds: string[];
    creExecutionIds: string[];
    authorizationIds: string[];
    capabilityIds: string[];
    txHashes: string[];
  };
  /** The stage the action reached. A trace that stops at CAPABILITY never moved value. */
  reached: TraceStage | null;
  /** True when a correction event (a reorg, say) appears anywhere in the trace. */
  corrected: boolean;
  startedAtMs: number | null;
  endedAtMs: number | null;
}

const uniq = (xs: Array<string | null>): string[] => [...new Set(xs.filter((x): x is string => x !== null))];

/**
 * Assemble one attempted action from its events.
 *
 * Stages are ordered by the TRACE_STAGES sequence rather than by timestamp. Observers lag by
 * different amounts — a chain observer polling every 12 s reports a receipt after a runtime
 * reported a submission it saw instantly — so sorting a trace by observation time would routinely
 * show the receipt before the submission.
 */
export function buildTrace(correlationId: string, events: RuntimeEvent[]): ActionTrace {
  const mine = events.filter((e) => e.correlationId === correlationId);
  const byStage = new Map<TraceStage, RuntimeEvent[]>();
  for (const e of mine) {
    const stage = stageOf(e.type);
    if (!stage) continue;
    const list = byStage.get(stage) ?? [];
    list.push(e);
    byStage.set(stage, list);
  }

  const stages: TraceNode[] = TRACE_STAGES.filter((s) => byStage.has(s)).map((stage) => {
    const evs = byStage.get(stage)!.sort((a, b) => a.timestamp - b.timestamp);
    return { stage, events: evs, firstAtMs: evs[0]!.timestamp, lastAtMs: evs[evs.length - 1]!.timestamp };
  });

  const times = mine.map((e) => e.timestamp).sort((a, b) => a - b);
  return {
    correlationId,
    stages,
    identifiers: {
      agentRunIds: uniq(mine.map((e) => e.agentRunId)),
      modelRunIds: uniq(mine.map((e) => e.modelRunId)),
      strategyEvaluationIds: uniq(mine.map((e) => e.strategyEvaluationId)),
      creExecutionIds: uniq(mine.map((e) => e.creExecutionId)),
      authorizationIds: uniq(mine.map((e) => e.authorizationId)),
      capabilityIds: uniq(mine.map((e) => e.capabilityId)),
      txHashes: uniq(mine.map((e) => e.txHash)),
    },
    reached: stages.length > 0 ? stages[stages.length - 1]!.stage : null,
    corrected: mine.some((e) => e.correctsEventId !== null),
    startedAtMs: times[0] ?? null,
    endedAtMs: times[times.length - 1] ?? null,
  };
}

/**
 * Find the correlation id for any identifier a user might paste in.
 *
 * The navigation §25.6 asks for: one transaction hash should lead back to the trigger. A block
 * explorer gives a user a tx hash and nothing else, so that is the entry point that has to work.
 */
export function correlationIdFor(
  events: RuntimeEvent[],
  needle: { txHash?: string; capabilityId?: string; creExecutionId?: string; authorizationId?: string; agentRunId?: string },
): string | null {
  const match = events.find((e) =>
    (needle.txHash !== undefined && e.txHash?.toLowerCase() === needle.txHash.toLowerCase()) ||
    (needle.capabilityId !== undefined && e.capabilityId === needle.capabilityId) ||
    (needle.creExecutionId !== undefined && e.creExecutionId === needle.creExecutionId) ||
    (needle.authorizationId !== undefined && e.authorizationId === needle.authorizationId) ||
    (needle.agentRunId !== undefined && e.agentRunId === needle.agentRunId),
  );
  return match?.correlationId ?? null;
}

/**
 * Trace context safe to propagate.
 *
 * What may travel in OTel baggage or a gateway header. Identifiers only — no verdict, no amount, no
 * threshold, no reasoning. A field added here travels to every service and every exporter, which is
 * why the list is short and the type is closed.
 */
export const SafeTraceContextSchema = z.object({
  correlationId: z.string().min(1),
  agentRunId: z.string().nullable(),
  deploymentId: z.string().min(1),
  agentId: z.string().nullable(),
});
export type SafeTraceContext = z.infer<typeof SafeTraceContextSchema>;

/** Fields that must never be put into trace baggage, named so their absence is testable. */
export const FORBIDDEN_BAGGAGE_KEYS = [
  "amount", "amountUsdCents", "threshold", "policyThreshold", "reasoning", "chainOfThought",
  "prompt", "privateKey", "capability", "signature", "balance",
] as const;
