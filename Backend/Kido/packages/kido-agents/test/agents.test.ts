import { describe, expect, it } from "vitest";
import { PlanProposalSchema, SPECIALISTS, ScriptedSpecialistRunner, modelFromEnv } from "../src/index.js";

describe("specialist contracts", () => {
  it("no specialist may propose BORROW or WITHDRAW", () => {
    for (const c of Object.values(SPECIALISTS)) {
      expect(c.mayNotPropose).toEqual(expect.arrayContaining(["BORROW", "WITHDRAW"]));
      for (const a of [...c.owns, ...c.mayRequest]) expect(c.mayNotPropose).not.toContain(a);
    }
  });

  it("proposal schema is strict: extra fields such as calldata are rejected", () => {
    const ok = { objective: "x", decision: "PROPOSE_PLAN", steps: [], requests: [], summary: "" };
    expect(PlanProposalSchema.safeParse(ok).success).toBe(true);
    expect(PlanProposalSchema.safeParse({ ...ok, calldata: "0x" }).success).toBe(false);
  });

  it("amounts must be positive base-unit integers", () => {
    const step = { stepId: "a", chain: "sui-testnet", action: "PAY", asset: "AMUSD", assetOut: null, payee: null, dependsOn: [], rationale: "" };
    const plan = (amount: string) => ({ objective: "x", decision: "PROPOSE_PLAN", steps: [{ ...step, amount }], requests: [], summary: "" });
    expect(PlanProposalSchema.safeParse(plan("1000000")).success).toBe(true);
    for (const bad of ["0", "-1", "1.5", "1e6"]) expect(PlanProposalSchema.safeParse(plan(bad)).success).toBe(false);
  });

  it("the scripted runner never reports a model", async () => {
    const r = new ScriptedSpecialistRunner(() => ({}));
    const out = await r.propose({ specialist: "PaymentAgent", wakeCondition: "RESOURCE_SHORTFALL", objective: "", context: {}, untrusted: [] });
    expect(out.model).toBeNull();
    expect(r.calls).toBe(1);
  });

  it("model comes from KIDO_MODEL, then OPENAI_MODEL", () => {
    const saved = { ...process.env };
    process.env.KIDO_MODEL = "m-kido";
    expect(modelFromEnv()).toBe("m-kido");
    delete process.env.KIDO_MODEL;
    process.env.OPENAI_MODEL = "m-openai";
    expect(modelFromEnv()).toBe("m-openai");
    process.env = saved;
  });
});
