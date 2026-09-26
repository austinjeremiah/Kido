import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { OperationalError, PolicyDenial, ReasonCode } from "@contextlock/protocol";
import { audit, AuditType, type DB } from "./db.js";
import type { Broker } from "./broker.js";

/**
 * Public agent-facing API.
 *
 * Two rules shape this surface:
 *  1. The agent supplies typed adapter PARAMETERS, never target or calldata. `.strict()` on the
 *     schema means an attempt to smuggle `target`/`calldata` is a 400, not a silently ignored
 *     field (API-003).
 *  2. Responses carry a machine-readable reason code and never expose private policy values or
 *     the issuer key.
 */

const createRequestSchema = z
  .object({
    agentEnsName: z.string().min(3).max(255),
    actionKind: z.string().min(1).max(64),
    adapterParams: z.record(z.string(), z.unknown()),
    policyId: z.string().min(1).max(64),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

function serialize(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(serialize);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, serialize(x)]));
  }
  return v;
}

export function buildApi(broker: Broker, db: DB): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async () => ({
    status: "ok",
    chainId: 11155111,
    capabilityIssuer: broker.issuerAddress,
  }));

  app.post("/v1/capability-requests", async (req, reply) => {
    const parsed = createRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // API-002 / API-003: malformed input, or an attempt to supply raw target/calldata on a
      // typed endpoint, is refused before any chain interaction happens.
      audit(db, null, AuditType.REQUEST_REJECTED_VALIDATION, {
        issues: parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return reply.code(400).send({
        reasonCode: ReasonCode.API_VALIDATION,
        message: "Invalid request body",
        issues: parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    try {
      const result = await broker.createRequest(parsed.data);
      const code = result.status === "ALLOWED" ? 201 : 200;
      return reply.code(code).send(serialize(result));
    } catch (e: unknown) {
      if (e instanceof PolicyDenial) {
        return reply.code(200).send({ status: "DENIED", reasonCode: e.code, message: e.message });
      }
      if (e instanceof OperationalError) {
        // Operational failure is NOT a policy denial. It fails closed and says so distinctly,
        // so an outage can never be read as a considered allow or a considered deny.
        return reply
          .code(503)
          .send({ status: "FAILED", reasonCode: e.code, message: "Upstream dependency unavailable" });
      }
      req.log?.error?.(e);
      return reply
        .code(500)
        .send({ status: "FAILED", reasonCode: ReasonCode.INTERNAL_INVARIANT, message: "Internal error" });
    }
  });

  app.get<{ Params: { id: string } }>("/v1/capability-requests/:id", async (req, reply) => {
    const r = broker.getRequest(req.params.id);
    if (!r) return reply.code(404).send({ reasonCode: "CTX_NOT_FOUND", message: "Unknown requestId" });
    return reply.send(serialize(r));
  });

  app.get<{ Params: { ensName: string } }>("/v1/agents/:ensName", async (req, reply) => {
    try {
      const identity = await broker.resolveIdentityForApi(req.params.ensName);
      return reply.send(serialize(identity));
    } catch (e: unknown) {
      if (e instanceof OperationalError) {
        return reply.code(503).send({ reasonCode: e.code, message: "Identity unavailable" });
      }
      return reply.code(404).send({ reasonCode: ReasonCode.IDENTITY_NOT_FOUND, message: "Not found" });
    }
  });

  app.get<{ Params: { id: string } }>("/v1/policies/:id", async (req, reply) => {
    const p = broker.getPolicy(req.params.id);
    if (!p) return reply.code(404).send({ reasonCode: "CTX_NOT_FOUND", message: "Unknown policy" });
    // Public constraints only. Private thresholds live in the confidential evaluator (Phase 4)
    // and are never served here.
    return reply.send(serialize(p));
  });

  app.get<{ Querystring: { requestId?: string } }>("/v1/audit", async (req, reply) => {
    return reply.send(serialize(broker.getAudit(req.query.requestId)));
  });

  return app;
}
