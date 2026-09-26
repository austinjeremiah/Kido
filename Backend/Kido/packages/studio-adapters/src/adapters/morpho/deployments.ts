/**
 * Morpho Blue deployments the adapter will construct against.
 *
 * Morpho Blue is one singleton per chain; markets are identified by a `bytes32` id, not by an
 * address. The singleton's address is what a transaction targets, so it is the only address
 * recorded here — a market id is a parameter of the intent and is decoded from calldata.
 *
 * Both entries were verified by reading the contract: `owner()` answered and the bytecode size
 * (15,623 bytes) matches on both chains. A chain not listed here is refused, never guessed.
 */

export interface MorphoDeployment {
  chainId: number;
  network: string;
  /** The Morpho Blue singleton. */
  morpho: `0x${string}`;
  source: string;
  verifiedOn: string;
  verifiedOnChain: boolean;
}

export const MORPHO_DEPLOYMENTS: MorphoDeployment[] = [
  {
    chainId: 11155111,
    network: "sepolia",
    morpho: "0xd011EE229E7459ba1ddd22631eF7bF528d424A14",
    source: "https://docs.morpho.org/get-started/resources/addresses",
    verifiedOn: "2026-09-11",
    verifiedOnChain: true,
  },
  {
    chainId: 1,
    network: "mainnet",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    source: "https://docs.morpho.org/get-started/resources/addresses",
    verifiedOn: "2026-09-11",
    verifiedOnChain: true,
  },
];

export class UnknownMorphoDeploymentError extends Error {
  constructor(chainId: number) {
    super(`no verified Morpho Blue deployment recorded for chain ${chainId}; refusing to guess the singleton's address`);
    this.name = "UnknownMorphoDeploymentError";
  }
}

export function morphoDeploymentFor(chainId: number): MorphoDeployment {
  const d = MORPHO_DEPLOYMENTS.find((x) => x.chainId === chainId);
  if (!d) throw new UnknownMorphoDeploymentError(chainId);
  return d;
}
