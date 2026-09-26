import { describe, it, expect } from "vitest";
import { QuotaManager, QuotaExceededError } from "../src/quota.js";
import { DEFAULT_QUOTA } from "../src/config.js";

/** The daily cap is off by default; these tests pin the mechanism with an explicit one. */
const CAPPED = { ...DEFAULT_QUOTA, newBuildsPerRollingDay: 3 };
import { buildServer } from "../src/api.js";
import { testDb, scriptedAgents } from "./helpers.js";
import type { DB } from "../src/db.js";
import { openStudioDb } from "../src/db.js";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function seed(db: DB, buildId = "b1", userId = "u1"): string {
  const t = new Date().toISOString();
  db.prepare(`INSERT INTO studio_projects (id,user_id,name,prompt,created_at) VALUES ('p1',?,'n','p',?)`).run(userId, t);
  db.prepare(
    `INSERT INTO studio_builds (id,project_id,user_id,stage,status,build_revision,repair_cycles,created_at,updated_at)
     VALUES (?, 'p1', ?, 'INTAKE','RUNNING',0,0,?,?)`,
  ).run(buildId, userId, t, t);
  return buildId;
}

describe("STUDIO-015 quota blocks an excess model call", () => {
  it("refuses the request that would exceed the request budget", () => {
    const db = testDb();
    const id = seed(db);
    const q = new QuotaManager(db, { ...DEFAULT_QUOTA, modelRequestsPerBuild: 3 });
    for (let i = 0; i < 3; i++) {
      const r = q.reserve(id, "requirements", 10);
      q.settle(r, id, "requirements", `run${i}`, { requests: 1, inputTokens: 10, outputTokens: 10, totalTokens: 20 });
    }
    expect(() => q.reserve(id, "requirements", 10)).toThrow(QuotaExceededError);
    try {
      q.reserve(id, "requirements", 10);
    } catch (e) {
      expect((e as QuotaExceededError).kind).toBe("MODEL_REQUESTS");
    }
  });

  it("refuses on input tokens and on output tokens separately", () => {
    const db = testDb();
    const id = seed(db);
    const qi = new QuotaManager(db, { ...DEFAULT_QUOTA, inputTokensPerBuild: 100 });
    expect(() => qi.reserve(id, "requirements", 500)).toThrow(/INPUT_TOKENS/);

    const db2 = testDb();
    const id2 = seed(db2);
    const qo = new QuotaManager(db2, { ...DEFAULT_QUOTA, outputTokensPerBuild: 100, reservedOutputTokensPerRequest: 500 });
    expect(() => qo.reserve(id2, "requirements", 1)).toThrow(/OUTPUT_TOKENS/);
  });
});

describe("STUDIO-029 a reservation covers the worst case before the call", () => {
  it("a held reservation is visible in the snapshot, so an in-flight call cannot be double-spent", () => {
    const db = testDb();
    const id = seed(db);
    const q = new QuotaManager(db, DEFAULT_QUOTA);
    const before = q.snapshot(id);
    q.reserve(id, "builder", 1000);
    const during = q.snapshot(id);
    expect(during.requests).toBe(before.requests + 1);
    expect(during.inputTokens).toBe(before.inputTokens + 1000);
    // The reserved output allowance is held, not zero — a build cannot start a turn it cannot finish.
    expect(during.outputTokens).toBe(DEFAULT_QUOTA.reservedOutputTokensPerRequest);
  });

  it("settling replaces the reservation with the real usage", () => {
    const db = testDb();
    const id = seed(db);
    const q = new QuotaManager(db, DEFAULT_QUOTA);
    const r = q.reserve(id, "builder", 1000);
    q.settle(r, id, "builder", "run", { requests: 1, inputTokens: 812, outputTokens: 97, totalTokens: 909 });
    const after = q.snapshot(id);
    expect(after.inputTokens).toBe(812);
    expect(after.outputTokens).toBe(97);
    expect(after.requests).toBe(1);
  });

  it("releasing a reservation returns the budget", () => {
    const db = testDb();
    const id = seed(db);
    const q = new QuotaManager(db, DEFAULT_QUOTA);
    const r = q.reserve(id, "builder", 1000);
    q.release(r);
    expect(q.snapshot(id).inputTokens).toBe(0);
  });
});

