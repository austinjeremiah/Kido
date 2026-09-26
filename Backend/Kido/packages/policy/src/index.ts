/**
 * ContextLock deterministic policy decision function.
 *
 * This module is the decision logic that runs INSIDE the enclave in `workflow.ts`.
 *
 * What is and is not confidential here matters, and the CRE docs are explicit about it:
 * a confidential workflow's binary — including this logic — is provided to the enclave by the
 * Workflow DON and is therefore NOT secret. What the enclave keeps confidential is the DATA this
 * logic computes over: Vault DON secrets, HTTP request/response payloads made from the enclave,
 * and intermediate values.
 *
 * So: this file is public on purpose. The private policy VALUES it reads are not.
 * ContextLock never claims its policy source code is hidden.
 *
 * The function is pure and deterministic: the enclave result is attested and verified by DON
 * consensus, so a non-deterministic decision would fail consensus.
 */

/** Verdicts. Deliberately three-valued: binary authorization is insufficient for autonomous finance. */
export type Verdict = "ALLOW" | "ESCALATE" | "DENY";

/** Reason codes are produced by THIS function, never by the AI agent. */
export const ReasonCode = {
  ALLOW_POLICY_MATCH: "ALLOW_POLICY_MATCH",

  DENY_AGENT_NOT_AUTHORIZED: "DENY_AGENT_NOT_AUTHORIZED",
  DENY_TARGET_NOT_ALLOWED: "DENY_TARGET_NOT_ALLOWED",
  DENY_ACTION_NOT_ALLOWED: "DENY_ACTION_NOT_ALLOWED",
  DENY_AMOUNT_TOO_HIGH: "DENY_AMOUNT_TOO_HIGH",
  DENY_CONTEXT_STALE: "DENY_CONTEXT_STALE",
  DENY_SLIPPAGE: "DENY_SLIPPAGE",
  DENY_VOLATILITY: "DENY_VOLATILITY",
  DENY_LIQUIDITY: "DENY_LIQUIDITY",
  DENY_POLICY_DISABLED: "DENY_POLICY_DISABLED",
  DENY_MALFORMED_CONTEXT: "DENY_MALFORMED_CONTEXT",

  ESCALATE_AMOUNT: "ESCALATE_AMOUNT",
  ESCALATE_RISK: "ESCALATE_RISK",
  ESCALATE_POLICY_RULE: "ESCALATE_POLICY_RULE",
} as const;
export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

/**
 * PRIVATE policy values. Released by the Vault DON into the attested enclave via
 * `runtime.getSecret()`. Never crosses back out through `usingTheDons()`; only a verdict and a
 * reason code do.
 */
export type PrivatePolicy = {
  policyId: string;
  policyVersion: number;
  enabled: boolean;

  /** Integer base units (6dp USDC-style). Never floats. */
  autoLimit: bigint;
  escalationLimit: bigint;

  maxSlippageBps: number;
  maxVolatilityBps: number;
  minLiquidity: bigint;

  targetEthAllocationBps: number;
  rebalanceDriftBps: number;

  minHealthFactorBps: number;
  targetHealthFactorBps: number;

  /** Deliberately opaque proprietary threshold. */
  proprietaryRiskThreshold: number;

  /** Canary used by CONF-001 to prove no confidential value escapes the boundary. */
  canary: string;

  allowedActionKinds: string[];
  allowedTargets: string[];
  authorizedAgentIdentityHashes: string[];
};

/**
 * The request being ruled on. Every transaction-identifying field here is DECODED FROM CALLDATA
 * by the caller, never taken from the agent's self-declared numbers (see P4.3 / CRE-014).
 */
export type EvaluationRequest = {
  requestHash: string;
  agentIdentityHash: string;
  ensNode: string;
  agent: string;
  chainId: number;
  target: string;
  value: bigint;
  calldataHash: string;
  selector: string;
  /** Decoded from calldata. */
  decodedRecipient: string;
  decodedAmount: bigint;
  intentHash: string;
  policyId: string;
  policyVersion: number;
  actionKind: string;
};

/** Live market/context values observed inside the enclave. */
export type MarketContext = {
  observedAtUnix: number;
  slippageBps: number;
  volatilityBps: number;
  liquidity: bigint;
  healthFactorBps: number;
};

export type PolicyDecision = {
  verdict: Verdict;
  reasonCode: ReasonCode;
  /** Non-secret, coarse risk band. Deliberately NOT the underlying thresholds. */
  riskBand: "LOW" | "MEDIUM" | "HIGH";
  /** Seconds this verdict stays valid. Short, because context cannot be re-observed later. */
  ttlSeconds: number;
};

/** Context older than this is refused outright. */
export const MAX_CONTEXT_AGE_SECONDS = 120;
export const DEFAULT_TTL_SECONDS = 60;

/**
 * Evaluate. Pure, total, and deterministic.
 *
 * Ordering is deliberate: structural authorization first (who/what/where), then amount, then live
 * market risk. A DENY for an unauthorized agent must not be masked by an ESCALATE for amount.
 */
