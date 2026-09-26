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
}

/** The chains Kido targets and which address family each belongs to. */
export const CHAINS: ChainProfile[] = [
  { chainId: "ethereum-sepolia", family: "evm", label: "Ethereum", aliases: ["ethereum", "eth", "sepolia", "evm"] },
  { chainId: "sui-testnet", family: "sui", label: "Sui", aliases: ["sui"] },
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
