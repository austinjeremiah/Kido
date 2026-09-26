import { z } from "zod";
import { lookupNetwork } from "@contextlock/studio-network";

/**
 * The canonical asset registry.
 *
 * §P27.16 states the rule and §P27.17 states the attack: **identity must not use symbol alone.**
 *
 * `USDC` is a string. Anyone can deploy a contract whose `symbol()` returns `USDC`, with eighteen
 * decimals instead of six, and a strategy that resolves assets by symbol will price a position off
 * a token it has never heard of and size it wrong by twelve orders of magnitude. The symbol is a
 * label a contract chooses for itself; the address is what it is.
 *
 * So a canonical asset is an identity with a list of deployments, each of which is a
 * (chainId, address, decimals) triple that someone reviewed. Resolution takes a chain and an
 * address. There is no function here that takes a symbol and returns a token — not a discouraged
 * one, an absent one.
 */

export const ASSET_ROLES = ["NATIVE", "WRAPPED_NATIVE", "STABLECOIN", "COLLATERAL", "LP_TOKEN", "RECEIPT_TOKEN"] as const;
export const AssetRoleSchema = z.enum(ASSET_ROLES);
export type AssetRole = z.infer<typeof AssetRoleSchema>;

export const AssetDeploymentSchema = z.object({
  chainId: z.number().int().positive(),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /**
   * The symbol THIS deployment reports on chain.
   *
   * Deliberately per-deployment rather than per-asset, because they genuinely differ: the canonical
   * asset `weth` is `WETH` on both networks, but a bridged asset is routinely `USDC.e` on one chain
   * and `USDC` on another. Hanging one symbol off the identity and comparing every deployment
   * against it would reject the real contract — which it did, the first time this registry was
   * checked against live chain data.
   */
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
  role: AssetRoleSchema,
  /** Who checked that this address is what it claims to be. Prose, and required. */
  verifiedBy: z.string().min(10),
});
export type AssetDeployment = z.infer<typeof AssetDeploymentSchema>;

export const CanonicalAssetSchema = z.object({
  /** The identity. Not a symbol — a symbol is a property of a deployment, not of an asset. */
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** A human label for the identity. Never used for resolution; `displaySymbol` says so. */
  displaySymbol: z.string().min(1),
  name: z.string().min(1),
  deployments: z.array(AssetDeploymentSchema).min(1),
});
export type CanonicalAsset = z.infer<typeof CanonicalAssetSchema>;

export const ASSET_REASONS = {
  IDENTITY_MISMATCH: "ASSET_IDENTITY_MISMATCH",
  UNKNOWN_ASSET: "ASSET_NOT_IN_REGISTRY",
  NO_DEPLOYMENT: "ASSET_HAS_NO_DEPLOYMENT_ON_CHAIN",
  CROSS_ENVIRONMENT_ADDRESS: "ASSET_ADDRESS_FROM_WRONG_NETWORK",
  DECIMALS_MISMATCH: "ASSET_DECIMALS_MISMATCH",
} as const;
export type AssetReason = (typeof ASSET_REASONS)[keyof typeof ASSET_REASONS];

export class AssetIdentityError extends Error {
  constructor(readonly reason: AssetReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "AssetIdentityError";
  }
}

const lower = (a: string): string => a.toLowerCase();

/**
 * The registry.
 *
 * Every entry was checked against the issuing protocol's own documentation, and `verifiedBy` says
 * which. A registry whose provenance is "it was in the code already" is a registry that propagates
 * one person's typo forever.
 */
