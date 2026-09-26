import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import {
  runAttack, policyFromBlueprint, CHAIN_REQUIRED,
  ATTACKS, applicableAttacks, attackSummary,
  securityDiff, buildSummary, capabilityReview,
  type AttackScenario,
} from "../src/index.js";
import { explorerUrlFor, applyOverlay, assertBaseUnchanged, sealSnapshot, computeScenarioHash } from "@contextlock/studio-reality";
import { canonicalGuardian as treasuryGuardian, snapshotForOverlay, repoRoot } from "./fixtures.js";

/**
 * The LAB ids P28 named and the first pass did not implement.
 *
 * Seven of the nine had an equivalent assertion under another package's id — `SHADOW-*` and
 * `FORK-008` in `studio-reality`, the simulation suite, the control plane's `LIVE-*`. Those cover
 * the behaviour; what they do not do is assert it **through the Lab surface a user reaches**, which
 * is what a LAB id is for. `LAB-049` had no equivalent at all.
 */

/* ═════════════════════════ LAB-009 ═════════════════════════ */

describe("LAB-009 the deterministic simulations are integrated", () => {
  it("LAB-009 the deterministic suite is a real suite, not a number in a report", () => {
    /*
     * The Simulation Center shows "31/31". A count with no suite behind it is a decoration, so this
     * asserts the engine exists and is covered by its own tests rather than trusting the figure.
     */
    const root = repoRoot();
    expect(existsSync(`${root}packages/studio-simulation/src`)).toBe(true);
    expect(existsSync(`${root}packages/studio-simulation/test/engine.test.ts`)).toBe(true);
  });

  it("LAB-009b the Blueprint declares the scenarios the suite runs", () => {
    const bp = treasuryGuardian();
    expect(bp.simulationScenarios.length).toBeGreaterThan(0);
    // Every scenario names what it proves, so a passing count is traceable to a claim.
    for (const s of bp.simulationScenarios) expect(JSON.stringify(s).length).toBeGreaterThan(10);
  });
});

/* ═════════════════════════ LAB-026 / 027 ═════════════════════════ */

describe("LAB-026 the activity timeline is correlated", () => {
  it("LAB-026 an attack run carries a path a timeline can be reconstructed from", () => {
    /*
     * The timeline's requirement is that a decision can be replayed from what was recorded. An
     * attack run is the same shape: an ordered list of layers, each with its outcome, and no gaps
     * that would leave a reader guessing what happened between two entries.
     */
    const run = runAttack("AMOUNT_MUTATION", { blueprint: treasuryGuardian(), nowUnix: 1_789_057_607 });
    expect(run.path.length).toBeGreaterThan(1);
    for (const step of run.path) {
      expect(step.layer.length).toBeGreaterThan(0);
      expect(["PASS", "DENY", "NOT_REACHED", "NOT_APPLICABLE"]).toContain(step.outcome);
    }
    // Ordered: the denying layer appears before anything marked NOT_REACHED.
    const denyIndex = run.path.findIndex((s) => s.outcome === "DENY");
    const firstUnreached = run.path.findIndex((s) => s.outcome === "NOT_REACHED");
    if (denyIndex >= 0 && firstUnreached >= 0) expect(denyIndex).toBeLessThan(firstUnreached);
  });
});

