import type { Address, Hex } from "viem";
import { encodeDeployData, type Abi } from "viem";
import type { ChainReader } from "./chain.js";
import type { StepCost } from "./plan.js";
import type { RequiredBalance, RequiredBalanceCategory } from "./manifest.js";

/**
 * The deployment cost estimator.
 *
 * §1.6 of the addendum is a single instruction: costs are CALCULATED, never guessed by the model.
 * A language model asked "roughly how much gas does deploying this cost?" will produce a plausible
 * number, and a plausible number is worse than no number, because the user will fund against it.
 *
 * So every figure here comes from a node:
 *
 *     simulate  ->  estimate gas  ->  read current fees  ->  multiply  ->  add a labelled buffer
 *
 * Three things are kept deliberately separate, because collapsing them is how estimates become
 * lies:
 *
 *   ESTIMATE vs BUFFER. `eth_estimateGas` is an estimate; the 20% is our uncertainty, not the
 *   node's. Adding them into one number presents a guess with the authority of a measurement.
 *
 *   COST vs CAPITAL. Gas is a fee. 500 test USDC is the money the agent will operate on. §22.6
 *   exists because a screen that totals them has told the user their capital is a cost.
 *
 *   NOW vs THEN. Fees move. Every quote carries the moment it was taken and expires.
 */

/** The default safety buffer, in basis points. Configurable; 2000 bps = 20%, per §1.6. */
export const DEFAULT_BUFFER_BPS = 2000;

/**
 * How long a fee quote may be shown as current.
 *
 * Two minutes. Long enough for a person to read an approval screen, short enough that the number
 * they approve is the number that will be charged. Beyond it the estimate is STALE and the plan
 * cannot be approved until it is refreshed (DEP-PRE-024).
 */
export const FEE_QUOTE_TTL_MS = 120_000;

export const COST_REASONS = {
  STALE_QUOTE: "COST-QUOTE-STALE",
  NO_FEE_DATA: "COST-NO-FEE-DATA",
  ESTIMATE_FAILED: "COST-GAS-ESTIMATE-FAILED",
  INSUFFICIENT_BALANCE: "COST-INSUFFICIENT-BALANCE",
  NOT_LIVE: "COST-ESTIMATE-NOT-FROM-LIVE-NODE",
} as const;
export type CostReason = (typeof COST_REASONS)[keyof typeof COST_REASONS];

export class CostError extends Error {
  constructor(readonly reason: CostReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "CostError";
  }
}

export interface FeeQuote {
  chainId: number;
  mode: "EIP1559" | "LEGACY";
  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint | null;
  quotedAtMs: number;
  fromLiveNode: boolean;
}

export async function quoteFees(reader: ChainReader, now: () => number = Date.now): Promise<FeeQuote> {
  const f = await reader.estimateFeesPerGas();
  if (f.maxFeePerGas !== undefined && f.maxFeePerGas > 0n) {
    return {
      chainId: reader.chainId,
      mode: "EIP1559",
      maxFeePerGasWei: f.maxFeePerGas,
      maxPriorityFeePerGasWei: f.maxPriorityFeePerGas ?? null,
      quotedAtMs: now(),
      fromLiveNode: reader.live,
    };
  }
  if (f.gasPrice !== undefined && f.gasPrice > 0n) {
    return {
      chainId: reader.chainId,
      mode: "LEGACY",
      maxFeePerGasWei: f.gasPrice,
      maxPriorityFeePerGasWei: null,
      quotedAtMs: now(),
      fromLiveNode: reader.live,
    };
  }
  // Refusing beats substituting a default. A hard-coded fallback gas price is a number that will be
  // wrong on exactly the day the network is congested and the user most needs it to be right.
  throw new CostError(COST_REASONS.NO_FEE_DATA, `chain ${reader.chainId} returned no usable fee data`);
}

export const quoteIsStale = (q: { quotedAtMs: number }, now = Date.now(), ttlMs = FEE_QUOTE_TTL_MS): boolean =>
  now - q.quotedAtMs > ttlMs;

/** Combine a gas estimate and a fee quote into the step cost the plan carries. */
export function costFrom(estimatedGas: bigint, quote: FeeQuote, bufferBps = DEFAULT_BUFFER_BPS): StepCost {
  const base = estimatedGas * quote.maxFeePerGasWei;
  // Integer arithmetic throughout. A float here would round wei, and rounding a funding requirement
  // downward is the direction that fails at the worst moment.
  const buffer = (base * BigInt(bufferBps)) / 10_000n;
  return {
    estimatedGas: estimatedGas.toString(),
    feeMode: quote.mode,
    maxFeePerGasWei: quote.maxFeePerGasWei.toString(),
    maxPriorityFeePerGasWei: quote.maxPriorityFeePerGasWei?.toString() ?? null,
    baseNativeWei: base.toString(),
    bufferBps,
    bufferNativeWei: buffer.toString(),
    totalNativeWei: (base + buffer).toString(),
    quotedAtMs: quote.quotedAtMs,
    fromLiveNode: quote.fromLiveNode,
  };
}

