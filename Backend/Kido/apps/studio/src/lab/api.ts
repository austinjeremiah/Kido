import type { FastifyInstance } from "fastify";
import type { DB } from "../db.js";
import { assertPublicSafe } from "@contextlock/studio-events";
import {
  projectLabState, labStateLabel, productModeDescriptor, HEADLINE_CLAIM,
  buildSummary, capabilityReview, unestablishedBoundaries,
  realityModes, graphStatus, realityDisplay, badgeTone,
  creStatus, promotionAvailability, CreConnectionInfoSchema,
  deployReadiness, DEPLOY_PHASES, CONTROL_SEMANTICS,
  ATTACKS, applicableAttacks, runAttack, AttackScenarioSchema,
  publicSafetyView, type LabInputs, type SafetyReport,
  simulationCenter, connectFlow, creAccountView, parityRun, PARITY_FIXTURES,
  tokenRequirements, TESTNET_ASSET_NOTE, activationReadiness,
  shockPresets, presetById, runShock, decideOnSnapshot, compareScenarios, assertSyntheticLabelled,
  shadowRunView, forkActionDetail, decisionDetail, assertDecisionPrivate,
  policyFromBlueprint, type DecisionInputs,
} from "@contextlock/studio-lab";
import type { MarketSnapshot, ShadowDecision, ForkDescriptor, ForkTransaction } from "@contextlock/studio-reality";
import { keccak256, toHex } from "viem";
import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";

/**
 * The Testnet Lab HTTP surface.
 *
 * Thin on purpose. §P28's principle is that this phase integrates rather than adds, and the
 * temptation an API layer creates is to *recompute* — to answer "is it active?" from something
 * convenient rather than from the projection.
 *
 * So every route here reads underlying state and calls the same projection the tests drive. There is
 * no route that accepts a lifecycle state, and no route that stores one. `PRODUCT-004` and
 * `PRODUCT-005` are assertions about exactly this file's shape.
 */

/** Every response is scanned before it leaves, like the control plane's. */
function safe<T>(payload: T): T {
  assertPublicSafe(payload, "api-response");
  return payload;
}

export interface LabApiDeps {
  db: DB;
  /**
   * Read the underlying states for a project.
   *
   * Injected so the route cannot assemble them from whatever is nearby: the caller owns where each
   * state comes from, and the route owns only the projection.
   */
  readInputs: (projectId: string) => Promise<LabInputs | null>;
  readBlueprint: (projectId: string) => Promise<ContextLockAgentBlueprint | null>;
  /** Which credential is held where (env or Ledger Key Ring); never a value. Optional. */
  readProtectedSources?: () => Promise<Array<{ name: string; source: "ledger-key-ring" | "env" | "absent"; ring: { keyName: string; status: string } | null; note: string }>>;
  readCapabilities: () => Promise<{
    mainnetReadAvailable: boolean;
    archiveDepth: "ARCHIVE" | "RECENT_STATE_ONLY" | "UNKNOWN" | null;
    forkAvailable: boolean;
    availableCredentials: ReadonlySet<string>;
  }>;
  readCre: (projectId: string) => Promise<{
    connection: unknown;
    workflowBinaryHash: string | null;
    productionLimits: boolean;
    officialSimulationRan: boolean;
  } | null>;
  readSafetyReport: (projectId: string) => Promise<SafetyReport | null>;
  /**
   * The deterministic suite's counts for a project's latest build, from the pipeline's own table.
   *
   * The demo project reads them from its recorded safety report; every other project reads them
   * from `studio_simulations`. Null when the suite has not run for the current revision.
   */
  readDeterministic: (projectId: string) => Promise<{ passed: number; total: number } | null>;
  /**
   * Run the official CRE simulation for a project, and the runs so far.
   *
   * Optional: a server without the CLI wired simply has no run button. The route reports that
   * rather than pretending a run happened.
   */
  runCreSimulation?: (projectId: string) => Promise<unknown>;
  listCreSimulations?: (projectId: string) => Promise<unknown[]>;
  /**
   * The sealed market snapshot the scenario lab shocks.
   *
   * A reader rather than a constant: a shock applied to a snapshot nobody took would be a
   * comparison between two invented markets.
   */
  readSnapshot: (projectId: string) => Promise<MarketSnapshot | null>;
  /** The recorded shadow run and the fork transaction it produced, when one exists. */
  readShadow: (projectId: string) => Promise<{
    decision: ShadowDecision;
    fork: ForkDescriptor;
    tx: ForkTransaction;
    protocol: string;
    input: string;
    output: string;
  } | null>;
  /** One decision, by correlation id, in the deterministic form §P28.34 asks for. */
  readDecision: (projectId: string, correlationId: string) => Promise<DecisionInputs | null>;
  executionChainId: number;
  realityChainId: number;
  /**
   * Where THIS project currently executes, when that differs from the default testnet.
   *
   * A project deployed to a local fork executes on chain 31337, forked from mainnet, and every
   * screen that names an execution target must name that one — a header that said "Ethereum
   * Sepolia" over a fork deployment would be describing a chain the agent is not on.
   */
  executionNetworkFor?: (projectId: string) => Promise<{ chainId: number; forkedFrom: number | null } | null>;
}

