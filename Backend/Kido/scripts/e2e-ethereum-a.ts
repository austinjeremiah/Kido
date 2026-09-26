/**
 * Scenario A, Ethereum Sepolia, one continuous run:
 *   user request → design interview → blueprint → security review → simulation → build →
 *   ENS identity for the KidoAgentId → Amane v2 account, owner-signed policy, issuer-signed lease →
 *   running agent → live Aave health-factor breach → deterministic REPAY sizing → Amane → Aave →
 *   settlement → debt and health-factor verification → evidence.
 *
 * Env: SEPOLIA_RPC_URL, FUNDER_PRIVATE_KEY (gas relayer and the demo borrower/owner wallet),
 *      KIDO_DEMO_KEYS (disposable controller/issuer/agent keys; never printed),
 *      KIDO_INTERVIEW_MODEL=rule|openai (default rule).
 * Writes evidence and a deployment state file under KIDO_EVIDENCE_DIR (default ../.gauntlet/evidence).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { blueprintHash } from "@kido/blueprint";
import { KIDO_DEFAULTS, OpenAIInterviewModel, RuleBasedInterviewModel } from "@kido/design-interview";
import { FileProjectStore, Foundry, activateEvmAuthority, buildEvmRuntime, deployEvmAuthority } from "@kido/foundry";
import { EnsIdentityAdapter, assertPublicSafe } from "@kido/identity";
import { loadAmaneManifest, signThreshold } from "@kido/amane-bridge";
import { ProviderRegistry, rpcUrl } from "@kido/registry";
import { ActionExecutor, FileEventLog, readAavePosition } from "@kido/runtime";

const need = (k: string) => process.env[k] ?? (console.log(JSON.stringify({ status: "BLOCKED_ENV", missing: k })), process.exit(2));
const funderKey = need("FUNDER_PRIVATE_KEY") as Hex;
const keys = JSON.parse(readFileSync(need("KIDO_DEMO_KEYS"), "utf8")) as { evm: Record<string, Hex> };
const who = Object.fromEntries(Object.entries(keys.evm).map(([k, v]) => [k, privateKeyToAccount(v)])) as Record<"controllerA" | "controllerB" | "issuer" | "agent", ReturnType<typeof privateKeyToAccount>>;
const evidenceDir = resolve(process.env.KIDO_EVIDENCE_DIR ?? "../.gauntlet/evidence");
const runDir = join(evidenceDir, `e2e-ethereum-a-${Date.now()}`);
mkdirSync(runDir, { recursive: true });

const registry = new ProviderRegistry();
const manifest = loadAmaneManifest(resolve("../Aname/deployments/testnet.json"));
const transport = http(rpcUrl("ethereum-sepolia"));
const publicClient = createPublicClient({ chain: sepolia, transport });
const owner = privateKeyToAccount(funderKey);
const relayer = createWalletClient({ chain: sepolia, transport, account: owner });
const aave = registry.get("aave-v3")!.deployments["ethereum-sepolia"] as Record<string, Address>;
const usdc = registry.assetsOn("ethereum-sepolia").find((a) => a.symbol === "USDC")!.ref as Address;
const now = () => BigInt(Math.floor(Date.now() / 1000));

const evidence: { step: string; ok: boolean; data: unknown }[] = [];
const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
function step(name: string, ok: boolean, data: unknown = {}) {
  evidence.push({ step: name, ok, data: JSON.parse(ser(data)) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${data && typeof data === "object" && Object.keys(data as object).length ? `  ${ser(data).slice(0, 220)}` : ""}`);
  if (!ok) finish(1);
}
function finish(code: number): never {
  writeFileSync(join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`evidence: ${runDir}`);
  process.exit(code);
}
const wait = async (hash: Hex) => {
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") step(`tx ${hash}`, false);
  return hash;
};
const ethStart = await publicClient.getBalance({ address: owner.address });

// ---------------------------------------------------------------- fixture: the owner's position is at risk
const POOL = parseAbi(["function borrow(address,uint256,uint256,uint16,address)"]);
const pos0 = (await readAavePosition({ client: publicClient as never, pool: aave.pool!, oracle: aave.oracle!, user: owner.address, asset: usdc })).position;
const FIXTURE_HF = Number(process.env.E2E_FIXTURE_HF ?? 1.4);
if (pos0.healthFactor > FIXTURE_HF + 0.05) {
  const target = BigInt(Math.round(FIXTURE_HF * 1e6));
  const debtAt = (pos0.collateralBase * pos0.liquidationThreshold * 1_000_000n) / (10_000n * target);
  const borrow = ((debtAt - pos0.debtBase) * 10n ** BigInt(pos0.assetDecimals)) / pos0.assetPriceBase;
  await wait(await relayer.writeContract({ address: aave.pool!, abi: POOL, functionName: "borrow", args: [usdc, borrow, 2n, 0, owner.address] }));
}
const pos1 = (await readAavePosition({ client: publicClient as never, pool: aave.pool!, oracle: aave.oracle!, user: owner.address, asset: usdc })).position;
step("FIXTURE owner's Aave position brought near liquidation (test setup, not agent action)", pos1.healthFactor < 1.5, { healthFactor: pos1.healthFactor, debtBase: pos1.debtBase });

// ---------------------------------------------------------------- design interview → blueprint → build
const model = process.env.KIDO_INTERVIEW_MODEL === "openai" ? new OpenAIInterviewModel() : new RuleBasedInterviewModel();
const foundry = new Foundry({
  store: new FileProjectStore(mkdtempSync(join(tmpdir(), "kido-e2e-a-"))),
  model,
  amaneManifest: manifest,
  signers: { controllers: [who.controllerA.address, who.controllerB.address], issuer: who.issuer.address, agent: who.agent.address },
});
const USER: Record<string, string> = {
  "authority.mode": "Act on its own within limits I set",
  "authority.withdraw": "No, never",
  "actions.allowed": "It may repay my debt",
  beneficiary: `The loan is on my wallet ${owner.address}`,
  "authority.autonomy": "Only when a condition it can prove on-chain occurs",
  "limits.window": "500 USDC",
  "limits.total": "2,000",
  "identity.public": "yes",
  "identity.name": process.env.E2E_IDENTITY_NAME ?? "repay kidomuhsw6k2",
  "privacy.required": "no",
  "monitor.condition": "health factor below 1.5",
  "recovery.partial": "stop and notify me",
};
const transcript: { kido: string; user: string }[] = [];
const created = await foundry.create("Build me an agent that protects my Aave position.");
let q = created.question;
while (q) {
  const answer = USER[q.key];
  if (answer === undefined) step(`interview asked an unexpected question: ${q.key}`, false, { text: q.text });
  transcript.push({ kido: q.text, user: answer! });
  q = (await foundry.answer(created.projectId, answer!)).next;
}
for (const u of foundry.unresolved(created.projectId)) if (USER[u.key]) await foundry.edit(created.projectId, u.key, USER[u.key]!);
step("design interview completed", foundry.unresolved(created.projectId).length === 0, { questions: transcript.length, model: model.name });
writeFileSync(join(runDir, "transcript.json"), JSON.stringify(transcript, null, 2));

const fin = foundry.finalize(created.projectId);
const bp = fin.blueprint;
step("blueprint compiled with no blockers", fin.blockers.length === 0, { kidoAgentId: bp.kidoAgentId, revision: bp.revision, blockers: fin.blockers });
step("authority: REPAY only, BORROW/WITHDRAW forbidden, beneficiary pinned", bp.authority.allowedActions.join() === "REPAY" && bp.authority.forbiddenActions.includes("WITHDRAW") && bp.authority.beneficiaries[0]?.address === owner.address, { authority: { allowed: bp.authority.allowedActions, limits: bp.authority.limits, beneficiaries: bp.authority.beneficiaries } });
step("protocol and knowledge: Aave v3 with its pack", bp.protocols.some((p) => p.providerId === "aave-v3") && bp.agents.some((a) => a.knowledgePacks.includes("protocols/aave-v3")), { protocols: bp.protocols, agents: bp.agents });
step("monitor: health factor below 1.5 answered deterministically by REPAY", bp.monitors[0]?.metric === "HEALTH_FACTOR" && bp.monitors[0]?.response === "DETERMINISTIC_ACTION", { monitors: bp.monitors });
const review = foundry.securityReview(created.projectId);
step("security review has no blocking finding", !review.blocking, { findings: review.findings.map((f) => `${f.severity} ${f.id}`) });
const sim = await foundry.simulate(created.projectId);
step("simulation passed on the chain's rules", sim.passed, { results: sim.results.map((r) => `${r.id}:${r.actual}`) });
const build = foundry.build(created.projectId);
step("build produced for the current revision", build.blueprintHash === blueprintHash(bp), { buildRevision: build.buildRevision, agents: build.agents.map((a) => a.role) });

// ---------------------------------------------------------------- ENS identity for the KidoAgentId
const plan = fin.identityPlan.find((p) => p.providerId === "ens");
if (!plan) step("identity plan contains an ENS binding", false);
assertPublicSafe(plan!.records, bp);
const ens = new EnsIdentityAdapter(publicClient as never, relayer as never, registry.get("ens")!.deployments["ethereum-sepolia"] as never);
const existing = await ens.inspect(plan!.name);
const idReceipt = existing.registered ? await ens.publishRecords(plan!.name, plan!.records) : await ens.createSubIdentity(plan!.parent, plan!.label, plan!.records);
const resolved = await ens.resolve(plan!.name);
step("ENS name resolves to the blueprint's KidoAgentId", resolved.kidoAgentId === bp.kidoAgentId, { name: plan!.name, receipt: idReceipt, kidoAgentId: resolved.kidoAgentId });

// ---------------------------------------------------------------- Amane authority
const dep = await deployEvmAuthority({ bp, manifest, registry, publicClient: publicClient as never, relayer: relayer as never, controllers: [who.controllerA.address, who.controllerB.address], threshold: 2, issuer: who.issuer.address, agent: who.agent.address, ownerRecovery: owner.address, now: now() });
step("Amane core v2 account deployed", (await dep.endpoint.coreVersion()) === 2, { account: dep.endpoint.address, tx: dep.deployTx, accountId: dep.accountId });
const ownerSigs = await signThreshold([who.controllerA, who.controllerB], "RootPolicy", dep.authority.policy);
const leaseId = keccak256(toHex(`kido:lease:${bp.kidoAgentId}:${Date.now()}`));
const act = await activateEvmAuthority(dep, ownerSigs, who.issuer, leaseId, now());
step("owner-signed Root Policy installed", act.install.kind === "EXECUTED", act.install);
step("issuer-signed lease activated", act.activate.kind === "EXECUTED", act.activate);
const FAUCET = parseAbi(["function mint(address,address,uint256) returns (uint256)"]);
await wait(await relayer.writeContract({ address: aave.faucet!, abi: FAUCET, functionName: "mint", args: [usdc, dep.endpoint.address, 1_000_000000n] }));
step("account funded with 1000 test USDC (Aave faucet)", true);

writeFileSync(join(evidenceDir, "e2e-ethereum-a-state.json"), ser({ kidoAgentId: bp.kidoAgentId, projectDir: null, account: dep.endpoint.address, accountId: dep.accountId, policy: act.policy, lease: act.lease, bindings: dep.authority.bindings, beneficiary: owner.address, runDir }));

// ---------------------------------------------------------------- the running agent
const log = new FileEventLog(join(runDir, "events.jsonl"));
const executor = new ActionExecutor({ evm: dep.endpoint, suiCoinTypes: {}, suiRoutes: [], agent: who.agent, log, agentId: bp.kidoAgentId });
const rt = buildEvmRuntime({ bp, registry, authority: dep.authority, policy: act.policy, lease: act.lease, account: dep.endpoint.address, publicClient: publicClient as never, executor, log, targetMargin: KIDO_DEFAULTS.healthFactorTargetMargin, ttlSeconds: BigInt(KIDO_DEFAULTS.actionTtlSeconds) });
step("runtime assembled from the blueprint", rt.blockers.length === 0 && rt.monitors.length === 1, { blockers: rt.blockers });

const debt0 = pos1.debtBase;
let hf = pos1.healthFactor;
for (let i = 0; i < 3 && hf < 1.5; i++) {
  const tick = await rt.runtime.tick();
  const run = tick.runs[0];
  step(`tick ${i + 1}: breach observed → ${tick.decisions[0]?.path ?? "no event"} → ${run?.status ?? "no plan"}`, run?.status === "COMPLETED", { decisions: tick.decisions, steps: run?.steps.map((s) => ({ id: s.step.stepId, action: s.step.action, amount: s.step.amount, status: s.status, tx: s.tx })) });
  hf = (await readAavePosition({ client: publicClient as never, pool: aave.pool!, oracle: aave.oracle!, user: owner.address, asset: usdc })).position.healthFactor;
}
const pos2 = (await readAavePosition({ client: publicClient as never, pool: aave.pool!, oracle: aave.oracle!, user: owner.address, asset: usdc })).position;
step("settlement verified: owner's debt fell and health factor recovered above the threshold", pos2.debtBase < debt0 && pos2.healthFactor >= 1.5 && pos2.healthFactor > pos1.healthFactor, { before: { hf: pos1.healthFactor, debtBase: debt0 }, after: { hf: pos2.healthFactor, debtBase: pos2.debtBase } });
const tick = await rt.runtime.tick();
step("healthy position produces no action on the next tick", tick.runs.length === 0, { events: tick.events.length });
step("audit log recorded every decision and outcome", log.list({ type: "ACTION_EXECUTED" }).length >= 1 && log.list({ type: "GATE_DECISION" }).length >= 1, { events: log.list().map((e) => `${e.type}${e.tx ? ` ${e.tx}` : ""}`) });
const spent = ethStart - (await publicClient.getBalance({ address: owner.address }));
step("gas spent", true, { eth: Number(spent) / 1e18 });
finish(0);
