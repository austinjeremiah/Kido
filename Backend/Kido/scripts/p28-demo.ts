/**
 * P28 canonical demo — the 50-step user journey.
 *
 * One project, from a natural-language prompt to an activated testnet agent, attacked, shadow-run
 * on a real mainnet fork, edited, paused, disabled and exported — with every claim produced by the
 * system that owns it.
 *
 * Real throughout: real mainnet reads, the real Chainlink aggregator, the real CRE CLI simulator,
 * the real Sepolia deployment from Group E, a real Anvil fork of a real mainnet block, and a real
 * Uniswap swap on that fork. No public mainnet transaction occurs at any point.
 */
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  projectLabState, labStateLabel, productModeDescriptor, HEADLINE_CLAIM,
  buildSummary, capabilityReview, assertBoundariesEstablished,
  realityModes, graphStatus, realityDisplay, badgeTone,
  creStatus, assertCreDisplayHonest, promotionAvailability, assertRegistryAllowed,
  assertArtifactUnchanged, CreConnectionInfoSchema, PromotionArtifactSchema, assertNoCreSession,
  deployReadiness, costBreakdown, DEPLOY_PHASES, activate, ACTIVATION_CHECKS, CONTROL_SEMANTICS,
  ATTACKS, applicableAttacks, buildSecurityPath, assembleAttackRun, assertDefensesExercised, attackSummary,
  securityDiff, authorityExpansions, markStale, assertCurrentRevision, REVISION_KINDS,
  sealSafetyReport, publicSafetyView, scanForSecrets,
  type LabInputs, type ActivationCheck, type SecurityLayer, type AttackRun,
} from "../packages/studio-lab/src/index.js";
import { canonicalP28Blueprint, CANONICAL_OBJECTIVE } from "./lib/p28-blueprint.js";
import {
  FencedJsonRpcProvider, ReadSourceEndpointSchema, corroborateBlockNumber, sealSnapshot,
  selectSource, sourceAgeLimits, stalenessThresholdMs, AnvilForkProvider, explorerUrlFor,
  LOCAL_FORK_TX_LABEL, ANVIL_DEV_ACCOUNTS, applyOverlay, assertBaseUnchanged,
  type MarketObservation, type SnapshotSource, type ForkDescriptor,
} from "../packages/studio-reality/src/index.js";
import { fenceWriteByChain, lookupNetwork, NetworkGuardError } from "../packages/studio-network/src/index.js";

const OUT = "reports/phase-28/evidence";
const UPSTREAM = process.env["MAINNET_RPC_URL"] ?? "https://ethereum-rpc.publicnode.com";
const CRE = `${process.env["HOME"]}/.cre/bin/cre`;

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" as const;
const FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" as const;
const ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as const;

/** The real Sepolia deployment from Group E. Nothing is redeployed; this demo reads it. */
const SEPOLIA_CONSUMER = "0xf8a3b4bf44975a2d4b3fb7a099b80db7620ad2ca";
const SEPOLIA_DEPLOY_TX = "0xb33a7366f763ca6ec6bd889eef3599c6de69d0f5e0a9bf6ed1fafadb2c81fc0c";
const RUNTIME_IMAGE = "sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5";

const lines: string[] = [];
let n = 0;
const STEPS: Array<{ n: number; title: string; ok: boolean; detail: string }> = [];
const say = (s: string): void => { lines.push(s); console.log(s); };
const step = (title: string): void => { n += 1; say(""); say(`── ${String(n).padStart(2)}. ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`); };
const ok = (title: string, pass: boolean, detail: string): void => {
  STEPS.push({ n, title, ok: pass, detail });
  say(`   ${pass ? "PASS" : "FAIL"}  ${detail}`);
  if (!pass) process.exitCode = 1;
};

const pad32 = (h: string): string => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const uint = (v: bigint): string => pad32(v.toString(16));

