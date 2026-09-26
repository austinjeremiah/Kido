import { z } from "zod";
import type { Address, Hex } from "viem";
import { classifyRpcError, RpcError, type ChainReader } from "@contextlock/studio-deploy";

/**
 * Transaction receipt certainty.
 *
 * The single most dangerous moment in a deployment is not a transaction that fails. It is a
 * transaction whose fate is unknown — the RPC accepted `eth_sendRawTransaction` and then the socket
 * timed out. At that instant the transaction may be in the mempool, mined, or nowhere, and the
 * three are indistinguishable from where the caller is standing.
 *
 * The wrong thing to do is retry. A retry after a successful send is a second deployment of the
 * same contract at a different address, or a second configuration write, or — with a nonce reused —
 * a replacement that silently drops the first.
 *
 * So an unknown send produces `UNKNOWN_SUBMISSION_STATE`, which is NOT a retryable state. It is
 * resolved by looking: by hash if a hash came back, and by sender+nonce if one did not, because a
 * nonce that has advanced is proof that SOMETHING was mined from that account.
 */

export const SUBMISSION_STATES = [
  "NOT_SUBMITTED",
  "SUBMITTED",
  /** Sent, fate unknown. Must be reconciled before anything else happens on this account. */
  "UNKNOWN_SUBMISSION_STATE",
  "MINED_SUCCESS",
  "MINED_REVERTED",
  /** Reconciled and definitively absent: the nonce did not advance, so nothing was mined. */
  "CONFIRMED_ABSENT",
] as const;
export const SubmissionStateSchema = z.enum(SUBMISSION_STATES);
export type SubmissionState = z.infer<typeof SubmissionStateSchema>;

export const TransactionRecordSchema = z.object({
  deploymentStepId: z.string().min(1),
  chainId: z.number().int().positive(),
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** The nonce we intended to use. The anchor for reconciliation when no hash came back. */
  nonce: z.number().int().nonnegative(),
  txHash: z.string().regex(/^0x[0-9a-f]{64}$/).nullable(),
  submittedAtMs: z.number().int().positive().nullable(),
  state: SubmissionStateSchema,
  blockNumber: z.string().regex(/^\d+$/).nullable(),
  confirmations: z.number().int().nonnegative(),
  contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullable(),
  /**
   * Actual cost, recorded ALONGSIDE the estimate rather than replacing it.
   *
   * DEP-024: keeping both is what lets anyone check whether the estimator is any good. Overwriting
   * the estimate with the actual would make the estimator permanently unfalsifiable.
   */
  gasUsed: z.string().regex(/^\d+$/).nullable(),
  effectiveGasPriceWei: z.string().regex(/^\d+$/).nullable(),
  actualNativeCostWei: z.string().regex(/^\d+$/).nullable(),
  estimatedNativeCostWei: z.string().regex(/^\d+$/).nullable(),
  /** Set when a transaction reverted, naming the step so an operator does not have to guess. */
  revertDetail: z.string().nullable(),
});
export type TransactionRecord = z.infer<typeof TransactionRecordSchema>;

export const RECEIPT_REASONS = {
  UNKNOWN_STATE: "TX-UNKNOWN-SUBMISSION-STATE",
  UNSAFE_RETRY: "TX-UNSAFE-RETRY",
  REVERTED: "TX-REVERTED",
  NOT_FINAL: "TX-NOT-FINAL",
} as const;
export type ReceiptReason = (typeof RECEIPT_REASONS)[keyof typeof RECEIPT_REASONS];

export class ReceiptError extends Error {
  constructor(readonly reason: ReceiptReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ReceiptError";
  }
}

/** How many confirmations make a testnet write final enough to depend on. */
export const DEFAULT_CONFIRMATIONS = 2;

