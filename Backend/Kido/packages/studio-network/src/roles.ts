import { z } from "zod";

/**
 * The network role model.
 *
 * ContextLock is now intentionally a testnet laboratory. That is a product boundary, and a product
 * boundary that lives in prose gets crossed. So it lives in the type system:
 *
 *     A NETWORK IS NEVER JUST A CHAIN ID. IT IS A CHAIN ID AND WHAT IT IS FOR.
 *
 * The distinction the whole group turns on is that mainnet data is legitimate and valuable — a
 * testnet agent should react to real prices — while mainnet *execution* is outside this roadmap
 * entirely. Those are different permissions on the same chain id, and representing a network as a
 * bare number makes them indistinguishable.
 *
 * There is no "enable mainnet" flag anywhere below. Not a disabled one; not one behind an
 * environment variable. `TESTNET_EXECUTION` on chain 1 is not a configuration this codebase can
 * express, and `assertExecutionAllowed` refuses it whatever a model, a Blueprint or a request body
 * says.
 */

export const NETWORK_ROLES = [
  /** Mainnet, an archive node, a subgraph. Read all you like; write nothing, ever. */
  "READ_ONLY_SOURCE",
  /** An approved public testnet. The only role that may produce a public transaction. */
  "TESTNET_EXECUTION",
  /** An Anvil fork on this machine. Writes go nowhere public. */
  "LOCAL_FORK",
] as const;
export const NetworkRoleSchema = z.enum(NETWORK_ROLES);
export type NetworkRole = z.infer<typeof NetworkRoleSchema>;

/** Which roles may originate a write at all. `READ_ONLY_SOURCE` is deliberately absent. */
export const WRITE_CAPABLE_ROLES: ReadonlySet<NetworkRole> = new Set<NetworkRole>(["TESTNET_EXECUTION", "LOCAL_FORK"]);

/** Which roles may produce a transaction other people can see. */
export const PUBLIC_WRITE_ROLES: ReadonlySet<NetworkRole> = new Set<NetworkRole>(["TESTNET_EXECUTION"]);

export const NetworkRefSchema = z.object({
  chainId: z.number().int().positive(),
  role: NetworkRoleSchema,
  /**
   * For a fork, the chain it was forked FROM.
   *
   * A fork of mainnet has `chainId` 31337 and `forkedFrom` 1. Conflating those is how a local
   * transaction hash ends up linked to Etherscan.
   */
  forkedFrom: z.number().int().positive().nullable().default(null),
  forkBlock: z.string().regex(/^\d+$/).nullable().default(null),
});
export type NetworkRef = z.infer<typeof NetworkRefSchema>;

/* ─────────────────────── the approved execution registry ─────────────────────── */

export const APPROVED_NETWORK_REASONS = {
  PRODUCTION_WRITE: "PRODUCTION_NETWORK_WRITE_PROHIBITED",
  NOT_APPROVED: "EXECUTION_NETWORK_NOT_APPROVED",
  ROLE_MISMATCH: "NETWORK_ROLE_MISMATCH",
  READ_ONLY_WRITE: "READ_ONLY_SOURCE_CANNOT_EXECUTE",
  FORK_PUBLIC_WRITE: "LOCAL_FORK_CANNOT_PUBLICLY_WRITE",
  UNKNOWN_NETWORK: "NETWORK_NOT_IN_REGISTRY",
} as const;
export type ApprovedNetworkReason = (typeof APPROVED_NETWORK_REASONS)[keyof typeof APPROVED_NETWORK_REASONS];

export class NetworkGuardError extends Error {
  constructor(readonly reason: ApprovedNetworkReason, detail: string, readonly chainId: number | null = null) {
    super(`${reason}: ${detail}`);
    this.name = "NetworkGuardError";
  }
}

/**
 * What a network's RPC endpoint is permitted to do.
 *
 * Separate from `role` on purpose. The role says what the network is FOR; this says what the
 * transport may carry. They agree today, and keeping them distinct means a future entry cannot
 * acquire write capability by being relabelled — the Reality Engine's transport fence reads this
 * field, not the role.
 */
