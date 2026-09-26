import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api.js";
import { testDb } from "./helpers.js";
import { bridgePlan, clone, withStatus } from "../../../packages/studio-plan/test/fixtures.js";

const post = async (body: unknown) => {
  const ctx = buildServer({ db: testDb() });
  return ctx.app.inject({ method: "POST", url: "/api/studio/plans/compile", payload: body as never });
};

describe("the plan API", () => {
  it("PLAN-API-001 a valid plan compiles to a graph, scenarios and per-step scopes", async () => {
    const res = await post(bridgePlan());
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.planHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(b.state).toBe("DRAFT");
    expect(b.runnable).toEqual(["bridge"]);
    expect(b.graph.nodes.length).toBeGreaterThan(4);
    expect(b.scenarios.length).toBeGreaterThan(12);
  });

  it("PLAN-API-002 every step gets its own scope, and no two are the same", async () => {
    const b = (await post(bridgePlan())).json();
    const scopes = (b.stepAuthorizations as Array<{ stepId: string; capabilityScope: string }>);
    expect(scopes).toHaveLength(2);
    expect(new Set(scopes.map((s) => s.capabilityScope)).size).toBe(2);
    for (const s of scopes) {
      // A scope that does not name its own step is a plan-wide grant wearing a step's name.
      expect(s.capabilityScope).toContain(`:step:${s.stepId}:`);
      expect(s.capabilityScope).toContain(b.planHash);
    }
  });

  it("PLAN-API-003 editing the plan changes the hash and every scope with it", async () => {
    const before = (await post(bridgePlan())).json();
    const p = clone(bridgePlan());
    (p.steps[0]!.normalizedIntent as Record<string, unknown>).amount = "1";
    const after = (await post(p)).json();
    expect(after.planHash).not.toBe(before.planHash);
    const b = before.stepAuthorizations.map((s: { capabilityScope: string }) => s.capabilityScope);
    const a = after.stepAuthorizations.map((s: { capabilityScope: string }) => s.capabilityScope);
    expect(a.some((x: string) => b.includes(x))).toBe(false);
  });

  it("PLAN-API-004 a partially executed plan reports PARTIAL, not COMPLETED or FAILED", async () => {
    let p = withStatus(bridgePlan(), "bridge", "CONFIRMED");
    p = withStatus(p, "supply", "FAILED");
    const b = (await post(p)).json();
    expect(b.state).toBe("PARTIAL");
    expect(b.graph.state).toBe("PARTIAL");
  });

  it("PLAN-API-005 a malformed plan is refused with the offending path", async () => {
    const p = clone(bridgePlan()) as unknown as Record<string, unknown>;
    (p.steps as Array<Record<string, unknown>>)[0]!.adapterVersion = "^1.0.0";
    const res = await post(p);
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json().detail)).toContain("adapterVersion");
  });

  it("PLAN-API-006 no state, status or policy value expresses a reversal", async () => {
    let p = withStatus(bridgePlan(), "bridge", "CONFIRMED");
    p = withStatus(p, "supply", "FAILED");
    const b = (await post(p)).json();

    // Checked structurally rather than by scanning the whole payload for a word: the scenario
    // list legitimately SAYS there is no rollback, and an assertion that forbade the word would
    // force deleting the sentence that explains the design.
    const reversal = /rollback|revert|undo|unwind|refund/i;
    const values: string[] = [];
    const walk = (v: unknown, path: string): void => {
      if (typeof v === "string") { if (/state|status|kind|policy|outcome|disposition/i.test(path)) values.push(v); return; }
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(b, "$");
    expect(values.length).toBeGreaterThan(5);
    expect(values.filter((v) => reversal.test(v))).toEqual([]);

    // And the honest state is reported instead.
    expect(b.state).toBe("PARTIAL");
  });
});
