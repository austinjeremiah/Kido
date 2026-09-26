/** Shared live-Sepolia harness for Phase 4-7 evidence scripts. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { PrivatePolicy, MarketContext } from "@contextlock/policy";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const dep = JSON.parse(readFileSync(join(ROOT, "deployments/sepolia.json"), "utf8"));
export const p4 = JSON.parse(readFileSync(join(ROOT, "deployments/sepolia-p4.json"), "utf8"));

export const RPC = process.env.SEPOLIA_RPC_URL!;
export const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
export const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY! as Hex);
export const issuer = privateKeyToAccount(process.env.CAPABILITY_ISSUER_PRIVATE_KEY! as Hex);
export const relayer = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY! as Hex);
export const AGENT = process.env.AGENT_ADDRESS! as Address;
export const wDep = createWalletClient({ account: deployer, chain: sepolia, transport: http(RPC) });
export const wRel = createWalletClient({ account: relayer, chain: sepolia, transport: http(RPC) });

// Addresses come from the canonical manifest (P9.1). `canonicalExecutor` is the one every default
// script uses; historical executors stay in the manifest so Phase 3-6 evidence remains
// reproducible, but nothing here targets them implicitly.
export const POLICY_REGISTRY = dep.contracts.ContextLockPolicyRegistry as Address;
export const AUTH_REGISTRY = dep.contracts.ContextLockAuthorizationRegistry as Address;
export const IDENTITY = dep.contracts.EnsAgentIdentityVerifier as Address;
export const EXECUTOR = dep.canonicalExecutor.address as Address;
export const TARGET = dep.contracts.MockTreasuryTarget as Address;
export const GATEWAY = dep.contracts.ContextLockGateway as Address;
export const CONSUMER = dep.contracts.ContextLockCreConsumer as Address;
export const APPROVAL_REGISTRY = dep.contracts.ContextLockApprovalRegistry as Address;

export const ACTION_KIND = keccak256(toHex("MOCK_TRANSFER"));
export const RECIPIENT = "0x00000000000000000000000000000000c0ffee00" as Address;

/** ContextLock treasury private policy. TEST values; the canary proves none of them escape. */
export const PRIVATE_POLICY: PrivatePolicy = {
  policyId: keccak256(toHex("contextlock-treasury-v1")),
  policyVersion: 1,
  enabled: true,
  autoLimit: 1_000_000_000n,
  escalationLimit: 10_000_000_000n,
  maxSlippageBps: 50,
  maxVolatilityBps: 600,
  minLiquidity: 1_000_000_000_000n,
  targetEthAllocationBps: 5000,
  rebalanceDriftBps: 500,
  minHealthFactorBps: 13500,
  targetHealthFactorBps: 16000,
  proprietaryRiskThreshold: 120,
  canary: "CTXLOCK_CONFIDENTIAL_CANARY_9f2b71c4a83e",
  allowedActionKinds: [ACTION_KIND],
  allowedTargets: [TARGET],
  authorizedAgentIdentityHashes: [],
};

/** Deterministic benign context, so protocol tests never depend on a flaky external feed. */
export function healthyContext(): MarketContext {
  return { observedAtUnix: Math.floor(Date.now() / 1000), slippageBps: 12, volatilityBps: 150,
           liquidity: 9_000_000_000_000n, healthFactorBps: 18000 };
}

export const IDENTITY_ABI = [
  { type:"function", name:"computeIdentityHash", stateMutability:"pure", inputs:[{type:"address"},{type:"uint256"},{type:"address"},{type:"address"},{type:"uint256"},{type:"uint64"}], outputs:[{type:"bytes32"}] },
  { type:"function", name:"isIdentityCurrent", stateMutability:"view", inputs:[{type:"bytes32"},{type:"address"}], outputs:[{type:"bool"}] },
  { type:"function", name:"bind", stateMutability:"nonpayable", inputs:[{type:"address"},{type:"uint256"},{type:"address"},{type:"uint64"}], outputs:[{type:"bytes32"}] },
] as const;
export const POLICY_ABI = [
  { type:"function", name:"setPolicyAdmin", stateMutability:"nonpayable", inputs:[{type:"bytes32"},{type:"address"}], outputs:[] },
  { type:"function", name:"setPolicy", stateMutability:"nonpayable", inputs:[{type:"bytes32"},{type:"bytes32"},{type:"bool"},{type:"uint256"}], outputs:[] },
  { type:"function", name:"setTargetAllowed", stateMutability:"nonpayable", inputs:[{type:"bytes32"},{type:"bytes32"},{type:"address"},{type:"bool"}], outputs:[] },
  { type:"function", name:"setActionAllowed", stateMutability:"nonpayable", inputs:[{type:"bytes32"},{type:"bytes32"},{type:"bytes32"},{type:"bool"}], outputs:[] },
  { type:"function", name:"isPolicyEnabled", stateMutability:"view", inputs:[{type:"bytes32"},{type:"bytes32"}], outputs:[{type:"bool"}] },
] as const;
export const CONSUMER_ABI = [
  { type:"function", name:"onReport", stateMutability:"nonpayable", inputs:[{type:"bytes"}], outputs:[] },
  { type:"function", name:"computeAuthorizationId", stateMutability:"pure", inputs:[{type:"bytes32"},{type:"bytes32"},{type:"uint64"}], outputs:[{type:"bytes32"}] },
  { type:"function", name:"forwarder", stateMutability:"view", inputs:[], outputs:[{type:"address"}] },
  { type:"error", name:"NotForwarder", inputs:[{type:"address"}] },
] as const;
export const AUTHREG_ABI = [
  { type:"function", name:"authorizer", stateMutability:"view", inputs:[], outputs:[{type:"address"}] },
  { type:"function", name:"getAuthorization", stateMutability:"view", inputs:[{type:"bytes32"}], outputs:[
    { type:"tuple", components:[{name:"requestHash",type:"bytes32"},{name:"policyHash",type:"bytes32"},
      {name:"contextCommitment",type:"bytes32"},{name:"evaluatedAt",type:"uint64"},
      {name:"approvedUntil",type:"uint64"},{name:"verdict",type:"uint8"}] }] },
  { type:"function", name:"recordAuthorization", stateMutability:"nonpayable", inputs:[{type:"bytes32"},{type:"bytes32"},{type:"bytes32"},{type:"bytes32"},{type:"uint64"},{type:"uint64"},{type:"uint8"}], outputs:[] },
  { type:"error", name:"NotAuthorizer", inputs:[] },
] as const;
const CAP_TUPLE = { name:"cap", type:"tuple", components:[
  {name:"version",type:"uint8"},{name:"agentIdentityHash",type:"bytes32"},{name:"agent",type:"address"},
  {name:"chainId",type:"uint256"},{name:"executor",type:"address"},{name:"target",type:"address"},
  {name:"value",type:"uint256"},{name:"calldataHash",type:"bytes32"},{name:"intentHash",type:"bytes32"},
  {name:"policyHash",type:"bytes32"},{name:"authorizationId",type:"bytes32"},{name:"contextCommitment",type:"bytes32"},
  {name:"issuedAt",type:"uint64"},{name:"expiresAt",type:"uint64"},{name:"nonce",type:"uint256"}]} as const;
