/**
 * Restrictive platform defaults the compiler applies where the user was not asked. Each one is
 * visible in the blueprint and can be changed by an explicit edit; none of them grants authority.
 */
export const KIDO_DEFAULTS = {
  /** Budget window the "if compromised for one hour" limit question refers to. */
  limitWindowSeconds: 3600,
  /** Lease lifetime before renewal within the same limits. */
  leaseLifetimeSeconds: 3600,
  /** Oldest data a monitor may act on. */
  dataMaxAgeMs: 60_000,
  /** Oldest data the security review tolerates for a deterministic action. */
  reviewMaxDataAgeMs: 300_000,
  maxRecoveryAttempts: 1,
  maxModelCallsPerHour: 30,
  /** Time a cross-chain intent may stay in flight before it enters recovery. */
  crossChainRecoveryDeadlineSeconds: 3600,
  /** Transport statuses acceptable for a planned bridge route. */
  transportStatuses: ["VERIFIED_LIVE", "MOCK_ONLY"] as string[],
  /**
   * Minimum debt reduction per unit spent that a REPAY must achieve, pinned into the policy. Interest
   * accrues between reading and repaying a debt, so an exact 1:1 would reject honest repayments.
   */
  repayMinReductionPerSpent: "0.9999",
  /** A health-factor rescue repays until HF reaches trigger threshold × this margin. */
  healthFactorTargetMargin: 1.2,
  /** Lifetime of a signed agent action before it expires. */
  actionTtlSeconds: 300,
  /** Knowledge every generated agent receives. */
  basePacks: ["platform/kido", "platform/actions"],
} as const;
