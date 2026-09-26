import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { projectGraph, computeSecurityScore, validateBlueprint } from "@contextlock/studio-blueprint";
import type { SimulationResult } from "@contextlock/studio-simulation";
import { openStudioDb, type DB } from "./db.js";
import { StudioEventBus } from "./events.js";
import { QuotaManager, QuotaExceededError } from "./quota.js";
import { StudioPipeline, type PipelineDeps } from "./pipeline.js";
import { buildExport, ExportContainsSecretError, ExportTooLargeError } from "./export.js";
import { SERVER, DEFAULT_QUOTA, STUDIO_MODEL } from "./config.js";
import { registeredSandboxProviders } from "./sandbox/provider.js";
import { projectOrgGraph, type Organization } from "@contextlock/studio-org";
import { memberPrompt, proposalToOrganization, compileOrganization, reconcileUnknowns } from "./organization.js";
import { runOrganization, type OrganizationProposal } from "./agents/roles.js";
import {
  ExecutionPlanSchema, projectPlanGraph, generatePlanScenarios, planHash, capabilityScopeFor,
  derivePlanState, runnableSteps,
} from "@contextlock/studio-plan";
import { registerControlPlaneRoutes, type ControlPlaneDeps } from "./control/api.js";
import { registerLabRoutes, type LabApiDeps } from "./lab/api.js";
import { registerForkRoutes } from "./fork/api.js";
import { registerProjectRoutes } from "./projects.js";
import type { ForkLabService } from "./fork/service.js";

/**
 * Studio HTTP API.
 *
 * Two things are deliberate.
 *
 * A build's lifetime lives here and in the database, never in a browser connection. Every endpoint
 * reads persisted state, so closing a tab, switching views or reloading cannot affect a running
 * build — it can only affect what someone is looking at.
 *
 * The user identity comes from the authenticated session, never from the request body. A
 * client-supplied user id would make every per-user quota advisory.
 */

export interface BuildApiDeps {
  db?: DB;
  pipelineFactory?: (deps: PipelineDeps) => StudioPipeline;
  agents?: PipelineDeps["agents"];
  sandboxProviderId?: string;
  /** Injectable for tests. In production this reads the authenticated session. */
  resolveUserId?: (req: { headers: Record<string, unknown> }) => string;
  /** Injectable so organization tests do not spend model tokens. */
  organizationAgent?: (prompt: string) => Promise<OrganizationProposal>;
  /**
   * The P25 control plane.
   *
   * Absent by default. Its routes answer questions about live chain, CRE and runtime state, and
   * mounting them without configured observers would produce an API that reports on a system
   * nobody is watching.
   */
  controlPlane?: ControlPlaneDeps;
  /**
   * The P28 Testnet Lab.
   *
   * Attached when its readers are configured, for the same reason the control plane is: the routes
   * project underlying state, and mounting them with stubs would produce a lifecycle that answers
   * questions about a project nobody is tracking.
   */
  /**
   * A factory over the db handle, because `buildServer` owns the connection. Passing the deps
   * directly would mean opening a second one, and two handles to one SQLite file is how a write
   * lands in a transaction nobody is watching.
   */
  lab?: (db: DB) => LabApiDeps;
  /**
   * The fork lab: deployments to a local mainnet fork, and the control plane over them.
   *
   * Built from the db and the Lab deps, because it reads Blueprints through the Lab's reader and
   * the Lab reads deployment state back through it. When present it also supplies the P25
   * control-plane deps, unless the caller configured those separately.
   */
  fork?: (db: DB, lab: LabApiDeps) => ForkLabService;
}

const CreateBuildBody = z.object({
  prompt: z.string().min(10).max(4000),
  name: z.string().max(120).optional(),
  idempotencyKey: z.string().max(120).optional(),
  /**
   * The ENS name the agent will be known by, when the user has one.
   *
   * Optional here, unlike an organization's root, because a single agent can be designed and
   * simulated without a name — but when it is given it is authoritative, and the model's guess is
   * never used over it. A name is the user's property, not a design decision.
   */
  ensName: z.string().max(253).regex(/^([a-z0-9-]+\.)+eth$/, "expected a lowercase .eth name, e.g. guardian.acme.eth").optional(),
});