export const RPC_CAPABILITIES = ["READ_ONLY", "READ_WRITE"] as const;
export const RpcCapabilitySchema = z.enum(RPC_CAPABILITIES);
export type RpcCapability = z.infer<typeof RpcCapabilitySchema>;

/** Which side of the product boundary a network sits on. */
export const NETWORK_ENVIRONMENTS = ["PRODUCTION", "TESTNET", "LOCAL"] as const;
export const NetworkEnvironmentSchema = z.enum(NETWORK_ENVIRONMENTS);
export type NetworkEnvironment = z.infer<typeof NetworkEnvironmentSchema>;

export interface ApprovedNetwork {
  chainId: number;
  name: string;
  /**
   * The stable machine name, distinct from the display `name`.
   *
   * Display names get edited; identifiers must not. Anything that keys on a network — evidence
   * files, snapshot provenance, source descriptors — uses this.
   */
  canonicalName: string;
  role: NetworkRole;
  environment: NetworkEnvironment;
  rpcCapability: RpcCapability;
  /** Decimal uint64 as a STRING. Never a number — see the note in `chainSelector` below. */
  chainSelector: string | null;
  nativeSymbol: string;
  explorer: string | null;
  /** Why this network is on the list, and what verified it. */
  verifiedBy: string;
}

/**
 * The one trusted registry. Server-side, and the only place a chain id may be approved to execute.
 *
 * Deliberately short. §"Add others only after validating current official chain metadata" — a
 * registry that grows by convenience is a registry nobody re-checks, and every entry here is a
 * network this project has actually deployed to and verified.
 *
 * Chain selectors are strings because they are uint64: `Number("16015286601757825753")` and
 * `Number("16015286601757825754")` are the same double, so a selector that passes through a JSON
 * number has already lost the low bits (FND-V2-E-002).
 */
const APPROVED: ReadonlyArray<ApprovedNetwork> = [
  {
    chainId: 11155111,
    name: "Ethereum Sepolia",
    canonicalName: "ethereum-testnet-sepolia",
    role: "TESTNET_EXECUTION",
    environment: "TESTNET",
    rpcCapability: "READ_WRITE",
    chainSelector: "16015286601757825753",
    nativeSymbol: "ETH",
    explorer: "https://sepolia.etherscan.io",
    verifiedBy: "ContextLock P23 live deployment; CRE supported-chains as ethereum-testnet-sepolia",
  },
  {
    chainId: 84532,
    name: "Base Sepolia",
    canonicalName: "ethereum-testnet-sepolia-base-1",
    role: "TESTNET_EXECUTION",
    environment: "TESTNET",
    rpcCapability: "READ_WRITE",
    chainSelector: "10344971235874465080",
    nativeSymbol: "ETH",
    explorer: "https://sepolia.basescan.org",
    verifiedBy: "ContextLock P19 CCIP lane verification; CRE supported-chains as ethereum-testnet-sepolia-base-1",
  },
  {
    /*
     * The Anvil fork.
     *
     * 31337 is Anvil's default and is not a public network — nothing outside this machine can see
     * it, and nothing on it can be seen from outside. It is write-capable and NOT publicly
     * write-capable, which is the distinction `PUBLIC_WRITE_ROLES` exists for.
     */
    chainId: 31337,
    name: "Local Anvil fork",
    canonicalName: "local-anvil-fork",
    role: "LOCAL_FORK",
    environment: "LOCAL",
    rpcCapability: "READ_WRITE",
    chainSelector: null,
    nativeSymbol: "ETH",
    explorer: null,
    verifiedBy: "local process; not a public network",
  },
  {
    /*
     * Ethereum mainnet, as a DATA SOURCE.
     *
     * Phase 27 needs mainnet in the registry so the Reality Engine can name what it is reading and
     * so provenance has something to point at. Registering it does not make it executable, and the
     * entry is refused by `assertExecutionAllowed` three separate times: the production-chain check
     * fires first on the chain id, the `READ_ONLY_SOURCE` check fires on the role, and the
     * write-capability check fires on the registry's own record of that role.
     *
     * `rpcCapability: "READ_ONLY"` is the fourth, and it is the one the transport fence reads — so
     * a caller that somehow obtained a client for this network still cannot put a write method on
     * the wire.
     */
    chainId: 1,
    name: "Ethereum Mainnet",
    canonicalName: "ethereum-mainnet",
    role: "READ_ONLY_SOURCE",
    environment: "PRODUCTION",
    rpcCapability: "READ_ONLY",
    chainSelector: "5009297550715157269",
    nativeSymbol: "ETH",
    explorer: "https://etherscan.io",
    verifiedBy: "P27 live read: eth_blockNumber agreed across two independent providers; CRE supported-chains as ethereum-mainnet",
  },
];

