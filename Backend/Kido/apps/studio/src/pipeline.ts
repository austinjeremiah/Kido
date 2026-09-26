import { randomUUID } from "node:crypto";
import {
  validateBlueprint,
  validateBlueprintArtifacts,
  projectGraph,
  computeSecurityScore,
  aaveGuardianSkeleton,
  PROTOCOL_CATALOGUE,
  DEX_ROUTER_ID,
  catalogueActionIds,
  familyOfActionKind,
  swapAction,
  routerProtocol,
  type ContextLockAgentBlueprint,
  type ValidationIssue,
} from "@contextlock/studio-blueprint";
import { runAllScenarios, runScenario, type SimulationResult } from "@contextlock/studio-simulation";
import { renderProject } from "@contextlock/studio-templates";
import { scanArtifactHonesty } from "./honesty.js";
import { adapterCatalogue, buildRegistry, resolveBlueprintAdapters, resolveExecutionCapability } from "./adapters.js";
import { buildAdapterFixtures } from "./adapter-fixtures.js";
import type { DB } from "./db.js";
import { StudioEventBus } from "./events.js";
import { QuotaManager, QuotaExceededError } from "./quota.js";
import { DEFAULT_QUOTA, SANDBOX } from "./config.js";
import { getSandboxProvider, SandboxUnavailableError, type StudioSandbox } from "./sandbox/provider.js";
import {
  runArchitecture,
  runFinalReviewer,
  runRequirements,
  runSecurityArchitect,
  UpstreamRateLimitError,
  type ArchitectureChoice,
  type FinalReview,
  type Requirements,
  type SecurityReview,
} from "./agents/roles.js";

/**
 * The build state machine.
 *
 * Application code owns this. The model works inside individual stages and never decides which
 * stage runs next, when to stop, when to retry, or when a build is finished.
 *
 * That division is not stylistic. A model that controls its own loop decides when it has done
 * enough — and a model under a failing test has a strong pull toward declaring completion. Here, a
 * build advances only when deterministic code says the stage's gate passed.
 */

export type BuildStage =
  | "INTAKE"
  | "REQUIREMENTS"
  | "BLUEPRINT"
  | "SECURITY_REVIEW"
  | "AWAITING_APPROVAL"
  | "BUILD"
  | "TEST"
  | "SIMULATE"
  | "REPAIR"
  | "FINAL_VERIFY"
  | "EXPORT_READY";

export type BuildStatus =
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "PAUSED"
  | "BUILD_LIMIT_REACHED"
  | "BUILD_NEEDS_USER_REVIEW"
  | "BUILD_PAUSED_UPSTREAM_LIMIT"
  | "ABANDONED";

export interface BuildRow {
  id: string;
  projectId: string;
  userId: string;
  stage: BuildStage;
  status: BuildStatus;
  blueprintRevision: number | null;
  buildRevision: number;
  repairCycles: number;
  approvedAt: string | null;
  failureReason: string | null;
}

export interface PipelineDeps {
  db: DB;
  bus: StudioEventBus;
  quota: QuotaManager;
  /** Injectable so tests can drive the pipeline without spending model tokens. */
  agents?: {
    requirements: (prompt: string) => Promise<{ output: Requirements; usage: Usage; runId: string }>;
    architecture: (input: string) => Promise<{ output: ArchitectureChoice; usage: Usage; runId: string }>;
    security: (input: string) => Promise<{ output: SecurityReview; usage: Usage; runId: string }>;
    reviewer: (input: string) => Promise<{ output: FinalReview; usage: Usage; runId: string }>;
  };
  sandboxProviderId?: string;
}

type Usage = { requests: number; inputTokens: number; outputTokens: number; totalTokens: number };

const now = () => new Date().toISOString();

const getSandboxRegistry = () => buildRegistry();

export class StudioPipeline {
  private readonly sandboxes = new Map<string, StudioSandbox>();

  constructor(private readonly deps: PipelineDeps) {}

  /* ── build creation ─────────────────────────────────────────────────────── */

