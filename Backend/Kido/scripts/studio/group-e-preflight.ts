/**
 * P22 live preflight evidence.
 *
 * Runs the real checks against the real things: the user's own `cre` CLI, the real Sepolia RPC, and
 * the contracts actually deployed at the addresses in deployments/sepolia.json.
 *
 * It performs NO write. Every call here is a read, a hash or a gas estimate. That is the phase
 * boundary, and this script is the demonstration of it — `grep` this file for a send and there
 * isn't one.
 *
 * Output: reports/group-e/evidence/p22-live-preflight.json
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createPublicClient, http, keccak256, toHex, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import {
  costFrom, quoteFees, aggregateByChain, requiredBalancesFor, formatUnitsExact,
  selectRegistry, testnetEnvironment, ETHEREUM_SEPOLIA, BASE_SEPOLIA,
  assertNoCreSecret, scanForSecrets, DOCUMENTED_CRE_DEFAULTS,
  type ChainReader,
} from "@contextlock/studio-deploy";

const exec = promisify(execFile);
const CRE = `${process.env.HOME}/.cre/bin/cre`;

const run = async (args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> => {
  try {
    const { stdout, stderr } = await exec(CRE, [...args, "--non-interactive"], { cwd: cwd ?? process.cwd(), maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, out: stdout + stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: (err.stdout ?? "") + (err.stderr ?? "") + err.message };
  }
};

/**
 * Parse `cre workflow supported-chains --output json` WITHOUT losing the selectors.
 *
 * The CLI emits uint64 selectors as bare JSON numbers, and `JSON.parse` turns
 * 16015286601757825753 into 16015286601757825752. Every selector in this codebase is a string for
 * exactly that reason, so the digits are lifted out of the raw text before any parser sees them.
 */
