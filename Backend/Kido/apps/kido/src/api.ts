import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { INTERVIEW_TEMPLATES } from "@kido/design-interview";
import type { EnsIdentityAdapter } from "@kido/identity";
import { LifecycleError, type EvidenceStore, type Foundry, type WalletDeployments } from "@kido/foundry";
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
const Create = z.object({ objective: z.string().min(1).max(4000).optional(), name: z.string().max(120).optional(), template: z.string().max(80).optional() }).refine((b) => b.objective || b.template, "give an objective or a template");
const Rename = z.object({ name: z.string().min(1).max(120) });
const Ask = z.object({ question: z.string().min(1).max(1000) });
const Edit = z.object({ key: z.string().min(1).max(100), text: z.string().min(1).max(4000) });
const Addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Sig = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const Start = z.object({ owner: Addr, recoveryEvm: Addr.optional(), recoverySui: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).optional() });
const TxHash = z.object({ txHash: Hex32 });
const Signature = z.object({ signature: Sig });
const WhatIfBody = z.object({ chain: z.string().max(40), action: z.string().max(20), asset: z.string().max(20), assetOut: z.string().max(20).nullable().optional(), amount: z.string().regex(/^\d{1,40}$/), recipient: z.string().max(100).nullable(), atSecondsFromNow: z.number().int().min(0).max(31_536_000).optional() });
const Injection = z.object({ instruction: z.string().min(1).max(2000), target: z.string().min(1).max(100), amount: z.string().regex(/^\d{1,40}$/), chain: z.string().max(40).optional() });
const CostOverrides = z.object({ actionsPerMonth: z.record(z.string().max(20), z.number().int().min(0).max(100_000)), leaseRenewalsPerMonth: z.number().int().min(0).max(100_000), modelCallsPerMonth: z.number().int().min(0).max(10_000_000), outputTokensPerCall: z.number().int().min(0).max(100_000), indexerQueriesPerMonth: z.number().int().min(0).max(1_000_000_000), rpcComputeUnitsPerMonth: z.number().int().min(0).max(1e12) }).partial();
const EnsName = z.object({ name: z.string().min(3).max(255).regex(/^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i, "an ENS name ending in .eth").transform((x) => x.toLowerCase()) });
const EvidenceRef = z.object({ ref: z.string().min(1).max(500) });
const WalletTx = z.object({ chain: z.string().max(40), label: z.string().max(120), tx: Hex32 });
const Signed = z.object({ signed: z.array(z.object({ chain: z.string().max(40), message: z.record(z.string(), z.unknown()), signature: Sig })).min(1).max(4) });

type Handler = (req: IncomingMessage, params: Record<string, string>) => Promise<unknown> | unknown;

/**
 * Kido HTTP API: a thin transport over the Foundry state machine. Every lifecycle transition is a
 * foundry gate; this layer only parses input and maps errors.
 */