export function newTransactionRecord(args: { deploymentStepId: string; chainId: number; from: Address; nonce: number; estimatedNativeCostWei: string | null }): TransactionRecord {
  return {
    deploymentStepId: args.deploymentStepId,
    chainId: args.chainId,
    from: args.from,
    nonce: args.nonce,
    txHash: null,
    submittedAtMs: null,
    state: "NOT_SUBMITTED",
    blockNumber: null,
    confirmations: 0,
    contractAddress: null,
    gasUsed: null,
    effectiveGasPriceWei: null,
    actualNativeCostWei: null,
    estimatedNativeCostWei: args.estimatedNativeCostWei,
    revertDetail: null,
  };
}

/**
 * A transaction may be retried only when we have PROVEN nothing was mined.
 *
 * The proof is a nonce that has not advanced past the one we intended. Not "we did not see a
 * receipt" — a receipt lookup can fail for the same reason the send did.
 */
export function assertSafeToRetry(record: TransactionRecord): void {
  if (record.state === "UNKNOWN_SUBMISSION_STATE") {
    throw new ReceiptError(
      RECEIPT_REASONS.UNSAFE_RETRY,
      `step "${record.deploymentStepId}" was sent and its outcome is unknown. Reconcile it against the chain (by hash${record.txHash ? ` ${record.txHash}` : ", or by sender+nonce"}) before resubmitting; retrying now risks a duplicate deployment.`,
    );
  }
  if (record.state === "MINED_SUCCESS") {
    throw new ReceiptError(RECEIPT_REASONS.UNSAFE_RETRY, `step "${record.deploymentStepId}" already succeeded in block ${record.blockNumber}`);
  }
}

/**
 * Record what happened to a send.
 *
 * A timeout or a rate-limit AFTER the request left is `UNKNOWN_SUBMISSION_STATE`. A transport error
 * that is definitely a refusal — a rejected signature, an invalid transaction — leaves the record
 * NOT_SUBMITTED, because nothing was accepted.
 */
export function recordSendOutcome(
  record: TransactionRecord,
  outcome: { txHash: Hex } | { error: unknown; definitelyRejected?: boolean },
  nowMs: number,
): TransactionRecord {
  if ("txHash" in outcome) {
    return { ...record, txHash: outcome.txHash.toLowerCase() as string, submittedAtMs: nowMs, state: "SUBMITTED" };
  }
  const err = outcome.error instanceof RpcError ? outcome.error : classifyRpcError(outcome.error);
  if (outcome.definitelyRejected) {
    return { ...record, state: "NOT_SUBMITTED", revertDetail: err.message };
  }
  // Everything else is unknown. Erring towards "unknown" costs one reconciliation query; erring the
  // other way costs a duplicate deployment.
  return { ...record, submittedAtMs: nowMs, state: "UNKNOWN_SUBMISSION_STATE", revertDetail: err.message };
}

/**
 * Reconcile an unknown submission against the chain.
 *
 * Two independent routes, tried in order:
 *
 *   BY HASH, when a hash came back. A receipt settles it.
 *
 *   BY SENDER+NONCE, when it did not. If the account's next nonce is still the one we intended, the
 *   transaction was never mined and it is now definitively safe to retry. If it has advanced,
 *   something WAS mined from this account and we must not send again — even though we cannot say
 *   which transaction it was, which is itself worth reporting rather than papering over.
 */
export async function reconcile(
  record: TransactionRecord,
  reader: ChainReader,
  nowMs: number,
): Promise<TransactionRecord> {
  if (record.txHash) {
    const receipt = await reader.getTransactionReceipt(record.txHash as Hex);
    if (receipt) {
      const head = await reader.getBlockNumber();
      const cost = receipt.gasUsed * receipt.effectiveGasPrice;
      return {
        ...record,
        state: receipt.status === "success" ? "MINED_SUCCESS" : "MINED_REVERTED",
        blockNumber: receipt.blockNumber.toString(),
        confirmations: Number(head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n),
        contractAddress: receipt.contractAddress,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
        actualNativeCostWei: cost.toString(),
        revertDetail: receipt.status === "reverted" ? `step "${record.deploymentStepId}" reverted in block ${receipt.blockNumber}` : null,
      };
    }
    // No receipt yet is not "absent". It may simply be pending, so the state does not move.
    return { ...record, state: "UNKNOWN_SUBMISSION_STATE", revertDetail: `no receipt for ${record.txHash} as of ${new Date(nowMs).toISOString()}` };
  }

  const next = await reader.getTransactionCount(record.from as Address);
  if (Number(next) <= record.nonce) {
    return { ...record, state: "CONFIRMED_ABSENT", revertDetail: `nonce ${record.nonce} is still unused on ${record.from}; nothing was mined` };
  }
  return {
    ...record,
    state: "UNKNOWN_SUBMISSION_STATE",
    revertDetail: `nonce ${record.nonce} has been consumed on ${record.from} (account is now at ${next}) but no transaction hash is known. A transaction WAS mined from this account; identify it before resubmitting.`,
  };
}

