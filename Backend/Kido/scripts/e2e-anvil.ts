/**
 * Phase 2 end-to-end: untrusted agent -> broker -> capability -> executor -> MockTreasuryTarget.
 *
 * Runs against a live Anvil node so the capability is actually submitted to a deployed executor,
 * not merely constructed in memory. Proves both directions: the benign action executes exactly
 * once, and the malicious corpus produces nothing executable.
 */
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { makeHarness, TEST_AGENT_NAME, TEST_POLICY_ID } from "../apps/broker/src/testkit.js";
import { buildApi } from "../apps/broker/src/api.js";
import { requestHash as computeRequestHash } from "../packages/protocol/src/capability.js";
import { benignProposal, maliciousCorpus } from "../apps/demo-agent/src/index.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
// Published Anvil dev keys. Public, zero-value, documented — never used on a real network.
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const ISSUER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const AUTHORIZER = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
const RELAYER = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as Hex;

const A = (s: string) => s as Address;
const args = process.argv.slice(2);
const addr = (k: string) => A(args[args.indexOf(`--${k}`) + 1]!);

const POLICY = addr("policy");
const AUTH = addr("auth");
const IDENTITY = addr("identity");
const EXECUTOR = addr("executor");
const TARGET = addr("target");

const pub = createPublicClient({ chain: anvil, transport: http(RPC) });
const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER), chain: anvil, transport: http(RPC) });
const authorizer = createWalletClient({ account: privateKeyToAccount(AUTHORIZER), chain: anvil, transport: http(RPC) });
const relayer = createWalletClient({ account: privateKeyToAccount(RELAYER), chain: anvil, transport: http(RPC) });

const AGENT = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as Hex).address;

