import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";
import { validGuardian } from "../../studio-blueprint/test/fixtures.js";
import type { LabInputs } from "../src/lifecycle.js";
import type { SafetyReport } from "../src/safety-report.js";

/**
 * A real Blueprint, from the Blueprint package's own fixture.
 *
 * Deliberately not a hand-written object shaped like a Blueprint. A local fixture drifts from the
 * schema silently and then tests the drift — FND-V2-27-001 was that failure with an asset registry,
 * and reusing the canonical fixture is how this file avoids repeating it.
 */
export const guardian = (over: Partial<ContextLockAgentBlueprint> = {}): ContextLockAgentBlueprint => validGuardian(over);

/** The Treasury Guardian, with the canonical prompt's limits. */
export const treasuryGuardian = (): ContextLockAgentBlueprint =>
  guardian({
    objective: "Prevent liquidation of the Aave position and keep the treasury balanced",
    autonomousPolicy: { maxValueUsdCents: 100_000, allowedActionRefs: ["repay-debt"] },
    escalationPolicy: {
      minValueUsdCents: 100_000,
      maxValueUsdCents: 500_000,
      mechanism: "approval-registry-standin",
      denyIsTerminal: true,
    },
  });

/**
 * The canonical P28 agent, read from the recorded Blueprint.
 *
 * The same document the journey and the API serve, rather than one rebuilt here — a test that
 * asserted against a reconstruction would be checking the reconstruction.
 */
export const canonicalGuardian = (): ContextLockAgentBlueprint => {
  const path = new URL("../../../reports/phase-28/evidence/p28-blueprint.json", import.meta.url).pathname;
  return JSON.parse(readFileSync(path, "utf8")) as ContextLockAgentBlueprint;
};

/** A sealed-snapshot input carrying the metric the stock overlays act on. */
export const snapshotForOverlay = () => ({
  snapshotId: "lab-overlay-base",
  mode: "LIVE_MIRROR" as const,
  observedAtMs: 1_789_057_607_000,
  anchorChainId: 1,
  anchorBlock: "25948176",
  anchorBlockHash: "0x681b99ef550b9a9b141cd47f92c4c3ba40a08c037eecabeea58c1e19c9e67bbd",
  anchorBlockTimestampMs: 1_789_057_607_000,
  sources: [{
    sourceId: "chainlink-feed-eth-usd-mainnet", kind: "CHAINLINK_DATA_FEED" as const,
    adapterId: "chainlink-data-feeds", adapterVersion: "1.0.0", trustClass: "VERIFIED_ORACLE" as const,
    sourceChainId: 1, timeSupport: "BLOCK_SCOPED" as const, observedBlock: "25948176",
    lagBlocks: 0, healthy: true, detail: null,
  }],
  observations: [{
    observationId: "obs-price", metric: "weth/usd:price", value: "243442066354", decimals: 8,
    unit: "USD", dataType: "PRICE" as const, canonicalAssetId: "weth",
    sourceId: "chainlink-feed-eth-usd-mainnet", sourceChainId: 1, blockNumber: "25948176",
    sourceTimestampMs: 1_789_057_583_000, retrievedAtMs: 1_789_057_607_000,
    trustClass: "VERIFIED_ORACLE" as const, adapterId: "chainlink-data-feeds", adapterVersion: "1.0.0",
    derivedFrom: null, provenance: "Chainlink ETH/USD aggregator",
  }],
  provenance: ["lab overlay fixture, built from the real P27 reading"],
  nowMs: 1_789_057_607_000,
  maxTimeSkewMs: 5_400_000,
  maxSourceAgeMs: 5_400_000,
});

/* ─────────────────────────── lifecycle inputs ─────────────────────────── */

/**
 * A complete set of lifecycle inputs.
 *
 * Every field is supplied. A partial fixture with defaults would let a test pass because a field it
 * meant to set was silently defaulted to the value it was asserting — so the base is explicit and
 * each test overrides exactly what it is about.
 */
export const labInputs = (over: Partial<LabInputs> = {}): LabInputs => ({
  build: { stage: "EXPORT_READY", status: "COMPLETED" },
  deterministicSimulationsPassed: true,
  creSimulationPassed: true,
  preflightPassed: true,
  deployment: "READY_TO_ACTIVATE",
  runtime: "HEALTHY",
  cre: "NOT_DEPLOYED",
  policy: { enabled: false, observedAtBlock: "11674967", observedAtMs: 1_789_057_607_000, source: "sepolia rpc" },
  emergencyLockActive: false,
  degradedDependencies: [],
  ...over,
});

/** An active lab: policy enabled, everything healthy. */
export const activeLab = (over: Partial<LabInputs> = {}): LabInputs =>
  labInputs({
    policy: { enabled: true, observedAtBlock: "11674970", observedAtMs: 1_789_057_620_000, source: "sepolia rpc" },
    ...over,
  });

/* ─────────────────────────── safety report ─────────────────────────── */

export const privacyClaims = (): SafetyReport["privacy"] => [
  { claim: "Agent cannot access CRE credential", answer: "VERIFIED", evidence: "RUN-014: the container refuses to start carrying any of six credential classes", blocker: null },
  { claim: "Private policy absent from agent prompt", answer: "VERIFIED", evidence: "P4: the confidential policy lives in the CRE workflow; the Blueprint carries parameter names only", blocker: null },
  { claim: "CRE official simulation", answer: "VERIFIED", evidence: "CRELAB-003-LIVE: the official Chainlink CRE CLI ran against a real Sepolia event under production limits", blocker: null },
  { claim: "CRE DON execution", answer: "NO", evidence: null, blocker: "BLK-V2-CRE-DEPLOY" },
  { claim: "CRE hardware TEE", answer: "NO", evidence: null, blocker: "BLK-V2-CRE-DEPLOY" },
  { claim: "Physical Ledger", answer: "NO", evidence: null, blocker: "BLK-002" },
];

