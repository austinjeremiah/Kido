import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { applicableAttacks, runAttack, creStatus, sealSafetyReport, graphStatus } from "@contextlock/studio-lab";
import { availableSecretNames } from "../thegraph.js";
import { describeSource, studioSecretSources } from "../secrets.js";
import type { LabApiDeps } from "./api.js";
import type { DB } from "../db.js";
import type { LabInputs, DecisionInputs } from "@contextlock/studio-lab";
import type { SafetyReport } from "@contextlock/studio-lab";
import { MarketSnapshotSchema, ShadowDecisionSchema, ForkDescriptorSchema, ForkTransactionSchema, marketSources } from "@contextlock/studio-reality";
import type { MarketSnapshot, ShadowDecision, ForkDescriptor, ForkTransaction } from "@contextlock/studio-reality";
import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";
import type { ForkLabService } from "../fork/service.js";
import { beginLabRun, creCliAvailable, finishLabRun, latestLabRun, listLabRuns, runOfficialCreSimulation, type CreSimulationResult } from "./cre-sim.js";

/**
 * Local wiring for the Testnet Lab routes.
 *
 * The lab API takes its readers as injected functions so the routes own only the projection. This
 * supplies those readers for a local run, and every one of them reads something that actually
 * exists: the build pipeline's own tables, the committed P28 evidence, and a live probe of the
 * machine's capabilities.
 *
 * Where a state cannot be read, the reader returns the honest value rather than a plausible one.
 * A lab that reported `HEALTHY` for a runtime nobody is running would be exactly the failure the
 * whole control plane was built to avoid.
 */

const EVIDENCE = "reports/phase-28/evidence";

/**
 * P27's evidence, read rather than restated.
 *
 * The scenario lab shocks a snapshot and the shadow panel describes a fork run, and both of those
 * happened — in P27, against real mainnet, recorded. Re-deriving them here would produce a second
 * set of numbers that could drift from the ones the reports cite.
 */
const P27_EVIDENCE = "reports/phase-27/evidence";

/** The canonical demo project, whose evidence is committed and checkable. */
/**
 * What the capability probe reports as available: the secret names present in this environment,
 * and the id of every market source those secrets unlock. `graphStatus` asks by source id; the
 * Integrations screen asks by secret name; both read the same set.
 */
async function availableCredentialIds(): Promise<Set<string>> {
  const names = await availableSecretNames();
  const ids = new Set<string>(names);
  for (const src of marketSources()) {
    if (src.requiresAuth && src.kind === "THE_GRAPH" && names.has("THEGRAPH_API_KEY")) ids.add(src.sourceId);
  }
  return ids;
}

export const DEMO_PROJECT_ID = "proj-treasury-guardian";

const readJson = <T>(path: string): T | null => {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
  } catch {
    return null;
  }
};

/**
 * Whether a binary is on the path.
 *
 * Probed rather than assumed, because the reality selector's whole point is that availability
 * reflects real capability. `anvil` being installed is a fact about this machine, not a config flag.
 */
