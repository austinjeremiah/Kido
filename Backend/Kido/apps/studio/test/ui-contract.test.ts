import { describe, it, expect, beforeAll } from "vitest";
import { buildServer } from "../src/api.js";
import { testDb, scriptedAgents, RecordingSandbox } from "./helpers.js";
import { registerSandboxProvider, type StudioSandbox, type StudioSandboxProvider } from "../src/sandbox/provider.js";

/**
 * The UI contract.
 *
 * The Studio frontend holds no build state — every field it renders comes from these endpoints. So
 * the thing worth testing is not that React draws, but that the API returns exactly the shapes the
 * views consume. This suite drives the API through the same call sequence the UI makes and asserts
 * every field each component reads.
 *
 * It exists partly because the automated browser in this environment cannot reach the dev server
 * (BLK-V2-001). A contract test is a weaker form of evidence than a working screenshot for
 * *appearance*, and a stronger one for *correctness*.
 */

const sandbox = new RecordingSandbox((cmd) =>
  cmd.includes("vitest")
    ? { stdout: "Tests  7 passed (7)", exitCode: 0 }
    : { stdout: "", exitCode: 0 },
);

class TestProvider implements StudioSandboxProvider {
  readonly id = "recording";
  async create(): Promise<StudioSandbox> { return sandbox as unknown as StudioSandbox; }
  async resume(): Promise<StudioSandbox> { return sandbox as unknown as StudioSandbox; }
  async snapshot() { return "snap"; }
  async destroy() {}
}
registerSandboxProvider("recording", () => new TestProvider());

const HDRS = { "x-studio-user": "ui-test" };
let ctx: ReturnType<typeof buildServer>;
let buildId: string;

beforeAll(async () => {
  ctx = buildServer({ db: testDb(), agents: scriptedAgents(), sandboxProviderId: "recording" });
  const created = await ctx.app.inject({
    method: "POST", url: "/api/studio/builds", headers: HDRS,
    payload: { prompt: "Aave guardian that repays up to $1,000 automatically and never withdraws collateral." },
  });
  buildId = created.json().id;
  await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${buildId}/design` });
  await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${buildId}/approve`, payload: { acknowledgeFindings: [] } });
  await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${buildId}/build` });
});

describe("the health endpoint tells the UI what it is talking to", () => {
  it("names the model and the registered sandbox providers", async () => {
    const r = await ctx.app.inject({ method: "GET", url: "/api/studio/health" });
    const b = r.json();
    expect(b.model).toBe("gpt-5.6-luna");
    expect(b.sandboxProviders).toContain("docker");
    // E2B is listed now: the client exists after all (FND-V2-002-UPDATE). Listing it is not a
    // claim that it is isolated — see BLK-V2-E2B-LIVE and the capability matrix.
    expect(b.sandboxProviders).toContain("e2b");
    expect(b.limits.modelRequestsPerBuild).toBe(60);
  });
});

describe("GET /builds/:id returns everything the three views render", () => {
  it("carries the fields the Architecture view reads", async () => {
    const v = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${buildId}` })).json();
    expect(v.graph).toBeTruthy();
    expect(v.graph.nodes.length).toBeGreaterThan(5);
    for (const n of v.graph.nodes) {
      expect(typeof n.id).toBe("string");
      expect(typeof n.kind).toBe("string");
      expect(typeof n.label).toBe("string");
      expect(typeof n.rank).toBe("number");
      expect(typeof n.position.x).toBe("number");
      expect(typeof n.position.y).toBe("number");
      expect(Array.isArray(n.detail)).toBe(true);
    }
    for (const e of v.graph.edges) {
      expect(["authority", "data", "control"]).toContain(e.kind);
      expect(v.graph.nodes.some((n: { id: string }) => n.id === e.source)).toBe(true);
      expect(v.graph.nodes.some((n: { id: string }) => n.id === e.target)).toBe(true);
    }
  });

  it("carries the fields the Simulation view reads", async () => {
    const v = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${buildId}` })).json();
    expect(v.simulations.length).toBe(24); // 17 built-in + 7 contributed by the bound adapters
    for (const s of v.simulations) {
      expect(typeof s.scenarioId).toBe("string");
      expect(typeof s.verdict).toBe("string");
      expect(typeof s.reasonCode).toBe("string");
      expect(typeof s.stoppedAt).toBe("string");
      expect(typeof s.passed).toBe("boolean");
      expect(typeof s.stale).toBe("boolean");
      expect(Array.isArray(s.stages)).toBe(true);
      expect(Array.isArray(s.assertions)).toBe(true);
      expect(Array.isArray(s.timeline)).toBe(true);
    }
  });

  it("carries the fields the Code view reads", async () => {
    const v = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${buildId}` })).json();
    expect(v.files.length).toBeGreaterThan(10);
    for (const f of v.files) {
      expect(typeof f.path).toBe("string");
      expect(typeof f.bytes).toBe("number");
      expect(typeof f.buildRevision).toBe("number");
    }
  });

  it("carries the score panel with per-category reasons", async () => {
    const v = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${buildId}` })).json();
    expect(v.score.categories).toHaveLength(10);
    for (const c of v.score.categories) {
      expect(typeof c.label).toBe("string");
      expect(typeof c.points).toBe("number");
      expect(Array.isArray(c.reasons)).toBe(true);
      expect(Array.isArray(c.missing)).toBe(true);
    }
    expect(["STRONG", "ADEQUATE", "WEAK", "UNSAFE"]).toContain(v.score.band);
  });

  it("carries the usage header fields", async () => {
    const v = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${buildId}` })).json();
    for (const k of ["requests", "inputTokens", "outputTokens", "simulations", "generatedFiles", "peakFraction", "warned"]) {
      expect(v.usage).toHaveProperty(k);
    }
    expect(v.usage.limits.modelRequestsPerBuild).toBe(60);
  });
});

