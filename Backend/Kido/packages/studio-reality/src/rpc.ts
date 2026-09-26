import { z } from "zod";
import { lookupNetwork, type NetworkRef } from "@contextlock/studio-network";

/**
 * The read-only chain provider, and the transport fence underneath it.
 *
 * §P27.3 asks for an abstraction that cannot write, and is specific about how:
 *
 *     Prefer making those operations absent from the type rather than present and throwing.
 *
 * So `ReadOnlyChainProvider` has no `sendTransaction`, no `writeContract`, no wallet client and no
 * signer. Not disabled ones — absent ones. Calling `provider.sendTransaction(...)` is a TypeScript
 * error about a property that does not exist, which is a better error than a runtime throw because
 * it happens before the code ships.
 *
 * But §P27.4 is the part that matters more, and it starts from an honest premise: **a hostile
 * caller might bypass TypeScript.** Types are erased at runtime. A `JSON.parse`d config, an `any`,
 * a compromised dependency reaching for the transport directly — none of them is stopped by an
 * interface that merely omits a method. So the same boundary is enforced a second time, on the
 * wire, by method name, with an allowlist and a default deny.
 *
 * Two mechanisms, two failure modes, and neither depends on the other being right.
 */

/* ───────────────────────────── the method allowlist ───────────────────────────── */

/**
 * JSON-RPC methods a read-only source may carry.
 *
 * An allowlist rather than a deny-list, because the set of methods is open: every provider adds
 * proprietary namespaces, and a deny-list is a promise to have anticipated all of them. Anything
 * absent from this list is refused, including methods that are perfectly harmless — a refused read
 * is a support ticket, an unrefused write is the product boundary.
 */
export const RPC_READ_METHODS = [
  "eth_blockNumber",
  "eth_chainId",
  "eth_call",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBalance",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_getBlockTransactionCountByNumber",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_estimateGas",
  "net_version",
  "web3_clientVersion",
] as const;
export type RpcReadMethod = (typeof RPC_READ_METHODS)[number];
const READ_SET: ReadonlySet<string> = new Set<string>(RPC_READ_METHODS);

/**
 * Methods named explicitly as forbidden.
 *
 * Redundant — the allowlist already refuses them by omission — and kept anyway for two reasons.
 * A refusal that says "eth_sendRawTransaction is a write method" is more useful than one that says
 * "unknown method", and enumerating them lets a test assert that each is refused BY NAME rather
 * than incidentally. If someone adds `eth_sendRawTransaction` to the allowlist, this list still
 * refuses it, and the mutation test for that is REALITY-005.
 */
export const RPC_FORBIDDEN_METHODS = [
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "eth_sign",
  "eth_signTransaction",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "eth_accounts",
  "eth_requestAccounts",
  "eth_sendBundle",
  "personal_sign",
  "personal_unlockAccount",
  "personal_sendTransaction",
  "personal_importRawKey",
  "wallet_addEthereumChain",
  "wallet_switchEthereumChain",
  "wallet_requestPermissions",
  "wallet_sendTransaction",
  "miner_start",
  "evm_mine",
  "anvil_impersonateAccount",
  "hardhat_impersonateAccount",
  "debug_traceCall",
] as const;
const FORBIDDEN_SET: ReadonlySet<string> = new Set<string>(RPC_FORBIDDEN_METHODS);

/** Namespaces that are write- or wallet-shaped in their entirety. */
export const FORBIDDEN_RPC_NAMESPACES = ["personal_", "wallet_", "miner_", "anvil_", "hardhat_", "evm_", "txpool_", "admin_"] as const;

export const RPC_FENCE_REASONS = {
  WRITE_METHOD: "RPC_WRITE_METHOD_PROHIBITED",
  SIGNING_METHOD: "RPC_SIGNING_METHOD_PROHIBITED",
  UNKNOWN_METHOD: "RPC_METHOD_NOT_ON_READ_ALLOWLIST",
  NOT_READ_ONLY: "RPC_ENDPOINT_NOT_READ_ONLY",
  CREDENTIAL_PRESENT: "RPC_CREDENTIALLED_SIGNER_PRESENT",
} as const;
export type RpcFenceReason = (typeof RPC_FENCE_REASONS)[keyof typeof RPC_FENCE_REASONS];

export class RpcFenceError extends Error {
  constructor(readonly reason: RpcFenceReason, readonly method: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "RpcFenceError";
  }
}

/**
 * The transport fence. Every outgoing JSON-RPC method passes through here.
 *
 * Order is deliberate. The explicit forbidden names are checked FIRST, so adding a write method to
 * the read allowlist does not admit it — the two guards are independent, and a mutation to either
 * one alone is caught by its own test.
 */
