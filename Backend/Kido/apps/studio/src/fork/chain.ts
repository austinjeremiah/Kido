import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { anvil, mainnet } from "viem/chains";
import { LOCAL_FORK_ONLY, assertDevKeyStoreAllowed, assertLocalForkEndpoint } from "@contextlock/studio-reality";
import type { ChainReader } from "@contextlock/studio-deploy";

/**
 * The chain-facing constants and clients the fork lab uses.
 *
 * Addresses are mainnet's, because the fork is mainnet's state: the Aave v3 pool, the Chainlink
 * ETH/USD aggregator and the two tokens are the real contracts at the pinned block. They are
 * read and — on the fork only — written to; nothing here has a path to a public chain.
 */

export const MAINNET = {
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address,
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
  aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" as Address,
  chainlinkEthUsd: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" as Address,
} as const;

/** Aave v3's base currency is USD with 8 decimals; USDC has 6. */
export const AAVE_BASE_DECIMALS = 8;
export const USDC_DECIMALS = 6;
/** Aave's health factor is a WAD. */
export const HEALTH_FACTOR_DECIMALS = 18;
/** Aave v3 interest rate mode for variable debt. */
export const VARIABLE_RATE = 2n;

export const DEFAULT_UPSTREAM_RPC = "https://ethereum-rpc.publicnode.com";
export const DEFAULT_UPSTREAM_PROVIDER_ID = "publicnode";

/*
 * The roles on the fork.
 *
 * Roles are separated the way the Sepolia deployment separates them: the deployer administers the
 * policy, the issuer signs capabilities, the authorizer records verdicts, the relayer submits, the
 * user owns the position the agent guards, and the approver signs escalations — the stand-in for
 * the Ledger device, and labelled as such everywhere it appears (BLK-002).
 *
 * Each role is a FRESH key, generated for one deployment and held only in this process's memory.
 * Not Anvil's published dev accounts: on a fork of mainnet those addresses carry whatever mainnet
 * has put on them, and at least one of them now has an EIP-7702 delegation — which turns the
 * executor's issuer check into an ERC-1271 call to a stranger's contract. A key nobody else has
 * ever seen has no such history. It is funded on the fork by `anvil_setBalance`, is worthless
 * anywhere else, and is never written to disk; the record keeps only the addresses.
 */
export const FORK_ROLES = ["deployer", "issuer", "authorizer", "relayer", "user", "approver"] as const;
export type ForkRole = (typeof FORK_ROLES)[number];

export class ForkKeyring {
  private readonly accounts: Record<ForkRole, PrivateKeyAccount>;

  private constructor(accounts: Record<ForkRole, PrivateKeyAccount>) {
    this.accounts = accounts;
  }

  static generate(): ForkKeyring {
    assertDevKeyStoreAllowed("fork-ephemeral-keyring", "fork keyring");
    return new ForkKeyring(Object.fromEntries(FORK_ROLES.map((r) => [r, privateKeyToAccount(generatePrivateKey())])) as Record<ForkRole, PrivateKeyAccount>);
  }

  account(role: ForkRole): PrivateKeyAccount {
    return this.accounts[role];
  }

  addresses(): Record<ForkRole, Address> {
    return Object.fromEntries(FORK_ROLES.map((r) => [r, this.accounts[r].address])) as Record<ForkRole, Address>;
  }

  /** Fund every role on the fork. `anvil_setBalance` exists only on a local node, which is the point. */
  async fund(endpoint: string, wei = 1_000n * 10n ** 18n): Promise<void> {
    assertLocalForkEndpoint(endpoint, "fork keyring funding");
    for (const r of FORK_ROLES) {
      await jsonRpc(endpoint, "anvil_setBalance", [this.accounts[r].address, `0x${wei.toString(16)}`]);
    }
  }
}

/** The label the reality package gives Anvil's own accounts; ours carry the same one. */
export const FORK_KEY_LABEL = LOCAL_FORK_ONLY;

/* ───────────────────────────── ABIs ───────────────────────────── */

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);

export const WETH_ABI = parseAbi(["function deposit() payable"]);

export const AAVE_POOL_ABI = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

export const CHAINLINK_FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

export const POLICY_REGISTRY_ABI = parseAbi([
  "function setPolicyAdmin(bytes32 agentIdentityHash, address admin)",
  "function setPolicy(bytes32 agentIdentityHash, bytes32 policyHash, bool enabled, uint256 maxValueHardCap)",
  "function setTargetAllowed(bytes32 agentIdentityHash, bytes32 policyHash, address target, bool allowed)",
  "function setActionAllowed(bytes32 agentIdentityHash, bytes32 policyHash, bytes32 actionKind, bool allowed)",
  "function policyAdmin(bytes32 agentIdentityHash) view returns (address)",
  "function isPolicyEnabled(bytes32 agentIdentityHash, bytes32 policyHash) view returns (bool)",
  "function isTargetAllowed(bytes32 agentIdentityHash, bytes32 policyHash, address target) view returns (bool)",
  "function isActionAllowed(bytes32 agentIdentityHash, bytes32 policyHash, bytes32 actionKind) view returns (bool)",
  "function maxValueHardCap(bytes32 agentIdentityHash, bytes32 policyHash) view returns (uint256)",
  "function bindingVersion(bytes32 agentIdentityHash) view returns (uint64)",
]);

export const IDENTITY_ABI = parseAbi([
  "function bind(bytes32 agentIdentityHash, address agent)",
  "function revoke(bytes32 agentIdentityHash)",
  "function boundAgent(bytes32 agentIdentityHash) view returns (address)",
  "function isIdentityCurrent(bytes32 agentIdentityHash, address agent) view returns (bool)",
]);

