/**
 * P9.6 — serves the operator console.
 *
 * Deliberately a tiny static server plus a few read-only JSON endpoints rather than a framework.
 * The UI's job is to make the protocol legible to a reviewer, and every number it shows is read
 * from the real deployment manifest, real demo results, or live Sepolia. Nothing is mocked.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { createPublicClient, http as vhttp, type Address } from "viem";
import { sepolia } from "viem/chains";
import { ENS_V2_SEPOLIA as ENS, ETH_REGISTRY_ABI } from "../packages/ens/src/deployments.js";

const ROOT = join(import.meta.dirname, "..");
const WEB = join(ROOT, "apps/web");
const PORT = Number(process.env.WEB_PORT ?? 3000);
const RPC = process.env.SEPOLIA_RPC_URL;
const pub = RPC ? createPublicClient({ chain: sepolia, transport: vhttp(RPC) }) : null;

const readJson = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const MIME: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" };

const IDENTITY_ABI = [
  { type: "function", name: "computeIdentityHash", stateMutability: "pure", inputs: [{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "isIdentityCurrent", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;
const TARGET_ABI = [{ type: "function", name: "callCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
const AUTHREG_ABI = [{ type: "function", name: "authorizer", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

/** Live chain state for the security dashboard. Read-only; never mutates anything. */
async function liveState() {
  const m = readJson(join(ROOT, "deployments/sepolia.json"));
  if (!pub || !m) return { available: false, reason: RPC ? "manifest missing" : "SEPOLIA_RPC_URL not set" };
  try {
    const labelId = BigInt(m.ens.labelId);
    const [chainId, block] = await Promise.all([pub.getChainId(), pub.getBlockNumber()]);
    const tokenId = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getTokenId", args: [labelId] }) as bigint;
    const owner = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "ownerOf", args: [tokenId] }) as Address;
    const expiry = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getExpiry", args: [labelId] }) as bigint;
    const aih = await pub.readContract({ address: m.contracts.EnsAgentIdentityVerifier as Address, abi: IDENTITY_ABI, functionName: "computeIdentityHash", args: [ENS.ethRegistry, labelId, owner, m.roles.agent as Address, tokenId, 1n] }) as `0x${string}`;
    const identityCurrent = await pub.readContract({ address: m.contracts.EnsAgentIdentityVerifier as Address, abi: IDENTITY_ABI, functionName: "isIdentityCurrent", args: [aih, m.roles.agent as Address] }) as boolean;
    const callCount = await pub.readContract({ address: m.contracts.MockTreasuryTarget as Address, abi: TARGET_ABI, functionName: "callCount" }) as bigint;
    const authorizer = await pub.readContract({ address: m.contracts.ContextLockAuthorizationRegistry as Address, abi: AUTHREG_ABI, functionName: "authorizer" }) as string;
    return {
      available: true, chainId, block: block.toString(),
      ens: { name: m.ens.agentName, node: m.ens.node, owner, tokenId: tokenId.toString(),
             expiry: expiry.toString(), expiryIso: new Date(Number(expiry) * 1000).toISOString(), identityCurrent, agentIdentityHash: aih },
      target: { address: m.contracts.MockTreasuryTarget, callCount: callCount.toString() },
      authorizationWriter: authorizer,
      writerIsConsumer: authorizer.toLowerCase() === m.contracts.ContextLockCreConsumer.toLowerCase(),
    };
  } catch (e) {
    return { available: false, reason: (e as Error).message.split("\n")[0] };
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const send = (code: number, body: string, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };

  if (url.pathname === "/api/manifest") return send(200, JSON.stringify(readJson(join(ROOT, "deployments/sepolia.json"))));
  if (url.pathname === "/api/demo-results") return send(200, JSON.stringify(readJson(join(WEB, "demo-results.json")) ?? { results: [] }));
  if (url.pathname === "/api/cre-baseline") {
    const p = join(ROOT, "docs/CRE_MODE_BASELINE.md");
    return send(200, JSON.stringify({ text: existsSync(p) ? readFileSync(p, "utf8") : "" }));
  }
  if (url.pathname === "/api/live") return send(200, JSON.stringify(await liveState()));

  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const p = join(WEB, file);
  if (!p.startsWith(WEB) || !existsSync(p)) return send(404, JSON.stringify({ error: "not found" }));
  return send(200, readFileSync(p, "utf8"), MIME[extname(p)] ?? "text/plain");
}).listen(PORT, () => {
  console.log(`ContextLock console → http://localhost:${PORT}`);
  console.log(RPC ? "live Sepolia reads enabled" : "SEPOLIA_RPC_URL not set — live panel will show unavailable");
});
