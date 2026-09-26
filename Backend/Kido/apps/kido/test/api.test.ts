import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, createFoundry, loadConfig, runCli } from "../src/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const env = { KIDO_DATA_DIR: mkdtempSync(join(tmpdir(), "kido-api-")), KIDO_AMANE_MANIFEST: resolve(here, "../../../../Aname/deployments/testnet.json") };
const config = loadConfig(env);
const server = createApi(createFoundry(config), config);
let base = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

const ANSWERS: Record<string, string> = {
  "authority.mode": "act on its own within limits",
  "authority.withdraw": "no",
  "actions.allowed": "pay approved recipients",
  "authority.arbitrary_recipients": "no, only approved ones",
  "authority.autonomy": "automatically",
  payees: `acme supplies: 0x${"ab".repeat(32)}`,
  "limits.window": "50",
  "limits.total": "500",
  "identity.public": "no",
  "privacy.required": "no",
  "recovery.partial": "stop and notify me",
};

describe("Kido API", () => {
  it("reports that throwaway simulation signers are in use when none are configured", async () => {
    expect((await call("GET", "/health")).json).toMatchObject({ ok: true, simulationSigners: true, interviewModel: "rule" });
  });

  it("drives a project from objective to build over HTTP", async () => {
    const c = await call("POST", "/projects", { objective: "Build a Sui agent that pays my supplier invoices" });
    expect(c.status).toBe(200);
    const id = c.json.projectId as string;
    let q = c.json.question;
    while (q) q = (await call("POST", `/projects/${id}/answer`, { text: ANSWERS[q.key] })).json.next;
    expect((await call("POST", `/projects/${id}/build`)).json.error).toBe("KIDO_LIFECYCLE_NOT_FINALIZED");
    expect((await call("POST", `/projects/${id}/finalize`)).json.blockers).toEqual([]);
    expect((await call("POST", `/projects/${id}/security-review`)).json.blocking).toBe(false);
    expect((await call("POST", `/projects/${id}/simulate`)).json.passed).toBe(true);
    const b = await call("POST", `/projects/${id}/build`);
    expect(b.status).toBe(200);
    expect(b.json.kind).toBe("build");
    expect((await call("GET", `/projects/${id}/status`)).json).toMatchObject({ build: "CURRENT" });
    const ask = await call("POST", `/projects/${id}/introspect`, { question: "Who can you pay?" });
    expect(ask.json.facts.actions.allowed).toEqual(["PAY"]);
    expect((await call("GET", `/projects/${id}/context/PaymentAgent`)).json.role).toBe("PaymentAgent");
  });

  it("rejects bad input and unknown resources with typed errors", async () => {
    expect((await call("POST", "/projects", { objective: "" })).json.error).toBe("KIDO_API_INVALID");
    expect((await call("GET", "/projects/proj_nope/status")).status).toBe(404);
    expect((await call("GET", "/registry/not-a-provider")).status).toBe(404);
    expect((await call("GET", "/nowhere")).status).toBe(404);
  });

  it("exposes registry status and knowledge drift", async () => {
    const r = await call("GET", "/registry");
    expect(r.json.providers.find((p: any) => p.providerId === "wormhole").status).toBe("VERIFIED_DOCS");
    expect((await call("GET", "/knowledge/drift")).json).toEqual({ drift: [], quarantined: [] });
  });
});

describe("kido CLI", () => {
  it("creates a project and reports its status", async () => {
    Object.assign(process.env, env);
    const out: string[] = [];
    expect(await runCli(["create", "Build a Sui agent that pays my supplier invoices"], (s) => out.push(s))).toBe(0);
    const { projectId } = JSON.parse(out[0]!);
    expect(await runCli(["status", projectId], (s) => out.push(s))).toBe(0);
    expect(JSON.parse(out[1]!)).toMatchObject({ projectId, revision: null });
    expect(await runCli(["build", projectId], (s) => out.push(s))).toBe(1);
    expect(JSON.parse(out[2]!).error).toBe("KIDO_LIFECYCLE_NOT_FINALIZED");
  });
});