export const APPROVAL_REGISTRY_ABI = parseAbi([
  "function setExecutor(address next)",
  "function approvalDigest(bytes32 capabilityDigest, address approver_, uint64 expiresAt) view returns (bytes32)",
  "function submitApproval(bytes32 capabilityDigest, uint64 expiresAt, bytes signature)",
  "function isApprovalValid(bytes32 capabilityDigest) view returns (bool)",
  "function approver() view returns (address)",
]);

export const AUTH_REGISTRY_ABI = parseAbi([
  "function recordAuthorization(bytes32 authorizationId, bytes32 requestHash, bytes32 policyHash, bytes32 contextCommitment, uint64 approvedAt, uint64 approvedUntil, uint8 verdict)",
]);

/** The executor's `execute`. Written out because `parseAbi` cannot express the nested tuple. */
export const EXECUTOR_ABI = [
  {
    type: "function", name: "execute", stateMutability: "payable", outputs: [{ type: "bytes" }],
    inputs: [
      {
        name: "cap", type: "tuple",
        components: [
          { name: "version", type: "uint8" }, { name: "agentIdentityHash", type: "bytes32" },
          { name: "agent", type: "address" }, { name: "chainId", type: "uint256" },
          { name: "executor", type: "address" }, { name: "target", type: "address" },
          { name: "value", type: "uint256" }, { name: "calldataHash", type: "bytes32" },
          { name: "intentHash", type: "bytes32" }, { name: "policyHash", type: "bytes32" },
          { name: "authorizationId", type: "bytes32" }, { name: "contextCommitment", type: "bytes32" },
          { name: "issuedAt", type: "uint64" }, { name: "expiresAt", type: "uint64" },
          { name: "nonce", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" }, { name: "callData", type: "bytes" }, { name: "actionKind", type: "bytes32" },
    ],
  },
] as const;

/* ───────────────────────────── compiled artifacts ───────────────────────────── */

export const CORE_CONTRACTS = ["ContextLockPolicyRegistry", "ContextLockAuthorizationRegistry", "LocalAgentIdentityVerifier", "ContextLockApprovalRegistry", "ContextLockExecutor", "ContextLockCreConsumer"] as const;
export type CoreContract = (typeof CORE_CONTRACTS)[number];

const ARTIFACT_DIR: Record<CoreContract, string> = {
  ContextLockPolicyRegistry: "contracts/out/ContextLockPolicyRegistry.sol/ContextLockPolicyRegistry.json",
  ContextLockAuthorizationRegistry: "contracts/out/ContextLockAuthorizationRegistry.sol/ContextLockAuthorizationRegistry.json",
  LocalAgentIdentityVerifier: "contracts/out/LocalAgentIdentityVerifier.sol/LocalAgentIdentityVerifier.json",
  ContextLockExecutor: "contracts/out/ContextLockExecutor.sol/ContextLockExecutor.json",
  ContextLockCreConsumer: "contracts/out/ContextLockCreConsumer.sol/ContextLockCreConsumer.json",
  ContextLockApprovalRegistry: "contracts/out/ContextLockApprovalRegistry.sol/ContextLockApprovalRegistry.json",
};

export interface CompiledContract { abi: readonly unknown[]; bytecode: Hex }

/**
 * The Foundry artifact for a core contract.
 *
 * Read from `contracts/out`, i.e. what `forge build` produced from the audited sources. There is
 * no second copy of the bytecode in this package.
 */
export function compiledContract(name: CoreContract, root = "."): CompiledContract {
  const raw = JSON.parse(readFileSync(`${root}/${ARTIFACT_DIR[name]}`, "utf8")) as { abi: unknown[]; bytecode: { object: string } };
  return { abi: raw.abi, bytecode: raw.bytecode.object as Hex };
}

export function artifactsPresent(root = "."): boolean {
  try {
    for (const c of CORE_CONTRACTS) compiledContract(c, root);
    return true;
  } catch {
    return false;
  }
}

/* ───────────────────────────── clients ───────────────────────────── */

export function upstreamClient(url: string): PublicClient {
  return createPublicClient({ chain: mainnet, transport: http(url) });
}

export function forkPublicClient(endpoint: string): PublicClient {
  return createPublicClient({ chain: anvil, transport: http(endpoint) });
}

export function forkWalletClient(endpoint: string, account: PrivateKeyAccount): WalletClient {
  return createWalletClient({ account, chain: anvil, transport: http(endpoint) });
}

/** A `ChainReader` over the fork, for the control plane's observer. */
export function forkChainReader(endpoint: string): ChainReader {
  const client = forkPublicClient(endpoint);
  return {
    chainId: 31337,
    live: true,
    getChainId: () => client.getChainId(),
    getCode: (a) => client.getCode({ address: a }),
    getBalance: (a) => client.getBalance({ address: a }),
    getTransactionCount: async (a) => BigInt(await client.getTransactionCount({ address: a })),
    estimateGas: (tx) => client.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value: tx.value }),
    estimateFeesPerGas: async () => {
      const f = await client.estimateFeesPerGas();
      return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas, gasPrice: undefined };
    },
    call: async (tx) => (await client.call({ account: tx.from, to: tx.to, data: tx.data, value: tx.value })).data ?? "0x",
    getTransactionReceipt: async (hash) => {
      const r = await client.getTransactionReceipt({ hash }).catch(() => null);
      return r ? { status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, contractAddress: r.contractAddress ?? null } : null;
    },
    getBlockNumber: () => client.getBlockNumber(),
  };
}

export async function jsonRpc(endpoint: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export async function waitForRpc(endpoint: string, attempts = 120, intervalMs = 500): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await jsonRpc(endpoint, "eth_chainId");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`the fork at ${endpoint} never answered eth_chainId`);
}
