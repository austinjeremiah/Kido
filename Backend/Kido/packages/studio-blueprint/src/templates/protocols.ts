import type { Action, ContextLockAgentBlueprint } from "../schema.js";

/**
 * The protocol catalogue: what the Architecture Agent may give an agent to DO.
 *
 * Every entry here is an action a registered execution adapter can construct, decode and validate,
 * on a protocol whose deployment was verified on chain. The model picks action ids from this list
 * by `actionRef`; it cannot invent one, and an action it names that is not here does not enter the
 * Blueprint. The shape of each action — protocol-resolved target, self-only recipient, bounded
 * approvals — is fixed here rather than chosen per build, because those are the properties the
 * executor re-checks and a design that could vary them could be talked out of them.
 *
 * `family` is what the simulation engine groups scenarios by: a lending action is exercised by the
 * health-factor scenarios, a staking action is not, and a swap is exercised by neither.
 */

export type ProtocolFamily = "lending" | "dex" | "staking";

type Protocol = ContextLockAgentBlueprint["protocols"][number];
type Asset = ContextLockAgentBlueprint["assets"][number];
type DataRequirement = ContextLockAgentBlueprint["dataRequirements"][number];
type ContextSource = ContextLockAgentBlueprint["contextSources"][number];

export interface ProtocolCatalogueEntry {
  id: string;
  displayName: string;
  family: ProtocolFamily;
  protocol: Protocol;
  actions: Action[];
  assets: Asset[];
  dataRequirements: DataRequirement[];
  contextSources: ContextSource[];
  /** The execution capability a registered adapter declares for each action kind. */
  capabilityFor: Record<string, string>;
}

const SEPOLIA = 11155111 as const;

const unknownAt = (reason: string) => ({ known: false as const, reason, requiredBefore: "DEPLOY" as const });

const exactApproval = (assetSymbol: string, spenderRole: string) => ({
  assetSymbol, spenderRole, unlimited: false as const, maxAmountPolicy: "exact-action-amount" as const,
});

const USDC: Asset = { symbol: "USDC", decimals: 6, chainId: SEPOLIA, address: unknownAt("Testnet token address is supplied at deployment time.") };
const WETH: Asset = { symbol: "WETH", decimals: 18, chainId: SEPOLIA, address: unknownAt("Testnet token address is supplied at deployment time.") };
const ETH: Asset = { symbol: "ETH", decimals: 18, chainId: SEPOLIA, address: unknownAt("The chain's native asset; it has no contract address.") };

/* ─────────────────────────────── Aave v3 ─────────────────────────────── */

export const AAVE: ProtocolCatalogueEntry = {
  id: "aave",
  displayName: "Aave-style lending pool",
  family: "lending",
  protocol: {
    id: "aave", displayName: "Aave-style lending pool", kind: "lending", chainId: SEPOLIA,
    contracts: [{ role: "pool", address: unknownAt("Testnet pool address is supplied at deployment time.") }],
  },
  actions: [
    {
      id: "repay-debt", kind: "AAVE_REPAY", displayName: "Repay outstanding debt", protocolRef: "aave",
      targetPolicy: { mode: "protocol-resolved", protocolRef: "aave", contractRole: "pool" },
      recipientPolicy: { mode: "self-only" }, spendsAssets: ["USDC"], approvals: [exactApproval("USDC", "pool")],
    },
    {
      id: "add-collateral", kind: "AAVE_SUPPLY", displayName: "Add collateral to the position", protocolRef: "aave",
      targetPolicy: { mode: "protocol-resolved", protocolRef: "aave", contractRole: "pool" },
      recipientPolicy: { mode: "self-only" }, spendsAssets: ["USDC"], approvals: [exactApproval("USDC", "pool")],
    },
  ],
  assets: [USDC],
  dataRequirements: [
    { key: "positionHealth", kind: "aave_position_health_factor", chainId: SEPOLIA, minimumTrustClass: "DIRECT_CHAIN_DATA", maxAgeMs: 60_000, confidential: false, historical: false },
    { key: "collateralPrice", kind: "collateral_asset_usd_price", chainId: SEPOLIA, minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 30_000, confidential: false, historical: false },
  ],
  contextSources: [
    { id: "position-health", dataKind: "aave_position_health_factor", minimumTrustClass: "DIRECT_CHAIN_DATA", maxAgeMs: 60_000, fallbackAllowed: false, placement: "cre-confidential" },
    { id: "collateral-price", dataKind: "collateral_asset_usd_price", minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 30_000, fallbackAllowed: false, placement: "cre-confidential" },
  ],
  capabilityFor: { AAVE_REPAY: "REPAY", AAVE_SUPPLY: "SUPPLY" },
};

