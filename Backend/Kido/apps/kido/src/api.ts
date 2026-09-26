import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { LifecycleError, type Foundry, type WalletDeployments } from "@kido/foundry";
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
const Addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Sig = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const Start = z.object({ owner: Addr, recoveryEvm: Addr.optional(), recoverySui: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).optional() });
const TxHash = z.object({ txHash: Hex32 });
const Signature = z.object({ signature: Sig });
const WalletTx = z.object({ chain: z.string().max(40), label: z.string().max(120), tx: Hex32 });
const Signed = z.object({ signed: z.array(z.object({ chain: z.string().max(40), message: z.record(z.string(), z.unknown()), signature: Sig })).min(1).max(4) });

type Handler = (req: IncomingMessage, params: Record<string, string>) => Promise<unknown> | unknown;

/**
 * Kido HTTP API: a thin transport over the Foundry state machine. Every lifecycle transition is a
 * foundry gate; this layer only parses input and maps errors.
 */
export function createApi(foundry: Foundry, config: Pick<KidoConfig, "simulationSigners" | "model">, deployments?: WalletDeployments): Server {
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
  const dep = () => deployments ?? (() => { throw new HttpError(503, "BLOCKED_ENV", "deployment is not configured on this backend"); })();
  route("GET", "/projects/:id/deployment", (_r, p) => dep().status(p.id!));
  route("POST", "/projects/:id/deploy/start", async (req, p) => {
    const b = await body(req, Start);
    return dep().start(p.id!, b.owner as `0x${string}`, { ...(b.recoveryEvm ? { evm: b.recoveryEvm as `0x${string}` } : {}), ...(b.recoverySui ? { sui: b.recoverySui } : {}) });
  });
  route("POST", "/projects/:id/deploy/evm-account", async (req, p) => {
    const b = await body(req, TxHash);
    return dep().evmAccount(p.id!, b.txHash as `0x${string}`);
  });
  route("GET", "/projects/:id/deploy/policy", (_r, p) => dep().policy(p.id!));
  route("POST", "/projects/:id/deploy/policy", async (req, p) => {
    const b = await body(req, Signature);
    return dep().submitPolicy(p.id!, b.signature as `0x${string}`);
  });
  route("POST", "/projects/:id/deploy/confirm", (_r, p) => dep().confirm(p.id!));
  route("POST", "/projects/:id/deploy/tx", async (req, p) => {
    const b = await body(req, WalletTx);
    return dep().record(p.id!, b.chain, b.label, b.tx as `0x${string}`);
  });
  route("GET", "/projects/:id/runtime", (_r, p) => dep().runtime(p.id!));
  route("GET", "/projects/:id/activity", (_r, p) => ({ events: foundry.loadRecord(p.id!).events ?? [] }));
  route("POST", "/projects/:id/control/:op/prepare", (_r, p) => {
    if (p.op !== "pause" && p.op !== "revoke") throw new HttpError(404, "KIDO_API_NOT_FOUND", `unknown control ${p.op}`);
    return dep().controlPrepare(p.id!, p.op);
  });
  route("POST", "/projects/:id/control/:op", async (req, p) => {
    if (p.op !== "pause" && p.op !== "revoke") throw new HttpError(404, "KIDO_API_NOT_FOUND", `unknown control ${p.op}`);
    const b = await body(req, Signed);
    return dep().controlSubmit(p.id!, p.op, b.signed as never);
  });
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
