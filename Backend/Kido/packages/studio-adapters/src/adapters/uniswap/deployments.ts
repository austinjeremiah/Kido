/**
 * Uniswap deployment registry.
 *
 * Addresses are read from the official deployments page and recorded here with the source and the
 * date they were verified. Never guessed, never inferred from a pattern, never taken from a blog
 * post — a wrong router address is a transaction sent to a contract nobody audited, and it would
 * pass every check that does not know what the right address is.
 */

export interface UniswapDeployment {
  chainId: number;
  network: string;
  universalRouter: `0x${string}`;
  permit2: `0x${string}`;
  poolManager?: `0x${string}`;
  positionManager?: `0x${string}`;
  quoter?: `0x${string}`;
  stateView?: `0x${string}`;
  source: string;
  verifiedOn: string;
}

export const UNISWAP_DEPLOYMENTS: Record<number, UniswapDeployment> = {
  11155111: {
    chainId: 11155111,
    network: "sepolia",
    universalRouter: "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
    positionManager: "0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4",
    quoter: "0x61b3f2011a92d183c7dbadbda940a7555ccf9227",
    stateView: "0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c",
    source: "https://developers.uniswap.org/docs/protocols/v4/deployments",
    verifiedOn: "2026-09-08",
  },
};

/**
 * Chains the HOSTED Trading API serves, from its own OpenAPI document.
 *
 * Sepolia is deliberately absent — the hosted API has no testnet (FND-V2-007). Declaring the real
 * list means the resolver refuses to select the hosted mode for a Sepolia requirement, rather than
 * that being a convention someone has to remember.
 */
export const TRADING_API_CHAINS = [1, 10, 130, 137, 8453, 42161] as const;

export const TRADING_API_BASE = "https://trade-api.gateway.uniswap.org/v1";

export function deploymentFor(chainId: number): UniswapDeployment {
  const d = UNISWAP_DEPLOYMENTS[chainId];
  if (!d) {
    throw new Error(
      `no verified Uniswap deployment recorded for chain ${chainId}; refusing to guess a router address`,
    );
  }
  return d;
}
