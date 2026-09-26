import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { assertExecutionAllowed, type NetworkRef } from "@contextlock/studio-network";
import type { Hex } from "./rpc.js";

/**
 * The mainnet fork.
 *
 * A fork is the one place in ContextLock where mainnet protocol addresses are legitimately used for
 * a WRITE. That is exactly why it needs the most care in this phase: an Anvil node forked from
 * mainnet has mainnet's state, mainnet's contract addresses and mainnet's chain id if you let it —
 * and a transaction hash out of it is 32 bytes indistinguishable from a real one.
 *
 * Four separate things keep that from becoming a false claim:
 *
 * 1. **The chain id is 31337**, not 1. The registry knows 31337 as `LOCAL_FORK`, which is
 *    write-capable and not publicly write-capable.
 * 2. **The endpoint must be local.** A fork provider pointed at a public RPC fails before any
 *    transaction is built, not after.
 * 3. **Capabilities are bound to an environment id.** A fork authorization names the fork it was
 *    issued for and is invalid anywhere else, including a different fork.
 * 4. **Transactions are labelled at the source.** `LOCAL FORK TRANSACTION`, and no explorer URL is
 *    ever generated for one.
 */

export const FORK_STATES = ["CREATING", "VERIFYING_ANCHOR", "READY", "ANCHOR_MISMATCH", "FAILED", "DESTROYED"] as const;
export const ForkStateSchema = z.enum(FORK_STATES);
export type ForkState = z.infer<typeof ForkStateSchema>;

export const FORK_REASONS = {
  NOT_LOCAL: "FORK_ENDPOINT_NOT_LOCAL",
  ANCHOR_MISMATCH: "FORK_ANCHOR_BLOCK_MISMATCH",
  NO_EXACT_BLOCK: "FORK_REQUIRES_EXACT_BLOCK",
  NOT_READY: "FORK_NOT_READY",
  DESTROYED: "FORK_DESTROYED",
  ENVIRONMENT_MISMATCH: "FORK_CAPABILITY_ENVIRONMENT_MISMATCH",
  KEY_ESCAPED: "FORK_DEVELOPMENT_KEY_OUTSIDE_FORK",
  IMPERSONATION_OUTSIDE_FORK: "IMPERSONATION_ONLY_VALID_ON_LOCAL_FORK",
  LIMIT: "FORK_RESOURCE_LIMIT",
  START_FAILED: "FORK_FAILED_TO_START",
} as const;
export type ForkReason = (typeof FORK_REASONS)[keyof typeof FORK_REASONS];

export class ForkError extends Error {
  constructor(readonly reason: ForkReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ForkError";
  }
}

/* ───────────────────────────── the endpoint guard ───────────────────────────── */

/**
 * Hostnames a fork's own RPC endpoint may have.
 *
 * §P27.25: a configuration mistake pointing the fork execution provider at a public mainnet RPC
 * must fail **before** a transaction is executed. The check is on the endpoint the provider writes
 * to, not on the upstream URL Anvil reads from — those are different URLs with different rules, and
 * conflating them is how this guard would end up either useless or blocking the fork entirely.
 */
export const LOCAL_FORK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "anvil", "reality-fork-worker"] as const;

