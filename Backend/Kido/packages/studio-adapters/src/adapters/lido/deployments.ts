/**
 * Lido deployments the adapter will construct against.
 *
 * stETH is the staking entrypoint: `submit()` is payable on the token itself. Both entries were
 * verified by reading `name()` — "Liquid staked Ether 2.0" — from the contract. A chain not listed
 * here is refused, never guessed.
 */

export interface LidoDeployment {
  chainId: number;
  network: string;
  /** The stETH token, which is also the staking entrypoint. */
  steth: `0x${string}`;
  source: string;
  verifiedOn: string;
  verifiedOnChain: boolean;
}

export const LIDO_DEPLOYMENTS: LidoDeployment[] = [
  {
    chainId: 11155111,
    network: "sepolia",
    steth: "0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af",
    source: "https://docs.lido.fi/deployed-contracts/sepolia",
    verifiedOn: "2026-09-11",
    verifiedOnChain: true,
  },
  {
    chainId: 1,
    network: "mainnet",
    steth: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
    source: "https://docs.lido.fi/deployed-contracts/",
    verifiedOn: "2026-09-11",
    verifiedOnChain: true,
  },
];

export class UnknownLidoDeploymentError extends Error {
  constructor(chainId: number) {
    super(`no verified Lido deployment recorded for chain ${chainId}; refusing to guess the stETH address`);
    this.name = "UnknownLidoDeploymentError";
  }
}

export function lidoDeploymentFor(chainId: number): LidoDeployment {
  const d = LIDO_DEPLOYMENTS.find((x) => x.chainId === chainId);
  if (!d) throw new UnknownLidoDeploymentError(chainId);
  return d;
}