describe("STUDIO-016 a concurrent quota race cannot exceed the budget", () => {
  it("with one request of budget left, exactly one of many concurrent reservations succeeds", async () => {
    const db = testDb();
    const id = seed(db);
    const q = new QuotaManager(db, { ...DEFAULT_QUOTA, modelRequestsPerBuild: 1 });

    // What this proves and what it does not: better-sqlite3 is synchronous, so reserve() cannot be
    // interleaved by microtasks at all. That makes this a check of the accounting — one request of
    // budget yields exactly one reservation — and NOT evidence that the transaction is atomic. A
    // naive check-then-act passes here too (verified by mutation). The mechanism is tested across
    // real processes in STUDIO-031.
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => Promise.resolve().then(() => q.reserve(id, "requirements", 10))),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(24);
    expect(failed.every((f) => (f as PromiseRejectedResult).reason instanceof QuotaExceededError)).toBe(true);
    expect(q.snapshot(id).requests).toBe(1);
  });

  it("token budgets cannot be overspent by concurrent reservations either", async () => {
    const db = testDb();
    const id = seed(db);
    // Room for exactly 4 reservations of 1000 input tokens.
    const q = new QuotaManager(db, { ...DEFAULT_QUOTA, inputTokensPerBuild: 4000, modelRequestsPerBuild: 999 });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => Promise.resolve().then(() => q.reserve(id, "builder", 1000))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    expect(q.snapshot(id).inputTokens).toBeLessThanOrEqual(4000);
  });
});

