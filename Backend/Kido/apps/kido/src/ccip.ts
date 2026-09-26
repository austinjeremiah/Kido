import { decodeFunctionData, encodeAbiParameters, keccak256, encodePacked, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Foundry, WalletDeployments } from "@kido/foundry";
import { ENS_COIN } from "@kido/identity";

/**
 * CCIP-read gateway (ERC-3668) for KidoLiveResolver: answers ENS queries for `live.<agent name>`
 * with the agent's state read from the chains right now, signed so the resolver contract (and any
 * client) can verify it. Keys served as text: kido.status, kido.lease-expires, kido.health-factor,
 * kido.holdings, kido.updated, kido-agent-id, description; addr() returns the agent's accounts.
 */
const RESOLVE = parseAbi(["function resolve(bytes name, bytes data) view returns (bytes)"]);
const QUERIES = parseAbi(["function text(bytes32 node, string key) view returns (string)", "function addr(bytes32 node) view returns (address)", "function addr(bytes32 node, uint256 coinType) view returns (bytes)"]);

function dnsDecode(hex: Hex): string {
  const b = Buffer.from(hex.slice(2), "hex");
  const labels: string[] = [];
  for (let i = 0; i < b.length && b[i] !== 0; i += b[i]! + 1) labels.push(b.subarray(i + 1, i + 1 + b[i]!).toString("utf8"));
  return labels.join(".");
}

export function createCcipGateway(d: { foundry: Foundry; deployments?: WalletDeployments; signerKey?: Hex; resolver?: Address; evmChainId: number; ttlSeconds?: number }) {
  const signer = d.signerKey ? privateKeyToAccount(d.signerKey) : null;
  // One chain read serves every key a client asks for in a burst (a profile view asks for several).
  const cache = new Map<string, { at: number; value: Promise<[Awaited<ReturnType<WalletDeployments["portfolio"]>> | null, Awaited<ReturnType<WalletDeployments["runtime"]>> | null]> }>();
  const state = (projectId: string) => {
    const hit = cache.get(projectId);
    if (hit && Date.now() - hit.at < 20_000) return hit.value;
    const value = Promise.all([d.deployments ? d.deployments.portfolio(projectId) : null, d.deployments ? d.deployments.runtime(projectId) : null]) as never;
    cache.set(projectId, { at: Date.now(), value });
    return value as Promise<[Awaited<ReturnType<WalletDeployments["portfolio"]>> | null, Awaited<ReturnType<WalletDeployments["runtime"]>> | null]>;
  };
  return async (data: Hex) => {
    if (!signer || !d.resolver) throw new Error("the live gateway is not configured (KIDO_CCIP_SIGNER_KEY, KIDO_LIVE_RESOLVER)");
    const { args } = decodeFunctionData({ abi: RESOLVE, data });
    const [dnsName, inner] = args as [Hex, Hex];
    const name = dnsDecode(dnsName);
    const agentName = name.replace(/^live\./, "");
    // The agent that published this name on-chain; else one that is deployed; else any that plans it.
    const named = d.foundry.projects().map((p) => d.foundry.loadRecord(p.projectId)).filter((r) => r.identityPlan.some((b) => b.name === agentName && !b.role));
    const project = named.find((r) => r.identityPublished?.some((x) => x.name === agentName)) ?? named.find((r) => r.deployment) ?? named[0];
    if (!project) throw new Error(`no agent is named ${agentName}`);
    const bp = project.revisions.at(-1)!;
    const q = decodeFunctionData({ abi: QUERIES, data: inner });
    const [pf, rt] = await state(project.projectId);
    const evm = pf?.chains.find((c) => (c as { chain: string }).chain.startsWith("ethereum")) as { account: string } | undefined;
    const sui = pf?.chains.find((c) => (c as { chain: string }).chain.startsWith("sui")) as { account: string } | undefined;
    const leaseLeft = pf?.leaseExpiresAt ? pf.leaseExpiresAt - Date.now() : null;
    const paused = rt?.chains.some((c) => c.paused) ?? false;
    const status = !pf?.deployed ? "NOT_DEPLOYED" : paused ? "PAUSED" : leaseLeft !== null && leaseLeft <= 0 ? "LEASE_EXPIRED" : (pf.status ?? "UNKNOWN");
    const pos = (pf?.positions as { healthFactor?: number | null }[] | undefined)?.find((x) => x.healthFactor !== undefined);
    const holdings = Object.fromEntries(((pf?.chains ?? []) as { chain: string; holdings: { symbol: string; amount: string; decimals: number }[] }[]).map((c) => [c.chain, Object.fromEntries(c.holdings.filter((h) => h.amount !== "0").map((h) => [h.symbol, Number(h.amount) / 10 ** h.decimals]))]));
    const text: Record<string, string> = {
      "kido.status": status,
      "kido.lease-expires": pf?.leaseExpiresAt ? new Date(pf.leaseExpiresAt).toISOString() : "",
      "kido.health-factor": pos?.healthFactor != null ? pos.healthFactor.toFixed(3) : "",
      "kido.holdings": JSON.stringify(holdings),
      "kido.updated": new Date().toISOString(),
      "kido-agent-id": bp.kidoAgentId,
      description: `Live state of ${agentName}: ${status}${pos?.healthFactor != null ? `, health factor ${pos.healthFactor.toFixed(3)}` : ""}. Read from the chains by Kido and signed; information, never authority.`,
    };
    let result: Hex;
    if (q.functionName === "text") result = encodeAbiParameters([{ type: "string" }], [text[(q.args as [Hex, string])[1]] ?? ""]);
    else if (q.functionName === "addr" && q.args.length === 1) result = encodeAbiParameters([{ type: "address" }], [(evm?.account ?? "0x0000000000000000000000000000000000000000") as Address]);
    else {
      const coin = (q.args as [Hex, bigint])[1];
      const v = coin === ENS_COIN.sui ? sui?.account : coin === ENS_COIN.eth || coin === ENS_COIN.evmChain(d.evmChainId) ? evm?.account : undefined;
      result = encodeAbiParameters([{ type: "bytes" }], [(v ?? "0x") as Hex]);
    }
    const expires = BigInt(Math.floor(Date.now() / 1000) + (d.ttlSeconds ?? 300));
    const hash = keccak256(encodePacked(["bytes2", "address", "uint64", "bytes32", "bytes32"], ["0x1900", d.resolver, expires, keccak256(data), keccak256(result)]));
    const sig = await signer.sign({ hash });
    return { data: encodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], [result, expires, sig]) };
  };
}
