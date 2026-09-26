/**
 * Central Studio configuration.
 *
 * Every limit, model name and price lives here. The Bible's instruction not to scatter magic
 * numbers is not a tidiness preference: a quota enforced in three places is a quota with three
 * different values the first time someone edits one of them, and the failure is silent.
 */

/** The only model the Studio uses. Set explicitly on every agent; never inherited from a default. */
export const STUDIO_MODEL = "gpt-5.6-luna" as const;

/**
 * Per-role reasoning effort. Starting points from the Bible, to be benchmarked rather than assumed
 * optimal. The security-relevant roles get more, because a cheap wrong answer from the Security
 * Architect is the expensive kind of wrong.
 */
export const ROLE_REASONING = {
  supervisor: "low",
  requirements: "low",
  architecture: "low",
  security: "medium",
  builder: "medium",
  repair: "medium",
  reviewer: "low",
} as const;
export type StudioRole = keyof typeof ROLE_REASONING;

/** Bounded agent loops. An unbounded loop is an unbounded bill. */
export const MAX_TURNS: Record<StudioRole, number> = {
  supervisor: 4,
  requirements: 3,
  architecture: 4,
  security: 4,
  builder: 24,
  repair: 12,
  reviewer: 3,
};

export interface StudioQuotaPolicy {
  /**
   * New builds a user may start in a rolling 24 hours, or null for no daily cap.
   *
   * Null by default: the cap rationed model spend during the phases that needed it, and it also
   * meant a user testing the product could be locked out for a day by three quick iterations.
   * Everything else here still bounds what a single build can cost.
   */
  newBuildsPerRollingDay: number | null;
  concurrentBuilds: number;
  modelRequestsPerBuild: number;
  inputTokensPerBuild: number;
  outputTokensPerBuild: number;
  autoRepairLoops: number;
  /**
   * Simulations the USER explicitly asks for — re-running a scenario to explore a design.
   *
   * The mandatory security suite is deliberately NOT charged here. Charging it made a rebuild after
   * a Blueprint edit silently incomplete (FND-V2-005): a 17-scenario Blueprint consumed 17 of 20 on
   * its first pass, leaving 3 for every rebuild — and the scenarios that got dropped were the ones
   * at the end of the list, which is where the attack and private-context cases live.
   *
   * Security verification is not a metered feature. If the design changes, everything that proves
   * the design gets re-run.
   */
  userRequestedSimulationsPerBuild: number;
  /**
   * Hard ceiling on ONE mandatory pass. Not a budget the user spends — a bound so an adapter with a
   * pathological scenario list cannot turn a build into an unbounded loop. The real constraints are
   * sandbox wall clock, build lifetime and the repair-cycle limit; this is the backstop.
   */
  maxMandatorySimulationsPerPass: number;
  /** Ceiling on mandatory passes per build: initial + one per repair cycle, plus a small margin. */
  maxMandatoryPassesPerBuild: number;
  sandboxWallClockMs: number;
  generatedFiles: number;
  exportBytes: number;
  /**
   * Held back from the token budget before starting any model call, so a build cannot spend its
   * last tokens beginning a turn it has no budget to finish. A half-written file is worse than a
   * refused one.
   */
  reservedOutputTokensPerRequest: number;
  buildCreationCooldownMs: number;
  promptInteractionsPerMinute: number;
  warnAtFraction: number;
}

export const STANDARD_QUOTA: StudioQuotaPolicy = {
  newBuildsPerRollingDay: null,
  concurrentBuilds: 1,
  modelRequestsPerBuild: 60,
  inputTokensPerBuild: 600_000,
  outputTokensPerBuild: 100_000,
  autoRepairLoops: 3,
  userRequestedSimulationsPerBuild: 20,
  maxMandatorySimulationsPerPass: 200,
  maxMandatoryPassesPerBuild: 8,
  sandboxWallClockMs: 30 * 60 * 1000,
  generatedFiles: 250,
  exportBytes: 100 * 1024 * 1024,
  reservedOutputTokensPerRequest: 4_000,
  buildCreationCooldownMs: 30_000,
  promptInteractionsPerMinute: 10,
  warnAtFraction: 0.8,
};

/**
 * No quotas: a local operator running their own Studio on their own machine.
 *
 * Every count-based limit is lifted; what stays is the sandbox wall clock, which bounds a runaway
 * build rather than a user. Selected with `STUDIO_QUOTAS=off`. Large finite numbers rather than
 * Infinity so the policy still serialises on the health route.
 */
const NO_LIMIT = 1_000_000_000;
export const UNLIMITED_QUOTA: StudioQuotaPolicy = {
  ...STANDARD_QUOTA,
  newBuildsPerRollingDay: null,
  concurrentBuilds: NO_LIMIT,
  modelRequestsPerBuild: NO_LIMIT,
  inputTokensPerBuild: NO_LIMIT,
  outputTokensPerBuild: NO_LIMIT,
  autoRepairLoops: NO_LIMIT,
  userRequestedSimulationsPerBuild: NO_LIMIT,
  maxMandatorySimulationsPerPass: NO_LIMIT,
  maxMandatoryPassesPerBuild: NO_LIMIT,
  generatedFiles: NO_LIMIT,
  exportBytes: NO_LIMIT,
  buildCreationCooldownMs: 0,
  promptInteractionsPerMinute: NO_LIMIT,
};

/** The policy in force: `STUDIO_QUOTAS=off` lifts every count-based limit. */
export const QUOTAS_ENABLED = (process.env.STUDIO_QUOTAS ?? "on").toLowerCase() !== "off";
export const DEFAULT_QUOTA: StudioQuotaPolicy = QUOTAS_ENABLED ? STANDARD_QUOTA : UNLIMITED_QUOTA;

/**
 * Pricing for cost telemetry only. Deliberately separate from the quota: tokens are the thing
 * enforced, money is the thing displayed. Conflating them means a price change silently changes
 * what users are allowed to do.
 */
export const MODEL_PRICING: Record<string, { inputPerMTokUsd: number; outputPerMTokUsd: number; asOf: string }> = {
  "gpt-5.6-luna": { inputPerMTokUsd: 1.25, outputPerMTokUsd: 10.0, asOf: "2026-09-08" },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = MODEL_PRICING[model];
  if (!p) return null;
  return (inputTokens / 1e6) * p.inputPerMTokUsd + (outputTokens / 1e6) * p.outputPerMTokUsd;
}

export const SANDBOX = {
  provider: (process.env.STUDIO_SANDBOX_PROVIDER ?? "docker") as "docker",
  /**
   * Pre-provisioned image. Dependencies are baked in on the host so the build sandbox never needs
   * the network — see FND-V2-003.
   */
  image: process.env.STUDIO_SANDBOX_IMAGE ?? "contextlock-studio-sandbox:node22",
  baseImage: "node:22-bookworm-slim",
  /** Not configurable. The whole generated-code lifecycle runs with no network. */
  networkMode: "none" as const,
  workspaceRoot: "/workspace",
};

export const SERVER = {
  port: Number(process.env.STUDIO_PORT ?? 4310),
  host: "127.0.0.1",
  dbUrl: process.env.STUDIO_DB_URL ?? "file:./studio.db",
};
