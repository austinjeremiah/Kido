/// Live ENSv2 (Sepolia) identity flow for one Kido agent:
///   register <org>.eth → agent subname with its own resolver + discovery records → resolve → revoke → verify.
///   KIDO_OPERATOR_KEY=<Sepolia gas key> SEPOLIA_RPC_URL=<rpc> npx tsx scripts/identity-live.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { blueprintHash, emptyBlueprint, nextRevision } from "@kido/blueprint";
import { ProviderRegistry } from "@kido/registry";
import { EnsIdentityAdapter, SuiNsIdentityAdapter, assertPublicSafe, buildPublicManifest, compileIdentityPlan } from "@kido/identity";

const need = (k: string) => process.env[k] ?? (() => { throw new Error(`${k} is required`); })();
const reg = new ProviderRegistry();
const rpc = need("SEPOLIA_RPC_URL");
const publicClient = createPublicClient({ chain: sepolia, transport: http(rpc) });
const wallet = createWalletClient({ chain: sepolia, transport: http(rpc), account: privateKeyToAccount(need("KIDO_OPERATOR_KEY") as Hex) });
const ens = new EnsIdentityAdapter(publicClient as never, wallet as never, reg.get("ens")!.deployments["ethereum-sepolia"] as never);

const org = `kido${Date.now().toString(36)}`;
const base = emptyBlueprint(`${org}-treasury`, "live", "dual-chain treasury agent");
const bp = nextRevision(base, {
  chains: ["ethereum-sepolia", "sui-testnet"],
  identity: { ...base.identity, public: true, organization: org, advertisedCapabilities: ["kido:pay"], endpoints: { web: "https://kido.example/agents/treasury" } },
  agents: [{ role: "PaymentAgent", owns: ["PAY"], mayRequest: [], knowledgePacks: [] }],
});
const manifest = buildPublicManifest(bp, blueprintHash(bp), { endpoints: { web: "https://kido.example/agents/treasury" } });
const plan = compileIdentityPlan(bp, reg, manifest);
const evidence: Record<string, unknown> = { kidoAgentId: bp.kidoAgentId, plan: plan.map(({ records, ...p }) => ({ ...p, recordKeys: Object.keys(records) })) };
const log = (k: string, v: unknown) => {
  evidence[k] = v;
  console.log(k, JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
};

const ensPlan = plan.find((p) => p.providerId === "ens")!;
assertPublicSafe(ensPlan.records, bp);
const parentLabel = ensPlan.parent.replace(/\.eth$/, "");
log("register", await ens.register(parentLabel, wallet.account.address));
log("subname", await ens.createSubIdentity(ensPlan.parent, ensPlan.label, ensPlan.records));
const resolved = await ens.resolve(ensPlan.name);
log("resolve", { found: resolved.found, kidoAgentId: resolved.kidoAgentId, keys: Object.keys(resolved.records) });
if (resolved.kidoAgentId !== bp.kidoAgentId) throw new Error("resolved KidoAgentId does not match the blueprint");
log("revoke", await ens.revoke(ensPlan.name, "CLEAR_RECORDS"));
const after = await ens.resolve(ensPlan.name);
log("afterRevoke", { found: after.found, kidoAgentId: after.kidoAgentId, keys: Object.keys(after.records) });

const suiPlan = plan.find((p) => p.providerId === "suins")!;
const suins = new SuiNsIdentityAdapter(new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" }));
log("suinsRegister", await suins.register(suiPlan.label));
log("suinsPlan", { name: suiPlan.name, liveCapable: suiPlan.liveCapable, blockers: suiPlan.blockers });

const out = resolve(process.env.KIDO_EVIDENCE_DIR ?? "../.gauntlet/evidence", `identity-live-${Date.now()}.json`);
mkdirSync(resolve(out, ".."), { recursive: true });
writeFileSync(out, JSON.stringify(evidence, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
console.log(`evidence: ${out}`);