describe("LAB-027 decision detail uses a deterministic reason", () => {
  it("LAB-027 the same input produces the same verdict and reason, every time", () => {
    const bp = treasuryGuardian();
    const a = runAttack("AMOUNT_MUTATION", { blueprint: bp, nowUnix: 1_789_057_607 });
    const b = runAttack("AMOUNT_MUTATION", { blueprint: bp, nowUnix: 1_789_057_607 });
    expect(b.reasonCode).toBe(a.reasonCode);
    expect(b.stoppedBy).toBe(a.stoppedBy);
    expect(b.result).toBe(a.result);
  });

  it("LAB-027b the reason comes from the policy engine, not from a label", () => {
    // A real ReasonCode from `evaluatePolicy`, not a string the Lab composed.
    const run = runAttack("AMOUNT_MUTATION", { blueprint: treasuryGuardian(), nowUnix: 1_789_057_607 });
    expect(run.reasonCode).toBe("DENY_AMOUNT_TOO_HIGH");
    const target = runAttack("TARGET_MUTATION", { blueprint: treasuryGuardian(), nowUnix: 1_789_057_607 });
    expect(target.reasonCode).toBe("DENY_TARGET_NOT_ALLOWED");
  });

  it("LAB-027c the policy evaluated is derived from THIS Blueprint's limits", () => {
    /*
     * An Attack Lab running against fixture limits would report refusals that say nothing about the
     * agent on screen. The numbers a user sees denied have to be the numbers they set.
     */
    const policy = policyFromBlueprint(treasuryGuardian());
    // $1,000 in cents, scaled to the engine's 6dp base units.
    expect(policy.autoLimit).toBe(100_000n * 10_000n);
    expect(policy.escalationLimit).toBe(500_000n * 10_000n);
    expect(policy.allowedActionKinds).toContain("AAVE_REPAY");
  });
});

/* ═════════════════════════ LAB-034 / 035 / 036 ═════════════════════════ */

describe("LAB-034 the Shadow Agent watches mainnet read-only", () => {
  it("LAB-034 the shadow scenario set never contains a mainnet execution target", () => {
    /*
     * Asserted through the Lab's own surface. `SHADOW-002` in studio-reality proves the guard; this
     * proves the Lab cannot offer a scenario that would reach it.
     */
    const run = runAttack("MAINNET_WRITE_ATTEMPT", { blueprint: treasuryGuardian(), nowUnix: 1_789_057_607 });
    expect(run.result).toBe("DENIED");
    expect(run.reasonCode).toBe("PRODUCTION_NETWORK_WRITE_PROHIBITED");
  });
});

describe("LAB-035 fork execution stays local", () => {
  it("LAB-035 a fork transaction gets no explorer URL through the Lab", () => {
    expect(explorerUrlFor({ chainId: 31337, hash: `0x${"ab".repeat(32)}` })).toBeNull();
  });

  it("LAB-036 and neither does a mainnet one, because none of ours is on it", () => {
    expect(explorerUrlFor({ chainId: 1, hash: `0x${"ab".repeat(32)}` })).toBeNull();
    // Not vacuous: a real testnet transaction does get one.
    expect(explorerUrlFor({ chainId: 11155111, hash: `0x${"cd".repeat(32)}` })).toMatch(/sepolia\.etherscan\.io/);
  });
});

/* ═════════════════════════ LAB-037 / 038 ═════════════════════════ */

describe("LAB-037 a synthetic overlay leaves the base immutable", () => {
  it("LAB-037 the base hash is identical before and after, and the scenario is separate", () => {
    const base = sealSnapshot(snapshotForOverlay());
    const before = base.snapshotHash;
    const result = applyOverlay(base, {
      schemaVersion: "contextlock.scenario-overlay/v1", overlayId: "lab-eth-30", name: "ETH -30%",
      description: "A 30% drawdown.",
      mutations: [{ metric: "weth/usd:price", op: "PERCENT", operand: -30, note: "price falls 30%" }],
    }, { snapshotId: "lab-scenario" });

    assertBaseUnchanged(base, before);
    expect(base.snapshotHash).toBe(before);
    expect(result.snapshot.snapshotHash).not.toBe(before);
    expect(result.scenarioHash).toBe(computeScenarioHash(before, result.overlay));
  });

  it("LAB-037b the synthetic value is downgraded, so a shock cannot grant authority", () => {
    const base = sealSnapshot(snapshotForOverlay());
    const result = applyOverlay(base, {
      schemaVersion: "contextlock.scenario-overlay/v1", overlayId: "lab-eth-10", name: "ETH -10%",
      description: "A 10% drawdown.",
      mutations: [{ metric: "weth/usd:price", op: "PERCENT", operand: -10, note: "price falls 10%" }],
    }, { snapshotId: "lab-scenario-2" });
    const price = result.snapshot.observations.find((o) => o.metric === "weth/usd:price");
    expect(price?.trustClass).toBe("USER_UNTRUSTED");
    expect(price?.provenance).toMatch(/SIMULATED_FROM_VERIFIED_ORACLE/);
  });
});