/* ─────────────────────────────── Morpho Blue ─────────────────────────────── */

export const MORPHO: ProtocolCatalogueEntry = {
  id: "morpho",
  displayName: "Morpho Blue",
  family: "lending",
  protocol: {
    id: "morpho", displayName: "Morpho Blue", kind: "lending", chainId: SEPOLIA,
    contracts: [{ role: "morpho", address: unknownAt("The Morpho Blue singleton comes from the adapter's verified deployment registry at build time.") }],
  },
  actions: [
    {
      id: "morpho-repay", kind: "MORPHO_REPAY", displayName: "Repay Morpho Blue debt in the position's market", protocolRef: "morpho",
      targetPolicy: { mode: "protocol-resolved", protocolRef: "morpho", contractRole: "morpho" },
      recipientPolicy: { mode: "self-only" }, spendsAssets: ["USDC"], approvals: [exactApproval("USDC", "morpho")],
    },
    {
      id: "morpho-supply-collateral", kind: "MORPHO_SUPPLY_COLLATERAL", displayName: "Add collateral to the Morpho Blue position", protocolRef: "morpho",
      targetPolicy: { mode: "protocol-resolved", protocolRef: "morpho", contractRole: "morpho" },
      recipientPolicy: { mode: "self-only" }, spendsAssets: ["WETH"], approvals: [exactApproval("WETH", "morpho")],
    },
  ],
  assets: [USDC, WETH],
  dataRequirements: [
    { key: "morphoHealth", kind: "morpho_position_health_factor", chainId: SEPOLIA, minimumTrustClass: "DIRECT_CHAIN_DATA", maxAgeMs: 60_000, confidential: false, historical: false },
    { key: "collateralPrice", kind: "collateral_asset_usd_price", chainId: SEPOLIA, minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 30_000, confidential: false, historical: false },
  ],
  contextSources: [
    { id: "morpho-position-health", dataKind: "morpho_position_health_factor", minimumTrustClass: "DIRECT_CHAIN_DATA", maxAgeMs: 60_000, fallbackAllowed: false, placement: "cre-confidential" },
    { id: "collateral-price", dataKind: "collateral_asset_usd_price", minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 30_000, fallbackAllowed: false, placement: "cre-confidential" },
  ],
  capabilityFor: { MORPHO_REPAY: "MORPHO_REPAY", MORPHO_SUPPLY_COLLATERAL: "MORPHO_SUPPLY_COLLATERAL" },
};

/* ─────────────────────────────── Compound v3 ─────────────────────────────── */

export const COMPOUND: ProtocolCatalogueEntry = {
  id: "compound",
  displayName: "Compound v3 (Comet)",
  family: "lending",
  protocol: {
    id: "compound", displayName: "Compound v3 (Comet)", kind: "lending", chainId: SEPOLIA,
    contracts: [{ role: "comet", address: unknownAt("The Comet market comes from the adapter's verified deployment registry at build time.") }],
  },
  actions: [
    {
      id: "compound-repay", kind: "COMPOUND_REPAY", displayName: "Repay Compound v3 base-asset debt", protocolRef: "compound",
      targetPolicy: { mode: "protocol-resolved", protocolRef: "compound", contractRole: "comet" },
      recipientPolicy: { mode: "self-only" }, spendsAssets: ["USDC"], approvals: [exactApproval("USDC", "comet")],
    },
    {
      id: "compound-supply", kind: "COMPOUND_SUPPLY", displayName: "Add collateral to the Compound v3 position", protocolRef: "compound",
      targetPolicy: { mode: "protocol-resolved", protocolRef: "compound", contractRole: "comet" },
      recipientPolicy: { mode: "self-only" }, spendsAssets: ["WETH"], approvals: [exactApproval("WETH", "comet")],
    },
  ],
  assets: [USDC, WETH],
  dataRequirements: [
    { key: "compoundHealth", kind: "compound_position_health_factor", chainId: SEPOLIA, minimumTrustClass: "DIRECT_CHAIN_DATA", maxAgeMs: 60_000, confidential: false, historical: false },
    { key: "collateralPrice", kind: "collateral_asset_usd_price", chainId: SEPOLIA, minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 30_000, confidential: false, historical: false },
  ],
  contextSources: [
    { id: "compound-position-health", dataKind: "compound_position_health_factor", minimumTrustClass: "DIRECT_CHAIN_DATA", maxAgeMs: 60_000, fallbackAllowed: false, placement: "cre-confidential" },
    { id: "collateral-price", dataKind: "collateral_asset_usd_price", minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 30_000, fallbackAllowed: false, placement: "cre-confidential" },
  ],
  capabilityFor: { COMPOUND_REPAY: "COMPOUND_REPAY", COMPOUND_SUPPLY: "COMPOUND_SUPPLY" },
};

