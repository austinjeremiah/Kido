import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { LifecycleError, type Foundry } from "@kido/foundry";
import type { KidoConfig } from "./config.js";

const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function body<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "KIDO_API_BODY_TOO_LARGE", "request body too large");
    chunks.push(c as Buffer);
  }
  let json: unknown;
  try {
    json = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw new HttpError(400, "KIDO_API_BAD_JSON", "body is not JSON");
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new HttpError(400, "KIDO_API_INVALID", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

const Text = z.object({ text: z.string().min(1).max(4000) });
const Create = z.object({ objective: z.string().min(1).max(4000), name: z.string().max(120).optional() });
const Rename = z.object({ name: z.string().min(1).max(120) });
const Ask = z.object({ question: z.string().min(1).max(1000) });
const Edit = z.object({ key: z.string().min(1).max(100), text: z.string().min(1).max(4000) });

type Handler = (req: IncomingMessage, params: Record<string, string>) => Promise<unknown> | unknown;

/**
 * Kido HTTP API: a thin transport over the Foundry state machine. Every lifecycle transition is a
 * foundry gate; this layer only parses input and maps errors.
 */
export function createApi(foundry: Foundry, config: Pick<KidoConfig, "simulationSigners" | "model">): Server {
  const routes: [string, RegExp, Handler][] = [];
  const route = (method: string, path: string, h: Handler) => routes.push([method, new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>[\\w-]+)")}$`), h]);

  route("GET", "/health", () => ({ ok: true, interviewModel: config.model, simulationSigners: config.simulationSigners }));
  route("GET", "/projects", () => ({ projects: foundry.projects() }));
  route("POST", "/projects", async (req) => {
    const b = await body(req, Create);
    return foundry.create(b.objective, b.name);
  });
  route("GET", "/projects/:id", (_r, p) => foundry.summary(p.id!));
  route("PATCH", "/projects/:id", async (req, p) => foundry.rename(p.id!, (await body(req, Rename)).name));
  route("GET", "/projects/:id/next", (_r, p) => ({ question: foundry.next(p.id!) }));
  route("POST", "/projects/:id/answer", async (req, p) => foundry.answer(p.id!, (await body(req, Text)).text));
  route("POST", "/projects/:id/edit", async (req, p) => {
    const b = await body(req, Edit);
    return foundry.edit(p.id!, b.key, b.text);
  });
  route("GET", "/projects/:id/unresolved", (_r, p) => ({ unresolved: foundry.unresolved(p.id!) }));
  route("GET", "/projects/:id/blueprint", (_r, p) => ({ blueprint: foundry.blueprint(p.id!) }));
  route("POST", "/projects/:id/finalize", (_r, p) => foundry.finalize(p.id!));
  route("POST", "/projects/:id/security-review", (_r, p) => foundry.securityReview(p.id!));
  route("POST", "/projects/:id/simulate", (_r, p) => foundry.simulate(p.id!));
  route("POST", "/projects/:id/build", (_r, p) => foundry.build(p.id!));
  route("GET", "/projects/:id/status", (_r, p) => foundry.status(p.id!));
  route("POST", "/projects/:id/introspect", async (req, p) => foundry.introspect(p.id!, (await body(req, Ask)).question));
  route("GET", "/projects/:id/self-model", (_r, p) => foundry.selfModel(p.id!));
  route("GET", "/projects/:id/context/:role", (_r, p) => foundry.agentContext(p.id!, p.role!));
  route("GET", "/registry", () => ({ providers: foundry.registry.providers.map((m) => ({ providerId: m.providerId, kind: m.kind, chains: m.chains, status: m.status, statusNote: m.statusNote, capabilityStatus: m.capabilityStatus ?? {}, implementation: m.implementation })) }));
  route("GET", "/registry/:id", (_r, p) => {
    const m = foundry.registry.get(p.id!);
    if (!m) throw new HttpError(404, "KIDO_API_UNKNOWN_PROVIDER", `unknown provider ${p.id}`);
    return m;
  });
  route("GET", "/knowledge/drift", () => ({ drift: foundry.knowledge.drift(foundry.registry), quarantined: foundry.knowledge.quarantined }));

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    };
    try {
      const url = new URL(req.url ?? "/", "http://kido.local");
      // The web app proxies /api/* here; routes are the same with or without the prefix.
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) url.pathname = url.pathname.slice(4) || "/";
      for (const [method, re, h] of routes) {
        const m = re.exec(url.pathname);
        if (m && req.method === method) return send(200, await h(req, m.groups ?? {}));
      }
      throw new HttpError(404, "KIDO_API_NOT_FOUND", `${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.code, message: err.message });
      if (err instanceof LifecycleError) return send(409, { error: err.code, message: err.message });
      const msg = (err as Error).message ?? String(err);
      if (/^unknown project/.test(msg)) return send(404, { error: "KIDO_API_UNKNOWN_PROJECT", message: msg });
      if (/no pending question|unknown requirement/.test(msg)) return send(409, { error: "KIDO_API_CONFLICT", message: msg });
      send(500, { error: "KIDO_API_INTERNAL", message: msg });
    }
  });
}