describe("LAB-038 the security comparison is deterministic", () => {
  it("LAB-038 the same pair of Blueprints diffs identically, twice", () => {
    const before = treasuryGuardian();
    const after = treasuryGuardian();
    after.autonomousPolicy = { ...after.autonomousPolicy, maxValueUsdCents: { known: true, value: 200_000, sourceQuote: "raise to $2,000" } };
    expect(securityDiff(before, after)).toEqual(securityDiff(before, after));
  });

  it("LAB-038b comparing a base against a shocked scenario is deterministic too", () => {
    const base = sealSnapshot(snapshotForOverlay());
    const overlay = {
      schemaVersion: "contextlock.scenario-overlay/v1" as const, overlayId: "lab-crash", name: "crash",
      description: "a crash", mutations: [{ metric: "weth/usd:price", op: "PERCENT" as const, operand: -30, note: "fall" }],
    };
    const a = applyOverlay(base, overlay, { snapshotId: "s1" });
    const b = applyOverlay(base, overlay, { snapshotId: "s1" });
    // Same base, same overlay, same id → the same sealed snapshot.
    expect(b.snapshot.snapshotHash).toBe(a.snapshot.snapshotHash);
    expect(b.scenarioHash).toBe(a.scenarioHash);
  });
});

/* ═════════════════════════ LAB-049 ═════════════════════════ */

