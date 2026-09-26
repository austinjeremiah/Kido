/**
 * Deploys KidoLiveResolver (CCIP-read, ERC-3668) on Sepolia and registers `live.<agent name>` on
 * ENSv2 with it as the resolver, so the name answers with the agent's live state from Kido's
 * gateway, signed by the gateway key. Prints the resolver address for KIDO_LIVE_RESOLVER.
 *
 * Env: FUNDER_PRIVATE_KEY (owner of the agent name), KIDO_PROJECT, KIDO_CCIP_SIGNER_KEY,
 * KIDO_CCIP_URL (default the local API), KIDO_MAX_ETH, SEPOLIA_RPC_URL.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { EnsIdentityAdapter, type EnsDeployment } from "@kido/identity";
import { ProviderRegistry, rpcUrl } from "@kido/registry";
import { createFoundry, loadConfig } from "../src/index.js";

const need = (k: string) => process.env[k] ?? (console.log(JSON.stringify({ status: "BLOCKED_ENV", missing: k })), process.exit(2));
const foundry = createFoundry(loadConfig());
const rec = foundry.loadRecord(need("KIDO_PROJECT"));
const root = rec.identityPlan.find((b) => b.providerId === "ens" && !b.role);
if (!root) throw new Error("this agent has no ENS name planned");
const liveName = `live.${root.name}`;
const url = process.env.KIDO_CCIP_URL ?? "http://127.0.0.1:4310/ccip/{sender}/{data}.json";
const signer = privateKeyToAccount(need("KIDO_CCIP_SIGNER_KEY") as Hex);

const reg = new ProviderRegistry();
const chain = reg.get("ens")!.chains[0]!;
const transport = http(rpcUrl(chain));
const pub = createPublicClient({ chain: sepolia, transport });
const pk = need("FUNDER_PRIVATE_KEY");
const owner = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
const wallet = createWalletClient({ chain: sepolia, transport, account: owner });
const maxEth = parseEther(need("KIDO_MAX_ETH"));
const ethStart = await pub.getBalance({ address: owner.address });

const art = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../contracts/out/KidoLiveResolver.sol/KidoLiveResolver.json"), "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };
let resolver = process.env.KIDO_LIVE_RESOLVER as Hex | undefined;
if (!resolver) {
  const hash = await wallet.deployContract({ abi: art.abi as never, bytecode: art.bytecode.object, args: [url, signer.address] });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed ${hash}`);
  resolver = r.contractAddress;
  console.log(`PASS  KidoLiveResolver deployed ${resolver}  tx ${hash}  gateway ${url}  signer ${signer.address}`);
}
if (ethStart - (await pub.getBalance({ address: owner.address })) > maxEth) throw new Error("over the approved spend");

const ens = new EnsIdentityAdapter(pub as never, wallet as never, reg.get("ens")!.deployments[chain] as unknown as EnsDeployment);
const r = await ens.publishName(liveName, {}, [], { resolver });
console.log(`${r.status === "CONFIRMED" ? "PASS" : "FAIL"}  ${liveName} → resolver ${resolver}  ${r.txs.length} tx  ${r.detail ?? ""}`);
const p2 = foundry.loadRecord(rec.projectId);
p2.identityPublished = [...(p2.identityPublished ?? []).filter((x) => x.name !== liveName), { providerId: "ens", chain, name: liveName, role: "live", resolver, txs: r.txs, at: Date.now() }];
p2.events = [...(p2.events ?? []), { at: Date.now(), type: "identity.published", chain, detail: `${liveName} → CCIP-read live resolver ${resolver}`, tx: r.txs.at(-1) }];
foundry.saveRecord(p2);
console.log(`KIDO_LIVE_RESOLVER=${resolver}`);
console.log(`ETH spent ${formatEther(ethStart - (await pub.getBalance({ address: owner.address })))}`);
