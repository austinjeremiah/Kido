import type { AmaneOutcome } from "@amane/sdk";
import type { EventDraft, EventType, EventSeverity } from "@contextlock/studio-events";

export interface ActionAuditContext {
  organizationId: string | null;
  projectId: string;
  deploymentId: string;
  agentId: string | null;
  correlationId: string;
  planHash: string;
  planStep: number;
  leaseId: string;
  nonce: string;
  adapterId: string;
  chainId: number | null;
  timestamp: number;
}

const EVM_TX = /^0x[0-9a-f]{64}$/;

/**
 * Maps one Amane outcome onto the audit vocabulary. The mapping never upgrades an outcome: a
 * consumed nonce is not a confirmation, and an operational failure is not a policy decision.
 */
export function toAuditDraft(outcome: AmaneOutcome, ctx: ActionAuditContext): EventDraft {
  const [type, severity, source]: [EventType, EventSeverity, EventDraft["source"]] =
    outcome.kind === "EXECUTED"
      ? ["ACTION_CONFIRMED", "INFO", "CHAIN"]
      : outcome.kind === "REJECTED_BY_AMANE"
        ? ["ACTION_REJECTED_BY_AMANE", "NOTICE", "AMANE"]
        : outcome.kind === "NONCE_CONSUMED"
          ? ["ACTION_NONCE_CONSUMED", "WARNING", "AMANE"]
          : ["EXECUTION_REVERTED", "ERROR", "SYSTEM"];
  const tx = "tx" in outcome ? outcome.tx : undefined;
  const lowerTx = tx?.toLowerCase();
  return {
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    deploymentId: ctx.deploymentId,
    agentId: ctx.agentId,
    source,
    type,
    severity,
    timestamp: ctx.timestamp,
    correlationId: ctx.correlationId,
    agentRunId: null,
    modelRunId: null,
    strategyEvaluationId: null,
    creExecutionId: null,
    authorizationId: ctx.leaseId,
    capabilityId: null,
    chainId: ctx.chainId,
    blockNumber: outcome.kind === "EXECUTED" && outcome.block ? outcome.block : null,
    txHash: lowerTx && EVM_TX.test(lowerTx) ? lowerTx : null,
    creWorkflowId: null,
    adapterId: ctx.adapterId,
    runtimeRevision: null,
    buildRevision: null,
    deploymentRevision: null,
    correctsEventId: null,
    publicMetadata: {
      chain: outcome.chain,
      outcome: outcome.kind,
      ...(outcome.kind === "REJECTED_BY_AMANE" ? { code: outcome.code } : {}),
      ...(outcome.kind === "OPERATIONAL_FAILURE" ? { operationalError: outcome.message.slice(0, 200) } : {}),
      ...(tx && !(lowerTx && EVM_TX.test(lowerTx)) ? { txDigest: tx } : {}),
      planHash: ctx.planHash,
      planStep: ctx.planStep,
      nonce: ctx.nonce,
      settlement: outcome.kind === "EXECUTED" ? "RECEIPT_CONFIRMED" : outcome.kind === "NONCE_CONSUMED" ? "VERIFY_FROM_CHAIN_EVENTS" : "NONE",
    },
  };
}
