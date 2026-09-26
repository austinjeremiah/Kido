import { describe, it, expect } from "vitest";
import {
  compileStrategy, describeCondition, propagateTrust, propagateFreshness,
  generateStrategyScenarios,
  assertComparable, UnitMismatchError, UNITS, unit, tokenToUsd, ratioToBps, rescale, percentToBps,
  STRATEGY_IR_VERSION, type Strategy,
} from "../src/index.js";
import { treasuryStrategy } from "./fixtures.js";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Every negative test names the code it expects. "Some rejection" is not evidence. */
function expectProblem(r: { problems: Array<{ code: string }> }, code: string) {
  const codes = r.problems.map((p) => p.code);
  expect(codes, `expected ${code}, got ${codes.join(", ") || "none"}`).toContain(code);
}

/* ───────────────────────────── STRAT-001 ──────────────────────────────────── */

describe("STRAT-001 a valid strategy compiles", () => {
  it("accepts the canonical treasury strategy", () => {
    const r = compileStrategy(treasuryStrategy());
    expect(r.problems.filter((p) => p.severity === "CRITICAL" || p.severity === "HIGH")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.buildable).toBe(true);
  });

  it("computes provenance for every derived node", () => {
    const r = compileStrategy(treasuryStrategy());
    expect(r.provenance["eth-usd-value"]!.unit.kind).toBe("USD_VALUE");
    expect(r.provenance["eth-allocation-bps"]!.unit).toEqual(UNITS.bps);
  });

  it("STRAT-017 the same IR compiles identically every time", () => {
    const a = compileStrategy(treasuryStrategy());
    const b = compileStrategy(treasuryStrategy());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.order).toEqual(["eth-price", "eth-balance", "portfolio-usd", "eth-usd-value", "eth-allocation-bps"]);
  });
});

/* ─────────────────────── STRAT-003 unit safety ────────────────────────────── */

describe("STRAT-003 unit mismatches are rejected", () => {
  it("rejects comparing a token amount against a USD threshold", () => {
    const s = clone(treasuryStrategy());
    s.decisions[0]!.when = {
      type: "compare", op: "LT",
      left: { type: "ref", id: "eth-balance" },
      right: { type: "literal", value: "50000", unit: UNITS.usd },
    };
    expectProblem(compileStrategy(s), "STRAT-UNIT-KIND");
  });

  it("rejects comparing a health factor against basis points", () => {
    // 1.6 is 1600000000000000000 in WAD and 16000 in bps. "They're both health-ish" is the bug.
    expect(() => assertComparable(UNITS.healthFactor, UNITS.bps, "test")).toThrow(UnitMismatchError);
    try {
      assertComparable(UNITS.healthFactor, UNITS.bps, "test");
    } catch (e) {
      expect((e as UnitMismatchError).code).toBe("STRAT-UNIT-KIND");
    }
  });

  it("rejects the same unit at different scales", () => {
    try {
      assertComparable(UNITS.usd, UNITS.usdCents, "test");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as UnitMismatchError).code).toBe("STRAT-UNIT-SCALE");
    }
  });

  it("rejects the same kind with a different subject", () => {
    // USDC and WETH are both TOKEN_AMOUNT and are not interchangeable.
    try {
      assertComparable(UNITS.token("USDC", 18), UNITS.token("WETH", 18), "test");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as UnitMismatchError).code).toBe("STRAT-UNIT-SUBJECT");
    }
  });

  it("rejects adding a health factor to anything", () => {
    const s = clone(treasuryStrategy());
    s.inputs.push({
      id: "hf", requirementKey: "hf", dataKind: "aave_position_health_factor",
      unit: UNITS.healthFactor, minimumTrustClass: "DIRECT_CHAIN_DATA", maxAgeMs: 60_000, description: "hf",
    });
    s.transforms.push({ id: "nonsense", op: "SUM", inputs: ["hf", "hf"], description: "meaningless" });
    s.decisions[0]!.when = {
      type: "compare", op: "LT", left: { type: "ref", id: "nonsense" }, right: { type: "literal", value: "1", unit: UNITS.healthFactor },
    };
    expectProblem(compileStrategy(s), "STRAT-UNIT-ADD");
  });

  it("rejects a ratio of unlike units", () => {
    const s = clone(treasuryStrategy());
    s.transforms[1] = { id: "eth-allocation-bps", op: "RATIO_TO_BPS", inputs: ["eth-balance", "portfolio-usd"], description: "token / USD" };
    expectProblem(compileStrategy(s), "STRAT-UNIT-KIND");
  });

  it("permits the conversions that are written down", () => {
    const usd = tokenToUsd({ value: 1_500_000_000_000_000_000n, unit: UNITS.token("ETH", 18) }, { value: 249_356_368_692n, unit: UNITS.price("USD", 8) });
    expect(usd.unit.kind).toBe("USD_VALUE");
    expect(usd.value).toBe(374_034_553_038n);
    const bps = ratioToBps({ value: 40n, unit: UNITS.usd }, { value: 100n, unit: UNITS.usd });
    expect(bps.value).toBe(4000n);
    expect(percentToBps({ value: 4000n, unit: UNITS.percent }).value).toBe(4000n);
    expect(rescale({ value: 100_000_000n, unit: UNITS.usd }, 2).value).toBe(100n);
  });

  it("a price in the wrong quote currency does not silently become USD", () => {
    const eur = tokenToUsd({ value: 10n ** 18n, unit: UNITS.token("ETH", 18) }, { value: 100n, unit: unit("PRICE", 8, "EUR") });
    expect(eur.unit.subject).toBe("EUR");
    expect(() => assertComparable(eur.unit, UNITS.usd, "compare")).toThrow(/STRAT-UNIT-SUBJECT/);
  });
});

