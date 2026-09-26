/**
 * Dual-chain identity E2E: one KidoAgentId, bound through ENS (Sepolia, live) and SuiNS (Sui
 * testnet: live reads, registration blocked). Neither name is the root identity; each advertises the
 * same KidoAgentId and lists the other binding.
 *
 * Env: SEPOLIA_RPC_URL, FUNDER_PRIVATE_KEY (owner of the ENS parent name; gas only).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { blueprintHash, nextRevision } from "@kido/blueprint";
import { RuleBasedInterviewModel } from "@kido/design-interview";
import { FileProjectStore, Foundry } from "@kido/foundry";
import { EnsIdentityAdapter, SuiNsIdentityAdapter, assertPublicSafe, buildPublicManifest, verifyBinding } from "@kido/identity";
import { loadAmaneManifest } from "@kido/amane-bridge";
import { ProviderRegistry, rpcUrl } from "@kido/registry";

const pk = process.env.FUNDER_PRIVATE_KEY as Hex | undefined;
if (!pk) {
  console.log(JSON.stringify({ status: "BLOCKED_ENV", missing: "FUNDER_PRIVATE_KEY" }));
  process.exit(2);
}
const registry = new ProviderRegistry();
const transport = http(rpcUrl("ethereum-sepolia"));
const publicClient = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account: privateKeyToAccount(pk) });
const ens = new EnsIdentityAdapter(publicClient as never, wallet as never, registry.get("ens")!.deployments["ethereum-sepolia"] as never);
const suins = new SuiNsIdentityAdapter(new SuiGrpcClient({ network: "testnet", baseUrl: rpcUrl("sui-testnet") }) as never);
const runDir = resolve(process.env.KIDO_EVIDENCE_DIR ?? "../.gauntlet/evidence", `e2e-identity-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const evidence: { step: string; ok: boolean; data: unknown }[] = [];
function step(name: string, ok: boolean, data: unknown = {}) {
  evidence.push({ step: name, ok, data: JSON.parse(ser(data)) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${ser(data).slice(0, 180)}`);
  if (!ok) finish(1);
}
function finish(code: number): never {
  writeFileSync(join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`evidence: ${runDir}`);
  process.exit(code);
}
const ethStart = await publicClient.getBalance({ address: wallet.account.address });

// A dual-chain treasury agent, designed through the interview.
const foundry = new Foundry({ store: new FileProjectStore(mkdtempSync(join(tmpdir(), "kido-e2e-id-"))), model: new RuleBasedInterviewModel(), amaneManifest: loadAmaneManifest(resolve("../Aname/deployments/testnet.json")), signers: { controllers: ["0x0000000000000000000000000000000000000c01"], issuer: "0x0000000000000000000000000000000000000c02", agent: "0x0000000000000000000000000000000000000c03" } });
const ACME_EVM = "0xacE0000000000000000000000000000000000ACE";
const ACME_SUI = `0x${"ac".repeat(32)}`;
const USER: Record<string, string> = { "authority.mode": "act on its own within limits", "authority.withdraw": "no", "authority.bridge": "no, each chain uses its own funds", "actions.allowed": "pay approved recipients", "authority.arbitrary_recipients": "only recipients I approve", payees: `acme ${ACME_EVM} and acme ${ACME_SUI}`, "authority.autonomy": "automatically", "assets.spend": "AMUSD", "limits.window": "50", "limits.total": "500", "identity.public": "yes", "identity.name": "treasury kidomuhsw6k2", "privacy.required": "no", "recovery.partial": "stop and notify me" };
const { projectId, question } = await foundry.create("Build me a treasury agent on Ethereum and Sui that pays my supplier.");
let q = question;
while (q) q = (await foundry.answer(projectId, USER[q.key] ?? "no")).next;
const fin = foundry.finalize(projectId);
const bp = fin.blueprint;
const ensPlan = fin.identityPlan.find((p) => p.providerId === "ens")!;
const suiPlan = fin.identityPlan.find((p) => p.providerId === "suins")!;
step("one blueprint, one KidoAgentId, one binding per chain", bp.chains.length === 2 && Boolean(ensPlan) && Boolean(suiPlan), { kidoAgentId: bp.kidoAgentId, ens: ensPlan?.name, suins: suiPlan?.name });

const bindings = fin.identityPlan.map((p) => ({ provider: p.providerId, chain: p.chain, name: p.name }));
const recordsFor = (b: typeof bp) => {
  const m = buildPublicManifest(b, blueprintHash(b), { bindings });
  const r = { "agent-context": JSON.stringify(m), "kido-agent-id": m.kidoAgentId };
  assertPublicSafe(r, b);
  return r;
};

// ---------------------------------------------------------------- ENS: bind, lookup
const existing = await ens.inspect(ensPlan.name);
const bind = existing.registered ? await ens.publishRecords(ensPlan.name, recordsFor(bp)) : await ens.createSubIdentity(ensPlan.parent, ensPlan.label, recordsFor(bp));
step("ENS binding published", bind.status === "CONFIRMED", bind);
const v1 = await verifyBinding(ens, ensPlan.name, { kidoAgentId: bp.kidoAgentId, blueprintCommitment: blueprintHash(bp) });
step("ENS lookup verifies the KidoAgentId and current blueprint", v1.verdict === "VERIFIED", { verdict: v1.verdict, detail: v1.detail });
step("ENS manifest lists both chain bindings (neither is the root)", ser(v1.manifest?.bindings) === ser(bindings), { bindings: v1.manifest?.bindings });

// ---------------------------------------------------------------- wrong name / wrong agent
step("wrong name (invalid) refused", (await verifyBinding(ens, ensPlan.name.toUpperCase(), { kidoAgentId: bp.kidoAgentId })).verdict === "INVALID_NAME");
step("wrong name (unregistered) not found", (await verifyBinding(ens, `nobody-${Date.now().toString(36)}.kidomuhsw6k2.eth`, { kidoAgentId: bp.kidoAgentId })).verdict === "NOT_FOUND");
step("name checked against a different agent is WRONG_AGENT", (await verifyBinding(ens, ensPlan.name, { kidoAgentId: "kido:agent:aaaaaaaaaaaaaaaa" })).verdict === "WRONG_AGENT");

// ---------------------------------------------------------------- rotation to a new revision
const bp2 = nextRevision(bp, { objective: { ...bp.objective, summary: "TREASURY (rotated)" } });
step("stale binding detected after a new revision", (await verifyBinding(ens, ensPlan.name, { kidoAgentId: bp2.kidoAgentId, blueprintCommitment: blueprintHash(bp2) })).verdict === "STALE");
const rot = await ens.publishRecords(ensPlan.name, recordsFor(bp2));
step("rotation republished", rot.status === "CONFIRMED", rot);
const v2 = await verifyBinding(ens, ensPlan.name, { kidoAgentId: bp2.kidoAgentId, blueprintCommitment: blueprintHash(bp2) });
step("same KidoAgentId, new commitment verified after rotation", v2.verdict === "VERIFIED" && v2.manifest?.kidoAgentId === bp.kidoAgentId, { verdict: v2.verdict, commitment: v2.manifest?.blueprintCommitment });

// ---------------------------------------------------------------- SuiNS: live reads, registration blocked
const s1 = await verifyBinding(suins, suiPlan.name, { kidoAgentId: bp.kidoAgentId, planned: true });
step("SuiNS binding for the same KidoAgentId is planned; live lookup confirms it is not registered", s1.verdict === "PLANNED_NOT_REGISTERED", { name: suiPlan.name, verdict: s1.verdict });
const reg = await suins.register(suiPlan.label);
step("SuiNS registration reported BLOCKED_ENV with its blocker, not faked", reg.status === "BLOCKED_ENV", { detail: reg.detail, registry: registry.get("suins")!.implementation.blocker });

// ---------------------------------------------------------------- revocation
const rev = await ens.revoke(ensPlan.name, "CLEAR_RECORDS");
step("ENS binding revoked (records cleared)", rev.status === "CONFIRMED", rev);
step("revoked name no longer verifies as the agent", (await verifyBinding(ens, ensPlan.name, { kidoAgentId: bp.kidoAgentId })).verdict === "REVOKED");
step("wrong-address check: covered by local conformance (this identity-only agent has no deployed account to advertise)", true, { test: "packages/identity/test/dual-identity.test.ts" });
step("gas spent", true, { eth: Number(ethStart - (await publicClient.getBalance({ address: wallet.account.address }))) / 1e18 });
finish(0);
