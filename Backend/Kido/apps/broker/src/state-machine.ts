/**
 * Capability-request state machine.
 *
 * Explicit rather than implicit because the audit trail is a product surface: a reviewer must be
 * able to reconstruct exactly how a request reached its outcome, and an invalid transition must be
 * a loud failure rather than a silently-accepted status field.
 */
export const RequestState = {
  RECEIVED: "RECEIVED",
  IDENTITY_VALIDATED: "IDENTITY_VALIDATED",
  POLICY_EVALUATING: "POLICY_EVALUATING",

  DENIED: "DENIED",
  ESCALATION_REQUIRED: "ESCALATION_REQUIRED",
  AUTHORIZED: "AUTHORIZED",

  CAPABILITY_ISSUED: "CAPABILITY_ISSUED",
  SUBMITTED: "SUBMITTED",

  EXECUTED: "EXECUTED",
  REVERTED: "REVERTED",
  EXPIRED: "EXPIRED",
  FAILED: "FAILED",
} as const;
export type RequestState = (typeof RequestState)[keyof typeof RequestState];

/**
 * Permitted transitions.
 *
 * Two properties worth noting:
 *  - DENIED is TERMINAL. There is no edge from DENIED to anything executable. A policy denial can
 *    never be walked forward into a capability, by any path, including human approval. That is the
 *    "Ledger must not turn DENY into ALLOW" rule expressed structurally rather than by convention.
 *  - ESCALATION_REQUIRED does NOT lead to CAPABILITY_ISSUED here. Phase 7 inserts the human
 *    approval states between them; until then an escalation simply cannot progress.
 */
const TRANSITIONS: Record<RequestState, readonly RequestState[]> = {
  RECEIVED: [RequestState.IDENTITY_VALIDATED, RequestState.DENIED, RequestState.FAILED],
  IDENTITY_VALIDATED: [RequestState.POLICY_EVALUATING, RequestState.DENIED, RequestState.FAILED],
  POLICY_EVALUATING: [
    RequestState.AUTHORIZED,
    RequestState.ESCALATION_REQUIRED,
    RequestState.DENIED,
    RequestState.FAILED,
  ],
  AUTHORIZED: [RequestState.CAPABILITY_ISSUED, RequestState.EXPIRED, RequestState.FAILED],
  ESCALATION_REQUIRED: [RequestState.EXPIRED, RequestState.FAILED],
  CAPABILITY_ISSUED: [RequestState.SUBMITTED, RequestState.EXPIRED],
  SUBMITTED: [RequestState.EXECUTED, RequestState.REVERTED],

  // Terminal.
  DENIED: [],
  EXECUTED: [],
  REVERTED: [],
  EXPIRED: [],
  FAILED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: RequestState,
    public readonly to: RequestState,
  ) {
    super(`Invalid request state transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: RequestState, to: RequestState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RequestState, to: RequestState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(s: RequestState): boolean {
  return TRANSITIONS[s].length === 0;
}

/** States from which a capability may exist and be executed. */
export function mayExecute(s: RequestState): boolean {
  return s === RequestState.CAPABILITY_ISSUED || s === RequestState.SUBMITTED;
}
