/**
 * Phase 7: DEMO-A / DEMO-B / DEMO-C on live Sepolia.
 *
 *   A  ALLOW    -> autonomous, no human
 *   B  ESCALATE -> approval signature required, then executes the exact transaction
 *   C  DENY     -> cannot be rescued, even by a genuinely valid approval
 *
 * ⚠️ The approval signature is produced by a locally generated STAND-IN key, because no Ledger
 * device is attached (BLK-002). That proves the CONTRACT boundary. It does NOT prove a human
 * pressed a button on hardware. Every output below is labelled accordingly.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters, toHex, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ROOT, dep, p4, pub, wDep, wRel, deployer, issuer, relayer, AGENT, assertSepolia, revertName,
  POLICY_REGISTRY, TARGET, GATEWAY, CONSUMER, ACTION_KIND, RECIPIENT, PRIVATE_POLICY, healthyContext,
  IDENTITY_ABI, POLICY_ABI, CONSUMER_ABI, TARGET_ABI, GATEWAY_ABI, EXEC_ABI,
} from "./lib/harness.js";
import { evaluatePolicy, verdictToUint } from "@contextlock/policy";
import { CAPABILITY_TYPES, domain, requestHash as reqHash, capabilityDigest, type Capability } from "../packages/protocol/src/capability.js";
import { ENS_V2_SEPOLIA as ENS, ETH_REGISTRY_ABI } from "../packages/ens/src/deployments.js";
import { buildApprovalSummary } from "../packages/ledger/src/clear-signing.js";
import { readFileSync } from "node:fs";

const p7 = JSON.parse(readFileSync(join(ROOT, "deployments/sepolia-p7.json"), "utf8"));
const EXECUTOR_V2 = p7.contextlock.ContextLockExecutorV2 as Address;
const APPROVALS = p7.contextlock.ContextLockApprovalRegistry as Address;
const IDENTITY = dep.contextlock.EnsAgentIdentityVerifier as Address;

const approver = privateKeyToAccount(process.env.APPROVER_STANDIN_PRIVATE_KEY! as Hex);
// NOTE: the approver signs but never broadcasts, so it holds no gas — exactly how a Ledger-held
// key behaves in practice.

const APPROVALS_ABI = [
  { type:"function", name:"approvalDigest", stateMutability:"view", inputs:[{type:"bytes32"},{type:"address"},{type:"uint64"}], outputs:[{type:"bytes32"}] },
  { type:"function", name:"submitApproval", stateMutability:"nonpayable", inputs:[{type:"bytes32"},{type:"uint64"},{type:"bytes"}], outputs:[] },
  { type:"function", name:"isApprovalValid", stateMutability:"view", inputs:[{type:"bytes32"}], outputs:[{type:"bool"}] },
  { type:"function", name:"approver", stateMutability:"view", inputs:[], outputs:[{type:"address"}] },
  { type:"error", name:"InvalidApprovalSignature", inputs:[] },
] as const;

const log = (...a: unknown[]) => console.log(...a);
const results: Array<{ id: string; result: string; detail: string; classification: string }> = [];
const evidence: Record<string, unknown> = {};
const rec = (id: string, ok: boolean, detail: string, cls = "live-sepolia") => {
  results.push({ id, result: ok ? "PASS" : "FAIL", detail, classification: cls });
  log(`  ${ok ? "PASS" : "FAIL"}  ${id.padEnd(10)} ${detail}`);
};

const RUN = Date.now().toString();
let aih: Hex; let seq = 0n;
const pc = (): Hex => { const p = PRIVATE_POLICY;
  return keccak256(toHex([p.policyId,p.policyVersion,p.enabled,p.autoLimit,p.escalationLimit,p.maxSlippageBps,
    p.maxVolatilityBps,p.minLiquidity,p.targetEthAllocationBps,p.rebalanceDriftBps,p.minHealthFactorBps,
    p.targetHealthFactorBps,p.proprietaryRiskThreshold].join("|"))); };
const cc = (c: ReturnType<typeof healthyContext>): Hex =>
  keccak256(toHex(`ctx:${c.observedAtUnix}:${c.slippageBps}:${c.volatilityBps}:${c.liquidity}:${c.healthFactorBps}`));

function build(amount: bigint, recipient: Address = RECIPIENT) {
  const cd = encodeFunctionData({ abi: TARGET_ABI, functionName: "transferTo", args: [recipient, amount] });
  const now = BigInt(Math.floor(Date.now() / 1000)); seq += 1n;
  const cap: Capability = {
    version: 1, agentIdentityHash: aih, agent: AGENT, chainId: 11155111n, executor: EXECUTOR_V2,
    target: TARGET, value: 0n, calldataHash: keccak256(cd), intentHash: keccak256(toHex(`p7-${RUN}-${seq}`)),
    policyHash: pc(), authorizationId: ("0x"+"0".repeat(64)) as Hex, contextCommitment: ("0x"+"0".repeat(64)) as Hex,
    issuedAt: now, expiresAt: now + 1800n, nonce: BigInt(Date.now()) * 10n + seq };
  return { cap, cd, amount };
}
async function creRoundTrip(cap: Capability, cd: Hex) {
  const ctx = healthyContext();
  const gw = await wRel.writeContract({ address: GATEWAY, abi: GATEWAY_ABI, functionName: "requestEvaluation",
    args: [cap.agentIdentityHash, cap.agent, dep.ens.node as Hex, cap.target, cap.value, cd, cap.intentHash,
           PRIVATE_POLICY.policyId as Hex, BigInt(PRIVATE_POLICY.policyVersion), ACTION_KIND] });
  await pub.waitForTransactionReceipt({ hash: gw });
  const decision = evaluatePolicy({
    requestHash: reqHash(cap), agentIdentityHash: cap.agentIdentityHash, ensNode: dep.ens.node, agent: cap.agent,
    chainId: 11155111, target: cap.target, value: cap.value, calldataHash: cap.calldataHash,
    selector: cd.slice(0,10), decodedRecipient: RECIPIENT, decodedAmount: BigInt("0x"+cd.slice(-64)),
    intentHash: cap.intentHash, policyId: PRIVATE_POLICY.policyId, policyVersion: PRIVATE_POLICY.policyVersion,
    actionKind: ACTION_KIND }, { ...PRIVATE_POLICY, authorizedAgentIdentityHashes: [aih] }, ctx, Math.floor(Date.now()/1000));
  const evaluatedAt = BigInt(Math.floor(Date.now()/1000));
  const validUntil = evaluatedAt + 1800n;
  const report = encodeAbiParameters(parseAbiParameters("bytes32 a, bytes32 b, bytes32 c, uint8 d, bytes32 e, uint64 f, uint64 g"),
    [reqHash(cap), pc(), cc(ctx), verdictToUint(decision.verdict), keccak256(toHex(decision.reasonCode)), evaluatedAt, validUntil]);
  const del = await wRel.writeContract({ address: CONSUMER, abi: CONSUMER_ABI, functionName: "onReport", args: [report] });
  await pub.waitForTransactionReceipt({ hash: del });
  const authId = await pub.readContract({ address: CONSUMER, abi: CONSUMER_ABI, functionName: "computeAuthorizationId",
    args: [reqHash(cap), pc(), evaluatedAt] }) as Hex;
  return { decision, authId, ctxC: cc(ctx), gw, del };
}
async function sign(cap: Capability): Promise<Hex> {
  return await issuer.signTypedData({ domain: domain(cap.chainId, cap.executor), types: CAPABILITY_TYPES, primaryType: "Capability", message: cap }) as Hex;
}
async function exec(cap: Capability, cd: Hex) {
  const sig = await sign(cap);
  try {
    const tx = await wRel.writeContract({ address: EXECUTOR_V2, abi: EXEC_ABI, functionName: "execute", args: [cap, sig, cd, ACTION_KIND] });
    const rc = await pub.waitForTransactionReceipt({ hash: tx });
    return { ok: rc.status === "success", tx, err: "" };
  } catch (e) { return { ok: false, tx: undefined, err: revertName(e) }; }
}
const count = () => pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "callCount" }) as Promise<bigint>;

async function main() {
  const chainId = await assertSepolia();
  log("=== ContextLock Phase 7 - three-path escalation boundary (live Sepolia) ===");
  log("chainId    =", chainId);
  log("executorV2 =", EXECUTOR_V2);
  log("approvals  =", APPROVALS);
  log("approver   =", approver.address, "  ⚠️ STAND-IN KEY, NOT a Ledger device (BLK-002)");
  log("issuer     =", issuer.address);

  const onChainApprover = await pub.readContract({ address: APPROVALS, abi: APPROVALS_ABI, functionName: "approver" }) as string;
  rec("P7-WIRING", onChainApprover.toLowerCase() === approver.address.toLowerCase()
    && onChainApprover.toLowerCase() !== issuer.address.toLowerCase(),
    `approver ${onChainApprover} is distinct from the capability issuer`);

  // bind identity + policy against executor V2
  const labelId = BigInt(dep.ens.labelId);
  const tokenId = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getTokenId", args: [labelId] }) as bigint;
  const owner = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "ownerOf", args: [tokenId] }) as Address;
  aih = await pub.readContract({ address: IDENTITY, abi: IDENTITY_ABI, functionName: "computeIdentityHash",
    args: [ENS.ethRegistry, labelId, owner, AGENT, tokenId, 1n] }) as Hex;
  try {
    const t = await wDep.writeContract({ address: IDENTITY, abi: IDENTITY_ABI, functionName: "bind", args: [ENS.ethRegistry, labelId, AGENT, 1n] });
    await pub.waitForTransactionReceipt({ hash: t });
  } catch (e) { if (!(e as Error).message.includes("0x682a9065")) throw e; }
  for (const [fn, args] of [["setPolicyAdmin",[aih, deployer.address]],["setPolicy",[aih, pc(), true, 10n**18n]],
    ["setTargetAllowed",[aih, pc(), TARGET, true]],["setActionAllowed",[aih, pc(), ACTION_KIND, true]]] as const) {
    const t = await wDep.writeContract({ address: POLICY_REGISTRY, abi: POLICY_ABI, functionName: fn as never, args: args as never });
    await pub.waitForTransactionReceipt({ hash: t });
  }

  // ───────── DEMO-A: ALLOW, autonomous ─────────
  log("\n─── DEMO-A: $500 rebalance -> ALLOW -> autonomous, no human ───");
  {
    const { cap, cd } = build(500_000_000n);
    const e = await creRoundTrip(cap, cd);
    cap.authorizationId = e.authId; cap.contextCommitment = e.ctxC;
    const d = capabilityDigest(cap);
    const approvalExists = await pub.readContract({ address: APPROVALS, abi: APPROVALS_ABI, functionName: "isApprovalValid", args: [d] }) as boolean;
    const before = await count();
    const r = await exec(cap, cd);
    const after = await count();
    rec("DEMO-A", e.decision.verdict === "ALLOW" && r.ok && after === before + 1n && !approvalExists,
      `ALLOW executed with NO approval on record. tx=${r.tx} callCount ${before}->${after}`);
    evidence["DEMO-A"] = { verdict: e.decision.verdict, executeTx: r.tx, humanApprovalOnRecord: approvalExists,
      capabilityDigest: d, callCountBefore: before.toString(), callCountAfter: after.toString() };
  }

  // ───────── DEMO-B: ESCALATE -> approval -> execute ─────────
  log("\n─── DEMO-B: $5,000 rebalance -> ESCALATE -> approval required ───");
  {
    const { cap, cd, amount } = build(5_000_000_000n);
    const e = await creRoundTrip(cap, cd);
    cap.authorizationId = e.authId; cap.contextCommitment = e.ctxC;
    const d = capabilityDigest(cap);
    log(`  verdict = ${e.decision.verdict} (${e.decision.reasonCode})`);

    // 1. without approval -> blocked
    const before = await count();
    const blocked = await exec(cap, cd);
    rec("LED-H02", !blocked.ok && blocked.err === "HumanApprovalRequired",
      `without approval the executor rejected: ${blocked.err}`);

    // 2. what the human would see on the device
    const summary = buildApprovalSummary({
      ensName: dep.ens.agentName, actionKind: "MOCK_TRANSFER", amount, tokenSymbol: "USDC", tokenDecimals: 6,
      recipient: RECIPIENT, target: TARGET, policyId: pc(), policyVersion: PRIVATE_POLICY.policyVersion,
      expiresAt: cap.expiresAt, capabilityDigest: d });
    log("  ── human-readable summary (what a Clear-Signing device would render) ──");
    for (const [k, v] of Object.entries(summary)) log(`     ${k.padEnd(18)} ${v}`);

    // 3. approval signature (STAND-IN key, not a device)
    const expiresAt = BigInt(Math.floor(Date.now()/1000)) + 1800n;
    const ad = await pub.readContract({ address: APPROVALS, abi: APPROVALS_ABI, functionName: "approvalDigest",
      args: [d, approver.address, expiresAt] }) as Hex;
    const approvalSig = await approver.sign({ hash: ad });
    // The RELAYER broadcasts the approval, not the approver. This mirrors real hardware usage:
    // a Ledger signs offline and never needs to hold gas. submitApproval is permissionless
    // precisely because the signature is the authority — who relays it is irrelevant.
    const sub = await wRel.writeContract({ address: APPROVALS, abi: APPROVALS_ABI, functionName: "submitApproval",
      args: [d, expiresAt, approvalSig] });
    await pub.waitForTransactionReceipt({ hash: sub });
    const valid = await pub.readContract({ address: APPROVALS, abi: APPROVALS_ABI, functionName: "isApprovalValid", args: [d] }) as boolean;
    log(`  approval submitted tx=${sub}  valid=${valid}`);

    // 4. now it executes
    const r = await exec(cap, cd);
    const after = await count();
    rec("DEMO-B", e.decision.verdict === "ESCALATE" && valid && r.ok && after === before + 1n,
      `ESCALATE + approval executed the exact transaction. tx=${r.tx} callCount ${before}->${after}`,
      "live-sepolia (approval signature from STAND-IN key, not a Ledger device)");

    // 5. approval is single-use
    const replay = await exec(cap, cd);
    rec("LED-H06", !replay.ok, `approval/nonce replay rejected: ${replay.err}`);

    evidence["DEMO-B"] = { verdict: e.decision.verdict, reason: e.decision.reasonCode,
      blockedWithoutApproval: blocked.err, humanReadableSummary: summary,
      approvalDigest: ad, approvalTx: sub, approvalValid: valid, executeTx: r.tx,
      replayError: replay.err, approvalSignedBy: approver.address,
      approvalSource: "STAND-IN KEY - no physical Ledger attached (BLK-002)" };
  }

  // ───────── DEMO-C: DENY cannot be escalated ─────────
  log("\n─── DEMO-C: attacker transfer -> DENY -> no Ledger escape hatch ───");
  {
    const ATTACKER = "0x000000000000000000000000000000000000dEaD" as Address;
    const { cap, cd } = build(50_000_000_000n, ATTACKER);
    const e = await creRoundTrip(cap, cd);
    cap.authorizationId = e.authId; cap.contextCommitment = e.ctxC;
    const d = capabilityDigest(cap);
    const before = await count();

    // The human signs a genuine, valid approval for this exact capability.
    const expiresAt = BigInt(Math.floor(Date.now()/1000)) + 1800n;
    const ad = await pub.readContract({ address: APPROVALS, abi: APPROVALS_ABI, functionName: "approvalDigest",
      args: [d, approver.address, expiresAt] }) as Hex;
    const approvalSig = await approver.sign({ hash: ad });
    // The RELAYER broadcasts the approval, not the approver. This mirrors real hardware usage:
    // a Ledger signs offline and never needs to hold gas. submitApproval is permissionless
    // precisely because the signature is the authority — who relays it is irrelevant.
    const sub = await wRel.writeContract({ address: APPROVALS, abi: APPROVALS_ABI, functionName: "submitApproval",
      args: [d, expiresAt, approvalSig] });
    await pub.waitForTransactionReceipt({ hash: sub });
    const valid = await pub.readContract({ address: APPROVALS, abi: APPROVALS_ABI, functionName: "isApprovalValid", args: [d] }) as boolean;
    log(`  a REAL, VALID approval was recorded for the DENIED capability: valid=${valid} tx=${sub}`);

    const r = await exec(cap, cd);
    const after = await count();
    const stillValid = await pub.readContract({ address: APPROVALS, abi: APPROVALS_ABI, functionName: "isApprovalValid", args: [d] }) as boolean;
    const attackerBal = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "balanceOf", args: [ATTACKER] }) as bigint;

    rec("DEMO-C", e.decision.verdict === "DENY" && valid && !r.ok && r.err === "AuthorizationNotAllow"
      && after === before && attackerBal === 0n && stillValid,
      `DENY + valid approval STILL rejected (${r.err}); approval never even consumed; attacker balance ${attackerBal}`);
    evidence["DEMO-C"] = { verdict: e.decision.verdict, reason: e.decision.reasonCode,
      approvalWasValid: valid, approvalTx: sub, executorError: r.err,
      approvalStillUnconsumed: stillValid, attackerBalance: attackerBal.toString(),
      note: "The approval branch is unreachable from DENY, so the approval was not even read." };
  }

  log("\n=== RESULTS ===");
  for (const r of results) log(`${r.result.padEnd(5)} ${r.id.padEnd(10)} ${r.detail}`);
  writeFileSync(join(ROOT, "reports/phase-07/test-results/p7-live-results.json"),
    JSON.stringify({ chainId, executorV2: EXECUTOR_V2, approvalRegistry: APPROVALS,
      approverStatus: "STAND-IN KEY - no physical Ledger attached (BLK-002)",
      clearSigningPhysicallyRendered: false, results, evidence }, null, 2) + "\n");
  const failed = results.filter((r) => r.result === "FAIL");
  if (failed.length) { log(`\n${failed.length} FAILED`); process.exit(1); }
  log("\nALL PHASE 7 LIVE SCENES PASSED (contract boundary; hardware approval still blocked)");
}
main().catch((e) => { console.error(e); process.exit(1); });
