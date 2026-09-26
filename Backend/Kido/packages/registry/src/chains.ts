import { isAddress } from "viem";
import { isValidSuiAddress } from "@mysten/sui/utils";
import type { ChainId } from "@kido/blueprint";

export type ChainFamily = "evm" | "sui";

export interface ChainProfile {
  chainId: ChainId;
  family: ChainFamily;
  /** How users name the chain. */
  label: string;
  aliases: string[];
  /** Environment variable that overrides the public endpoint. */
  rpcEnv: string;
  /** Public testnet endpoint used when the variable is unset. */
  publicRpc: string;
  /** Gas token symbol and decimals. */
  nativeSymbol: string;
  nativeDecimals: number;
}

/** The chains Kido targets and which address family each belongs to. */
export const CHAINS: ChainProfile[] = [
  { chainId: "ethereum-sepolia", family: "evm", label: "Ethereum", aliases: ["ethereum", "eth", "sepolia", "evm"], rpcEnv: "SEPOLIA_RPC_URL", publicRpc: "https://ethereum-sepolia-rpc.publicnode.com", nativeSymbol: "ETH", nativeDecimals: 18 },
  { chainId: "sui-testnet", family: "sui", label: "Sui", aliases: ["sui"], rpcEnv: "SUI_GRPC_URL", publicRpc: "https://fullnode.testnet.sui.io:443", nativeSymbol: "SUI", nativeDecimals: 9 },
];

/** Address validity comes from each chain's own SDK, not from local patterns. */
const VALIDATORS: Record<ChainFamily, (address: string) => boolean> = {
  evm: (a) => isAddress(a, { strict: false }),
  // Sui accepts short-form ids; Kido only pins full 32-byte addresses.
  sui: (a) => /^0x[0-9a-fA-F]+$/.test(a) && a.length === 66 && isValidSuiAddress(a),
};

export function isChainAddress(chain: string, address: string, chains: ChainProfile[] = CHAINS): boolean | undefined {
  const p = chains.find((c) => c.chainId === chain);
  return p ? VALIDATORS[p.family](address) : undefined;
}

export function rpcUrl(chain: string, env: NodeJS.ProcessEnv = process.env, chains: ChainProfile[] = CHAINS): string {
  const p = chains.find((c) => c.chainId === chain);
  if (!p) throw new Error(`no chain profile for ${chain}`);
  return env[p.rpcEnv] || p.publicRpc;
}