export function assertRpcMethodAllowed(method: string): void {
  const lower = method.toLowerCase();

  if (FORBIDDEN_SET.has(method) || FORBIDDEN_SET.has(lower)) {
    const signing = /sign|accounts|personal/.test(lower);
    throw new RpcFenceError(
      signing ? RPC_FENCE_REASONS.SIGNING_METHOD : RPC_FENCE_REASONS.WRITE_METHOD,
      method,
      `"${method}" changes state or asks for a signature. The Reality Engine reads mainnet and never writes to it; there is no configuration in which this method is correct here.`,
    );
  }

  for (const ns of FORBIDDEN_RPC_NAMESPACES) {
    if (lower.startsWith(ns)) {
      throw new RpcFenceError(
        RPC_FENCE_REASONS.WRITE_METHOD,
        method,
        `"${method}" is in the ${ns}* namespace, which is wallet- or node-control-shaped in its entirety.`,
      );
    }
  }

  if (!READ_SET.has(method)) {
    // Default deny. An unrecognised method is refused rather than forwarded and hoped about.
    throw new RpcFenceError(
      RPC_FENCE_REASONS.UNKNOWN_METHOD,
      method,
      `"${method}" is not on the read allowlist. Unknown methods are denied by default: the set of RPC methods is open-ended and a deny-list is a promise to have anticipated every provider's extensions.`,
    );
  }
}

/* ───────────────────────────── the provider ───────────────────────────── */

export type Hex = `0x${string}`;
export type BlockTag = "latest" | "earliest" | "safe" | "finalized" | "pending";
export type BlockRef = bigint | BlockTag;

export interface RpcBlock {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
  baseFeePerGas: bigint | null;
  gasUsed: bigint;
  gasLimit: bigint;
}

export interface RpcLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

/**
 * A chain client that can only read.
 *
 * Note what is NOT here: no `sendTransaction`, no `sendRawTransaction`, no `writeContract`, no
 * `deployContract`, no `signMessage`, no `account`, no `wallet`. §P27.3 asks for absence rather
 * than presence-and-throw, and `REALITY-007` enumerates the interface's own keys to prove it.
 */
export interface ReadOnlyChainProvider {
  readonly chainId: number;
  readonly canonicalName: string;
  /** Which endpoint this is, for provenance. Never the URL — that can carry an API key. */
  readonly providerId: string;

  getBlockNumber(): Promise<bigint>;
  getBlock(ref: BlockRef): Promise<RpcBlock>;
  getBalance(address: Hex, ref?: BlockRef): Promise<bigint>;
  call(tx: { to: Hex; data: Hex; from?: Hex }, ref?: BlockRef): Promise<Hex>;
  getLogs(filter: { address?: Hex | Hex[]; topics?: (Hex | Hex[] | null)[]; fromBlock: BlockRef; toBlock: BlockRef }): Promise<RpcLog[]>;
  getCode(address: Hex, ref?: BlockRef): Promise<Hex>;
  getStorageAt(address: Hex, slot: Hex, ref?: BlockRef): Promise<Hex>;
  getTransactionReceipt(hash: Hex): Promise<{ blockNumber: bigint; status: "success" | "reverted" } | null>;
}

/** Method names that must never appear on a read-only provider. Enumerated so absence is testable. */
export const FORBIDDEN_PROVIDER_MEMBERS = [
  "sendTransaction", "sendRawTransaction", "writeContract", "deployContract",
  "signMessage", "signTransaction", "signTypedData", "account", "wallet",
  "walletClient", "privateKey", "mnemonic", "signer", "getAddresses", "requestAddresses",
] as const;

/* ───────────────────────────── endpoint configuration ───────────────────────────── */

/**
 * What the Reality Engine is given for a source.
 *
 * §P27.5: an RPC URL, and nothing else. No key, no mnemonic, no wallet session, no capability
 * issuer, no Ledger. The schema below is the whole of it, and `assertNoSignerCredential` scans a
 * candidate configuration for anything credential-shaped before it is accepted — because the
 * failure this prevents is not someone deliberately adding a private key, it is someone passing a
 * whole config object that happens to contain one.
 */
/**
 * How far back an endpoint can answer.
 *
 * Found the hard way: a public RPC serves the head happily and refuses a block five thousand back
 * with `"Archive requests require a personal token"`. A historical replay against such an endpoint
 * does not return stale data — it fails — but only because that provider is explicit. A provider
 * that silently answered from its most recent state would produce a replay labelled with a past
 * block and filled with present values, which is precisely what §P27.20 forbids.
 *
 * So depth is a declared property of the endpoint, checked before a replay is attempted, rather
 * than something discovered from an error message halfway through.
 */
export const ARCHIVE_DEPTHS = ["ARCHIVE", "RECENT_STATE_ONLY", "UNKNOWN"] as const;
export const ArchiveDepthSchema = z.enum(ARCHIVE_DEPTHS);
export type ArchiveDepth = z.infer<typeof ArchiveDepthSchema>;

/** Blocks of state a non-archive node typically retains. Geth's default is 128. */
export const RECENT_STATE_BLOCKS = 128;

