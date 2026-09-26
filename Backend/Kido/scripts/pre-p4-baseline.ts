/**
 * Pre-Phase-4 baseline recovery.
 *
 * Phase 3's DEMO-004 deliberately left the live ENS identity revoked (ROLE_SET_RESOLVER and
 * ROLE_SET_SUBREGISTRY revoked, token id regenerated). That is historical evidence and is NOT
 * modified. This script restores a clean OPERATIONAL state on top of it, and records the recovery
 * as its own artifact.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, toHex, encodeFunctionData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { ENS_V2_SEPOLIA as ENS, ETH_REGISTRY_ABI } from "../packages/ens/src/deployments.js";
import { CAPABILITY_TYPES, domain, requestHash as reqHash, capabilityDigest, type Capability } from "../packages/protocol/src/capability.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dep = JSON.parse(readFileSync(join(ROOT, "deployments/sepolia.json"), "utf8"));
const RPC = process.env.SEPOLIA_RPC_URL!;
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY! as Hex);
const issuer = privateKeyToAccount(process.env.CAPABILITY_ISSUER_PRIVATE_KEY! as Hex);
const relayer = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY! as Hex);
const AGENT = process.env.AGENT_ADDRESS! as Address;
const wDep = createWalletClient({ account: deployer, chain: sepolia, transport: http(RPC) });
const wRel = createWalletClient({ account: relayer, chain: sepolia, transport: http(RPC) });

const POLICY = dep.contextlock.ContextLockPolicyRegistry as Address;
const AUTH = dep.contextlock.ContextLockAuthorizationRegistry as Address;
const IDENTITY = dep.contextlock.EnsAgentIdentityVerifier as Address;
const EXECUTOR = dep.contextlock.ContextLockExecutor as Address;
const TARGET = dep.contextlock.MockTreasuryTarget as Address;
const labelId = BigInt(dep.ens.labelId);

const ROLES_ABI = [
  { type:"function", name:"grantRoles", stateMutability:"nonpayable", inputs:[{type:"uint256"},{type:"uint256"},{type:"address"}], outputs:[{type:"bool"}] },
  { type:"function", name:"roles", stateMutability:"view", inputs:[{type:"uint256"},{type:"address"}], outputs:[{type:"uint256"}] },
] as const;
const IDENTITY_ABI = [
  { type:"function", name:"bind", stateMutability:"nonpayable", inputs:[{type:"address"},{type:"uint256"},{type:"address"},{type:"uint64"}], outputs:[{type:"bytes32"}] },
  { type:"function", name:"computeIdentityHash", stateMutability:"pure", inputs:[{type:"address"},{type:"uint256"},{type:"address"},{type:"address"},{type:"uint256"},{type:"uint64"}], outputs:[{type:"bytes32"}] },
  { type:"function", name:"isIdentityCurrent", stateMutability:"view", inputs:[{type:"bytes32"},{type:"address"}], outputs:[{type:"bool"}] },
] as const;
const POLICY_ABI = [
  { type:"function", name:"setPolicyAdmin", stateMutability:"nonpayable", inputs:[{type:"bytes32"},{type:"address"}], outputs:[] },
  { type:"function", name:"setPolicy", stateMutability:"nonpayable", inputs:[{type:"bytes32"},{type:"bytes32"},{type:"bool"},{type:"uint256"}], outputs:[] },
  { type:"function", name:"setTargetAllowed", stateMutability:"nonpayable", inputs:[{type:"bytes32"},{type:"bytes32"},{type:"address"},{type:"bool"}], outputs:[] },
  { type:"function", name:"setActionAllowed", stateMutability:"nonpayable", inputs:[{type:"bytes32"},{type:"bytes32"},{type:"bytes32"},{type:"bool"}], outputs:[] },
  { type:"function", name:"isPolicyEnabled", stateMutability:"view", inputs:[{type:"bytes32"},{type:"bytes32"}], outputs:[{type:"bool"}] },
] as const;
const AUTH_ABI = [{ type:"function", name:"recordAuthorization", stateMutability:"nonpayable", inputs:[{type:"bytes32"},{type:"bytes32"},{type:"bytes32"},{type:"bytes32"},{type:"uint64"},{type:"uint64"},{type:"uint8"}], outputs:[] }] as const;
const CAP_TUPLE = { name:"cap", type:"tuple", components:[
  {name:"version",type:"uint8"},{name:"agentIdentityHash",type:"bytes32"},{name:"agent",type:"address"},
  {name:"chainId",type:"uint256"},{name:"executor",type:"address"},{name:"target",type:"address"},
  {name:"value",type:"uint256"},{name:"calldataHash",type:"bytes32"},{name:"intentHash",type:"bytes32"},
  {name:"policyHash",type:"bytes32"},{name:"authorizationId",type:"bytes32"},{name:"contextCommitment",type:"bytes32"},
  {name:"issuedAt",type:"uint64"},{name:"expiresAt",type:"uint64"},{name:"nonce",type:"uint256"}]} as const;
const EXEC_ABI = [{ type:"function", name:"execute", stateMutability:"payable", inputs:[CAP_TUPLE,{name:"signature",type:"bytes"},{name:"callData",type:"bytes"},{name:"actionKind",type:"bytes32"}], outputs:[{type:"bytes"}] }] as const;
const TARGET_ABI = [
  { type:"function", name:"transferTo", stateMutability:"nonpayable", inputs:[{type:"address"},{type:"uint256"}], outputs:[] },
  { type:"function", name:"callCount", stateMutability:"view", inputs:[], outputs:[{type:"uint256"}] },
] as const;

const POLICY_HASH = keccak256(toHex("contextlock-p4-policy-v1"));
const ACTION_KIND = keccak256(toHex("MOCK_TRANSFER"));
const log = (...a: unknown[]) => console.log(...a);
const txs: Record<string, string> = {};

const ROLE_SET_SUBREGISTRY = 1n << 20n;
const ROLE_SET_RESOLVER = 1n << 24n;

function decodeRoles(v: bigint) {
  const out: Record<string, { held: boolean; admin: boolean }> = {};
  for (const [n, b] of [["ROLE_UNREGISTER",12n],["ROLE_RENEW",16n],["ROLE_SET_SUBREGISTRY",20n],["ROLE_SET_RESOLVER",24n],["ROLE_CAN_TRANSFER_ADMIN",28n]] as const) {
    out[n as string] = { held: ((v >> (b as bigint)) & 1n) === 1n, admin: ((v >> ((b as bigint) + 128n)) & 1n) === 1n };
  }
  return out;
}

async function main() {
  const chainId = await pub.getChainId();
  if (chainId !== 11155111) throw new Error(`ABORT: chainId ${chainId}`);
  log("=== Pre-P4 ENS baseline recovery ===");
  log("chainId =", chainId, "(Ethereum Sepolia)");
  log("name    =", dep.ens.agentName);

  // 1. inspect
  const rolesBefore = await pub.readContract({ address: ENS.ethRegistry, abi: ROLES_ABI, functionName: "roles", args: [labelId, deployer.address] }) as bigint;
  const tokenBefore = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getTokenId", args: [labelId] }) as bigint;
  log("\n[1] current state");
  log("  tokenId =", tokenBefore.toString());
  log("  roles   =", JSON.stringify(decodeRoles(rolesBefore)));

  // 2. re-grant ONLY the name-management roles that Phase 3 revoked
  log("\n[2] re-granting ROLE_SET_RESOLVER | ROLE_SET_SUBREGISTRY (the two DEMO-004b revoked)");
  const t1 = await wDep.writeContract({ address: ENS.ethRegistry, abi: ROLES_ABI, functionName: "grantRoles",
    args: [labelId, ROLE_SET_RESOLVER | ROLE_SET_SUBREGISTRY, deployer.address] });
  const r1 = await pub.waitForTransactionReceipt({ hash: t1 });
  txs["grantRoles"] = t1;
  log("  tx", t1, `(block ${r1.blockNumber})`);

  const rolesAfter = await pub.readContract({ address: ENS.ethRegistry, abi: ROLES_ABI, functionName: "roles", args: [labelId, deployer.address] }) as bigint;
  const tokenAfter = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getTokenId", args: [labelId] }) as bigint;
  const owner = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "ownerOf", args: [tokenAfter] }) as Address;
  const expiry = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getExpiry", args: [labelId] }) as bigint;
  const resolver = await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getResolver", args: [dep.ens.agentName.replace(/\.eth$/, "")] }) as Address;
  log("  tokenId regenerated:", tokenBefore.toString(), "->", tokenAfter.toString());
  log("  roles now:", JSON.stringify(decodeRoles(rolesAfter)));

  // 3. re-bind identity to the NEW live state
  log("\n[3] binding agent identity to current live ENS state");
  const aih = await pub.readContract({ address: IDENTITY, abi: IDENTITY_ABI, functionName: "computeIdentityHash",
    args: [ENS.ethRegistry, labelId, owner, AGENT, tokenAfter, 1n] }) as Hex;
  log("  agentIdentityHash =", aih);
  try {
    const t2 = await wDep.writeContract({ address: IDENTITY, abi: IDENTITY_ABI, functionName: "bind", args: [ENS.ethRegistry, labelId, AGENT, 1n] });
    await pub.waitForTransactionReceipt({ hash: t2 }); txs["bindIdentity"] = t2;
    log("  bind tx", t2);
  } catch (e) {
    if (!(e as Error).message.includes("0x682a9065")) throw e;
    log("  already bound (AlreadyBound) - reusing");
  }

  // 4/5. verify live resolution + verifier
  const isCurrent = await pub.readContract({ address: IDENTITY, abi: IDENTITY_ABI, functionName: "isIdentityCurrent", args: [aih, AGENT] }) as boolean;
  log("\n[4/5] live verification");
  log("  owner=", owner, " expiry=", expiry.toString(), " resolver=", resolver);
  log("  isIdentityCurrent =", isCurrent);
  if (!isCurrent) throw new Error("ABORT: identity not current after recovery");

  // 6. policy
  log("\n[6] enabling ContextLock policy for the recovered identity");
  for (const [fn, args] of [
    ["setPolicyAdmin", [aih, deployer.address]],
    ["setPolicy", [aih, POLICY_HASH, true, 10n ** 18n]],
    ["setTargetAllowed", [aih, POLICY_HASH, TARGET, true]],
    ["setActionAllowed", [aih, POLICY_HASH, ACTION_KIND, true]],
  ] as const) {
    const t = await wDep.writeContract({ address: POLICY, abi: POLICY_ABI, functionName: fn as never, args: args as never });
    await pub.waitForTransactionReceipt({ hash: t }); txs[fn as string] = t;
  }
  const enabled = await pub.readContract({ address: POLICY, abi: POLICY_ABI, functionName: "isPolicyEnabled", args: [aih, POLICY_HASH] }) as boolean;
  log("  isPolicyEnabled =", enabled);

  // 7. one normal protected execution
  log("\n[7] one normal protected execution");
  const cd = encodeFunctionData({ abi: TARGET_ABI, functionName: "transferTo", args: ["0x00000000000000000000000000000000c0ffee00" as Address, 500n] });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const cap: Capability = {
    version: 1, agentIdentityHash: aih, agent: AGENT, chainId: 11155111n, executor: EXECUTOR,
    target: TARGET, value: 0n, calldataHash: keccak256(cd), intentHash: keccak256(toHex("pre-p4 baseline")),
    policyHash: POLICY_HASH, authorizationId: keccak256(toHex(`pre-p4-${Date.now()}`)),
    contextCommitment: keccak256(toHex(`pre-p4-ctx-${Date.now()}`)),
    issuedAt: now, expiresAt: now + 1800n, nonce: BigInt(Date.now()),
  };
  const sig = await issuer.signTypedData({ domain: domain(cap.chainId, cap.executor), types: CAPABILITY_TYPES, primaryType: "Capability", message: cap }) as Hex;
  const ta = await wRel.writeContract({ address: AUTH, abi: AUTH_ABI, functionName: "recordAuthorization",
    args: [cap.authorizationId, reqHash(cap), cap.policyHash, cap.contextCommitment, now, now + 1800n, 1] });
  await pub.waitForTransactionReceipt({ hash: ta }); txs["recordAuthorization"] = ta;

  const before = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "callCount" }) as bigint;
  const te = await wRel.writeContract({ address: EXECUTOR, abi: EXEC_ABI, functionName: "execute", args: [cap, sig, cd, ACTION_KIND] });
  const re = await pub.waitForTransactionReceipt({ hash: te }); txs["execute"] = te;
  const after = await pub.readContract({ address: TARGET, abi: TARGET_ABI, functionName: "callCount" }) as bigint;
  log("  execute tx", te, `(status ${re.status}, block ${re.blockNumber})`);
  log("  callCount", before.toString(), "->", after.toString());
  if (re.status !== "success" || after !== before + 1n) throw new Error("ABORT: baseline execution failed");

  const out = {
    _comment: "Pre-Phase-4 ENS baseline recovery. Phase 3 revocation evidence in reports/phase-03/ is UNMODIFIED historical evidence; this records the restoration performed on top of it.",
    chainId, network: "Ethereum Sepolia",
    name: dep.ens.agentName, node: dep.ens.node, labelId: labelId.toString(),
    owner, agent: AGENT, resolver, expiry: expiry.toString(),
    tokenIdBeforeRecovery: tokenBefore.toString(), tokenIdAfterRecovery: tokenAfter.toString(),
    rolesBeforeRecovery: decodeRoles(rolesBefore), rolesAfterRecovery: decodeRoles(rolesAfter),
    rolesReGranted: ["ROLE_SET_RESOLVER", "ROLE_SET_SUBREGISTRY"],
    rolesDeliberatelyNotGranted: ["ROLE_UNREGISTER", "ROLE_RENEW"],
    rolesNote: "ROLE_UNREGISTER/ROLE_RENEW were never held by the owner (FND-009) and are not grantable by it; only the two roles DEMO-004b revoked were restored.",
    agentIdentityHash: aih, policyId: "contextlock-p4-policy-v1", policyHash: POLICY_HASH, policyVersion: 1,
    policyEnabled: enabled, isIdentityCurrent: isCurrent,
    verificationResult: "PASS - identity current, policy enabled, one protected execution succeeded",
    baselineExecution: { tx: te, block: re.blockNumber.toString(), capabilityDigest: capabilityDigest(cap),
      callCountBefore: before.toString(), callCountAfter: after.toString() },
    recoveryTransactions: txs,
    recordedAtBlock: re.blockNumber.toString(), timestamp: new Date().toISOString(),
  };
  writeFileSync(join(ROOT, "reports/phase-04/evidence/pre-p4-ens-baseline.json"), JSON.stringify(out, null, 2) + "\n");
  log("\nwrote reports/phase-04/evidence/pre-p4-ens-baseline.json");
  log("\nBASELINE RECOVERY: PASS");
}
main().catch((e) => { console.error(e); process.exit(1); });
