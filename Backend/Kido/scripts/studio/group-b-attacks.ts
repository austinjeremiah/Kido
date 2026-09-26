/**
 * Group B attack demo.
 *
 * Eight scenarios drawn from the run instruction, executed against the real registry, resolver and
 * adapter decoders. Nothing here is asserted — each line is what the code actually did.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { encodeAbiParameters, encodeFunctionData, parseAbiParameters, getAddress } from "viem";
import {
  UniswapExecutionAdapter, UNIVERSAL_ROUTER_ABI, COMMANDS, deploymentFor,
  ChainlinkDataFeedsAdapter, TheGraphSubgraphAdapter,
  resolveDataRequirement, resolveWithSuggestion, ModelOverrideRejectedError,
  type ExecutionConstraints, type UniswapSwapIntent, type UniswapPrepared,
} from "@contextlock/studio-adapters";
import { buildRegistry } from "../../apps/studio/src/adapters.js";

const SEPOLIA = 11155111;
const D = deploymentFor(SEPOLIA);
const OWNER = "0x0000000000000000000000000000000000005e1f";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const now = Math.floor(Date.now() / 1000);
const registry = buildRegistry();
const results: Array<{ n: number; scenario: string; outcome: string; detail: string }> = [];

const say = (n: number, scenario: string, outcome: string, detail: string) => {
  results.push({ n, scenario, outcome, detail });
  const c = outcome.startsWith("ALLOW") || outcome === "SELECTED" ? "\x1b[32m" : "\x1b[31m";
  console.log(`\n${n}. ${scenario}\n   ${c}${outcome}\x1b[0m  ${detail}`);
};

const intent: UniswapSwapIntent = {
  action: "SWAP", chainId: SEPOLIA, tokenIn: USDC, tokenOut: WETH,
  amountIn: "500000000", recipient: OWNER, slippageBps: 50,
  deadline: String(now + 600),
};
const constraints: ExecutionConstraints = {
  chainId: SEPOLIA, allowedTargets: [D.universalRouter], allowedRecipients: "self-only",
  owner: OWNER, maxSlippageBps: 50, allowUnlimitedApprovals: false, maxQuoteAgeMs: 30_000,
};
const calldata = (o: { recipient?: string; amountIn?: bigint } = {}) => {
  const path = `0x${USDC.slice(2)}000bb8${WETH.slice(2)}` as `0x${string}`;
  const amt = o.amountIn ?? BigInt(intent.amountIn);
  const input = encodeAbiParameters(parseAbiParameters("address, uint256, uint256, bytes, bool"), [
    getAddress(o.recipient ?? OWNER), amt, (amt * 9_950n) / 10_000n, path, true,
  ]) as `0x${string}`;
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI, functionName: "execute",
    args: [`0x${COMMANDS.V3_SWAP_EXACT_IN.toString(16).padStart(2, "0")}` as `0x${string}`, [input], BigInt(intent.deadline)],
  });
};
const prep = (data: string, ageMs = 0): UniswapPrepared => ({
  mode: "universal-router",
  swap: { to: D.universalRouter, data, value: "0", from: OWNER, chainId: SEPOLIA },
  // The summary always claims the honest transaction, in every scenario below.
  quote: { quoteId: "q", amountOut: "1", minAmountOut: "1", recipientSummary: OWNER, createdAtMs: Date.now() - ageMs },
});
const uni = new UniswapExecutionAdapter("universal-router");

console.log("\x1b[1m════ GROUP B ATTACK DEMO ════\x1b[0m");

/* 1 */ {
  const n = await uni.decodeTransaction(prep(calldata()));
  const r = uni.validateTransaction(n, intent, constraints);
  say(1, "Normal rebalance", r.ok ? "ALLOW" : "BLOCKED", `decoded recipient ${n.recipient}, amount ${n.inputs[0]?.amount}`);
}

/* 2 */ {
  const out = resolveDataRequirement(registry, {
    key: "ethUsd", kind: "eth_usd_price", chainId: SEPOLIA,
    minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 60_000, confidential: false, historical: false,
  });
  const graphOffered = registry.list().filter((m) => m.trustClass === "INDEXED_CHAIN_DATA").length;
  say(2, "Indexed price disagrees with the verified one — which wins?",
    out.ok ? "SELECTED" : "NO_COMPATIBLE_ADAPTER",
    out.ok
      ? `${out.selection.adapterId} (${out.selection.trustClass}); ${graphOffered} indexed adapter(s) were never candidates for this requirement`
      : "none");
}