const ASSETS: ReadonlyArray<CanonicalAsset> = [
  {
    id: "weth",
    displaySymbol: "WETH",
    name: "Wrapped Ether",
    deployments: [
      { chainId: 1, address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18, role: "WRAPPED_NATIVE", verifiedBy: "canonical WETH9; read live on Ethereum mainnet in P27 — symbol WETH, decimals 18" },
      { chainId: 11155111, address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", symbol: "WETH", decimals: 18, role: "WRAPPED_NATIVE", verifiedBy: "read live on Sepolia in P27 — symbol WETH, decimals 18; used by the P19 Uniswap lane" },
    ],
  },
  {
    id: "usdc",
    displaySymbol: "USDC",
    name: "USD Coin",
    deployments: [
      { chainId: 1, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6, role: "STABLECOIN", verifiedBy: "Circle's published Ethereum mainnet USDC; read live in P27 — symbol USDC, decimals 6" },
      { chainId: 11155111, address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", symbol: "USDC", decimals: 6, role: "STABLECOIN", verifiedBy: "Circle's published Sepolia USDC; read live in P27 — symbol USDC, decimals 6" },
    ],
  },
  {
    id: "dai",
    displaySymbol: "DAI",
    name: "Dai Stablecoin",
    deployments: [
      { chainId: 1, address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18, role: "STABLECOIN", verifiedBy: "MakerDAO's published Ethereum mainnet DAI; read live in P27 — symbol DAI, decimals 18" },
    ],
  },
];

const BY_ID = new Map(ASSETS.map((a) => [a.id, a]));
const BY_CHAIN_ADDRESS = new Map<string, { asset: CanonicalAsset; deployment: AssetDeployment }>();
for (const asset of ASSETS) {
  for (const d of asset.deployments) BY_CHAIN_ADDRESS.set(`${d.chainId}:${lower(d.address)}`, { asset, deployment: d });
}

export function canonicalAssets(): ReadonlyArray<CanonicalAsset> {
  return ASSETS;
}

export function assetById(id: string): CanonicalAsset | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Resolve a (chain, address) pair to a canonical asset.
 *
 * The only resolution function, and it takes an address. **There is deliberately no
 * `assetBySymbol`** — see `REALITY-011`, which enumerates this module's exports and fails if one
 * appears that resolves on a symbol.
 */
export function resolveAsset(chainId: number, address: string): { asset: CanonicalAsset; deployment: AssetDeployment } | null {
  return BY_CHAIN_ADDRESS.get(`${chainId}:${lower(address)}`) ?? null;
}

/**
 * Confirm an observed token really is the asset it claims to be.
 *
 * Takes what a contract SAYS about itself — its symbol and decimals, as read on chain — and checks
 * them against what the registry knows. Three independent checks, and each has its own test:
 *
 *   1. the address is registered on this chain at all
 *   2. the symbol matches the registered asset
 *   3. the decimals match the registered deployment
 *
 * Any one failing is `ASSET_IDENTITY_MISMATCH`. Note that (2) and (3) can only be reached once (1)
 * has passed — a token at an unknown address is refused before its self-description is considered,
 * because a hostile token's self-description is exactly what should not be trusted.
 */
export function assertAssetIdentity(
  observed: { chainId: number; address: string; symbol: string; decimals: number },
  expectedAssetId: string,
): { asset: CanonicalAsset; deployment: AssetDeployment } {
  const expected = BY_ID.get(expectedAssetId);
  if (!expected) {
    throw new AssetIdentityError(ASSET_REASONS.UNKNOWN_ASSET, `"${expectedAssetId}" is not a canonical asset. Mapping must be explicitly reviewed and configured, not inferred.`);
  }

  const found = resolveAsset(observed.chainId, observed.address);
  if (!found) {
    throw new AssetIdentityError(
      ASSET_REASONS.IDENTITY_MISMATCH,
      `${observed.address} on chain ${observed.chainId} is not a registered deployment of any canonical asset. It reports the symbol "${observed.symbol}", and a symbol is a string a contract chooses for itself.`,
    );
  }

  if (found.asset.id !== expected.id) {
    throw new AssetIdentityError(
      ASSET_REASONS.IDENTITY_MISMATCH,
      `${observed.address} on chain ${observed.chainId} is ${found.asset.id}, and this position expected ${expected.id}. The symbol it reports is "${observed.symbol}".`,
    );
  }

  if (observed.symbol !== found.deployment.symbol) {
    throw new AssetIdentityError(
      ASSET_REASONS.IDENTITY_MISMATCH,
      `the contract at ${observed.address} reports the symbol "${observed.symbol}" and the registry recorded "${found.deployment.symbol}" for that deployment. A registered address whose symbol changed is a token that is not what it was.`,
    );
  }

  if (observed.decimals !== found.deployment.decimals) {
    throw new AssetIdentityError(
      ASSET_REASONS.DECIMALS_MISMATCH,
      `the contract at ${observed.address} reports ${observed.decimals} decimals and the registry has ${found.deployment.decimals}. Pricing a balance with the wrong exponent is wrong by a factor of 10^${Math.abs(observed.decimals - found.deployment.decimals)}.`,
    );
  }

  return found;
}

/**
 * The mainnet → testnet mapping, and the thing it is NOT.
 *
 * §P27.18: a mapping applies to **semantic asset identity**, not to contract authority. A mainnet
 * observation about ETH informs a Sepolia decision about ETH. What must never happen is the mainnet
 * *address* travelling into a Sepolia transaction: on Sepolia that address is either nothing at all
 * or, worse, somebody else's contract, and an approval or transfer aimed at it is a loss.
 *
 * So this returns the deployment registered for the TARGET chain, looked up by canonical identity,
 * and throws if none exists. It never returns the source deployment as a fallback.
 */
export function mapAssetToChain(assetId: string, targetChainId: number): AssetDeployment {
  const asset = BY_ID.get(assetId);
  if (!asset) throw new AssetIdentityError(ASSET_REASONS.UNKNOWN_ASSET, `"${assetId}" is not a canonical asset`);

  const deployment = asset.deployments.find((d) => d.chainId === targetChainId);
  if (!deployment) {
    const known = asset.deployments.map((d) => `${d.chainId}`).join(", ");
    throw new AssetIdentityError(
      ASSET_REASONS.NO_DEPLOYMENT,
      `${asset.id} has no reviewed deployment on chain ${targetChainId} (known: ${known}). A strategy cannot act on an asset that does not exist on its execution network, and substituting the address from another chain would aim the transaction at whatever happens to live there.`,
    );
  }
  return deployment;
}

/**
 * Refuse an address that belongs to a different network than the one being written to.
 *
 * The single most dangerous copy in this phase, and it gets its own guard so it can be mutated on
 * its own. Called wherever a shadow decision is recompiled for a testnet target.
 */
export function assertAddressBelongsToChain(address: string, targetChainId: number, context: string): void {
  const found = BY_CHAIN_ADDRESS.get(`${targetChainId}:${lower(address)}`);
  if (found) return;

  // Where does it belong? A specific answer makes the error diagnostic rather than merely negative.
  for (const [key, entry] of BY_CHAIN_ADDRESS) {
    const [chainIdStr, addr] = key.split(":");
    if (addr === lower(address)) {
      const sourceChain = Number(chainIdStr);
      const sourceName = lookupNetwork(sourceChain)?.canonicalName ?? `chain ${sourceChain}`;
      const targetName = lookupNetwork(targetChainId)?.canonicalName ?? `chain ${targetChainId}`;
      throw new AssetIdentityError(
        ASSET_REASONS.CROSS_ENVIRONMENT_ADDRESS,
        `${context}: ${address} is ${entry.asset.id} on ${sourceName}, and this transaction targets ${targetName}. Addresses are not portable between networks — the same bytes on ${targetName} are a different contract or none at all.`,
      );
    }
  }

  throw new AssetIdentityError(
    ASSET_REASONS.CROSS_ENVIRONMENT_ADDRESS,
    `${context}: ${address} is not a reviewed deployment on chain ${targetChainId}`,
  );
}