/* ─────────────────── STRAT-004/005 trust and freshness flow ───────────────── */

describe("STRAT-004 trust propagates to the weakest input", () => {
  it("a derived value cannot outrank its weakest dependency", () => {
    // Otherwise combining a weak source with a strong one launders the weak one.
    expect(propagateTrust(["VERIFIED_ORACLE", "INDEXED_CHAIN_DATA"])).toBe("INDEXED_CHAIN_DATA");
    expect(propagateTrust(["VERIFIED_ORACLE", "DIRECT_CHAIN_DATA", "INDEXED_CHAIN_DATA"])).toBe("DIRECT_CHAIN_DATA");
    expect(propagateTrust(["CONFIDENTIAL_VERIFIED_COMPUTE", "VERIFIED_ORACLE"])).toBe("VERIFIED_ORACLE");
    expect(propagateTrust([])).toBe("USER_UNTRUSTED");
  });

  it("the compiled allocation carries the weakest of its inputs", () => {
    const r = compileStrategy(treasuryStrategy());
    // eth-usd-value = balance(INDEXED) × price(VERIFIED_ORACLE) → INDEXED, the weaker of the two.
    expect(r.provenance["eth-usd-value"]!.trustClass).toBe("INDEXED_CHAIN_DATA");
    // eth-allocation-bps = that ÷ portfolio-usd(DIRECT_CHAIN_DATA) → DIRECT, which ranks BELOW
    // indexed: trust ranks corroboration, not recency, so a single RPC read is the weaker link.
    expect(r.provenance["eth-allocation-bps"]!.trustClass).toBe("DIRECT_CHAIN_DATA");
  });

  it("a decision resting on untrusted data is rejected", () => {
    const s = clone(treasuryStrategy());
    s.inputs[0]!.minimumTrustClass = "USER_UNTRUSTED";
    expectProblem(compileStrategy(s), "STRAT-TRUST-FLOOR");
  });
});

describe("STRAT-005 freshness propagates to the stalest input", () => {
  it("a derived value is only as fresh as its stalest dependency", () => {
    expect(propagateFreshness([3_000, 120_000])).toBe(120_000);
    expect(propagateFreshness([])).toBe(0);
  });

  it("the compiled allocation inherits the loosest bound", () => {
    const r = compileStrategy(treasuryStrategy());
    // A 30s price combined with a 120s balance is a 120s value, not a 30s one.
    expect(r.provenance["eth-allocation-bps"]!.maxAgeMs).toBe(120_000);
    expect(r.provenance["eth-price"]!.maxAgeMs).toBe(30_000);
  });
});

/* ────────────────── STRAT-011/012/013/014 decision integrity ───────────────── */

describe("STRAT-011 an action with no decision is rejected", () => {
  it("fails with STRAT-ACTION-NO-DECISION", () => {
    const s = clone(treasuryStrategy());
    s.actions.push({ id: "sneaky-transfer", capability: "TOKEN_SWAP", actionKind: "TRANSFER", recipientPolicy: "self-only", description: "no decision routes this" });
    expectProblem(compileStrategy(s), "STRAT-ACTION-NO-DECISION");
    expect(compileStrategy(s).buildable).toBe(false);
  });
});

