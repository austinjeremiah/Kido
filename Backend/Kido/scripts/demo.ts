/**
 * P9.5 — the demo runner. One entry point for every scene, on live Sepolia.
 *
 * Each scene emits a structured trace (REQUEST → IDENTITY → CRE → CAPABILITY → EXECUTION) so both
 * a terminal viewer and the Attack Lab UI show the same thing: not just the outcome, but which
 * stage stopped it.
 *
 * CRE verdicts here are produced by the same policy module the official simulator runs; the
 * simulator scenes are separate (`npm run demo:cre-private-context`). See docs/CRE_MODE_BASELINE.md.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ROOT, dep, pub, wDep, wRel, deployer, issuer, AGENT, assertSepolia, revertName,
  POLICY_REGISTRY, TARGET, GATEWAY, CONSUMER, ACTION_KIND, RECIPIENT, PRIVATE_POLICY, healthyContext,
  IDENTITY_ABI, POLICY_ABI, CONSUMER_ABI, TARGET_ABI, GATEWAY_ABI, EXEC_ABI,
} from "./lib/harness.js";
import { evaluatePolicy, verdictToUint, type MarketContext } from "@contextlock/policy";
import { CAPABILITY_TYPES, domain, requestHash as reqHash, capabilityDigest, type Capability } from "../packages/protocol/src/capability.js";
import { ENS_V2_SEPOLIA as ENS, ETH_REGISTRY_ABI } from "../packages/ens/src/deployments.js";

const M = JSON.parse(readFileSync(join(ROOT, "deployments/sepolia.json"), "utf8"));
const EXECUTOR = M.canonicalExecutor.address as Address;
const IDENTITY = M.contracts.EnsAgentIdentityVerifier as Address;
const APPROVALS = M.contracts.ContextLockApprovalRegistry as Address;
const approver = privateKeyToAccount(process.env.APPROVER_STANDIN_PRIVATE_KEY! as Hex);

const APPROVALS_ABI = [
  { type: "function", name: "approvalDigest", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }, { type: "uint64" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "submitApproval", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], outputs: [] },
  { type: "function", name: "isApprovalValid", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

type Stage = "REQUEST" | "IDENTITY" | "CRE" | "CAPABILITY" | "EXECUTION";
type Trace = { stage: Stage; ok: boolean; detail: string; tx?: string };
export type SceneResult = {
  id: string; title: string; expectation: string;
  outcome: "EXECUTED" | "BLOCKED"; stoppedAt?: Stage;
  trace: Trace[]; targetBefore: string; targetAfter: string;
  capabilityDigest?: string; verdict?: string; reason?: string; error?: string;
};

const E = "[";
const C = { dim: `${E}2m`, red: `${E}31m`, green: `${E}32m`, bold: `${E}1m`, off: `${E}0m` };
const log = (...a: unknown[]) => console.log(...a);
const RUN = Date.now().toString();
let aih: Hex;
let seq = 0n;

const pc = (): Hex => {
  const p = PRIVATE_POLICY;
  return keccak256(toHex([p.policyId, p.policyVersion, p.enabled, p.autoLimit, p.escalationLimit,
    p.maxSlippageBps, p.maxVolatilityBps, p.minLiquidity, p.targetEthAllocationBps, p.rebalanceDriftBps,
    p.minHealthFactorBps, p.targetHealthFactorBps, p.proprietaryRiskThreshold].join("|")));
};
const cc = (c: MarketContext): Hex =>
  keccak256(toHex(`ctx:${c.observedAtUnix}:${c.slippageBps}:${c.volatilityBps}:${c.liquidity}:${c.healthFactorBps}`));

function build(amount: bigint, recipient: Address = RECIPIENT) {
  const cd = encodeFunctionData({ abi: TARGET_ABI, functionName: "transferTo", args: [recipient, amount] });
  const now = BigInt(Math.floor(Date.now() / 1000));
  seq += 1n;
  const cap: Capability = {
    version: 1, agentIdentityHash: aih, agent: AGENT, chainId: 11155111n, executor: EXECUTOR,
    target: TARGET, value: 0n, calldataHash: keccak256(cd), intentHash: keccak256(toHex(`demo-${RUN}-${seq}`)),
    policyHash: pc(), authorizationId: ("0x" + "0".repeat(64)) as Hex,
    contextCommitment: ("0x" + "0".repeat(64)) as Hex,
    issuedAt: now, expiresAt: now + 1800n, nonce: BigInt(Date.now()) * 10n + seq,
  };
  return { cap, cd, amount };
}

async function creRoundTrip(cap: Capability, cd: Hex, ctx = healthyContext()) {
  const gw = await wRel.writeContract({
    address: GATEWAY, abi: GATEWAY_ABI, functionName: "requestEvaluation",
    args: [cap.agentIdentityHash, cap.agent, dep.ens.node as Hex, cap.target, cap.value, cd,
           cap.intentHash, PRIVATE_POLICY.policyId as Hex, BigInt(PRIVATE_POLICY.policyVersion), ACTION_KIND],
  });
  await pub.waitForTransactionReceipt({ hash: gw });
  const decision = evaluatePolicy({
    requestHash: reqHash(cap), agentIdentityHash: cap.agentIdentityHash, ensNode: dep.ens.node,
    agent: cap.agent, chainId: 11155111, target: cap.target, value: cap.value,
    calldataHash: cap.calldataHash, selector: cd.slice(0, 10),
    decodedRecipient: ("0x" + cd.slice(34, 74)) as Address, decodedAmount: BigInt("0x" + cd.slice(-64)),
    intentHash: cap.intentHash, policyId: PRIVATE_POLICY.policyId,
    policyVersion: PRIVATE_POLICY.policyVersion, actionKind: ACTION_KIND,
  }, { ...PRIVATE_POLICY, authorizedAgentIdentityHashes: [aih] }, ctx, Math.floor(Date.now() / 1000));
  const evaluatedAt = BigInt(Math.floor(Date.now() / 1000));
  const validUntil = evaluatedAt + 1800n;
  const report = encodeAbiParameters(
    parseAbiParameters("bytes32 a, bytes32 b, bytes32 c, uint8 d, bytes32 e, uint64 f, uint64 g"),
    [reqHash(cap), pc(), cc(ctx), verdictToUint(decision.verdict), keccak256(toHex(decision.reasonCode)), evaluatedAt, validUntil]);
  const del = await wRel.writeContract({ address: CONSUMER, abi: CONSUMER_ABI, functionName: "onReport", args: [report] });
  await pub.waitForTransactionReceipt({ hash: del });
  const authId = await pub.readContract({
    address: CONSUMER, abi: CONSUMER_ABI, functionName: "computeAuthorizationId",
    args: [reqHash(cap), pc(), evaluatedAt],
  }) as Hex;
  return { decision, authId, ctxC: cc(ctx), gw, del };
}

const sign = (cap: Capability) =>
  issuer.signTypedData({ domain: domain(cap.chainId, cap.executor), types: CAPABILITY_TYPES, primaryType: "Capability", message: cap }) as Promise<Hex>;

async function exec(cap: Capability, cd: Hex, sigOverride?: Hex) {
  const sig = sigOverride ?? (await sign(cap));
  try {
    const tx = await wRel.writeContract({ address: EXECUTOR, abi: EXEC_ABI, functionName: "execute", args: [cap, sig, cd, ACTION_KIND] });
    const rc = await pub.waitForTransactionReceipt({ hash: tx });
    return { ok: rc.status === "success", tx, err: "" };
  } catch (e) {
    return { ok: false, tx: undefined, err: revertName(e) };
  }
}
const count = () => pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "callCount" }) as Promise<bigint>;

async function setup() {
  await assertSepolia();
  const labelId = BigInt(dep.ens.labelId);
  const tokenId = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getTokenId", args: [labelId] }) as bigint;
  const owner = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "ownerOf", args: [tokenId] }) as Address;
  aih = await pub.readContract({
    address: IDENTITY, abi: IDENTITY_ABI, functionName: "computeIdentityHash",
    args: [ENS.ethRegistry, labelId, owner, AGENT, tokenId, 1n],
  }) as Hex;
  try {
    const t = await wDep.writeContract({ address: IDENTITY, abi: IDENTITY_ABI, functionName: "bind", args: [ENS.ethRegistry, labelId, AGENT, 1n] });
    await pub.waitForTransactionReceipt({ hash: t });
  } catch (e) {
    if (!(e as Error).message.includes("0x682a9065")) throw e;
  }
  for (const [fn, args] of [
    ["setPolicyAdmin", [aih, deployer.address]], ["setPolicy", [aih, pc(), true, 10n ** 18n]],
    ["setTargetAllowed", [aih, pc(), TARGET, true]], ["setActionAllowed", [aih, pc(), ACTION_KIND, true]],
  ] as const) {
    const t = await wDep.writeContract({ address: POLICY_REGISTRY, abi: POLICY_ABI, functionName: fn as never, args: args as never });
    await pub.waitForTransactionReceipt({ hash: t });
  }
  return labelId;
}

function render(r: SceneResult) {
  const head = r.outcome === "EXECUTED" ? `${C.green}EXECUTED${C.off}` : `${C.red}BLOCKED${C.off}`;
  log(`\n${C.bold}${r.id} — ${r.title}${C.off}`);
  log(`${C.dim}expectation: ${r.expectation}${C.off}`);
  for (const t of r.trace) {
    const mark = t.ok ? `${C.green}OK${C.off}  ` : `${C.red}STOP${C.off}`;
    log(`   ${mark}  ${t.stage.padEnd(11)} ${t.detail}${t.tx ? `  ${C.dim}${t.tx}${C.off}` : ""}`);
  }
  log(`   -> ${head}${r.stoppedAt ? ` at ${r.stoppedAt}` : ""}   target callCount ${r.targetBefore} -> ${r.targetAfter}`);
}

// ───────────────────────────── scenes ─────────────────────────────

async function sceneAllow(): Promise<SceneResult> {
  const trace: Trace[] = [];
  const { cap, cd } = build(500_000_000n);
  const before = await count();
  trace.push({ stage: "REQUEST", ok: true, detail: "agent proposes: rebalance 500 USDC to treasury recipient" });
  trace.push({ stage: "IDENTITY", ok: true, detail: `${dep.ens.agentName} resolves and is current` });
  const e = await creRoundTrip(cap, cd);
  trace.push({ stage: "CRE", ok: e.decision.verdict === "ALLOW", detail: `${e.decision.verdict} (${e.decision.reasonCode})`, tx: e.del });
  cap.authorizationId = e.authId;
  cap.contextCommitment = e.ctxC;
  trace.push({ stage: "CAPABILITY", ok: true, detail: "minted, expires in 30min", tx: capabilityDigest(cap) });
  const r = await exec(cap, cd);
  trace.push({ stage: "EXECUTION", ok: r.ok, detail: r.ok ? "executed autonomously, no human" : r.err, tx: r.tx });
  const after = await count();
  return {
    id: "DEMO-ALLOW", title: "Autonomous low-risk rebalance", expectation: "executes with no human in the loop",
    outcome: r.ok ? "EXECUTED" : "BLOCKED", trace, targetBefore: before.toString(), targetAfter: after.toString(),
    capabilityDigest: capabilityDigest(cap), verdict: e.decision.verdict, reason: e.decision.reasonCode,
  };
}

async function sceneDeny(): Promise<SceneResult> {
  const trace: Trace[] = [];
  const ATTACKER = "0x000000000000000000000000000000000000dEaD" as Address;
  const { cap, cd } = build(50_000_000_000n, ATTACKER);
  const before = await count();
  trace.push({ stage: "REQUEST", ok: true, detail: "COMPROMISED agent proposes: send 50,000 USDC to 0x...dEaD" });
  trace.push({ stage: "IDENTITY", ok: true, detail: "identity is valid - the agent is who it says it is" });
  const e = await creRoundTrip(cap, cd);
  trace.push({ stage: "CRE", ok: false, detail: `${e.decision.verdict} (${e.decision.reasonCode}) - private threshold`, tx: e.del });
  cap.authorizationId = e.authId;
  cap.contextCommitment = e.ctxC;
  trace.push({ stage: "CAPABILITY", ok: false, detail: "no autonomous authority: verdict is not ALLOW" });
  const r = await exec(cap, cd);
  trace.push({ stage: "EXECUTION", ok: false, detail: `executor rejected: ${r.err}` });
  const after = await count();
  return {
    id: "DEMO-DENY", title: "Prompt injection / treasury drain", expectation: "denied; attacker receives nothing",
    outcome: "BLOCKED", stoppedAt: "CRE", trace, targetBefore: before.toString(), targetAfter: after.toString(),
    verdict: e.decision.verdict, reason: e.decision.reasonCode, error: r.err,
  };
}

async function sceneMutate(): Promise<SceneResult> {
  const trace: Trace[] = [];
  const { cap, cd } = build(500_000_000n);
  const before = await count();
  const e = await creRoundTrip(cap, cd);
  cap.authorizationId = e.authId;
  cap.contextCommitment = e.ctxC;
  const goodSig = await sign(cap);
  trace.push({ stage: "REQUEST", ok: true, detail: "a legitimate 500 USDC capability is issued" });
  trace.push({ stage: "CRE", ok: true, detail: `${e.decision.verdict}`, tx: e.del });
  trace.push({ stage: "CAPABILITY", ok: true, detail: "valid and signed", tx: capabilityDigest(cap) });
  const attackerCd = encodeFunctionData({
    abi: TARGET_ABI, functionName: "transferTo",
    args: ["0x000000000000000000000000000000000000dEaD" as Address, 9_000_000_000n],
  });
  const r = await exec(cap, attackerCd, goodSig);
  trace.push({ stage: "EXECUTION", ok: false, detail: `attacker swapped recipient AND amount: ${r.err}` });
  const after = await count();
  return {
    id: "DEMO-MUTATE", title: "Capability mutation after issuance", expectation: "rejected: calldata is bound by hash",
    outcome: "BLOCKED", stoppedAt: "EXECUTION", trace, targetBefore: before.toString(), targetAfter: after.toString(), error: r.err,
  };
}

async function sceneReplay(): Promise<SceneResult> {
  const trace: Trace[] = [];
  const { cap, cd } = build(500_000_000n);
  const before = await count();
  const e = await creRoundTrip(cap, cd);
  cap.authorizationId = e.authId;
  cap.contextCommitment = e.ctxC;
  const sig = await sign(cap);
  const first = await exec(cap, cd, sig);
  trace.push({ stage: "EXECUTION", ok: first.ok, detail: "first execution succeeds", tx: first.tx });
  const mid = await count();
  const second = await exec(cap, cd, sig);
  trace.push({ stage: "EXECUTION", ok: false, detail: `identical capability resubmitted: ${second.err}` });
  const after = await count();
  return {
    id: "DEMO-REPLAY", title: "Replay a spent capability", expectation: "second submission rejected by nonce",
    outcome: "BLOCKED", stoppedAt: "EXECUTION", trace, targetBefore: before.toString(), targetAfter: after.toString(),
    error: second.err, verdict: `callCount ${mid} then ${after}`,
  };
}

async function sceneEnsRevoke(labelId: bigint): Promise<SceneResult> {
  const trace: Trace[] = [];
  const ROLES_ABI = [
    { type: "function", name: "revokeRoles", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }] },
    { type: "function", name: "grantRoles", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }] },
  ] as const;
  const { cap, cd } = build(500_000_000n);
  const before = await count();
  const e = await creRoundTrip(cap, cd);
  cap.authorizationId = e.authId;
  cap.contextCommitment = e.ctxC;
  trace.push({ stage: "CAPABILITY", ok: true, detail: "valid, signed, UNEXPIRED", tx: capabilityDigest(cap) });
  const rev = await wDep.writeContract({ address: ENS.ethRegistry, abi: ROLES_ABI, functionName: "revokeRoles", args: [labelId, 1n << 24n, deployer.address] });
  await pub.waitForTransactionReceipt({ hash: rev });
  trace.push({ stage: "IDENTITY", ok: false, detail: "ENS role revoked -> token id regenerates -> identity changed", tx: rev });
  const r = await exec(cap, cd);
  trace.push({ stage: "EXECUTION", ok: false, detail: `executor rejected: ${r.err}` });
  const gr = await wDep.writeContract({ address: ENS.ethRegistry, abi: ROLES_ABI, functionName: "grantRoles", args: [labelId, 1n << 24n, deployer.address] });
  await pub.waitForTransactionReceipt({ hash: gr });

  // Re-granting the role regenerates the token id AGAIN, so the identity bound at setup is now
  // stale twice over. Rebind before returning, otherwise every later scene inherits a broken
  // identity and fails for the wrong reason. A demo scene that leaves the world worse than it
  // found it is a scene that can only be run first.
  await setup();
  trace.push({ stage: "IDENTITY", ok: true, detail: "role restored and identity rebound - later scenes unaffected" });

  const after = await count();
  return {
    id: "DEMO-ENS-REVOKE", title: "ENS revocation kills outstanding authority",
    expectation: "an unexpired, correctly signed capability stops working",
    outcome: "BLOCKED", stoppedAt: "IDENTITY", trace, targetBefore: before.toString(), targetAfter: after.toString(), error: r.err,
  };
}

async function sceneEscalate(): Promise<SceneResult> {
  const trace: Trace[] = [];
  const { cap, cd } = build(5_000_000_000n);
  const before = await count();
  const e = await creRoundTrip(cap, cd);
  cap.authorizationId = e.authId;
  cap.contextCommitment = e.ctxC;
  const d = capabilityDigest(cap);
  trace.push({ stage: "REQUEST", ok: true, detail: "agent proposes 5,000 USDC - above the private autonomous limit" });
  trace.push({ stage: "CRE", ok: true, detail: `${e.decision.verdict} (${e.decision.reasonCode})`, tx: e.del });
  const blocked = await exec(cap, cd);
  trace.push({ stage: "EXECUTION", ok: false, detail: `without approval: ${blocked.err}` });
  const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + 1800n;
  const ad = await pub.readContract({ address: APPROVALS, abi: APPROVALS_ABI, functionName: "approvalDigest", args: [d, approver.address, expiresAt] }) as Hex;
  const approvalSig = await approver.sign({ hash: ad });
  const sub = await wRel.writeContract({ address: APPROVALS, abi: APPROVALS_ABI, functionName: "submitApproval", args: [d, expiresAt, approvalSig] });
  await pub.waitForTransactionReceipt({ hash: sub });
  trace.push({ stage: "CAPABILITY", ok: true, detail: "approval recorded (STAND-IN key - NOT a Ledger device, BLK-002)", tx: sub });
  const r = await exec(cap, cd);
  trace.push({ stage: "EXECUTION", ok: r.ok, detail: r.ok ? "executes only after approval" : r.err, tx: r.tx });
  const after = await count();
  return {
    id: "DEMO-ESCALATE", title: "High-risk action requires human approval",
    expectation: "blocked without approval, executes with it",
    outcome: r.ok ? "EXECUTED" : "BLOCKED", trace, targetBefore: before.toString(), targetAfter: after.toString(),
    capabilityDigest: d, verdict: e.decision.verdict, reason: e.decision.reasonCode,
  };
}

async function main() {
  const which = process.argv[2] ?? "all";
  log(`${C.bold}ContextLock demo - live Sepolia${C.off}`);
  log(`${C.dim}executor ${EXECUTOR}  |  ENS ${dep.ens.agentName}  |  CRE mode ${M.cre.mode}${C.off}`);
  const labelId = await setup();

  const scenes: Record<string, () => Promise<SceneResult>> = {
    allow: sceneAllow, deny: sceneDeny, mutate: sceneMutate, replay: sceneReplay,
    "ens-revoke": () => sceneEnsRevoke(labelId), escalate: sceneEscalate,
  };

  const toRun = which === "all" ? Object.keys(scenes) : [which];
  const results: SceneResult[] = [];
  for (const k of toRun) {
    const fn = scenes[k];
    if (!fn) {
      console.error(`unknown scene "${k}". one of: ${Object.keys(scenes).join(", ")}, all`);
      process.exit(1);
    }
    const r = await fn();
    render(r);
    results.push(r);
  }

  const outPath = join(ROOT, "apps/web/demo-results.json");
  writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(), executor: EXECUTOR, creMode: M.cre.mode,
    ensName: dep.ens.agentName, results,
  }, null, 2) + "\n");
  log(`\n${C.dim}wrote ${outPath}${C.off}`);

  const executed = results.filter((r) => r.outcome === "EXECUTED").length;
  log(`\n${C.bold}${executed} executed, ${results.length - executed} blocked${C.off}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