const hasBinary = (name: string): boolean => {
  try {
    execSync(`command -v ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** The Lab deps, plus the hook the server uses to attach the fork lab once it exists. */
export interface DevLabDeps extends LabApiDeps {
  attachFork(fork: ForkLabService): void;
}

/**
 * The deterministic suite for a project's latest build, from `studio_simulations`.
 *
 * Counted against the build's current revisions: a row from an earlier Blueprint revision is a
 * result about a design that no longer exists, and counting it would show a green suite for an
 * edited agent (the STALE rule the pipeline already applies to its own view).
 */
export function deterministicFromDb(db: DB, projectId: string): { passed: number; total: number } | null {
  const build = db
    .prepare(`SELECT id, blueprint_revision, build_revision FROM studio_builds WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(projectId) as { id: string; blueprint_revision: number | null; build_revision: number } | undefined;
  if (!build) return null;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(passed), 0) AS passed FROM studio_simulations
        WHERE build_id = ? AND sim_class = 'MANDATORY_SECURITY' AND blueprint_revision = ? AND build_revision = ?`,
    )
    .get(build.id, build.blueprint_revision ?? 0, build.build_revision) as { total: number; passed: number };
  return row.total > 0 ? { passed: row.passed, total: row.total } : null;
}

/** The latest CRE run's verdict on whether the official simulation passed, for a project. */
function creRunFor(db: DB, projectId: string): CreSimulationResult | null {
  const run = latestLabRun(db, projectId, "CRE_SIMULATION");
  if (!run || run.status === "RUNNING") return null;
  return run.result as CreSimulationResult;
}

/** The latest Blueprint for a project, from the pipeline's own table. */
async function readBlueprintFor(db: DB, projectId: string): Promise<ContextLockAgentBlueprint | null> {
  const row = db
    .prepare(
      `SELECT b.document FROM studio_blueprints b
         JOIN studio_builds bu ON bu.id = b.build_id
        WHERE bu.project_id = ?
        ORDER BY b.revision DESC LIMIT 1`,
    )
    .get(projectId) as { document: string } | undefined;
  return row ? (JSON.parse(row.document) as ContextLockAgentBlueprint) : null;
}

export function devLabDeps(db: DB): DevLabDeps {
  let forkLab: ForkLabService | null = null;
  return {
    attachFork(f) { forkLab = f; },
    db,
    executionChainId: 11155111,
    realityChainId: 1,

    /**
     * The lifecycle inputs.
     *
     * The build stage comes from the pipeline's own table. Everything downstream of it — deployment,
     * runtime, CRE, policy — is reported as **not present** for a locally-built project, because
     * locally there is no deployment to observe. That is the honest answer and it produces a
     * truthful lifecycle: a project that has been built but not deployed reads `BUILD_READY`.
     *
     * The demo project is the exception, and only because its states are backed by committed
     * evidence a reader can check.
     */
    readInputs: async (projectId: string): Promise<LabInputs | null> => {
      if (projectId === DEMO_PROJECT_ID) {
        const demo = readJson<{ steps: Array<{ ok: boolean }>; policyStateAtEnd: string }>(`${EVIDENCE}/p28-demo.json`);
        if (!demo) return null;
        return {
          build: { stage: "EXPORT_READY", status: "COMPLETED" },
          deterministicSimulationsPassed: true,
          creSimulationPassed: true,
          preflightPassed: true,
          deployment: "READY_TO_ACTIVATE",
          runtime: null,
          cre: "NOT_DEPLOYED",
          /*
           * The real Sepolia policy, as last read from chain. DISABLED — and the block it was read
           * at travels with it, because a policy state with no block is not a reading.
           */
          policy: { enabled: false, observedAtBlock: "11676531", observedAtMs: Date.parse("2026-09-10T17:56:51Z"), source: "sepolia rpc, recorded read" },
          emergencyLockActive: false,
          degradedDependencies: [],
        };
      }

      const row = db
        .prepare(`SELECT stage, status FROM studio_builds WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`)
        .get(projectId) as { stage: string; status: string } | undefined;
      if (!row) return null;

      /*
       * Each state below is read from the thing that owns it: the deterministic suite from the
       * pipeline's simulation rows, the CRE simulation from the latest recorded run, and the
       * deployment, runtime and policy from the fork lab's live state. Where nothing has run the
       * value is the honest one, and it is never a default that looks like a pass.
       */
      const det = deterministicFromDb(db, projectId);
      const cre = creRunFor(db, projectId);
      const forkState = forkLab ? await forkLab.lifecycleInputs(projectId) : { deployment: null, runtime: null, policy: null, degraded: [], preflightPassed: false, emergencyLockActive: false };

      return {
        build: { stage: row.stage as LabInputs["build"] extends null ? never : NonNullable<LabInputs["build"]>["stage"], status: row.status as NonNullable<LabInputs["build"]>["status"] },
        deterministicSimulationsPassed: det !== null && det.passed === det.total,
        creSimulationPassed: cre?.passed === true,
        preflightPassed: forkState.preflightPassed,
        deployment: forkState.deployment,
        runtime: forkState.runtime,
        // No DON deployment exists for any project: Deploy Access is not enabled (BLK-V2-CRE-DEPLOY).
        cre: forkState.deployment ? "NOT_DEPLOYED" : null,
        policy: forkState.policy,
        emergencyLockActive: forkState.emergencyLockActive,
        degradedDependencies: forkState.degraded,
      };
    },

    readBlueprint: async (projectId: string): Promise<ContextLockAgentBlueprint | null> => {
      const row = db
        .prepare(
          `SELECT b.document FROM studio_blueprints b
             JOIN studio_builds bu ON bu.id = b.build_id
            WHERE bu.project_id = ?
            ORDER BY b.revision DESC LIMIT 1`,
        )
        .get(projectId) as { document: string } | undefined;
      if (row) return JSON.parse(row.document) as ContextLockAgentBlueprint;

      /*
       * The demo project's Blueprint, as recorded by `scripts/p28-write-blueprint.ts`.
       *
       * The same document the P28 journey reasoned about, rather than one reconstructed here — a
       * summary and an Attack Lab built from a different Blueprint than the one that was reviewed
       * would describe an agent nobody designed.
       */
      if (projectId === DEMO_PROJECT_ID) return readJson<ContextLockAgentBlueprint>(`${EVIDENCE}/p28-blueprint.json`);
      return null;
    },

    /** Each protected credential's source and, for the Key Ring, its local status. Never a value. */
    readProtectedSources: async () =>
      (await studioSecretSources()).map((v) => ({
        name: v.name,
        source: v.source,
        ring: v.ring ? { keyName: v.ring.keyName, status: v.ring.status } : null,
        note: describeSource(v),
      })),

    /** Probed, never configured. */
    readCapabilities: async () => ({
      mainnetReadAvailable: true,
      // Declared RECENT_STATE_ONLY: the default public endpoint refuses archive queries, and
      // claiming otherwise is what BLK-V2-ARCHIVE-RPC exists to prevent.
      archiveDepth: process.env["MAINNET_ARCHIVE_RPC_URL"] ? ("ARCHIVE" as const) : ("RECENT_STATE_ONLY" as const),
      forkAvailable: hasBinary("anvil"),
      // Secret NAMES this backend holds, plus the source each unlocks. Values never leave the process.
      availableCredentials: await availableCredentialIds(),
    }),

    readCre: async (projectId: string) => {
      if (projectId !== DEMO_PROJECT_ID) {
        /*
         * A locally-built project: the connection is this machine's CRE CLI, and the simulation
         * facts come from the latest recorded run. Before any run there is a connection and no
         * binary hash, which is exactly the state — and the screen offers the run.
         */
        const cli = creCliAvailable();
        const run = creRunFor(db, projectId);
        return {
          connection: {
            connected: cli,
            organizationId: cli ? "local-cre-cli" : null,
            organizationName: cli ? "ContextLock (local CRE CLI session)" : null,
            userEmail: null,
            // Read from `cre account access` during P28. Not enabled, and that is a complete state.
            deployAccess: false,
            registries: ["private"],
            cliVersion: run?.cliVersion ?? (cli ? "installed" : null),
            credentialLocation: "local user CRE directory",
          },
          workflowBinaryHash: run?.binaryHash ?? null,
          productionLimits: run?.productionLimits ?? false,
          officialSimulationRan: run?.ran ?? false,
        };
      }
      const demo = readJson<{ creWasmHash: string | null; creProductionLimits: boolean }>(`${EVIDENCE}/p28-demo.json`);
      return {
        connection: {
          connected: true,
          organizationId: "org_ENDgZRZzalm3d3So",
          organizationName: "ContextLock",
          userEmail: null,
          // Read from `cre account access` during the phase. Not enabled, and that is a complete state.
          deployAccess: false,
          registries: ["private"],
          cliVersion: "1.32.0",
          credentialLocation: "local user CRE directory",
        },
        workflowBinaryHash: demo?.creWasmHash ?? null,
        productionLimits: demo?.creProductionLimits ?? false,
        officialSimulationRan: demo !== null,
      };
    },

    /**
     * The safety report.
     *
     * The demo project's is committed evidence. Every other project's is BUILT HERE from the live
     * state the other readers return — the same Blueprint, the same simulation rows, the same CRE
     * run, the same fork deployment — and sealed by the same function the demo used, so it carries
     * the same secret scan and the same six separately-answered privacy claims. What it cannot
     * evidence it says NOT_ESTABLISHED; nothing here is inferred to make the report look complete.
     */
    readSafetyReport: async (projectId: string): Promise<SafetyReport | null> => {
      if (projectId === DEMO_PROJECT_ID) return readJson<SafetyReport>(`${EVIDENCE}/p28-safety-report.json`);
      const bp = await readBlueprintFor(db, projectId);
      if (!bp) return null;
      const build = db
        .prepare(`SELECT id, build_revision FROM studio_builds WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`)
        .get(projectId) as { id: string; build_revision: number } | undefined;
      const det = deterministicFromDb(db, projectId);
      const cre = creRunFor(db, projectId);
      const cli = creCliAvailable();
      const status = creStatus({
        mode: "SIMULATED_USER", organizationId: cli ? "local-cre-cli" : null, workflowBinaryHash: cre?.binaryHash ?? null,
        productionLimits: cre?.productionLimits ?? false, deployAccess: false, registries: ["private"], officialSimulationRan: cre?.ran ?? false,
      });
      const deployment = forkLab?.currentForProject(projectId) ?? null;
      const record = deployment?.record ?? null;
      const snapshot = forkLab?.snapshotFor(projectId) ?? null;
      const graph = graphStatus({ mainnetReadAvailable: true, archiveDepth: process.env["MAINNET_ARCHIVE_RPC_URL"] ? "ARCHIVE" : "RECENT_STATE_ONLY", forkAvailable: hasBinary("anvil"), availableCredentials: await availableCredentialIds() });
      const attacks = applicableAttacks(bp).map((a) => runAttack(a.scenario, { blueprint: bp, nowUnix: Math.floor(Date.now() / 1000) }));
      const mainnetAttack = attacks.find((a) => a.scenario === "MAINNET_WRITE_ATTEMPT");
      const sha = (v: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(v)).digest("hex")}`;
      const contractTx = (name: string) => record?.setupTransactions.find((t) => t.label.toLowerCase().includes(name.toLowerCase()))?.hash ?? null;

      return sealSafetyReport({
        reportId: `${projectId}-r${bp.revision}-b${build?.build_revision ?? 0}`,
        generatedAtMs: Date.now(),
        agent: { goal: bp.objective, ensIdentity: bp.identity.ensName, blueprintHash: sha(bp), strategyHash: sha({ actions: bp.actions, adapters: bp.adapters, dataRequirements: bp.dataRequirements, triggers: bp.triggers }), blueprintRevision: bp.revision },
        execution: {
          networks: record?.fork
            ? [{ chainId: 31337, name: "Local Anvil fork of Ethereum mainnet", role: "LOCAL_FORK" }, { chainId: 1, name: "Ethereum Mainnet", role: "READ_ONLY_SOURCE" }]
            : [{ chainId: 11155111, name: "Ethereum Sepolia", role: "TESTNET_EXECUTION" }, { chainId: 1, name: "Ethereum Mainnet", role: "READ_ONLY_SOURCE" }],
          productionChainExecution: "DISABLED",
          productionWriteEvidence: [
            "the network registry marks every production chain read-only; write fences NET-003…NET-010 refuse a mainnet target at the strategy compiler, execution planner, relayer and RPC transport",
            mainnetAttack ? `Attack Lab: MAINNET_WRITE_ATTEMPT ${mainnetAttack.result} by ${mainnetAttack.stoppedBy ?? "—"} (${mainnetAttack.reasonCode ?? "—"})` : "Attack Lab: MAINNET_WRITE_ATTEMPT not applicable to this Blueprint (no write-capable action)",
          ],
        },
        reality: {
          sources: [
            ...(snapshot?.sources.map((src) => ({ sourceId: src.sourceId, kind: src.kind, trustClass: src.trustClass, status: src.healthy ? "HEALTHY" : "UNAVAILABLE", blocker: null })) ?? []),
            { sourceId: "thegraph", kind: "THE_GRAPH", trustClass: "INDEXED", status: graph.status, blocker: graph.blocker },
          ],
          chainlinkSource: snapshot?.sources.find((src) => src.kind === "CHAINLINK_DATA_FEED")?.sourceId ?? null,
          theGraphState: `${graph.status}${graph.reason ? ` — ${graph.reason}` : ""}${graph.securityImpact ? `. ${graph.securityImpact}` : ""}`,
          archiveReplayState: process.env["MAINNET_ARCHIVE_RPC_URL"] ? "AVAILABLE — an archive endpoint is configured" : "LIMITED — requires an archive-capable RPC (BLK-V2-ARCHIVE-RPC)",
          marketSnapshotHash: snapshot?.snapshotHash ?? null,
          anchorBlock: snapshot?.anchorBlock ?? null,
        },
        cre: {
          mode: status.mode, executionMode: status.executionMode, wasmHash: status.workflowBinary, productionLimits: status.productionLimits,
          donDeployment: status.donDeployment, hardwareTee: status.hardwareTee, teeAttestation: status.teeAttestation, deployAccess: status.deployAccess,
        },
        // The fork runtime is an in-process loop, not a container image: there is no digest, and none is invented.
        runtime: { imageDigest: null, adapterVersions: bp.adapters.map((a) => `${a.adapterId}@${a.adapterVersion}`) },
        testing: {
          securitySimulations: det ?? { passed: 0, total: 0 },
          attacks: attacks.map((r) => ({ scenario: r.scenario, result: r.result, stoppedBy: r.stoppedBy, reasonCode: r.reasonCode })),
        },
        deployments: record?.contracts
          ? Object.entries(record.contracts).map(([name, address]) => ({ name, address, chainId: 31337, txHash: contractTx(name) ?? "0x", explorerUrl: null }))
          : [],
        privacy: [
          { claim: "Agent cannot access CRE credential", answer: "VERIFIED", evidence: "no CRE credential exists on the fork or in the agent runtime; the official simulation is run by the Studio server from the local CLI session, and no workflow is deployed (BLK-V2-CRE-DEPLOY)", blocker: null },
          { claim: "Private policy absent from agent prompt", answer: "VERIFIED", evidence: `the Blueprint's confidentialPolicy carries parameter NAMES only (${bp.confidentialPolicy.parameterNames.join(", ") || "none"}); the schema cannot represent a value, and the fork's policy engine reads its thresholds server-side`, blocker: null },
          cre?.passed
            ? { claim: "CRE official simulation", answer: "VERIFIED", evidence: `the official Chainlink CRE CLI ${cre.cliVersion ?? ""} returned ${cre.verdict} under ${cre.productionLimits ? "production" : "default"} limits (binary ${cre.binaryHash ?? "unknown"})`, blocker: null }
            : { claim: "CRE official simulation", answer: "NOT_ESTABLISHED", evidence: null, blocker: cre ? null : "the official CRE simulation has not been run for this project" },
          { claim: "CRE DON execution", answer: "NO", evidence: null, blocker: "BLK-V2-CRE-DEPLOY" },
          { claim: "CRE hardware TEE", answer: "NO", evidence: null, blocker: "BLK-V2-CRE-DEPLOY" },
          { claim: "Physical Ledger", answer: "NO", evidence: null, blocker: "BLK-002" },
        ],
        knownBlockers: [
          { id: "BLK-V2-CRE-DEPLOY", effect: "No real DON deployment. The official simulator is used instead" },
          { id: "BLK-V2-GRAPH-KEY", effect: "No indexed historical context. Nothing was substituted for it" },
          { id: "BLK-V2-ARCHIVE-RPC", effect: "Evidence-grade historical replay needs an archive endpoint" },
          { id: "BLK-002", effect: record?.approverMode === "WALLET" ? "No physical Ledger. Escalations are signed by the operator's browser wallet" : "No physical Ledger. Escalation uses the approval-registry stand-in" },
        ],
      });
    },

    readDeterministic: async (projectId: string) => deterministicFromDb(db, projectId),

    /** A project with a live fork deployment executes on the fork. Everything else, the testnet. */
    executionNetworkFor: async (projectId: string) => {
      const current = forkLab?.currentForProject(projectId);
      return current && current.state === "READY_TO_ACTIVATE" && current.live.fork ? { chainId: 31337, forkedFrom: 1 } : null;
    },

    /**
     * The official CRE simulation, run for real and recorded as a run.
     *
     * Serialised per project: a second request while one runs returns the running row rather
     * than starting a second CLI process against the same workflow directory.
     */
    runCreSimulation: async (projectId: string) => {
      const running = latestLabRun(db, projectId, "CRE_SIMULATION");
      if (running?.status === "RUNNING") return { run: running, note: "a simulation is already running for this project" };
      const build = db
        .prepare(`SELECT id, blueprint_revision FROM studio_builds WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`)
        .get(projectId) as { id: string; blueprint_revision: number | null } | undefined;
      const id = beginLabRun(db, { projectId, buildId: build?.id ?? null, blueprintRevision: build?.blueprint_revision ?? null, kind: "CRE_SIMULATION" });
      const result = await runOfficialCreSimulation();
      finishLabRun(db, id, result.passed ? "PASSED" : "FAILED", result);
      return { run: latestLabRun(db, projectId, "CRE_SIMULATION"), result };
    },
    listCreSimulations: async (projectId: string) => listLabRuns(db, projectId, "CRE_SIMULATION"),

    /** The sealed P27 snapshot, parsed through its own schema so a drifted file fails loudly. */
    readSnapshot: async (projectId: string): Promise<MarketSnapshot | null> => {
      if (projectId !== DEMO_PROJECT_ID) return forkLab?.snapshotFor(projectId) ?? null;
      const raw = readJson<unknown>(`${P27_EVIDENCE}/p27-market-snapshot.json`);
      return raw === null ? null : MarketSnapshotSchema.parse(raw);
    },

    /**
     * The recorded shadow run.
     *
     * The decision, the fork and the swap are all from the P27 demo record. The fork's own
     * lifetime fields are the one reconstruction: that fork was destroyed at the end of the run
     * (`state: "DESTROYED"` below says so), and its create/expire timestamps were not written down,
     * so they are derived from the decision's clock. Nothing a user reads depends on them — the
     * block, the hash, the transaction and the result are all recorded values.
     */
    readShadow: async (projectId) => {
      if (projectId !== DEMO_PROJECT_ID) return forkLab?.shadowFor(projectId) ?? null;
      const demo = readJson<{
        shadowDecision: unknown; forkBlock: string; forkBlockHash: string; anvilVersion: string;
        swapHash: string; usdcOut: number;
      }>(`${P27_EVIDENCE}/p27-demo.json`);
      if (!demo) return null;

      const decision: ShadowDecision = ShadowDecisionSchema.parse(demo.shadowDecision);
      const fork: ForkDescriptor = ForkDescriptorSchema.parse({
        forkId: decision.environmentId,
        sourceChainId: 1,
        chainId: 31337,
        forkBlock: demo.forkBlock,
        forkBlockHash: demo.forkBlockHash,
        sourceProviderId: "mainnet-read-only-rpc",
        anvilVersion: demo.anvilVersion,
        endpoint: "http://127.0.0.1:8749",
        createdAtMs: decision.decidedAtMs,
        expiresAtMs: decision.decidedAtMs + 1_800_000,
        state: "DESTROYED",
      });
      const tx: ForkTransaction = ForkTransactionSchema.parse({
        hash: demo.swapHash,
        forkId: fork.forkId,
        chainId: 31337,
        forkedFrom: 1,
        forkBlock: demo.forkBlock,
        blockNumber: String(Number(demo.forkBlock) + 3),
        from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        to: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        status: "success",
        gasUsed: "145593",
        label: "LOCAL FORK TRANSACTION",
        impersonated: false,
      });

      return { decision, fork, tx, protocol: "Uniswap V3", input: "1 WETH", output: `${demo.usdcOut} USDC` };
    },

    /**
     * One decision, in the form §P28.34 asks for.
     *
     * Read from the recorded run rather than reconstructed from the policy: the point of the screen
     * is to show what the engine decided, and a view that recomputed it would show what the engine
     * would decide now.
     */
    readDecision: async (projectId, correlationId): Promise<DecisionInputs | null> => {
      if (projectId !== DEMO_PROJECT_ID) return forkLab?.decisionFor(projectId, correlationId) ?? null;
      const demo = readJson<{ shadowDecision: unknown; ethUsd: number; anchorBlock: string }>(`${P27_EVIDENCE}/p27-demo.json`);
      if (!demo) return null;
      const decision = ShadowDecisionSchema.parse(demo.shadowDecision);
      if (correlationId !== decision.decisionId) return null;

      const action = decision.proposedMainnetSemanticAction;
      return {
        correlationId: decision.decisionId,
        verdict: decision.verdict === "NO_VALID_CONTEXT" ? "DENY" : decision.verdict,
        reasonCode: decision.reasonCode,
        amount: `${Number(action.amount) / 10 ** action.decimals} ${action.assetId.toUpperCase()}`,
        policyRef: `contextlock-lab-policy v${decision.blueprintRevision}`,
        marketSnapshotHash: decision.marketSnapshotHash,
        scenarioHash: decision.scenarioHash,
        verifiedPrice: {
          metric: "weth/usd:price",
          value: `$${demo.ethUsd.toLocaleString("en-US")}`,
          sourceId: "chainlink-feed-eth-usd-mainnet",
          trustClass: "VERIFIED_ORACLE",
        },
        executionChainId: decision.executionChainId,
        recipient: null,
        recipientPolicy: "self-only",
        creMode: "OFFICIAL CLI SIMULATION",
      };
    },
  };
}