describe("STRAT-012 implicit ALLOW is not expressible", () => {
  it("an unbounded amount is rejected", () => {
    const s = clone(treasuryStrategy());
    s.decisions[0]!.autonomousMaxUsdCents = null;
    s.decisions[0]!.escalationMaxUsdCents = null;
    expectProblem(compileStrategy(s), "STRAT-UNBOUNDED-AMOUNT");
  });

  it("the IR has no way to say 'condition true therefore execute'", () => {
    // aboveCeiling is a literal "DENY". There is no other value to give it.
    const s = treasuryStrategy();
    expect(s.decisions[0]!.aboveCeiling).toBe("DENY");
    const bad = clone(s) as unknown as Record<string, unknown>;
    (bad.decisions as Array<Record<string, unknown>>)[0]!.aboveCeiling = "ALLOW";
    expectProblem(compileStrategy(bad), "STRAT-SCHEMA");
  });

  it("an inverted band is rejected", () => {
    const s = clone(treasuryStrategy());
    s.decisions[0]!.escalationMaxUsdCents = 100;
    expectProblem(compileStrategy(s), "STRAT-BAND-INVERTED");
  });
});

describe("STRAT-014 an unbounded recipient is rejected", () => {
  it("only self-only and allow-list are expressible", () => {
    const s = clone(treasuryStrategy()) as unknown as Record<string, unknown>;
    (s.actions as Array<Record<string, unknown>>)[0]!.recipientPolicy = "anyone";
    expectProblem(compileStrategy(s), "STRAT-SCHEMA");
  });
});

/* ──────────────────── STRAT-015/016 graph integrity ───────────────────────── */

describe("STRAT-015 a cyclic graph is rejected", () => {
  it("fails with STRAT-CYCLE", () => {
    const s = clone(treasuryStrategy());
    s.transforms.push({ id: "loop-a", op: "SUM", inputs: ["loop-b"], description: "a" });
    s.transforms.push({ id: "loop-b", op: "SUM", inputs: ["loop-a"], description: "b" });
    expectProblem(compileStrategy(s), "STRAT-CYCLE");
  });

  it("an unknown reference is distinguished from a cycle", () => {
    const s = clone(treasuryStrategy());
    s.transforms.push({ id: "dangling", op: "SUM", inputs: ["nothing-declares-this"], description: "x" });
    const r = compileStrategy(s);
    expectProblem(r, "STRAT-UNKNOWN-REF");
    expect(r.problems.map((p) => p.code)).not.toContain("STRAT-CYCLE");
  });
});

describe("STRAT-016 unreachable and unused nodes are surfaced", () => {
  it("an input nobody reads is reported", () => {
    const s = clone(treasuryStrategy());
    s.inputs.push({
      id: "never-used", requirementKey: "x", dataKind: "historical_swap_volume",
      unit: UNITS.usd, minimumTrustClass: "INDEXED_CHAIN_DATA", maxAgeMs: 600_000, description: "fetched and ignored",
    });
    expectProblem(compileStrategy(s), "STRAT-UNUSED-INPUT");
  });

  it("a transform nobody reads is reported", () => {
    const s = clone(treasuryStrategy());
    s.transforms.push({ id: "orphan", op: "RESCALE", inputs: ["portfolio-usd"], toDecimals: 2, description: "computed, never used" });
    expectProblem(compileStrategy(s), "STRAT-UNUSED-TRANSFORM");
  });
});

/* ───────────────────── STRAT-002 unknowns block the build ─────────────────── */

describe("STRAT-002 an unknown financial limit stays unknown", () => {
  it("a BUILD-blocking unknown makes the strategy unbuildable", () => {
    const s = clone(treasuryStrategy());
    s.unknowns.push({ field: "escalationMaxUsdCents", reason: "the prompt never stated a hard deny ceiling", requiredBefore: "BUILD" });
    const r = compileStrategy(s);
    expectProblem(r, "STRAT-UNKNOWN-LIMIT");
    expect(r.buildable).toBe(false);
    expect(r.problems.find((p) => p.code === "STRAT-UNKNOWN-LIMIT")!.remediation).toMatch(/must not be invented/);
  });

  it("a DEPLOY-only unknown does not block the build", () => {
    const s = clone(treasuryStrategy());
    s.unknowns.push({ field: "treasuryAddress", reason: "assigned at deployment", requiredBefore: "DEPLOY" });
    expect(compileStrategy(s).buildable).toBe(true);
  });
});