export const EXEC_ABI = [
  { type:"function", name:"execute", stateMutability:"payable", inputs:[CAP_TUPLE,{name:"signature",type:"bytes"},{name:"callData",type:"bytes"},{name:"actionKind",type:"bytes32"}], outputs:[{type:"bytes"}] },
  { type:"error", name:"IdentityNotCurrent", inputs:[{type:"bytes32"},{type:"address"}] },
  { type:"error", name:"NonceUsed", inputs:[{type:"uint256"}] },
  { type:"error", name:"CapabilityExpired", inputs:[{type:"uint64"},{type:"uint256"}] },
  { type:"error", name:"PolicyDisabled", inputs:[{type:"bytes32"},{type:"bytes32"}] },
  { type:"error", name:"AuthorizationStale", inputs:[{type:"uint64"},{type:"uint256"}] },
  { type:"error", name:"AuthorizationMissing", inputs:[{type:"bytes32"}] },
  { type:"error", name:"AuthorizationRequestMismatch", inputs:[{type:"bytes32"},{type:"bytes32"}] },
  { type:"error", name:"AuthorizationNotAllow", inputs:[{type:"uint8"}] },
  { type:"error", name:"AuthorizationPolicyMismatch", inputs:[] },
  { type:"error", name:"AuthorizationContextMismatch", inputs:[] },
  { type:"error", name:"InvalidSignature", inputs:[] },
  { type:"error", name:"TargetNotAllowed", inputs:[{type:"address"}] },
  { type:"error", name:"CalldataHashMismatch", inputs:[{type:"bytes32"},{type:"bytes32"}] },
  { type:"error", name:"ValueMismatch", inputs:[{type:"uint256"},{type:"uint256"}] },
  // Phase 7 (ADR-001): the ESCALATE branch.
  { type:"error", name:"HumanApprovalRequired", inputs:[{type:"bytes32"}] },
  { type:"error", name:"HumanApprovalUnavailable", inputs:[] },
] as const;
export const TARGET_ABI = [
  { type:"function", name:"transferTo", stateMutability:"nonpayable", inputs:[{type:"address"},{type:"uint256"}], outputs:[] },
  { type:"function", name:"callCount", stateMutability:"view", inputs:[], outputs:[{type:"uint256"}] },
  { type:"function", name:"balanceOf", stateMutability:"view", inputs:[{type:"address"}], outputs:[{type:"uint256"}] },
  { type:"function", name:"lastRecipient", stateMutability:"view", inputs:[], outputs:[{type:"address"}] },
] as const;
export const GATEWAY_ABI = [
  { type:"function", name:"requestEvaluation", stateMutability:"nonpayable", inputs:[
      {type:"bytes32"},{type:"address"},{type:"bytes32"},{type:"address"},{type:"uint256"},
      {type:"bytes"},{type:"bytes32"},{type:"bytes32"},{type:"uint64"},{type:"bytes32"}], outputs:[{type:"bytes32"}] },
] as const;

/** Decode a viem revert into the custom error NAME. */
export function revertName(e: unknown): string {
  const anyE = e as { walk?: (f: (x: unknown) => boolean) => unknown; message?: string };
  try {
    const rev = anyE.walk?.((x: unknown) => (x as { name?: string })?.name === "ContractFunctionRevertedError") as
      { data?: { errorName?: string } } | undefined;
    if (rev?.data?.errorName) return rev.data.errorName;
  } catch { /* fall through */ }
  const m = /(IdentityNotCurrent|NonceUsed|CapabilityExpired|PolicyDisabled|AuthorizationStale|AuthorizationMissing|AuthorizationRequestMismatch|AuthorizationNotAllow|AuthorizationPolicyMismatch|AuthorizationContextMismatch|InvalidSignature|TargetNotAllowed|CalldataHashMismatch|ValueMismatch|NotForwarder|NotAuthorizer|HumanApprovalRequired|HumanApprovalUnavailable)/
    .exec(anyE.message ?? "");
  return m?.[0] ?? (anyE.message ?? "unknown").split("\n")[0]!.slice(0, 100);
}

export async function assertSepolia(): Promise<number> {
  const id = await pub.getChainId();
  if (id !== 11155111) throw new Error(`ABORT: chainId ${id} is not Sepolia`);
  return id;
}
