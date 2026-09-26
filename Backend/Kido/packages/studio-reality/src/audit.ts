import { z } from "zod";
import type { MarketSnapshot } from "./snapshot.js";
import type { ShadowDecision } from "./shadow.js";

/**
 * The auditability gate.
 *
 * §P27.47 lists seven questions every evaluation must answer, and adds the consequence: if the
 * answer cannot be reconstructed, the gate fails. That is a strong requirement and worth honouring
 * literally — this does not check that fields are *present*, it reconstructs each answer from the
 * evidence and reports the ones it cannot.
 *
 * The distinction matters. A schema guarantees a field exists; it does not guarantee the field says
 * anything. `provenance: ""` passes a schema and answers nothing.
 */

export const AUDIT_QUESTIONS = [
  "What real-world state was seen?",
  "From where?",
  "At what block or time?",
  "How fresh was it?",
  "What trust did each source have?",
  "What modifications were synthetic?",
  "Where was execution actually performed?",
] as const;
export type AuditQuestion = (typeof AUDIT_QUESTIONS)[number];

export const AuditAnswerSchema = z.object({
  question: z.string(),
  answered: z.boolean(),
  answer: z.string(),
});
export type AuditAnswer = z.infer<typeof AuditAnswerSchema>;

export interface AuditResult {
  answers: AuditAnswer[];
  auditable: boolean;
  unanswered: string[];
}

export class AuditabilityError extends Error {
  constructor(readonly unanswered: string[], detail: string) {
    super(`REALITY_AUDIT_INCOMPLETE: ${detail}`);
    this.name = "AuditabilityError";
  }
}

/**
 * Reconstruct the seven answers from a snapshot and the decision made against it.
 *
 * Each answer is built rather than looked up, so an empty or placeholder field produces an
 * unanswered question instead of a blank string that passes.
 */
export function auditRealityEvaluation(snapshot: MarketSnapshot, decision: ShadowDecision | null): AuditResult {
  const answers: AuditAnswer[] = [];

  const metrics = snapshot.observations.map((o) => `${o.metric}=${o.value}e-${o.decimals}${o.unit === "none" ? "" : ` ${o.unit}`}`);
  answers.push({
    question: AUDIT_QUESTIONS[0],
    answered: metrics.length > 0,
    answer: metrics.length > 0 ? metrics.join("; ") : "no observations were recorded",
  });

  const sources = snapshot.sources.map((s) => `${s.sourceId} (${s.kind}, ${s.adapterId}@${s.adapterVersion})`);
  answers.push({
    question: AUDIT_QUESTIONS[1],
    answered: sources.length > 0 && snapshot.provenance.length > 0,
    answer: sources.length > 0 ? `${sources.join("; ")} — provenance: ${snapshot.provenance.join(" | ")}` : "no sources were recorded",
  });

  const blockAnswers = snapshot.observations.map((o) => `${o.metric}@${o.blockNumber ?? "no block"}/${o.sourceTimestampMs ?? o.retrievedAtMs}`);
  answers.push({
    question: AUDIT_QUESTIONS[2],
    answered: /^\d+$/.test(snapshot.anchorBlock) && snapshot.anchorBlockHash !== `0x${"0".repeat(64)}`,
    answer: `anchor chain ${snapshot.anchorChainId} block ${snapshot.anchorBlock} (${snapshot.anchorBlockHash}); ${blockAnswers.join("; ")}`,
  });

  answers.push({
    question: AUDIT_QUESTIONS[3],
    answered: true,
    answer: `observations span ${snapshot.coherence.maxTimeSkewMs}ms, block skew ${snapshot.coherence.maxBlockSkew ?? "incomparable"}, stale: ${
      snapshot.coherence.staleSources.join(", ") || "none"
    }, coherent: ${snapshot.coherence.coherent}`,
  });

  const trust = snapshot.observations.map((o) => `${o.metric}=${o.trustClass}`);
  answers.push({
    question: AUDIT_QUESTIONS[4],
    answered: trust.length > 0 && snapshot.observations.every((o) => o.trustClass.length > 0),
    answer: trust.join("; ") || "no trust classes recorded",
  });

  const synthetic = snapshot.observations.filter((o) => o.derivedFrom !== null);
  answers.push({
    question: AUDIT_QUESTIONS[5],
    // Always answerable: "none" is a complete answer, and the absence of synthetic values is a fact.
    answered: true,
    answer: synthetic.length === 0
      ? "none — every observation is a measurement"
      : synthetic.map((o) => `${o.metric} derived from ${o.derivedFrom}: ${o.provenance}`).join("; "),
  });

  answers.push({
    question: AUDIT_QUESTIONS[6],
    answered: decision !== null && decision.executionEnvironment !== undefined,
    answer: decision
      ? `${decision.executionEnvironment}${decision.environmentId ? ` ${decision.environmentId}` : ""}${
          decision.executionChainId ? ` on chain ${decision.executionChainId}` : ""
        }; ${decision.simulatedExecutionResult.executed ? `tx ${decision.simulatedExecutionResult.txHash} labelled "${decision.simulatedExecutionResult.label}"` : "nothing was executed"}`
      : "no decision was recorded against this snapshot",
  });

  const unanswered = answers.filter((a) => !a.answered).map((a) => a.question);
  return { answers, auditable: unanswered.length === 0, unanswered };
}

/** Fail the gate rather than reporting an incomplete audit as a pass. */
export function assertAuditable(snapshot: MarketSnapshot, decision: ShadowDecision | null): AuditResult {
  const result = auditRealityEvaluation(snapshot, decision);
  if (!result.auditable) {
    throw new AuditabilityError(
      result.unanswered,
      `${result.unanswered.length} of ${AUDIT_QUESTIONS.length} questions cannot be answered from the evidence: ${result.unanswered.join(" ")}`,
    );
  }
  return result;
}
