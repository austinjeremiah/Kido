/**
 * ContextLock reason-code taxonomy.
 *
 * The split that matters: a policy DENY is a SUCCESSFUL evaluation with a negative verdict.
 * An RPC timeout, a missing ENS interface or a Key Ring outage is an OPERATIONAL failure.
 * Collapsing the two would let an outage read as a decision — and, worse, would let a
 * fail-closed outage be mistaken for a considered allow. Keep them distinct everywhere.
 */
export const ReasonCode = {
  IDENTITY_NOT_FOUND: "CTX_IDENTITY_NOT_FOUND",
  IDENTITY_EXPIRED: "CTX_IDENTITY_EXPIRED",
  IDENTITY_REBOUND: "CTX_IDENTITY_REBOUND",
  IDENTITY_UNAVAILABLE: "CTX_IDENTITY_UNAVAILABLE",

  POLICY_DISABLED: "CTX_POLICY_DISABLED",
  POLICY_ACTION_DENIED: "CTX_POLICY_ACTION_DENIED",
  POLICY_TARGET_DENIED: "CTX_POLICY_TARGET_DENIED",
  POLICY_VALUE_EXCEEDS_CAP: "CTX_POLICY_VALUE_EXCEEDS_CAP",

  CRE_PENDING: "CTX_CRE_PENDING",
  CRE_DENIED: "CTX_CRE_DENIED",
  CRE_ESCALATE: "CTX_CRE_ESCALATE",
  CRE_STALE: "CTX_CRE_STALE",
  CRE_UNAVAILABLE: "CTX_CRE_UNAVAILABLE",

  CAP_BAD_SIG: "CTX_CAP_BAD_SIG",
  CAP_EXPIRED: "CTX_CAP_EXPIRED",
  CAP_NONCE_USED: "CTX_CAP_NONCE_USED",
  CAP_CALL_MISMATCH: "CTX_CAP_CALL_MISMATCH",

  LEDGER_REJECTED: "CTX_LEDGER_REJECTED",
  LEDGER_UNAVAILABLE: "CTX_LEDGER_UNAVAILABLE",

  CHAIN_RPC_FAILURE: "CTX_CHAIN_RPC_FAILURE",
  CHAIN_WRONG_NETWORK: "CTX_CHAIN_WRONG_NETWORK",

  INTERNAL_STORAGE: "CTX_INTERNAL_STORAGE",
  INTERNAL_INVARIANT: "CTX_INTERNAL_INVARIANT",

  API_VALIDATION: "CTX_API_VALIDATION",
  API_ARBITRARY_CALLDATA_REJECTED: "CTX_API_ARBITRARY_CALLDATA_REJECTED",
} as const;

export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

/** A policy decision. Not an error. */
export type Verdict = "ALLOW" | "ESCALATE" | "DENY";

/** Distinguishes "the system could not decide" from "the system decided no". */
export class OperationalError extends Error {
  constructor(
    public readonly code: ReasonCode,
    message: string,
    public readonly diagnosticId?: string,
  ) {
    super(message);
    this.name = "OperationalError";
  }
}

export class PolicyDenial extends Error {
  constructor(
    public readonly code: ReasonCode,
    message: string,
  ) {
    super(message);
    this.name = "PolicyDenial";
  }
}

export const SEPOLIA_CHAIN_ID = 11155111 as const;

/** Hard guard used by every script and provider that touches a network. */
export function assertSepolia(chainId: number | bigint): void {
  if (Number(chainId) !== SEPOLIA_CHAIN_ID) {
    throw new OperationalError(
      ReasonCode.CHAIN_WRONG_NETWORK,
      `Refusing to operate on chainId ${chainId}. ContextLock is Sepolia-only (${SEPOLIA_CHAIN_ID}).`,
    );
  }
}
