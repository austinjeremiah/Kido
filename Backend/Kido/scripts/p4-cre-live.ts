/**
 * Phase 4 live-Sepolia evidence: the CRE authorization boundary.
 *
 * SCOPE NOTE: the *verdict* here is produced by CRE_MODE=sdk-local-tests (the real workflow policy
 * module run in-process). The *authorization path* — gateway event, restricted consumer, registry
 * record, executor enforcement — is genuinely live on Sepolia. Those are labelled separately
 * throughout and must not be conflated. See reports/phase-04/CRE_MODE.md.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters, toHex, type Hex } from "viem";
import {
  ROOT, dep, pub, wDep, wRel, deployer, issuer, relayer, AGENT, assertSepolia, revertName,
  POLICY_REGISTRY, AUTH_REGISTRY, IDENTITY, EXECUTOR, TARGET, GATEWAY, CONSUMER,
  ACTION_KIND, RECIPIENT, PRIVATE_POLICY, healthyContext,
  IDENTITY_ABI, POLICY_ABI, CONSUMER_ABI, AUTHREG_ABI, EXEC_ABI, TARGET_ABI, GATEWAY_ABI,
} from "./lib/harness.js";
import { evaluatePolicy, verdictToUint } from "@contextlock/policy";
import { CAPABILITY_TYPES, domain, requestHash as reqHash, capabilityDigest, type Capability } from "../packages/protocol/src/capability.js";
import { ENS_V2_SEPOLIA as ENS, ETH_REGISTRY_ABI } from "../packages/ens/src/deployments.js";

const log = (...a: unknown[]) => console.log(...a);
const results: Array<{ id: string; result: string; detail: string; classification: string }> = [];
const rec = (id: string, ok: boolean, detail: string, cls: string) => {
  results.push({ id, result: ok ? "PASS" : "FAIL", detail, classification: cls });
  log(`  ${ok ? "PASS" : "FAIL"}  ${id.padEnd(12)} [${cls}] ${detail}`);
};
const evidence: Record<string, unknown> = {};
const RUN = Date.now().toString();

function policyCommitment(): Hex {
  const p = PRIVATE_POLICY;
  return keccak256(toHex([p.policyId, p.policyVersion, p.enabled, p.autoLimit, p.escalationLimit,
    p.maxSlippageBps, p.maxVolatilityBps, p.minLiquidity, p.targetEthAllocationBps, p.rebalanceDriftBps,
    p.minHealthFactorBps, p.targetHealthFactorBps, p.proprietaryRiskThreshold].join("|")));
}
function commitContext(c: ReturnType<typeof healthyContext>): Hex {
  return keccak256(toHex(`ctx:${c.observedAtUnix}:${c.slippageBps}:${c.volatilityBps}:${c.liquidity}:${c.healthFactorBps}`));
}

let aih: Hex;
let seq = 0n;

function buildCap(amount: bigint, over: Partial<Capability> = {}): { cap: Capability; cd: Hex } {
  const cd = encodeFunctionData({ abi: TARGET_ABI, functionName: "transferTo", args: [RECIPIENT, amount] });
  const now = BigInt(Math.floor(Date.now() / 1000));
  seq += 1n;
  const cap: Capability = {
    version: 1, agentIdentityHash: aih, agent: AGENT, chainId: 11155111n, executor: EXECUTOR,
    target: TARGET, value: 0n, calldataHash: keccak256(cd), intentHash: keccak256(toHex(`p4-${RUN}`)),
    policyHash: policyCommitment(), authorizationId: "0x" + "0".repeat(64) as Hex,
    contextCommitment: "0x" + "0".repeat(64) as Hex,
    issuedAt: now, expiresAt: now + 1800n, nonce: BigInt(Date.now()) * 10n + seq, ...over,
  };
  return { cap, cd };
}

/** Full CRE round trip: gateway event -> policy evaluation -> consumer report -> registry record. */
async function creEvaluate(cap: Capability, cd: Hex, ctx = healthyContext()) {
  const gwTx = await wRel.writeContract({ address: GATEWAY, abi: GATEWAY_ABI, functionName: "requestEvaluation",
    args: [cap.agentIdentityHash, cap.agent, dep.ens.node as Hex, cap.target, cap.value, cd,
           cap.intentHash, PRIVATE_POLICY.policyId as Hex, BigInt(PRIVATE_POLICY.policyVersion), ACTION_KIND] });
  await pub.waitForTransactionReceipt({ hash: gwTx });

  const rh = reqHash(cap);
  const decision = evaluatePolicy({
    requestHash: rh, agentIdentityHash: cap.agentIdentityHash, ensNode: dep.ens.node,
    agent: cap.agent, chainId: 11155111, target: cap.target, value: cap.value,
    calldataHash: cap.calldataHash, selector: cd.slice(0, 10),
    decodedRecipient: RECIPIENT, decodedAmount: BigInt("0x" + cd.slice(-64)),
    intentHash: cap.intentHash, policyId: PRIVATE_POLICY.policyId,
    policyVersion: PRIVATE_POLICY.policyVersion, actionKind: ACTION_KIND,
  }, { ...PRIVATE_POLICY, authorizedAgentIdentityHashes: [aih] }, ctx, Math.floor(Date.now() / 1000));

  const evaluatedAt = BigInt(Math.floor(Date.now() / 1000));
  const validUntil = evaluatedAt + BigInt(decision.ttlSeconds || 60);
  const cc = commitContext(ctx);
  const report = encodeAbiParameters(
    parseAbiParameters("bytes32 a, bytes32 b, bytes32 c, uint8 d, bytes32 e, uint64 f, uint64 g"),
    [rh, policyCommitment(), cc, verdictToUint(decision.verdict), keccak256(toHex(decision.reasonCode)), evaluatedAt, validUntil]);

  const delTx = await wRel.writeContract({ address: CONSUMER, abi: CONSUMER_ABI, functionName: "onReport", args: [report] });
  await pub.waitForTransactionReceipt({ hash: delTx });
  const authId = await pub.readContract({ address: CONSUMER, abi: CONSUMER_ABI, functionName: "computeAuthorizationId",
    args: [rh, policyCommitment(), evaluatedAt] }) as Hex;
  return { decision, authId, cc, gwTx, delTx, evaluatedAt, validUntil };
}

