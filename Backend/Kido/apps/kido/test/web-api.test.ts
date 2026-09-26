import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, createFoundry, loadConfig } from "../src/index.js";

/** The routes the web app uses: list, summary, rename, the /api prefix, and deployment gating. */
const here = fileURLToPath(new URL(".", import.meta.url));
const env = { KIDO_DATA_DIR: mkdtempSync(join(tmpdir(), "kido-web-")), KIDO_AMANE_MANIFEST: resolve(here, "../../../../Aname/deployments/testnet.json") };
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

describe("web app routes", () => {
  it("creates, lists, summarizes and renames a project through the /api prefix", async () => {
    const created = await call("POST", "/api/projects", { objective: "Build me a treasury agent on Ethereum that pays my supplier", name: "Supplier payer" });
    expect(created.status).toBe(200);
    const id = created.json.projectId as string;
    const list = await call("GET", "/api/projects");
    expect(list.json.projects.map((p: { projectId: string }) => p.projectId)).toContain(id);
    const s = await call("GET", `/api/projects/${id}`);
    expect(s.json).toMatchObject({ projectId: id, name: "Supplier payer", stage: "INTERVIEW", blueprint: null, security: null });
    expect(s.json.interview.question.key).toBe("authority.mode");
    expect((await call("PATCH", `/api/projects/${id}`, { name: "Renamed" })).json.name).toBe("Renamed");
    expect((await call("GET", `/projects/${id}`)).json.name).toBe("Renamed");
  });

  it("an unknown project is a 404, not a crash", async () => {
    expect((await call("GET", "/api/projects/proj_missing")).status).toBe(404);
  });

  it("deployment routes report BLOCKED_ENV when the backend is not configured for it", async () => {
    const id = (await call("POST", "/api/projects", { objective: "Build me a treasury agent on Ethereum that pays my supplier" })).json.projectId;
    const r = await call("GET", `/api/projects/${id}/deployment`);
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("BLOCKED_ENV");
  });

  it("rejects a malformed owner address and signature before touching any chain", async () => {
    const id = (await call("POST", "/api/projects", { objective: "Build me a treasury agent on Ethereum that pays my supplier" })).json.projectId;
    expect((await call("POST", `/api/projects/${id}/deploy/start`, { owner: "not-an-address" })).status).toBe(400);
    expect((await call("POST", `/api/projects/${id}/deploy/policy`, { signature: "0x1234" })).status).toBe(400);
  });
});
