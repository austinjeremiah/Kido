import type { FastifyInstance } from "fastify";
import { assertPublicSafe } from "@contextlock/studio-events";
import type { ForkLabService } from "./service.js";
import type { LabApiDeps } from "../lab/api.js";

/**
 * The fork lab's HTTP surface.
 *
 * Deployments to a local mainnet fork, and the position the agent guards there. The deployed-agent
 * console itself reads the P25 control-plane routes, which this lab backs; these routes cover what
 * that console has no concept of — starting a fork, watching the deployment, stressing the
 * position, and the performance samples the runtime keeps.
 *
 * Every response is scanned before it leaves, as the other surfaces are.
 */

function safe<T>(payload: T): T {
  assertPublicSafe(payload, "api-response");
  return payload;
}

export interface ForkApiDeps {
  service: ForkLabService;
  lab: LabApiDeps;
}

export function registerForkRoutes(app: FastifyInstance, deps: ForkApiDeps): void {
  const { service } = deps;

  app.get<{ Params: { id: string } }>("/api/fork/projects/:id/readiness", async (req, reply) => {
    const inputs = await deps.lab.readInputs(req.params.id);
    if (!inputs) return reply.code(404).send({ error: "unknown project" });
    const cre = await deps.lab.readCre(req.params.id);
    return safe(await service.readiness(req.params.id, {
      architecturePassed: inputs.build?.status === "COMPLETED",
      securityTestsPassed: inputs.deterministicSimulationsPassed,
      creSimulationPassed: inputs.creSimulationPassed,
      creSimulationDetail: inputs.creSimulationPassed
        ? `The official Chainlink CRE CLI simulation passed under production limits${cre?.workflowBinaryHash ? ` (binary ${cre.workflowBinaryHash.slice(0, 16)}…)` : ""}`
        : "The official CRE simulation has not passed for this project — run it above",
    }));
  });

  app.post<{ Params: { id: string }; Body: { buildId?: string | null; approverAddress?: string | null } | null }>("/api/fork/projects/:id/deploy", async (req, reply) => {
    const inputs = await deps.lab.readInputs(req.params.id);
    if (!inputs) return reply.code(404).send({ error: "unknown project" });
    const readiness = await service.readiness(req.params.id, {
      architecturePassed: inputs.build?.status === "COMPLETED",
      securityTestsPassed: inputs.deterministicSimulationsPassed,
      creSimulationPassed: inputs.creSimulationPassed,
      creSimulationDetail: "",
    });
    // The gates are re-checked here, not trusted from the screen that showed them.
    if (!readiness.canDeploy) return reply.code(409).send({ error: "not ready to deploy", blockedBy: readiness.blockedBy });
    try {
      return safe(await service.deploy(req.params.id, req.body?.buildId ?? null, { approverAddress: (req.body?.approverAddress as `0x${string}` | null | undefined) ?? null }));
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/fork/projects/:id/deployments", async (req) =>
    safe({ deployments: service.listForProject(req.params.id) }));

  app.get<{ Params: { id: string } }>("/api/fork/deployments/:id", async (req, reply) => {
    const d = service.get(req.params.id);
    if (!d) return reply.code(404).send({ error: "unknown deployment" });
    return safe(d);
  });

  app.get<{ Params: { id: string } }>("/api/fork/deployments/:id/position", async (req, reply) => {
    const p = await service.position(req.params.id);
    if (!p) return reply.code(404).send({ error: "unknown deployment" });
    return safe(p);
  });

  app.post<{ Params: { id: string } }>("/api/fork/deployments/:id/tick", async (req, reply) => {
    const d = service.get(req.params.id);
    if (!d) return reply.code(404).send({ error: "unknown deployment" });
    const sample = await service.tickNow(req.params.id);
    return safe({ sample, live: d.live });
  });

  app.post<{ Params: { id: string }; Body: { driverId?: string; option?: string; value?: number } | null }>("/api/fork/deployments/:id/stress", async (req, reply) => {
    const d = service.get(req.params.id);
    if (!d) return reply.code(404).send({ error: "unknown deployment" });
    try {
      const r = await service.stress(req.params.id, String(req.body?.driverId ?? ""), String(req.body?.option ?? ""), Number(req.body?.value ?? NaN));
      return safe({ ...r, note: "An operator moved the position. The agent may only take its Blueprint's actions; watch what it does next." });
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  /**
   * A human signs an escalation.
   *
   * The signer is the deployment's approver key — a stand-in generated for this fork, never a
   * Ledger device (BLK-002) — and the response says so. The executor consumes the approval when
   * it runs the steps; nothing here can make a DENY executable.
   */
  app.post<{ Params: { id: string; correlationId: string }; Body: { signatures?: Array<{ capabilityDigest: string; expiresAt: number; signature: string }> } | null }>("/api/fork/deployments/:id/approvals/:correlationId", async (req, reply) => {
    const d = service.get(req.params.id);
    if (!d) return reply.code(404).send({ error: "unknown deployment" });
    try {
      const sigs = req.body?.signatures?.map((s) => ({ capabilityDigest: s.capabilityDigest as `0x${string}`, expiresAt: Number(s.expiresAt), signature: s.signature as `0x${string}` })) ?? null;
      const exec = await service.approve(req.params.id, req.params.correlationId, sigs);
      const signer = d.record.approverMode === "WALLET"
        ? `the operator's connected wallet ${d.record.roles.approver} (EIP-712, signed in the wallet; the ContextLock Key Ring is not attached — BLK-002)`
        : "stand-in approver key — NOT a Ledger device (BLK-002)";
      return safe({ execution: exec, signer, approverMode: d.record.approverMode });
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  /**
   * What the wallet signs to approve an escalation.
   *
   * A GET that returns typed data, not a POST that signs anything: the server holds no key for a
   * WALLET deployment, and this is the whole of what leaves it — the registry's domain, the one
   * type, and a message per step. The signatures come back through the POST above.
   */
  app.get<{ Params: { id: string; correlationId: string } }>("/api/fork/deployments/:id/approvals/:correlationId/typed-data", async (req, reply) => {
    const d = service.get(req.params.id);
    if (!d) return reply.code(404).send({ error: "unknown deployment" });
    try {
      return safe(await service.approvalTypedData(req.params.id, req.params.correlationId));
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string; correlationId: string }; Body: { reason?: string } | null }>("/api/fork/deployments/:id/approvals/:correlationId/decline", async (req, reply) => {
    const d = service.get(req.params.id);
    if (!d) return reply.code(404).send({ error: "unknown deployment" });
    try {
      await service.decline(req.params.id, req.params.correlationId, req.body?.reason ?? "declined by the operator");
      return safe({ declined: true });
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } | null }>("/api/fork/deployments/:id/stop", async (req, reply) => {
    const d = await service.stop(req.params.id, req.body?.reason ?? "stopped by the operator");
    if (!d) return reply.code(404).send({ error: "unknown deployment" });
    return safe(d);
  });
}