const POLICY_ABI = [
  { type: "function", name: "setPolicyAdmin", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "setPolicy", inputs: [{ type: "bytes32" }, { type: "bytes32" }, { type: "bool" }, { type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "setTargetAllowed", inputs: [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bool" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "setActionAllowed", inputs: [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bool" }], outputs: [], stateMutability: "nonpayable" },
] as const;
const IDENTITY_ABI = [
  { type: "function", name: "bind", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [], stateMutability: "nonpayable" },
] as const;
const AUTH_ABI = [
  { type: "function", name: "recordAuthorization", inputs: [
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "uint64" }, { type: "uint64" }, { type: "uint8" }], outputs: [], stateMutability: "nonpayable" },
] as const;
const EXEC_ABI = [
  { type: "function", name: "execute", stateMutability: "payable", outputs: [{ type: "bytes" }], inputs: [
    { name: "cap", type: "tuple", components: [
      { name: "version", type: "uint8" }, { name: "agentIdentityHash", type: "bytes32" },
      { name: "agent", type: "address" }, { name: "chainId", type: "uint256" },
      { name: "executor", type: "address" }, { name: "target", type: "address" },
      { name: "value", type: "uint256" }, { name: "calldataHash", type: "bytes32" },
      { name: "intentHash", type: "bytes32" }, { name: "policyHash", type: "bytes32" },
      { name: "authorizationId", type: "bytes32" }, { name: "contextCommitment", type: "bytes32" },
      { name: "issuedAt", type: "uint64" }, { name: "expiresAt", type: "uint64" },
      { name: "nonce", type: "uint256" }]},
    { name: "signature", type: "bytes" }, { name: "callData", type: "bytes" }, { name: "actionKind", type: "bytes32" }]},
] as const;
const TARGET_ABI = [
  { type: "function", name: "callCount", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "lastRecipient", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
] as const;

const log = (...a: unknown[]) => console.log(...a);

async function main() {
  const chainId = await pub.getChainId();
  log("=== ContextLock Phase 2 end-to-end (Anvil) ===");
  log("chainId          ", chainId);
  log("executor         ", EXECUTOR);
  log("target           ", TARGET);
  log("agent (untrusted)", AGENT);

  const h = makeHarness({ executor: EXECUTOR, target: TARGET, agent: AGENT, issuerPrivateKey: ISSUER, chainId });
  log("capabilityIssuer ", h.broker.issuerAddress);
  log("relayer          ", relayer.account.address);

  const identity = await h.broker.resolveIdentityForApi(TEST_AGENT_NAME) as { agentIdentityHash: Hex; node: Hex };
  const aih = identity.agentIdentityHash;
  const policyHash = h.policy.policyHash;
  const actionKindHash = keccak256(toHex("MOCK_TRANSFER"));

  log("\n--- configuring on-chain policy + identity ---");
  for (const [fn, a] of [
    ["setPolicyAdmin", [aih, deployer.account.address]],
    ["setPolicy", [aih, policyHash, true, 10n ** 18n]],
    ["setTargetAllowed", [aih, policyHash, TARGET, true]],
    ["setActionAllowed", [aih, policyHash, actionKindHash, true]],
  ] as const) {
    const hash = await deployer.writeContract({ address: POLICY, abi: POLICY_ABI, functionName: fn as never, args: a as never });
    await pub.waitForTransactionReceipt({ hash });
  }
  const bindTx = await deployer.writeContract({ address: IDENTITY, abi: IDENTITY_ABI, functionName: "bind", args: [aih, AGENT] });
  await pub.waitForTransactionReceipt({ hash: bindTx });
  log("agentIdentityHash", aih);
  log("policy + identity configured");

  const api = buildApi(h.broker, h.db);

  // ---------------- malicious corpus ----------------
  log("\n--- untrusted agent proposes MALICIOUS actions ---");
  let minted = 0;
  for (const p of maliciousCorpus(TEST_AGENT_NAME, "e2e")) {
    const res = await api.inject({ method: "POST", url: "/v1/capability-requests", payload: p.body });
    const body = res.json() as { status?: string; reasonCode?: string; capability?: unknown };
    if (body.capability) minted++;
    log(`  [${res.statusCode}] ${p.label.padEnd(26)} -> ${body.status ?? "REJECTED"} / ${body.reasonCode ?? "validation"}`);
  }
  log(`  capabilities minted for malicious proposals: ${minted}  (expected 0)`);
  if (minted !== 0) throw new Error("FAIL: a malicious proposal minted a capability");

  // ---------------- benign path ----------------
  log("\n--- untrusted agent proposes a BENIGN in-policy action ---");
  const good = await api.inject({
    method: "POST", url: "/v1/capability-requests",
    payload: benignProposal(TEST_AGENT_NAME, `e2e-benign-${Date.now()}`).body,
  });
  if (good.statusCode !== 201) throw new Error(`FAIL: benign request status ${good.statusCode}`);
  const r = good.json() as {
    requestId: string; capability: Record<string, string>; signature: Hex;
    calldata: Hex; actionKindHash: Hex; capabilityDigest: Hex; authorizationId: Hex;
  };
  log("  requestId       ", r.requestId);
  log("  capabilityDigest", r.capabilityDigest);
  log("  authorizationId ", r.authorizationId);

  const cap = {
    version: Number(r.capability.version),
    agentIdentityHash: r.capability.agentIdentityHash as Hex,
    agent: r.capability.agent as Address,
    chainId: BigInt(r.capability.chainId!),
    executor: r.capability.executor as Address,
    target: r.capability.target as Address,
    value: BigInt(r.capability.value!),
    calldataHash: r.capability.calldataHash as Hex,
    intentHash: r.capability.intentHash as Hex,
    policyHash: r.capability.policyHash as Hex,
    authorizationId: r.capability.authorizationId as Hex,
    contextCommitment: r.capability.contextCommitment as Hex,
    issuedAt: BigInt(r.capability.issuedAt!),
    expiresAt: BigInt(r.capability.expiresAt!),
    nonce: BigInt(r.capability.nonce!),
  };

  // The broker's evaluator stands in for CRE; the authorization must be on-chain for the
  // executor to accept it. In Phase 4 this write comes from the CRE report path instead.
  const now = BigInt(Math.floor(Date.now() / 1000));
  const recTx = await authorizer.writeContract({
    address: AUTH, abi: AUTH_ABI, functionName: "recordAuthorization",
    args: [cap.authorizationId, computeRequestHash(cap), cap.policyHash, cap.contextCommitment, now, now + 120n, 1],
  });
  await pub.waitForTransactionReceipt({ hash: recTx });
  log("  authorization recorded on-chain:", recTx);

  const before = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "callCount" });
  log("\n--- target BEFORE ---  callCount =", before);

  const execTx = await relayer.writeContract({
    address: EXECUTOR, abi: EXEC_ABI, functionName: "execute",
    args: [cap, r.signature, r.calldata, r.actionKindHash],
  });
  const rc = await pub.waitForTransactionReceipt({ hash: execTx });
  log("  execute tx      ", execTx, `(status ${rc.status}, block ${rc.blockNumber})`);

  const after = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "callCount" });
  const lastRecipient = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "lastRecipient" });
  const bal = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "balanceOf", args: [lastRecipient] });
  log("--- target AFTER  ---  callCount =", after, " lastRecipient =", lastRecipient, " balance =", bal);
  if (after !== before + 1n) throw new Error("FAIL: target was not called exactly once");

  // ---------------- replay ----------------
  log("\n--- replay the SAME capability ---");
  try {
    await relayer.writeContract({ address: EXECUTOR, abi: EXEC_ABI, functionName: "execute",
      args: [cap, r.signature, r.calldata, r.actionKindHash] });
    throw new Error("FAIL: replay succeeded");
  } catch (e) {
    const m = (e as Error).message;
    if (m.includes("FAIL:")) throw e;
    log("  replay REJECTED:", /NonceUsed\S*/.exec(m)?.[0] ?? "reverted");
  }

  const final = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "callCount" });
  log("  callCount still =", final);
  if (final !== after) throw new Error("FAIL: replay changed target state");

  // ---------------- audit ----------------
  log("\n--- audit trail ---");
  for (const e of h.broker.getAudit(r.requestId) as Array<{ type: string }>) log("  " + e.type);

  await api.close();
  log("\n=== PHASE 2 E2E PASS: 1 authorized call, 0 malicious, replay blocked ===");
}

main().catch((e) => { console.error(e); process.exit(1); });