export const safetyReportInput = (over: Partial<Omit<SafetyReport, "reportHash" | "schemaVersion">> = {}): Omit<SafetyReport, "reportHash" | "schemaVersion"> => ({
  reportId: "report-test-1",
  generatedAtMs: 1_789_057_607_000,
  agent: {
    goal: "Prevent liquidation of the Aave position",
    ensIdentity: "guardian.contextlock.eth",
    blueprintHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    strategyHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    blueprintRevision: 3,
  },
  execution: {
    networks: [{ chainId: 11155111, name: "Ethereum Sepolia", role: "TESTNET_EXECUTION" }],
    productionChainExecution: "DISABLED",
    productionWriteEvidence: [
      "NET-003…NET-010: mainnet refused at ten independently-named fences",
      "REALITY-005: write methods refused on the read transport",
    ],
  },
  reality: {
    sources: [
      { sourceId: "chainlink-feed-eth-usd-mainnet", kind: "CHAINLINK_DATA_FEED", trustClass: "VERIFIED_ORACLE", status: "HEALTHY", blocker: null },
      { sourceId: "thegraph-uniswap-v3-mainnet", kind: "THE_GRAPH", trustClass: "INDEXED_CHAIN_DATA", status: "UNAVAILABLE", blocker: "BLK-V2-GRAPH-KEY" },
    ],
    chainlinkSource: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    theGraphState: "UNAVAILABLE — API authentication required (BLK-V2-GRAPH-KEY). No fallback substitution occurred",
    archiveReplayState: "LIMITED — requires an archive-capable RPC (BLK-V2-ARCHIVE-RPC)",
    marketSnapshotHash: "sha256:5b392cffacbac05207c09ccac81d169b8f022ed7c34597391448bd5a48437244",
    anchorBlock: "25948265",
  },
  cre: {
    mode: "OFFICIAL CLI SIMULATION",
    executionMode: "SIMULATED_USER",
    wasmHash: "800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0",
    productionLimits: "ENABLED",
    donDeployment: "NO",
    hardwareTee: "NO",
    teeAttestation: "NO",
    deployAccess: "NOT_ENABLED",
  },
  runtime: { imageDigest: "sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5", adapterVersions: ["aave-v3-state@1.4.0", "chainlink-data-feeds@1.0.0"] },
  testing: {
    securitySimulations: { passed: 31, total: 31 },
    attacks: [{ scenario: "MAINNET_WRITE_ATTEMPT", result: "DENIED", stoppedBy: "STRATEGY_COMPILER", reasonCode: "PRODUCTION_NETWORK_WRITE_PROHIBITED" }],
  },
  deployments: [
    {
      name: "cre-consumer",
      address: "0xf8a3b4bf44975a2d4b3fb7a099b80db7620ad2ca",
      chainId: 11155111,
      txHash: "0xb33a7366f763ca6ec6bd889eef3599c6de69d0f5e0a9bf6ed1fafadb2c81fc0c",
      explorerUrl: "https://sepolia.etherscan.io/tx/0xb33a7366f763ca6ec6bd889eef3599c6de69d0f5e0a9bf6ed1fafadb2c81fc0c",
    },
  ],
  privacy: privacyClaims(),
  knownBlockers: [
    { id: "BLK-V2-CRE-DEPLOY", effect: "No real DON deployment. The official simulator is used instead" },
    { id: "BLK-V2-GRAPH-KEY", effect: "No indexed historical context. Nothing was substituted for it" },
  ],
  ...over,
});

/* ─────────────────────────── source scanning ─────────────────────────── */

/**
 * The repository root, from this file rather than from `process.cwd()`.
 *
 * FND-V2-26-001: `process.cwd()` differs between a root run and a per-package run, so a scan keyed
 * on it searches a directory that does not exist and passes by finding nothing.
 */
export const repoRoot = (): string => {
  const root = new URL("../../../", import.meta.url).pathname;
  if (!existsSync(`${root}packages`) || !existsSync(`${root}apps`)) {
    throw new Error(`source scan resolved ${root}, which is not the repository root`);
  }
  return root;
};

export interface SourceLine { file: string; line: number; text: string }

export const sourceLines = (pattern: RegExp, dirs = "packages apps scripts"): SourceLine[] => {
  const out = execSync(
    // `.next` is the frontend's build cache: megabytes of bundled dependencies, not our source.
    `grep -rn --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next ${JSON.stringify(pattern.source)} ${dirs} 2>/dev/null || true`,
    { cwd: repoRoot(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const m = /^([^:]+):(\d+):(.*)$/.exec(l);
      return m ? { file: m[1] as string, line: Number(m[2]), text: m[3] as string } : null;
    })
    .filter((x): x is SourceLine => x !== null)
    .filter((x) => !x.file.includes("node_modules") && !x.file.includes("/test/") && !x.file.endsWith(".test.ts"));
};

export const isComment = (text: string): boolean => /^\s*(\/\/|\/\*|\*|#)/.test(text);