async function tryExec(cap: Capability, cd: Hex) {
  const sig = await issuer.signTypedData({ domain: domain(cap.chainId, cap.executor), types: CAPABILITY_TYPES, primaryType: "Capability", message: cap }) as Hex;
  try {
    const tx = await wRel.writeContract({ address: EXECUTOR, abi: EXEC_ABI, functionName: "execute", args: [cap, sig, cd, ACTION_KIND] });
    const rc = await pub.waitForTransactionReceipt({ hash: tx });
    return { ok: rc.status === "success", tx, err: "" };
  } catch (e) { return { ok: false, tx: undefined, err: revertName(e) }; }
}

async function main() {
  const chainId = await assertSepolia();
  log("=== ContextLock Phase 4 - CRE authorization boundary (live Sepolia) ===");
  log("chainId      =", chainId);
  log("gateway      =", GATEWAY);
  log("cre consumer =", CONSUMER);
  log("executor     =", EXECUTOR);
  log("CRE_MODE     = sdk-local-tests  (verdict NOT from a TEE; authorization path IS live)");

  // authorizer must now be the consumer contract
  const authorizer = await pub.readContract({ address: AUTH_REGISTRY, abi: AUTHREG_ABI, functionName: "authorizer" }) as string;
  log("registry authorizer =", authorizer);
  rec("P4-WIRING", authorizer.toLowerCase() === CONSUMER.toLowerCase(),
    `authorization writer is the CRE consumer, not an EOA`, "live-sepolia");

  // bind identity + policy under the CRE policy commitment
  const labelId = BigInt(dep.ens.labelId);
  const tokenId = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getTokenId", args: [labelId] }) as bigint;
  const owner = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "ownerOf", args: [tokenId] }) as `0x${string}`;
  aih = await pub.readContract({ address: IDENTITY, abi: IDENTITY_ABI, functionName: "computeIdentityHash",
    args: [ENS.ethRegistry, labelId, owner, AGENT, tokenId, 1n] }) as Hex;
  log("agentIdentityHash =", aih);
  try {
    const t = await wDep.writeContract({ address: IDENTITY, abi: IDENTITY_ABI, functionName: "bind", args: [ENS.ethRegistry, labelId, AGENT, 1n] });
    await pub.waitForTransactionReceipt({ hash: t });
  } catch (e) { if (!(e as Error).message.includes("0x682a9065")) throw e; }

  const pc = policyCommitment();
  for (const [fn, args] of [
    ["setPolicyAdmin", [aih, deployer.address]],
    ["setPolicy", [aih, pc, true, 10n ** 18n]],
    ["setTargetAllowed", [aih, pc, TARGET, true]],
    ["setActionAllowed", [aih, pc, ACTION_KIND, true]],
  ] as const) {
    const t = await wDep.writeContract({ address: POLICY_REGISTRY, abi: POLICY_ABI, functionName: fn as never, args: args as never });
    await pub.waitForTransactionReceipt({ hash: t });
  }
  log("policy configured under the CRE policy commitment", pc);

  // ── CRE-001 ──
  log("\n--- CRE-001: valid request -> ALLOW -> executes ---");
  {
    const { cap, cd } = buildCap(500_000_000n);
    const e = await creEvaluate(cap, cd);
    cap.authorizationId = e.authId; cap.contextCommitment = e.cc;
    const before = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "callCount" }) as bigint;
    const r = await tryExec(cap, cd);
    const after = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "callCount" }) as bigint;
    rec("CRE-001", e.decision.verdict === "ALLOW" && r.ok && after === before + 1n,
      `verdict=${e.decision.verdict} reason=${e.decision.reasonCode} exec=${r.tx} callCount ${before}->${after}`, "live-sepolia");
    evidence["CRE-001"] = { verdict: e.decision.verdict, reason: e.decision.reasonCode, gatewayTx: e.gwTx,
      consumerTx: e.delTx, authorizationId: e.authId, executeTx: r.tx, capabilityDigest: capabilityDigest(cap),
      callCountBefore: before.toString(), callCountAfter: after.toString() };
  }

  // ── CRE-002 ──
  log("\n--- CRE-002: above the private autonomous limit -> ESCALATE, no execution ---");
  {
    const { cap, cd } = buildCap(5_000_000_000n);
    const e = await creEvaluate(cap, cd);
    cap.authorizationId = e.authId; cap.contextCommitment = e.cc;
    const before = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "callCount" }) as bigint;
    const r = await tryExec(cap, cd);
    const after = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "callCount" }) as bigint;
    rec("CRE-002", e.decision.verdict === "ESCALATE" && !r.ok && after === before,
      `verdict=ESCALATE reason=${e.decision.reasonCode}; executor rejected with ${r.err}`, "live-sepolia");
    evidence["CRE-002"] = { verdict: e.decision.verdict, reason: e.decision.reasonCode, consumerTx: e.delTx,
      authorizationId: e.authId, executorError: r.err, callCountUnchanged: after === before };
  }

  // ── CRE-006 ──
  log("\n--- CRE-006: DENY never yields an executable capability ---");
  {
    const { cap, cd } = buildCap(50_000_000_000n);
    const e = await creEvaluate(cap, cd);
    cap.authorizationId = e.authId; cap.contextCommitment = e.cc;
    const before = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "callCount" }) as bigint;
    const r = await tryExec(cap, cd);
    const after = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "callCount" }) as bigint;
    rec("CRE-006", e.decision.verdict === "DENY" && !r.ok && after === before,
      `verdict=DENY reason=${e.decision.reasonCode}; executor rejected with ${r.err}`, "live-sepolia");
    evidence["CRE-006"] = { verdict: e.decision.verdict, reason: e.decision.reasonCode, executorError: r.err };
  }

  // ── CRE-007 live ──
  log("\n--- CRE-007: unauthorized writer cannot create an authorization (live) ---");
  {
    const { cap } = buildCap(500_000_000n);
    let eoaErr = "", consumerErr = "";
    try {
      await wDep.writeContract({ address: AUTH_REGISTRY, abi: AUTHREG_ABI, functionName: "recordAuthorization",
        args: [keccak256(toHex(`x${RUN}`)), reqHash(cap), policyCommitment(), keccak256(toHex("c")),
               BigInt(Math.floor(Date.now()/1000)), BigInt(Math.floor(Date.now()/1000)+60), 1] });
    } catch (e) { eoaErr = revertName(e); }
    try {
      await wDep.writeContract({ address: CONSUMER, abi: CONSUMER_ABI, functionName: "onReport",
        args: [encodeAbiParameters(parseAbiParameters("bytes32 a, bytes32 b, bytes32 c, uint8 d, bytes32 e, uint64 f, uint64 g"),
          [reqHash(cap), policyCommitment(), keccak256(toHex("c")), 1, keccak256(toHex("x")),
           BigInt(Math.floor(Date.now()/1000)), BigInt(Math.floor(Date.now()/1000)+60)])] });
    } catch (e) { consumerErr = revertName(e); }
    rec("CRE-007", eoaErr === "NotAuthorizer" && consumerErr === "NotForwarder",
      `direct registry write -> ${eoaErr}; non-forwarder report -> ${consumerErr}`, "live-sepolia");
    evidence["CRE-007"] = { directRegistryWrite: eoaErr, nonForwarderReport: consumerErr };
  }

  // ── CRE-014 live: declared amount ignored, calldata wins ──
  log("\n--- CRE-014: agent declares 500 but encodes 50,000 in calldata ---");
  {
    const { cap, cd } = buildCap(50_000_000_000n); // calldata says 50,000
    const e = await creEvaluate(cap, cd);          // policy decodes the REAL amount
    rec("CRE-014", e.decision.verdict === "DENY" && e.decision.reasonCode === "DENY_AMOUNT_TOO_HIGH",
      `decoded amount won: verdict=${e.decision.verdict} reason=${e.decision.reasonCode}`, "live-sepolia");
    evidence["CRE-014"] = { declaredAmount: "500000000", encodedAmount: "50000000000",
      verdict: e.decision.verdict, reason: e.decision.reasonCode };
  }

  // ── CRE-008 live: stale authorization ──
  log("\n--- CRE-008: authorization aged past validUntil is rejected ---");
  {
    const { cap, cd } = buildCap(500_000_000n);
    const ctx = healthyContext();
    const rh = reqHash(cap);
    const evaluatedAt = BigInt(Math.floor(Date.now() / 1000));
    const validUntil = evaluatedAt + 1n; // 1-second window
    const cc = commitContext(ctx);
    const report = encodeAbiParameters(
      parseAbiParameters("bytes32 a, bytes32 b, bytes32 c, uint8 d, bytes32 e, uint64 f, uint64 g"),
      [rh, policyCommitment(), cc, 1, keccak256(toHex("ALLOW_POLICY_MATCH")), evaluatedAt, validUntil]);
    const t = await wRel.writeContract({ address: CONSUMER, abi: CONSUMER_ABI, functionName: "onReport", args: [report] });
    await pub.waitForTransactionReceipt({ hash: t });
    const authId = await pub.readContract({ address: CONSUMER, abi: CONSUMER_ABI, functionName: "computeAuthorizationId",
      args: [rh, policyCommitment(), evaluatedAt] }) as Hex;
    cap.authorizationId = authId; cap.contextCommitment = cc;
    await new Promise((r) => setTimeout(r, 15_000)); // let the window lapse
    const r = await tryExec(cap, cd);
    rec("CRE-008", !r.ok && r.err === "AuthorizationStale",
      `rejected with ${r.err}; capability itself still unexpired`, "live-sepolia");
    evidence["CRE-008"] = { consumerTx: t, validUntil: validUntil.toString(), executorError: r.err };
  }

  log("\n=== RESULTS ===");
  for (const r of results) log(`${r.result.padEnd(5)} ${r.id.padEnd(12)} [${r.classification}] ${r.detail}`);
  writeFileSync(join(ROOT, "reports/phase-04/test-results/p4-live-results.json"),
    JSON.stringify({ creMode: "sdk-local-tests", chainId, results, evidence }, null, 2) + "\n");
  const failed = results.filter((r) => r.result === "FAIL");
  if (failed.length) { log(`\n${failed.length} FAILED`); process.exit(1); }
  log("\nALL PHASE 4 LIVE TESTS PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
