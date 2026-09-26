import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
const API = "http://127.0.0.1:4310", P = "proj_e4be779a-421";
const pk = process.env.FUNDER_PRIVATE_KEY!;
const owner = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
const rpc = http(process.env.SEPOLIA_RPC_URL || undefined);
const pub = createPublicClient({ chain: sepolia, transport: rpc });
const wallet = createWalletClient({ chain: sepolia, transport: rpc, account: owner });
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`); return j as T;
}
function revive(td: any) {
  const rev = (type: string, v: any): any => Object.fromEntries(td.types[type].map((f: any) => { const base = f.type.replace(/\[\]$/, ""); const one = (x: any): any => (td.types[base] ? rev(base, x) : /^u?int\d*$/.test(base) ? BigInt(x) : x); const x = v[f.name]; return [f.name, f.type.endsWith("[]") ? x.map(one) : one(x)]; }));
  const { EIP712Domain: _d, ...types } = td.types;
  return { domain: { ...td.domain, ...(td.domain.chainId !== undefined ? { chainId: BigInt(td.domain.chainId) } : {}) }, types, primaryType: td.primaryType, message: rev(td.primaryType, td.message) };
}
const before = await pub.getBalance({ address: owner.address });
const prep = await call<{ messages: any[] }>("POST", `/projects/${P}/control/revoke/prepare`);
const signed = [];
for (const m of prep.messages) signed.push({ chain: m.chain, message: m.message, signature: await owner.signTypedData(revive(m.typedData)) });
const r = await call<{ transactions: any[]; results: unknown[] }>("POST", `/projects/${P}/control/revoke`, { signed });
console.log("sui/relayed results", JSON.stringify(r.results).slice(0, 300));
for (const tx of r.transactions) {
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, chain: sepolia });
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log("sent", tx.label, hash, rc.status);
  await call("POST", `/projects/${P}/deploy/tx`, { chain: "ethereum-sepolia", label: tx.label, tx: hash });
}
const rt = await call<any>("GET", `/projects/${P}/runtime`);
console.log("leases now", rt.chains.map((c: any) => `${c.chain}:${c.leaseStatus}`).join(" "));
console.log("retire", JSON.stringify(await call("POST", `/projects/${P}/deploy/retire`)));
console.log("eth spent", formatEther(before - (await pub.getBalance({ address: owner.address }))));