export function assertLocalForkEndpoint(url: string, context: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ForkError(FORK_REASONS.NOT_LOCAL, `${context}: "${url}" is not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "ws:") {
    throw new ForkError(
      FORK_REASONS.NOT_LOCAL,
      `${context}: a local fork speaks http or ws on this machine. "${parsed.protocol}" implies something remote, and a fork whose writes leave the machine is not a fork.`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!(LOCAL_FORK_HOSTS as readonly string[]).includes(host)) {
    throw new ForkError(
      FORK_REASONS.NOT_LOCAL,
      `${context}: the fork execution endpoint is ${host}, which is not a local address. Fork transactions execute against a node on this machine; pointing this at a public endpoint would send them somewhere real.`,
    );
  }
  return parsed;
}

/* ───────────────────────────── descriptors ───────────────────────────── */

export const ForkDescriptorSchema = z.object({
  forkId: z.string().regex(/^fork-[0-9a-f]{12}$/),
  /** The chain the fork copies. Never the fork's own chain id. */
  sourceChainId: z.number().int().positive(),
  /** Anvil's chain id. Distinct from `sourceChainId` on purpose. */
  chainId: z.literal(31337),
  /** Exact, always. §P27.23 forbids "latest" for evidence. */
  forkBlock: z.string().regex(/^\d+$/),
  forkBlockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  /** Which upstream provided the state. An identity, never the URL — that can carry a key. */
  sourceProviderId: z.string().min(1),
  anvilVersion: z.string().min(1),
  endpoint: z.string().min(1),
  createdAtMs: z.number().int().positive(),
  expiresAtMs: z.number().int().positive(),
  state: ForkStateSchema,
});
export type ForkDescriptor = z.infer<typeof ForkDescriptorSchema>;

/** The network reference for a fork. `forkedFrom` carries the truth about where state came from. */
export function forkNetworkRef(fork: ForkDescriptor): NetworkRef {
  return { chainId: 31337, role: "LOCAL_FORK", forkedFrom: fork.sourceChainId, forkBlock: fork.forkBlock };
}

/* ───────────────────────────── transactions ───────────────────────────── */

export const LOCAL_FORK_TX_LABEL = "LOCAL FORK TRANSACTION" as const;

/** Labels a local transaction must never carry. Named so their absence is testable. */
export const FORBIDDEN_TX_LABELS = ["MAINNET TRANSACTION", "MAINNET", "Ethereum Mainnet", "CONFIRMED ON MAINNET", "LIVE TRANSACTION"] as const;

export const ForkTransactionSchema = z.object({
  /** 32 bytes, and indistinguishable from a mainnet hash by inspection. Hence every other field. */
  hash: z.string().regex(/^0x[0-9a-f]{64}$/),
  forkId: z.string().min(1),
  chainId: z.literal(31337),
  forkedFrom: z.number().int().positive(),
  forkBlock: z.string().regex(/^\d+$/),
  blockNumber: z.string().regex(/^\d+$/),
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullable(),
  status: z.enum(["success", "reverted"]),
  gasUsed: z.string().regex(/^\d+$/),
  /** Fixed by the schema. There is no value of this field that says "mainnet". */
  label: z.literal(LOCAL_FORK_TX_LABEL),
  /** Whether the sender was impersonated rather than holding a key. */
  impersonated: z.boolean(),
});
export type ForkTransaction = z.infer<typeof ForkTransactionSchema>;

/**
 * The explorer URL for a transaction — or the refusal to invent one.
 *
 * §P27.30 asks for this specifically, and it is worth being blunt about why. A local Anvil hash is
 * 32 random-looking bytes. Pasted into an Etherscan URL it produces a page saying "Sorry, We are
 * unable to locate this TxnHash", which reads as "not indexed yet" rather than "this never
 * happened". The UI must know the origin, because the hash cannot tell it.
 */
export function explorerUrlFor(tx: { chainId: number; hash: string }): string | null {
  if (tx.chainId === 31337) return null;
  if (tx.chainId === 11155111) return `https://sepolia.etherscan.io/tx/${tx.hash}`;
  if (tx.chainId === 84532) return `https://sepolia.basescan.org/tx/${tx.hash}`;
  // Mainnet is absent on purpose: no transaction this product makes can be on it.
  return null;
}

/* ───────────────────────────── development keys ───────────────────────────── */

/**
 * Anvil's published development accounts.
 *
 * These are the well-known keys derived from the standard test mnemonic. They are in every Foundry
 * install and in the documentation; publishing them here is not a leak, and the secret scanner
 * needs to know they are expected rather than flagging them as a credential that escaped.
 *
 * The label is the point. §P27.26: never persisted to a wallet store, a signer store or a
 * credential store, and never displayed as a user credential.
 */
export const LOCAL_FORK_ONLY = "LOCAL_FORK_ONLY" as const;

export const ANVIL_DEV_ACCOUNTS = [
  { index: 0, address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", label: LOCAL_FORK_ONLY },
  { index: 1, address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", label: LOCAL_FORK_ONLY },
  { index: 2, address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", label: LOCAL_FORK_ONLY },
] as const;

/** Stores an Anvil development key must never reach. */
export const KEY_FORBIDDEN_STORES = ["user-wallet-store", "deployment-signer-store", "testnet-signer-store", "production-credentials", "capability-issuer"] as const;

export function assertDevKeyStoreAllowed(store: string, context: string): void {
  if ((KEY_FORBIDDEN_STORES as readonly string[]).includes(store)) {
    throw new ForkError(
      FORK_REASONS.KEY_ESCAPED,
      `${context}: an Anvil development account was offered to "${store}". These keys are public, disposable and valid only on a local fork; storing one anywhere a real key lives makes the two indistinguishable later.`,
    );
  }
}

/* ───────────────────────────── impersonation ───────────────────────────── */

export const IMPERSONATED_FOR_SIMULATION = "IMPERSONATED_FOR_SIMULATION" as const;

export const ImpersonatedActorSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  forkId: z.string().min(1),
  metadata: z.literal(IMPERSONATED_FOR_SIMULATION),
  reason: z.string().min(1),
});
export type ImpersonatedActor = z.infer<typeof ImpersonatedActorSchema>;

/**
 * Impersonation is a fork-only capability, and it proves nothing about identity.
 *
 * Anvil will happily let a caller send from Vitalik's address. What that demonstrates is that Anvil
 * accepts the request — not control of the account, not ownership, not authorization. Every
 * impersonated actor is stamped `IMPERSONATED_FOR_SIMULATION` so nothing downstream can read the
 * resulting transaction as evidence about a person.
 */
export function assertImpersonationAllowed(network: NetworkRef, context: string): void {
  if (network.role !== "LOCAL_FORK") {
    throw new ForkError(
      FORK_REASONS.IMPERSONATION_OUTSIDE_FORK,
      `${context}: impersonation was requested on a ${network.role} (chain ${network.chainId}). Sending from an address you do not control is a property of a simulator, and asking a public network for it is asking for something that does not exist.`,
    );
  }
}

/** Impersonation output can never be identity evidence. Enumerated so the claim is testable. */
export const IMPERSONATION_CANNOT_PROVE = ["ownership", "control", "authorization", "identity", "signature", "consent"] as const;

/* ───────────────────────────── environment binding ───────────────────────────── */

/**
 * A capability bound to an execution environment.
 *
 * §P27.34–35, and the subtlety worth stating: on a mainnet fork, the mainnet Aave Pool address IS
 * the right address, because the fork has mainnet's state. So a fork capability legitimately names
 * mainnet contracts. What stops it from being a mainnet capability is not the addresses — it is
 * that the authorization names `LOCAL_FORK` and a specific `environmentId`, and is invalid
 * anywhere else including a different fork of the same block.
 */
export const EXECUTION_ENVIRONMENTS = ["LOCAL_FORK", "TESTNET", "CRE_SIMULATION"] as const;
export const ExecutionEnvironmentSchema = z.enum(EXECUTION_ENVIRONMENTS);
export type ExecutionEnvironment = z.infer<typeof ExecutionEnvironmentSchema>;

export const EnvironmentBindingSchema = z.object({
  executionEnvironment: ExecutionEnvironmentSchema,
  /** The fork id, the deployment id — whatever names the one place this is valid. */
  environmentId: z.string().min(1),
  chainId: z.number().int().positive(),
  /** For a fork: the chain whose state it holds. Null elsewhere. */
  forkedFrom: z.number().int().positive().nullable(),
  forkBlock: z.string().regex(/^\d+$/).nullable(),
});
export type EnvironmentBinding = z.infer<typeof EnvironmentBindingSchema>;

/**
 * Check a capability against the environment it is being used in.
 *
 * Both halves matter and are checked separately, because they fail differently: the wrong KIND of
 * environment (a fork authorization on a testnet) and the wrong INSTANCE (a fork authorization on a
 * different fork). The second is the subtle one — two forks of the same chain at the same block are
 * still different machines with different state histories.
 */
export function assertEnvironmentBinding(binding: EnvironmentBinding, current: EnvironmentBinding, context: string): void {
  if (binding.executionEnvironment !== current.executionEnvironment) {
    throw new ForkError(
      FORK_REASONS.ENVIRONMENT_MISMATCH,
      `${context}: this authorization was issued for ${binding.executionEnvironment} and is being presented in ${current.executionEnvironment}. Authorizations do not travel between execution environments.`,
    );
  }
  if (binding.environmentId !== current.environmentId) {
    throw new ForkError(
      FORK_REASONS.ENVIRONMENT_MISMATCH,
      `${context}: this authorization names ${binding.environmentId} and the current environment is ${current.environmentId}. Two forks of the same chain at the same block are still two different machines.`,
    );
  }
  if (binding.chainId !== current.chainId) {
    throw new ForkError(
      FORK_REASONS.ENVIRONMENT_MISMATCH,
      `${context}: chain ${binding.chainId} authorization presented on chain ${current.chainId}`,
    );
  }
}

/* ───────────────────────────── resource bounds ───────────────────────────── */

/**
 * §P27.49. Forks are expensive: a process, memory, and an upstream RPC bill per lazily-fetched slot.
 * Central, so a limit is changed in one place rather than discovered in four.
 */
export const FORK_LIMITS = {
  maxConcurrentPerUser: 2,
  maxLifetimeMs: 30 * 60_000,
  maxMemoryMb: 2048,
  maxHistoricalReplaysPerBuild: 20,
  maxSnapshotBytes: 2 * 1024 * 1024,
} as const;

export function assertForkQuota(currentForks: number, limits: { maxConcurrentPerUser: number } = FORK_LIMITS): void {
  if (currentForks >= limits.maxConcurrentPerUser) {
    throw new ForkError(
      FORK_REASONS.LIMIT,
      `${currentForks} forks are already running and the limit is ${limits.maxConcurrentPerUser}. Each fork is a process plus an upstream RPC bill for every state slot it lazily fetches.`,
    );
  }
}

/* ───────────────────────────── the provider ───────────────────────────── */

export interface ForkCreateRequest {
  sourceChainId: number;
  /** Exact. There is no "latest" option, because §P27.23 forbids one for evidence. */
  forkBlock: string;
  /** The upstream Anvil reads state from. Held here and never handed downstream. */
  upstreamRpcUrl: string;
  sourceProviderId: string;
  /** The block hash we expect at `forkBlock`, read independently. Verified after startup. */
  expectedBlockHash?: string;
  port?: number;
  lifetimeMs?: number;
}

export interface MainnetForkProvider {
  create(req: ForkCreateRequest): Promise<ForkDescriptor>;
  snapshot(forkId: string): Promise<string>;
  restore(forkId: string, snapshotId: string): Promise<boolean>;
  reset(forkId: string): Promise<ForkDescriptor>;
  execute(forkId: string, tx: { from: Hex; to: Hex; data: Hex; value?: bigint; impersonate?: boolean }): Promise<ForkTransaction>;
  impersonate(forkId: string, address: Hex, reason: string): Promise<ImpersonatedActor>;
  destroy(forkId: string): Promise<void>;
  get(forkId: string): ForkDescriptor | null;
  list(): ReadonlyArray<ForkDescriptor>;
}

export const newForkId = (): string => `fork-${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 12)}`;

export interface AnvilDeps {
  spawnFn?: typeof spawn;
  nowMs?: () => number;
  /** Injected so tests drive the lifecycle without a binary. */
  rpc?: (endpoint: string, method: string, params: unknown[]) => Promise<unknown>;
  anvilBinary?: string;
  /** Reads the expected block hash from an independent source, for anchor verification. */
  readUpstreamBlockHash?: (chainId: number, block: string) => Promise<string>;
  /**
   * How many forks may run at once. The default (§P27.49) is sized for one agent under test; an
   * operator running a swarm — one fork per member — raises it knowingly, since every fork is an
   * Anvil process and an upstream RPC bill.
   */
  maxConcurrentForks?: number;
}

interface LiveFork {
  descriptor: ForkDescriptor;
  child: ChildProcess | null;
  impersonated: Map<string, ImpersonatedActor>;
}

/**
 * Anvil, supervised.
 *
 * Foundry 1.2.3-stable is what this was verified against, and the version is recorded on every
 * descriptor rather than assumed — a fork's reproducibility claim depends on the tool as much as
 * on the block.
 */
export class AnvilForkProvider implements MainnetForkProvider {
  private readonly forks = new Map<string, LiveFork>();

  constructor(private readonly deps: AnvilDeps = {}) {}

  private now(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private mustFind(forkId: string): LiveFork {
    const f = this.forks.get(forkId);
    if (!f) throw new ForkError(FORK_REASONS.NOT_READY, `${forkId} is not a running fork`);
    if (f.descriptor.state === "DESTROYED") throw new ForkError(FORK_REASONS.DESTROYED, `${forkId} was destroyed`);
    return f;
  }

  private async call(endpoint: string, method: string, params: unknown[] = []): Promise<unknown> {
    if (this.deps.rpc) return this.deps.rpc(endpoint, method, params);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }

  async create(req: ForkCreateRequest): Promise<ForkDescriptor> {
    if (!/^\d+$/.test(req.forkBlock)) {
      throw new ForkError(
        FORK_REASONS.NO_EXACT_BLOCK,
        `a fork used as evidence must pin an exact block; got "${req.forkBlock}". "latest" makes a run unreproducible the moment the chain advances, which is immediately.`,
      );
    }
    assertForkQuota(
      [...this.forks.values()].filter((f) => f.descriptor.state === "READY").length,
      { ...FORK_LIMITS, maxConcurrentPerUser: this.deps.maxConcurrentForks ?? FORK_LIMITS.maxConcurrentPerUser },
    );

    const forkId = newForkId();
    const port = req.port ?? 8545 + this.forks.size;
    const endpoint = `http://127.0.0.1:${port}`;
    // The provider's own write endpoint must be local. Checked before anything is spawned.
    assertLocalForkEndpoint(endpoint, `fork ${forkId}`);

    const binary = this.deps.anvilBinary ?? "anvil";
    const args = [
      "--fork-url", req.upstreamRpcUrl,
      "--fork-block-number", req.forkBlock,
      "--port", String(port),
      "--chain-id", "31337",
      "--host", "127.0.0.1",
      "--silent",
    ];

    const spawnFn = this.deps.spawnFn ?? spawn;
    const child = spawnFn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });

    const descriptor: ForkDescriptor = {
      forkId,
      sourceChainId: req.sourceChainId,
      chainId: 31337,
      forkBlock: req.forkBlock,
      forkBlockHash: `0x${"0".repeat(64)}`,
      sourceProviderId: req.sourceProviderId,
      anvilVersion: "unknown",
      endpoint,
      createdAtMs: this.now(),
      expiresAtMs: this.now() + (req.lifetimeMs ?? FORK_LIMITS.maxLifetimeMs),
      state: "CREATING",
    };
    this.forks.set(forkId, { descriptor, child, impersonated: new Map() });
    return descriptor;
  }

  /**
   * Verify the fork is anchored where it claims to be.
   *
   * §P27.24. Reads the fork's own block hash and compares it with one read independently upstream.
   * A mismatch destroys the fork: state that is not the state we intended is worse than no state,
   * because every result computed on it looks legitimate.
   */
  async verifyAnchor(forkId: string, expectedBlockHash?: string): Promise<ForkDescriptor> {
    const f = this.mustFind(forkId);
    const d = f.descriptor;

    const mutable = { ...d, state: "VERIFYING_ANCHOR" as ForkState };
    f.descriptor = mutable;

    try {
      const chainIdHex = (await this.call(d.endpoint, "eth_chainId")) as string;
      const block = (await this.call(d.endpoint, "eth_getBlockByNumber", [`0x${BigInt(d.forkBlock).toString(16)}`, false])) as
        | { number: string; hash: string }
        | null;
      const version = (await this.call(d.endpoint, "web3_clientVersion").catch(() => "anvil/unknown")) as string;

      if (!block) throw new ForkError(FORK_REASONS.ANCHOR_MISMATCH, `${forkId}: the fork has no block ${d.forkBlock}`);
      if (BigInt(chainIdHex) !== 31337n) {
        throw new ForkError(
          FORK_REASONS.ANCHOR_MISMATCH,
          `${forkId}: the fork reports chain id ${BigInt(chainIdHex)}. A fork that keeps its source chain id is a fork whose transactions can be replayed onto the real chain.`,
        );
      }
      if (BigInt(block.number) !== BigInt(d.forkBlock)) {
        throw new ForkError(FORK_REASONS.ANCHOR_MISMATCH, `${forkId}: asked for block ${d.forkBlock} and the fork has ${BigInt(block.number)}`);
      }

      const expected = expectedBlockHash ?? (this.deps.readUpstreamBlockHash ? await this.deps.readUpstreamBlockHash(d.sourceChainId, d.forkBlock) : null);
      if (expected && expected.toLowerCase() !== block.hash.toLowerCase()) {
        throw new ForkError(
          FORK_REASONS.ANCHOR_MISMATCH,
          `${forkId}: block ${d.forkBlock} hashes to ${block.hash} in the fork and ${expected} upstream. The fork is not holding the state it claims to hold.`,
        );
      }

      f.descriptor = { ...mutable, state: "READY", forkBlockHash: block.hash.toLowerCase(), anvilVersion: version };
      return f.descriptor;
    } catch (e) {
      f.descriptor = { ...mutable, state: e instanceof ForkError && e.reason === FORK_REASONS.ANCHOR_MISMATCH ? "ANCHOR_MISMATCH" : "FAILED" };
      // A fork that is not what it claims must not survive to be used by something less careful.
      await this.destroy(forkId);
      throw e;
    }
  }

  async snapshot(forkId: string): Promise<string> {
    const f = this.mustFind(forkId);
    return (await this.call(f.descriptor.endpoint, "evm_snapshot")) as string;
  }

  async restore(forkId: string, snapshotId: string): Promise<boolean> {
    const f = this.mustFind(forkId);
    return (await this.call(f.descriptor.endpoint, "evm_revert", [snapshotId])) as boolean;
  }

  async reset(forkId: string): Promise<ForkDescriptor> {
    const f = this.mustFind(forkId);
    const d = f.descriptor;
    await this.call(d.endpoint, "anvil_reset", [{ forking: { blockNumber: Number(d.forkBlock) } }]);
    return d;
  }

  async impersonate(forkId: string, address: Hex, reason: string): Promise<ImpersonatedActor> {
    const f = this.mustFind(forkId);
    assertImpersonationAllowed(forkNetworkRef(f.descriptor), `impersonate ${address}`);
    await this.call(f.descriptor.endpoint, "anvil_impersonateAccount", [address]);
    const actor: ImpersonatedActor = { address, forkId, metadata: IMPERSONATED_FOR_SIMULATION, reason };
    f.impersonated.set(address.toLowerCase(), actor);
    return actor;
  }

  async execute(forkId: string, tx: { from: Hex; to: Hex; data: Hex; value?: bigint; impersonate?: boolean }): Promise<ForkTransaction> {
    const f = this.mustFind(forkId);
    const d = f.descriptor;
    if (d.state !== "READY") {
      throw new ForkError(FORK_REASONS.NOT_READY, `${forkId} is ${d.state}; a fork executes only after its anchor is verified`);
    }
    // Re-checked at execution, not only at creation. The endpoint is the thing writes go to, and a
    // check that ran once at startup does not cover a descriptor mutated since.
    assertLocalForkEndpoint(d.endpoint, `fork ${forkId} execute`);
    // And through the product-wide guard, so a fork write is fenced by the same code as every other.
    assertExecutionAllowed(forkNetworkRef(d), "LOCAL_WRITE", `fork ${forkId}`);

    if (tx.impersonate) await this.call(d.endpoint, "anvil_impersonateAccount", [tx.from]);

    const hash = (await this.call(d.endpoint, "eth_sendTransaction", [{
      from: tx.from,
      to: tx.to,
      data: tx.data,
      ...(tx.value !== undefined ? { value: `0x${tx.value.toString(16)}` } : {}),
    }])) as string;

    const receipt = (await this.call(d.endpoint, "eth_getTransactionReceipt", [hash])) as
      | { blockNumber: string; status: string; gasUsed: string; to: string | null }
      | null;
    if (!receipt) throw new ForkError(FORK_REASONS.NOT_READY, `${forkId}: no receipt for ${hash}`);

    return ForkTransactionSchema.parse({
      hash: hash.toLowerCase(),
      forkId,
      chainId: 31337,
      forkedFrom: d.sourceChainId,
      forkBlock: d.forkBlock,
      blockNumber: BigInt(receipt.blockNumber).toString(),
      from: tx.from,
      to: tx.to,
      status: receipt.status === "0x1" ? "success" : "reverted",
      gasUsed: BigInt(receipt.gasUsed).toString(),
      label: LOCAL_FORK_TX_LABEL,
      impersonated: tx.impersonate === true || f.impersonated.has(tx.from.toLowerCase()),
    });
  }

  async destroy(forkId: string): Promise<void> {
    const f = this.forks.get(forkId);
    if (!f) return;
    f.child?.kill("SIGTERM");
    // SIGKILL after a grace period, because an Anvil that ignores SIGTERM keeps the port and the
    // memory, and §P27.49 asks for abandoned forks to actually go away.
    setTimeout(() => f.child?.kill("SIGKILL"), 2_000).unref?.();
    f.descriptor = { ...f.descriptor, state: "DESTROYED" };
    f.child = null;
  }

  /** Destroy every fork past its lifetime. §P27.49's "destroy abandoned forks". */
  async reapExpired(): Promise<string[]> {
    const now = this.now();
    const reaped: string[] = [];
    for (const [id, f] of this.forks) {
      if (f.descriptor.state !== "DESTROYED" && now > f.descriptor.expiresAtMs) {
        await this.destroy(id);
        reaped.push(id);
      }
    }
    return reaped;
  }

  get(forkId: string): ForkDescriptor | null {
    return this.forks.get(forkId)?.descriptor ?? null;
  }

  list(): ReadonlyArray<ForkDescriptor> {
    return [...this.forks.values()].map((f) => f.descriptor);
  }
}