/* ─────────────────────────────── Lido ─────────────────────────────── */

export const LIDO: ProtocolCatalogueEntry = {
  id: "lido",
  displayName: "Lido staking",
  family: "staking",
  protocol: {
    id: "lido", displayName: "Lido staking", kind: "staking", chainId: SEPOLIA,
    contracts: [{ role: "steth", address: unknownAt("The stETH contract comes from the adapter's verified deployment registry at build time.") }],
  },
  actions: [
    {
      // The stETH is minted to the caller — under ContextLock, the vault the user's funds sit in.
      id: "stake-eth", kind: "LIDO_STAKE", displayName: "Stake ETH held by the vault with Lido", protocolRef: "lido",
      targetPolicy: { mode: "protocol-resolved", protocolRef: "lido", contractRole: "steth" },
      recipientPolicy: { mode: "self-only" }, spendsAssets: ["ETH"], approvals: [],
    },
  ],
  assets: [ETH],
  dataRequirements: [
    { key: "stethBalance", kind: "lido_steth_balance", chainId: SEPOLIA, minimumTrustClass: "DIRECT_CHAIN_DATA", maxAgeMs: 60_000, confidential: false, historical: false },
    { key: "ethPrice", kind: "eth_usd_price", chainId: SEPOLIA, minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 30_000, confidential: false, historical: false },
  ],
  contextSources: [
    { id: "steth-balance", dataKind: "lido_steth_balance", minimumTrustClass: "DIRECT_CHAIN_DATA", maxAgeMs: 60_000, fallbackAllowed: false, placement: "cre-confidential" },
    { id: "eth-price", dataKind: "eth_usd_price", minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 30_000, fallbackAllowed: false, placement: "cre-confidential" },
  ],
  capabilityFor: { LIDO_STAKE: "LIDO_STAKE" },
};

/* ─────────────────────────────── DEX router ─────────────────────────────── */

/** The swap action and router protocol live in `aave-guardian.ts` (`swapAction`, `routerProtocol`); this entry names them for the catalogue. */
export const DEX_ROUTER_ID = "dex-router";

export const PROTOCOL_CATALOGUE: ReadonlyArray<ProtocolCatalogueEntry> = [AAVE, MORPHO, COMPOUND, LIDO];

export function catalogueEntryFor(protocolId: string): ProtocolCatalogueEntry | null {
  return PROTOCOL_CATALOGUE.find((p) => p.id === protocolId) ?? null;
}

/** The action ids the architecture stage may reference, plus the swap. */
export function catalogueActionIds(): string[] {
  return [...PROTOCOL_CATALOGUE.flatMap((p) => p.actions.map((a) => a.id)), "swap-tokens"];
}

/** The family an action kind belongs to, or null for a kind the catalogue does not know. */
export function familyOfActionKind(kind: string): ProtocolFamily | null {
  if (kind === "TOKEN_SWAP") return "dex";
  const entry = PROTOCOL_CATALOGUE.find((p) => p.actions.some((a) => a.kind === kind));
  return entry?.family ?? null;
}

/** The execution capability the adapter registry declares for an action kind. */
export function capabilityForActionKind(kind: string): string | null {
  if (kind === "TOKEN_SWAP") return "TOKEN_SWAP";
  for (const p of PROTOCOL_CATALOGUE) if (p.capabilityFor[kind]) return p.capabilityFor[kind]!;
  return null;
}
