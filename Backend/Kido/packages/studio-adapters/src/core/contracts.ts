import type { ContextLockAdapterManifest } from "./manifest.js";
import type { DataObservation } from "./observation.js";

/**
 * Adapter contracts.
 *
 * Execution and data adapters are separate interfaces because they carry different risk. Merging
 * them would produce one `run()` that sometimes returns a number and sometimes returns something a
 * relayer will broadcast.
 */

export interface ValidationProblem {
  code: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  field: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  problems: ValidationProblem[];
}

export const valid = (): ValidationResult => ({ ok: true, problems: [] });
export const invalid = (problems: ValidationProblem[]): ValidationResult => ({ ok: false, problems });

/* ─────────────────────────────── execution ────────────────────────────────── */

/** A movement of value, expressed independently of any provider's response shape. */
export interface AssetFlow {
  token: string;
  /** Integer base units, as a string. */
  amount: string;
  from?: string;
  to?: string;
}

export interface AllowanceChange {
  token: string;
  spender: string;
  amount: string;
  /** True when the amount is unbounded — the shape a policy is most likely to forbid. */
  unlimited: boolean;
}

/**
 * The security-relevant view of a transaction, re-derived by ContextLock.
 *
 * Every field here is something a policy might need to rule on, expressed the same way regardless of
 * which provider produced the transaction. That uniformity is the point: a policy says "the
 * recipient must be the treasury", not "the `swapper` field of the Uniswap response must be...".
 */
export interface NormalizedAction {
  chainId: number;
  target: string;
  calldata: string;
  value: string;
  actionType: string;
  inputs: AssetFlow[];
  outputs: AssetFlow[];
  recipient?: string;
  spender?: string;
  allowanceChanges: AllowanceChange[];
  minOutputs: Array<{ token: string; amount: string }>;
  deadline?: string;
  /** Provider-specific extras. Explicitly NOT consulted by any policy check. */
  providerMetadata: Record<string, unknown>;
}

export interface AdapterExecutionContext {
  chainId: number;
  /** The account the agent operates on behalf of. Never supplied by the agent itself. */
  owner: string;
  nowMs: number;
  observations?: DataObservation[];
}

/**
 * @template TIntent   what the agent asks for
 * @template TPrepared whatever the provider hands back — assumed hostile
 */
export interface ExecutionAdapter<TIntent = unknown, TPrepared = unknown> {
  manifest(): ContextLockAdapterManifest;

  supportedActions(): string[];

  /** Reject a malformed or out-of-scope intent before any provider is contacted. */
  normalizeIntent(intent: unknown): { ok: true; intent: TIntent } | { ok: false; problems: ValidationProblem[] };

  /**
   * Ask the provider to construct the action.
   *
   * The result is NOT authorization. It is an untrusted proposal from a third party, and nothing
   * downstream may act on it until `decodeTransaction` and `validateTransaction` have both run.
   */
  buildTransaction(intent: TIntent, ctx: AdapterExecutionContext): Promise<TPrepared>;

  /**
   * Re-derive the security-relevant fields from the calldata itself.
   *
   * Deliberately does not read the provider's own summary of what it built. A provider that wanted
   * to mislead would produce a benign summary alongside hostile calldata, and reading the summary
   * would defeat the entire exercise.
   */
  decodeTransaction(prepared: TPrepared): Promise<NormalizedAction>;

  /** Compare the decoded action against the intent and the Blueprint's constraints. */
  validateTransaction(
    normalized: NormalizedAction,
    intent: TIntent,
    constraints: ExecutionConstraints,
  ): ValidationResult;

  createSimulationFixtures(): AdapterSimulationFixture[];

  generateTemplateConfig(): Record<string, unknown>;
}

/** What the Blueprint permits. Passed in rather than read, so an adapter cannot widen its own limits. */
export interface ExecutionConstraints {
  chainId: number;
  allowedTargets: string[];
  allowedRecipients: string[] | "self-only";
  owner: string;
  maxSlippageBps?: number;
  allowUnlimitedApprovals: boolean;
  maxApprovalAmount?: string;
  /** Quotes older than this are refused: a stale route prices a market that has moved. */
  maxQuoteAgeMs: number;
}

/* ──────────────────────────────── data ────────────────────────────────────── */

export interface DataReadContext {
  chainId: number;
  nowMs: number;
  subject?: string;
}

export interface DataAdapter<TQuery = unknown, TRaw = unknown> {
  manifest(): ContextLockAdapterManifest;

  /** Reject a query before it is sent. Templates only where injection is possible. */
  validateQuery(query: unknown): { ok: true; query: TQuery } | { ok: false; problems: ValidationProblem[] };

  fetch(query: TQuery, ctx: DataReadContext): Promise<TRaw>;

  /** Raw provider response → a single typed observation. Throws on a shape it does not recognise. */
  normalize(raw: TRaw, query: TQuery, ctx: DataReadContext): DataObservation;

  /** Post-normalization checks the adapter itself can make (units, ranges, block lag). */
  validate(observation: DataObservation, ctx: DataReadContext): ValidationResult;

  provenance(raw: TRaw, ctx: DataReadContext): DataObservation["provenance"];

  createSimulationFixtures(): AdapterSimulationFixture[];

  /**
   * The query the adapter's own fixtures should be evaluated with.
   *
   * Required because query shapes differ per adapter — a feed takes a dataKind, a subgraph takes a
   * template id and bound variables. A harness that guessed the shape would fail every adapter
   * whose shape it guessed wrong, and the failure would look like the adapter rejecting its own
   * happy-path fixture.
   */
  fixtureQuery(): TQuery;

  generateTemplateConfig(): Record<string, unknown>;
}

/* ─────────────────────────────── simulation ───────────────────────────────── */

/**
 * A deterministic fixture an adapter contributes to the mandatory security pass.
 *
 * Adapters own their own failure modes. The simulation engine does not contain a list of things
 * that can go wrong with Uniswap — the Uniswap adapter does, which is what stops the engine from
 * accumulating provider-specific branches.
 */
export interface AdapterSimulationFixture {
  scenarioId: string;
  description: string;
  /** What the provider returns in this scenario — including malformed and hostile responses. */
  providerResponse: unknown;
  expected:
    | { outcome: "ACCEPTED" }
    | { outcome: "REJECTED"; reasonCodeMatches: string };
}
