/**
 * Publishes a deployed agent's SuiNS names on Sui testnet in one transaction, paid by Kido's Sui
 * relayer and priced through Pyth (keyed Hermes, PYTH_ACCESS_TOKEN):
 *
 *   <org>.sui                         registered for a year, paid in SUI at the live Pyth price
 *   <agent>.<org>.sui                 a node subname → the agent's Sui Amane account
 *   <role>.<agent>.<org>.sui × N      leaf subnames → the same account
 *
 * Both name NFTs are then transferred to the owner's Sui recovery address: the owner holds the
 * names, not Kido. Names are discovery only. Results land in the project (identityPublished).
 *
 * Env: KIDO_SUI_RELAYER_KEY, KIDO_PROJECT, KIDO_MAX_SUI; KIDO_SUINS_USDC_COIN (a TESTUSDC coin, skips
 * Pyth), or KIDO_PYTH_HERMES (default the public Hermes)
 * and PYTH_ACCESS_TOKEN (sent to the keyed Pro endpoint only; it needs a grant for the SUI/USD feed).
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuinsClient, SuinsTransaction } from "@mysten/suins";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { rpcUrl } from "@kido/registry";
import { createFoundry, loadConfig } from "../src/index.js";

const need = (k: string) => process.env[k] ?? (console.log(JSON.stringify({ status: "BLOCKED_ENV", missing: k })), process.exit(2));
const foundry = createFoundry(loadConfig());
const rec = foundry.loadRecord(need("KIDO_PROJECT"));
const dec = <T>(v: unknown): T => JSON.parse(JSON.stringify(v), (_k, x) => (x && typeof x === "object" && "$big" in x ? BigInt(x.$big) : x)) as T;
const dep = rec.deployment ? dec<{ status: string; recovery: { sui?: string }; chains: Record<string, { account?: string }> }>(rec.deployment) : null;
if (!dep || dep.status !== "ACTIVE") throw new Error("deploy the agent first: the names point at its Sui account");
const suiAccount = Object.entries(dep.chains).find(([c]) => c.startsWith("sui"))?.[1].account;
const ownerSui = dep.recovery.sui;
if (!suiAccount || !ownerSui) throw new Error("the deployment has no Sui account or owner recovery address");

const plan = rec.identityPlan.filter((b) => b.providerId === "suins");
const root = plan.find((b) => !b.role);
if (!root) throw new Error("this agent has no SuiNS name planned");
const org = root.parent; // e.g. kidomuhsw6k2.sui
const agentLabel = root.label; // e.g. treasury
const leaves = plan.filter((b) => b.role);

const client = new SuiGrpcClient({ network: "testnet", baseUrl: rpcUrl("sui-testnet") });
const relayer = Ed25519Keypair.fromSecretKey(need("KIDO_SUI_RELAYER_KEY"));
const suins = new SuinsClient({ client: client as never, network: "testnet", ...(process.env.PYTH_ACCESS_TOKEN ? { pythAccessToken: process.env.PYTH_ACCESS_TOKEN } : {}) });
// The SDK fetches Pyth updates only from the keyed Pro endpoint; the same signed updates come from the
// public Hermes, so price through that (the SDK's own Pyth helpers, loaded from its package).
const hermes = process.env.KIDO_PYTH_HERMES ?? "https://hermes.pyth.network";
const suinsDir = dirname(createRequire(import.meta.url).resolve("@mysten/suins"));
type PythMod = { SuiPriceServiceConnection: new (u: string, o?: object) => { getPriceFeedsUpdateData(ids: string[]): Promise<unknown> }; SuiPythClient: new (c: unknown, p: string, w: string) => { updatePriceFeeds(tx: Transaction, d: unknown, ids: string[], fee?: unknown): Promise<string[]> } };
const { SuiPriceServiceConnection, SuiPythClient } = (await import(pathToFileURL(join(suinsDir, "pyth/pyth.mjs")).href)) as PythMod;
(suins as unknown as { getPriceInfoObject: (tx: Transaction, feed: string, feeCoin?: unknown) => Promise<string[]> }).getPriceInfoObject = async (tx, feed, feeCoin) => {
  const conn = new SuiPriceServiceConnection(hermes, process.env.PYTH_ACCESS_TOKEN && hermes.includes("dourolabs") ? { accessToken: process.env.PYTH_ACCESS_TOKEN } : {});
  const data = await conn.getPriceFeedsUpdateData([feed]);
  return new SuiPythClient(client, suins.config.pyth.pythStateId, suins.config.pyth.wormholeStateId).updatePriceFeeds(tx, data, [feed], feeCoin);
};
const maxMist = BigInt(Math.round(Number(need("KIDO_MAX_SUI")) * 1e9));

const before = BigInt((await client.core.getBalance({ owner: relayer.toSuiAddress() })).balance.balance);
const existing = await suins.getNameRecord(org).catch(() => null);
if (existing) throw new Error(`${org} is already registered (owner record ${existing.nftId}); publishing under an existing name needs its NFT holder`);

const tx = new Transaction();
tx.setSender(relayer.toSuiAddress());
const stx = new SuinsTransaction(suins, tx);
// Pay in SuiNS TESTUSDC when the relayer holds some (KIDO_SUINS_USDC_COIN; no price feed needed),
// otherwise in SUI at the Pyth price (bounded by maxAmount).
const usdcCoin = process.env.KIDO_SUINS_USDC_COIN;
const orgNft = usdcCoin
  ? stx.register({ domain: org, years: 1, coinConfig: suins.config.coins.USDC, coin: usdcCoin })
  : stx.register({ domain: org, years: 1, coinConfig: suins.config.coins.SUI, coin: tx.gas, priceInfoObjectId: (await suins.getPriceInfoObject(tx, suins.config.coins.SUI.feed))[0]!, maxAmount: maxMist });
stx.setTargetAddress({ nft: orgNft, address: suiAccount });
// The agent: a node subname that may hold the specialists' leaves, pointing at the Sui Amane account.
const expiry = Date.now() + 360 * 24 * 3600 * 1000;
const agentNft = stx.createSubName({ parentNft: orgNft, name: root.name, expirationTimestampMs: expiry, allowChildCreation: true, allowTimeExtension: true });
stx.setTargetAddress({ nft: agentNft, address: suiAccount, isSubname: true });
for (const l of leaves) stx.createLeafSubName({ parentNft: agentNft, name: l.name, targetAddress: suiAccount });
// The owner holds the names.
tx.transferObjects([orgNft, agentNft], ownerSui);

const res = await client.signAndExecuteTransaction({ transaction: tx, signer: relayer, include: { effects: true } });
const digest = (res as { Transaction?: { digest: string }; digest?: string }).Transaction?.digest ?? (res as { digest?: string }).digest ?? "";
const ok = (res as { Transaction?: { effects?: { status?: { success?: boolean } } } }).Transaction?.effects?.status?.success ?? true;
console.log(`${ok ? "PASS" : "FAIL"}  ${org} + ${root.name} + ${leaves.length} leaves  tx ${digest}`);
if (!ok) process.exit(1);
await client.waitForTransaction({ digest }).catch(() => undefined);
for (const n of [org, root.name, ...leaves.map((l) => l.name)]) {
  const r = await suins.getNameRecord(n).catch((e: Error) => ({ error: e.message }));
  console.log(`      ${n.padEnd(40)} → ${"targetAddress" in (r as object) ? (r as { targetAddress: string }).targetAddress : JSON.stringify(r).slice(0, 80)}`);
}
const after = BigInt((await client.core.getBalance({ owner: relayer.toSuiAddress() })).balance.balance);
console.log(`SUI spent ${(Number(before - after) / 1e9).toFixed(4)} · names held by ${ownerSui}`);

const p2 = foundry.loadRecord(rec.projectId);
const at = Date.now();
const entries = [{ name: org }, { name: root.name }, ...leaves.map((l) => ({ name: l.name, role: l.role! }))].map((e) => ({ providerId: "suins", chain: "sui-testnet", ...e, txs: [digest], at }));
p2.identityPublished = [...(p2.identityPublished ?? []).filter((x) => !entries.some((y) => y.name === x.name)), ...entries];
p2.events = [...(p2.events ?? []), { at, type: "identity.published", chain: "sui-testnet", detail: `${root.name} and ${leaves.length} specialist names published on SuiNS (paid via Pyth), held by the owner`, tx: digest }];
foundry.saveRecord(p2);
