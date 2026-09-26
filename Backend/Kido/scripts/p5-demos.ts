/**
 * Phase 5: DEMO-001..007 — the complete autonomous flow on live Sepolia.
 *
 * Scenario: Autonomous Treasury Rebalancer. Target 50/50 USDC/ETH, currently 55/45, so the agent
 * proposes moving 500 USDC-equivalent. Amounts are integer base units (6dp).
 *
 * CRE verdicts are produced in CRE_MODE=sdk-local-tests (see reports/phase-04/CRE_MODE.md).
 * Every on-chain step — gateway, consumer, registry, executor, ENS — is LIVE.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters, toHex, type Hex, type Address } from "viem";
import {
  ROOT, dep, pub, wDep, wRel, deployer, issuer, relayer, AGENT, assertSepolia, revertName,
  POLICY_REGISTRY, AUTH_REGISTRY, IDENTITY, EXECUTOR, TARGET, GATEWAY, CONSUMER,
  ACTION_KIND, RECIPIENT, PRIVATE_POLICY, healthyContext,
  IDENTITY_ABI, POLICY_ABI, CONSUMER_ABI, AUTHREG_ABI, EXEC_ABI, TARGET_ABI, GATEWAY_ABI,
} from "./lib/harness.js";
import { evaluatePolicy, verdictToUint, type MarketContext } from "@contextlock/policy";
import { CAPABILITY_TYPES, domain, requestHash as reqHash, capabilityDigest, type Capability } from "../packages/protocol/src/capability.js";
import { ENS_V2_SEPOLIA as ENS, ETH_REGISTRY_ABI } from "../packages/ens/src/deployments.js";
import { RequestState } from "../apps/broker/src/state-machine.js";

const log = (...a: unknown[]) => console.log(...a);
const results: Array<{ id: string; result: string; detail: string; classification: string }> = [];
const evidence: Record<string, unknown> = {};
const rec = (id: string, ok: boolean, detail: string, cls = "live-sepolia") => {
  results.push({ id, result: ok ? "PASS" : "FAIL", detail, classification: cls });
  log(`  ${ok ? "PASS" : "FAIL"}  ${id.padEnd(10)} ${detail}`);
};

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
  keccak256(toHex(`ctx:${c.observedAtUnix}:${c.slippageBps}:${c.volatilityBps}:${c.liquidity}:${c.headroom ?? c.healthFactorBps}`));

function build(amount: bigint, recipient: Address = RECIPIENT, label = "rebalance") {
  const cd = encodeFunctionData({ abi: TARGET_ABI, functionName: "transferTo", args: [recipient, amount] });
  const now = BigInt(Math.floor(Date.now() / 1000));
  seq += 1n;
  const cap: Capability = {
    version: 1, agentIdentityHash: aih, agent: AGENT, chainId: 11155111n, executor: EXECUTOR,
    target: TARGET, value: 0n, calldataHash: keccak256(cd),
    intentHash: keccak256(toHex(`${label}:${RUN}:${seq}`)), policyHash: pc(),
    authorizationId: ("0x" + "0".repeat(64)) as Hex, contextCommitment: ("0x" + "0".repeat(64)) as Hex,
    issuedAt: now, expiresAt: now + 1800n, nonce: BigInt(Date.now()) * 10n + seq,
  };
  return { cap, cd, amount, recipient };
}

/** Full CRE round trip on live Sepolia. Returns the verdict and the on-chain authorization. */
async function creRoundTrip(cap: Capability, cd: Hex, ctx = healthyContext(), amountOverride?: bigint) {
  const gwTx = await wRel.writeContract({ address: GATEWAY, abi: GATEWAY_ABI, functionName: "requestEvaluation",
    args: [cap.agentIdentityHash, cap.agent, dep.ens.node as Hex, cap.target, cap.value, cd,
           cap.intentHash, PRIVATE_POLICY.policyId as Hex, BigInt(PRIVATE_POLICY.policyVersion), ACTION_KIND] });
  await pub.waitForTransactionReceipt({ hash: gwTx });

  const decodedAmount = amountOverride ?? BigInt("0x" + cd.slice(-64));
  const decision = evaluatePolicy({
    requestHash: reqHash(cap), agentIdentityHash: cap.agentIdentityHash, ensNode: dep.ens.node,
    agent: cap.agent, chainId: 11155111, target: cap.target, value: cap.value,
    calldataHash: cap.calldataHash, selector: cd.slice(0, 10),
    decodedRecipient: ("0x" + cd.slice(34, 74)) as Address, decodedAmount,
    intentHash: cap.intentHash, policyId: PRIVATE_POLICY.policyId,
    policyVersion: PRIVATE_POLICY.policyVersion, actionKind: ACTION_KIND,
  }, { ...PRIVATE_POLICY, authorizedAgentIdentityHashes: [aih] }, ctx, Math.floor(Date.now() / 1000));

  const evaluatedAt = BigInt(Math.floor(Date.now() / 1000));
  const validUntil = evaluatedAt + BigInt(decision.ttlSeconds || 60);
  const ctxC = cc(ctx);
  const report = encodeAbiParameters(
    parseAbiParameters("bytes32 a, bytes32 b, bytes32 c, uint8 d, bytes32 e, uint64 f, uint64 g"),
    [reqHash(cap), pc(), ctxC, verdictToUint(decision.verdict), keccak256(toHex(decision.reasonCode)), evaluatedAt, validUntil]);
  const delTx = await wRel.writeContract({ address: CONSUMER, abi: CONSUMER_ABI, functionName: "onReport", args: [report] });
  await pub.waitForTransactionReceipt({ hash: delTx });
  const authId = await pub.readContract({ address: CONSUMER, abi: CONSUMER_ABI, functionName: "computeAuthorizationId",
    args: [reqHash(cap), pc(), evaluatedAt] }) as Hex;
  return { decision, authId, ctxC, gwTx, delTx, evaluatedAt, validUntil };
}