/**
 * Estimate a contract CREATION.
 *
 * From the actual creation bytecode and the actual constructor arguments, per §1.6 — not from a
 * table of typical deployment costs. Constructor arguments change the cost materially (storage
 * writes in a constructor are the expensive kind), so an estimate that ignores them is an estimate
 * of a different deployment.
 */
export async function estimateContractCreation(
  reader: ChainReader,
  args: { from: Address; abi: Abi; bytecode: Hex; args?: readonly unknown[] },
  now: () => number = Date.now,
  bufferBps = DEFAULT_BUFFER_BPS,
): Promise<{ cost: StepCost; calldata: Hex }> {
  const data = encodeDeployData({ abi: args.abi, bytecode: args.bytecode, args: args.args ?? [] } as never);
  let gas: bigint;
  try {
    gas = await reader.estimateGas({ from: args.from, data });
  } catch (e) {
    throw new CostError(COST_REASONS.ESTIMATE_FAILED, `contract creation: ${(e as Error).message}`);
  }
  const quote = await quoteFees(reader, now);
  return { cost: costFrom(gas, quote, bufferBps), calldata: data };
}

/**
 * Estimate a CONFIGURATION write, simulating it first.
 *
 * The static call is not an optimization. A configuration transaction that reverts costs gas and
 * changes nothing, and the revert reason is far more useful before signing than after — so the
 * simulation runs first and its failure is reported as the step that would fail, by name
 * (DEP-PRE-007).
 */
export async function estimateConfigurationWrite(
  reader: ChainReader,
  args: { from: Address; to: Address; data: Hex; value?: bigint },
  now: () => number = Date.now,
  bufferBps = DEFAULT_BUFFER_BPS,
): Promise<{ cost: StepCost; simulated: true }> {
  try {
    await reader.call({ from: args.from, to: args.to, data: args.data, ...(args.value !== undefined ? { value: args.value } : {}) });
  } catch (e) {
    throw new CostError(COST_REASONS.ESTIMATE_FAILED, `simulation reverted before estimating: ${(e as Error).message}`);
  }
  let gas: bigint;
  try {
    gas = await reader.estimateGas({ from: args.from, to: args.to, data: args.data, ...(args.value !== undefined ? { value: args.value } : {}) });
  } catch (e) {
    throw new CostError(COST_REASONS.ESTIMATE_FAILED, (e as Error).message);
  }
  const quote = await quoteFees(reader, now);
  return { cost: costFrom(gas, quote, bufferBps), simulated: true };
}

/* ──────────────────────────── per-chain aggregation ──────────────────────────── */

export interface ChainFunding {
  chainId: number;
  symbol: string;
  decimals: number;
  /** Sum of every step's unbuffered estimate on this chain. */
  baseWei: bigint;
  /** Sum of every step's buffer. Shown on its own line, never folded into the base. */
  bufferWei: bigint;
  /**
   * The configured buffer, in basis points.
   *
   * Carried rather than recomputed from the wei amounts. Dividing rounded integers back out gave
   * "19.99% safety buffer" for a 20% buffer on the first live run — a number that is wrong in a way
   * nobody would ever have questioned, which is the worst kind of wrong on a screen about money.
   * Null when steps on this chain disagree about the buffer, so a mixed aggregate cannot claim one.
   */
  bufferBps: number | null;
  /** base + buffer. What the user is told to have. */
  recommendedWei: bigint;
  holder: Address;
  balanceWei: bigint;
  sufficient: boolean;
  shortfallWei: bigint;
  quotedAtMs: number;
  fromLiveNode: boolean;
}

export function aggregateByChain(
  steps: Array<{ chainId: number | null; cost: StepCost | null }>,
  chainMeta: Map<number, { symbol: string; decimals: number; holder: Address }>,
  balances: Map<number, bigint>,
): ChainFunding[] {
  const acc = new Map<number, { base: bigint; buffer: bigint; quotedAtMs: number; live: boolean; bps: Set<number> }>();
  for (const s of steps) {
    if (s.chainId === null || s.cost === null) continue;
    const cur = acc.get(s.chainId) ?? { base: 0n, buffer: 0n, quotedAtMs: Number.MAX_SAFE_INTEGER, live: true, bps: new Set<number>() };
    cur.base += BigInt(s.cost.baseNativeWei);
    cur.buffer += BigInt(s.cost.bufferNativeWei);
    cur.bps.add(s.cost.bufferBps);
    // The OLDEST quote governs, so one refreshed step cannot make a stale aggregate look current.
    cur.quotedAtMs = Math.min(cur.quotedAtMs, s.cost.quotedAtMs);
    cur.live = cur.live && s.cost.fromLiveNode;
    acc.set(s.chainId, cur);
  }
  const out: ChainFunding[] = [];
  for (const [chainId, v] of acc) {
    const meta = chainMeta.get(chainId);
    if (!meta) continue;
    const balance = balances.get(chainId) ?? 0n;
    const recommended = v.base + v.buffer;
    out.push({
      chainId,
      symbol: meta.symbol,
      decimals: meta.decimals,
      baseWei: v.base,
      bufferWei: v.buffer,
      bufferBps: v.bps.size === 1 ? [...v.bps][0]! : null,
      recommendedWei: recommended,
      holder: meta.holder,
      balanceWei: balance,
      sufficient: balance >= recommended,
      shortfallWei: balance >= recommended ? 0n : recommended - balance,
      quotedAtMs: v.quotedAtMs,
      fromLiveNode: v.live,
    });
  }
  return out.sort((a, b) => a.chainId - b.chainId);
}