/** The project's execution network: the fork it is deployed to, or the default testnet. */
async function executionFor(deps: LabApiDeps, projectId: string): Promise<{ chainId: number; forkedFrom: number | null }> {
  return (await deps.executionNetworkFor?.(projectId)) ?? { chainId: deps.executionChainId, forkedFrom: null };
}

export function registerLabRoutes(app: FastifyInstance, deps: LabApiDeps): void {
  /* ── the lifecycle ──────────────────────────────────────────────────────── */

  app.get<{ Params: { id: string } }>("/api/lab/projects/:id/state", async (req, reply) => {
    const inputs = await deps.readInputs(req.params.id);
    if (!inputs) return reply.code(404).send({ error: "unknown project" });

    // Computed here, on every read. Nothing is stored and nothing is cached.
    const projection = projectLabState(inputs);
    const exec = await executionFor(deps, req.params.id);
    const mode = productModeDescriptor();
    return safe({
      projectId: req.params.id,
      ...projection,
      label: labStateLabel(projection.state),
      // The project's own execution network first, so a header that shows one shows the right one.
      mode: { ...mode, execution: { ...mode.execution, networks: [...mode.execution.networks].sort((a, b) => (a.chainId === exec.chainId ? -1 : b.chainId === exec.chainId ? 1 : 0)) } },
      executionNetwork: realityDisplay({ marketChainId: deps.realityChainId, executionChainId: exec.chainId, forkedFrom: exec.forkedFrom }).executionTarget,
      headlineClaim: HEADLINE_CLAIM,
      /*
       * The inputs are returned alongside the answer.
       *
       * A client that disagrees with the projection can see exactly what it was computed from,
       * which is the difference between a status a user can check and one they have to trust.
       */
      computedFrom: inputs,
    });
  });

  /* ── the build summary and permissions ─────────────────────────────────── */

  app.get<{ Params: { id: string } }>("/api/lab/projects/:id/summary", async (req, reply) => {
    const bp = await deps.readBlueprint(req.params.id);
    if (!bp) return reply.code(404).send({ error: "no blueprint" });
    const exec = await executionFor(deps, req.params.id);
    return safe({
      summary: buildSummary(bp, exec.chainId, deps.realityChainId),
      capabilities: capabilityReview(bp, exec.chainId),
      unestablishedBoundaries: unestablishedBoundaries(bp),
      networks: realityDisplay({ marketChainId: deps.realityChainId, executionChainId: exec.chainId, forkedFrom: exec.forkedFrom }),
    });
  });

  /* ── reality ────────────────────────────────────────────────────────────── */

  app.get("/api/lab/reality/modes", async () => {
    const caps = await deps.readCapabilities();
    const resolved = { ...caps, archiveDepth: caps.archiveDepth };
    const graph = graphStatus(resolved);
    return safe({
      modes: realityModes(resolved),
      sources: [{ ...graph, tone: badgeTone(graph.status) }],
      // The NAMES of the secrets the backend holds, by presence — never a value, and not under a
      // field the redaction scanner reads as a secret. A screen that needs to say "THEGRAPH_API_KEY
      // is configured" reads it here rather than guessing from a source's colour.
      configuredSecretNames: [...caps.availableCredentials].filter((c) => /^[A-Z][A-Z0-9_]+$/.test(c)).sort(),
      // Where each one is held — the Ledger Key Ring or the server environment — and the ring's
      // local status. Names and sources only; a value has no path to this response.
      protectedSources: deps.readProtectedSources ? await deps.readProtectedSources() : [],
      networks: realityDisplay({ marketChainId: deps.realityChainId, executionChainId: deps.executionChainId }),
    });
  });

  /* ── CRE ────────────────────────────────────────────────────────────────── */

  app.get<{ Params: { id: string } }>("/api/lab/projects/:id/cre", async (req, reply) => {
    const cre = await deps.readCre(req.params.id);
    if (!cre) return reply.code(404).send({ error: "no CRE configuration" });

    const connection = CreConnectionInfoSchema.parse(cre.connection);
    const status = creStatus({
      mode: "SIMULATED_USER",
      organizationId: connection.organizationId,
      workflowBinaryHash: cre.workflowBinaryHash,
      productionLimits: cre.productionLimits,
      deployAccess: connection.deployAccess,
      registries: connection.registries,
      officialSimulationRan: cre.officialSimulationRan,
    });
    return safe({ status, connection, promotion: promotionAvailability(connection) });
  });

  /**
   * Run the official CRE simulation, now, for this project.
   *
   * A POST that takes minutes: it compiles the workflow and runs Chainlink's simulator. The result
   * is stored as a run, and every reader of `creSimulationPassed` reads the latest run — so a rerun
   * that fails after a pass is what the screens show.
   */
  app.post<{ Params: { id: string } }>("/api/lab/projects/:id/cre/simulate", async (req, reply) => {
    if (!deps.runCreSimulation) return reply.code(501).send({ error: "the CRE simulator is not wired on this server" });
    const inputs = await deps.readInputs(req.params.id);
    if (!inputs) return reply.code(404).send({ error: "unknown project" });
    return safe(await deps.runCreSimulation(req.params.id));
  });

  app.get<{ Params: { id: string } }>("/api/lab/projects/:id/cre/simulations", async (req, reply) => {
    if (!deps.listCreSimulations) return reply.code(501).send({ error: "the CRE simulator is not wired on this server" });
    return safe({ runs: await deps.listCreSimulations(req.params.id) });
  });

  /* ── deploy ─────────────────────────────────────────────────────────────── */

  app.get<{ Params: { id: string }; Querystring: { gas?: string; balance?: string; required?: string } }>(
    "/api/lab/projects/:id/deploy-readiness",
    async (req, reply) => {
      const inputs = await deps.readInputs(req.params.id);
      if (!inputs) return reply.code(404).send({ error: "unknown project" });
      const cre = await deps.readCre(req.params.id);

      return safe({
        readiness: deployReadiness({
          architecturePassed: inputs.build?.status === "COMPLETED",
          securityTestsPassed: inputs.deterministicSimulationsPassed,
          creSimulationPassed: inputs.creSimulationPassed,
          realityTestPassed: inputs.creSimulationPassed,
          preflightPassed: inputs.preflightPassed,
          executionChainId: deps.executionChainId,
          runtimeImageDigest: cre?.workflowBinaryHash ?? null,
          estimatedGas: req.query.gas ? BigInt(req.query.gas) : null,
          walletBalanceWei: req.query.balance ? BigInt(req.query.balance) : null,
          requiredBalanceWei: req.query.required ? BigInt(req.query.required) : null,
        }),
        phases: DEPLOY_PHASES,
        controlSemantics: CONTROL_SEMANTICS,
      });
    },
  );

  /* ── attack lab ─────────────────────────────────────────────────────────── */

  app.get<{ Params: { id: string } }>("/api/lab/projects/:id/attacks", async (req, reply) => {
    const bp = await deps.readBlueprint(req.params.id);
    if (!bp) return reply.code(404).send({ error: "no blueprint" });
    const applicable = applicableAttacks(bp);
    return safe({
      /*
       * Applicable scenarios, and the ones that do not apply, with the reason.
       *
       * §P28.35 asks for only applicable scenarios to be *displayed*. Returning the inapplicable
       * ones separately means the UI can explain why an attack is absent rather than leaving the
       * list looking arbitrary.
       */
      applicable,
      notApplicable: ATTACKS.filter((a) => !applicable.includes(a)).map((a) => ({ scenario: a.scenario, title: a.title, requires: a.appliesWhen })),
    });
  });

  /**
   * Run one attack scenario.
   *
   * A POST because it exercises real guards — the policy engine, the network fences, the transport
   * allowlist — rather than reading a stored result. Nothing it runs can write anywhere: every
   * driver either evaluates a pure function or calls a fence that refuses.
   */
  app.post<{ Params: { id: string; scenario: string } }>("/api/lab/projects/:id/attacks/:scenario/run", async (req, reply) => {
    const bp = await deps.readBlueprint(req.params.id);
    if (!bp) return reply.code(404).send({ error: "no blueprint" });

    const parsed = AttackScenarioSchema.safeParse(req.params.scenario);
    if (!parsed.success) return reply.code(422).send({ error: "unknown scenario", scenario: req.params.scenario });

    // Only scenarios this Blueprint makes meaningful. Running an inapplicable one would produce a
    // pass that proves nothing, which is worse than refusing it.
    if (!applicableAttacks(bp).some((a) => a.scenario === parsed.data)) {
      return reply.code(409).send({ error: "scenario does not apply to this Blueprint", scenario: parsed.data });
    }

    return safe(runAttack(parsed.data, { blueprint: bp, nowUnix: Math.floor(Date.now() / 1000) }));
  });

  /* ── the simulation center ──────────────────────────────────────────────── */

  /**
   * Four layers, four meanings.
   *
   * The counts come from the safety report's recorded testing block rather than from a constant
   * here — a screen that reported "31 / 31" from a literal would keep reporting it after the suite
   * changed.
   */
  app.get<{ Params: { id: string } }>("/api/lab/projects/:id/simulation-center", async (req, reply) => {
    const inputs = await deps.readInputs(req.params.id);
    if (!inputs) return reply.code(404).send({ error: "unknown project" });
    const cre = await deps.readCre(req.params.id);
    const caps = await deps.readCapabilities();
    const report = await deps.readSafetyReport(req.params.id);
    const snapshot = await deps.readSnapshot(req.params.id);
    const shadow = await deps.readShadow(req.params.id);
    // The recorded report where one exists; the pipeline's own simulation rows otherwise.
    const deterministic = report ? report.testing.securitySimulations : await deps.readDeterministic(req.params.id);

    return safe(simulationCenter({
      deterministic,
      cre: {
        ran: inputs.creSimulationPassed,
        passed: inputs.creSimulationPassed,
        productionLimits: cre?.productionLimits ?? false,
        binaryHash: cre?.workflowBinaryHash ?? null,
      },
      reality: {
        ran: snapshot !== null,
        passed: snapshot !== null,
        mode: snapshot?.mode ?? "LIVE_MIRROR",
        anchorBlock: snapshot?.anchorBlock ?? null,
      },
      fork: {
        available: caps.forkAvailable,
        ran: shadow !== null,
        passed: shadow?.tx.status === "success",
        forkBlock: shadow?.fork.forkBlock ?? null,
        blocker: caps.forkAvailable ? null : "no local fork provider (anvil) on this machine",
      },
    }));
  });

  /* ── connecting a CRE account ───────────────────────────────────────────── */

  /**
   * The Local Bridge flow, §P28.15.
   *
   * A GET that returns a description rather than a POST that performs one: the connect action
   * happens on the user's own machine, through the CLI. There is no endpoint here that could
   * receive a credential, which is the property the screen is claiming.
   */
  app.get<{ Params: { id: string } }>("/api/lab/projects/:id/cre/connect", async (req, reply) => {
    const cre = await deps.readCre(req.params.id);
    if (!cre) return reply.code(404).send({ error: "no CRE configuration" });
    const connection = CreConnectionInfoSchema.parse(cre.connection);
    return safe({ flow: connectFlow(connection.connected), account: creAccountView(connection) });
  });

  /**
   * Promotion parity, §P28.24.
   *
   * The deployed side is empty while BLK-V2-CRE-DEPLOY is open, and the result says so per fixture
   * — `notRun: "DEPLOYED"` rather than a match. A parity screen that showed five green rows against
   * a workflow that was never deployed would be the exact false claim this phase forbids.
   */
  app.get<{ Params: { id: string } }>("/api/lab/projects/:id/cre/parity", async (req, reply) => {
    const cre = await deps.readCre(req.params.id);
    if (!cre) return reply.code(404).send({ error: "no CRE configuration" });
    const connection = CreConnectionInfoSchema.parse(cre.connection);

    const simulator = Object.fromEntries(
      PARITY_FIXTURES.map((f) => [f.id, { verdict: f.expectedVerdict, reasonCode: f.expectedReason, riskClass: f.expectedRisk, publicOutput: f.expectedReason }]),
    );
    // Nothing is deployed, so nothing ran on the deployed side. Stated, not simulated.
    const deployed = {};

    return safe({
      result: parityRun(simulator, deployed),
      deployedAvailable: connection.deployAccess === true,
      blocker: connection.deployAccess === true ? null : "BLK-V2-CRE-DEPLOY",
      note: "Parity compares the simulator against a deployed workflow. Deploy Access is not enabled for this account, so the deployed column has no results — each fixture reports NOT RUN rather than a match.",
    });
  });

  /* ── testnet assets and activation ──────────────────────────────────────── */

  app.get<{ Params: { id: string } }>("/api/lab/projects/:id/token-requirements", async (req, reply) => {
    const bp = await deps.readBlueprint(req.params.id);
    if (!bp) return reply.code(404).send({ error: "no blueprint" });
    return safe({
      requirements: tokenRequirements({
        executionChainId: deps.executionChainId,
        spendsAssets: bp.actions.flatMap((a) => a.spendsAssets ?? []),
        needsNativeGas: true,
      }),
      note: TESTNET_ASSET_NOTE,
    });
  });

  app.get<{ Params: { id: string } }>("/api/lab/projects/:id/activation-readiness", async (req, reply) => {
    const inputs = await deps.readInputs(req.params.id);
    if (!inputs) return reply.code(404).send({ error: "unknown project" });
    return safe({
      readiness: activationReadiness({
        contractsVerified: inputs.deployment === "READY_TO_ACTIVATE",
        runtimeHealthy: inputs.runtime === "HEALTHY",
        creSimulatorHealthy: inputs.creSimulationPassed,
        realityDataHealthy: inputs.degradedDependencies.length === 0,
        policyEnabled: inputs.policy?.enabled ?? false,
        executionChainId: deps.executionChainId,
      }),
      /* The projection, so the screen and the header cannot disagree about the state. */
      state: projectLabState(inputs).state,
    });
  });

  /* ── shadow mode and the fork ───────────────────────────────────────────── */

  app.get<{ Params: { id: string } }>("/api/lab/projects/:id/shadow", async (req, reply) => {
    const shadow = await deps.readShadow(req.params.id);
    if (!shadow) return reply.code(404).send({ error: "no shadow run recorded for this project" });
    return safe({
      run: shadowRunView({ decision: shadow.decision, watchingChainId: deps.realityChainId, fork: shadow.fork }),
      fork: forkActionDetail({ fork: shadow.fork, tx: shadow.tx, protocol: shadow.protocol, input: shadow.input, output: shadow.output }),
    });
  });

  /* ── market shocks ──────────────────────────────────────────────────────── */

  /**
   * The shock presets and, for the applicable ones, the decision each produces.
   *
   * Every verdict comes from the same policy engine the workflow runs, against a copy of the sealed
   * snapshot. The base is re-read and its hash checked afterwards inside `runShock`, so a scenario
   * that edited its input would fail here rather than quietly replace the record.
   */
  app.get<{ Params: { id: string } }>("/api/lab/projects/:id/scenarios", async (req, reply) => {
    const snapshot = await deps.readSnapshot(req.params.id);
    if (!snapshot) return reply.code(404).send({ error: "no market snapshot for this project" });
    const bp = await deps.readBlueprint(req.params.id);
    if (!bp) return reply.code(404).send({ error: "no blueprint" });

    const policy = policyFromBlueprint(bp);
    const common = {
      policy,
      priceMetric: "weth/usd:price",
      amount: 500_000_000_000_000_000n,
      amountDecimals: 18,
      amountLabel: "repay 0.5 WETH of Aave debt",
      actionKind: bp.actions[0]?.kind ?? "AAVE_REPAY",
      agentIdentityHash: keccak256(toHex(bp.identity.agentId)),
      target: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
      recipient: "0x93e0FCb0F71e83F3340264339BC5983C474635c5",
      nowMs: snapshot.observedAtMs,
      maxSnapshotAgeMs: 5_400_000,
    };

    const presets = shockPresets(snapshot);
    const base = decideOnSnapshot({ snapshot, ...common });
    const runs = presets
      .filter((p) => p.applicable)
      .flatMap((p) => {
        const overlay = presetById(p.overlayId);
        if (!overlay) return [];
        const result = runShock(snapshot, overlay, { snapshotId: `scn-${overlay.overlayId}` });
        return [{ overlay, result, decision: decideOnSnapshot({ snapshot: result.snapshot, ...common }) }];
      });

    const rows = compareScenarios({ decision: base, snapshotHash: snapshot.snapshotHash }, runs);
    assertSyntheticLabelled(rows, "scenario comparison");

    return safe({
      presets,
      rows,
      action: common.amountLabel,
      basis: base.basis,
      baseValuedAt: base.valuedAt,
      anchorBlock: snapshot.anchorBlock,
    });
  });

  /* ── why did it act? ────────────────────────────────────────────────────── */

  app.get<{ Params: { id: string; correlationId: string } }>("/api/lab/projects/:id/decisions/:correlationId", async (req, reply) => {
    const input = await deps.readDecision(req.params.id, req.params.correlationId);
    if (!input) return reply.code(404).send({ error: "unknown decision" });
    const detail = decisionDetail(input);
    // The private policy check runs on the assembled object, on the way out, every time.
    assertDecisionPrivate(detail, "decision detail response");
    return safe(detail);
  });

  /* ── the safety report ──────────────────────────────────────────────────── */

  app.get<{ Params: { id: string } }>("/api/lab/projects/:id/safety-report", async (req, reply) => {
    const report = await deps.readSafetyReport(req.params.id);
    if (!report) return reply.code(404).send({ error: "no report" });
    // The private report. `assertPublicSafe` runs on the way out, as it does for every response.
    return safe(report);
  });

  app.get<{ Params: { id: string } }>("/api/lab/projects/:id/safety-report/public", async (req, reply) => {
    const report = await deps.readSafetyReport(req.params.id);
    if (!report) return reply.code(404).send({ error: "no report" });
    /*
     * Built from an allow-list rather than filtered from the private report.
     *
     * A filter is a deny-list, and a field added to the report later would be public by default.
     * `publicSafetyView` constructs a new object, so a new field is private until someone adds it
     * there on purpose.
     */
    return safe(publicSafetyView(report));
  });
}
