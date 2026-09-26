/**
 * Live transactions for a deployed Kido agent (testnet), acting as its agent runtime: every step is
 * compiled by Kido against the deployment's owner policy and lease, signed with the agent key and
 * relayed; Amane enforces it on-chain. Results land in the project's activity log.
 *
 *   fund      owner mints/transfers demo funds into the agent's Amane accounts
 *   Sepolia   PAY a pinned supplier · SWAP AMUSD → AMDAI on Uniswap · REPAY the owner's Aave debt
 *   Sui       PAY a pinned supplier · SWAP AMUSD → AMSUI on the pinned Cetus pool · refused PAY to a stranger
 *   bridge    Sui AMUSD → Wormhole → Sepolia wAMUSD, reserved on arrival for SWAP → USDC, then REPAY
 *
 * Env: FUNDER_PRIVATE_KEY (the owner wallet, also the Sepolia relayer), KIDO_DEMO_KEYS (agent key and
 * Sui relayer), KIDO_PROJECT, SEPOLIA_RPC_URL, the Kido issuer/agent env the API uses, KIDO_MAX_ETH.
 * Never prints a key.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, erc20Abi, formatEther, formatUnits, http, keccak256, parseAbi, parseEther, parseUnits, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { ActionKind, AmaneEvmEndpoint, AmaneSuiEndpoint, ZERO32, destSpecHash, signAmane, type ActionIntent, type AgentLease, type AmaneOutcome, type DestSpec, type RootPolicy } from "@kido/amane-bridge";
import { AmaneOnChainDestination, WormholeAmaneTransport, amaneIntentId, wormholeFacts, type AmaneBridgeAuthority } from "@kido/foundry";
import { rpcUrl } from "@kido/registry";
import { CrossChainEngine, FileEventLog, compileStep, readAavePosition, type CompileContext, type CrossChainIntent, type SemanticStep } from "@kido/runtime";
import { createDeployments, createFoundry, loadConfig } from "../src/index.js";

const need = (k: string) => process.env[k] ?? (console.log(JSON.stringify({ status: "BLOCKED_ENV", missing: k })), process.exit(2));
const P = need("KIDO_PROJECT");
const keys = JSON.parse(readFileSync(need("KIDO_DEMO_KEYS"), "utf8")) as { evm: Record<string, Hex>; suiRelayer: string };
const maxEth = parseEther(need("KIDO_MAX_ETH"));
const only = new Set((process.env.KIDO_STEPS ?? "fund,sepolia,sui,bridge").split(","));

const config = loadConfig();
const foundry = createFoundry(config);
const deployments = createDeployments(foundry);
const dec = <T>(v: unknown): T => JSON.parse(JSON.stringify(v), (_k, x) => (x && typeof x === "object" && "$big" in x ? BigInt(x.$big) : x)) as T;
const rec0 = foundry.loadRecord(P);
type Dep = { accountId: Hex; owner: Address; policy: RootPolicy; lease: AgentLease; leaseId: Hex; status: string; chains: Record<string, { account?: string; corePackage?: string }> };
const dep = dec<Dep>(rec0.deployment ?? (console.log("not deployed"), process.exit(2)));
if (dep.status !== "ACTIVE") throw new Error(`deployment is ${dep.status}, not ACTIVE`);
const bp = rec0.revisions.at(-1)!;
// The same compiled authority the deployment installed: bindings (adapters, pinned labels, assets).
const authority = (deployments as unknown as { authority: (p: unknown, d: unknown) => { bindings: CompileContext["bindings"] } }).authority(rec0, dep);

const m = foundry.manifest as unknown as { sui: any; evm: any };
const transport = http(rpcUrl("ethereum-sepolia"));
const pub = createPublicClient({ chain: sepolia, transport });
const pk = need("FUNDER_PRIVATE_KEY");
const owner = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
if (owner.address.toLowerCase() !== dep.owner.toLowerCase()) throw new Error("FUNDER_PRIVATE_KEY is not this deployment's owner");
const wallet = createWalletClient({ chain: sepolia, transport, account: owner });
const agent = privateKeyToAccount(keys.evm.agent!);
const sui = new SuiGrpcClient({ network: "testnet", baseUrl: rpcUrl("sui-testnet") });
const relayer = Ed25519Keypair.fromSecretKey(keys.suiRelayer);
const evmAccount = dep.chains["ethereum-sepolia"]!.account as Address;
const suiAccount = dep.chains["sui-testnet"]!.account!;
const evmEp = new AmaneEvmEndpoint(pub as never, wallet as never, evmAccount);
const suiEp = new AmaneSuiEndpoint(sui, dep.chains["sui-testnet"]!.corePackage ?? m.sui.packageId, suiAccount, relayer);

const runDir = resolve(process.env.KIDO_EVIDENCE_DIR ?? "../../../.gauntlet/evidence", `treasury-live-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
const evidence: Record<string, unknown>[] = [];
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const ethStart = await pub.getBalance({ address: owner.address });
async function guardEth() {
  const spent = ethStart - (await pub.getBalance({ address: owner.address }));
  if (spent > maxEth) throw new Error(`ETH spend ${formatEther(spent)} is above the approved ${formatEther(maxEth)}`);
}
/** Appends to the project's activity log (what the Activity and Control Plane pages read). */
function record(type: string, chain: string | undefined, detail: string, tx?: string) {
  const p = foundry.loadRecord(P);
  p.events = [...(p.events ?? []), { at: Date.now(), type, ...(chain ? { chain } : {}), detail, ...(tx ? { tx } : {}) }];
  foundry.saveRecord(p);
}
function step(name: string, ok: boolean, data: Record<string, unknown> = {}) {
  evidence.push({ step: name, ok, ...JSON.parse(show(data)) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(70)} ${show(data).slice(0, 220)}`);
}
const nowS = () => BigInt(Math.floor(Date.now() / 1000));
let nonce = BigInt(Date.now() % 1_000_000) * 100n;
const ctx: CompileContext = { accountId: dep.accountId, policy: dep.policy, lease: dep.lease, bindings: authority.bindings, nextNonce: () => ++nonce, now: nowS, ttlSeconds: 600n };
const asset = (chain: string, sym: string) => bp.assets.find((a) => a.chain === chain && a.symbol === sym) ?? (() => { throw new Error(`${sym} is not a blueprint asset on ${chain}`); })();
const units = (chain: string, sym: string, human: string) => parseUnits(human, asset(chain, sym).decimals);

/** Kido compiles the step (with preflight against the Amane rules), the agent signs, the relayer submits. */
async function act(label: string, s: Omit<SemanticStep, "stepId" | "dependsOn" | "origin">, submit: (i: ActionIntent, sig: Hex) => Promise<AmaneOutcome>, o: { planHash?: Hex; expect?: string } = {}) {
  const c = compileStep({ ...s, stepId: label, dependsOn: [], origin: "DETERMINISTIC" } as SemanticStep, o.planHash ?? keccak256(toHex(`kido:treasury:${label}:${Date.now()}`)), 0, ctx, { preflight: !o.expect });
  if (!c.ok) {
    const ok = o.expect !== undefined && c.code.includes(o.expect);
    step(`${label} (refused by Kido before relay)`, ok, { code: c.code, detail: c.detail });
    record(ok ? "action.refused" : "action.error", s.chain, `${label}: ${c.code}`);
    return null;
  }
  const out = await submit(c.intent, await signAmane(agent, "ActionIntent", c.intent));
  const got = out.kind === "REJECTED_BY_AMANE" ? out.code : out.kind;
  const ok = o.expect ? got.includes(o.expect) : out.kind === "EXECUTED";
  step(label, ok, { got, tx: out.tx, ...(out.kind === "OPERATIONAL_FAILURE" ? { message: out.message } : {}) });
  record(out.kind === "EXECUTED" ? "action.executed" : out.kind === "REJECTED_BY_AMANE" ? "action.refused" : "action.error", s.chain, `${label}: ${got}`, out.tx);
  return out;
}
const payee = (chain: string) => bp.authority.payees.find((p) => p.chain === chain)!.label;
const erc20 = parseAbi(["function mint(address to, uint256 amount)"]);
const tok = m.sui.tokens;
const evmAsset = (sym: string) => asset("ethereum-sepolia", sym).ref as Address;

// ---------------------------------------------------------------- fund
if (only.has("fund")) {
  const mintHash = await wallet.writeContract({ address: evmAsset("AMUSD"), abi: erc20, functionName: "mint", args: [evmAccount, units("ethereum-sepolia", "AMUSD", "300")] });
  await pub.waitForTransactionReceipt({ hash: mintHash });
  step("fund Sepolia: 300 AMUSD minted into the agent account", true, { tx: mintHash });
  record("fund", "ethereum-sepolia", "owner minted 300 AMUSD into the agent account", mintHash);
  const usdcHash = await wallet.writeContract({ address: evmAsset("USDC"), abi: erc20Abi, functionName: "transfer", args: [evmAccount, units("ethereum-sepolia", "USDC", "60")] });
  await pub.waitForTransactionReceipt({ hash: usdcHash });
  step("fund Sepolia: owner moved 60 Aave USDC into the agent account", true, { tx: usdcHash });
  record("fund", "ethereum-sepolia", "owner moved 60 USDC into the agent account", usdcHash);
  const d = await suiEp.depositFromFaucet(tok.packageId, "amusd", tok.AMUSD.coinType, tok.AMUSD.faucet, units("sui-testnet", "AMUSD", "300"));
  step("fund Sui: 300 AMUSD deposited into the agent account (testnet faucet)", d.kind === "EXECUTED", { got: d.kind, tx: d.tx });
  record("fund", "sui-testnet", "300 AMUSD deposited into the agent account", d.tx);
  await guardEth();
}

// ---------------------------------------------------------------- Sepolia
if (only.has("sepolia")) {
  const E = "ethereum-sepolia";
  await act("PaymentAgent · Sepolia PAY 5 AMUSD to northwind", { chain: E, action: "PAY", asset: "AMUSD", assetOut: null, amount: units(E, "AMUSD", "5"), payee: payee(E) } as never, (i, s) => evmEp.executeAction(i, s));
  await act("SwapAgent · Sepolia SWAP 25 AMUSD → AMDAI (Uniswap v3, floor 0.95)", { chain: E, action: "SWAP", asset: "AMUSD", assetOut: "AMDAI", amount: units(E, "AMUSD", "25"), payee: null } as never, (i, s) => evmEp.executeAction(i, s));
  const aave = foundry.registry.get("aave-v3")!.deployments[E] as Record<string, Address>;
  const pos = async () => (await readAavePosition({ client: pub as never, pool: aave.pool!, oracle: aave.oracle!, user: owner.address, asset: evmAsset("USDC") })).position;
  const before = await pos();
  await act("RepayDebtAgent · Sepolia REPAY 20 USDC of the treasury's Aave debt", { chain: E, action: "REPAY", asset: "USDC", assetOut: null, amount: units(E, "USDC", "20"), payee: bp.authority.beneficiaries[0]!.label } as never, (i, s) => evmEp.executeAction(i, s));
  const after = await pos();
  step("         Aave debt fell and the health factor rose", after.debtBase < before.debtBase, { hfBefore: before.healthFactor, hfAfter: after.healthFactor, debtBefore: before.debtBase, debtAfter: after.debtBase });
  await guardEth();
}

// ---------------------------------------------------------------- Sui
if (only.has("sui")) {
  const S = "sui-testnet";
  const coin = (sym: string) => asset(S, sym).ref;
  await act("PaymentAgent · Sui PAY 5 AMUSD to harbor logistics", { chain: S, action: "PAY", asset: "AMUSD", assetOut: null, amount: units(S, "AMUSD", "5"), payee: payee(S) } as never, (i, s) => suiEp.pay(coin("AMUSD"), i, s));
  const cetus = m.sui.adapters.find((a: { name: string; core?: string }) => a.name === "Cetus CLMM Pinned Swap" && a.core === Object.entries(m.sui.releases).find(([, r]: [string, any]) => r.packageId === dep.chains[S]!.corePackage)?.[0]);
  const pool = Object.values(m.sui.pools as Record<string, { pool: string; coinA: string; coinB: string }>).find((p) => [p.coinA, p.coinB].includes(coin("AMUSD")) && [p.coinA, p.coinB].includes(coin("AMSUI")))!;
  const route = { adapterPackage: cetus.package, module: cetus.module, witnessType: cetus.witnessType, coinA: pool.coinA, coinB: pool.coinB, a2b: pool.coinA === coin("AMUSD"), pool: pool.pool, globalConfig: m.sui.protocols.cetusClmm.globalConfig };
  await act("SwapAgent · Sui SWAP 10 AMUSD → AMSUI (pinned Cetus pool, floor 0.9)", { chain: S, action: "SWAP", asset: "AMUSD", assetOut: "AMSUI", amount: units(S, "AMUSD", "10"), payee: null } as never, (i, s) => suiEp.swapCetus(route, i, s));
  await act("ATTACK  Sui PAY 5 AMUSD to an address nobody pinned", { chain: S, action: "PAY", asset: "AMUSD", assetOut: null, amount: units(S, "AMUSD", "5"), payee: `0x${"de".repeat(32)}` } as never, (i, s) => suiEp.pay(coin("AMUSD"), i, s, { submitRejected: true }), { expect: "RECIPIENT_NOT_ALLOWED" });
}

// ---------------------------------------------------------------- bridge: Sui → Sepolia, reserved for a swap into USDC, then REPAY
if (only.has("bridge")) {
  const leaseLeft = Number(dep.lease.expiresAt - nowS());
  if (leaseLeft < 2400) throw new Error(`the lease has ${leaseLeft}s left; the bridge needs ~40 min — renew the lease first`);
  const E = "ethereum-sepolia", S = "sui-testnet";
  const whEvm = m.evm.adapters.find((a: { name: string }) => a.name === "Wormhole Bridge");
  const whSui = m.sui.adapters.find((a: { name: string; core?: string }) => a.name === "Wormhole Bridge" && a.core);
  const uni = authority.bindings[E]!.adapters.SWAP!;
  const facts = wormholeFacts(m as never, { suiBridge: whSui.instance.bridge, evmAdapterId: whEvm.adapterId, coinType: asset(S, "AMUSD").ref });
  const endpoints = { sui: suiEp, evm: evmEp };
  const amount = units(S, "AMUSD", "20");
  const wUsd = authority.bindings[E]!.assets.wAMUSD!;
  const dest: DestSpec = { actionKind: ActionKind.SWAP, adapterId: uni.adapterId, recipient: ZERO32, recipientLabel: "", asset: wUsd, minArrival: amount, deadline: nowS() + 1800n };
  const src = compileStep({ stepId: "bridge", chain: S, action: "BRIDGE", asset: "AMUSD", assetOut: "wAMUSD", amount, payee: `amane-${E}`, dependsOn: [], origin: "DETERMINISTIC" } as never, destSpecHash(dest), 2, ctx, { preflight: true });
  if (!src.ok) throw new Error(`bridge refused by Kido: ${src.code} ${src.detail}`);
  const auth: AmaneBridgeAuthority = { src: src.intent, srcSig: await signAmane(agent, "ActionIntent", src.intent), dest };
  const xIntent: CrossChainIntent = {
    intentId: amaneIntentId(auth),
    source: { chain: S, account: authority.bindings[S]!.account, asset: authority.bindings[S]!.assets.AMUSD!, amount },
    destination: { chain: E, account: authority.bindings[E]!.account, asset: wUsd, action: "SWAP", adapterId: uni.adapterId, beneficiary: ZERO32, minAmount: amount },
    deadline: Number(dest.deadline) * 1000,
    transport: "wormhole",
    authority: auth,
  };
  let usdcOut = 0n;
  const log = new FileEventLog(join(runDir, "events.jsonl"));
  const engine = new CrossChainEngine(new WormholeAmaneTransport(endpoints, facts), new AmaneOnChainDestination(E, authority.bindings[E]!.account, endpoints, facts), {
    authorizeSource: async (i) => ((i.authority as AmaneBridgeAuthority).src.planHash === destSpecHash(dest) ? { ok: true, detail: "source commits to SWAP-on-arrival" } : { ok: false, detail: "commitment mismatch" }),
    executeDestination: async (i, r) => {
      await guardEth();
      const bal = async () => (await pub.readContract({ address: evmAsset("USDC"), abi: erc20Abi, functionName: "balanceOf", args: [evmAccount] })) as bigint;
      const b0 = await bal();
      const o = await act("SwapAgent · Sepolia reserved SWAP wAMUSD → USDC (the bridge's committed action)", { chain: E, action: "SWAP", asset: "wAMUSD", assetOut: "USDC", amount: r.amount, payee: null } as never, (it, sg) => evmEp.executeReserved(i.intentId, it, sg), { planHash: i.intentId });
      usdcOut = (await bal()) - b0;
      return { ok: o?.kind === "EXECUTED", detail: `swapped into ${formatUnits(usdcOut, 6)} USDC` };
    },
    recover: async (_i, why) => ({ ok: false, detail: `recovery required: ${why}` }),
  }, log, bp.kidoAgentId);
  record("bridge.started", S, `BridgeAgent · Sui → Sepolia 20 AMUSD over Wormhole, reserved on arrival for SWAP into USDC (intent ${xIntent.intentId})`);
  const run = await engine.run(xIntent, { pollIntervalMs: 15_000, maxPolls: 100 });
  // The source commit's digest (Sui) and the arrival's reservation tx (Sepolia), as the engine reports them.
  const sourceTx = run.history.find((h) => h.state === "SOURCE_COMMITTED")?.detail;
  const vaa = run.history.find((h) => h.state === "ARRIVED")?.detail;
  const arrivalTx = run.history.find((h) => h.state === "RESERVED")?.detail?.match(/enforced on-chain (0x[0-9a-f]{64})/)?.[1];
  step("BridgeAgent · Sui → Sepolia bridge COMPLETE with an on-chain reservation", run.state === "COMPLETE", { history: run.history.map((h) => `${h.state}${h.detail ? `: ${h.detail.slice(0, 80)}` : ""}`) });
  if (sourceTx) record("bridge.source", S, `BridgeAgent · 20 AMUSD sent over Wormhole from the Sui account`, sourceTx);
  record(run.state === "COMPLETE" ? "bridge.complete" : "bridge.failed", E, run.state === "COMPLETE" ? `BridgeAgent · arrived on Sepolia as wAMUSD, reserved on-chain for its committed SWAP (VAA ${vaa ?? "?"})` : `bridge ${run.state}: ${run.history.map((h) => h.state).join(" → ")}`, arrivalTx);
  if (usdcOut > 0n) await act(`RepayDebtAgent · Sepolia REPAY ${formatUnits(usdcOut, 6)} USDC from the bridged funds`, { chain: E, action: "REPAY", asset: "USDC", assetOut: null, amount: usdcOut, payee: bp.authority.beneficiaries[0]!.label } as never, (i, s) => evmEp.executeAction(i, s));
}

const spent = ethStart - (await pub.getBalance({ address: owner.address }));
step("ETH spent by the owner/relayer this run", spent <= maxEth, { eth: formatEther(spent) });
writeFileSync(join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(`evidence: ${runDir}`);