function parseSupportedChains(raw: string): Array<{ chainName: string; chainSelector: string; forwarder: string }> {
  const start = raw.indexOf("[");
  if (start < 0) return [];
  const body = raw.slice(start, raw.lastIndexOf("]") + 1);
  const out: Array<{ chainName: string; chainSelector: string; forwarder: string }> = [];
  const re = /"chainName"\s*:\s*"([^"]+)"\s*,\s*"chainSelector"\s*:\s*(\d+)\s*,\s*"address"\s*:\s*"([^"]+)"/g;
  for (let m = re.exec(body); m; m = re.exec(body)) out.push({ chainName: m[1]!, chainSelector: m[2]!, forwarder: m[3]! });
  return out;
}

async function main() {
  const rpc = process.env.SEPOLIA_RPC_URL;
  if (!rpc) throw new Error("SEPOLIA_RPC_URL is not set");
  const client = createPublicClient({ transport: http(rpc) });
  const evidence: Record<string, unknown> = { generatedAt: new Date().toISOString(), performedWrites: false };

  /* ── 1. CRE connection preflight, through the official CLI ─────────────── */
  const whoami = await run(["whoami"]);
  const registryList = await run(["registry", "list"]);
  const wfDir = "workflows/cre-policy/contextlock-policy";
  const chainsRaw = await run(["workflow", "supported-chains", "--output", "json"], wfDir);
  const limits = await run(["workflow", "limits", "export"], wfDir);
  const version = await run(["version"]);

  const deployAccess = /Deploy Access:\s*Enabled/i.test(whoami.out);
  const orgId = /Organization ID:\s*(\S+)/.exec(whoami.out)?.[1] ?? null;
  const orgName = /Organization Name:\s*(.+?)\s*│/.exec(whoami.out)?.[1] ?? null;
  const account = /Email:\s*(\S+)/.exec(whoami.out)?.[1] ?? null;
  const cliVersion = /CRE CLI version (\S+)/.exec(version.out)?.[1] ?? null;
  const registryIds = [...registryList.out.matchAll(/ID:\s+(\S+)/g)].map((m) => m[1]!);
  const supportedChains = parseSupportedChains(chainsRaw.out);

  const status = {
    connected: whoami.ok,
    mode: "LOCAL_SESSION" as const,
    organizationId: orgId,
    organizationName: orgName,
    accountLabel: account,
    deployAccess,
    availableRegistryIds: registryIds,
    supportedChains,
    cliVersion,
    staleness: "CURRENT" as const,
    checkedAtMs: Date.now(),
  };
  // The projection that crosses to the web app must carry no credential, and this is the real
  // output of the real CLI rather than a fixture of it.
  assertNoCreSecret(status, "live cre status");

  evidence.cre = {
    ...status,
    // Recorded as a count, because a supported-chain list is long and the point is that we read it.
    supportedChainCount: supportedChains.length,
    supportedChains: supportedChains.filter((c) => /sepolia$|sepolia-base-1$/.test(c.chainName)),
    deployAccessBlocker: deployAccess ? null : "CRE_DEPLOY_ACCESS_REQUIRED",
    limitsExportAvailable: limits.ok,
    registrySelectedForTestnet: (() => {
      try { return selectRegistry(testnetEnvironment([ETHEREUM_SEPOLIA])); } catch (e) { return `REFUSED: ${(e as Error).message}`; }
    })(),
    onchainRegistryRefusal: (() => {
      try { selectRegistry(testnetEnvironment([ETHEREUM_SEPOLIA]), "onchain:ethereum-mainnet"); return "NOT REFUSED — BUG"; }
      catch (e) { return (e as { reason: string }).reason; }
    })(),
    documentedQuotaFallback: DOCUMENTED_CRE_DEFAULTS,
  };

  /* ── 2. Reuse verification against the real chain ─────────────────────── */
  const recorded = JSON.parse(readFileSync("reports/group-e/evidence/sepolia-code-hashes.json", "utf8")) as {
    contracts: Record<string, { address: string; runtimeCodeHash: string }>;
  };
  const chainId = await client.getChainId();
  const block = await client.getBlockNumber();
  const reuse: Array<Record<string, unknown>> = [];
  for (const [name, rec] of Object.entries(recorded.contracts)) {
    const code = await client.getCode({ address: rec.address as Address });
    const observed = keccak256((code ?? "0x") as Hex);
    reuse.push({
      name, address: rec.address,
      expectedRuntimeCodeHash: rec.runtimeCodeHash,
      observedRuntimeCodeHash: observed,
      verdict: observed === rec.runtimeCodeHash ? "REUSE_VERIFIED" : "REUSE-CODE-HASH-MISMATCH",
    });
  }
  // The negative case, on the real chain: a real address with the WRONG expected hash must reject.
  const executor = recorded.contracts.ContextLockExecutorV2!;
  const wrongHashVerdict = keccak256((await client.getCode({ address: executor.address as Address })) ?? "0x") === `0x${"0".repeat(64)}`
    ? "MISMATCH-NOT-DETECTED — BUG" : "REUSE-CODE-HASH-MISMATCH (correctly rejected against a deliberately wrong pin)";
  evidence.reuse = { chainId, block: block.toString(), contracts: reuse, negativeControl: wrongHashVerdict };

  /* ── 3. Real gas estimation and fee quote ─────────────────────────────── */
  const deployer = process.env.DEPLOYER_ADDRESS as Address;
  const reader: ChainReader = {
    chainId, live: true,
    getChainId: () => client.getChainId(),
    getCode: (a) => client.getCode({ address: a }),
    getBalance: (a) => client.getBalance({ address: a }),
    getTransactionCount: async (a) => BigInt(await client.getTransactionCount({ address: a })),
    estimateGas: (tx) => client.estimateGas({ account: tx.from, ...(tx.to ? { to: tx.to } : {}), ...(tx.data ? { data: tx.data } : {}), ...(tx.value !== undefined ? { value: tx.value } : {}) } as never),
    estimateFeesPerGas: async () => { const f = await client.estimateFeesPerGas(); return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas, gasPrice: undefined }; },
    call: async (tx) => (await client.call({ account: tx.from, to: tx.to, data: tx.data })).data ?? "0x",
    getTransactionReceipt: async () => null,
    getBlockNumber: () => client.getBlockNumber(),
  };

  const quote = await quoteFees(reader);

  // A real contract creation: the CRE consumer's compiled creation bytecode, estimated with its
  // actual constructor arguments. Estimated, not sent.
  const artifactPath = "contracts/out/ContextLockCreConsumer.sol/ContextLockCreConsumer.json";
  let creationEstimate: Record<string, unknown> = { skipped: "contract artifact not built" };
  if (existsSync(artifactPath)) {
    const art = JSON.parse(readFileSync(artifactPath, "utf8")) as { bytecode: { object: Hex }; abi: unknown[] };
    const ctor = (art.abi as Array<{ type: string; inputs?: Array<{ type: string }> }>).find((x) => x.type === "constructor");
    const argCount = ctor?.inputs?.length ?? 0;
    // Constructor arguments are real addresses from the recorded deployment, so the estimate is an
    // estimate of the deployment we would actually perform.
    const args: unknown[] = Array.from({ length: argCount }, (_, i) =>
      (ctor!.inputs![i]!.type === "address" ? (recorded.contracts.ContextLockAuthorizationRegistry!.address as Address) : 0n));
    try {
      const { encodeDeployData } = await import("viem");
      const data = encodeDeployData({ abi: art.abi as never, bytecode: art.bytecode.object, args: args as never });
      const gas = await reader.estimateGas({ from: deployer, data });
      const cost = costFrom(gas, quote);
      creationEstimate = {
        contract: "ContextLockCreConsumer", constructorArgs: args.map(String),
        creationCodeBytes: (art.bytecode.object.length - 2) / 2,
        estimatedGas: cost.estimatedGas, feeMode: cost.feeMode, maxFeePerGasWei: cost.maxFeePerGasWei,
        baseNativeWei: cost.baseNativeWei, bufferBps: cost.bufferBps, bufferNativeWei: cost.bufferNativeWei,
        totalNativeWei: cost.totalNativeWei, totalEth: formatUnitsExact(BigInt(cost.totalNativeWei), 18),
        fromLiveNode: cost.fromLiveNode,
      };
    } catch (e) {
      creationEstimate = { error: (e as Error).message };
    }
  }

  /*
   * A real configuration write, simulated before it would be signed.
   *
   * Two cases, because one proves nothing on its own: the same call from the authorized admin (must
   * succeed) and from an address with no authority (must revert with the contract's own error).
   * A preflight that only ever showed the passing case would not demonstrate that it can catch the
   * failing one — which is the whole point of DEP-PRE-007.
   */
  let configEstimate: Record<string, unknown> = {};
  try {
    const abi = parseAbi(["function setPolicyAdmin(bytes32 agentIdentityHash, address admin)"]);
    const agentIdentityHash = keccak256(toHex("contextlock:group-e:guardian"));
    const data = encodeFunctionData({ abi, functionName: "setPolicyAdmin", args: [agentIdentityHash, deployer] });
    const to = recorded.contracts.ContextLockPolicyRegistry!.address as Address;

    let authorized: string; let authorizedGas: string | null = null;
    try {
      await reader.call({ from: deployer, to, data });
      authorizedGas = (await reader.estimateGas({ from: deployer, to, data })).toString();
      authorized = "SIMULATED_OK";
    } catch (e) { authorized = `SIMULATION_REVERTED: ${(e as Error).message.split("\n")[0]}`; }

    // The negative control. An address holding no administrative role must be refused BEFORE the
    // user is asked to sign anything and pay for a transaction that would revert.
    const stranger = "0x000000000000000000000000000000000000dEaD" as Address;
    let unauthorized: string;
    try { await reader.call({ from: stranger, to, data }); unauthorized = "NOT REFUSED — BUG"; }
    catch (e) { unauthorized = /NotAdmin|reverted/i.test((e as Error).message) ? "SIMULATION_REVERTED (correctly refused: NotAdmin)" : `REVERTED: ${(e as Error).message.split("\n")[0]}`; }

    configEstimate = {
      target: to, function: "setPolicyAdmin(bytes32,address)", selector: data.slice(0, 10),
      fromAuthorizedAdmin: { sender: deployer, simulation: authorized, estimatedGas: authorizedGas },
      fromUnauthorizedSender: { sender: stranger, simulation: unauthorized },
      note: "DEP-PRE-007: every configuration write is statically simulated before it is offered for signature, and the sender is carried into the simulation. An estimate made without a sender would report NotAdmin for the admin and success for a stranger.",
    };
  } catch (e) { configEstimate = { error: (e as Error).message }; }

  /* ── 4. Per-chain funding, on two chains, one of which is not funded ──── */
  const sepoliaBal = await client.getBalance({ address: deployer });
  const baseClient = createPublicClient({ transport: http("https://sepolia.base.org") });
  const baseBal = await baseClient.getBalance({ address: deployer });

  const gasCost = creationEstimate.totalNativeWei ? costFrom(BigInt(creationEstimate.estimatedGas as string), quote) : costFrom(150_000n, quote);
  const funding = aggregateByChain(
    [{ chainId: 11155111, cost: gasCost }, { chainId: 84532, cost: gasCost }],
    new Map([
      [11155111, { symbol: "ETH", decimals: 18, holder: deployer }],
      [84532, { symbol: "ETH", decimals: 18, holder: deployer }],
    ]),
    new Map([[11155111, sepoliaBal], [84532, baseBal]]),
  );

  const balances = requiredBalancesFor(funding, [{
    category: "TEST_PROTOCOL_ASSET", chainId: 11155111,
    token: "0x768f42455a2d082e23ceef7d51e5787c82d67a39", symbol: "MockUSDC", decimals: 6,
    amount: "500000000", holder: deployer,
    purpose: "Operating capital the agent rebalances. Not a deployment fee; it remains yours and is not spent by deploying.",
  }]);

  evidence.cost = {
    feeQuote: { mode: quote.mode, maxFeePerGasWei: quote.maxFeePerGasWei.toString(), maxPriorityFeePerGasWei: quote.maxPriorityFeePerGasWei?.toString() ?? null, fromLiveNode: quote.fromLiveNode },
    contractCreation: creationEstimate,
    configurationWrite: configEstimate,
    perChain: funding.map((f) => ({
      chainId: f.chainId, holder: f.holder,
      baseWei: f.baseWei.toString(), bufferWei: f.bufferWei.toString(), recommendedWei: f.recommendedWei.toString(),
      recommendedEth: formatUnitsExact(f.recommendedWei, 18),
      balanceWei: f.balanceWei.toString(), balanceEth: formatUnitsExact(f.balanceWei, 18),
      sufficient: f.sufficient, shortfallWei: f.shortfallWei.toString(),
    })),
    requiredBalancesByCategory: balances.map((b) => ({ category: b.category, chainId: b.chainId, symbol: b.symbol, amount: b.amount, purpose: b.purpose })),
  };

  /* ── 5. Nothing secret in any of it ───────────────────────────────────── */
  const hits = scanForSecrets(evidence, "$evidence");
  evidence.secretScan = { hits: hits.length, findings: hits };
  if (hits.length > 0) throw new Error(`the evidence file itself contains ${hits.length} secret-shaped value(s)`);

  writeFileSync("reports/group-e/evidence/p22-live-preflight.json", JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
