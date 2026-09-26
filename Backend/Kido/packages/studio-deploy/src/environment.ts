import { z } from "zod";
import { fenceWriteByChain } from "@contextlock/studio-network";

/**
 * The deployment environment.
 *
 * P22's whole reason for existing is a distinction the rest of the product must never blur:
 *
 *     DEPLOYMENT IS NOT ACTIVATION, AND A DEPLOYMENT PLAN IS NOT FINANCIAL AUTHORITY.
 *
 * An environment is where that distinction is made mechanical. It is not a label on a config
 * object; it is the object that answers "may this write happen at all?", and it answers before any
 * cost is estimated, any wallet is consulted or any approval screen is drawn.
 *
 * Until P27 there is exactly one honest answer for mainnet, and it is no.
 */

export const DEPLOYMENT_ENVIRONMENT_VERSION = "contextlock.deployment-environment/v1" as const;

export const EnvironmentKindSchema = z.enum([
  /** In-process / anvil. Disposable, nothing outside this machine observes it. */
  "LOCAL",
  /** A fork of a live chain. Reads are real, writes land nowhere real. */
  "FORK",
  /** A public test network. Real transactions, valueless assets. */
  "TESTNET",
  /** Mainnet state, read-only. Exists so mainnet behaviour can be observed without touching it. */
  "SHADOW_MAINNET",
  /** The real thing. Prohibited until P27. */
  "MAINNET",
]);
export type EnvironmentKind = z.infer<typeof EnvironmentKindSchema>;

export const ENVIRONMENT_REASONS = {
  MAINNET_WRITE_PROHIBITED: "ENV-MAINNET-WRITE-PROHIBITED",
  SHADOW_MAINNET_READ_ONLY: "ENV-SHADOW-MAINNET-READ-ONLY",
  CHAIN_NOT_IN_ENVIRONMENT: "ENV-CHAIN-NOT-IN-ENVIRONMENT",
  CHAIN_ID_MISMATCH: "ENV-CHAIN-ID-MISMATCH",
  WALLET_CHAIN_MISMATCH: "ENV-WALLET-CHAIN-MISMATCH",
  UNKNOWN_ENVIRONMENT: "ENV-UNKNOWN-ENVIRONMENT",
  MAINNET_CONTROL_PLANE_PROHIBITED: "MAINNET_CONTROL_PLANE_PROHIBITED",
} as const;
export type EnvironmentReason = (typeof ENVIRONMENT_REASONS)[keyof typeof ENVIRONMENT_REASONS];

export class EnvironmentError extends Error {
  constructor(readonly reason: EnvironmentReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "EnvironmentError";
  }
}

export const ChainTargetSchema = z.object({
  chainId: z.number().int().positive(),
  name: z.string().min(1),
  /**
   * CCIP-style uint64 selector, as a decimal STRING.
   *
   * Group D learned this the expensive way: `Number("16015286601757825753")` and
   * `Number("16015286601757825754")` are the same double. A selector that round-trips through a
   * JSON number is a selector that can silently name a different chain, and `cre workflow
   * supported-chains --output json` emits them as bare numbers, so anything that parses that output
   * with a stock JSON parser has already lost the low bits.
   */
  chainSelector: z.string().regex(/^\d+$/, "decimal uint64 as a string").nullable(),
  /** Native currency symbol. Display only — every calculation is in wei. */
  nativeSymbol: z.string().min(1),
  nativeDecimals: z.number().int().min(0).max(36),
  /** A block explorer base URL, so a receipt can be checked by a human rather than believed. */
  explorer: z.string().url().nullable(),
});
export type ChainTarget = z.infer<typeof ChainTargetSchema>;

export const DeploymentEnvironmentSchema = z.object({
  schemaVersion: z.literal(DEPLOYMENT_ENVIRONMENT_VERSION),
  environmentId: z.string().min(1),
  kind: EnvironmentKindSchema,
  chains: z.array(ChainTargetSchema).min(1),
  /**
   * Whether onchain writes may be attempted here AT ALL.
   *
   * Stored rather than derived so it appears in the manifest hash: an approval is an approval of an
   * environment that said writes were permitted, and flipping this later must invalidate it.
   */
  writesPermitted: z.boolean(),
  /** CRE registries this environment may target. See cre.ts for why mainnet is not among them. */
  allowedCreRegistries: z.array(z.string()).default([]),
});
export type DeploymentEnvironment = z.infer<typeof DeploymentEnvironmentSchema>;

/**
 * Whether an environment kind may perform onchain writes, before P27.
 *
 * A function rather than a table entry, because the answer for MAINNET is not configuration. There
 * is no flag anywhere that turns it on: the phase gate is the gate, and a product that shipped a
 * boolean for this would eventually ship the boolean set to true.
 */
export function writesAllowedFor(kind: EnvironmentKind): boolean {
  switch (kind) {
    case "LOCAL":
    case "FORK":
    case "TESTNET":
      return true;
    case "SHADOW_MAINNET":
    case "MAINNET":
      return false;
  }
}

/** Chain IDs that are mainnets. Named so a TESTNET environment cannot smuggle one in. */
export const KNOWN_MAINNET_CHAIN_IDS = new Set<number>([
  1, 10, 56, 100, 137, 8453, 42161, 43114, 59144, 534352, 324, 5000, 130, 480,
]);

/**
 * Assert that a write to `chainId` is permitted in this environment.
 *
 * Called by the planner, by the cost estimator and again by the orchestrator immediately before
 * signing. Three checks rather than one is deliberate: the interesting failure is not "someone
 * selected mainnet in the UI", it is "the environment was edited between approval and execution".
 */