const BY_CHAIN_ID = new Map(APPROVED.map((n) => [n.chainId, n]));

/**
 * Networks that may originate execution.
 *
 * `approvedNetworks()` returns everything the registry knows, including read-only sources, because
 * provenance needs to name them. This is the narrower list, and it is derived from the roles rather
 * than maintained by hand — a read-only entry cannot be added to it by editing it.
 */
export function executionNetworks(): ReadonlyArray<ApprovedNetwork> {
  return APPROVED.filter((n) => WRITE_CAPABLE_ROLES.has(n.role));
}

/** Networks that may only be read. */
export function readOnlySources(): ReadonlyArray<ApprovedNetwork> {
  return APPROVED.filter((n) => n.role === "READ_ONLY_SOURCE");
}

/**
 * Chain ids that are production networks.
 *
 * Named rather than inferred. "Not in the approved list" and "is a production network" produce
 * different errors on purpose: the first is a configuration gap, the second is the product boundary,
 * and an operator needs to know which one they hit.
 */
export const PRODUCTION_CHAIN_IDS: ReadonlySet<number> = new Set([
  1,      // Ethereum
  10,     // OP Mainnet
  56,     // BNB Chain
  100,    // Gnosis
  130,    // Unichain
  137,    // Polygon
  146,    // Sonic
  250,    // Fantom
  252,    // Fraxtal
  324,    // zkSync Era
  480,    // World Chain
  1101,   // Polygon zkEVM
  1329,   // Sei
  5000,   // Mantle
  8453,   // Base
  34443,  // Mode
  42161,  // Arbitrum One
  42220,  // Celo
  43114,  // Avalanche
  59144,  // Linea
  81457,  // Blast
  534352, // Scroll
]);

export const isProductionChain = (chainId: number): boolean => PRODUCTION_CHAIN_IDS.has(chainId);

export function approvedNetworks(): ReadonlyArray<ApprovedNetwork> {
  return APPROVED;
}

export function lookupNetwork(chainId: number): ApprovedNetwork | null {
  return BY_CHAIN_ID.get(chainId) ?? null;
}

/**
 * THE write guard.
 *
 * Every write-capable subsystem calls this one function: contract deployment, capability issuance,
 * relayer submission, adapter execution, CCIP, CRE `--broadcast`, wallet signing, Local Bridge
 * signing, the agent runtime and the deployment orchestrator. Scattering chain-id checks would mean
 * a new subsystem is a new place to forget one.
 *
 * `intent` distinguishes a public transaction from a local one, because a fork may do the second
 * and not the first.
 */
