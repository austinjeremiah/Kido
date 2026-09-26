import type { ExecutionPlan } from "./schema.js";
import { planHash, stepHash } from "./hash.js";

/**
 * The cross-chain arrival registry.
 *
 * A CCIP message arriving on the destination chain is an OBSERVATION, not an instruction. The
 * dangerous architecture — the one this module exists to prevent — is a destination receiver that
 * treats an incoming message as authority to make a call. That turns any party who can get a
 * message delivered into a party who can move the treasury's money.
 *
 * So arrival is recorded here, checked against what the plan said should arrive, and only then does
 * the destination policy get asked whether the destination action may proceed:
 *
 *     CCIP arrival → arrival proof → ContextLock destination policy → step capability → action
 *
 * Nothing in this file authorizes anything. It answers one question — "did the thing the plan
 * expected actually arrive, exactly once?" — and answering it is not the same as saying yes.
 */

export const ARRIVAL_REASONS = {
  DUPLICATE: "XCHAIN-DUPLICATE-MESSAGE",
  WRONG_SOURCE_CHAIN: "XCHAIN-WRONG-SOURCE-CHAIN",
  WRONG_SENDER: "XCHAIN-WRONG-SENDER",
  WRONG_DESTINATION: "XCHAIN-WRONG-DESTINATION",
  WRONG_RECEIVER: "XCHAIN-WRONG-RECEIVER",
  TOKEN_MISMATCH: "XCHAIN-TOKEN-MISMATCH",
  AMOUNT_MISMATCH: "XCHAIN-AMOUNT-MISMATCH",
  UNKNOWN_PLAN: "XCHAIN-UNKNOWN-PLAN",
  UNKNOWN_STEP: "XCHAIN-UNKNOWN-STEP",
  STEP_HASH_MISMATCH: "XCHAIN-STEP-HASH-MISMATCH",
  DEPENDENCY_NOT_SATISFIED: "XCHAIN-DEPENDENCY-NOT-SATISFIED",
} as const;
export type ArrivalReason = (typeof ARRIVAL_REASONS)[keyof typeof ARRIVAL_REASONS];

/** What the destination expects, derived from the plan before anything is sent. */
export interface ArrivalExpectation {
  planHash: `0x${string}`;
  stepId: string;
  stepHash: `0x${string}`;
  sourceChainId: number;
  /** Decimal uint64 as a string. Never a JS number: selectors exceed 2^53. */
  sourceChainSelector: string;
  sender: string;
  destinationChainId: number;
  receiver: string;
  token: string;
  amount: string;
}

/** What actually turned up, as observed on the destination chain. */
export interface ObservedArrival {
  messageId: string;
  planHash: string;
  stepId: string;
  stepHash: string;
  sourceChainSelector: string;
  sender: string;
  destinationChainId: number;
  receiver: string;
  token: string;
  amount: string;
}

export type ArrivalOutcome =
  | { accepted: true; messageId: string }
  | { accepted: false; reason: ArrivalReason; detail: Record<string, unknown> };

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class ArrivalRegistry {
  /** messageId → the expectation it satisfied. Presence is what makes a replay detectable. */
  private readonly seen = new Map<string, { planHash: string; stepId: string }>();

  /**
   * Derive what should arrive for a step, from the plan itself.
   *
   * Taking the expectation from the plan rather than from the message is the whole point: a message
   * that describes itself is a message that can lie about itself.
   */
  static expectationFor(
    plan: ExecutionPlan,
    stepId: string,
    wire: { sourceChainSelector: string; sender: string; destinationChainId: number; receiver: string; token: string; amount: string },
  ): ArrivalExpectation {
    return {
      planHash: planHash(plan),
      stepId,
      stepHash: stepHash(plan, stepId),
      sourceChainId: plan.sourceChainId,
      ...wire,
    };
  }

  has(messageId: string): boolean {
    return this.seen.has(messageId);
  }

  /**
   * Record an arrival, or refuse it with an exact reason.
   *
   * Order matters. Replay is checked FIRST, before any field comparison: a duplicate of a message
   * that was valid the first time is valid on every field, so a check that ran the comparisons
   * first would find nothing wrong with it.
   */
  record(expected: ArrivalExpectation, observed: ObservedArrival): ArrivalOutcome {
    if (this.seen.has(observed.messageId)) {
      const first = this.seen.get(observed.messageId)!;
      return {
        accepted: false,
        reason: ARRIVAL_REASONS.DUPLICATE,
        detail: { messageId: observed.messageId, firstSeenFor: first },
      };
    }

    if (observed.planHash !== expected.planHash) {
      return { accepted: false, reason: ARRIVAL_REASONS.UNKNOWN_PLAN, detail: { expected: expected.planHash, observed: observed.planHash } };
    }
    if (observed.stepId !== expected.stepId) {
      return { accepted: false, reason: ARRIVAL_REASONS.UNKNOWN_STEP, detail: { expected: expected.stepId, observed: observed.stepId } };
    }
    if (observed.stepHash !== expected.stepHash) {
      // Same plan and step id, different step content: the plan changed after this was sent.
      return { accepted: false, reason: ARRIVAL_REASONS.STEP_HASH_MISMATCH, detail: { expected: expected.stepHash, observed: observed.stepHash } };
    }
    // String comparison, never numeric. A uint64 selector loses precision as a JS number, and two
    // different chains can round to the same value — the exact confusion P19.11 is about.
    if (observed.sourceChainSelector !== expected.sourceChainSelector) {
      return { accepted: false, reason: ARRIVAL_REASONS.WRONG_SOURCE_CHAIN, detail: { expected: expected.sourceChainSelector, observed: observed.sourceChainSelector } };
    }
    if (!eq(observed.sender, expected.sender)) {
      return { accepted: false, reason: ARRIVAL_REASONS.WRONG_SENDER, detail: { expected: expected.sender, observed: observed.sender } };
    }
    if (observed.destinationChainId !== expected.destinationChainId) {
      return { accepted: false, reason: ARRIVAL_REASONS.WRONG_DESTINATION, detail: { expected: expected.destinationChainId, observed: observed.destinationChainId } };
    }
    if (!eq(observed.receiver, expected.receiver)) {
      return { accepted: false, reason: ARRIVAL_REASONS.WRONG_RECEIVER, detail: { expected: expected.receiver, observed: observed.receiver } };
    }
    if (!eq(observed.token, expected.token)) {
      return { accepted: false, reason: ARRIVAL_REASONS.TOKEN_MISMATCH, detail: { expected: expected.token, observed: observed.token } };
    }
    if (observed.amount !== expected.amount) {
      return { accepted: false, reason: ARRIVAL_REASONS.AMOUNT_MISMATCH, detail: { expected: expected.amount, observed: observed.amount } };
    }

    this.seen.set(observed.messageId, { planHash: observed.planHash, stepId: observed.stepId });
    return { accepted: true, messageId: observed.messageId };
  }
}