export function evaluatePolicy(
  req: EvaluationRequest,
  policy: PrivatePolicy,
  ctx: MarketContext,
  nowUnix: number,
): PolicyDecision {
  const low = (s: string) => s.toLowerCase();

  if (!policy.enabled) {
    return { verdict: "DENY", reasonCode: ReasonCode.DENY_POLICY_DISABLED, riskBand: "HIGH", ttlSeconds: 0 };
  }

  // Malformed / nonsensical context fails CLOSED rather than being treated as benign (CRE-011).
  if (
    !Number.isFinite(ctx.slippageBps) || !Number.isFinite(ctx.volatilityBps) ||
    !Number.isFinite(ctx.healthFactorBps) || !Number.isFinite(ctx.observedAtUnix) ||
    ctx.slippageBps < 0 || ctx.volatilityBps < 0 || ctx.liquidity < 0n || ctx.healthFactorBps < 0
  ) {
    return { verdict: "DENY", reasonCode: ReasonCode.DENY_MALFORMED_CONTEXT, riskBand: "HIGH", ttlSeconds: 0 };
  }

  // Stale context cannot authorize a market-sensitive action.
  if (nowUnix - ctx.observedAtUnix > MAX_CONTEXT_AGE_SECONDS || ctx.observedAtUnix > nowUnix + 30) {
    return { verdict: "DENY", reasonCode: ReasonCode.DENY_CONTEXT_STALE, riskBand: "HIGH", ttlSeconds: 0 };
  }

  if (!policy.authorizedAgentIdentityHashes.map(low).includes(low(req.agentIdentityHash))) {
    return { verdict: "DENY", reasonCode: ReasonCode.DENY_AGENT_NOT_AUTHORIZED, riskBand: "HIGH", ttlSeconds: 0 };
  }
  if (!policy.allowedActionKinds.includes(req.actionKind)) {
    return { verdict: "DENY", reasonCode: ReasonCode.DENY_ACTION_NOT_ALLOWED, riskBand: "HIGH", ttlSeconds: 0 };
  }
  if (!policy.allowedTargets.map(low).includes(low(req.target))) {
    return { verdict: "DENY", reasonCode: ReasonCode.DENY_TARGET_NOT_ALLOWED, riskBand: "HIGH", ttlSeconds: 0 };
  }
  if (req.policyId !== policy.policyId || req.policyVersion !== policy.policyVersion) {
    // A verdict must never be issued against a policy version other than the one evaluated.
    return { verdict: "DENY", reasonCode: ReasonCode.DENY_POLICY_DISABLED, riskBand: "HIGH", ttlSeconds: 0 };
  }

  // Amount is the DECODED value, not anything the agent asserted.
  const amount = req.decodedAmount;

  if (amount > policy.escalationLimit) {
    return { verdict: "DENY", reasonCode: ReasonCode.DENY_AMOUNT_TOO_HIGH, riskBand: "HIGH", ttlSeconds: 0 };
  }

  // Market risk gates apply to autonomous execution.
  if (ctx.liquidity < policy.minLiquidity) {
    return { verdict: "DENY", reasonCode: ReasonCode.DENY_LIQUIDITY, riskBand: "HIGH", ttlSeconds: 0 };
  }
  if (ctx.slippageBps > policy.maxSlippageBps) {
    return { verdict: "DENY", reasonCode: ReasonCode.DENY_SLIPPAGE, riskBand: "HIGH", ttlSeconds: 0 };
  }
  if (ctx.volatilityBps > policy.maxVolatilityBps) {
    // Volatile but structurally permitted: a human may still decide to proceed.
    return { verdict: "ESCALATE", reasonCode: ReasonCode.ESCALATE_RISK, riskBand: "HIGH", ttlSeconds: DEFAULT_TTL_SECONDS };
  }
  if (ctx.healthFactorBps > 0 && ctx.healthFactorBps < policy.minHealthFactorBps) {
    return { verdict: "ESCALATE", reasonCode: ReasonCode.ESCALATE_RISK, riskBand: "HIGH", ttlSeconds: DEFAULT_TTL_SECONDS };
  }

  if (amount > policy.autoLimit) {
    return { verdict: "ESCALATE", reasonCode: ReasonCode.ESCALATE_AMOUNT, riskBand: "MEDIUM", ttlSeconds: DEFAULT_TTL_SECONDS };
  }

  // Proprietary composite score. The threshold itself is confidential; only the band leaves.
  const risk = Math.floor(
    (ctx.slippageBps * 3 + ctx.volatilityBps) / 4 + Number(amount / (policy.autoLimit > 0n ? policy.autoLimit : 1n)) * 10,
  );
  if (risk > policy.proprietaryRiskThreshold) {
    return { verdict: "ESCALATE", reasonCode: ReasonCode.ESCALATE_POLICY_RULE, riskBand: "MEDIUM", ttlSeconds: DEFAULT_TTL_SECONDS };
  }

  return { verdict: "ALLOW", reasonCode: ReasonCode.ALLOW_POLICY_MATCH, riskBand: "LOW", ttlSeconds: DEFAULT_TTL_SECONDS };
}

/** Numeric encoding for the on-chain authorization registry enum. */
export function verdictToUint(v: Verdict): number {
  return v === "ALLOW" ? 1 : v === "ESCALATE" ? 2 : 3;
}
