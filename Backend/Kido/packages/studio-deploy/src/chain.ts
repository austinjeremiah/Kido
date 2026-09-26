import { createPublicClient, http, keccak256, type Address, type Hex } from "viem";

/**
 * The chain reader.
 *
 * An interface rather than a viem client passed around directly, for one reason: every gas
 * estimate, balance check and bytecode verification in this package must be testable without a
 * network, and must be *visibly* testable — a test that silently fell back to a fixture when the
 * RPC was down would report a green preflight for a chain nobody contacted.
 *
 * So the interface is narrow, the live implementation is one adapter, and every estimate records
 * `fromLiveNode` so a fixture-derived number cannot be displayed as a quote.
 */
export interface ChainReader {
  readonly chainId: number;
  /** True when this reader talks to a real node. Recorded in every estimate it produces. */
  readonly live: boolean;
  getChainId(): Promise<number>;
  getCode(address: Address): Promise<Hex | undefined>;
  getBalance(address: Address): Promise<bigint>;
  getTransactionCount(address: Address): Promise<bigint>;
  estimateGas(tx: { from: Address; to?: Address; data?: Hex; value?: bigint }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint | undefined; maxPriorityFeePerGas: bigint | undefined; gasPrice: bigint | undefined }>;
  /** Static call. Used to prove a configuration write would succeed before it is signed. */
  call(tx: { from: Address; to: Address; data: Hex; value?: bigint }): Promise<Hex>;
  getTransactionReceipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint; contractAddress: Address | null } | null>;
  getBlockNumber(): Promise<bigint>;
}

export class RpcError extends Error {
  constructor(readonly kind: "TIMEOUT" | "RATE_LIMITED" | "TRANSPORT" | "REVERTED", detail: string) {
    super(`RPC-${kind}: ${detail}`);
    this.name = "RpcError";
  }
}

/**
 * Classify an RPC failure.
 *
 * The distinction that matters is between "the node refused" and "we do not know what the node
 * did". A 429 is the first; a timeout after a send is the second, and conflating them is how a
 * deployment resubmits a transaction that already succeeded (DEP-003, DEP-022).
 */
export function classifyRpcError(err: unknown): RpcError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/429|rate.?limit|too many requests/i.test(msg)) return new RpcError("RATE_LIMITED", msg);
  if (/timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|aborted/i.test(msg)) return new RpcError("TIMEOUT", msg);
  if (/revert|execution reverted/i.test(msg)) return new RpcError("REVERTED", msg);
  return new RpcError("TRANSPORT", msg);
}

export function viemChainReader(chainId: number, rpcUrl: string): ChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw classifyRpcError(e);
    }
  };
  return {
    chainId,
    live: true,
    getChainId: () => wrap(() => client.getChainId()),
    getCode: (address) => wrap(() => client.getCode({ address })),
    getBalance: (address) => wrap(() => client.getBalance({ address })),
    getTransactionCount: (address) => wrap(async () => BigInt(await client.getTransactionCount({ address }))),
    /*
     * `account`, not `from`.
     *
     * viem's `estimateGas` names the sender `account`; a `from` key is simply not part of its
     * parameter type and is dropped. An estimate made without a sender is an estimate of a
     * transaction nobody will send — for a permissioned call it reverts with the contract's
     * access-control error, and for an unpermissioned one it can be quietly wrong.
     *
     * This cost a live deployment run: `setPolicyAdmin` estimated as `NotAdmin()` because the
     * sender had been dropped and the call was being estimated from the zero address.
     */
    estimateGas: (tx) =>
      wrap(() =>
        client.estimateGas({
          account: tx.from,
          ...(tx.to !== undefined ? { to: tx.to } : {}),
          ...(tx.data !== undefined ? { data: tx.data } : {}),
          ...(tx.value !== undefined ? { value: tx.value } : {}),
        } as never),
      ),
    estimateFeesPerGas: () =>
      wrap(async () => {
        const fees = await client.estimateFeesPerGas().catch(() => null);
        if (fees) return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, gasPrice: undefined };
        const gasPrice = await client.getGasPrice();
        return { maxFeePerGas: undefined, maxPriorityFeePerGas: undefined, gasPrice };
      }),
    // `call` already takes `account`; kept explicit so the two stay obviously consistent.
    call: (tx) => wrap(async () => (await client.call({ account: tx.from, to: tx.to, data: tx.data, ...(tx.value !== undefined ? { value: tx.value } : {}) })).data ?? "0x"),
    getTransactionReceipt: (hash) =>
      wrap(async () => {
        try {
          const r = await client.getTransactionReceipt({ hash });
          return {
            status: r.status,
            blockNumber: r.blockNumber,
            gasUsed: r.gasUsed,
            effectiveGasPrice: r.effectiveGasPrice,
            contractAddress: r.contractAddress ?? null,
          };
        } catch {
          // Not found is not an error here — it is the answer "this chain has not seen it", which
          // is exactly what receipt reconciliation needs to distinguish from a transport failure.
          return null;
        }
      }),
    getBlockNumber: () => wrap(() => client.getBlockNumber()),
  };
}

/** keccak256 of deployed runtime bytecode. Empty code hashes to the empty-string keccak, not 0x0. */
export const codeHash = (code: Hex | undefined): Hex => keccak256((code ?? "0x") as Hex);
