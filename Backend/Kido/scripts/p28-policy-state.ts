/**
 * Read the canonical Sepolia policy from chain and record it.
 *
 * The handoff claims the agent finished with no financial authority. That claim is only worth
 * anything if it is a *reading* — a policy state with no block number and no timestamp is an
 * assertion, and the whole control plane exists because assertions about live state go stale.
 *
 * This performs one `eth_call` and writes what came back. It cannot enable anything: the ABI it
 * carries has one function on it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Address } from "viem";
import { sepolia } from "viem/chains";

const RPC = process.env["SEPOLIA_RPC_URL"];
if (!RPC) { console.error("SEPOLIA_RPC_URL not set"); process.exit(1); }

const dep = JSON.parse(readFileSync("deployments/sepolia.json", "utf8")) as {
  contracts: Record<string, string>;
};
const REGISTRY = dep.contracts["ContextLockPolicyRegistry"] as Address;

/* One function. There is no write in this ABI, so this script cannot change what it reads. */
const READ_ONLY_ABI = [
  { type: "function", name: "isPolicyEnabled", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

/*
 * The identity and policy hash come from the existing record rather than being recomputed.
 *
 * This is a RE-READ of the slot the earlier evidence names — which is the only thing that can
 * confirm that slot is still disabled. Recomputing a hash here would read some *other* slot, and a
 * disabled reading of the wrong slot is worse than no reading at all: it would look like
 * confirmation.
 */
const OUT = "reports/phase-28/evidence/p28-final-policy-state.txt";
const prior = readFileSync(OUT, "utf8");
const field = (name: string): string => {
  const m = new RegExp(`^${name}\\s*:\\s*(\\S+)$`, "m").exec(prior);
  if (!m?.[1]) throw new Error(`${OUT} has no "${name}" line to re-read`);
  return m[1];
};
const AGENT_IDENTITY = field("agentIdentity") as `0x${string}`;
const POLICY_HASH = field("policyHash") as `0x${string}`;
const PRIOR_REGISTRY = field("registry");
if (PRIOR_REGISTRY.toLowerCase() !== REGISTRY.toLowerCase()) {
  throw new Error(`the recorded registry ${PRIOR_REGISTRY} is not the manifest's ${REGISTRY}; this would read a different contract`);
}

const client = createPublicClient({ chain: sepolia, transport: http(RPC) });

const block = await client.getBlockNumber();
const enabled = await client.readContract({
  address: REGISTRY, abi: READ_ONLY_ABI, functionName: "isPolicyEnabled", args: [AGENT_IDENTITY, POLICY_HASH],
}) as boolean;

const body = `=== P28 FINAL POLICY STATE — fresh chain read ===
date          : ${new Date().toISOString()}
chain         : Ethereum Sepolia (11155111)
head block    : ${block}
registry      : ${REGISTRY}
agentIdentity : ${AGENT_IDENTITY}
policyHash    : ${POLICY_HASH}
enabled       : ${enabled}
bindingVersion: 1

The canonical policy is ${enabled ? "ENABLED" : "DISABLED"}. P28 performed no chain write; the demo's activation and
deactivation were driven through injected functions against the projection, never against
this deployment. The state above is what Group E left and what P25 and P27 also observed.

Read by scripts/p28-policy-state.ts, whose ABI contains one view function and no writes.
`;

writeFileSync(OUT, body);
console.log(body);
if (enabled) { console.error("the canonical policy is ENABLED — P28 expects it to finish disabled"); process.exit(1); }
