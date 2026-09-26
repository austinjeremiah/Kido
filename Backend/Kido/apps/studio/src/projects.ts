import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "./db.js";
import type { ForkLabService } from "./fork/service.js";
import { buildRegistry } from "./adapters.js";
import type { Organization } from "@contextlock/studio-org";

/**
 * Projects, as the frontend sees them.
 *
 * The build pipeline addresses everything by build id, and the Lab by project id; nothing listed a
 * user's projects or said which build a project currently has. These routes are the missing index:
 * read-only projections over `studio_projects`, `studio_builds`, `studio_organizations` and the
 * fork lab, keyed by the authenticated user. No route here creates, deploys or activates anything —
 * a project is created by starting a build, and every mutation keeps living where it did.
 */

export interface ProjectBuildSummary {
  buildId: string;
  stage: string;
  status: string;
  blueprintRevision: number | null;
  buildRevision: number;
  updatedAt: string;
}

export interface ProjectSummaryRow {
  id: string;
  name: string;
  prompt: string;
  ensName: string | null;
  createdAt: string;
  updatedAt: string;
  build: ProjectBuildSummary | null;
  /** Set when the project is one member of an organization. */
  organization: { orgId: string; agentId: string; name: string; rootEns: string } | null;
  /** The fork deployment the project's lifecycle currently reads, if one exists. */
  deployment: { deploymentId: string; state: string; live: boolean } | null;
}

export interface OrganizationSummaryRow {
  id: string;
  name: string;
  rootEns: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  agents: Array<{ id: string; displayName: string; ensName: string; projectId: string | null; buildId: string | null; stage: string | null; status: string | null }>;
}

export interface ProjectRoutesDeps {
  db: DB;
  userIdOf: (req: { headers: Record<string, unknown> }) => string;
  fork: () => ForkLabService | null;
}

interface BuildRowRaw {
  id: string; project_id: string; stage: string; status: string; blueprint_revision: number | null;
  build_revision: number; idempotency_key: string | null; updated_at: string;
}

