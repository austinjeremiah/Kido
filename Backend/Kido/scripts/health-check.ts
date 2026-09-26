/**
 * P9.14 — Sepolia demo baseline health check.
 *
 * Read-only. Verifies the demo can run, reports anything that would make it fail, and mutates
 * nothing. Run this before a demo or a recording rather than discovering a problem live.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { ENS_V2_SEPOLIA as ENS, ETH_REGISTRY_ABI } from "../packages/ens/src/deployments.js";

const ROOT = join(import.meta.dirname, "..");
const m = JSON.parse(readFileSync(join(ROOT, "deployments/sepolia.json"), "utf8"));
const RPC = process.env.SEPOLIA_RPC_URL;
if (!RPC) {
  console.error("SEPOLIA_RPC_URL not set");
  process.exit(1);
}
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });

const IDENTITY_ABI = [
  { type: "function", name: "computeIdentityHash", stateMutability: "pure", inputs: [{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "isIdentityCurrent", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;
const POLICY_ABI = [{ type: "function", name: "isPolicyEnabled", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "bytes32" }], outputs: [{ type: "bool" }] }] as const;
const AUTHREG_ABI = [{ type: "function", name: "authorizer", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const APPROVALS_ABI = [{ type: "function", name: "approver", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

let fail = 0;
const ok = (c: boolean, label: string, detail = "") => {
  console.log(`  ${c ? "OK  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!c) fail++;
};

async function main() {
  console.log("=== ContextLock Sepolia health check (read-only) ===\n");

  const chainId = await pub.getChainId();
  ok(chainId === 11155111, "chainId is Sepolia", String(chainId));
  if (chainId !== 11155111) {
    console.error("\nABORT: wrong network");
    process.exit(1);
  }

  console.log("\n-- contracts --");
  for (const [name, addr] of Object.entries(m.contracts as Record<string, string>)) {
    const code = await pub.getCode({ address: addr as Address });
    ok(!!code && code !== "0x", name, addr);
  }

  console.log("\n-- wiring --");
  const authorizer = (await pub.readContract({
    address: m.contracts.ContextLockAuthorizationRegistry as Address,
    abi: AUTHREG_ABI, functionName: "authorizer",
  })) as string;
  ok(
    authorizer.toLowerCase() === m.contracts.ContextLockCreConsumer.toLowerCase(),
    "authorization writer is the CRE consumer", authorizer,
  );
  const approver = (await pub.readContract({
    address: m.contracts.ContextLockApprovalRegistry as Address,
    abi: APPROVALS_ABI, functionName: "approver",
  })) as string;
  ok(
    approver.toLowerCase() !== m.roles.capabilityIssuer.toLowerCase(),
    "approver is distinct from the capability issuer", approver,
  );

  console.log("\n-- ENS identity --");
  const labelId = BigInt(m.ens.labelId);
  const tokenId = (await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getTokenId", args: [labelId] })) as bigint;
  const owner = (await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "ownerOf", args: [tokenId] })) as Address;
  const expiry = (await pub.readContract({ address: ENS.ethRegistry, abi: ETH_REGISTRY_ABI, functionName: "getExpiry", args: [labelId] })) as bigint;
  ok(owner !== "0x0000000000000000000000000000000000000000", "name is registered", m.ens.agentName);
  ok(expiry > BigInt(Math.floor(Date.now() / 1000)), "name is unexpired", new Date(Number(expiry) * 1000).toISOString());
  ok(owner.toLowerCase() === (m.ens.nameOwner as string).toLowerCase(), "owner matches the manifest", owner);

  const aih = (await pub.readContract({
    address: m.contracts.EnsAgentIdentityVerifier as Address, abi: IDENTITY_ABI,
    functionName: "computeIdentityHash",
    args: [ENS.ethRegistry, labelId, owner, m.roles.agent as Address, tokenId, 1n],
  })) as Hex;
  const current = (await pub.readContract({
    address: m.contracts.EnsAgentIdentityVerifier as Address, abi: IDENTITY_ABI,
    functionName: "isIdentityCurrent", args: [aih, m.roles.agent as Address],
  })) as boolean;
  ok(current, "agent identity is CURRENT (bound, unexpired, token id matches)", aih);
  if (!current) console.log("       -> run `npx tsx scripts/pre-p4-baseline.ts` to rebind");

  console.log("\n-- balances --");
  for (const [role, addr] of [["deployer", m.roles.deployer], ["relayer", m.roles.relayer]] as const) {
    const bal = await pub.getBalance({ address: addr as Address });
    ok(bal > 10n ** 16n, `${role} has gas`, `${Number(bal) / 1e18} ETH`);
  }

  console.log("\n-- declared status --");
  ok(
    m.cre.officialCliSimulation === true && m.cre.realTeeExecution === false,
    "CRE mode is simulator, not live TEE", m.cre.mode,
  );
  ok(
    m.ledger.keyRingProvisioned === false && m.ledger.physicalApproval === false,
    "Ledger hardware status is honestly recorded as pending", m.ledger.blocker,
  );

  console.log(fail === 0 ? "\nHEALTH: READY" : `\nHEALTH: ${fail} PROBLEM(S)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