/**
 * Wait, bounded, for a receipt.
 *
 * A transaction is never mined at the instant it is sent, so reconciling once and immediately
 * treats every successful send as UNKNOWN_SUBMISSION_STATE. The first live deployment did exactly
 * that: it sent a contract creation, found no receipt a millisecond later, and marked itself
 * DEPLOYMENT_PARTIAL over a transaction that was about to succeed.
 *
 * The timeout does NOT change what an unresolved send means. When it expires the state is still
 * UNKNOWN_SUBMISSION_STATE and still not retryable — reconciliation by hash on the next resume is
 * how it gets settled. All the wait does is stop the orchestrator declaring uncertainty about
 * something that merely had not happened yet.
 */
export async function waitForReceipt(
  record: TransactionRecord,
  reader: ChainReader,
  opts: { timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TransactionRecord> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;

  let current = record;
  for (;;) {
    current = await reconcile(current, reader, now());
    if (current.state === "MINED_SUCCESS" || current.state === "MINED_REVERTED" || current.state === "CONFIRMED_ABSENT") return current;
    if (now() >= deadline) return current;
    await sleep(intervalMs);
  }
}

/**
 * Wait for a transaction to be buried, not merely mined.
 *
 * `isFinal` requires confirmations; this is how they are obtained. A step that depends on another
 * depends on state that a small reorganization must not take away.
 */
export async function waitForFinality(
  record: TransactionRecord,
  reader: ChainReader,
  confirmations = DEFAULT_CONFIRMATIONS,
  opts: { timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TransactionRecord> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;

  let current = await waitForReceipt(record, reader, opts);
  while (current.state === "MINED_SUCCESS" && current.confirmations < confirmations && now() < deadline) {
    await sleep(intervalMs);
    current = await reconcile(current, reader, now());
  }
  return current;
}

/** Final enough to depend on? Mined is not final; mined and buried is. */
export function isFinal(record: TransactionRecord, required = DEFAULT_CONFIRMATIONS): boolean {
  return record.state === "MINED_SUCCESS" && record.confirmations >= required;
}

export function assertMinedSuccessfully(record: TransactionRecord): void {
  if (record.state === "MINED_REVERTED") {
    throw new ReceiptError(
      RECEIPT_REASONS.REVERTED,
      record.revertDetail ?? `step "${record.deploymentStepId}" reverted`,
    );
  }
  if (record.state !== "MINED_SUCCESS") {
    throw new ReceiptError(RECEIPT_REASONS.NOT_FINAL, `step "${record.deploymentStepId}" is ${record.state}`);
  }
}

/** How wrong the estimate was. Reported, because an estimator nobody measures drifts. */
export function estimateAccuracy(record: TransactionRecord): { deltaWei: string; ratio: number } | null {
  if (!record.actualNativeCostWei || !record.estimatedNativeCostWei) return null;
  const actual = BigInt(record.actualNativeCostWei);
  const estimated = BigInt(record.estimatedNativeCostWei);
  return {
    deltaWei: (actual - estimated).toString(),
    ratio: estimated === 0n ? 0 : Number((actual * 10_000n) / estimated) / 10_000,
  };
}