export function assertExecutionAllowed(ref: NetworkRef, intent: "PUBLIC_WRITE" | "LOCAL_WRITE", context: string): ApprovedNetwork {
  /*
   * Production first, and by chain id rather than by the role the caller claimed.
   *
   * This ordering is the point. A caller asserting `{ chainId: 1, role: "TESTNET_EXECUTION" }` is
   * either confused or hostile, and either way the answer is the same — the role is a claim and
   * the chain id is the fact.
   */
  if (isProductionChain(ref.chainId) && ref.role !== "LOCAL_FORK") {
    throw new NetworkGuardError(
      APPROVED_NETWORK_REASONS.PRODUCTION_WRITE,
      `${context}: chain ${ref.chainId} is a production network. ContextLock is a testnet laboratory; production-chain execution is outside this product and there is no flag that enables it.`,
      ref.chainId,
    );
  }

  if (ref.role === "READ_ONLY_SOURCE") {
    throw new NetworkGuardError(
      APPROVED_NETWORK_REASONS.READ_ONLY_WRITE,
      `${context}: chain ${ref.chainId} is a READ_ONLY_SOURCE. Data from it may inform a decision; it may never authorize execution.`,
      ref.chainId,
    );
  }

  const network = BY_CHAIN_ID.get(ref.chainId);
  if (!network) {
    throw new NetworkGuardError(
      APPROVED_NETWORK_REASONS.NOT_APPROVED,
      `${context}: chain ${ref.chainId} is not in ApprovedExecutionNetworks. Add it to the registry only after verifying its current official chain metadata.`,
      ref.chainId,
    );
  }

  // The registry's role is authoritative; the caller's is checked against it. A caller that
  // relabels a fork as a testnet gets caught here rather than at the transaction.
  if (network.role !== ref.role) {
    throw new NetworkGuardError(
      APPROVED_NETWORK_REASONS.ROLE_MISMATCH,
      `${context}: chain ${ref.chainId} is registered as ${network.role}, and this reference claims ${ref.role}`,
      ref.chainId,
    );
  }

  if (intent === "PUBLIC_WRITE" && !PUBLIC_WRITE_ROLES.has(network.role)) {
    throw new NetworkGuardError(
      APPROVED_NETWORK_REASONS.FORK_PUBLIC_WRITE,
      `${context}: chain ${ref.chainId} is a ${network.role} and cannot produce a public transaction. Its writes exist only on this machine.`,
      ref.chainId,
    );
  }

  if (!WRITE_CAPABLE_ROLES.has(network.role)) {
    throw new NetworkGuardError(APPROVED_NETWORK_REASONS.NOT_APPROVED, `${context}: ${network.role} is not write-capable`, ref.chainId);
  }

  return network;
}

/** Reading is unrestricted, by design. Mainnet data is the point of the reality engine. */
export function assertReadAllowed(_ref: NetworkRef, _context: string): void {
  // Deliberately empty, and deliberately present. A caller reaching for a read guard finds one that
  // says reads are allowed, rather than finding nothing and wondering whether they missed a check.
}

/**
 * A wallet connected to a production network, asked to write.
 *
 * The dangerous convenience is to switch the wallet's chain and sign. This refuses instead — a
 * product that silently moves a user's wallet onto a different network to complete an action is a
 * product that will one day move it onto the wrong one.
 */
export function assertWalletNetworkSafe(walletChainId: number, target: NetworkRef, context: string): void {
  if (isProductionChain(walletChainId)) {
    throw new NetworkGuardError(
      APPROVED_NETWORK_REASONS.PRODUCTION_WRITE,
      `${context}: the connected wallet is on chain ${walletChainId}, a production network. ContextLock will not switch networks and sign on your behalf. Switch to ${target.chainId} yourself if you intend to continue.`,
      walletChainId,
    );
  }
  if (walletChainId !== target.chainId) {
    throw new NetworkGuardError(
      APPROVED_NETWORK_REASONS.ROLE_MISMATCH,
      `${context}: the wallet is on chain ${walletChainId} and this action targets ${target.chainId}`,
      walletChainId,
    );
  }
}

/* ───────────────────────────── display ───────────────────────────── */

/** The label a network gets in the UI. Never "Live Mainnet Agent", which is not a thing here. */
export function networkLabel(ref: NetworkRef): string {
  switch (ref.role) {
    case "READ_ONLY_SOURCE":
      return "MAINNET DATA — READ ONLY";
    case "TESTNET_EXECUTION":
      return "TESTNET";
    case "LOCAL_FORK":
      return "LOCAL MAINNET FORK — NO PUBLIC TRANSACTIONS";
  }
}

/** Phrases the product must never emit. Enumerated so their absence is testable. */
export const FORBIDDEN_LABELS = [
  "Live Mainnet Agent",
  "Mainnet Agent",
  "Production Agent",
  "Live Trading",
  "Real Money",
  "Mainnet Execution",
] as const;
