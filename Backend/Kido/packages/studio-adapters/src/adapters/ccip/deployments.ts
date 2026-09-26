/**
 * CCIP deployments, verified on chain.
 *
 * Nothing here was copied from a documentation table. Each router was asked `typeAndVersion()`, and
 * each lane was confirmed by calling `isChainSupported(destinationSelector)` on the router itself —
 * the contract that would refuse the send is the contract that was asked.
 *
 * Reproduce with: `npx tsx scripts/studio/verify-ccip-deployments.ts`
 *
 *   Ethereum Sepolia 0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59
 *     typeAndVersion : Router 1.2.0
 *     supports 10344971235874465080 : true
 *   Base Sepolia     0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93
 *     typeAndVersion : Router 1.2.0
 *     supports 16015286601757825753 : true
 */

export interface CcipDeployment {
  chainId: number;
  /**
   * Decimal uint64, as a STRING.
   *
   * 16015286601757825753 > Number.MAX_SAFE_INTEGER. Held as a number it silently becomes
   * 16015286601757826000 — a different chain, or no chain, decided by floating point. Every
   * comparison in this codebase is a string comparison for that reason.
   */
  chainSelector: string;
  router: `0x${string}`;
  routerTypeAndVersion: string;
  name: string;
  isTestnet: true;
  verifiedOnChain: true;
  verifiedOn: string;
}

export const CCIP_DEPLOYMENTS: Record<number, CcipDeployment> = {
  11155111: {
    chainId: 11155111,
    chainSelector: "16015286601757825753",
    router: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59",
    routerTypeAndVersion: "Router 1.2.0",
    name: "ethereum-testnet-sepolia",
    isTestnet: true,
    verifiedOnChain: true,
    verifiedOn: "2026-09-08",
  },
  84532: {
    chainId: 84532,
    chainSelector: "10344971235874465080",
    router: "0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93",
    routerTypeAndVersion: "Router 1.2.0",
    name: "ethereum-testnet-sepolia-base-1",
    isTestnet: true,
    verifiedOnChain: true,
    verifiedOn: "2026-09-08",
  },
};

/** Lanes confirmed by `isChainSupported` on the source router, in the direction stated. */
export const VERIFIED_LANES: Array<{ sourceChainId: number; destinationChainId: number }> = [
  { sourceChainId: 11155111, destinationChainId: 84532 },
  { sourceChainId: 84532, destinationChainId: 11155111 },
];

export class UnknownCcipChainError extends Error {
  constructor(chainId: number) {
    super(`CCIP-UNKNOWN-CHAIN: chain ${chainId} has no verified CCIP deployment in this build`);
    this.name = "UnknownCcipChainError";
  }
}

export function ccipDeploymentFor(chainId: number): CcipDeployment {
  const d = CCIP_DEPLOYMENTS[chainId];
  if (!d) throw new UnknownCcipChainError(chainId);
  return d;
}

/** Chain id for a selector. Refuses rather than guessing — an unknown selector is not a chain. */
export function chainIdForSelector(selector: string): number | null {
  for (const d of Object.values(CCIP_DEPLOYMENTS)) if (d.chainSelector === selector) return d.chainId;
  return null;
}

export function laneIsVerified(sourceChainId: number, destinationChainId: number): boolean {
  return VERIFIED_LANES.some((l) => l.sourceChainId === sourceChainId && l.destinationChainId === destinationChainId);
}