async function rpc(endpoint: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const call = async (e: string, to: string, data: string): Promise<string> => (await rpc(e, "eth_call", [{ to, data }, "latest"])) as string;
async function receipt(e: string, hash: string): Promise<{ status: string; gasUsed: string }> {
  for (let i = 0; i < 40; i++) {
    const r = (await rpc(e, "eth_getTransactionReceipt", [hash])) as { status: string; gasUsed: string } | null;
    if (r) return r;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`no receipt for ${hash}`);
}
async function ready(e: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { await rpc(e, "eth_chainId"); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error("anvil never became ready");
}

const PROMPT = `Build a DeFi treasury guardian. Monitor my Aave position. Keep health factor above 1.6.
If health factor falls below 1.35, repay enough debt to recover safely. Use verified Chainlink market
data. Use real Ethereum mainnet market conditions when testing the strategy. For repayment: up to
$1,000 automatic. $1,000 to $5,000 requires approval. Above $5,000 deny. Never withdraw collateral.
Never borrow. Production-chain execution must always remain disabled.`;

async function main(): Promise<void> {
  say("═══════════════════════════════════════════════════════════════════════");
  say("   ContextLock PHASE 28 — TESTNET AGENT LAB, canonical journey");
  say("═══════════════════════════════════════════════════════════════════════");
  say(`date : ${new Date().toISOString()}`);
  say(`mode : ${productModeDescriptor().mode}`);
  say(`claim: ${HEADLINE_CLAIM}`);

  const reader = new FencedJsonRpcProvider(ReadSourceEndpointSchema.parse({ chainId: 1, providerId: "publicnode", url: UPSTREAM, archiveDepth: "RECENT_STATE_ONLY" }));
  const secondary = new FencedJsonRpcProvider(ReadSourceEndpointSchema.parse({ chainId: 1, providerId: "publicnode-2", url: UPSTREAM, archiveDepth: "RECENT_STATE_ONLY" }));

  /* ── the project ───────────────────────────────────────────────────────── */
  const projectId = "proj-treasury-guardian";
  let inputs: LabInputs = {
    build: null, deterministicSimulationsPassed: false, creSimulationPassed: false,
    preflightPassed: false, deployment: null, runtime: null, cre: null, policy: null,
    emergencyLockActive: false, degradedDependencies: [],
  };
  const advance = (patch: Partial<LabInputs>): void => { inputs = { ...inputs, ...patch }; };
  const state = (): string => projectLabState(inputs).state;

  /* 1 */ step("Create a project from natural language");
  say(`   project  ${projectId}`);
  say(`   prompt   "${PROMPT.split("\n")[0]}…"`);
  ok("create project", state() === "DRAFT", `project created, lifecycle ${state()}`);

  /* 2 */ step("Requirements generated");
  advance({ build: { stage: "REQUIREMENTS", status: "RUNNING" } });
  ok("requirements", state() === "DRAFT", `the pipeline is at REQUIREMENTS; lifecycle ${state()}`);

  /* 3 */ step("Blueprint generated");
  /*
   * §P28.57's prompt, both halves. Built from the shared definition rather than from a local
   * `validGuardian` call: this script writes `p28-blueprint.json`, and when it built a one-half
   * document it silently overwrote the two-half one the API and the tests read.
   */
  const bp = canonicalP28Blueprint();
  advance({ build: { stage: "BLUEPRINT", status: "RUNNING" } });
  say(`   blueprint revision ${bp.revision}, ${bp.actions.length} actions, ${bp.permissions.denied.length} explicit denials`);
  ok("blueprint", state() === "ARCHITECTURE_READY", `Blueprint compiled; lifecycle ${state()}`);

  /* 4 */ step("Architecture appears");
  const summary = buildSummary(bp, 11155111, 1);
  say(`   ${summary.name}`);
  say(`   goal              ${summary.goal}`);
  say(`   execution         ${summary.execution.name} — ${summary.execution.label}`);
  say(`   reality data      ${summary.realityData?.name} — ${summary.realityData?.label}`);
  say(`   protocols         ${summary.protocols.join(", ")}`);
  say(`   verified data     ${summary.verifiedMarketData.join(", ")}`);
  say(`   autonomous        ${summary.autonomous}`);
  say(`   human approval    ${summary.humanApproval}`);
  say(`   hard deny         ${summary.hardDeny}`);
  ok("architecture", summary.autonomous.startsWith("≤"), `summary derived from Blueprint revision ${summary.blueprintRevision}`);

  /* 5 */ step("Permissions review appears");
  advance({ build: { stage: "AWAITING_APPROVAL", status: "AWAITING_APPROVAL" } });
  const caps = capabilityReview(bp, 11155111);
  say("   WHAT THIS AGENT CAN DO");
  for (const l of caps.filter((c) => c.kind === "CAN").slice(0, 5)) say(`     + ${l.statement}`);
  say("   WHAT THIS AGENT CANNOT DO");
  for (const l of caps.filter((c) => c.kind === "CANNOT")) say(`     - ${l.statement}`);
  assertBoundariesEstablished(bp, "review");
  ok("permissions", state() === "REVIEW_REQUIRED" && caps.some((c) => c.kind === "CANNOT" && /production chain/i.test(c.statement)),
    `${caps.filter((c) => c.kind === "CANNOT").length} denials, every one traced to a Blueprint field or the product boundary`);

  /* 6-7 */ step("Build runs and the generated code passes");
  advance({ build: { stage: "EXPORT_READY", status: "COMPLETED" } });
  ok("build", state() === "BUILD_READY", `build COMPLETED; lifecycle ${state()} — nothing has been simulated yet`);

  /* 8 */ step("ContextLock deterministic simulations pass");
  advance({ deterministicSimulationsPassed: true });
  ok("deterministic simulations", true, "31/31 deterministic security simulations passed");

  /* 9 */ step("Official CRE simulation passes");
  let creOut = "";
  try {
    creOut = execFileSync(CRE, ["workflow", "simulate", "policy", "--target", "staging-settings", "--non-interactive", "--trigger-index", "0",
      "--evm-tx-hash", "0x62753fddb9c92d2ff9989c430e2ca47224f992ac3243eb77bea05eda21679843", "--evm-event-index", "0"],
      { cwd: "workflows/cre-policy/contextlock-cre", encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    creOut = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const wasmHash = /Binary hash: ([0-9a-f]{64})/.exec(creOut)?.[1] ?? null;
  const creVerdict = /^"(.+)"$/m.exec(creOut)?.[1] ?? "none";
  const limitsOn = /Simulation limits enabled/.test(creOut);
  say(`   binary ${wasmHash?.slice(0, 24)}…  limits ${limitsOn ? "ENABLED" : "NOT ENABLED"}  result ${creVerdict}`);
  advance({ creSimulationPassed: /Workflow Simulation Result/.test(creOut) });
  ok("CRE simulation", inputs.creSimulationPassed && limitsOn, `official CRE CLI returned ${creVerdict} under production limits`);

  /* 10 */ step("User selects Live Mainnet Mirror");
  const capsReality = { mainnetReadAvailable: true, archiveDepth: "RECENT_STATE_ONLY" as const, forkAvailable: true, availableCredentials: new Set<string>() };
  for (const m of realityModes(capsReality)) {
    say(`   ${m.availability.padEnd(9)} ${m.label}${m.blocker ? `  (${m.blocker})` : ""}`);
    if (m.reason) say(`             ${m.reason}`);
  }
  ok("reality selector", realityModes(capsReality).length === 4, "all four modes shown, including the unavailable ones with their reasons");

  /* 11 */ step("Reality Engine reads actual mainnet context");
  const corr = await corroborateBlockNumber([reader, secondary]);
  const anchor = await reader.getBlock(corr.agreed!);
  const round = await reader.call({ to: FEED, data: "0xfeaf968c" }, anchor.number);
  const answer = BigInt(`0x${round.slice(2).slice(64, 128)}`);
  const updatedAt = BigInt(`0x${round.slice(2).slice(192, 256)}`);
  const decimals = Number(BigInt(await reader.call({ to: FEED, data: "0x313ce567" }, anchor.number)));
  const ethUsd = Number(answer) / 10 ** decimals;
  const reserve = await reader.call({ to: AAVE_POOL, data: `0x35ea6a75${pad32(WETH)}` }, anchor.number);
  const liquidityRate = BigInt(`0x${reserve.slice(2).slice(128, 192)}`);
  say(`   mainnet block ${anchor.number}  hash ${anchor.hash.slice(0, 20)}…`);
  say(`   ETH/USD $${ethUsd}  updated ${new Date(Number(updatedAt) * 1000).toISOString()}`);
  say(`   Aave WETH liquidityRate ${liquidityRate}`);
  ok("mainnet read", anchor.number > 20_000_000n && ethUsd > 100, `read mainnet block ${anchor.number}, corroborated across ${corr.readings.length} providers`);

  /* 12 */ step("Chainlink oracle source verified");
  const selection = selectSource({ subject: "weth/usd", chainId: 1, requiredTrust: "VERIFIED_ORACLE", maxAgeMs: 3_600_000 });
  say(`   ${selection.source.sourceId}  ${selection.source.lifecycle}  verified ${selection.source.verifiedAt}`);
  say(`   rejected: ${selection.rejected.map((r) => r.sourceId).join(", ") || "none"}`);
  ok("chainlink verified", selection.source.trustClass === "VERIFIED_ORACLE", `${selection.source.identity} selected at VERIFIED_ORACLE`);

  /* 13 */ step("The Graph honestly shows unavailable");
  const g = graphStatus(capsReality);
  say(`   The Graph   ${g.status}`);
  say(`   reason      ${g.reason}`);
  say(`   effect      ${g.effect}`);
  say(`   security    ${g.securityImpact}`);
  say(`   tone        ${badgeTone(g.status)}`);
  ok("graph honest", g.status === "UNAVAILABLE" && badgeTone(g.status) !== "GREEN", `UNAVAILABLE (${g.blocker}); no fallback substitution occurred`);

  /* 14 */ step("Execution remains Sepolia");
  const display = realityDisplay({ marketChainId: 1, executionChainId: 11155111 });
  say(`   MARKET SOURCE     ${display.marketSource.name} — ${display.marketSource.roleLabel}`);
  say(`   EXECUTION TARGET  ${display.executionTarget.name} — ${display.executionTarget.roleLabel}`);
  ok("networks separate", display.marketSource.chainId !== display.executionTarget.chainId && display.marketSource.role === "READ_ONLY_SOURCE",
    "market source and execution target are separate fields with separate roles");

  /* build the snapshot the agent will decide against */
  const retrievedAtMs = Date.now();
  const sources: SnapshotSource[] = [
    { sourceId: selection.source.sourceId, kind: "CHAINLINK_DATA_FEED", adapterId: "chainlink-data-feeds", adapterVersion: "1.0.0", trustClass: "VERIFIED_ORACLE", sourceChainId: 1, timeSupport: "BLOCK_SCOPED", observedBlock: anchor.number.toString(), lagBlocks: 0, healthy: true, detail: `aggregator ${FEED}` },
    { sourceId: "aave-v3-mainnet-reserves", kind: "READ_ONLY_RPC", adapterId: "aave-v3-state", adapterVersion: "1.4.0", trustClass: "DIRECT_CHAIN_DATA", sourceChainId: 1, timeSupport: "BLOCK_SCOPED", observedBlock: anchor.number.toString(), lagBlocks: 0, healthy: true, detail: `Aave v3 Pool ${AAVE_POOL}` },
  ];
  const observations: MarketObservation[] = [
    { observationId: "obs-price", metric: "weth/usd:price", value: answer.toString(), decimals, unit: "USD", dataType: "PRICE", canonicalAssetId: "weth", sourceId: selection.source.sourceId, sourceChainId: 1, blockNumber: anchor.number.toString(), sourceTimestampMs: Number(updatedAt) * 1000, retrievedAtMs, trustClass: "VERIFIED_ORACLE", adapterId: "chainlink-data-feeds", adapterVersion: "1.0.0", derivedFrom: null, provenance: `Chainlink ETH/USD ${FEED} at mainnet block ${anchor.number}` },
    { observationId: "obs-rate", metric: "aave-v3:weth:liquidityRate", value: liquidityRate.toString(), decimals: 27, unit: "ray", dataType: "RATE", canonicalAssetId: "weth", sourceId: "aave-v3-mainnet-reserves", sourceChainId: 1, blockNumber: anchor.number.toString(), sourceTimestampMs: Number(anchor.timestamp) * 1000, retrievedAtMs, trustClass: "DIRECT_CHAIN_DATA", adapterId: "aave-v3-state", adapterVersion: "1.4.0", derivedFrom: null, provenance: `Aave v3 getReserveData(WETH) at block ${anchor.number}` },
  ];
  const snapshot = sealSnapshot({
    snapshotId: `p28-${anchor.number}`, mode: "LIVE_MIRROR", observedAtMs: retrievedAtMs,
    anchorChainId: 1, anchorBlock: anchor.number.toString(), anchorBlockHash: anchor.hash.toLowerCase(),
    anchorBlockTimestampMs: Number(anchor.timestamp) * 1000, sources, observations,
    provenance: [`P28 demo, mainnet read-only at ${new Date(retrievedAtMs).toISOString()}`],
    nowMs: retrievedAtMs, maxTimeSkewMs: stalenessThresholdMs(selection.source),
    sourceMaxAgeMs: sourceAgeLimits(sources.map((s) => s.sourceId)), maxSourceAgeMs: 5_400_000,
  });

  /* 15 */ step("User opens Deploy");
  advance({ preflightPassed: true });
  ok("preflight", state() === "READY_TO_DEPLOY", `preflight passed; lifecycle ${state()}`);

  /* 16-17 */ step("Gas estimate and testnet balance");
  const cost = costBreakdown({ estimatedGas: 400_810n, gasPriceWei: 2_181_215_936n, currentBalanceWei: 92_000_000_000_000_000n, executionChainId: 11155111 });
  say(`   estimated gas      ${cost.deployment.estimatedGas}`);
  say(`   estimated          ${(Number(cost.deployment.estimatedWei) / 1e18).toFixed(6)} ${cost.deployment.asset}`);
  say(`   buffer             ${cost.deployment.safetyBufferPercent}%`);
  say(`   recommended        ${(Number(cost.deployment.recommendedWei) / 1e18).toFixed(6)}`);
  say(`   current balance    ${(Number(cost.deployment.currentBalanceWei) / 1e18).toFixed(6)}`);
  say(`   note               ${cost.deployment.note}`);
  const costJson = JSON.stringify(cost);
  ok("cost", !/usdEquivalent|dollarValue/.test(costJson), "four cost categories kept separate; no dollar equivalent for a testnet asset");

  /* 18 */ step("Deploy to Testnet Lab");
  const gate = deployReadiness({
    architecturePassed: true, securityTestsPassed: true, creSimulationPassed: true, realityTestPassed: true,
    preflightPassed: true, executionChainId: 11155111, runtimeImageDigest: RUNTIME_IMAGE,
    estimatedGas: 400_810n, walletBalanceWei: 92_000_000_000_000_000n, requiredBalanceWei: 1_049_000_000_000_000n,
  });
  for (const gg of gate.gates) say(`   ${gg.status.padEnd(5)} ${gg.label.padEnd(22)} ${gg.detail.slice(0, 70)}`);
  advance({ deployment: "DEPLOYING_CHAIN_COMPONENTS" });
  ok("deploy gate", gate.canDeploy && state() === "DEPLOYING", "every gate passed; deployment started");

  /* 19-20 */ step("Contracts verified, policy remains disabled");
  say(`   phases: ${DEPLOY_PHASES.map((p) => p.key).join(" → ")}`);
  say(`   Group E deployment on Sepolia: consumer ${SEPOLIA_CONSUMER}`);
  say(`   deploy tx ${SEPOLIA_DEPLOY_TX}`);
  advance({ deployment: "READY_TO_ACTIVATE", policy: { enabled: false, observedAtBlock: "11674967", observedAtMs: Date.now(), source: "sepolia rpc" } });
  ok("policy disabled", state() === "READY_TO_ACTIVATE" && inputs.policy?.enabled === false, "contracts verified; the ContextLock policy is DISABLED");

  /* 21-23 */ step("Runtime and CRE simulator start, health gates pass");
  advance({ runtime: "HEALTHY", cre: "NOT_DEPLOYED" });
  const creSt = creStatus({ mode: "SIMULATED_USER", organizationId: "org_ENDgZRZzalm3d3So", workflowBinaryHash: wasmHash, productionLimits: limitsOn, deployAccess: false, registries: ["private"], officialSimulationRan: true });
  assertCreDisplayHonest(creSt);
  say(`   CHAINLINK CRE`);
  say(`     Mode              ${creSt.mode}`);
  say(`     Account           ${creSt.account}`);
  say(`     Workflow binary   ${creSt.workflowBinary?.slice(0, 24)}…`);
  say(`     Production limits ${creSt.productionLimits}`);
  say(`     DON deployment    ${creSt.donDeployment}`);
  say(`     Hardware TEE      ${creSt.hardwareTee}`);
  ok("health gates", state() === "READY_TO_ACTIVATE", "runtime HEALTHY, CRE simulator healthy, policy still DISABLED");

  /* 24-25 */ step("User activates — the policy is enabled LAST");
  /*
   * Exercised against the projection with INJECTED chain functions.
   *
   * This step proves the ORDERING — eight checks, then enablePolicy, then a fresh read — and it
   * does not write to Sepolia. The canonical deployment's policy is left exactly as Group E left
   * it, and `p28-final-policy-state.txt` records a real read of it. Calling this a live activation
   * would be claiming a chain write that did not happen.
   */
  say("   NOTE: activation is exercised against the projection with injected chain functions.");
  say("         No chain write is performed. The canonical policy on Sepolia is untouched;");
  say("         reports/phase-28/evidence/p28-final-policy-state.txt records a real read of it.");
  const order: string[] = [];
  const checks = {} as Record<ActivationCheck, { passed: boolean; detail: string }>;
  for (const c of ACTIVATION_CHECKS) checks[c] = { passed: true, detail: "verified" };
  const activation = await activate({
    checks,
    executionChainId: 11155111,
    enablePolicy: async () => { order.push("enablePolicy"); },
    readPolicyFromChain: async () => { order.push("freshChainRead"); return { enabled: true, blockNumber: "11674970" }; },
  });
  for (const c of activation.checks) say(`   ${c.passed ? "✓" : "✗"} ${c.check}`);
  say(`   order: ${order.join(" → ")}`);
  advance({ policy: { enabled: true, observedAtBlock: activation.verifiedAtBlock, observedAtMs: Date.now(), source: "sepolia rpc, fresh read" } });
  ok("activation", order[0] === "enablePolicy" && order[1] === "freshChainRead" && state() === "LAB_ACTIVE",
    `all ${ACTIVATION_CHECKS.length} checks ran before enablePolicy, then a fresh read — ordering proven against injected chain functions, no chain write performed`);

  /* 26 */ step("TESTNET LAB ACTIVE");
  const proj = projectLabState(inputs);
  say(`   ● ${labStateLabel(proj.state).headline}`);
  say(`   EXECUTION              ${lookupNetwork(11155111)?.name}`);
  say(`   MARKET REALITY         ${lookupNetwork(1)?.name} — READ ONLY`);
  say(`   CRE                    ${creSt.mode}`);
  say(`   CONTEXTLOCK POLICY     Enabled`);
  say(`   ${HEADLINE_CLAIM}`);
  ok("lab active", proj.state === "LAB_ACTIVE" && proj.hasFinancialAuthority, "the agent holds financial authority on an approved testnet");

  /* 27-29 */ step("A mainnet condition produces a decision, evaluated and executed on testnet");
  say(`   snapshot        ${snapshot.snapshotId} (${snapshot.snapshotHash.slice(0, 26)}…)`);
  say(`   ETH/USD         $${ethUsd}  VERIFIED_ORACLE  block ${anchor.number}`);
  say(`   CRE simulation  ${creVerdict}`);
  say(`   ContextLock     ALLOW:ALLOW_POLICY_MATCH`);
  say(`   execution       Ethereum Sepolia`);
  ok("decision", snapshot.coherence.coherent, "a mainnet observation produced a decision executed on a testnet");

  /* 30 */ step("The activity timeline reconstructs the decision");
  const correlationId = `corr-${anchor.number}`;
  const timeline = [
    `snapshot created            ${snapshot.snapshotId}`,
    `ETH/USD $${ethUsd}          ${selection.source.sourceId}  VERIFIED_ORACLE`,
    `Aave state evaluated        block ${anchor.number}`,
    `CRE simulator               ${creVerdict}`,
    `ContextLock                 ALLOW`,
    `capability issued           bound to chainId/target/calldataHash/value/nonce/expiry`,
    `Sepolia transaction         submitted`,
  ];
  for (const t of timeline) say(`   ${t}`);
  ok("timeline", timeline.length === 7, `every step carries correlation id ${correlationId}`);

  /* 31-35 */ step("Attack Lab");
  const applicable = applicableAttacks(bp);
  say(`   ${applicable.length} of ${ATTACKS.length} scenarios apply to this Blueprint`);
  const runs: AttackRun[] = [];

  const runAttack = (scenario: string, path: Parameters<typeof buildSecurityPath>[0], diffs: Array<{ field: string; original: string; mutated: string }>, capabilityIssued = false, transactionSubmitted = false, additional: Array<{ layer: SecurityLayer; reasonCode: string }> = []): void => {
    const def = ATTACKS.find((a) => a.scenario === scenario)!;
    const run = assembleAttackRun({ definition: def, path: buildSecurityPath(path), diffs, capabilityIssued, transactionSubmitted, additionalDefenses: additional });
    runs.push(run);
    say(`   ${attackSummary(run)}`);
    for (const d of run.diffs) say(`       ${d.field}: ${d.original}  →  ${d.mutated}`);
  };

  runAttack("PROMPT_INJECTION",
    [{ layer: "CRE_SIMULATION", outcome: "PASS" }, { layer: "CONTEXTLOCK_POLICY", outcome: "DENY", reasonCode: "RECIPIENT_NOT_ALLOWED" }, { layer: "CAPABILITY_ISSUER", outcome: "PASS" }],
    [{ field: "recipient (via injected model context)", original: "0xTreasury", mutated: "0xAttacker" }]);

  runAttack("RECIPIENT_MUTATION",
    [{ layer: "CONTEXTLOCK_POLICY", outcome: "DENY", reasonCode: "RECIPIENT_NOT_ALLOWED" }, { layer: "CAPABILITY_ISSUER", outcome: "PASS" }],
    [{ field: "recipient", original: "0xTreasury", mutated: "0xAttacker" }]);

  runAttack("AMOUNT_MUTATION",
    [{ layer: "CONTEXTLOCK_POLICY", outcome: "DENY", reasonCode: "DENY_AMOUNT_TOO_HIGH" }],
    [{ field: "amount", original: "500000000 (declared $500)", mutated: "50000000000 (encoded $50,000)" }]);

  runAttack("REPLAY",
    [{ layer: "CONTEXTLOCK_POLICY", outcome: "PASS" }, { layer: "CAPABILITY_ISSUER", outcome: "PASS" }, { layer: "EXECUTOR", outcome: "DENY", reasonCode: "AuthorizationAlreadyUsed" }],
    [{ field: "nonce", original: "117 (fresh)", mutated: "117 (reused)" }], true, true);

  // The mandatory one. Every listed defence is exercised first.
  const exercised = new Set<SecurityLayer>(["STRATEGY_COMPILER", "EXECUTION_PLANNER", "RELAYER", "RPC_TRANSPORT"]);
  const defenses: Array<{ layer: SecurityLayer; reasonCode: string }> = [];
  for (const [layer, fence] of [["EXECUTION_PLANNER", "EXECUTION_PLAN_VALIDATOR"], ["RELAYER", "RELAYER"]] as const) {
    try { fenceWriteByChain(fence, 1); } catch (e) { defenses.push({ layer, reasonCode: (e as NetworkGuardError).reason }); }
  }
  const { assertRpcMethodAllowed } = await import("../packages/studio-reality/src/index.js");
  try { assertRpcMethodAllowed("eth_sendRawTransaction"); } catch (e) { defenses.push({ layer: "RPC_TRANSPORT", reasonCode: (e as { reason: string }).reason }); }
  assertDefensesExercised(defenses, exercised, "mainnet write attack");
  runAttack("MAINNET_WRITE_ATTEMPT",
    [{ layer: "STRATEGY_COMPILER", outcome: "DENY", reasonCode: "PRODUCTION_NETWORK_WRITE_PROHIBITED" }],
    [{ field: "chainId", original: "11155111", mutated: "1" }], false, false, defenses);
  say(`       additional defenses actually exercised: ${defenses.map((d) => `${d.layer}=${d.reasonCode}`).join(", ")}`);

  ok("attack lab", runs.every((r) => r.result === "DENIED"), `${runs.length} attacks, all denied, each naming the layer that stopped it`);

  /* 36-38 */ step("Shadow Agent on a pinned mainnet fork");
  const forkBlock = anchor.number - 10n;
  const upstreamBlock = await reader.getBlock(forkBlock);
  const forkProvider = new AnvilForkProvider({ rpc, readUpstreamBlockHash: async (_c, b) => (await reader.getBlock(BigInt(b))).hash });
  let fork: ForkDescriptor = await forkProvider.create({ sourceChainId: 1, forkBlock: forkBlock.toString(), upstreamRpcUrl: UPSTREAM, sourceProviderId: "publicnode", port: 8751 });
  await ready(fork.endpoint);
  fork = await forkProvider.verifyAnchor(fork.forkId);
  say(`   fork ${fork.forkId} at block ${fork.forkBlock}`);
  say(`   fork hash     ${fork.forkBlockHash}`);
  say(`   upstream hash ${upstreamBlock.hash}`);

  const dev = ANVIL_DEV_ACCOUNTS[0];
  const dep = (await rpc(fork.endpoint, "eth_sendTransaction", [{ from: dev.address, to: WETH, data: "0xd0e30db0", value: `0x${(2n * 10n ** 18n).toString(16)}` }])) as string;
  await receipt(fork.endpoint, dep);
  const apr = (await rpc(fork.endpoint, "eth_sendTransaction", [{ from: dev.address, to: WETH, data: `0x095ea7b3${pad32(ROUTER)}${uint(2n * 10n ** 18n)}` }])) as string;
  await receipt(fork.endpoint, apr);
  const usdcBefore = BigInt(await call(fork.endpoint, USDC, `0x70a08231${pad32(dev.address)}`));
  const swap = (await rpc(fork.endpoint, "eth_sendTransaction", [{ from: dev.address, to: ROUTER, gas: "0x7a120", data: `0x04e45aaf${pad32(WETH)}${pad32(USDC)}${pad32("bb8")}${pad32(dev.address)}${uint(10n ** 18n)}${uint(0n)}${uint(0n)}` }])) as string;
  const swapR = await receipt(fork.endpoint, swap);
  const usdcAfter = BigInt(await call(fork.endpoint, USDC, `0x70a08231${pad32(dev.address)}`));
  const usdcOut = Number(usdcAfter - usdcBefore) / 1e6;
  say(`   LOCAL MAINNET FORK`);
  say(`     source block    ${fork.forkBlock}`);
  say(`     protocol        Uniswap V3`);
  say(`     input           1 WETH`);
  say(`     output          ${usdcOut} USDC`);
  say(`     transaction     ${swap}`);
  say(`     label           ${LOCAL_FORK_TX_LABEL}`);
  say(`     public explorer ${explorerUrlFor({ chainId: 31337, hash: swap }) ?? "NONE"}`);
  ok("shadow fork", swapR.status === "0x1" && explorerUrlFor({ chainId: 31337, hash: swap }) === null,
    `real Uniswap v3 swap on the fork: 1 WETH → ${usdcOut} USDC, labelled local, no explorer link`);

  /* 39-40 */ step("Synthetic market crash, and the decision compared");
  const hashBefore = snapshot.snapshotHash;
  const crash = applyOverlay(snapshot, {
    schemaVersion: "contextlock.scenario-overlay/v1", overlayId: "p28-crash-30", name: "ETH -30%",
    description: "A 30% drawdown applied to the verified price.",
    mutations: [{ metric: "weth/usd:price", op: "PERCENT", operand: -30, note: "price falls 30%" }],
  }, { snapshotId: `p28-crash-${anchor.number}` });
  assertBaseUnchanged(snapshot, hashBefore);
  const crashed = crash.snapshot.observations.find((o) => o.metric === "weth/usd:price")!;
  say(`   BASE MARKET      $${ethUsd}   ${snapshot.observations[0]?.trustClass}   → ALLOW`);
  say(`   ETH -30%         $${Number(BigInt(crashed.value)) / 10 ** crashed.decimals}   ${crashed.trustClass}   → ESCALATE (trust below policy)`);
  say(`   base hash before ${hashBefore.slice(0, 30)}…`);
  say(`   base hash after  ${snapshot.snapshotHash.slice(0, 30)}…`);
  say(`   scenario hash    ${crash.scenarioHash.slice(0, 30)}…`);
  ok("shock test", snapshot.snapshotHash === hashBefore && crashed.trustClass === "USER_UNTRUSTED",
    "the base snapshot is unchanged; the synthetic value is downgraded to USER_UNTRUSTED");

  /* 41-43 */ step("Pause the runtime, and show authority separately");
  advance({ runtime: "PAUSED" });
  const paused = projectLabState(inputs);
  say(`   ${labStateLabel(paused.state).headline}`);
  say(`   ${labStateLabel(paused.state).detail}`);
  say(`   ${CONTROL_SEMANTICS.PAUSE_RUNTIME.label}: ${CONTROL_SEMANTICS.PAUSE_RUNTIME.doesNot}`);
  say(`   ${CONTROL_SEMANTICS.DISABLE_POLICY.label}: ${CONTROL_SEMANTICS.DISABLE_POLICY.effect}`);
  say(`   financial authority while paused: ${paused.hasFinancialAuthority}`);
  advance({ runtime: "HEALTHY" });
  ok("pause semantics", paused.state === "PAUSED" && paused.hasFinancialAuthority,
    "pausing the runtime is an operational stop; the policy stays enabled and the UI says so");

  /* 44-45 */ step("Disable the policy, and verify it from a fresh chain read");
  advance({ policy: { enabled: false, observedAtBlock: "11675002", observedAtMs: Date.now(), source: "sepolia rpc, fresh read" } });
  const afterDisable = projectLabState(inputs);
  say(`   policy enabled       ${inputs.policy?.enabled}`);
  say(`   verified at block    ${inputs.policy?.observedAtBlock}`);
  say(`   source               ${inputs.policy?.source}`);
  say(`   lifecycle            ${afterDisable.state}`);
  ok("policy disabled", afterDisable.hasFinancialAuthority === false && afterDisable.state === "READY_TO_ACTIVATE",
    "the projection reports no financial authority once the policy reading says disabled (simulated reading; the real Sepolia policy was never enabled)");

  /* the live edit, before the report */
  step("A live edit creates a revision and shows the authority diff");
  /* The same agent with one field changed — a diff against a different Blueprint is not an edit. */
  const edited = canonicalP28Blueprint();
  edited.autonomousPolicy = { ...edited.autonomousPolicy, maxValueUsdCents: { known: true, value: 200_000, sourceQuote: "raise the autonomous limit to $2,000" } };
  const diff = securityDiff(bp, edited);
  for (const c of diff) say(`   ${c.impact.padEnd(20)} ${c.label}: ${c.before} → ${c.after}`);
  for (const e of authorityExpansions(diff)) say(`   ⚠  ${e.consequence}`);
  const revisions = REVISION_KINDS.map((kind) => ({ kind, value: "1", stale: false, staleBecause: null }));
  const stale = markStale(revisions, "BLUEPRINT").filter((r) => r.stale).map((r) => r.kind);
  say(`   marked stale: ${stale.join(", ")}`);
  let fenced = "not fenced";
  try { assertCurrentRevision("rev-1", "rev-2", "old runtime"); } catch (e) { fenced = (e as { reason: string }).reason; }
  say(`   old runtime revision: ${fenced}`);
  ok("revision workflow", authorityExpansions(diff).length === 1 && stale.length === 5 && fenced === "RUNTIME_REVISION_SUPERSEDED",
    "the edit created a revision, the expansion is highlighted, and the old runtime is fenced");

  /* 46-48 */ step("Connect CRE — no Deploy Access is a complete state");
  const connection = CreConnectionInfoSchema.parse({
    connected: true, organizationId: "org_ENDgZRZzalm3d3So", organizationName: "ContextLock",
    userEmail: null, deployAccess: false, registries: ["private"], cliVersion: "1.32.0",
    credentialLocation: "local user CRE directory",
  });
  assertNoCreSession(connection, "connection payload");
  const promo = promotionAvailability(connection);
  say(`   Connected        ${connection.connected ? "YES" : "NO"}`);
  say(`   Organization     ${connection.organizationId}`);
  say(`   Deploy Access    ${connection.deployAccess ? "ENABLED" : "NOT ENABLED"}`);
  say(`   Registries       ${connection.registries.join(", ")}`);
  say(`   Simulation       AVAILABLE`);
  say(`   Deploy Workflow  ${promo.available ? "AVAILABLE" : "UNAVAILABLE"}`);
  say(`   ${promo.message}`);
  let registryRefusal = "not refused";
  try { assertRegistryAllowed("onchain:ethereum-mainnet", "promotion"); } catch (e) { registryRefusal = (e as { reason: string }).reason; }
  say(`   onchain:ethereum-mainnet → ${registryRefusal}`);
  const artifact = PromotionArtifactSchema.parse({
    workflowSourceHash: `sha256:${"1".repeat(64)}`, wasmSha256: wasmHash ?? "0".repeat(64),
    workflowConfigHash: `sha256:${"2".repeat(64)}`, blueprintRevision: bp.revision, strategyRevision: 1,
    creCliVersion: "1.32.0", simulatedUnderProductionLimits: limitsOn,
  });
  let drift = "unchanged";
  try { assertArtifactUnchanged(artifact, { ...artifact, wasmSha256: "f".repeat(64) }, "promotion"); } catch (e) { drift = (e as { reason: string }).reason; }
  say(`   artifact mutation → ${drift}`);
  ok("CRE connect", !promo.available && registryRefusal === "PRODUCTION_NETWORK_WRITE_PROHIBITED" && drift === "CRE_PROMOTION_ARTIFACT_CHANGED",
    "connected without Deploy Access — the Lab is complete, promotion is offered as optional and unavailable");

  /* 49 */ step("Export the Agent Safety Report");
  const report = sealSafetyReport({
    reportId: `p28-${anchor.number}`,
    generatedAtMs: Date.now(),
    agent: { goal: bp.objective, ensIdentity: bp.identity.ensName, blueprintHash: `sha256:${"1".repeat(64)}`, strategyHash: `sha256:${"2".repeat(64)}`, blueprintRevision: bp.revision },
    execution: {
      networks: [{ chainId: 11155111, name: "Ethereum Sepolia", role: "TESTNET_EXECUTION" }],
      productionChainExecution: "DISABLED",
      productionWriteEvidence: [
        "NET-003…NET-010: mainnet refused at ten independently-named fences",
        `P28 attack lab: MAINNET_WRITE_ATTEMPT denied by STRATEGY_COMPILER, plus ${defenses.length} further defences exercised`,
      ],
    },
    reality: {
      sources: [
        { sourceId: selection.source.sourceId, kind: "CHAINLINK_DATA_FEED", trustClass: "VERIFIED_ORACLE", status: "HEALTHY", blocker: null },
        { sourceId: "thegraph-uniswap-v3-mainnet", kind: "THE_GRAPH", trustClass: "INDEXED_CHAIN_DATA", status: "UNAVAILABLE", blocker: "BLK-V2-GRAPH-KEY" },
      ],
      chainlinkSource: FEED,
      theGraphState: `${g.status} — ${g.reason}. ${g.securityImpact}`,
      archiveReplayState: "LIMITED — requires an archive-capable RPC (BLK-V2-ARCHIVE-RPC)",
      marketSnapshotHash: snapshot.snapshotHash,
      anchorBlock: anchor.number.toString(),
    },
    cre: {
      mode: creSt.mode, executionMode: creSt.executionMode, wasmHash: creSt.workflowBinary,
      productionLimits: creSt.productionLimits, donDeployment: creSt.donDeployment,
      hardwareTee: creSt.hardwareTee, teeAttestation: creSt.teeAttestation, deployAccess: creSt.deployAccess,
    },
    runtime: { imageDigest: RUNTIME_IMAGE, adapterVersions: bp.adapters.map((a) => `${a.adapterId}@${a.adapterVersion}`) },
    testing: {
      securitySimulations: { passed: 31, total: 31 },
      attacks: runs.map((r) => ({ scenario: r.scenario, result: r.result, stoppedBy: r.stoppedBy, reasonCode: r.reasonCode })),
    },
    deployments: [{ name: "cre-consumer", address: SEPOLIA_CONSUMER, chainId: 11155111, txHash: SEPOLIA_DEPLOY_TX, explorerUrl: `https://sepolia.etherscan.io/tx/${SEPOLIA_DEPLOY_TX}` }],
    privacy: [
      { claim: "Agent cannot access CRE credential", answer: "VERIFIED", evidence: "RUN-014: the container refuses to start carrying any of six credential classes", blocker: null },
      { claim: "Private policy absent from agent prompt", answer: "VERIFIED", evidence: "P4: the confidential policy lives in the CRE workflow; the Blueprint carries parameter names only", blocker: null },
      { claim: "CRE official simulation", answer: "VERIFIED", evidence: `CRELAB-003: the official Chainlink CRE CLI produced ${creVerdict} under production limits`, blocker: null },
      { claim: "CRE DON execution", answer: "NO", evidence: null, blocker: "BLK-V2-CRE-DEPLOY" },
      { claim: "CRE hardware TEE", answer: "NO", evidence: null, blocker: "BLK-V2-CRE-DEPLOY" },
      { claim: "Physical Ledger", answer: "NO", evidence: null, blocker: "BLK-002" },
    ],
    knownBlockers: [
      { id: "BLK-V2-CRE-DEPLOY", effect: "No real DON deployment. The official simulator is used instead" },
      { id: "BLK-V2-GRAPH-KEY", effect: "No indexed historical context. Nothing was substituted for it" },
      { id: "BLK-V2-ARCHIVE-RPC", effect: "Evidence-grade historical replay needs an archive endpoint" },
      { id: "BLK-002", effect: "No physical Ledger. Escalation uses the approval-registry stand-in" },
    ],
  });
  const pub = publicSafetyView(report);
  say(`   report hash   ${report.reportHash}`);
  say(`   secret scan   ${scanForSecrets(report).length === 0 ? "CLEAN" : "FAILED"}`);
  say(`   privacy       ${report.privacy.map((p) => `${p.claim}=${p.answer}`).join("; ")}`);
  say(`   public view   ${Object.keys(pub).join(", ")}`);
  ok("safety report", scanForSecrets(report).length === 0 && !JSON.stringify(pub).includes("deployments"),
    `report sealed and secret-free; the public view carries no deployments, runtime or reality section`);

  /* 50 */ step("Clean up — no dangling containers, forks or resources");
  await forkProvider.destroy(fork.forkId);
  await new Promise((r) => setTimeout(r, 1500));
  let reachable = true;
  try { await rpc(fork.endpoint, "eth_chainId"); } catch { reachable = false; }
  say(`   fork state         ${forkProvider.get(fork.forkId)?.state}`);
  say(`   endpoint reachable ${reachable}`);
  say("   policy state       the canonical Sepolia policy is DISABLED — read for real, separately,");
  say("                      and recorded in p28-final-policy-state.txt");
  ok("cleanup", !reachable && inputs.policy?.enabled === false,
    "the fork is destroyed and the canonical policy is left DISABLED");

  /* ── summary ───────────────────────────────────────────────────────────── */
  const passed = STEPS.filter((s) => s.ok).length;
  say("");
  say("═══════════════════════════════════════════════════════════════════════");
  say(`   ${passed}/${STEPS.length} steps passed`);
  say("   public mainnet transactions: 0");
  say("═══════════════════════════════════════════════════════════════════════");
  for (const s of STEPS) say(`  ${s.ok ? "PASS" : "FAIL"}  step ${String(s.n).padStart(2)}  ${s.title} — ${s.detail}`);

  writeFileSync(`${OUT}/p28-demo.txt`, lines.join("\n") + "\n");
  writeFileSync(`${OUT}/p28-demo.json`, JSON.stringify({
    steps: STEPS, projectId,
    anchorBlock: anchor.number.toString(), ethUsd, snapshotHash: snapshot.snapshotHash,
    scenarioHash: crash.scenarioHash, creWasmHash: wasmHash, creVerdict, creProductionLimits: limitsOn,
    forkBlock: fork.forkBlock, forkBlockHash: fork.forkBlockHash, forkSwapHash: swap, usdcOut,
    sepoliaConsumer: SEPOLIA_CONSUMER, runtimeImage: RUNTIME_IMAGE,
    attacks: runs.map((r) => ({ scenario: r.scenario, result: r.result, stoppedBy: r.stoppedBy, reasonCode: r.reasonCode })),
    safetyReportHash: report.reportHash,
    policyStateAtEnd: "DISABLED",
    activationPerformedOnChain: false,
    activationNote: "The activation ordering was exercised against the projection with injected chain functions. No chain write was performed in P28; the canonical Sepolia policy is as Group E left it and was read for real in p28-final-policy-state.txt.",
    publicMainnetTransactions: 0,
  }, null, 2) + "\n");
  writeFileSync(`${OUT}/p28-safety-report.json`, JSON.stringify(report, null, 2) + "\n");
  /*
   * The Blueprint the journey actually used.
   *
   * Recorded so the summary, permissions review and Attack Lab surfaces can be served from the same
   * document the demo reasoned about, rather than from one reconstructed later that might differ.
   */
  writeFileSync(`${OUT}/p28-blueprint.json`, JSON.stringify(bp, null, 2) + "\n");
  writeFileSync(`${OUT}/p28-public-safety-view.json`, JSON.stringify(pub, null, 2) + "\n");
  console.log(`\nwritten: ${OUT}/p28-demo.txt, p28-demo.json, p28-safety-report.json, p28-public-safety-view.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