/**
 * The required-balance rows, categorized.
 *
 * Gas becomes NATIVE_GAS. Everything else — test tokens, CCIP fee tokens, treasury seed — arrives
 * from the strategy and keeps its own category and its own words. Nothing in this function can
 * produce a NATIVE_GAS row for a protocol asset, which is what makes §22.6 structural rather than
 * a UI convention.
 */
export function requiredBalancesFor(funding: ChainFunding[], operatingAssets: RequiredBalance[]): RequiredBalance[] {
  const gas: RequiredBalance[] = funding.map((f) => ({
    category: "NATIVE_GAS" as RequiredBalanceCategory,
    chainId: f.chainId,
    token: null,
    symbol: f.symbol,
    decimals: f.decimals,
    amount: f.recommendedWei.toString(),
    holder: f.holder,
    purpose: `Gas for this deployment's writes on chain ${f.chainId}${
      f.bufferBps === null ? " (steps used differing safety buffers)" : `, including a ${f.bufferBps / 100}% safety buffer`
    }. Spent as fees; not recoverable.`,
  }));
  for (const a of operatingAssets) {
    if (a.category === "NATIVE_GAS") {
      // The one thing callers must not be able to do. An operating asset labelled as gas would
      // appear on the deployment-fee line, which is the confusion §22.6 names explicitly.
      throw new CostError(
        COST_REASONS.ESTIMATE_FAILED,
        `operating asset "${a.symbol}" is categorized NATIVE_GAS; gas rows are derived from estimates, never supplied`,
      );
    }
  }
  return [...gas, ...operatingAssets];
}

/** Format wei for display. Never used in a calculation — the calculations are all integer. */
export function formatUnitsExact(wei: bigint, decimals: number, places = 6): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const d = BigInt(10) ** BigInt(decimals);
  const whole = v / d;
  const frac = (v % d).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/* ──────────────────────── operating and model forecasts ──────────────────────── */

/**
 * An ongoing execution-cost estimate.
 *
 * Marked as an OPERATING estimate and kept out of the deployment funding total, because it is a
 * different question: "what will this cost to run" is not "what must be in the wallet to deploy".
 * A range rather than a point, since per-action gas varies with state.
 */
export interface OperatingEstimate {
  actionTemplate: string;
  chainId: number;
  minGas: string;
  maxGas: string;
  source: "FORK_SIMULATION" | "OBSERVED_FIXTURE";
  note: string;
}

export interface ModelUsageForecast {
  model: string;
  expectedInvocationsPerDay: number;
  observedMedianInputTokens: number;
  observedMedianOutputTokens: number;
  projectedInputTokensPerDay: number;
  projectedOutputTokensPerDay: number;
  /** Null when no verified price is available. A displayed price nobody checked is not a price. */
  projectedCostUsdPerDay: number | null;
  /** Where the medians came from. An estimate whose provenance is unstated is a guess. */
  basis: string;
  /** Always true. Quotas are enforced server-side by the Model Gateway, not by this forecast. */
  advisoryOnly: true;
}

export function forecastModelUsage(args: {
  model: string;
  invocationsPerDay: number;
  medianInputTokens: number;
  medianOutputTokens: number;
  pricePerMInputUsd?: number;
  pricePerMOutputUsd?: number;
  basis: string;
}): ModelUsageForecast {
  const inTok = args.invocationsPerDay * args.medianInputTokens;
  const outTok = args.invocationsPerDay * args.medianOutputTokens;
  const cost =
    args.pricePerMInputUsd !== undefined && args.pricePerMOutputUsd !== undefined
      ? (inTok / 1e6) * args.pricePerMInputUsd + (outTok / 1e6) * args.pricePerMOutputUsd
      : null;
  return {
    model: args.model,
    expectedInvocationsPerDay: args.invocationsPerDay,
    observedMedianInputTokens: args.medianInputTokens,
    observedMedianOutputTokens: args.medianOutputTokens,
    projectedInputTokensPerDay: inTok,
    projectedOutputTokensPerDay: outTok,
    projectedCostUsdPerDay: cost,
    basis: args.basis,
    advisoryOnly: true,
  };
}

/**
 * The cost categories the approval screen must keep apart.
 *
 * §1.6: "Never collapse them into one misleading dollar number." Enumerated here so the UI cannot
 * invent a total across them without naming what it is totalling.
 */
export const COST_CATEGORIES = [
  "ONE_TIME_CHAIN_GAS",
  "PROTOCOL_TEST_ASSETS",
  "EXPECTED_AGENT_EXECUTION_GAS",
  "CRE_REGISTRY_COST",
  "CRE_RUNTIME_SPEND",
  "MODEL_TOKEN_USAGE",
  "CONTAINER_HOSTING_COST",
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];