describe("STUDIO-029/030 warning and safe pause", () => {
  it("warns at 80% of the peak budget", () => {
    const db = testDb();
    const id = seed(db);
    const q = new QuotaManager(db, { ...DEFAULT_QUOTA, modelRequestsPerBuild: 10 });
    for (let i = 0; i < 7; i++) {
      const r = q.reserve(id, "requirements", 1);
      q.settle(r, id, "requirements", `r${i}`, { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    }
    expect(q.snapshot(id).warned).toBe(false);
    const r = q.reserve(id, "requirements", 1);
    q.settle(r, id, "requirements", "r8", { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    const s = q.snapshot(id);
    expect(s.peakFraction).toBeGreaterThanOrEqual(0.8);
    expect(s.warned).toBe(true);
  });

  it("STUDIO-030 hitting the limit pauses the build inspectably rather than losing it", async () => {
    const db = testDb();
    const ctx = buildServer({ db, agents: scriptedAgents(), sandboxProviderId: "docker" });
    // One request of budget: the design stage needs three, so it stops partway.
    const q = new QuotaManager(db, { ...DEFAULT_QUOTA, modelRequestsPerBuild: 1 });
    const created = await ctx.app.inject({ method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "u" }, payload: { prompt: "Aave guardian, repay up to $1,000." } });
    const id = created.json().id;
    // Replace the pipeline's quota with the tight one by driving it directly.
    const { StudioPipeline } = await import("../src/pipeline.js");
    const { StudioEventBus } = await import("../src/events.js");
    const bus = new StudioEventBus(db);
    const p = new StudioPipeline({ db, bus, quota: q, agents: scriptedAgents() });
    await expect(p.runToApproval(id)).rejects.toThrow(QuotaExceededError);

    const b = p.get(id)!;
    expect(b.status).toBe("BUILD_LIMIT_REACHED");
    // The build is still there and still inspectable — nothing was destroyed to enforce a limit.
    const view = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json();
    expect(view.build.status).toBe("BUILD_LIMIT_REACHED");
    expect(bus.history(id).some((e) => e.type === "build.limit_reached")).toBe(true);
  });
});

describe("build creation limits", () => {
  it("the default policy has no daily cap: a fourth, fifth and sixth build are all allowed", () => {
    const db = testDb();
    const q = new QuotaManager(db, DEFAULT_QUOTA);
    const t = new Date().toISOString();
    db.prepare(`INSERT INTO studio_projects (id,user_id,name,prompt,created_at) VALUES ('p1','u1','n','p',?)`).run(t);
    for (let i = 0; i < 6; i++) {
      db.prepare(
        `INSERT INTO studio_builds (id,project_id,user_id,stage,status,build_revision,repair_cycles,created_at,updated_at)
         VALUES (?,'p1','u1','EXPORT_READY','COMPLETED',1,0,?,?)`,
      ).run(`b${i}`, t, t);
    }
    expect(DEFAULT_QUOTA.newBuildsPerRollingDay).toBeNull();
    expect(() => q.assertCanCreateBuild("u1")).not.toThrow();
  });

  it("refuses a fourth build in a rolling day", () => {
    const db = testDb();
    const q = new QuotaManager(db, CAPPED);
    const t = new Date().toISOString();
    db.prepare(`INSERT INTO studio_projects (id,user_id,name,prompt,created_at) VALUES ('p1','u1','n','p',?)`).run(t);
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO studio_builds (id,project_id,user_id,stage,status,build_revision,repair_cycles,created_at,updated_at)
         VALUES (?,'p1','u1','EXPORT_READY','COMPLETED',1,0,?,?)`,
      ).run(`b${i}`, t, t);
    }
    expect(() => q.assertCanCreateBuild("u1")).toThrow(/NEW_BUILDS/);
  });

  it("refuses a second concurrent build", () => {
    const db = testDb();
    const q = new QuotaManager(db, DEFAULT_QUOTA);
    const t = new Date().toISOString();
    db.prepare(`INSERT INTO studio_projects (id,user_id,name,prompt,created_at) VALUES ('p1','u2','n','p',?)`).run(t);
    db.prepare(
      `INSERT INTO studio_builds (id,project_id,user_id,stage,status,build_revision,repair_cycles,created_at,updated_at)
       VALUES ('bx','p1','u2','BUILD','RUNNING',1,0,?,?)`,
    ).run(t, t);
    expect(() => q.assertCanCreateBuild("u2")).toThrow(/CONCURRENT_BUILDS/);
  });

  it("STUDIO-028 a repeated idempotency key returns the same build without a new credit", async () => {
    const ctx = buildServer({ db: testDb(), agents: scriptedAgents(), sandboxProviderId: "docker" });
    const payload = { prompt: "Aave guardian, repay up to $1,000.", idempotencyKey: "k1" };
    const a = await ctx.app.inject({ method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "u" }, payload });
    const b = await ctx.app.inject({ method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "u" }, payload });
    expect(a.statusCode).toBe(201);
    // 200, not 201: nothing new was created. And crucially not 429 — a retry is not a new request,
    // so the creation cooldown must not fire on it.
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    const n = (ctx.db.prepare(`SELECT COUNT(*) n FROM studio_builds`).get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("an idempotency key belonging to another user is refused, not returned", async () => {
    const ctx = buildServer({ db: testDb(), agents: scriptedAgents(), sandboxProviderId: "docker" });
    const payload = { prompt: "Aave guardian, repay up to $1,000.", idempotencyKey: "shared" };
    await ctx.app.inject({ method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "alice" }, payload });
    const r = await ctx.app.inject({ method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "mallory" }, payload });
    expect(r.statusCode).toBe(409);
  });
});

describe("other budgets", () => {
  it("caps simulations, files and sandbox wall clock", () => {
    const db = testDb();
    const id = seed(db);
    const q = new QuotaManager(db, { ...DEFAULT_QUOTA, userRequestedSimulationsPerBuild: 2, generatedFiles: 2, sandboxWallClockMs: 1000 });
    const t = new Date().toISOString();
    for (let i = 0; i < 2; i++) {
      db.prepare(`INSERT INTO studio_simulations (build_id,scenario_id,sim_class,pass_id,blueprint_revision,build_revision,result,passed,created_at) VALUES (?,?, 'USER_REQUESTED','u',1,1,'{}',1,?)`).run(id, `S${i}`, t);
      db.prepare(`INSERT INTO studio_artifacts (build_id,build_revision,path,content,bytes,updated_at) VALUES (?,1,?,'x',1,?)`).run(id, `f${i}.ts`, t);
    }
    expect(() => q.assertCanSimulate(id, "USER_REQUESTED")).toThrow(/USER_SIMULATIONS/);
    expect(() => q.assertCanWriteFile(id, 1)).toThrow(/GENERATED_FILES/);
    expect(() => q.assertSandboxWithinWallClock(Date.now() - 5000)).toThrow(/SANDBOX_WALL_CLOCK/);
    expect(() => q.assertSandboxWithinWallClock(Date.now() - 10)).not.toThrow();
  });
});

describe("STUDIO-034 the reservation is atomic across real processes", () => {
  it("with three requests of budget, exactly three of eight concurrent processes succeed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-race-"));
    const dbPath = join(dir, "studio.db");
    try {
      const seedDb = openStudioDb(`file:${dbPath}`);
      seed(seedDb);
      seedDb.close();

      const startAt = Date.now() + 6_000;
      const child = join(dirname(fileURLToPath(import.meta.url)), "quota-race-child.ts");
      const run = (): Promise<{ ok: boolean; kind?: string }> =>
        new Promise((resolve, reject) => {
          const k = spawn("npx", ["tsx", child, dbPath, String(startAt), "3"], {
            cwd: dirname(child),
            stdio: ["ignore", "pipe", "pipe"],
          });
          let out = "";
          let err = "";
          k.stdout.on("data", (d) => (out += String(d)));
          k.stderr.on("data", (d) => (err += String(d)));
          k.on("close", (code) =>
            out.trim() === ""
              ? reject(new Error(`child exited ${code}: ${err.slice(-400)}`))
              : resolve(JSON.parse(out.trim())),
          );
        });

      const results = await Promise.all(Array.from({ length: 8 }, run));
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      // The five that lose must lose to the budget, not to a lock error.
      expect(results.filter((r) => !r.ok).map((r) => r.kind)).toEqual([
        "MODEL_REQUESTS",
        "MODEL_REQUESTS",
        "MODEL_REQUESTS",
        "MODEL_REQUESTS",
        "MODEL_REQUESTS",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("STUDIO-033 a build the user decides against can be let go of", () => {
  /**
   * The gap this closes: AWAITING_APPROVAL is a state only a person can leave, and until `abandon`
   * existed the only exit was to approve. A user who read the security review and decided NOT to
   * build the agent held the single concurrency slot forever — so "no, don't build that", the one
   * answer the whole approval boundary exists to make possible, was the answer the Studio refused.
   */
  const awaitingApproval = (db: DB, id: string, userId = "u1") => {
    const t = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO studio_projects (id,user_id,name,prompt,created_at) VALUES (?,?,'n','p',?)`)
      .run(`p-${id}`, userId, t);
    db.prepare(
      `INSERT INTO studio_builds (id,project_id,user_id,stage,status,build_revision,repair_cycles,created_at,updated_at)
       VALUES (?, ?, ?, 'AWAITING_APPROVAL','AWAITING_APPROVAL',0,0,?,?)`,
    ).run(id, `p-${id}`, userId, t, t);
  };

  it("a build awaiting approval holds the only concurrency slot until it is abandoned", async () => {
    const db = testDb();
    const ctx = buildServer({ db, agents: scriptedAgents(), resolveUserId: () => "u1" });
    awaitingApproval(db, "bld_stuck");

    const blocked = await ctx.app.inject({
      method: "POST",
      url: "/api/studio/builds",
      payload: { prompt: "a second agent while the first waits for me" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().kind).toBe("CONCURRENT_BUILDS");

    const abandoned = await ctx.app.inject({
      method: "POST",
      url: "/api/studio/builds/bld_stuck/abandon",
      payload: { reason: "decided against it after the security review" },
    });
    expect(abandoned.statusCode).toBe(200);
    expect(abandoned.json().build.status).toBe("ABANDONED");

    const allowed = await ctx.app.inject({
      method: "POST",
      url: "/api/studio/builds",
      payload: { prompt: "a second agent now that the first is let go" },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("the record survives: what was designed and that a human declined it is the interesting part", () => {
    const db = testDb();
    const ctx = buildServer({ db, agents: scriptedAgents(), resolveUserId: () => "u1" });
    awaitingApproval(db, "bld_keep");
    ctx.pipeline.abandon("bld_keep", "not worth the residual allowance risk");

    const row = db.prepare(`SELECT status, failure_reason, stage FROM studio_builds WHERE id = ?`).get("bld_keep");
    expect(row).toEqual({
      status: "ABANDONED",
      failure_reason: "not worth the residual allowance risk",
      stage: "AWAITING_APPROVAL",
    });
  });

  it("abandoning twice is a conflict, not a silent success", async () => {
    const db = testDb();
    const ctx = buildServer({ db, agents: scriptedAgents(), resolveUserId: () => "u1" });
    awaitingApproval(db, "bld_twice");
    await ctx.app.inject({ method: "POST", url: "/api/studio/builds/bld_twice/abandon", payload: {} });
    const again = await ctx.app.inject({ method: "POST", url: "/api/studio/builds/bld_twice/abandon", payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain("already abandoned");
  });

  it("another user cannot abandon someone else's build", async () => {
    const db = testDb();
    const ctx = buildServer({ db, agents: scriptedAgents(), resolveUserId: () => "u2" });
    awaitingApproval(db, "bld_mine", "u1");
    const res = await ctx.app.inject({ method: "POST", url: "/api/studio/builds/bld_mine/abandon", payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

describe("STUDIO-035 a build that died with the server does not hold the slot forever", () => {
  /**
   * The same failure as STUDIO-033, arriving through a different door.
   *
   * A build runs **in the API process**. Stop the server mid-build and the worker goes with it,
   * but the row stays `RUNNING` — holding the single concurrency slot against a user whose only
   * way to release it, `abandon`, is reachable from a screen that no longer has a live build to
   * point at. Every subsequent "Design this agent" returns `CONCURRENT_BUILDS (1/1)`, forever, and
   * restarting the server — the obvious remedy — makes it worse by orphaning another one.
   *
   * Found in use rather than in a test: a running build was orphaned by an API restart and the
   * next build attempt returned 429.
   */
  const running = (db: DB, id: string, userId = "u1") => {
    const t = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO studio_projects (id,user_id,name,prompt,created_at) VALUES (?,?,'n','p',?)`)
      .run(`p-${id}`, userId, t);
    db.prepare(
      `INSERT INTO studio_builds (id,project_id,user_id,stage,status,build_revision,repair_cycles,created_at,updated_at)
       VALUES (?, ?, ?, 'REQUIREMENTS','RUNNING',0,0,?,?)`,
    ).run(id, `p-${id}`, userId, t, t);
  };

  it("STUDIO-035 an orphaned RUNNING build blocks a new build until it is reconciled", async () => {
    const db = testDb();
    const ctx = buildServer({ db, agents: scriptedAgents(), resolveUserId: () => "u1" });
    running(db, "bld_orphan");

    const blocked = await ctx.app.inject({
      method: "POST", url: "/api/studio/builds", payload: { prompt: "a new agent" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().kind).toBe("CONCURRENT_BUILDS");

    // What `server.ts` does at startup.
    expect(ctx.pipeline.reconcileOrphanedBuilds()).toEqual(["bld_orphan"]);

    const allowed = await ctx.app.inject({
      method: "POST", url: "/api/studio/builds", payload: { prompt: "a new agent" },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("STUDIO-035b the record is kept, with the reason, rather than deleted", () => {
    const db = testDb();
    const ctx = buildServer({ db, agents: scriptedAgents(), resolveUserId: () => "u1" });
    running(db, "bld_orphan");
    ctx.pipeline.reconcileOrphanedBuilds();

    const row = db.prepare(`SELECT status, failure_reason, stage FROM studio_builds WHERE id = 'bld_orphan'`)
      .get() as { status: string; failure_reason: string; stage: string };
    expect(row.status).toBe("ABANDONED");
    expect(row.stage).toBe("REQUIREMENTS");
    expect(row.failure_reason).toMatch(/the server restarted while this build was running/);
  });

  it("STUDIO-035c a build waiting for a person survives the reconcile", () => {
    /*
     * The distinction that makes this safe. AWAITING_APPROVAL and PAUSED are states a *person*
     * leaves; they are meant to outlive a restart, and reconciling them would throw away a security
     * review the user has not answered yet.
     */
    const db = testDb();
    const ctx = buildServer({ db, agents: scriptedAgents(), resolveUserId: () => "u1" });
    const t = new Date().toISOString();
    db.prepare(`INSERT INTO studio_projects (id,user_id,name,prompt,created_at) VALUES ('p-w','u1','n','p',?)`).run(t);
    db.prepare(
      `INSERT INTO studio_builds (id,project_id,user_id,stage,status,build_revision,repair_cycles,created_at,updated_at)
       VALUES ('bld_waiting','p-w','u1','AWAITING_APPROVAL','AWAITING_APPROVAL',0,0,?,?)`,
    ).run(t, t);

    expect(ctx.pipeline.reconcileOrphanedBuilds()).toEqual([]);
    expect((db.prepare(`SELECT status FROM studio_builds WHERE id='bld_waiting'`).get() as { status: string }).status)
      .toBe("AWAITING_APPROVAL");
  });

  it("STUDIO-035d reconciling twice is not an error and releases nothing the second time", () => {
    const db = testDb();
    const ctx = buildServer({ db, agents: scriptedAgents(), resolveUserId: () => "u1" });
    running(db, "bld_orphan");
    expect(ctx.pipeline.reconcileOrphanedBuilds()).toEqual(["bld_orphan"]);
    expect(ctx.pipeline.reconcileOrphanedBuilds()).toEqual([]);
  });

  it("STUDIO-035e the disappearance is recorded as an event, not only a status", () => {
    const db = testDb();
    const ctx = buildServer({ db, agents: scriptedAgents(), resolveUserId: () => "u1" });
    running(db, "bld_orphan");
    ctx.pipeline.reconcileOrphanedBuilds();

    const events = db.prepare(`SELECT type FROM studio_build_events WHERE build_id = 'bld_orphan'`)
      .all() as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toContain("build.abandoned");
  });
});

describe("STUDIO-036 the daily allowance rations work, not rows", () => {
  /**
   * A build that died before it did anything used to consume one of three daily builds. Unlike the
   * concurrency slot there is no way to give that back — the window is time-based — so a server
   * restart or a missing credential permanently cost the user a build they never got.
   *
   * Found the same way as FND-V2-28-005: by using the product. A build failed on its first call
   * because the API process had been restarted without its credentials, and it still counted.
   */
  const build = (db: DB, id: string, status: string, userId = "u1", createdAt = new Date().toISOString()) => {
    db.prepare(`INSERT OR IGNORE INTO studio_projects (id,user_id,name,prompt,created_at) VALUES (?,?,'n','p',?)`)
      .run(`p-${id}`, userId, createdAt);
    db.prepare(
      `INSERT INTO studio_builds (id,project_id,user_id,stage,status,build_revision,repair_cycles,created_at,updated_at)
       VALUES (?, ?, ?, 'REQUIREMENTS', ?, 0, 0, ?, ?)`,
    ).run(id, `p-${id}`, userId, status, createdAt, createdAt);
  };

  const spent = (db: DB, id: string) => {
    db.prepare(
      `INSERT INTO studio_usage (build_id,role,run_id,model,requests,input_tokens,output_tokens,total_tokens,created_at)
       VALUES (?, 'requirements', ?, 'm', 1, 10, 10, 20, ?)`,
    ).run(id, `run-${id}`, new Date().toISOString());
  };

  it("STUDIO-036 three builds that died without spending do not exhaust the daily allowance", () => {
    const db = testDb();
    const q = new QuotaManager(db, CAPPED);
    for (const id of ["b1", "b2", "b3"]) build(db, id, "ABANDONED");
    expect(() => q.assertCanCreateBuild("u1")).not.toThrow();
  });

  it("STUDIO-036g a completed build counts even with no usage row", () => {
    /*
     * A finished build did the work by definition. The count must not depend on the accounting
     * table having been written, or a gap in usage recording would silently hand out free builds.
     */
    const db = testDb();
    const q = new QuotaManager(db, CAPPED);
    for (const id of ["b1", "b2", "b3"]) build(db, id, "COMPLETED");
    expect(() => q.assertCanCreateBuild("u1")).toThrow(QuotaExceededError);
  });

  it("STUDIO-036b three builds that DID spend still exhaust it", () => {
    // The limit is not weakened — it is measured against the thing it exists to ration.
    const db = testDb();
    const q = new QuotaManager(db, CAPPED);
    for (const id of ["b1", "b2", "b3"]) { build(db, id, "COMPLETED"); spent(db, id); }
    expect(() => q.assertCanCreateBuild("u1")).toThrow(QuotaExceededError);
    try { q.assertCanCreateBuild("u1"); } catch (e) { expect((e as QuotaExceededError).kind).toBe("NEW_BUILDS"); }
  });

  it("STUDIO-036c a build left holding a reservation counts — the call may have been paid for", () => {
    /*
     * A HELD reservation nobody resolved means the process died mid-call. The provider may well
     * have been paid, so this is not a free build. Contrast STUDIO-036h.
     */
    const db = testDb();
    const q = new QuotaManager(db, CAPPED);
    for (const id of ["b1", "b2", "b3"]) { build(db, id, "ABANDONED"); q.reserve(id, "requirements", 10); }
    expect(() => q.assertCanCreateBuild("u1")).toThrow(QuotaExceededError);
  });

  it("STUDIO-036h a RELEASED reservation is free — the call never happened", () => {
    /*
     * The exact shape of the failure that prompted this. The API process had no credentials, so the
     * request failed locally before anything left the machine and the hold was given back. The
     * system already recorded that nothing was consumed; the allowance should agree with it.
     */
    const db = testDb();
    const q = new QuotaManager(db, CAPPED);
    for (const id of ["b1", "b2", "b3"]) {
      build(db, id, "ABANDONED");
      q.release(q.reserve(id, "requirements", 10));
    }
    expect(() => q.assertCanCreateBuild("u1")).not.toThrow();
  });

  it("STUDIO-036d an in-flight build counts even before it has spent anything", () => {
    // Otherwise the count would dip while a build was starting up.
    const db = testDb();
    const q = new QuotaManager(db, { ...CAPPED, concurrentBuilds: 99 });
    for (const id of ["b1", "b2", "b3"]) build(db, id, "RUNNING");
    expect(() => q.assertCanCreateBuild("u1")).toThrow(QuotaExceededError);
  });

  it("STUDIO-036e a build outside the rolling window does not count, spent or not", () => {
    const db = testDb();
    const q = new QuotaManager(db, CAPPED);
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    for (const id of ["b1", "b2", "b3"]) { build(db, id, "COMPLETED", "u1", old); spent(db, id); }
    expect(() => q.assertCanCreateBuild("u1")).not.toThrow();
  });

  it("STUDIO-036f another user's spending is not charged to this one", () => {
    const db = testDb();
    const q = new QuotaManager(db, CAPPED);
    for (const id of ["b1", "b2", "b3"]) { build(db, id, "COMPLETED", "someone-else"); spent(db, id); }
    expect(() => q.assertCanCreateBuild("u1")).not.toThrow();
  });
});