export function assertWriteAllowed(env: DeploymentEnvironment, chainId: number): void {
  if (env.kind === "MAINNET") {
    throw new EnvironmentError(
      ENVIRONMENT_REASONS.MAINNET_WRITE_PROHIBITED,
      `environment "${env.environmentId}" targets MAINNET; onchain writes are prohibited until P27`,
    );
  }
  if (env.kind === "SHADOW_MAINNET") {
    throw new EnvironmentError(
      ENVIRONMENT_REASONS.SHADOW_MAINNET_READ_ONLY,
      `environment "${env.environmentId}" is SHADOW_MAINNET, which is read-only`,
    );
  }
  if (!env.writesPermitted) {
    throw new EnvironmentError(
      ENVIRONMENT_REASONS.MAINNET_WRITE_PROHIBITED,
      `environment "${env.environmentId}" does not permit writes`,
    );
  }
  const target = env.chains.find((c) => c.chainId === chainId);
  if (!target) {
    throw new EnvironmentError(
      ENVIRONMENT_REASONS.CHAIN_NOT_IN_ENVIRONMENT,
      `chain ${chainId} is not one of this environment's chains (${env.chains.map((c) => c.chainId).join(", ")})`,
    );
  }
  // A TESTNET environment listing chain 1 is not a configuration quirk, it is mainnet wearing a
  // testnet's name. Checked separately from `kind` so neither check can be the only one.
  if (KNOWN_MAINNET_CHAIN_IDS.has(chainId)) {
    throw new EnvironmentError(
      ENVIRONMENT_REASONS.MAINNET_WRITE_PROHIBITED,
      `chain ${chainId} is a known mainnet; a ${env.kind} environment may not write to it`,
    );
  }

  /*
   * And finally the product-wide fence.
   *
   * The three checks above are this package's own, and they predate the testnet-lab boundary. This
   * one is the shared guard every write-capable subsystem calls, so approving a network is a single
   * decision in a single registry rather than a condition each subsystem maintains separately.
   *
   * Keeping all four is deliberate: each catches the mainnet case, and a mutation that removes any
   * one of them leaves the others.
   */
  /*
   * By chain id, not by asserted role.
   *
   * A FORK environment legitimately writes to 31337, and a caller here asserting
   * `TESTNET_EXECUTION` would have it refused for claiming the wrong role rather than permitted for
   * doing the right thing. The registry knows what 31337 is; the caller does not have to.
   */
  fenceWriteByChain("DEPLOYMENT_PREFLIGHT", chainId);
}

/**
 * Assert that the wallet the user has connected is on the chain the step targets.
 *
 * The failure this prevents is mundane and expensive: a wallet left on a different network signs a
 * transaction the user believed was for Sepolia. The wallet will happily do it.
 */
export function assertWalletChain(expectedChainId: number, walletChainId: number): void {
  if (expectedChainId !== walletChainId) {
    throw new EnvironmentError(
      ENVIRONMENT_REASONS.WALLET_CHAIN_MISMATCH,
      `the connected wallet is on chain ${walletChainId}, but this step targets chain ${expectedChainId}`,
    );
  }
}

/** Assert an RPC endpoint is actually the chain it was configured as. */
export function assertChainIdMatches(configured: number, observed: number, rpcLabel: string): void {
  if (configured !== observed) {
    throw new EnvironmentError(
      ENVIRONMENT_REASONS.CHAIN_ID_MISMATCH,
      `${rpcLabel} reports chainId ${observed}, but it is configured as ${configured}`,
    );
  }
}

/* ─────────────────────────── the environments we ship ────────────────────────── */

export const ETHEREUM_SEPOLIA: ChainTarget = {
  chainId: 11155111,
  name: "Ethereum Sepolia",
  chainSelector: "16015286601757825753",
  nativeSymbol: "ETH",
  nativeDecimals: 18,
  explorer: "https://sepolia.etherscan.io",
};

export const BASE_SEPOLIA: ChainTarget = {
  chainId: 84532,
  name: "Base Sepolia",
  chainSelector: "10344971235874465080",
  nativeSymbol: "ETH",
  nativeDecimals: 18,
  explorer: "https://sepolia.basescan.org",
};

export function testnetEnvironment(chains: ChainTarget[] = [ETHEREUM_SEPOLIA]): DeploymentEnvironment {
  return {
    schemaVersion: DEPLOYMENT_ENVIRONMENT_VERSION,
    environmentId: `testnet-${chains.map((c) => c.chainId).join("-")}`,
    kind: "TESTNET",
    chains,
    writesPermitted: true,
    // Private only. See cre.ts: the onchain registry is an Ethereum MAINNET control-plane
    // operation even when the workflow itself only ever touches a testnet.
    allowedCreRegistries: ["private"],
  };
}

export function mainnetEnvironment(): DeploymentEnvironment {
  return {
    schemaVersion: DEPLOYMENT_ENVIRONMENT_VERSION,
    environmentId: "mainnet-1",
    kind: "MAINNET",
    chains: [
      { chainId: 1, name: "Ethereum", chainSelector: "5009297550715157269", nativeSymbol: "ETH", nativeDecimals: 18, explorer: "https://etherscan.io" },
    ],
    // Not a switch anyone flips. It is false here so that the object exists — the UI needs to be
    // able to SHOW mainnet as a target and refuse it — without being usable.
    writesPermitted: false,
    allowedCreRegistries: [],
  };
}
