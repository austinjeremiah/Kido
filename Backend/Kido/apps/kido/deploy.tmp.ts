import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const API = "http://127.0.0.1:4310", P = "proj_e4be779a-421";
const pk = process.env.FUNDER_PRIVATE_KEY!;
const owner = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
const rpc = http(process.env.SEPOLIA_RPC_URL || undefined);
const pub = createPublicClient({ chain: sepolia, transport: rpc });
const wallet = createWalletClient({ chain: sepolia, transport: rpc, account: owner });
const keys = JSON.parse(readFileSync("/Users/kaushikh/Kido Master/.gauntlet/keys/testnet-demo.json", "utf8"));
const recoverySui: string = keys.suiRecovery;
const log: Record<string, unknown>[] = [];
const note = (m: string, x: Record<string, unknown> = {}) => { console.log(m, Object.keys(x).length ? JSON.stringify(x) : ""); log.push({ at: new Date().toISOString(), m, ...x }); };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j as T;
}
type Tx = { chainId: number; to?: `0x${string}`; data: `0x${string}`; label: string };
async function send(tx: Tx) {
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, chain: sepolia });
  const r = await pub.waitForTransactionReceipt({ hash });
  const cost = r.gasUsed * r.effectiveGasPrice;
  note(`sent: ${tx.label}`, { hash, status: r.status, gasUsed: r.gasUsed.toString(), costEth: formatEther(cost) });
  if (r.status !== "success") throw new Error(`${tx.label} reverted`);
  return hash;
}
function revive(td: { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }) {
  const rev = (type: string, v: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(td.types[type]!.map((f) => {
    const base = f.type.replace(/\[\]$/, "");
    const one = (x: unknown): unknown => (td.types[base] ? rev(base, x as Record<string, unknown>) : /^u?int\d*$/.test(base) ? BigInt(x as string) : x);
    const x = v[f.name];
    return [f.name, f.type.endsWith("[]") ? (x as unknown[]).map(one) : one(x)];
  }));
  const { EIP712Domain: _d, ...types } = td.types;
  const domain = { ...td.domain, ...(td.domain.chainId !== undefined ? { chainId: BigInt(td.domain.chainId as string) } : {}) };
  return { domain, types, primaryType: td.primaryType, message: rev(td.primaryType, td.message) };
}

const before = await pub.getBalance({ address: owner.address });
note("owner", { owner: owner.address, ethBefore: formatEther(before), recoverySui });
let st = await call<{ deployment: any }>("GET", `/projects/${P}/deployment`);
let d = st.deployment;
if (!d) {
  const r = await call<{ deployment: any; transactions: Tx[] }>("POST", `/projects/${P}/deploy/start`, { owner: owner.address, recoverySui });
  d = r.deployment;
  note("started", { accountId: d.accountId, sui: d.chains["sui-testnet"]?.account, suiTx: d.chains["sui-testnet"]?.deployTx });
  for (const tx of r.transactions) {
    const h = await send(tx);
    d = (await call<{ deployment: any }>("POST", `/projects/${P}/deploy/evm-account`, { txHash: h })).deployment;
    note("evm account", { account: d.chains["ethereum-sepolia"]?.account });
  }
}
if (d.status === "STARTED" || d.status === "ACCOUNTS_READY") {
  const pol = await call<{ typedData: any; summary: any }>("GET", `/projects/${P}/deploy/policy`);
  note("policy", pol.summary);
  const sig = await owner.signTypedData(revive(pol.typedData) as never);
  const r = await call<{ deployment: any; transactions: Tx[] }>("POST", `/projects/${P}/deploy/policy`, { signature: sig });
  d = r.deployment;
  note("policy signed; Sui installed + lease activated by relayer", { suiInstall: d.chains["sui-testnet"]?.install, suiActivate: d.chains["sui-testnet"]?.activate, leaseId: d.leaseId });
  for (const tx of r.transactions) {
    const h = await send(tx);
    await call("POST", `/projects/${P}/deploy/tx`, { chain: "ethereum-sepolia", label: tx.label, tx: h });
  }
}
const c = await call<{ active: boolean; runtime: any }>("POST", `/projects/${P}/deploy/confirm`);
const after = await pub.getBalance({ address: owner.address });
note("confirm", { active: c.active, chains: c.runtime.chains.map((x: any) => ({ chain: x.chain, account: x.account, policyVersion: x.policyVersion, lease: x.leaseStatus, paused: x.paused, error: x.error })), ethSpent: formatEther(before - after) });
writeFileSync("/Users/kaushikh/Kido Master/.gauntlet/state/treasury-deploy.json", JSON.stringify(log, null, 2));