export function createApi(foundry: Foundry, config: Pick<KidoConfig, "simulationSigners" | "model">, deployments?: WalletDeployments, evidence?: EvidenceStore, ens?: EnsIdentityAdapter): Server {
  const routes: [string, RegExp, Handler][] = [];
  const route = (method: string, path: string, h: Handler) => routes.push([method, new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>[\\w-]+)")}$`), h]);

  route("GET", "/health", () => ({ ok: true, interviewModel: config.model, simulationSigners: config.simulationSigners, chatModel: Boolean(process.env.OPENAI_API_KEY && (process.env.KIDO_MODEL ?? process.env.OPENAI_MODEL)) }));
  route("GET", "/projects", () => ({ projects: foundry.projects() }));
  // Template addresses come from this backend's environment: the owner's testnet wallet and a sample Sui payee.
  const sample = (chain: string) => (chain.startsWith("sui") ? process.env.KIDO_TEMPLATE_SUI_PAYEE : process.env.KIDO_TEMPLATE_OWNER ?? process.env.FUNDER_ADDRESS) ?? "";
  route("GET", "/templates", () => ({
    templates: INTERVIEW_TEMPLATES.map((t) => ({
      id: t.id, name: t.name, description: t.description, objective: t.objective, highlights: t.highlights,
      questions: t.asks.map((a) => a.text),
      asks: t.asks.map((a) => ({ key: a.key, text: a.text, amounts: a.amounts ?? null })),
      prefill: {
        payees: t.prefill.payees.map((p) => ({ ...p, address: p.address || sample(p.chain) })),
        beneficiary: { ...t.prefill.beneficiary, address: t.prefill.beneficiary.address || sample(t.prefill.beneficiary.chain) },
        limits: t.prefill.limits,
      },
    })),
  }));
  // ENS, read live: is a name taken, who owns it, what it resolves to and which records it carries.
  route("POST", "/identity/ens", async (req) => {
    if (!ens) throw new HttpError(503, "BLOCKED_ENV", "ENS reads are not configured on this backend");
    const { name } = await body(req, EnsName);
    const [status, owner] = await Promise.all([ens.inspect(name), ens.owner(name)]);
    const res = await ens.resolve(name);
    return { name, network: "ethereum-sepolia (ENSv2)", registered: status.registered, owner, expiresAt: status.expiresAt, address: res.address, records: res.records };
  });
  route("POST", "/projects", async (req) => {
    const b = await body(req, Create);
    return foundry.create(b.objective ?? "", b.name, b.template);
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
  route("POST", "/projects/:id/attack/what-if", async (req, p) => {
    const b = await body(req, WhatIfBody);
    return foundry.whatIf(p.id!, b as never);
  });
  route("POST", "/projects/:id/attack/injection", async (req, p) => {
    const b = await body(req, Injection);
    return foundry.injection(p.id!, b as never);
  });
  route("POST", "/projects/:id/costs", async (req, p) => foundry.costs(p.id!, await body(req, CostOverrides).catch(() => ({}))));
  route("POST", "/projects/:id/chat", async (req, p) => foundry.chat(p.id!, (await body(req, Ask)).question));
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
  route("GET", "/projects/:id/portfolio", (_r, p) => dep().portfolio(p.id!));
  route("GET", "/reality", () => dep().reality());
  route("GET", "/projects/:id/reality", (_r, p) => dep().reality(p.id!));
  route("GET", "/projects/:id/activity", (_r, p) => ({ events: foundry.loadRecord(p.id!).events ?? [] }));
  route("POST", "/projects/:id/control/:op/prepare", (_r, p) => {
    if (p.op !== "pause" && p.op !== "revoke") throw new HttpError(404, "KIDO_API_NOT_FOUND", `unknown control ${p.op}`);
    return dep().controlPrepare(p.id!, p.op);
  });
  route("POST", "/projects/:id/deploy/retire", (_r, p) => dep().retire(p.id!));
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
  const ev = () => evidence ?? (() => { throw new HttpError(503, "BLOCKED_ENV", "evidence access is not configured on this backend"); })();
  route("POST", "/evidence/resolve", async (req) => ev().resolve((await body(req, EvidenceRef)).ref));
  route("GET", "/evidence/file/:id", (_r, p) => {
    try {
      return ev().read(p.id!);
    } catch (e) {
      throw new HttpError(404, "KIDO_API_NOT_FOUND", (e as Error).message);
    }
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
      if (err instanceof LifecycleError) return send(err.code === "BLOCKED_ENV" ? 503 : 409, { error: err.code, message: err.message });
      const msg = (err as Error).message ?? String(err);
      if (/^unknown project/.test(msg)) return send(404, { error: "KIDO_API_UNKNOWN_PROJECT", message: msg });
      if (/no pending question|unknown requirement/.test(msg)) return send(409, { error: "KIDO_API_CONFLICT", message: msg });
      send(500, { error: "KIDO_API_INTERNAL", message: msg });
    }
  });
}