  createBuild(args: { userId: string; prompt: string; name?: string | undefined; idempotencyKey?: string | undefined; ensName?: string | undefined }): BuildRow {
    const { db, bus, quota } = this.deps;

    // STUDIO-028: an accidental double-submit must not consume a second build credit.
    if (args.idempotencyKey) {
      const existing = db
        .prepare(`SELECT * FROM studio_builds WHERE idempotency_key = ?`)
        .get(args.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) return this.rowOf(existing);
    }

    quota.assertCanCreateBuild(args.userId);

    const projectId = `prj_${randomUUID().slice(0, 8)}`;
    const buildId = `bld_${randomUUID().slice(0, 8)}`;
    const t = now();

    db.prepare(
      `INSERT INTO studio_projects (id, user_id, name, prompt, created_at, ens_name) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(projectId, args.userId, args.name ?? "Untitled agent", args.prompt, t, args.ensName ?? null);

    db.prepare(
      `INSERT INTO studio_builds (id, project_id, user_id, stage, status, build_revision, repair_cycles, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 'INTAKE', 'RUNNING', 0, 0, ?, ?, ?)`,
    ).run(buildId, projectId, args.userId, args.idempotencyKey ?? null, t, t);

    bus.emit(buildId, "build.created", { projectId, prompt: args.prompt });
    return this.get(buildId)!;
  }

  findByIdempotencyKey(key: string): BuildRow | undefined {
    const r = this.deps.db.prepare(`SELECT * FROM studio_builds WHERE idempotency_key = ?`).get(key) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowOf(r) : undefined;
  }

  /* ── stage 1-3: requirements → blueprint → security ─────────────────────── */

  /**
   * Runs everything up to the approval boundary and then STOPS.
   *
   * The stop is mandatory (Bible 11.24). Generating code straight from a prompt spends a sandbox
   * and most of a token budget before the user has seen what permissions their agent would hold —
   * which is the one thing they most need to look at.
   */
  async runToApproval(buildId: string): Promise<{ blueprint: ContextLockAgentBlueprint; issues: ValidationIssue[] }> {
    const { db, bus, quota } = this.deps;
    const build = this.require(buildId);
    const prompt = (
      db.prepare(`SELECT prompt FROM studio_projects WHERE id = ?`).get(build.projectId) as { prompt: string }
    ).prompt;

    /* REQUIREMENTS */
    this.setStage(buildId, "REQUIREMENTS");
    bus.emit(buildId, "requirements.started", {});
    const req = await this.callModel(buildId, "requirements", prompt, () =>
      this.deps.agents
        ? this.deps.agents.requirements(prompt)
        : runRequirements(prompt),
    );
    bus.emit(buildId, "requirements.completed", {
      objective: req.objective,
      unknowns: req.unknowns,
      allowedActions: req.allowedActions,
      forbiddenActions: req.forbiddenActions,
    });

    /* BLUEPRINT */
    this.setStage(buildId, "BLUEPRINT");
    bus.emit(buildId, "blueprint.started", {});
    /*
     * The architecture stage is given the registry's actual vocabulary. Left to invent data kinds it
     * produces plausible names no adapter declares, and every requirement becomes unresolvable.
     */
    const catalogueRegistry = buildRegistry();
    const archInput = JSON.stringify({
      prompt,
      requirements: req,
      catalogue: {
        ...adapterCatalogue(catalogueRegistry, 11155111),
        actionIds: catalogueActionIds(),
        protocols: [
          ...PROTOCOL_CATALOGUE.map((p) => ({ id: p.id, displayName: p.displayName, family: p.family, actions: p.actions.map((a) => ({ id: a.id, kind: a.kind, does: a.displayName, spends: a.spendsAssets })) })),
          // The swap is a catalogue entry like the others: an agent that rebalances names it by `swap-tokens`.
          { id: DEX_ROUTER_ID, displayName: "DEX router (token swaps)", family: "dex", actions: [{ id: "swap-tokens", kind: "TOKEN_SWAP", does: "Swap tokens through the router the registry resolves; the recipient is always the vault", spends: ["USDC", "WETH"] }] },
        ],
      },
    });
    const arch = await this.callModel(buildId, "architecture", archInput, () =>
      this.deps.agents
        ? this.deps.agents.architecture(archInput)
        : runArchitecture(archInput),
    );

    const draft = this.assembleBlueprint(buildId, req, arch);

    /*
     * Deterministic adapter resolution.
     *
     * The Architecture Agent may name a preferred adapter; `resolveBlueprintAdapters` accepts one
     * only when the deterministic rules would have chosen it anyway. A rejected suggestion is
     * recorded as a finding and resolution proceeds without it — the model's preference is
     * discarded, the requirement is not.
     */
    const registry = buildRegistry();
    const resolution = resolveBlueprintAdapters(registry, draft);

    /*
     * Execution capabilities the architecture stage asked for, resolved by capability and chain.
     * An unresolvable capability is a CRITICAL finding rather than a silent omission: an agent whose
     * architecture says it can swap, generated without a swap adapter, would fail at runtime having
     * passed design review.
     */
    for (const capability of arch.requiredExecutionCapabilities ?? []) {
      const r = resolveExecutionCapability(registry, capability, 11155111);
      if ("unresolved" in r) {
        const i: ValidationIssue = {
          code: "ADP-NO-EXECUTION-ADAPTER",
          severity: "CRITICAL",
          path: `requiredExecutionCapabilities.${capability}`,
          message:
            `No registered execution adapter provides "${capability}" on chain 11155111.` +
            (r.unresolved.rejected.length > 0
              ? ` Adapters offering it on other chains: ${r.unresolved.rejected.join("; ")}`
              : ""),
          remediation:
            "Register an adapter that supports this chain, or remove the capability. An adapter is never selected for a chain it does not declare.",
        };
        this.recordFinding(buildId, i, "adapter-resolver");
        bus.emit(buildId, "security.finding", { ...i, source: "adapter-resolver" });
      } else if (!resolution.bindings.some((b) => b.adapterId === r.adapterId && b.configRef === r.configRef)) {
        resolution.bindings.push(r);
      }
    }

    /*
     * Bound adapters contribute their declared scenarios to the mandatory security pass, and their
     * generated modules to the Blueprint's module list. Both come from the manifest, so a new
     * provider needs no change here.
     */
    /*
     * One adapter may be bound several times — aave-v3-state serves health factor, total debt and
     * the full position from the same contract read. Its scenarios and modules are contributed ONCE
     * per adapter, not once per binding, or a three-way binding reports the same five scenarios
     * three times and the pass count becomes meaningless.
     */
    const uniqueAdapters = [...new Map(resolution.bindings.map((b) => [`${b.adapterId}@${b.adapterVersion}`, b])).values()];

    const adapterScenarios = uniqueAdapters.flatMap((b) => {
      const m = registry.resolve(b.adapterId, b.adapterVersion).manifest;
      /*
       * Where a rejection is expected to land depends on the adapter's KIND, not its provider.
       * An execution adapter's checks run at EXECUTION — the transaction is decoded and refused
       * before signing. A data adapter's checks run at CRE — a bad observation never reaches a
       * verdict. Assuming EXECUTION for everything made a correctly-blocked stale price read as a
       * failure.
       */
      const stopStage = m.adapterType === "EXECUTION" ? ("EXECUTION" as const) : ("CRE" as const);

      /*
       * The expected outcome comes from the adapter's OWN fixture declaration, not from the shape of
       * the scenario's name.
       *
       * The first version guessed by matching /NORMAL|PRICE_MOVEMENT/, which happened to fit the
       * Uniswap and Graph naming and fit nothing else — AAVE-HEALTHY and AAVE-NO-DEBT are
       * happy-path readings and were expected to be blocked. That is the same mistake as
       * FND-V2-008: inferring something the adapter already states.
       */
      const declared = new Map(
        registry.resolve(b.adapterId, b.adapterVersion).adapter.createSimulationFixtures().map((f) => [f.scenarioId, f.expected.outcome]),
      );
      return m.simulationProviders.map((scenarioId) => {
        const accepted = declared.get(scenarioId) === "ACCEPTED";
        return {
          scenarioId,
          description: `${m.name} scenario ${scenarioId}`,
          expectedVerdict: "NO_VERDICT" as const,
          expectedOutcome: accepted ? ("EXECUTED" as const) : ("BLOCKED" as const),
          expectedStopStage: accepted ? ("NONE" as const) : stopStage,
        };
      });
    });

    const adapterModules = uniqueAdapters.flatMap((b) => {
      const m = registry.resolve(b.adapterId, b.adapterVersion).manifest;
      return m.generatedModules.map((g) => ({
        moduleId: `${b.adapterId}-${g.kind}`,
        kind: g.kind,
        path: g.path,
        templateRef: `${b.adapterId}@${b.adapterVersion}`,
        reusesContextLockCore: false,
      }));
    });

    const blueprint: ContextLockAgentBlueprint = {
      ...draft,
      adapters: resolution.bindings,
      simulationScenarios: [
        ...draft.simulationScenarios,
        ...adapterScenarios.filter((a) => !draft.simulationScenarios.some((s) => s.scenarioId === a.scenarioId)),
      ],
      generatedModules: [
        ...draft.generatedModules,
        ...adapterModules.filter((a) => !draft.generatedModules.some((m) => m.path === a.path)),
      ],
    };

    for (const o of resolution.overridesRejected) {
      const i: ValidationIssue = {
        code: "ADP-OVERRIDE-REJECTED",
        severity: "MEDIUM",
        path: `dataRequirements.${o.key}`,
        message: `The architecture stage suggested "${o.suggested}" for "${o.key}", which the deterministic resolver rejected: ${o.reason}`,
        remediation: "No action needed — the suggestion was discarded and resolution continued deterministically.",
      };
      this.recordFinding(buildId, i, "adapter-resolver");
      bus.emit(buildId, "security.finding", { ...i, source: "adapter-resolver" });
    }
    for (const u of resolution.unresolved) {
      /*
       * NO_COMPATIBLE_ADAPTER is CRITICAL, and the temptation here is to soften it — to pick the
       * closest available source and note the downgrade. That is precisely the silent substitution
       * the trust model exists to prevent, and it is more dangerous than an error because the value
       * that comes back looks entirely normal.
       */
      const i: ValidationIssue = {
        code: "ADP-NO-COMPATIBLE-ADAPTER",
        severity: "CRITICAL",
        path: `dataRequirements.${u.key}`,
        message:
          `No registered adapter can supply "${u.kind}" at ${u.minimumTrustClass} within ${u.maxAgeMs}ms. ` +
          (u.rejected.length > 0
            ? `Rejected: ${u.rejected.map((r) => `${r.ref} (${r.reason})`).join("; ")}`
            : "No candidate claimed this data kind."),
        remediation:
          "Relax the requirement explicitly, declare an acceptable lower-trust fallback, or register an adapter that meets it. A weaker source is never substituted automatically.",
      };
      this.recordFinding(buildId, i, "adapter-resolver");
      bus.emit(buildId, "security.finding", { ...i, source: "adapter-resolver" });
    }

    bus.emit(buildId, "blueprint.updated", {
      revision: blueprint.revision,
      adapters: resolution.bindings,
      unresolved: resolution.unresolved.map((u) => u.key),
    });

    const validation = validateBlueprint(blueprint);
    this.saveBlueprint(buildId, blueprint, validation.issues);
    bus.emit(buildId, "blueprint.completed", {
      revision: blueprint.revision,
      buildable: validation.buildable,
      unknowns: validation.unknowns,
      graph: projectGraph(blueprint),
    });

    /* SECURITY REVIEW — deterministic first, model second, deterministic decides. */
    this.setStage(buildId, "SECURITY_REVIEW");
    bus.emit(buildId, "security.started", {});
    for (const i of validation.issues) {
      this.recordFinding(buildId, i, "deterministic-validator");
      bus.emit(buildId, "security.finding", { ...i, source: "deterministic-validator" });
    }

    let modelIssues: ValidationIssue[] = [];
    try {
      const secInput = JSON.stringify({ blueprint, deterministicFindings: validation.issues });
      const review = await this.callModel(buildId, "security", secInput, () =>
        this.deps.agents
          ? this.deps.agents.security(secInput)
          : runSecurityArchitect(secInput),
      );
      modelIssues = review.findings.map((f) => ({ ...f, code: `SEC-${f.code}` }));
      for (const i of modelIssues) {
        this.recordFinding(buildId, i, "security-architect");
        bus.emit(buildId, "security.finding", { ...i, source: "security-architect" });
      }
    } catch (err) {
      // A failed advisory review must not block a build whose deterministic gate passed, and must
      // not silently pass one whose gate failed. It is recorded and the deterministic result stands.
      bus.emit(buildId, "security.finding", {
        code: "SEC-UNAVAILABLE",
        severity: "INFO",
        path: "security",
        message: `Advisory security review did not complete: ${(err as Error).message}`,
        remediation: "Deterministic validation still applies and is authoritative.",
        source: "security-architect",
      });
    }

    const allIssues = [...validation.issues, ...modelIssues];
    bus.emit(buildId, "security.completed", {
      buildable: validation.buildable,
      critical: allIssues.filter((i) => i.severity === "CRITICAL").length,
      high: allIssues.filter((i) => i.severity === "HIGH").length,
    });

    /* THE APPROVAL BOUNDARY */
    if (!validation.buildable) {
      this.setStatus(buildId, "BUILD_NEEDS_USER_REVIEW", "Blueprint is not buildable");
      this.setStage(buildId, "SECURITY_REVIEW");
      return { blueprint, issues: allIssues };
    }

    this.setStage(buildId, "AWAITING_APPROVAL");
    this.setStatus(buildId, "AWAITING_APPROVAL");
    bus.emit(buildId, "approval.requested", {
      estimatedUsage: quota.snapshot(buildId),
      graph: projectGraph(blueprint),
    });
    return { blueprint, issues: allIssues };
  }

  /* ── stage 4-7: build → test → simulate → verify ────────────────────────── */

  /**
   * Approve the design and unlock code generation.
   *
   * A CRITICAL raised by the Security Architect does not silently block the build (FND-V2-004: a
   * model's opinion is not a gate) and it does not silently pass either. It has to be
   * ACKNOWLEDGED by name, here, at the boundary where a human is already reading the design.
   *
   * That puts the decision where it belongs. Deterministic code decides what is buildable; a person
   * decides whether to accept a concern that only a model raised. Neither one gets to be quiet.
   */
  approve(buildId: string, acknowledgeFindings: string[] = []): void {
    const b = this.require(buildId);
    if (b.stage !== "AWAITING_APPROVAL") {
      throw new Error(`build ${buildId} is at stage ${b.stage}, not awaiting approval`);
    }

    const modelCriticals = this.deps.db
      .prepare(
        `SELECT code, message FROM studio_security_findings
         WHERE build_id = ? AND severity = 'CRITICAL' AND source = 'security-architect'`,
      )
      .all(buildId) as Array<{ code: string; message: string }>;

    const ack = new Set(acknowledgeFindings);
    const unacknowledged = modelCriticals.filter((f) => !ack.has(f.code));
    if (unacknowledged.length > 0) {
      const err = new Error(
        `approval refused: ${unacknowledged.length} CRITICAL finding(s) from the security review must be acknowledged by code: ${unacknowledged.map((f) => f.code).join(", ")}`,
      ) as Error & { unacknowledged: typeof unacknowledged };
      err.unacknowledged = unacknowledged;
      throw err;
    }

    this.deps.db.prepare(`UPDATE studio_builds SET approved_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), buildId);
    this.deps.bus.emit(buildId, "approval.granted", { acknowledged: acknowledgeFindings });
  }

  /**
   * Abandon a build the user has decided against.
   *
   * AWAITING_APPROVAL is a state only a person can leave, and until this existed the only exit was
   * to approve. A user who looked at the security review and decided NOT to build this agent was
   * left holding the single concurrency slot with no way to let go of it — so the safe answer,
   * "no, don't build that", was the one answer the Studio would not accept.
   *
   * The record is kept rather than deleted. What was designed, what the review found, and that a
   * human declined it are the interesting parts of an abandoned build.
   */
  abandon(buildId: string, reason: string): void {
    const b = this.require(buildId);
    if (b.status === "COMPLETED" || b.status === "ABANDONED") {
      throw new Error(`build ${buildId} is already ${b.status.toLowerCase()}`);
    }
    this.deps.db
      .prepare(`UPDATE studio_builds SET status = 'ABANDONED', failure_reason = ?, updated_at = ? WHERE id = ?`)
      .run(reason, now(), buildId);
    this.deps.bus.emit(buildId, "build.abandoned", { reason, stage: b.stage });
  }

  /**
   * Release the concurrency slots held by builds this process cannot possibly still be running.
   *
   * A build runs **in this process**. When the server stops mid-build, the worker goes with it and
   * the row stays `RUNNING` forever — holding the single concurrent slot against a user who has no
   * way to let go of it, because `abandon` is reachable from a screen they can no longer reach.
   * The next "Design this agent" returns `CONCURRENT_BUILDS (1/1)` and keeps returning it.
   *
   * That is the same failure the `abandon` comment above describes, arriving through a different
   * door: the safe answer — restart the server — became the one action the Studio would not
   * forgive.
   *
   * So any `RUNNING` row present at startup is orphaned **by definition**, and this says so
   * explicitly rather than guessing from a timestamp. A heartbeat age would be a guess; "the
   * process that was running this no longer exists" is a fact.
   *
   * `AWAITING_APPROVAL` and `PAUSED` are deliberately untouched. Those are states a *person* leaves,
   * they are meant to survive a restart, and reconciling them would throw away the review a user
   * has not answered yet.
   */
  reconcileOrphanedBuilds(): string[] {
    const orphaned = this.deps.db
      .prepare(`SELECT id, stage FROM studio_builds WHERE status = 'RUNNING'`)
      .all() as Array<{ id: string; stage: BuildStage }>;

    const reason =
      "the server restarted while this build was running, so the worker no longer exists. " +
      "The record is kept; the concurrency slot is released.";

    for (const b of orphaned) {
      this.deps.db
        .prepare(`UPDATE studio_builds SET status = 'ABANDONED', failure_reason = ?, updated_at = ? WHERE id = ?`)
        .run(reason, now(), b.id);
      // Recorded as an event, not just a status change: a build that vanished is worth seeing.
      this.deps.bus.emit(b.id, "build.abandoned", { reason, stage: b.stage });
    }
    return orphaned.map((b) => b.id);
  }

  async runBuild(buildId: string): Promise<{ ok: boolean; files: string[]; simulations: SimulationResult[] }> {
    const { bus, quota, db } = this.deps;
    const build = this.require(buildId);
    if (!build.approvedAt) throw new Error("build has not been approved by the user");

    const blueprint = this.currentBlueprint(buildId);
    const prompt = (
      db.prepare(`SELECT prompt FROM studio_projects WHERE id = ?`).get(build.projectId) as { prompt: string }
    ).prompt;
    const buildRevision = build.buildRevision + 1;
    db.prepare(`UPDATE studio_builds SET build_revision = ?, status = 'RUNNING', updated_at = ? WHERE id = ?`)
      .run(buildRevision, now(), buildId);

    /* BUILD — real files, in a real sandbox, with no network. */
    this.setStage(buildId, "BUILD");
    bus.emit(buildId, "code.started", { buildRevision, sandboxProvider: this.deps.sandboxProviderId ?? SANDBOX.provider });

    let sandbox: StudioSandbox;
    try {
      sandbox = await getSandboxProvider(this.deps.sandboxProviderId).create();
    } catch (err) {
      // Fails loudly. There is deliberately no host-execution fallback: running generated DeFi code
      // in the Studio process would defeat the only control that makes generation safe at all.
      this.setStatus(buildId, "FAILED", (err as Error).message);
      bus.emit(buildId, "build.failed", { reason: (err as Error).message });
      throw err instanceof SandboxUnavailableError ? err : new SandboxUnavailableError(String(err));
    }
    this.sandboxes.set(buildId, sandbox);
    const sandboxStartedAt = Date.now();
    db.prepare(`UPDATE studio_builds SET sandbox_id = ?, sandbox_started_at = ? WHERE id = ?`)
      .run(sandbox.id, sandboxStartedAt, buildId);

    try {
      const files = renderProject(blueprint);
      for (const f of files) {
        quota.assertCanWriteFile(buildId, buildRevision);
        quota.assertSandboxWithinWallClock(sandboxStartedAt);
        await sandbox.writeFile(f.path, f.content);
        db.prepare(
          `INSERT OR REPLACE INTO studio_artifacts (build_id, build_revision, blueprint_revision, path, content, bytes, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(buildId, buildRevision, blueprint.revision, f.path, f.content, Buffer.byteLength(f.content), now());
        bus.emit(buildId, "code.file.created", { path: f.path, bytes: Buffer.byteLength(f.content) });
      }

      // Dependencies come from the pre-provisioned image; nothing is fetched. See FND-V2-003.
      await sandbox.exec(`ln -sfn /opt/agent-deps/node_modules ${SANDBOX.workspaceRoot}/node_modules`);

      /* Blueprint ↔ artifact correspondence. The graph must not show what the code lacks. */
      const artifactIssues = validateBlueprintArtifacts(blueprint, files.map((f) => f.path));
      for (const i of artifactIssues) {
        this.recordFinding(buildId, i, "artifact-validator");
        bus.emit(buildId, "security.finding", { ...i, source: "artifact-validator" });
      }
      if (artifactIssues.length > 0) {
        this.setStatus(buildId, "BUILD_NEEDS_USER_REVIEW", "generated artifacts do not match the Blueprint");
        return { ok: false, files: files.map((f) => f.path), simulations: [] };
      }

      /* TEST — compile and run the generated project's own tests, in the sandbox. */
      this.setStage(buildId, "TEST");
      bus.emit(buildId, "test.started", { buildRevision });
      let testOk = await this.runSuite(buildId, sandbox, buildRevision);

      /* REPAIR — bounded. Three cycles, then hand it to a human. */
      while (!testOk) {
        try {
          quota.assertCanRepair(buildId);
        } catch (e) {
          if (e instanceof QuotaExceededError) {
            this.setStatus(buildId, "BUILD_NEEDS_USER_REVIEW", "automatic repair exhausted after 3 cycles");
            bus.emit(buildId, "build.failed", { reason: "repair budget exhausted" });
            return { ok: false, files: files.map((f) => f.path), simulations: [] };
          }
          throw e;
        }
        const cycles = this.require(buildId).repairCycles + 1;
        db.prepare(`UPDATE studio_builds SET repair_cycles = ?, updated_at = ? WHERE id = ?`).run(cycles, now(), buildId);
        this.setStage(buildId, "REPAIR");
        bus.emit(buildId, "repair.started", { cycle: cycles });
        // Templates are deterministic, so a failure here is a template defect rather than something
        // a retry can fix. Re-rendering is the honest repair: it either produces the same files (and
        // the same failure, which is then escalated) or a corrected one after a template change.
        for (const f of renderProject(blueprint)) await sandbox.writeFile(f.path, f.content);
        bus.emit(buildId, "repair.completed", { cycle: cycles });
        testOk = await this.runSuite(buildId, sandbox, buildRevision);
      }

      /* SIMULATE — deterministic, bound to both revisions. */
      this.setStage(buildId, "SIMULATE");
      bus.emit(buildId, "simulation.started", { blueprintRevision: blueprint.revision, buildRevision });
      /*
       * The mandatory security pass.
       *
       * Every scenario the Blueprint declares runs, every time the design or the code changes. It is
       * not charged to the user's simulation allowance — FND-V2-005 recorded what happened when it
       * was: a rebuild after an edit ran 3 of 17 and looked complete.
       *
       * It is still bounded. The pass size is checked before it starts, the number of passes per
       * build is capped, and the sandbox wall clock applies throughout.
       */
      /*
       * Adapter fixtures are produced by RUNNING each bound adapter's decoder and validator against
       * constructed provider responses — never by asserting an expected outcome. A fixture that
       * merely claimed "REJECTED" would prove nothing about whether the adapter would really reject
       * it, which is the only thing the scenario is evidence for.
       */
      const adapterFixtures = await buildAdapterFixtures(getSandboxRegistry(), blueprint);

      const sims: SimulationResult[] = [];
      const planned = runAllScenarios(blueprint, buildRevision, adapterFixtures);
      const passId = `pass-${buildRevision}-${Date.now().toString(36)}`;
      let truncated = 0;

      quota.assertMandatoryPassSize(planned.length);
      for (const r of planned) {
        try {
          quota.assertCanSimulate(buildId, "MANDATORY_SECURITY");
          quota.assertSandboxWithinWallClock(sandboxStartedAt);
        } catch (e) {
          if (e instanceof QuotaExceededError) {
            // Reaching here means a ceiling designed never to bind has bound. Loud, and named.
            truncated = planned.length - sims.length;
            bus.emit(buildId, "build.limit_reached", {
              kind: e.kind,
              used: e.used,
              limit: e.limit,
              notRun: planned.slice(sims.length).map((p) => p.scenarioId),
            });
            break;
          }
          throw e;
        }
        db.prepare(
          `INSERT INTO studio_simulations (build_id, scenario_id, sim_class, pass_id, blueprint_revision, build_revision, result, passed, created_at)
           VALUES (?, ?, 'MANDATORY_SECURITY', ?, ?, ?, ?, ?, ?)`,
        ).run(buildId, r.scenarioId, passId, r.blueprintRevision, r.buildRevision, JSON.stringify(r), r.passed ? 1 : 0, now());
        sims.push(r);
        bus.emit(buildId, "simulation.step", {
          scenarioId: r.scenarioId,
          verdict: r.verdict,
          outcome: r.outcome,
          stoppedAt: r.stoppedAt,
          passed: r.passed,
        });
      }
      bus.emit(buildId, "simulation.completed", {
        passed: sims.filter((s) => s.passed).length,
        total: sims.length,
        planned: planned.length,
        truncated,
      });

      /* FINAL VERIFY */
      this.setStage(buildId, "FINAL_VERIFY");
      const score = computeSecurityScore(blueprint, {
        passedTests: this.passedStudioTests(buildId),
        passedScenarios: sims.filter((s) => s.passed).map((s) => s.scenarioId),
        issues: this.openIssues(buildId),
      });

      /*
       * Final Reviewer — read-only, and its most useful output is the honesty check.
       *
       * It compares the original request against everything produced and flags any artifact that
       * claims something which did not happen. A build is refused if it does, because the failure
       * mode this guards against is the one that survives every other control: a correct system
       * described inaccurately.
       */
      let review: FinalReview | undefined;
      try {
        const reviewInput = JSON.stringify({
          originalPrompt: prompt,
          blueprint,
          generatedFiles: files.map((f) => f.path),
          simulations: sims.map((r) => ({ id: r.scenarioId, verdict: r.verdict, outcome: r.outcome, passed: r.passed })),
          score,
        });
        review = await this.callModel(buildId, "reviewer", reviewInput, () =>
          this.deps.agents ? this.deps.agents.reviewer(reviewInput) : runFinalReviewer(reviewInput),
        );
      } catch (err) {
        bus.emit(buildId, "security.finding", {
          code: "REV-UNAVAILABLE",
          severity: "INFO",
          path: "final-review",
          message: `Final review did not complete: ${(err as Error).message}`,
          remediation: "Deterministic checks below still apply and are authoritative.",
          source: "final-reviewer",
        });
      }

      /*
       * The honesty check is DETERMINISTIC, and the deterministic result is the one that gates the
       * build.
       *
       * The first version of this code OR-ed the reviewer's boolean into the gate, and a real run
       * caught the problem: the model set `exposesConfidentialValues` on a build where nothing was
       * exposed, and a model's unexplained boolean silently blocked an otherwise clean build. That
       * is the same mistake as asking a model whether its own architecture is safe, just pointing
       * the other way — and a gate that fires without a reason nobody can inspect gets disabled by
       * whoever hits it next.
       *
       * So: code decides, and the reviewer's disagreement is recorded as a finding a human reads.
       */
      const honestyFlags = scanArtifactHonesty(files, blueprint);
      if (review) {
        for (const k of Object.keys(honestyFlags) as Array<keyof typeof honestyFlags>) {
          if (review.honestyCheck[k] && !honestyFlags[k]) {
            const disagreement: ValidationIssue = {
              code: "REV-DISAGREE",
              severity: "HIGH",
              path: `finalReview.honestyCheck.${k}`,
              message: `The Final Reviewer flagged "${k}" but the deterministic scan found no supporting evidence. Reviewer summary: ${review.summary.slice(0, 300)}`,
              remediation: "Read the artifacts and decide. The build is not blocked on a model's unexplained flag, and the flag is not discarded either.",
            };
            this.recordFinding(buildId, disagreement, "final-reviewer");
            bus.emit(buildId, "security.finding", { ...disagreement, source: "final-reviewer" });
          }
        }
      }
      const dishonest = Object.entries(honestyFlags).filter(([, v]) => v);
      if (dishonest.length > 0) {
        this.setStatus(buildId, "BUILD_NEEDS_USER_REVIEW", `artifact makes an unsupported claim: ${dishonest.map(([k]) => k).join(", ")}`);
        bus.emit(buildId, "build.failed", { reason: "honesty check failed", flags: honestyFlags });
        return { ok: false, files: files.map((f) => f.path), simulations: sims };
      }

      const allSimsPassed = sims.length > 0 && sims.every((s) => s.passed);
      if (!allSimsPassed || truncated > 0) {
        const reason = truncated > 0
          ? `simulation budget exhausted: ${truncated} scenario(s) never ran`
          : "one or more simulations did not meet expectations";
        this.setStatus(buildId, "BUILD_NEEDS_USER_REVIEW", reason);
        bus.emit(buildId, "build.failed", { reason, score, truncated });
        return { ok: false, files: files.map((f) => f.path), simulations: sims };
      }

      this.setStage(buildId, "EXPORT_READY");
      this.setStatus(buildId, "COMPLETED");
      bus.emit(buildId, "build.completed", {
        buildRevision,
        files: files.length,
        score,
        review: review ?? null,
        honestyCheck: honestyFlags,
        usage: quota.snapshot(buildId),
      });
      return { ok: true, files: files.map((f) => f.path), simulations: sims };
    } catch (err) {
      /*
       * An error nothing above classified.
       *
       * The guarded calls set BUILD_LIMIT_REACHED and BUILD_PAUSED_UPSTREAM_LIMIT themselves, and
       * those are resumable states that must be left alone. Anything else — a sandbox exec that
       * came back empty, a provider that died mid-build — used to propagate as a 500 and leave the
       * row RUNNING, holding the one concurrency slot until the next server restart (a repeat of
       * the shape FND-V2-28-005 recorded). A build that threw is FAILED, and says with what.
       */
      const status = this.get(buildId)?.status;
      if (status === "RUNNING") {
        const reason = (err as Error).message;
        this.setStatus(buildId, "FAILED", reason);
        bus.emit(buildId, "build.failed", { reason });
      }
      throw err;
    } finally {
      // The sandbox is destroyed only after the loop leaves it; never mid-write.
      const sb = this.sandboxes.get(buildId);
      if (sb) {
        await getSandboxProvider(this.deps.sandboxProviderId).destroy(sb).catch(() => undefined);
        this.sandboxes.delete(buildId);
      }
    }
  }

  private async runSuite(buildId: string, sandbox: StudioSandbox, buildRevision: number): Promise<boolean> {
    const tc = await sandbox.exec(`cd ${SANDBOX.workspaceRoot} && npx --no-install tsc -p tsconfig.json --noEmit 2>&1`);
    if (tc.exitCode !== 0) {
      this.recordTest(buildId, buildRevision, "typecheck", 0, 1, tc.stdout + tc.stderr);
      this.deps.bus.emit(buildId, "test.failed", { suite: "typecheck", output: tc.stdout.slice(0, 2000) });
      return false;
    }
    this.recordTest(buildId, buildRevision, "typecheck", 1, 0, "clean");
    this.deps.bus.emit(buildId, "test.passed", { suite: "typecheck" });

    const t = await sandbox.exec(`cd ${SANDBOX.workspaceRoot} && npx --no-install vitest run 2>&1`);
    const out = t.stdout + t.stderr;
    const m = /Tests\s+(\d+)\s+passed/.exec(out);
    const passed = m ? Number(m[1]) : 0;
    const ok = t.exitCode === 0;
    this.recordTest(buildId, buildRevision, "generated-tests", passed, ok ? 0 : 1, out.slice(0, 8000));
    this.deps.bus.emit(buildId, ok ? "test.passed" : "test.failed", {
      suite: "generated-tests",
      passed,
      output: out.slice(0, 2000),
    });
    return ok;
  }

  /* ── model call wrapper: quota + usage + upstream limits ────────────────── */

  private async callModel<T>(
    buildId: string,
    role: "requirements" | "architecture" | "security" | "reviewer",
    input: string,
    fn: () => Promise<{ output: T; usage: Usage; runId: string }>,
  ): Promise<T> {
    const { quota, bus } = this.deps;
    // Rough input estimate is used only to RESERVE. Settlement uses the SDK's actual numbers, so an
    // inaccurate estimate can make the Studio too cautious but never let it overspend.
    const estimatedInput = Math.ceil(input.length / 3);
    let reservationId: number;
    try {
      reservationId = quota.reserve(buildId, role, estimatedInput);
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        this.setStatus(buildId, "BUILD_LIMIT_REACHED", e.message);
        bus.emit(buildId, "build.limit_reached", { kind: e.kind, used: e.used, limit: e.limit });
      }
      throw e;
    }

    try {
      const r = await fn();
      quota.settle(reservationId, buildId, role, r.runId, r.usage);
      const snap = quota.snapshot(buildId);
      bus.emit(buildId, "usage.updated", snap as unknown as Record<string, unknown>);
      if (snap.warned) bus.emit(buildId, "usage.warning", { peakFraction: snap.peakFraction });
      return r.output;
    } catch (err) {
      quota.release(reservationId);
      if (err instanceof UpstreamRateLimitError) {
        this.setStatus(buildId, "BUILD_PAUSED_UPSTREAM_LIMIT", err.message);
        bus.emit(buildId, "build.paused", { reason: "upstream rate limit", resumable: true });
      }
      throw err;
    }
  }

  /* ── blueprint assembly ─────────────────────────────────────────────────── */

  /**
   * Merge the model's choices onto the verified template skeleton.
   *
   * The skeleton supplies every field that encodes a ContextLock invariant. The model supplies the
   * genuinely variable parts. A model that omits a limit yields UNKNOWN here, not a default — which
   * is why `usdToCents` returns the unknown rather than substituting zero.
   */
  private assembleBlueprint(buildId: string, req: Requirements, arch: ArchitectureChoice): ContextLockAgentBlueprint {
    /*
     * The name comes from the user when they gave one. The model's proposal is a fallback for a
     * user who did not, and the fallback is visibly a placeholder rather than a real name: a
     * Blueprint that claimed `guardian.contextlock.eth` for a stranger's agent would be naming it
     * in a namespace they do not control.
     */
    const project = this.deps.db.prepare(`SELECT ens_name FROM studio_projects p JOIN studio_builds b ON b.project_id = p.id WHERE b.id = ?`).get(buildId) as { ens_name: string | null } | undefined;
    const ensName = project?.ens_name || arch.ensName || "guardian.unspecified.eth";
    const skeleton = aaveGuardianSkeleton({
      blueprintId: `bp_${buildId}`,
      ensName,
      objective: arch.objective || req.objective,
    });
    // The agent's id is its own first label — not the template's — so a swap agent is not "aave-guardian".
    skeleton.identity.agentId = ensName.split(".")[0] || skeleton.identity.agentId;

    const usdToCents = (m: Requirements["autonomousLimitUsd"]) =>
      m.known
        ? { known: true as const, value: Math.round(m.value * 100), sourceQuote: m.sourceQuote }
        : { known: false as const, reason: m.reason, requiredBefore: m.requiredBefore };

    /*
     * The Requirements and Architecture stages both surface prohibitions, and they usually agree —
     * so "Withdraw collateral" arrives twice, worded slightly differently. Duplicates in a deny list
     * are not harmless: the approval panel is the one screen where a user reads what their agent may
     * never do, and a list that repeats itself reads as noise and gets skimmed.
     *
     * Compared on normalised text so trivial differences in punctuation or case collapse, while a
     * genuinely different prohibition survives.
     */
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    const denied: Array<{ id: string; statement: string }> = [];
    const seenDenials = new Set<string>();
    for (const statement of [...arch.deniedPermissions, ...req.forbiddenActions]) {
      const key = norm(statement);
      if (!key || seenDenials.has(key)) continue;
      seenDenials.add(key);
      denied.push({ id: `d-${denied.length}`, statement });
    }
    // The deny list must always be non-empty (schema) and must name the dangerous verbs (BP-018).
    // Rather than silently inventing prohibitions, unmentioned dangerous verbs are recorded as
    // explicitly unresolved so the validator raises them and the user is asked.
    for (const verb of ["withdraw", "arbitrary transfer", "arbitrary token approval"]) {
      if (!denied.some((d) => norm(d.statement).includes(norm(verb)))) {
        denied.push({
          id: `dq-${verb.replace(/[^a-z]/g, "")}`,
          statement: `UNRESOLVED: the user did not state whether "${verb}" is permitted`,
        });
      }
    }

    /*
     * Every action the catalogue offers is a candidate; a permission that names one activates it.
     *
     * The catalogue is the set of actions a registered adapter can construct, decode and validate
     * on a verified deployment. The model chooses among them by `actionRef`; it cannot add to them.
     * A swap is offered when the architecture asked for the capability, as before.
     */
    const needsSwap = (arch.requiredExecutionCapabilities ?? []).includes("TOKEN_SWAP")
      || arch.allowedPermissions.some((p) => p.actionRef === "swap-tokens");
    const candidateActions = [...PROTOCOL_CATALOGUE.flatMap((p) => p.actions), ...(needsSwap ? [swapAction(DEX_ROUTER_ID)] : [])];
    const permittedActionIds = arch.allowedPermissions
      .map((p) => p.actionRef)
      .filter((r): r is string => !!r && candidateActions.some((a) => a.id === r));

    /*
     * An action nobody authorized is removed from the Blueprint entirely, rather than kept and
     * merely excluded from autonomy. Leaving it in would put a capability in the generated agent
     * and in its architecture diagram that no permission covers.
     */
    const activeActions = candidateActions.filter((a) => permittedActionIds.includes(a.id));

    /*
     * The protocols, assets and data the ACTIVE actions need, from the catalogue. An agent that
     * repays on Morpho gets Morpho's singleton and Morpho's position read, not Aave's; an agent
     * with no active action keeps the skeleton's Aave defaults so the Blueprint still validates
     * and the review can say what is missing.
     */
    const activeEntries = PROTOCOL_CATALOGUE.filter((p) => activeActions.some((a) => a.protocolRef === p.id));
    const uniqueBy = <T>(items: T[], key: (t: T) => string): T[] => [...new Map(items.map((i) => [key(i), i])).values()];
    const activeProtocols = activeEntries.length > 0
      ? [...activeEntries.map((p) => p.protocol), ...(needsSwap ? [routerProtocol(DEX_ROUTER_ID, "DEX router")] : [])]
      : [...skeleton.protocols, ...(needsSwap ? [routerProtocol(DEX_ROUTER_ID, "DEX router")] : [])];
    const activeAssets = activeEntries.length > 0 ? uniqueBy(activeEntries.flatMap((p) => p.assets), (a) => a.symbol) : skeleton.assets;
    const activeDataRequirements = activeEntries.length > 0 ? uniqueBy(activeEntries.flatMap((p) => p.dataRequirements), (d) => d.key) : skeleton.dataRequirements;
    const activeContextSources = activeEntries.length > 0 ? uniqueBy(activeEntries.flatMap((p) => p.contextSources), (c) => c.id) : skeleton.contextSources;
    const hasLending = activeActions.some((a) => familyOfActionKind(a.kind) === "lending");
    // The generated protocol-adapter module is named for the agent's first protocol.
    const primaryProtocolId = activeProtocols[0]?.id ?? "aave";

    const bp: ContextLockAgentBlueprint = {
      ...skeleton,
      adapters: [],
      revision: 1,
      createdAt: now(),
      capabilityPolicy: {
        ...skeleton.capabilityPolicy,
        ttlSeconds: Math.min(Math.max(arch.capabilityTtlSeconds || 45, 15), 300),
      },
      confidentialPolicy: {
        ...skeleton.confidentialPolicy,
        parameterNames:
          arch.confidentialParameterNames.length > 0
            ? arch.confidentialParameterNames
            : skeleton.confidentialPolicy.parameterNames,
      },
      /*
       * A swap agent gets a swap action and a router protocol. Without them the Blueprint would
       * describe a lending agent while the objective asked for a trading one, and the adapter would
       * be bound with nothing referencing it — which the security review correctly flags.
       */
      /*
       * Generic router name. Which router this resolves to is decided by the adapter registry, and
       * the graph shows the bound adapter's own name — hard-coding a provider here would put exactly
       * the branching Group B exists to remove into the pipeline, and the architecture guard test
       * catches it if it ever comes back.
       */
      protocols: activeProtocols,
      assets: activeAssets,
      contextSources: activeContextSources,
      generatedModules: skeleton.generatedModules.map((m) =>
        m.kind === "protocol-adapter"
          ? { ...m, moduleId: `${primaryProtocolId}-adapter`, path: `src/adapters/${primaryProtocolId}.ts`, templateRef: `${primaryProtocolId}-adapter@1` }
          : m,
      ),
      ...(activeActions.length > 0 ? { actions: activeActions } : {}),
      /*
       * Scenarios follow the actions.
       *
       * The skeleton carries Aave-specific scenarios; a swap agent that has no lending actions
       * cannot meaningfully run them, and declaring them produced thirteen "failures" that were
       * really just inapplicable. A scenario for an action the agent cannot take is not evidence
       * about that agent.
       */
      simulationScenarios: skeleton.simulationScenarios.filter((sc) => {
        const lendingOnly = ["HEALTH_FACTOR_DROP", "FLASH_CRASH", "COLLATERAL_RECOVERY", "REPAY_ABOVE_AUTO_LIMIT"];
        if (!lendingOnly.includes(sc.scenarioId)) return true;
        return hasLending;
      }),
      dataRequirements:
        arch.dataRequirements && arch.dataRequirements.length > 0
          ? arch.dataRequirements.map((d) => ({
              key: d.key,
              kind: d.kind,
              chainId: 11155111 as const,
              minimumTrustClass: d.minimumTrustClass,
              maxAgeMs: d.maxAgeMs,
              confidential: false,
              historical: d.historical,
            }))
          : activeDataRequirements,
      triggers: [
        {
          id: "primary-trigger",
          kind: "threshold",
          description: req.triggers[0] ?? "Confidential threshold breach",
          thresholdIsConfidential: true,
          confidentialParameterName: skeleton.confidentialPolicy.parameterNames[0] ?? "threshold",
        },
      ],
      permissions: {
        allowed: arch.allowedPermissions.map((p, i) => ({
          id: `a-${i}`,
          statement: p.statement,
          ...(p.actionRef ? { actionRef: p.actionRef } : {}),
        })),
        denied,
      },
      autonomousPolicy: {
        maxValueUsdCents: usdToCents(req.autonomousLimitUsd),
        /*
         * Autonomy follows the PERMISSIONS, not the template.
         *
         * The first version listed every action the skeleton happened to contain, so a swap agent
         * inherited autonomous authority over lending actions nobody authorized — and the validator
         * correctly flagged it. An action runs autonomously because a stated permission names it,
         * or it does not run autonomously at all.
         */
        allowedActionRefs: permittedActionIds,
      },
      escalationPolicy: {
        minValueUsdCents: usdToCents(req.escalationFloorUsd),
        maxValueUsdCents: usdToCents(req.escalationCeilingUsd),
        // Never "ledger-device" unless a device genuinely exists. It does not.
        mechanism: "approval-registry-standin",
        denyIsTerminal: true,
      },
    };
    return bp;
  }

  /* ── persistence helpers ────────────────────────────────────────────────── */

  private saveBlueprint(buildId: string, bp: ContextLockAgentBlueprint, issues: ValidationIssue[]): void {
    this.deps.db
      .prepare(
        `INSERT OR REPLACE INTO studio_blueprints (build_id, revision, document, validation, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(buildId, bp.revision, JSON.stringify(bp), JSON.stringify(issues), now());
    this.deps.db
      .prepare(`UPDATE studio_builds SET blueprint_revision = ?, updated_at = ? WHERE id = ?`)
      .run(bp.revision, now(), buildId);
  }

  /**
   * Scenarios re-run on request, against the current Blueprint and build revision.
   *
   * Charged to the user's allowance and recorded as USER_REQUESTED, so a row here never counts as
   * the mandatory security pass. The engine is the same deterministic one the pass runs; what
   * differs is only who asked and what it is evidence of.
   */
  async runUserSimulations(buildId: string, scenarioIds: string[] | null): Promise<{ simulations: SimulationResult[]; notDeclared: string[] }> {
    const { db, bus, quota } = this.deps;
    const build = this.require(buildId);
    const blueprint = this.currentBlueprint(buildId);
    const declared = new Set(blueprint.simulationScenarios.map((s) => s.scenarioId));
    const wanted = scenarioIds && scenarioIds.length > 0 ? scenarioIds : [...declared];
    const notDeclared = wanted.filter((id) => !declared.has(id));
    const toRun = wanted.filter((id) => declared.has(id));
    if (toRun.length === 0) throw new Error(`none of the requested scenarios is declared by this Blueprint (${notDeclared.join(", ")})`);

    const adapterFixtures = await buildAdapterFixtures(getSandboxRegistry(), blueprint);
    const passId = `user-${build.buildRevision}-${Date.now().toString(36)}`;
    const out: SimulationResult[] = [];
    bus.emit(buildId, "simulation.started", { blueprintRevision: blueprint.revision, buildRevision: build.buildRevision, userRequested: true, scenarios: toRun });
    for (const scenarioId of toRun) {
      quota.assertCanSimulate(buildId, "USER_REQUESTED");
      const r = runScenario(blueprint, scenarioId as never, build.buildRevision, undefined, adapterFixtures);
      db.prepare(
        `INSERT INTO studio_simulations (build_id, scenario_id, sim_class, pass_id, blueprint_revision, build_revision, result, passed, created_at)
         VALUES (?, ?, 'USER_REQUESTED', ?, ?, ?, ?, ?, ?)`,
      ).run(buildId, r.scenarioId, passId, r.blueprintRevision, r.buildRevision, JSON.stringify(r), r.passed ? 1 : 0, now());
      out.push(r);
      bus.emit(buildId, "simulation.step", { scenarioId: r.scenarioId, verdict: r.verdict, outcome: r.outcome, stoppedAt: r.stoppedAt, passed: r.passed, userRequested: true });
    }
    bus.emit(buildId, "simulation.completed", { passed: out.filter((s) => s.passed).length, total: out.length, planned: toRun.length, truncated: 0, userRequested: true });
    return { simulations: out, notDeclared };
  }

  currentBlueprint(buildId: string): ContextLockAgentBlueprint {
    const row = this.deps.db
      .prepare(`SELECT document FROM studio_blueprints WHERE build_id = ? ORDER BY revision DESC LIMIT 1`)
      .get(buildId) as { document: string } | undefined;
    if (!row) throw new Error(`build ${buildId} has no blueprint`);
    return JSON.parse(row.document) as ContextLockAgentBlueprint;
  }

  /**
   * Editing the Blueprint bumps its revision, which is what makes every prior simulation and every
   * generated file STALE. Presenting an old green simulation next to an edited design would be
   * showing proof of something that is no longer the thing being built.
   */
  editBlueprint(buildId: string, patch: Partial<ContextLockAgentBlueprint>): { blueprint: ContextLockAgentBlueprint; issues: ValidationIssue[] } {
    const current = this.currentBlueprint(buildId);
    const next = { ...current, ...patch, revision: current.revision + 1, createdAt: now() };
    const validation = validateBlueprint(next);
    this.saveBlueprint(buildId, next, validation.issues);
    this.deps.bus.emit(buildId, "blueprint.updated", {
      revision: next.revision,
      buildable: validation.buildable,
      graph: projectGraph(next),
      staleSimulations: true,
      staleCode: true,
    });
    return { blueprint: next, issues: validation.issues };
  }

  private recordFinding(buildId: string, i: ValidationIssue, source: string): void {
    this.deps.db
      .prepare(
        `INSERT INTO studio_security_findings (build_id, code, severity, path, message, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(buildId, i.code, i.severity, i.path, i.message, source, now());
  }

  private recordTest(buildId: string, rev: number, suite: string, passed: number, failed: number, output: string): void {
    this.deps.db
      .prepare(
        `INSERT INTO studio_test_results (build_id, build_revision, suite, passed, failed, output, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(buildId, rev, suite, passed, failed, output, now());
  }

  private openIssues(buildId: string): ValidationIssue[] {
    return (
      this.deps.db
        .prepare(`SELECT code, severity, path, message FROM studio_security_findings WHERE build_id = ?`)
        .all(buildId) as Array<{ code: string; severity: string; path: string; message: string }>
    ).map((r) => ({ ...r, severity: r.severity as ValidationIssue["severity"], remediation: "" }));
  }

  private passedStudioTests(_buildId: string): string[] {
    // Studio's own STUDIO-* suite runs in CI, not per build. The score reads it from the recorded
    // evidence file rather than inferring it, so a build cannot award itself coverage points.
    return [];
  }

  private setStage(buildId: string, stage: BuildStage): void {
    this.deps.db.prepare(`UPDATE studio_builds SET stage = ?, updated_at = ? WHERE id = ?`).run(stage, now(), buildId);
  }

  private setStatus(buildId: string, status: BuildStatus, reason?: string): void {
    this.deps.db
      .prepare(`UPDATE studio_builds SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?`)
      .run(status, reason ?? null, now(), buildId);
  }

  private rowOf(r: Record<string, unknown>): BuildRow {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      userId: r.user_id as string,
      stage: r.stage as BuildStage,
      status: r.status as BuildStatus,
      blueprintRevision: (r.blueprint_revision as number) ?? null,
      buildRevision: r.build_revision as number,
      repairCycles: r.repair_cycles as number,
      approvedAt: (r.approved_at as string) ?? null,
      failureReason: (r.failure_reason as string) ?? null,
    };
  }

  get(buildId: string): BuildRow | undefined {
    const r = this.deps.db.prepare(`SELECT * FROM studio_builds WHERE id = ?`).get(buildId) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowOf(r) : undefined;
  }

  private require(buildId: string): BuildRow {
    const b = this.get(buildId);
    if (!b) throw new Error(`no such build: ${buildId}`);
    return b;
  }
}
