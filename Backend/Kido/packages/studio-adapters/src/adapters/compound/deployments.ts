/**
 * Compound v3 (Comet) deployments the adapter will construct against.
 *
 * Comet is one contract per market, and each market has one base asset. The USDC markets are
 * recorded: both were verified by reading `baseToken()` from the contract — Sepolia answers the
 * Sepolia USDC (0x1c7D…7238, the same asset the Aave adapter's fixtures use) and mainnet answers
 * mainnet USDC. A chain not listed here is refused, never guessed.
 */

export interface CompoundDeployment {
  chainId: number;
  network: string;
  market: string;
  /** The Comet proxy for this market. */
  comet: `0x${string}`;
  baseToken: `0x${string}`;
  baseTokenSymbol: string;
  baseTokenDecimals: number;
  source: string;
  verifiedOn: string;
  verifiedOnChain: boolean;
}

export const COMPOUND_DEPLOYMENTS: CompoundDeployment[] = [
  {
    chainId: 11155111,
    network: "sepolia",
    market: "cUSDCv3",
    comet: "0xAec1F48e02Cfb822Be958B68C7957156EB3F0b6e",
    baseToken: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    baseTokenSymbol: "USDC",
    baseTokenDecimals: 6,
    source: "https://docs.compound.finance/#networks",
    verifiedOn: "2026-09-11",
    verifiedOnChain: true,
  },
  {
    chainId: 1,
    network: "mainnet",
    market: "cUSDCv3",
    comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
    baseToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    baseTokenSymbol: "USDC",
    baseTokenDecimals: 6,
    source: "https://docs.compound.finance/#networks",
    verifiedOn: "2026-09-11",
    verifiedOnChain: true,
  },
];

export class UnknownCompoundMarketError extends Error {
  constructor(chainId: number) {
    super(`no verified Compound v3 market recorded for chain ${chainId}; refusing to guess a Comet address`);
    this.name = "UnknownCompoundMarketError";
  }
}

export function compoundDeploymentFor(chainId: number): CompoundDeployment {
  const d = COMPOUND_DEPLOYMENTS.find((x) => x.chainId === chainId);
  if (!d) throw new UnknownCompoundMarketError(chainId);
  return d;
}