/* 3 */ {
  const feeds = new ChainlinkDataFeedsAdapter(async () => ({
    roundId: "1", answer: "249356368692", startedAt: now - 86_400, updatedAt: now - 86_400, answeredInRound: "1", decimals: 8,
  }));
  const q = { dataKind: "eth_usd_price" };
  const obs = feeds.normalize(await feeds.fetch(q), q, { chainId: SEPOLIA, nowMs: Date.now() });
  const v = feeds.validate(obs, { chainId: SEPOLIA, nowMs: Date.now() });
  say(3, "Verified price is stale", v.ok ? "ALLOW" : "NO EXECUTION", v.problems[0]?.message ?? "");
}

/* 4 */ {
  const n = await uni.decodeTransaction(prep(calldata({ recipient: ATTACKER })));
  const r = uni.validateTransaction(n, intent, constraints);
  say(4, "Uniswap recipient substituted (quote still claims the owner)",
    r.ok ? "ALLOW" : "DENY", `${r.problems.map((p) => p.code).join(", ")} — decoded ${n.recipient}`);
}

/* 5 */ {
  const n = await uni.decodeTransaction(prep(calldata({ amountIn: 9_999_999_999n })));
  const r = uni.validateTransaction(n, intent, constraints);
  say(5, "Uniswap amount mutated after issuance",
    r.ok ? "ALLOW" : "CAPABILITY INVALID", `${r.problems.map((p) => p.code).join(", ")} — decoded ${n.inputs[0]?.amount}`);
}

/* 6 */ {
  const graph = new TheGraphSubgraphAdapter(async () => ({
    data: { _meta: { deployment: "Qm", block: { number: 8_990_000, hash: "0x0", timestamp: now - 7200 }, hasIndexingErrors: false }, pool: { id: "0x1", liquidity: "1" } },
    chainHead: 9_000_000,
  }));
  const q = graph.fixtureQuery();
  const obs = graph.normalize(await graph.fetch(q), q, { chainId: SEPOLIA, nowMs: Date.now() });
  const v = graph.validate(obs, { chainId: SEPOLIA, nowMs: Date.now() });
  say(6, "Graph result is stale", v.ok ? "ALLOW" : "SURFACED AS STALE",
    `${v.problems[0]?.message ?? ""} (indexed ${obs.provenance.indexedBlock}, head ${obs.provenance.chainHeadBlock}, lag ${obs.provenance.blockLag})`);
}

/* 7 */ {
  let outcome = "MODEL OVERRODE THE RESOLVER";
  let detail = "";
  try {
    resolveWithSuggestion(
      registry,
      { key: "ethUsd", kind: "eth_usd_price", chainId: SEPOLIA, minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 60_000, confidential: false, historical: false },
      { adapterId: "chainlink-functions", adapterVersion: "1.0.0" },
    );
  } catch (e) {
    outcome = "REJECTED";
    detail = e instanceof ModelOverrideRejectedError ? e.message : String(e);
  }
  say(7, "Model tries to use an untrusted source for a verified-price requirement", outcome, detail);
}

/* 8 */ {
  const a = resolveDataRequirement(registry, { key: "k", kind: "eth_usd_price", chainId: SEPOLIA, minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 60_000, confidential: false, historical: false });
  const b = resolveDataRequirement(registry, { key: "k", kind: "eth_usd_price", chainId: SEPOLIA, minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 60_000, confidential: false, historical: false });
  const same = a.ok && b.ok && a.selection.adapterId === b.selection.adapterId && a.selection.adapterVersion === b.selection.adapterVersion;
  say(8, "Same Blueprint regenerated", same ? "PINNED VERSIONS UNCHANGED" : "DRIFTED",
    a.ok ? `${a.selection.adapterId}@${a.selection.adapterVersion} both times` : "unresolved");
}

mkdirSync("reports/group-b/evidence", { recursive: true });
writeFileSync("reports/group-b/evidence/group-b-attacks.json", JSON.stringify(results, null, 2));
console.log(`\n\x1b[1m${results.length} scenarios executed\x1b[0m`);
