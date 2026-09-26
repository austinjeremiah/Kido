/**
 * Publishes a deployed agent's identity on ENSv2 (Sepolia), as the owner of the parent name:
 *
 *   <agent>.<org>.eth                 its own resolver and registry; text records (agent-context
 *                                     manifest with the Amane account id and accounts, kido-agent-id,
 *                                     description) and multichain addresses: the Sepolia account
 *                                     (coin 60 and the ENSIP-11 Sepolia coin type) and the Sui account (784)
 *   <role>.<agent>.<org>.eth × N      one per specialist: its role, the agent id, the same accounts
 *
 * Names are discovery only; the records say so. Idempotent: an existing name only has its records
 * rewritten. Results land in the project (identityPublished, activity).
 *
 * Env: FUNDER_PRIVATE_KEY (owner of the parent name), KIDO_PROJECT, KIDO_MAX_ETH, SEPOLIA_RPC_URL.
 */
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { blueprintHash } from "@kido/blueprint";
import { ENS_COIN, EnsIdentityAdapter, buildPublicManifest, type EnsDeployment } from "@kido/identity";
import { ProviderRegistry, rpcUrl } from "@kido/registry";
import { createFoundry, loadConfig } from "../src/index.js";

const need = (k: string) => process.env[k] ?? (console.log(JSON.stringify({ status: "BLOCKED_ENV", missing: k })), process.exit(2));
const P = need("KIDO_PROJECT");
const maxEth = parseEther(need("KIDO_MAX_ETH"));
const foundry = createFoundry(loadConfig());
const rec = foundry.loadRecord(P);
const bp = rec.revisions.at(-1)!;
const dec = <T>(v: unknown): T => JSON.parse(JSON.stringify(v), (_k, x) => (x && typeof x === "object" && "$big" in x ? BigInt(x.$big) : x)) as T;
const dep = rec.deployment ? dec<{ accountId: Hex; status: string; chains: Record<string, { account?: string }> }>(rec.deployment) : null;
if (!dep || dep.status !== "ACTIVE") throw new Error("deploy the agent before publishing its identity: the records carry its accounts");

const reg = new ProviderRegistry();
const ensChain = reg.get("ens")!.chains[0]!;
const d = reg.get("ens")!.deployments[ensChain] as unknown as EnsDeployment;
const transport = http(rpcUrl(ensChain));
const pub = createPublicClient({ chain: sepolia, transport });
const pk = need("FUNDER_PRIVATE_KEY");
const owner = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
const wallet = createWalletClient({ chain: sepolia, transport, account: owner });
const ens = new EnsIdentityAdapter(pub as never, wallet as never, d);

const plan = rec.identityPlan.filter((b) => b.providerId === "ens");
const root = plan.find((b) => !b.role);
if (!root) throw new Error("this agent has no ENS name planned");
const parent = root.parent;
const parentOwner = await ens.owner(parent);
if (parentOwner?.toLowerCase() !== owner.address.toLowerCase()) throw new Error(`${parent} is owned by ${parentOwner ?? "nobody"}, not the owner wallet ${owner.address}`);

// Multichain addresses: the agent's Amane accounts, one name for both chains.
const evmChainId = Number((foundry.manifest as unknown as { evm: { chainId: number } }).evm.chainId);
const evmAcct = Object.entries(dep.chains).find(([c]) => c.startsWith("ethereum"))?.[1].account as Hex | undefined;
const suiAcct = Object.entries(dep.chains).find(([c]) => c.startsWith("sui"))?.[1].account;
const addresses = [
  ...(evmAcct ? [{ coinType: ENS_COIN.eth, address: evmAcct }, { coinType: ENS_COIN.evmChain(evmChainId), address: evmAcct }] : []),
  ...(suiAcct ? [{ coinType: ENS_COIN.sui, address: suiAcct as Hex }] : []),
];
const accounts = Object.fromEntries(Object.entries(dep.chains).filter(([, s]) => s.account).map(([c, s]) => [c, s.account!]));
const manifest = buildPublicManifest(bp, blueprintHash(bp), { amaneAccountId: dep.accountId, accounts, bindings: plan.filter((b) => !b.role).concat(rec.identityPlan.filter((b) => b.providerId === "suins" && !b.role)).map((b) => ({ provider: b.providerId, chain: b.chain, name: b.name })) });
const liveName = `live.${root.name}`;
const rootRecords = {
  "agent-context": JSON.stringify(manifest),
  "kido-agent-id": bp.kidoAgentId,
  description: `Kido agent · ${bp.objective.summary ?? "agent"} on ${bp.chains.join(" + ")} · ${bp.agents.length} specialists. Authority is enforced by its Amane accounts, never by this name.`,
  "kido-live": liveName,
};

const ethStart = await pub.getBalance({ address: owner.address });
const guard = async () => {
  const spent = ethStart - (await pub.getBalance({ address: owner.address }));
  if (spent > maxEth) throw new Error(`ETH spend ${formatEther(spent)} above the approved ${formatEther(maxEth)}`);
};
const published: NonNullable<typeof rec.identityPublished> = [];
const log = (r: { name: string; status: string; txs: string[]; detail?: string }) => console.log(`${r.status === "CONFIRMED" ? "PASS" : "FAIL"}  ${r.name.padEnd(44)} ${r.txs.length} tx  ${r.detail ?? ""}`);

const r0 = await ens.publishName(root.name, rootRecords, addresses, { withSubregistry: true });
log(r0);
if (r0.status !== "CONFIRMED") process.exit(1);
published.push({ providerId: "ens", chain: ensChain, name: root.name, ...(r0.resolver ? { resolver: r0.resolver } : {}), ...(r0.registry ? { registry: r0.registry } : {}), txs: r0.txs, at: Date.now() });
await guard();
for (const b of plan.filter((x) => x.role)) {
  const agent = bp.agents.find((a) => a.role === b.role);
  const r = await ens.publishName(b.name, { "kido-agent-id": bp.kidoAgentId, "kido-agent-role": b.role!, description: `${b.role} of ${root.name}: owns ${agent?.owns.join(", ") || "nothing"}. Acts only through the agent's lease.` }, addresses);
  log(r);
  published.push({ providerId: "ens", chain: ensChain, name: b.name, role: b.role!, ...(r.resolver ? { resolver: r.resolver } : {}), txs: r.txs, at: Date.now() });
  await guard();
}

const p2 = foundry.loadRecord(P);
p2.identityPublished = [...(p2.identityPublished ?? []).filter((x) => !published.some((y) => y.name === x.name)), ...published];
p2.events = [...(p2.events ?? []), ...published.map((x) => ({ at: x.at, type: "identity.published", chain: ensChain, detail: `${x.name} published on ENSv2${x.role ? ` (${x.role})` : ""}`, tx: x.txs.at(-1) }))];
foundry.saveRecord(p2);
console.log(`ETH spent ${formatEther(ethStart - (await pub.getBalance({ address: owner.address })))}`);