/* ───────────────────── STRAT-019 multi-step deferral ──────────────────────── */

describe("STRAT-019 a multi-step need is identified, not improvised", () => {
  it("carries REQUIRES_P19_CAPABILITY through compilation", () => {
    const s = clone(treasuryStrategy());
    s.requiresCapability = ["REQUIRES_P19_CAPABILITY"];
    const r = compileStrategy(s);
    expect(r.requiresCapability).toEqual(["REQUIRES_P19_CAPABILITY"]);
  });

  it("the IR cannot express a chained action sequence", () => {
    // An action has one capability and one kind. There is no "then" field to abuse, so a
    // swap-then-repay plan cannot be smuggled in as a single action.
    const a = treasuryStrategy().actions[0]!;
    expect(Object.keys(a).sort()).toEqual(["actionKind", "capability", "description", "id", "recipientPolicy", "spendsAsset"]);
  });
});

/* ──────────────────── STRAT-008/009/010 boundary generation ───────────────── */

describe("STRAT-008/009/010 boundary simulations are generated", () => {
  const s = treasuryStrategy();
  const scenarios = generateStrategyScenarios(s, compileStrategy(s));

  it("produces below / at / above for every comparison", () => {
    const ids = scenarios.map((x) => x.scenarioId);
    expect(ids.some((i) => i.endsWith("-BELOW"))).toBe(true);
    expect(ids.some((i) => i.endsWith("-AT"))).toBe(true);
    expect(ids.some((i) => i.endsWith("-ABOVE"))).toBe(true);
  });

  it("produces the full amount band including both exact edges", () => {
    const ids = scenarios.map((x) => x.scenarioId);
    for (const suffix of ["AMOUNT-BELOW-AUTO", "AMOUNT-AT-AUTO", "AMOUNT-IN-ESCALATION", "AMOUNT-AT-CEILING", "AMOUNT-ABOVE-CEILING"]) {
      expect(ids.some((i) => i.endsWith(suffix)), suffix).toBe(true);
    }
    expect(scenarios.find((x) => x.scenarioId.endsWith("AMOUNT-ABOVE-CEILING"))!.expectedDisposition).toBe("DENY");
    expect(scenarios.find((x) => x.scenarioId.endsWith("AMOUNT-AT-CEILING"))!.expectedDisposition).toBe("ESCALATE");
  });

  it("produces valid / stale / unavailable / wrong-trust for every data source", () => {
    for (const input of s.inputs) {
      const forInput = scenarios.filter((x) => x.perturbation.nodeId === input.id && x.kind === "DATA_SOURCE");
      expect(forInput.map((x) => x.perturbation.position).sort(), input.id).toEqual([
        "STALE", "UNAVAILABLE", "VALID", "WRONG_TRUST",
      ]);
    }
  });

  it("generation is deterministic", () => {
    const a = generateStrategyScenarios(s, compileStrategy(s));
    const b = generateStrategyScenarios(s, compileStrategy(s));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/* ────────────────────────── condition rendering ───────────────────────────── */

describe("a compiled condition can be read and argued with", () => {
  it("renders to a human-checkable sentence", () => {
    expect(describeCondition(treasuryStrategy().decisions[0]!.when)).toBe(
      "eth-allocation-bps < 4000 BASIS_POINTS@4dp",
    );
  });

  it("renders nested logic", () => {
    const c = {
      type: "and" as const,
      children: [
        treasuryStrategy().decisions[0]!.when,
        { type: "not" as const, child: treasuryStrategy().decisions[0]!.when },
      ],
    };
    expect(describeCondition(c)).toContain(" AND ");
    expect(describeCondition(c)).toContain("NOT ");
  });

  it("a condition is an AST, never an expression string", () => {
    // The property that matters: nothing here is ever passed to an evaluator.
    const json = JSON.stringify(treasuryStrategy().decisions[0]!.when);
    expect(json).not.toMatch(/eval|Function|=>/);
    expect(JSON.parse(json).type).toBe("compare");
  });
});

describe("schema version", () => {
  it("is pinned", () => {
    expect(STRATEGY_IR_VERSION).toBe("contextlock.strategy/v1");
    const s = clone(treasuryStrategy()) as unknown as Record<string, unknown>;
    s.schemaVersion = "contextlock.strategy/v2";
    expectProblem(compileStrategy(s), "STRAT-SCHEMA");
  });
});