async function sign(cap: Capability): Promise<Hex> {
  return await issuer.signTypedData({ domain: domain(cap.chainId, cap.executor), types: CAPABILITY_TYPES, primaryType: "Capability", message: cap }) as Hex;
}
async function exec(cap: Capability, cd: Hex, sigOverride?: Hex) {
  const sig = sigOverride ?? await sign(cap);
  try {
    const tx = await wRel.writeContract({ address: EXECUTOR, abi: EXEC_ABI, functionName: "execute", args: [cap, sig, cd, ACTION_KIND] });
    const rc = await pub.waitForTransactionReceipt({ hash: tx });
    return { ok: rc.status === "success", tx, err: "", block: rc.blockNumber };
  } catch (e) { return { ok: false, tx: undefined, err: revertName(e), block: undefined }; }
}
const count = () => pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "callCount" }) as Promise<bigint>;

async function main() {
  const chainId = await assertSepolia();
  log("=== ContextLock Phase 5 - Autonomous Treasury Rebalancer (live Sepolia) ===");
  log("chainId  =", chainId, "| executor =", EXECUTOR, "| target =", TARGET);
  log("agent    =", AGENT, "(untrusted)");
  log("issuer   =", issuer.address, "| relayer =", relayer.address, "| deployer =", deployer.address);
  log("ENS name =", dep.ens.agentName);
  log("scenario : target 50/50 USDC/ETH, currently 55/45 -> rebalance 500 units");

  // Bind identity to current live ENS state + configure policy.
  const labelId = BigInt(dep.ens.labelId);
  const tokenId = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getTokenId", args: [labelId] }) as bigint;
  const owner = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "ownerOf", args: [tokenId] }) as Address;
  aih = await pub.readContract({ address: IDENTITY, abi: IDENTITY_ABI, functionName: "computeIdentityHash",
    args: [ENS.ethRegistry, labelId, owner, AGENT, tokenId, 1n] }) as Hex;
  try {
    const t = await wDep.writeContract({ address: IDENTITY, abi: IDENTITY_ABI, functionName: "bind", args: [ENS.ethRegistry, labelId, AGENT, 1n] });
    await pub.waitForTransactionReceipt({ hash: t });
  } catch (e) { if (!(e as Error).message.includes("0x682a9065")) throw e; }
  for (const [fn, args] of [
    ["setPolicyAdmin", [aih, deployer.address]], ["setPolicy", [aih, pc(), true, 10n ** 18n]],
    ["setTargetAllowed", [aih, pc(), TARGET, true]], ["setActionAllowed", [aih, pc(), ACTION_KIND, true]],
  ] as const) {
    const t = await wDep.writeContract({ address: POLICY_REGISTRY, abi: POLICY_ABI, functionName: fn as never, args: args as never });
    await pub.waitForTransactionReceipt({ hash: t });
  }
  log("agentIdentityHash =", aih);

  // ───────────────── DEMO-001: normal autonomous execution ─────────────────
  log("\n─── DEMO-001: agent proposes a valid low-risk rebalance ───");
  {
    const { cap, cd } = build(500_000_000n);
    const states: string[] = [RequestState.RECEIVED, RequestState.IDENTITY_VALIDATED, RequestState.POLICY_EVALUATING];
    const e = await creRoundTrip(cap, cd);
    states.push(e.decision.verdict === "ALLOW" ? RequestState.AUTHORIZED : RequestState.DENIED);
    cap.authorizationId = e.authId; cap.contextCommitment = e.ctxC;
    states.push(RequestState.CAPABILITY_ISSUED);
    const before = await count();
    const balBefore = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "balanceOf", args: [RECIPIENT] }) as bigint;
    states.push(RequestState.SUBMITTED);
    const r = await exec(cap, cd);
    const after = await count();
    const balAfter = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "balanceOf", args: [RECIPIENT] }) as bigint;
    states.push(r.ok ? RequestState.EXECUTED : RequestState.REVERTED);
    rec("DEMO-001", e.decision.verdict === "ALLOW" && r.ok && after === before + 1n,
      `ALLOW -> executed autonomously, no human. tx=${r.tx} callCount ${before}->${after}`);
    evidence["DEMO-001"] = { verdict: e.decision.verdict, reason: e.decision.reasonCode,
      gatewayTx: e.gwTx, consumerTx: e.delTx, authorizationId: e.authId,
      capabilityDigest: capabilityDigest(cap), executeTx: r.tx, block: r.block?.toString(),
      preState: { callCount: before.toString(), recipientBalance: balBefore.toString() },
      postState: { callCount: after.toString(), recipientBalance: balAfter.toString() },
      stateProgression: states, humanApprovalInvolved: false };
  }

  // ───────────────── DEMO-002: prompt injection / theft ─────────────────
  log("\n─── DEMO-002: compromised agent tries to send treasury to an attacker ───");
  {
    const ATTACKER = "0x000000000000000000000000000000000000dEaD" as Address;
    const { cap, cd } = build(50_000_000_000n, ATTACKER, "drain");
    const before = await count();
    const e = await creRoundTrip(cap, cd);
    cap.authorizationId = e.authId; cap.contextCommitment = e.ctxC;
    const r = await exec(cap, cd);
    const after = await count();
    const attackerBal = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "balanceOf", args: [ATTACKER] }) as bigint;
    rec("DEMO-002", e.decision.verdict === "DENY" && !r.ok && after === before && attackerBal === 0n,
      `DENY(${e.decision.reasonCode}); executor rejected ${r.err}; attacker balance ${attackerBal}`);
    evidence["DEMO-002"] = { attacker: ATTACKER, verdict: e.decision.verdict, reason: e.decision.reasonCode,
      executorError: r.err, attackerBalance: attackerBal.toString(),
      targetStateBefore: before.toString(), targetStateAfter: after.toString(),
      executableCapabilities: 0 };
  }

  // ───────────────── DEMO-003: capability mutation ─────────────────
  log("\n─── DEMO-003: mutate a legitimately issued capability ───");
  {
    const { cap, cd } = build(500_000_000n);
    const e = await creRoundTrip(cap, cd);
    cap.authorizationId = e.authId; cap.contextCommitment = e.ctxC;
    const goodSig = await sign(cap);
    const before = await count();
    const mutations: Record<string, string> = {};

    // amount mutation - calldata no longer matches the committed hash
    const bigCd = encodeFunctionData({ abi: TARGET_ABI, functionName: "transferTo", args: [RECIPIENT, 9_000_000_000n] });
    mutations["amount"] = (await exec(cap, bigCd, goodSig)).err;
    // recipient mutation
    const attackerCd = encodeFunctionData({ abi: TARGET_ABI, functionName: "transferTo", args: ["0x000000000000000000000000000000000000dEaD" as Address, 500_000_000n] });
    mutations["recipient"] = (await exec(cap, attackerCd, goodSig)).err;
    // target mutation
    const tCap = { ...cap, target: "0x000000000000000000000000000000000000dEaD" as Address };
    mutations["target"] = (await exec(tCap, cd, goodSig)).err;
    // raw calldata byte flip
    const flipped = (cd.slice(0, -2) + (cd.slice(-2) === "00" ? "01" : "00")) as Hex;
    mutations["calldata"] = (await exec(cap, flipped, goodSig)).err;

    const after = await count();
    const allRejected = Object.values(mutations).every((m) => m && m !== "");
    rec("DEMO-003", allRejected && after === before,
      `4/4 mutations rejected: ${JSON.stringify(mutations)}`);
    evidence["DEMO-003"] = { mutations, targetStateBefore: before.toString(), targetStateAfter: after.toString() };
  }

  // ───────────────── DEMO-005: context invalidation ─────────────────
  log("\n─── DEMO-005: security-relevant state changes after authorization ───");
  {
    const { cap, cd } = build(500_000_000n);
    const e = await creRoundTrip(cap, cd);
    cap.authorizationId = e.authId; cap.contextCommitment = e.ctxC;
    const before = await count();
    const notExpired = cap.expiresAt > BigInt(Math.floor(Date.now() / 1000));

    // Disable the policy AFTER the CRE authorization was recorded. This is a real state change,
    // not merely letting the capability age out.
    const dis = await wDep.writeContract({ address: POLICY_REGISTRY, abi: POLICY_ABI, functionName: "setPolicy", args: [aih, pc(), false, 10n ** 18n] });
    await pub.waitForTransactionReceipt({ hash: dis });
    const r = await exec(cap, cd);
    const after = await count();
    // restore
    const en = await wDep.writeContract({ address: POLICY_REGISTRY, abi: POLICY_ABI, functionName: "setPolicy", args: [aih, pc(), true, 10n ** 18n] });
    await pub.waitForTransactionReceipt({ hash: en });

    rec("DEMO-005", !r.ok && r.err === "PolicyDisabled" && after === before && notExpired,
      `policy disabled post-authorization -> ${r.err}; capability had NOT expired`);
    evidence["DEMO-005"] = { disableTx: dis, restoreTx: en, executorError: r.err,
      capabilityExpiresAt: cap.expiresAt.toString(), capabilityWasStillValid: notExpired,
      note: "Failure is a live policy-state change, not capability expiry." };
  }

  // ───────────────── DEMO-006: replay ─────────────────
  log("\n─── DEMO-006: replay a successfully executed capability ───");
  {
    const { cap, cd } = build(500_000_000n);
    const e = await creRoundTrip(cap, cd);
    cap.authorizationId = e.authId; cap.contextCommitment = e.ctxC;
    const sig = await sign(cap);
    const first = await exec(cap, cd, sig);
    const mid = await count();
    const second = await exec(cap, cd, sig);
    const after = await count();
    rec("DEMO-006", first.ok && !second.ok && second.err === "NonceUsed" && after === mid,
      `first tx=${first.tx}; replay rejected ${second.err}; callCount unchanged at ${after}`);
    evidence["DEMO-006"] = { firstExecuteTx: first.tx, replayError: second.err,
      callCountAfterFirst: mid.toString(), callCountAfterReplay: after.toString() };
  }

  // ───────────────── DEMO-007: ESCALATE fails closed at Phase 5 ─────────────────
  log("\n─── DEMO-007: high-risk request -> ESCALATE, no autonomous path ───");
  {
    const { cap, cd } = build(5_000_000_000n, RECIPIENT, "high-risk");
    const before = await count();
    const e = await creRoundTrip(cap, cd);
    cap.authorizationId = e.authId; cap.contextCommitment = e.ctxC;
    const r = await exec(cap, cd);
    const after = await count();
    rec("DEMO-007", e.decision.verdict === "ESCALATE" && !r.ok && r.err === "AuthorizationNotAllow" && after === before,
      `ESCALATE(${e.decision.reasonCode}); no autonomous capability, executor rejected ${r.err}`);
    evidence["DEMO-007"] = { verdict: e.decision.verdict, reason: e.decision.reasonCode,
      authorizationId: e.authId, executorError: r.err,
      humanApprovalProviderStatus: "fails closed at Phase 5 - Ledger arrives in Phase 7",
      targetStateUnchanged: after === before };
  }

  // ───────────────── DEMO-004: ENS revocation (regression) ─────────────────
  log("\n─── DEMO-004: ENS revocation still invalidates outstanding capability ───");
  {
    const { cap, cd } = build(500_000_000n);
    const e = await creRoundTrip(cap, cd);
    cap.authorizationId = e.authId; cap.contextCommitment = e.ctxC;
    const before = await count();
    const idBefore = await pub.readContract({ address: IDENTITY, abi: IDENTITY_ABI, functionName: "isIdentityCurrent", args: [aih, AGENT] }) as boolean;
    const notExpired = cap.expiresAt > BigInt(Math.floor(Date.now() / 1000));

    // Revoke an ENS role -> token id regenerates -> identity changes.
    const ROLES_ABI = [{ type:"function", name:"revokeRoles", stateMutability:"nonpayable", inputs:[{type:"uint256"},{type:"uint256"},{type:"address"}], outputs:[{type:"bool"}] },
                       { type:"function", name:"grantRoles", stateMutability:"nonpayable", inputs:[{type:"uint256"},{type:"uint256"},{type:"address"}], outputs:[{type:"bool"}] }] as const;
    const rev = await wDep.writeContract({ address: ENS.ethRegistry, abi: ROLES_ABI, functionName: "revokeRoles", args: [labelId, 1n << 24n, deployer.address] });
    await pub.waitForTransactionReceipt({ hash: rev });
    const idAfter = await pub.readContract({ address: IDENTITY, abi: IDENTITY_ABI, functionName: "isIdentityCurrent", args: [aih, AGENT] }) as boolean;
    const r = await exec(cap, cd);
    const after = await count();
    // restore for later phases
    const gr = await wDep.writeContract({ address: ENS.ethRegistry, abi: ROLES_ABI, functionName: "grantRoles", args: [labelId, 1n << 24n, deployer.address] });
    await pub.waitForTransactionReceipt({ hash: gr });

    rec("DEMO-004", !r.ok && r.err === "IdentityNotCurrent" && after === before && idBefore && !idAfter && notExpired,
      `ENS role revoked -> ${r.err}; identity ${idBefore}->${idAfter}; capability unexpired`);
    evidence["DEMO-004"] = { revokeTx: rev, restoreTx: gr, identityBefore: idBefore, identityAfter: idAfter,
      executorError: r.err, capabilityWasUnexpired: notExpired };
  }

  const final = await count();
  log("\nfinal target callCount =", final.toString());
  log("\n=== RESULTS ===");
  for (const r of results) log(`${r.result.padEnd(5)} ${r.id.padEnd(10)} ${r.detail}`);
  writeFileSync(join(ROOT, "reports/phase-05/test-results/p5-demo-results.json"),
    JSON.stringify({ chainId, creMode: "sdk-local-tests", scenario: "Autonomous Treasury Rebalancer",
      agentIdentityHash: aih, results, evidence, finalCallCount: final.toString() }, null, 2) + "\n");
  const failed = results.filter((r) => r.result === "FAIL");
  if (failed.length) { log(`\n${failed.length} FAILED`); process.exit(1); }
  log("\nALL PHASE 5 DEMOS PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
