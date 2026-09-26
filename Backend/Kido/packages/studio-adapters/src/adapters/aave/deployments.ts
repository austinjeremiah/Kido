/**
 * Aave v3 deployment registry.
 *
 * Only the Pool address came from documentation. Every other address was then derived from the Pool
 * itself, through its own addresses provider — so a wrong Pool address would have produced a failed
 * call rather than a plausible-looking set of siblings.
 */

export interface AaveDeployment {
  chainId: number;
  network: string;
  protocolMajor: 3;
  market: string;
  pool: `0x${string}`;
  addressesProvider: `0x${string}`;
  poolDataProvider: `0x${string}`;
  oracle: `0x${string}`;
  /** Base currency of `*Base` values. USD when BASE_CURRENCY() is the zero address. */
  baseCurrency: "USD";
  /** Read from AaveOracle.BASE_CURRENCY_UNIT(): 1e8. */
  baseCurrencyDecimals: number;
  source: string;
  verifiedOn: string;
  verifiedOnChain: boolean;
}

export const AAVE_DEPLOYMENTS: AaveDeployment[] = [
  {
    chainId: 11155111,
    network: "sepolia",
    protocolMajor: 3,
    market: "AaveV3Sepolia",
    pool: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
    addressesProvider: "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A",
    poolDataProvider: "0x3e9708d80f7B3e43118013075F7e95CE3AB31F31",
    oracle: "0x2da88497588bf89281816106C7259e31AF45a663",
    baseCurrency: "USD",
    baseCurrencyDecimals: 8,
    source: "https://aave.com/docs/developers/smart-contracts/pool",
    verifiedOn: "2026-09-08",
    verifiedOnChain: true,
  },
];

export class UnknownAaveMarketError extends Error {
  constructor(chainId: number) {
    super(`no verified Aave deployment recorded for chain ${chainId}; refusing to guess a Pool address`);
    this.name = "UnknownAaveMarketError";
  }
}

export function aaveDeploymentFor(chainId: number): AaveDeployment {
  const d = AAVE_DEPLOYMENTS.find((x) => x.chainId === chainId);
  if (!d) throw new UnknownAaveMarketError(chainId);
  return d;
}