describe("file contents come from storage, not from a preview", () => {
  it("returns the real generated bytes", async () => {
    const r = await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${buildId}/files/src/ledger/escalation.ts` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("mayProceed");
    // The file the UI shows is the file that was written into the sandbox.
    expect(sandbox.files.get("src/ledger/escalation.ts")).toBe(r.body);
  });

  it("404s for a path that was never generated", async () => {
    const r = await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${buildId}/files/src/nope.ts` });
    expect(r.statusCode).toBe(404);
  });
});

describe("STUDIO-021 the export contains no secrets", () => {
  it("exports source, blueprint and both reports", async () => {
    const r = await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${buildId}/export` });
    expect(r.statusCode).toBe(200);
    const paths = r.json().files.map((f: { path: string }) => f.path);
    expect(paths).toContain("contextlock/blueprint.json");
    expect(paths).toContain("contextlock/SIMULATION_REPORT.md");
    expect(paths).toContain("contextlock/SECURITY_REPORT.md");
    expect(paths).toContain(".env.example");
    expect(paths).toContain("README.md");
    expect(paths).toContain("DEPLOYMENT.md");
  });

  it("the .env.example carries names with empty values", async () => {
    const r = await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${buildId}/export` });
    const env = r.json().files.find((f: { path: string }) => f.path === ".env.example")!;
    expect(env.content).toMatch(/SEPOLIA_RPC_URL=\s*$/m);
    expect(env.content).not.toMatch(/PRIVATE_KEY\s*=\s*\S/);
  });

  it("no exported file contains key-shaped material", async () => {
    const r = await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${buildId}/export` });
    for (const f of r.json().files as Array<{ path: string; content: string }>) {
      expect(f.content, f.path).not.toMatch(/\b0x[0-9a-fA-F]{64}\b/);
      expect(f.content, f.path).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}/);
    }
  });
});

describe("SSE replays history so a reconnecting view misses nothing", () => {
  it("history is ordered and complete", () => {
    const events = ctx.bus.history(buildId);
    expect(events.length).toBeGreaterThan(20);
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("build.created");
    for (const t of ["requirements.completed", "blueprint.completed", "security.completed",
                     "approval.granted", "code.started", "code.file.created",
                     "simulation.completed", "build.completed"]) {
      expect(types, `missing ${t}`).toContain(t);
    }
  });

  it("afterSeq resumes rather than replaying everything", () => {
    const all = ctx.bus.history(buildId);
    const mid = all[Math.floor(all.length / 2)]!.seq;
    const rest = ctx.bus.history(buildId, mid);
    expect(rest.length).toBe(all.length - all.filter((e) => e.seq <= mid).length);
    expect(rest.every((e) => e.seq > mid)).toBe(true);
  });
});
