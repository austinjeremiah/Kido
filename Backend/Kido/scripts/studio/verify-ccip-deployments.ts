/**
 * Verify CCIP routers on chain. Nothing here is taken from documentation or memory: each address is
 * asked what it is, and asked whether it supports the lane we intend to use.
 */
import { createPublicClient, http, parseAbi } from "viem";

const ABI = parseAbi([
  "function typeAndVersion() view returns (string)",
  "function isChainSupported(uint64 destChainSelector) view returns (bool)",
  "function getSupportedTokens(uint64 chainSelector) view returns (address[])",
]);

const SEPOLIA = { chainId: 11155111, selector: 16015286601757825753n, rpc: process.env.SEPOLIA_RPC_URL! };
const BASE_SEPOLIA = { chainId: 84532, selector: 10344971235874465080n, rpc: "https://sepolia.base.org" };

// Candidates to interrogate. If one is not a CCIP router, typeAndVersion() reverts or returns junk.
const CANDIDATES: Record<string, `0x${string}`[]> = {
  sepolia: ["0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59"],
  baseSepolia: ["0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93"],
};

async function probe(name: string, rpc: string, chainId: number, addrs: `0x${string}`[], destSelector: bigint) {
  const c = createPublicClient({ transport: http(rpc) });
  const id = await c.getChainId();
  if (id !== chainId) throw new Error(`${name}: RPC reports chain ${id}, expected ${chainId}`);
  for (const address of addrs) {
    try {
      const tv = await c.readContract({ address, abi: ABI, functionName: "typeAndVersion" });
      let supported: boolean | string = "n/a";
      try {
        supported = await c.readContract({ address, abi: ABI, functionName: "isChainSupported", args: [destSelector] });
      } catch (e) { supported = `isChainSupported reverted: ${(e as Error).message.slice(0, 60)}`; }
      let tokens: readonly `0x${string}`[] | string = [];
      try {
        tokens = await c.readContract({ address, abi: ABI, functionName: "getSupportedTokens", args: [destSelector] });
      } catch (e) { tokens = `getSupportedTokens reverted (expected on v1.5+)`; }
      console.log(`${name} ${address}\n  typeAndVersion : ${tv}\n  chainId        : ${id}\n  supports ${destSelector} : ${supported}\n  tokens         : ${Array.isArray(tokens) ? tokens.join(", ") || "(none returned)" : tokens}`);
    } catch (e) {
      console.log(`${name} ${address}\n  NOT A CCIP ROUTER: ${(e as Error).message.slice(0, 120)}`);
    }
  }
}

async function main() {
  await probe("Ethereum Sepolia", SEPOLIA.rpc, SEPOLIA.chainId, CANDIDATES.sepolia!, BASE_SEPOLIA.selector);
  console.log();
  await probe("Base Sepolia    ", BASE_SEPOLIA.rpc, BASE_SEPOLIA.chainId, CANDIDATES.baseSepolia!, SEPOLIA.selector);
}
void main();