export const ReadSourceEndpointSchema = z.object({
  chainId: z.number().int().positive(),
  providerId: z.string().min(1),
  url: z.string().url(),
  /**
   * Defaults to UNKNOWN rather than ARCHIVE.
   *
   * "We have not checked" and "it can serve archive" are different facts, and a default that
   * assumed the generous one would let a replay be attempted against an endpoint that cannot serve
   * it — the same reasoning as the source lifecycle's UNKNOWN state.
   */
  archiveDepth: ArchiveDepthSchema.default("UNKNOWN"),
  /** Requests per second this endpoint tolerates. */
  rateLimitPerSecond: z.number().int().positive().default(10),
  timeoutMs: z.number().int().positive().default(15_000),
});
export type ReadSourceEndpoint = z.infer<typeof ReadSourceEndpointSchema>;

/** Field names that would mean a signing credential reached the Reality Engine. */
export const REPLAY_DEPTH_REASON = "READ_SOURCE_CANNOT_SERVE_HISTORICAL_STATE" as const;

/**
 * Refuse a historical read an endpoint cannot serve.
 *
 * Checked before the request rather than after the error, so the failure names the cause. An
 * `UNKNOWN` endpoint is refused too: a replay is evidence, and evidence gathered from a provider
 * whose depth nobody established is evidence about the provider as much as about the chain.
 */
export function assertCanServeHistorical(
  endpoint: { providerId: string; archiveDepth: ArchiveDepth },
  requestedBlock: bigint,
  headBlock: bigint,
  context: string,
): void {
  const depth = headBlock - requestedBlock;
  if (depth <= BigInt(RECENT_STATE_BLOCKS)) return;
  if (endpoint.archiveDepth === "ARCHIVE") return;

  throw new RpcFenceError(
    RPC_FENCE_REASONS.NOT_READ_ONLY,
    "",
    `${context}: block ${requestedBlock} is ${depth} blocks behind the head, and ${endpoint.providerId} is declared ${endpoint.archiveDepth}. ${
      endpoint.archiveDepth === "UNKNOWN"
        ? "An endpoint whose archive depth was never established cannot be used for a replay: if it answered from its most recent state instead, the result would be a snapshot labelled with a past block and filled with present values."
        : "A node that retains only recent state cannot answer about this block."
    }`,
  );
}

export const SIGNER_CREDENTIAL_FIELDS = [
  "privateKey", "private_key", "privatekey", "mnemonic", "seed", "seedPhrase",
  "keystore", "walletSession", "signer", "account", "capabilityIssuer",
  "ledger", "derivationPath", "secretKey", "apiSecret",
] as const;

/**
 * Refuse a configuration carrying anything that could sign.
 *
 * Recursive, because the dangerous shape is a nested object — a whole deployment config passed
 * where an endpoint was expected. The value is never logged, only the field path, since the point
 * is to refuse the credential rather than to reproduce it in an error message.
 */
export function assertNoSignerCredential(config: unknown, context: string, path: string[] = []): void {
  if (config === null || typeof config !== "object") return;
  if (Array.isArray(config)) {
    config.forEach((v, i) => assertNoSignerCredential(v, context, [...path, String(i)]));
    return;
  }
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (SIGNER_CREDENTIAL_FIELDS.some((f) => lower === f.toLowerCase())) {
      throw new RpcFenceError(
        RPC_FENCE_REASONS.CREDENTIAL_PRESENT,
        "",
        `${context}: the configuration carries "${[...path, key].join(".")}". The Reality Engine receives an RPC URL and nothing else — it reads mainnet, and a component that cannot sign cannot be tricked into signing.`,
      );
    }
    // A 0x-prefixed 32-byte value is a private key whatever the field is called.
    if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new RpcFenceError(
        RPC_FENCE_REASONS.CREDENTIAL_PRESENT,
        "",
        `${context}: "${[...path, key].join(".")}" holds a 32-byte hex value. That is the shape of a private key, and this component has no use for one.`,
      );
    }
    assertNoSignerCredential(value, context, [...path, key]);
  }
}

/**
 * A network may be read as a source only if the registry says it is one.
 *
 * The check is on `rpcCapability` rather than `role`, so the transport's permission and the
 * network's purpose stay independently recorded — a network relabelled without its capability
 * being changed is refused here.
 */
export function assertReadSourceAllowed(chainId: number, context: string): void {
  const net = lookupNetwork(chainId);
  if (!net) {
    throw new RpcFenceError(RPC_FENCE_REASONS.NOT_READ_ONLY, "", `${context}: chain ${chainId} is not in the network registry`);
  }
  if (net.rpcCapability !== "READ_ONLY" && net.role === "READ_ONLY_SOURCE") {
    throw new RpcFenceError(
      RPC_FENCE_REASONS.NOT_READ_ONLY,
      "",
      `${context}: ${net.canonicalName} is a READ_ONLY_SOURCE whose endpoint is marked ${net.rpcCapability}. The role and the transport capability disagree, and the safe reading of a disagreement is refusal.`,
    );
  }
}

/** The reference for a read source, for provenance. Always `READ_ONLY_SOURCE`. */
export function readSourceRef(chainId: number): NetworkRef {
  return { chainId, role: "READ_ONLY_SOURCE", forkedFrom: null, forkBlock: null };
}