const ORG_KEY = /^org:(org-[0-9a-f-]+):(.+)$/;

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRoutesDeps): void {
  const { db } = deps;

  const latestBuildFor = (projectId: string): BuildRowRaw | undefined =>
    db.prepare(`SELECT * FROM studio_builds WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`).get(projectId) as BuildRowRaw | undefined;

  const orgRow = (orgId: string): { id: string; user_id: string; name: string; doc: string; revision: number; created_at: string; updated_at: string } | undefined =>
    db.prepare(`SELECT * FROM studio_organizations WHERE id = ?`).get(orgId) as never;

  const membership = (build: BuildRowRaw | undefined): ProjectSummaryRow["organization"] => {
    const m = build?.idempotency_key?.match(ORG_KEY);
    if (!m) return null;
    const org = orgRow(m[1]!);
    if (!org) return null;
    const doc = JSON.parse(org.doc) as Organization;
    return { orgId: org.id, agentId: m[2]!, name: org.name, rootEns: doc.rootEns };
  };

  const deploymentFor = (projectId: string): ProjectSummaryRow["deployment"] => {
    /*
     * A row written by an earlier record schema fails to parse. That is a fact about that old
     * deployment, not about this project's listing — so it is reported as "no current deployment"
     * here rather than taking the whole index down with it.
     */
    try {
      const d = deps.fork()?.currentForProject(projectId) ?? null;
      return d ? { deploymentId: d.deploymentId, state: d.state, live: d.live.fork } : null;
    } catch {
      return null;
    }
  };

  const project = (row: { id: string; name: string; prompt: string; ens_name: string | null; created_at: string }): ProjectSummaryRow => {
    const build = latestBuildFor(row.id);
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      ensName: row.ens_name ?? null,
      createdAt: row.created_at,
      updatedAt: build?.updated_at ?? row.created_at,
      build: build
        ? { buildId: build.id, stage: build.stage, status: build.status, blueprintRevision: build.blueprint_revision, buildRevision: build.build_revision, updatedAt: build.updated_at }
        : null,
      organization: membership(build),
      deployment: deploymentFor(row.id),
    };
  };

  const organization = (row: NonNullable<ReturnType<typeof orgRow>>): OrganizationSummaryRow => {
    const doc = JSON.parse(row.doc) as Organization;
    const builds = db
      .prepare(`SELECT * FROM studio_builds WHERE idempotency_key LIKE ? ORDER BY created_at ASC`)
      .all(`org:${row.id}:%`) as BuildRowRaw[];
    const byAgent = new Map(builds.map((b) => [b.idempotency_key!.slice(`org:${row.id}:`.length), b]));
    return {
      id: row.id,
      name: row.name,
      rootEns: doc.rootEns,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      agents: doc.agents.map((a) => {
        const b = byAgent.get(a.id);
        return { id: a.id, displayName: a.displayName, ensName: a.ensName, projectId: b?.project_id ?? null, buildId: b?.id ?? null, stage: b?.stage ?? null, status: b?.status ?? null };
      }),
    };
  };

  /** Every project and organization the caller owns, newest activity first. */
  app.get("/api/studio/projects", async (req) => {
    const userId = deps.userIdOf(req as never);
    const rows = db
      .prepare(`SELECT id, name, prompt, ens_name, created_at FROM studio_projects WHERE user_id = ? ORDER BY created_at DESC`)
      .all(userId) as Array<{ id: string; name: string; prompt: string; ens_name: string | null; created_at: string }>;
    const orgs = db
      .prepare(`SELECT * FROM studio_organizations WHERE user_id = ? ORDER BY created_at DESC`)
      .all(userId) as Array<NonNullable<ReturnType<typeof orgRow>>>;
    const projects = rows.map(project).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return { projects, organizations: orgs.map(organization) };
  });

  /** One project, with its current build and — when it is a member — its organization. */
  app.get<{ Params: { id: string } }>("/api/studio/projects/:id", async (req, reply) => {
    const userId = deps.userIdOf(req as never);
    const row = db
      .prepare(`SELECT id, name, prompt, ens_name, created_at FROM studio_projects WHERE id = ? AND user_id = ?`)
      .get(req.params.id, userId) as { id: string; name: string; prompt: string; ens_name: string | null; created_at: string } | undefined;
    if (!row) return reply.code(404).send({ error: "no such project" });
    const p = project(row);
    const org = p.organization ? orgRow(p.organization.orgId) : undefined;
    return { project: p, organization: org ? organization(org) : null };
  });

  const RenameBody = z.object({ name: z.string().min(1).max(120) });

  /** Rename. The only mutable field a project has that is not a design decision. */
  app.patch<{ Params: { id: string } }>("/api/studio/projects/:id", async (req, reply) => {
    const userId = deps.userIdOf(req as never);
    const parsed = RenameBody.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid body", detail: parsed.error.issues });
    const r = db.prepare(`UPDATE studio_projects SET name = ? WHERE id = ? AND user_id = ?`).run(parsed.data.name, req.params.id, userId);
    if (r.changes === 0) return reply.code(404).send({ error: "no such project" });
    return { ok: true };
  });

  /**
   * The adapter registry, as manifests.
   *
   * Read-only and public: a manifest names an adapter's provider, trust class, chains, auth MODE and
   * the secret NAMES it needs — never a value. The Integrations screen is a projection of exactly this.
   */
  app.get<{ Querystring: { chainId?: string } }>("/api/studio/adapters", async (req) => {
    const registry = buildRegistry();
    const chainId = req.query.chainId ? Number(req.query.chainId) : null;
    const manifests = registry.list().filter((m) => chainId === null || m.supportedChains.includes(chainId));
    return {
      adapters: manifests.map((m) => ({
        id: m.id,
        version: m.version,
        adapterType: m.adapterType,
        name: m.name,
        description: m.description,
        provider: m.provider,
        supportedChains: m.supportedChains,
        capabilities: m.capabilities,
        trustClass: m.trustClass,
        freshnessSemantics: m.freshnessSemantics,
        auth: m.auth,
        executionPlacement: m.executionPlacement,
        safety: m.safety,
        generatedModules: m.generatedModules,
        simulationProviders: m.simulationProviders,
        securityAssertions: m.securityAssertions,
        documentation: m.documentation,
      })),
    };
  });
}
