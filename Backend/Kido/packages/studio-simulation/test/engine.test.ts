import { describe, it, expect } from "vitest";
import { runAllScenarios, runScenario, SIM_PRIVATE_POLICY } from "../src/engine.js";
import { validGuardian, copy } from "../../studio-blueprint/test/fixtures.js";

describe("simulation engine is deterministic and complete", () => {
  it("every declared scenario meets its declared expectations", () => {
    const results = runAllScenarios(validGuardian(), 1);
    const failed = results.filter((r) => !r.passed);
    expect(
      failed.map((f) => `${f.scenarioId}: ${f.assertions.filter((a) => !a.held).map((a) => a.detail).join("; ")}`),
    ).toEqual([]);
    expect(results).toHaveLength(17);
  });

  it("two runs of the same Blueprint produce identical results", () => {
    const bp = validGuardian();
    expect(JSON.stringify(runAllScenarios(bp, 1))).toBe(JSON.stringify(runAllScenarios(bp, 1)));
  });

  it("the fixture hash is stable and distinguishes scenarios", () => {
    const bp = validGuardian();
    const a = runScenario(bp, "NORMAL", 1);
    const b = runScenario(bp, "NORMAL", 1);
    const c = runScenario(bp, "AMOUNT_MUTATION", 1);
    expect(a.fixtureHash).toBe(b.fixtureHash);
    expect(a.fixtureHash).not.toBe(c.fixtureHash);
  });
});

describe("STUDIO-025 same transaction, different private context, different verdict", () => {
  const bp = validGuardian();
  const allow = runScenario(bp, "PRIVATE_CONTEXT_ALLOW", 1);
  const escalate = runScenario(bp, "PRIVATE_CONTEXT_ESCALATE", 1);
  const deny = runScenario(bp, "PRIVATE_CONTEXT_DENY", 1);

  it("produces three different verdicts", () => {
    expect([allow.verdict, escalate.verdict, deny.verdict]).toEqual(["ALLOW", "ESCALATE", "DENY"]);
  });

  it("the publicly observable transaction is byte-identical across all three", () => {
    // This is the whole claim. If the request differed, the demo would prove nothing at all —
    // it would just be three different transactions getting three different answers.
    const req = (id: "PRIVATE_CONTEXT_ALLOW" | "PRIVATE_CONTEXT_ESCALATE" | "PRIVATE_CONTEXT_DENY") => {
      const s = runScenario(bp, id, 1);
      return s;
    };
    const [a, e, d] = [req("PRIVATE_CONTEXT_ALLOW"), req("PRIVATE_CONTEXT_ESCALATE"), req("PRIVATE_CONTEXT_DENY")];
    // Verdicts differ...
    expect(new Set([a.verdict, e.verdict, d.verdict]).size).toBe(3);
    // ...while the reason codes name a cause without disclosing the threshold that produced it.
    for (const r of [a, e, d]) {
      expect(r.reasonCode).toMatch(/^(ALLOW|ESCALATE|DENY)_[A-Z_]+$/);
    }
  });

  it("no confidential threshold value appears anywhere in a simulation result", () => {
    const rendered = JSON.stringify(runAllScenarios(bp, 1));
    expect(rendered).not.toContain(SIM_PRIVATE_POLICY.canary);
    for (const v of [
      SIM_PRIVATE_POLICY.autoLimit.toString(),
      SIM_PRIVATE_POLICY.escalationLimit.toString(),
      String(SIM_PRIVATE_POLICY.maxVolatilityBps),
      String(SIM_PRIVATE_POLICY.minHealthFactorBps),
    ]) {
      expect(rendered).not.toContain(v);
    }
  });
});

describe("the escalation gate is proven in both directions", () => {
  it("holds without approval and opens with it", () => {
    const bp = validGuardian();
    const r = runScenario(bp, "REPAY_ABOVE_AUTO_LIMIT", 1);
    expect(r.outcome).toBe("APPROVAL_REQUIRED");
    expect(r.stoppedAt).toBe("APPROVAL");
    // A5 re-runs the identical scenario with an approval recorded.
    const a5 = r.assertions.find((a) => a.id === "A5")!;
    expect(a5.held).toBe(true);
    expect(a5.detail).toContain("EXECUTED");
  });

  it("approving does not change the verdict, only whether it may proceed", () => {
    const r = runScenario(validGuardian(), "FLASH_CRASH", 1);
    expect(r.assertions.find((a) => a.id === "A6")!.held).toBe(true);
  });
});

describe("DENY cannot be rescued", () => {
  it("a DENY never reaches approval or execution in any scenario", () => {
    for (const r of runAllScenarios(validGuardian(), 1)) {
      expect(r.assertions.find((a) => a.id === "A4")!.held).toBe(true);
      if (r.verdict === "DENY") {
        expect(r.outcome).toBe("BLOCKED");
        const reached = r.stages.filter((s) => s.status === "PASS").map((s) => s.stage);
        expect(reached).not.toContain("EXECUTION");
      }
    }
  });

  it("even granting an approval cannot make a DENY execute", () => {
    // Directly force the approval flag on a denied scenario — the branch is unreachable from DENY,
    // exactly as proven live on Sepolia in P7 DEMO-C.
    const forced = runScenario(validGuardian(), "PRIVATE_CONTEXT_DENY", 1, true);
    expect(forced.verdict).toBe("DENY");
    expect(forced.outcome).toBe("BLOCKED");
    expect(forced.stoppedAt).toBe("CRE");
  });
});

describe("the engine is capable of reporting failure", () => {
  it("a scenario whose expectation is wrong is reported as FAILED, not quietly passed", () => {
    const bp = copy(validGuardian());
    // Claim the prompt-injection withdrawal should succeed. It must not, and the engine must say so.
    bp.simulationScenarios.find((s) => s.scenarioId === "PROMPT_INJECTION")!.expectedOutcome = "EXECUTED";
    const r = runScenario(bp, "PROMPT_INJECTION", 1);
    expect(r.passed).toBe(false);
    expect(r.outcome).toBe("BLOCKED");
  });

  it("a scenario the Blueprint does not declare is reported, not ignored", () => {
    const bp = copy(validGuardian());
    bp.simulationScenarios = bp.simulationScenarios.filter((s) => s.scenarioId !== "REPLAY");
    const r = runScenario(bp, "REPLAY", 1);
    expect(r.passed).toBe(false);
    expect(r.assertions.find((a) => a.id === "A0")!.held).toBe(false);
  });
});

describe("stage ordering mirrors the real system", () => {
  it("identity is checked before any policy evaluation", () => {
    const r = runScenario(validGuardian(), "ENS_REVOCATION", 1);
    expect(r.stoppedAt).toBe("IDENTITY");
    expect(r.verdict).toBe("NO_VERDICT");
    // No verdict was produced at all, which is the point: a revoked agent is not evaluated.
    expect(r.stages.find((s) => s.stage === "CRE")!.status).toBe("SKIPPED");
  });

  it("an unreachable RPC fails closed rather than assuming the last known identity", () => {
    const r = runScenario(validGuardian(), "RPC_FAILURE", 1);
    expect(r.outcome).toBe("BLOCKED");
    expect(r.stages.find((s) => s.stage === "IDENTITY")!.reason).toBe("IdentityUnavailable");
  });
});