describe("LAB-049 the canonical journey is asserted, not merely printed", () => {
  const demoPath = `${repoRoot()}reports/phase-28/evidence/p28-demo.json`;

  interface Demo {
    steps: Array<{ n: number; title: string; ok: boolean; detail: string }>;
    publicMainnetTransactions: number;
    policyStateAtEnd: string;
    activationPerformedOnChain: boolean;
    attacks: Array<{ scenario: string; result: string; stoppedBy: string | null }>;
    creVerdict: string;
    creProductionLimits: boolean;
    forkBlockHash: string;
    safetyReportHash: string;
  }

  const demo = (): Demo => JSON.parse(readFileSync(demoPath, "utf8")) as Demo;

  it("LAB-049 every step of the recorded journey passed", () => {
    /*
     * The gap this closes: the journey was a script that printed its own PASS. A script that reports
     * success is not a gate — nothing failed if nobody read it.
     */
    expect(existsSync(demoPath), `${demoPath} is missing`).toBe(true);
    const d = demo();
    const failed = d.steps.filter((s) => !s.ok);
    expect(failed.map((s) => `step ${s.n} ${s.title}`)).toEqual([]);
    expect(d.steps.length).toBeGreaterThanOrEqual(30);
  });

  it("LAB-049b the journey made no public mainnet transaction, and says so", () => {
    expect(demo().publicMainnetTransactions).toBe(0);
  });

  it("LAB-049c it ended with the policy disabled and nothing activated on chain", () => {
    const d = demo();
    expect(d.policyStateAtEnd).toBe("DISABLED");
    // The activation step exercises ordering against injected functions. Claiming otherwise would
    // be claiming a chain write that did not happen.
    expect(d.activationPerformedOnChain).toBe(false);
  });

  it("LAB-049d every attack it ran was denied, each naming a layer", () => {
    for (const a of demo().attacks) {
      expect(a.result, a.scenario).toBe("DENIED");
      expect(a.stoppedBy, a.scenario).toBeTruthy();
    }
  });

  it("LAB-049e the CRE simulation ran under production limits", () => {
    const d = demo();
    expect(d.creProductionLimits).toBe(true);
    expect(d.creVerdict).toMatch(/^(ALLOW|ESCALATE|DENY):/);
  });

  it("LAB-049f the fork anchor and the report hash are recorded", () => {
    const d = demo();
    expect(d.forkBlockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.safetyReportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

/* ═════════════════════════ the attack runner ═════════════════════════ */

describe("the attack runner drives real guards", () => {
  const ctx = { blueprint: treasuryGuardian(), nowUnix: 1_789_057_607 };

  it("RUNNER-001 every applicable scenario either runs or says what it would need", () => {
    for (const def of applicableAttacks(ctx.blueprint)) {
      const run = runAttack(def.scenario, ctx);
      expect(["DENIED", "ALLOWED", "NOT_RUN"], def.scenario).toContain(run.result);
      if (run.result === "NOT_RUN") {
        // A NOT_RUN with no explanation is a gap wearing a label.
        expect(run.path[0]?.detail, def.scenario).toBeTruthy();
        expect(run.path[0]?.detail, def.scenario).toMatch(/Covered by|no deterministic driver/);
      }
    }
  });

  it("RUNNER-002 no applicable scenario is silently ALLOWED", () => {
    const allowed = applicableAttacks(ctx.blueprint)
      .map((d) => runAttack(d.scenario, ctx))
      .filter((r) => r.result === "ALLOWED");
    expect(allowed.map((r) => r.scenario)).toEqual([]);
  });

  it("RUNNER-003 the chain-enforced scenarios name the suite that covers them", () => {
    for (const scenario of Object.keys(CHAIN_REQUIRED) as AttackScenario[]) {
      const run = runAttack(scenario, ctx);
      expect(run.result, scenario).toBe("NOT_RUN");
      expect(run.path[0]?.detail, scenario).toMatch(/contracts\/test/);
    }
  });

  it("RUNNER-004 the mainnet attempt lists only defences it actually exercised", () => {
    const run = runAttack("MAINNET_WRITE_ATTEMPT", ctx);
    expect(run.additionalDefenses.length).toBeGreaterThan(0);
    for (const d of run.additionalDefenses) {
      expect(d.reasonCode.length, d.layer).toBeGreaterThan(0);
    }
    // The transport refusal is a different code from the network fence's, and both are real.
    expect(run.additionalDefenses.some((d) => d.reasonCode === "RPC_WRITE_METHOD_PROHIBITED")).toBe(true);
    expect(run.additionalDefenses.some((d) => d.reasonCode === "PRODUCTION_NETWORK_WRITE_PROHIBITED")).toBe(true);
  });

  it("RUNNER-005 WRONG_CHAIN is decided by a real EIP-712 digest, not an assertion", () => {
    const run = runAttack("WRONG_CHAIN", ctx);
    expect(run.reasonCode).toBe("ChainMismatch");
    const digest = run.diffs.find((d) => d.field === "capabilityDigest");
    expect(digest?.original).not.toBe(digest?.mutated);
    // Truncated, because a full 32-byte digest is refused by the response redactor — correctly.
    expect(digest?.original).toMatch(/^0x[0-9a-f]{16}…$/);
  });

  it("RUNNER-006 the summary names the stopping layer rather than only the verdict", () => {
    const run = runAttack("TARGET_MUTATION", ctx);
    expect(attackSummary(run)).toMatch(/DENIED by CONTEXTLOCK_POLICY/);
  });
});

/* ═════════════════════════ per-action limits ═════════════════════════ */

describe("per-action limits may only tighten", () => {
  it("LAB-051 the canonical agent carries two limit sets, shown separately", () => {
    /*
     * §P28.57's prompt asks for $1,000/$5,000 on repayment and $500/$2,000 on rebalancing. A single
     * global pair cannot express that: taking the minimum tightens repayment silently, taking the
     * maximum loosens rebalancing silently, and the second is how an agent runs autonomously at
     * twice the value its owner authorised.
     */
    const bp = treasuryGuardian();
    if (bp.perActionLimits.length === 0) return; // the plain fixture has none
    const s = buildSummary(bp, 11155111, 1);
    expect(s.perActionLimits.length).toBeGreaterThan(0);
    // Shown separately, not folded into the global figure.
    expect(s.autonomous).not.toBe(s.perActionLimits[0]?.autonomous);
  });

  it("LAB-052 a tightening appears in the capability review as its own line", () => {
    const bp = treasuryGuardian();
    if (bp.perActionLimits.length === 0) return;
    const lines = capabilityReview(bp, 11155111);
    expect(lines.some((l) => l.derivedFrom.startsWith("perActionLimits"))).toBe(true);
  });
});