export function buildServer(deps: BuildApiDeps = {}): {
  app: FastifyInstance;
  db: DB;
  pipeline: StudioPipeline;
  bus: StudioEventBus;
  quota: QuotaManager;
  fork: ForkLabService | null;
} {
  const db = deps.db ?? openStudioDb(SERVER.dbUrl);
  const bus = new StudioEventBus(db);
  const quota = new QuotaManager(db, DEFAULT_QUOTA);
  const pipelineDeps: PipelineDeps = {
    db,
    bus,
    quota,
    ...(deps.agents ? { agents: deps.agents } : {}),
    ...(deps.sandboxProviderId ? { sandboxProviderId: deps.sandboxProviderId } : {}),
  };
  const pipeline = deps.pipelineFactory ? deps.pipelineFactory(pipelineDeps) : new StudioPipeline(pipelineDeps);

  const app = Fastify({ logger: false });

  const userIdOf = (req: { headers: Record<string, unknown> }) =>
    deps.resolveUserId ? deps.resolveUserId(req) : String(req.headers["x-studio-user"] ?? "local-user");

  /* Simple per-user abuse limits, in memory. Quotas that must survive a restart live in the DB. */
  const lastCreate = new Map<string, number>();
  const promptHits = new Map<string, number[]>();

  const labDeps = deps.lab ? deps.lab(db) : null;
  const fork = labDeps && deps.fork ? deps.fork(db, labDeps) : null;
  const controlPlane = deps.controlPlane ?? fork?.controlPlaneDeps() ?? null;

  app.get("/api/studio/health", async () => ({
    ok: true,
    model: STUDIO_MODEL,
    sandboxProviders: registeredSandboxProviders(),
    limits: DEFAULT_QUOTA,
    controlPlane: controlPlane ? "attached" : "not configured",
    lab: labDeps ? "attached" : "not configured",
    fork: fork ? "attached" : "not configured",
  }));

  /*
   * The P25 control plane, attached only when its observers are configured.
   *
   * Conditional because the routes are useless without live chain, CRE and runtime observers, and
   * mounting them with stubs would produce an API that answers questions about a system nobody is
   * watching — which is worse than a 404. The fork lab is one such configuration: its observers
   * read a fork this process is running.
   */
  if (controlPlane) registerControlPlaneRoutes(app, controlPlane);

  /* The P28 Testnet Lab, on the same terms. */
  if (labDeps) registerLabRoutes(app, labDeps);

  /* The fork lab: needs the Lab's readers for its gates. */
  if (labDeps && fork) registerForkRoutes(app, { service: fork, lab: labDeps });

  /* The project index the frontend navigates by. */
  registerProjectRoutes(app, { db, userIdOf: userIdOf as never, fork: () => fork });

  app.post("/api/studio/builds", async (req, reply) => {
    const userId = userIdOf(req as never);
    const parsed = CreateBuildBody.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid body", detail: parsed.error.issues });

    /*
     * Idempotency is resolved BEFORE any rate limit.
     *
     * A retry carrying the same key is the same request, not a second one — and the client most
     * likely to retry is one that never saw the first response. Rate-limiting it produced a 429 for
     * a build that already existed, which is both wrong and the least helpful possible answer.
     */
    if (parsed.data.idempotencyKey) {
      const existing = pipeline.findByIdempotencyKey(parsed.data.idempotencyKey);
      if (existing) {
        if (existing.userId !== userId) return reply.code(409).send({ error: "idempotency key belongs to another user" });
        return reply.code(200).send(existing);
      }
    }

    const now = Date.now();
    const last = lastCreate.get(userId) ?? 0;
    if (now - last < DEFAULT_QUOTA.buildCreationCooldownMs) {
      return reply.code(429).send({ error: "build creation cooldown", retryAfterMs: DEFAULT_QUOTA.buildCreationCooldownMs - (now - last) });
    }
    const hits = (promptHits.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= DEFAULT_QUOTA.promptInteractionsPerMinute) {
      return reply.code(429).send({ error: "too many Studio interactions" });
    }
    promptHits.set(userId, [...hits, now]);

    try {
      const build = pipeline.createBuild({ userId, ...parsed.data });
      lastCreate.set(userId, now);
      return reply.code(201).send(build);
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        return reply.code(429).send({ error: e.message, kind: e.kind, used: e.used, limit: e.limit });
      }
      throw e;
    }
  });

  /** Runs requirements → blueprint → security, then STOPS at the approval boundary. */
  app.post<{ Params: { id: string } }>("/api/studio/builds/:id/design", async (req, reply) => {
    try {
      const { blueprint, issues } = await pipeline.runToApproval(req.params.id);
      return reply.send({
        build: pipeline.get(req.params.id),
        blueprint,
        issues,
        graph: projectGraph(blueprint),
        usage: quota.snapshot(req.params.id),
      });
    } catch (e) {
      if (e instanceof QuotaExceededError) return reply.code(429).send({ error: e.message, kind: e.kind });
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string }; Body: { acknowledgeFindings?: string[] } }>(
    "/api/studio/builds/:id/approve",
    async (req, reply) => {
      try {
        pipeline.approve(req.params.id, req.body?.acknowledgeFindings ?? []);
        return reply.send({ build: pipeline.get(req.params.id) });
      } catch (e) {
        const err = e as Error & { unacknowledged?: unknown };
        return reply.code(409).send({ error: err.message, unacknowledged: err.unacknowledged ?? null });
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/studio/builds/:id/build", async (req, reply) => {
    try {
      const r = await pipeline.runBuild(req.params.id);
      return reply.send({ build: pipeline.get(req.params.id), ...r });
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message, name: (e as Error).name });
    }
  });

  /** Let go of a build the user has decided against, freeing the concurrency slot. */
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/api/studio/builds/:id/abandon",
    async (req, reply) => {
      const build = pipeline.get(req.params.id);
      if (!build) return reply.code(404).send({ error: "no such build" });
      if (build.userId !== userIdOf(req as never)) return reply.code(404).send({ error: "no such build" });
      try {
        pipeline.abandon(req.params.id, req.body?.reason ?? "abandoned by the user");
        return reply.send({ build: pipeline.get(req.params.id) });
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );

  /**
   * Re-run scenarios on demand, charged to the user's simulation allowance.
   *
   * The mandatory pass already ran during the build; this exists for a person exploring a design —
   * "run these three again" — and its results are recorded as USER_REQUESTED so they never masquerade
   * as the security pass. A scenario the Blueprint does not declare is refused by name.
   */
  app.post<{ Params: { id: string }; Body: { scenarioIds?: string[] } | null }>("/api/studio/builds/:id/simulate", async (req, reply) => {
    const build = pipeline.get(req.params.id);
    if (!build) return reply.code(404).send({ error: "no such build" });
    if (build.userId !== userIdOf(req as never)) return reply.code(404).send({ error: "no such build" });
    try {
      const r = await pipeline.runUserSimulations(req.params.id, req.body?.scenarioIds ?? null);
      return reply.send({ ...r, usage: quota.snapshot(req.params.id) });
    } catch (e) {
      if (e instanceof QuotaExceededError) return reply.code(429).send({ error: e.message, kind: e.kind, used: e.used, limit: e.limit });
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.patch<{ Params: { id: string } }>("/api/studio/builds/:id/blueprint", async (req, reply) => {
    try {
      const { blueprint, issues } = pipeline.editBlueprint(req.params.id, (req.body ?? {}) as never);
      return reply.send({ blueprint, issues, graph: projectGraph(blueprint) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /**
   * The whole build, reconstructed from persisted state.
   *
   * This is what makes a browser refresh a non-event: everything the UI shows comes from here, so
   * a reload cannot lose anything a subscriber would have seen.
   */
  app.get<{ Params: { id: string } }>("/api/studio/builds/:id", async (req, reply) => {
    const build = pipeline.get(req.params.id);
    if (!build) return reply.code(404).send({ error: "no such build" });

    let blueprint = null;
    let graph = null;
    try {
      blueprint = pipeline.currentBlueprint(req.params.id);
      graph = projectGraph(blueprint);
    } catch {
      /* design stage has not produced a blueprint yet */
    }

    const sims = (
      db
        .prepare(`SELECT result FROM studio_simulations WHERE build_id = ? ORDER BY id`)
        .all(req.params.id) as Array<{ result: string }>
    ).map((r) => JSON.parse(r.result) as SimulationResult);

    const files = db
      .prepare(
        `SELECT path, bytes, build_revision AS buildRevision, blueprint_revision AS blueprintRevision
         FROM studio_artifacts WHERE build_id = ? ORDER BY build_revision DESC, path`,
      )
      .all(req.params.id) as Array<{ path: string; bytes: number; buildRevision: number; blueprintRevision: number }>;

    const findings = db
      .prepare(`SELECT code, severity, path, message, source FROM studio_security_findings WHERE build_id = ? ORDER BY id`)
      .all(req.params.id) as Array<Record<string, string>>;

    const tests = db
      .prepare(`SELECT suite, passed, failed, build_revision AS buildRevision FROM studio_test_results WHERE build_id = ? ORDER BY id`)
      .all(req.params.id);

    /*
     * Staleness is computed here rather than trusted from a stored flag. A result is current only
     * if it was produced against BOTH the current blueprint revision and the current build
     * revision; anything else is presented as stale, never as proof of the present design.
     */
    const currentBlueprintRevision = blueprint?.revision ?? null;
    const staleSimulations = sims.filter(
      (s) => s.blueprintRevision !== currentBlueprintRevision || s.buildRevision !== build.buildRevision,
    ).length;

    const score = blueprint
      ? computeSecurityScore(blueprint, {
          passedTests: [],
          passedScenarios: sims
            .filter((s) => s.passed && s.blueprintRevision === currentBlueprintRevision && s.buildRevision === build.buildRevision)
            .map((s) => s.scenarioId),
          issues: validateBlueprint(blueprint).issues,
        })
      : null;

    return reply.send({
      /*
       * `projectId` travels with the build so the Lab lifecycle can be read for the project on
       * screen. Without it the client would have to guess which project a build belongs to, and a
       * guessed project id is a lifecycle about the wrong agent.
       */
      build: { ...build, projectId: build.projectId },
      blueprint,
      graph,
      simulations: sims.map((s) => ({
        ...s,
        stale: s.blueprintRevision !== currentBlueprintRevision || s.buildRevision !== build.buildRevision,
      })),
      staleSimulations,
      // Stale on either axis: a newer build revision exists, or the Blueprint moved on beneath the
      // code that is being shown.
      codeStale:
        files.length > 0 &&
        (files[0]!.buildRevision !== build.buildRevision ||
          files[0]!.blueprintRevision !== currentBlueprintRevision),
      files,
      findings,
      tests,
      score,
      usage: quota.snapshot(req.params.id),
      events: bus.history(req.params.id).length,
    });
  });

  /* ─────────────────────── organizations ─────────────────────── */

  const CreateOrgBody = z.object({
    prompt: z.string().min(10).max(4000),
    name: z.string().max(120).optional(),
    /**
     * The ENS root the user already controls. Authoritative over anything the model proposed —
     * a namespace is the user's property, not a design decision the Studio gets to make.
     */
    rootEns: z.string().max(120).optional(),
  });

  const readOrg = (id: string, userId: string): Organization | null => {
    const row = db.prepare(`SELECT user_id, doc FROM studio_organizations WHERE id = ?`).get(id) as
      | { user_id: string; doc: string }
      | undefined;
    if (!row || row.user_id !== userId) return null;
    return JSON.parse(row.doc) as Organization;
  };

  /**
   * Design an organization from a prompt.
   *
   * The model proposes; deterministic code translates and validates. A proposal that omits a
   * financial ceiling is rejected here with the exact field, rather than completed with a value
   * nobody chose.
   */
  app.post("/api/studio/organizations", async (req, reply) => {
    const userId = userIdOf(req as never);
    const parsed = CreateOrgBody.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid body", detail: parsed.error.issues });

    const now = Date.now();
    const hits = (promptHits.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= DEFAULT_QUOTA.promptInteractionsPerMinute) {
      return reply.code(429).send({ error: "too many Studio interactions" });
    }
    promptHits.set(userId, [...hits, now]);

    const proposal = deps.organizationAgent
      ? await deps.organizationAgent(parsed.data.prompt)
      : (await runOrganization(parsed.data.prompt)).output;

    const orgId = `org-${randomUUID()}`;
    const t = proposalToOrganization(proposal, orgId, 1, parsed.data.rootEns);
    if (!t.ok) return reply.code(422).send({ error: "organization is not buildable", problems: t.problems });

    const artifacts = compileOrganization(t.org);
    const ts = new Date().toISOString();
    db.prepare(
      `INSERT INTO studio_organizations (id, user_id, name, prompt, revision, doc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(orgId, userId, parsed.data.name ?? proposal.orgName, parsed.data.prompt, 1, JSON.stringify(t.org), ts, ts);

    return reply.code(201).send({
      id: orgId,
      buildable: artifacts.buildable,
      organization: t.org,
      issues: artifacts.issues,
      graph: projectOrgGraph(t.org),
      scenarios: artifacts.scenarios,
      blastRadii: artifacts.blastRadii,
      rationale: proposal.rationale,
      unknowns: reconcileUnknowns(proposal.unknowns, t.org, (parsed.data.rootEns ?? "").trim() !== ""),
    });
  });

  /** The builds started for an organization's members, by member id. */
  const memberBuilds = (orgId: string): Record<string, { buildId: string; projectId: string; stage: string; status: string }> => {
    const rows = db
      .prepare(`SELECT id, project_id, stage, status, idempotency_key FROM studio_builds WHERE idempotency_key LIKE ? ORDER BY created_at ASC`)
      .all(`org:${orgId}:%`) as Array<{ id: string; project_id: string; stage: string; status: string; idempotency_key: string }>;
    const out: Record<string, { buildId: string; projectId: string; stage: string; status: string }> = {};
    for (const r of rows) out[r.idempotency_key.slice(`org:${orgId}:`.length)] = { buildId: r.id, projectId: r.project_id, stage: r.stage, status: r.status };
    return out;
  };

  app.get<{ Params: { id: string } }>("/api/studio/organizations/:id", async (req, reply) => {
    const org = readOrg(req.params.id, userIdOf(req as never));
    if (!org) return reply.code(404).send({ error: "no such organization" });
    const artifacts = compileOrganization(org);
    return reply.send({
      id: org.orgId,
      buildable: artifacts.buildable,
      organization: org,
      issues: artifacts.issues,
      graph: projectOrgGraph(org),
      scenarios: artifacts.scenarios,
      blastRadii: artifacts.blastRadii,
      memberBuilds: memberBuilds(org.orgId),
    });
  });

  /**
   * Build one member of an organization.
   *
   * A member is a design until it is built; building it is an ordinary single-agent build whose
   * prompt is derived from the member's role, limits and name (`memberPrompt`). One build per
   * member: the idempotency key is the member's, so a second click returns the first build. The
   * organization's own prompt travels as context so the requirements stage knows the protocol.
   */
  app.post<{ Params: { id: string; agentId: string } }>("/api/studio/organizations/:id/agents/:agentId/build", async (req, reply) => {
    const userId = userIdOf(req as never);
    const org = readOrg(req.params.id, userId);
    if (!org) return reply.code(404).send({ error: "no such organization" });
    const agent = org.agents.find((a) => a.id === req.params.agentId);
    if (!agent) return reply.code(404).send({ error: "no such member" });
    const row = db.prepare(`SELECT prompt FROM studio_organizations WHERE id = ?`).get(org.orgId) as { prompt: string } | undefined;
    try {
      const build = pipeline.createBuild({
        userId,
        prompt: memberPrompt(org, agent, row?.prompt ?? ""),
        name: `${agent.displayName} (${org.rootEns})`,
        ensName: agent.ensName,
        idempotencyKey: `org:${org.orgId}:${agent.id}`,
      });
      return reply.code(201).send({ build, prompt: memberPrompt(org, agent, row?.prompt ?? "") });
    } catch (e) {
      if (e instanceof QuotaExceededError) return reply.code(429).send({ error: e.message, kind: e.kind, used: e.used, limit: e.limit });
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  /* ─────────────────────── execution plans ─────────────────────── */

  /**
   * Compile an execution plan into its three projections.
   *
   * Stateless: a plan is a document, and the interesting output is entirely derived from it. The
   * per-step capability scopes are returned so a reviewer can see that each one names exactly one
   * step — that is the claim P19.3 makes, and it should be visible rather than asserted.
   */
  app.post("/api/studio/plans/compile", async (req, reply) => {
    const parsed = ExecutionPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "invalid execution plan", detail: parsed.error.issues });
    }
    const plan = parsed.data;
    return reply.send({
      planHash: planHash(plan),
      state: derivePlanState(plan),
      runnable: runnableSteps(plan).map((s) => s.stepId),
      graph: projectPlanGraph(plan),
      scenarios: generatePlanScenarios(plan),
      stepAuthorizations: plan.steps.map((s) => ({
        stepId: s.stepId,
        chainId: s.chainId,
        disposition: s.authorizationRequirement.disposition,
        valueUsdCents: s.authorizationRequirement.valueUsdCents,
        capabilityScope: capabilityScopeFor(plan, s.stepId),
      })),
    });
  });

  app.get<{ Params: { id: string; "*": string } }>("/api/studio/builds/:id/files/*", async (req, reply) => {
    const path = (req.params as Record<string, string>)["*"];
    const row = db
      .prepare(
        `SELECT content FROM studio_artifacts WHERE build_id = ? AND path = ?
         ORDER BY build_revision DESC LIMIT 1`,
      )
      .get(req.params.id, path) as { content: string } | undefined;
    if (!row) return reply.code(404).send({ error: "no such file" });
    return reply.type("text/plain; charset=utf-8").send(row.content);
  });

  /** SSE. Replays history first, then streams — so a late subscriber misses nothing. */
  app.get<{ Params: { id: string }; Querystring: { afterSeq?: string } }>(
    "/api/studio/builds/:id/events",
    async (req, reply) => {
      const buildId = req.params.id;
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const send = (e: { seq: number; type: string; payload: unknown }) => {
        reply.raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`);
      };

      for (const e of bus.history(buildId, Number(req.query.afterSeq ?? 0))) send(e);

      const unsubscribe = bus.subscribe(buildId, send);
      const keepAlive = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15_000);

      req.raw.on("close", () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
      // Never resolves: the connection stays open until the client closes it. The build is
      // unaffected either way — it lives in the pipeline, not in this handler.
      await new Promise(() => {});
    },
  );

  app.get<{ Params: { id: string } }>("/api/studio/builds/:id/export", async (req, reply) => {
    const buildId = req.params.id;
    const build = pipeline.get(buildId);
    if (!build) return reply.code(404).send({ error: "no such build" });

    let blueprint;
    try {
      blueprint = pipeline.currentBlueprint(buildId);
    } catch {
      return reply.code(409).send({ error: "build has no blueprint to export" });
    }

    const sims = (
      db.prepare(`SELECT result FROM studio_simulations WHERE build_id = ? ORDER BY id`).all(buildId) as Array<{
        result: string;
      }>
    ).map((r) => JSON.parse(r.result) as SimulationResult);

    const score = computeSecurityScore(blueprint, {
      passedTests: [],
      passedScenarios: sims.filter((s) => s.passed).map((s) => s.scenarioId),
      issues: validateBlueprint(blueprint).issues,
    });

    try {
      const files = buildExport({ db, buildId, blueprint, simulations: sims, score });
      return reply.send({ buildId, files, totalBytes: files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) });
    } catch (e) {
      if (e instanceof ExportContainsSecretError) {
        return reply.code(409).send({ error: e.message, matches: e.matches });
      }
      if (e instanceof ExportTooLargeError) return reply.code(413).send({ error: e.message });
      throw e;
    }
  });

  return { app, db, pipeline, bus, quota, fork };
}
