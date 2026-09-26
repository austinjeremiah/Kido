import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";
import {
  ExecutionPlanSchema,
  planHash,
  stepHash,
  capabilityScopeFor,
  canonicalize,
  assertStepExecutable,
  dependenciesSatisfied,
  derivePlanState,
  runnableSteps,
  PlanError,
  PLAN_REASONS,
  ArrivalRegistry,
  ARRIVAL_REASONS,
  generatePlanScenarios,
  projectPlanGraph,
} from "../src/index.js";
import {
  bridgePlan, clone, withStatus, OWNER, ATTACKER, USDC_SEPOLIA,
  SEPOLIA, BASE_SEPOLIA, SEPOLIA_SELECTOR, BASE_SELECTOR,
} from "./fixtures.js";
import {
  ChainlinkCcipAdapter, CCIP_ROUTER_ABI, ccipDeploymentFor, chainIdForSelector, laneIsVerified,
  ingestChainedPlan, CHAINED_REASONS,
  type CcipConstraints, type CcipIntent, type CcipPrepared,
} from "@contextlock/studio-adapters";

const NOW = 1_700_000_000_000;

/** Every rejection assertion names the exact code. Cross-chain failures all look alike otherwise. */
const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) {
    if (e instanceof PlanError) return e.reason;
    throw e;
  }
  throw new Error("expected a rejection, but the call succeeded");
};

const scope = (p = bridgePlan(), id = "bridge") => capabilityScopeFor(p, id);
const auth = (capabilityScope: string, humanApproved = false) => ({ capabilityScope, humanApproved });

describe("the execution plan", () => {
  it("PLAN-001 the canonical two-step plan is schema valid", () => {
    const r = ExecutionPlanSchema.safeParse(bridgePlan());
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });

  it("PLAN-002 canonical hashing is deterministic and key-order independent", () => {
    const a = bridgePlan();
    const b = clone(a);
    // Re-serialise one step with its keys in a different order.
    const s = b.steps[0]!;
    b.steps[0] = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(s).reverse()))) as typeof s;
    expect(planHash(b)).toBe(planHash(a));
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("PLAN-002b execution progress does not change a plan's identity", () => {
    const a = bridgePlan();
    // If status were hashed, running the plan would invalidate its own authorization.
    expect(planHash(withStatus(a, "bridge", "CONFIRMED"))).toBe(planHash(a));
  });

  it("PLAN-003 a step hash binds the step to its plan", () => {
    const a = bridgePlan();
    const b = clone(a);
    b.planId = "plan-somewhere-else";
    // Byte-identical step, different plan: different hash, so its capability is not portable.
    expect(b.steps[0]).toEqual(a.steps[0]);
    expect(stepHash(b, "bridge")).not.toBe(stepHash(a, "bridge"));
  });

  it("PLAN-004 every mutation that changes what executes changes the hash", () => {
    const base = bridgePlan();
    const h = planHash(base);
    const mutations: Array<[string, (p: ReturnType<typeof bridgePlan>) => void]> = [
      ["recipient", (p) => { (p.steps[0]!.normalizedIntent as Record<string, unknown>).receiver = ATTACKER; }],
      ["amount", (p) => { (p.steps[0]!.normalizedIntent as Record<string, unknown>).amount = "999999999"; }],
      ["destination chain", (p) => { (p.steps[0]!.normalizedIntent as Record<string, unknown>).destinationChainId = 1; }],
      ["adapter", (p) => { p.steps[0]!.adapterId = "some-other-adapter"; }],
      ["adapter version", (p) => { p.steps[0]!.adapterVersion = "9.9.9"; }],
      ["step order", (p) => { p.steps.reverse(); }],
      ["step dependency", (p) => { p.steps[1]!.dependencies = []; }],
      ["target chain", (p) => { p.steps[1]!.chainId = 1; }],
      ["action", (p) => { p.steps[1]!.action = "WITHDRAW"; }],
      ["timeout", (p) => { p.steps[0]!.timeoutMs = 1; }],
      ["disposition", (p) => { p.steps[1]!.authorizationRequirement.disposition = "REQUIRES_HUMAN"; }],
      ["value band", (p) => { p.steps[1]!.authorizationRequirement.valueUsdCents = 1_000_000; }],
      ["required steps", (p) => { p.completionPolicy.requiredStepIds = ["bridge"]; }],
      ["failure policy", (p) => { p.failurePolicy.onStepFailure = "ABORT_REMAINING"; }],
    ];
    for (const [label, mutate] of mutations) {
      const p = clone(base);
      mutate(p);
      // Guard against a mutation that quietly does nothing: a no-op would "pass" this test by
      // hashing identically for the wrong reason, which is how the disposition case slipped in.
      expect(JSON.stringify(p), `mutating ${label} must actually change the plan`).not.toBe(JSON.stringify(base));
      expect(planHash(p), `mutating ${label} must change the plan hash`).not.toBe(h);
    }
  });

  it("PLAN-005 a dependency is satisfied only by a CONFIRMED step, never a submitted one", () => {
    const p = bridgePlan();
    expect(dependenciesSatisfied(p, "supply")).toEqual({ ok: false, missing: ["bridge"] });
    expect(dependenciesSatisfied(withStatus(p, "bridge", "SUBMITTED"), "supply")).toEqual({ ok: false, missing: ["bridge"] });
    expect(dependenciesSatisfied(withStatus(p, "bridge", "CONFIRMED"), "supply")).toEqual({ ok: true });
  });

  it("PLAN-005b out-of-order execution is PLAN-DEPENDENCY-NOT-SATISFIED", () => {
    const p = bridgePlan();
    expect(reasonOf(() => assertStepExecutable(p, "supply", auth(scope(p, "supply")), NOW, NOW)))
      .toBe(PLAN_REASONS.DEPENDENCY_NOT_SATISFIED);
  });

  it("PLAN-006 a step's capability cannot execute another step", () => {
    const p = withStatus(bridgePlan(), "bridge", "CONFIRMED");
    // The scope minted for step 1, presented for step 2.
    const stolen = capabilityScopeFor(p, "bridge");
    expect(reasonOf(() => assertStepExecutable(p, "supply", auth(stolen), NOW, NOW)))
      .toBe(PLAN_REASONS.SCOPE_MISMATCH);
    // ...and the correct one works, so the check is discriminating rather than blanket.
    expect(() => assertStepExecutable(p, "supply", auth(capabilityScopeFor(p, "supply")), NOW, NOW)).not.toThrow();
  });

  it("PLAN-006b a capability from a superseded plan matches nothing in the current one", () => {
    const before = withStatus(bridgePlan(), "bridge", "CONFIRMED");
    const minted = capabilityScopeFor(before, "supply");
    const after = clone(before);
    (after.steps[1]!.normalizedIntent as Record<string, unknown>).amount = "1";
    expect(reasonOf(() => assertStepExecutable(after, "supply", auth(minted), NOW, NOW)))
      .toBe(PLAN_REASONS.PLAN_MUTATED);
  });

  it("PLAN-013 a step past its timeout cannot execute on the original authorization", () => {
    const p = withStatus(bridgePlan(), "bridge", "CONFIRMED");
    const late = NOW + p.steps[1]!.timeoutMs + 1;
    expect(reasonOf(() => assertStepExecutable(p, "supply", auth(capabilityScopeFor(p, "supply")), late, NOW)))
      .toBe(PLAN_REASONS.TIMED_OUT);
  });

  it("PLAN-016 a step needing a person is not carried by the plan's initial approval", () => {
    const p = withStatus(bridgePlan(), "bridge", "CONFIRMED");
    p.steps[1]!.authorizationRequirement.disposition = "REQUIRES_HUMAN";
    const s = capabilityScopeFor(p, "supply");
    expect(reasonOf(() => assertStepExecutable(p, "supply", auth(s, false), NOW, NOW)))
      .toBe(PLAN_REASONS.HUMAN_APPROVAL_REQUIRED);
    expect(() => assertStepExecutable(p, "supply", auth(s, true), NOW, NOW)).not.toThrow();
  });

  it("PLAN-016b a DENY step has no path to execution, approved or not", () => {
    const p = withStatus(bridgePlan(), "bridge", "CONFIRMED");
    p.steps[1]!.authorizationRequirement.disposition = "DENY";
    expect(reasonOf(() => assertStepExecutable(p, "supply", auth(capabilityScopeFor(p, "supply"), true), NOW, NOW)))
      .toBe(PLAN_REASONS.DENIED);
  });

  it("PLAN-016c an unknown step value blocks rather than defaulting", () => {
    const p = withStatus(bridgePlan(), "bridge", "CONFIRMED");
    p.steps[1]!.authorizationRequirement.valueUsdCents = null;
    expect(reasonOf(() => assertStepExecutable(p, "supply", auth(capabilityScopeFor(p, "supply")), NOW, NOW)))
      .toBe(PLAN_REASONS.UNKNOWN_VALUE);
  });
});

describe("partial execution is reported honestly", () => {
  it("PLAN-014 a delivered bridge followed by a failed destination step is PARTIAL", () => {
    let p = withStatus(bridgePlan(), "bridge", "CONFIRMED");
    p = withStatus(p, "supply", "FAILED");
    expect(derivePlanState(p)).toBe("PARTIAL");
  });

  it("PLAN-014b a failure before anything moved is not dressed up as PARTIAL", () => {
    const p = withStatus(bridgePlan(), "bridge", "FAILED");
    expect(derivePlanState(p)).toBe("STEP_FAILED");
  });

  it("PLAN-014c COMPLETED requires every required step, not merely the last one", () => {
    let p = withStatus(bridgePlan(), "supply", "CONFIRMED");
    expect(derivePlanState(p)).not.toBe("COMPLETED");
    p = withStatus(p, "bridge", "CONFIRMED");
    expect(derivePlanState(p)).toBe("COMPLETED");
  });

  it("PLAN-015 there is no rollback to express", () => {
    const p = bridgePlan();
    // The type system is the enforcement: no failure policy names a reversal, and the plan carries
    // no field in which one could be recorded.
    expect(["HOLD_AND_ESCALATE", "RETRY_SAME_STEP", "ABORT_REMAINING"]).toContain(p.failurePolicy.onStepFailure);
    expect(JSON.stringify(p)).not.toMatch(/rollback|revert|undo/i);
    expect(p.failurePolicy.protocolRefundAvailable).toBe(false);
  });

  it("PLAN-015b a timed-out step after value moved is PARTIAL, not TIMED_OUT", () => {
    let p = withStatus(bridgePlan(), "bridge", "CONFIRMED");
    p = withStatus(p, "supply", "TIMED_OUT");
    expect(derivePlanState(p)).toBe("PARTIAL");
  });

  it("runnable steps are exactly those whose dependencies are met", () => {
    const p = bridgePlan();
    expect(runnableSteps(p).map((s) => s.stepId)).toEqual(["bridge"]);
    expect(runnableSteps(withStatus(p, "bridge", "CONFIRMED")).map((s) => s.stepId)).toEqual(["supply"]);
  });
});

describe("cross-chain arrival", () => {
  const wire = {
    sourceChainSelector: SEPOLIA_SELECTOR,
    sender: OWNER,
    destinationChainId: BASE_SEPOLIA,
    receiver: OWNER,
    token: USDC_SEPOLIA,
    amount: "500000000",
  };
  const setup = () => {
    const plan = bridgePlan();
    const expected = ArrivalRegistry.expectationFor(plan, "bridge", wire);
    const observed = {
      messageId: "0xmsg1",
      planHash: expected.planHash,
      stepId: "bridge",
      stepHash: expected.stepHash,
      ...wire,
    };
    return { plan, expected, observed, registry: new ArrivalRegistry() };
  };

  it("PLAN-007 the same message cannot be recorded twice", () => {
    const { registry, expected, observed } = setup();
    expect(registry.record(expected, observed)).toEqual({ accepted: true, messageId: "0xmsg1" });
    const again = registry.record(expected, observed);
    expect(again).toMatchObject({ accepted: false, reason: ARRIVAL_REASONS.DUPLICATE });
  });

  it("PLAN-008 a message from the wrong source chain is rejected", () => {
    const { registry, expected, observed } = setup();
    expect(registry.record(expected, { ...observed, sourceChainSelector: BASE_SELECTOR }))
      .toMatchObject({ reason: ARRIVAL_REASONS.WRONG_SOURCE_CHAIN });
  });

  it("PLAN-008b a message from the wrong sender is rejected", () => {
    const { registry, expected, observed } = setup();
    expect(registry.record(expected, { ...observed, sender: ATTACKER }))
      .toMatchObject({ reason: ARRIVAL_REASONS.WRONG_SENDER });
  });

  it("PLAN-009 a message delivered on the wrong destination chain is rejected", () => {
    const { registry, expected, observed } = setup();
    expect(registry.record(expected, { ...observed, destinationChainId: SEPOLIA }))
      .toMatchObject({ reason: ARRIVAL_REASONS.WRONG_DESTINATION });
  });

  it("PLAN-009b selectors are compared as strings, so no uint64 is narrowed to a float", () => {
    // 16015286601757825753 and 16015286601757825754 are the same IEEE-754 double.
    expect(Number(SEPOLIA_SELECTOR)).toBe(Number("16015286601757825754"));
    const { registry, expected, observed } = setup();
    expect(registry.record(expected, { ...observed, sourceChainSelector: "16015286601757825754" }))
      .toMatchObject({ reason: ARRIVAL_REASONS.WRONG_SOURCE_CHAIN });
  });

  it("PLAN-010 a substituted receiver is rejected", () => {
    const { registry, expected, observed } = setup();
    expect(registry.record(expected, { ...observed, receiver: ATTACKER }))
      .toMatchObject({ reason: ARRIVAL_REASONS.WRONG_RECEIVER });
  });

  it("PLAN-011 a token mismatch is rejected", () => {
    const { registry, expected, observed } = setup();
    expect(registry.record(expected, { ...observed, token: ATTACKER }))
      .toMatchObject({ reason: ARRIVAL_REASONS.TOKEN_MISMATCH });
  });

  it("PLAN-012 an amount mismatch is rejected", () => {
    const { registry, expected, observed } = setup();
    expect(registry.record(expected, { ...observed, amount: "500000001" }))
      .toMatchObject({ reason: ARRIVAL_REASONS.AMOUNT_MISMATCH });
  });

  it("PLAN-012b a rejected arrival is not remembered, so the real message can still land", () => {
    const { registry, expected, observed } = setup();
    registry.record(expected, { ...observed, amount: "1" });
    expect(registry.has(observed.messageId)).toBe(false);
    expect(registry.record(expected, observed)).toEqual({ accepted: true, messageId: "0xmsg1" });
  });

  it("PLAN-012c an arrival for a superseded plan is rejected", () => {
    const { registry, expected, observed } = setup();
    expect(registry.record(expected, { ...observed, planHash: "0xdeadbeef" }))
      .toMatchObject({ reason: ARRIVAL_REASONS.UNKNOWN_PLAN });
  });
});

describe("the CCIP adapter", () => {
  const D = ccipDeploymentFor(SEPOLIA);
  const exec = new ChainlinkCcipAdapter();

  const intent = (over: Partial<CcipIntent> = {}): CcipIntent => ({
    action: "CROSS_CHAIN_TOKEN_TRANSFER",
    sourceChainId: SEPOLIA,
    destinationChainId: BASE_SEPOLIA,
    receiver: OWNER,
    tokenTransfers: [{ token: USDC_SEPOLIA, amount: "500000000" }],
    data: "0x",
    feeToken: "0x0000000000000000000000000000000000000000",
    gasLimit: 200_000,
    timeoutMs: 1_800_000,
    ...over,
  });

  const constraints = (over: Partial<CcipConstraints> = {}): CcipConstraints => ({
    chainId: SEPOLIA,
    allowedTargets: [D.router],
    allowedRecipients: "self-only",
    owner: OWNER,
    allowUnlimitedApprovals: false,
    maxQuoteAgeMs: 60_000,
    permittedDestinationChainIds: [BASE_SEPOLIA],
    permittedActions: ["CROSS_CHAIN_TOKEN_TRANSFER"],
    allowedDestinationReceivers: [OWNER],
    ...over,
  });

  const encode = (o: { selector?: string; receiver?: string; token?: string; amount?: bigint; data?: `0x${string}` } = {}) =>
    encodeFunctionData({
      abi: CCIP_ROUTER_ABI,
      functionName: "ccipSend",
      args: [
        BigInt(o.selector ?? BASE_SELECTOR),
        {
          receiver: `0x${"0".repeat(24)}${(o.receiver ?? OWNER).slice(2)}` as `0x${string}`,
          data: o.data ?? "0x",
          tokenAmounts: [{ token: (o.token ?? USDC_SEPOLIA) as `0x${string}`, amount: o.amount ?? 500_000_000n }],
          feeToken: "0x0000000000000000000000000000000000000000",
          extraArgs: "0x",
        },
      ],
    });

  // Every fixture carries an HONEST summary. If any check read it, every attack below passes.
  const prep = (data: string, to = D.router): CcipPrepared => ({
    to, data, value: "0", chainId: SEPOLIA,
    summary: { action: "CROSS_CHAIN_TOKEN_TRANSFER", destination: "Base Sepolia", receiver: OWNER, amount: "500000000" },
  });

  const judge = async (data: string, i = intent(), c = constraints(), to = D.router) => {
    const n = await exec.decodeTransaction(prep(data, to));
    return { n, result: exec.validateTransaction(n, i, c) };
  };
  const expectRejection = (r: { ok: boolean; problems: Array<{ code: string }> }, code: string) => {
    expect(r.ok).toBe(false);
    const codes = r.problems.map((p) => p.code);
    expect(codes, `expected ${code}, got ${codes.join(", ") || "none"}`).toContain(code);
  };

  it("PLAN-017 the adapter registers as a generic CROSS_CHAIN adapter with a pinned version", () => {
    const m = exec.manifest();
    expect(m.adapterType).toBe("CROSS_CHAIN");
    expect(m.id).toBe("chainlink-ccip");
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.supportedChains).toContain(SEPOLIA);
    expect(m.supportedChains).toContain(BASE_SEPOLIA);
    // Trust: a transaction an adapter builds is never trusted output.
    expect(m.trustClass).toBe("USER_UNTRUSTED");
    expect(m.safety.independentlyValidatesProviderOutput).toBe(true);
  });

  it("PLAN-017b the verified lane and its selectors round-trip", () => {
    expect(laneIsVerified(SEPOLIA, BASE_SEPOLIA)).toBe(true);
    expect(laneIsVerified(BASE_SEPOLIA, SEPOLIA)).toBe(true);
    expect(laneIsVerified(SEPOLIA, 1)).toBe(false);
    expect(chainIdForSelector(BASE_SELECTOR)).toBe(BASE_SEPOLIA);
    expect(chainIdForSelector("999")).toBeNull();
    expect(ccipDeploymentFor(SEPOLIA).routerTypeAndVersion).toBe("Router 1.2.0");
    expect(ccipDeploymentFor(SEPOLIA).verifiedOnChain).toBe(true);
  });

  it("PLAN-020 mainnet is refused by the adapter, not by configuration", () => {
    const r = exec.normalizeIntent(intent({ destinationChainId: 8453 }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.problems.map((p) => p.code)).toContain("CCIP-I-MAINNET");
  });

  it("PLAN-020b an unverified lane is refused even between two testnets", () => {
    const r = exec.normalizeIntent(intent({ destinationChainId: 421614 }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.problems.map((p) => p.code)).toContain("CCIP-I-UNVERIFIED-LANE");
  });

  it("the honest send validates", async () => {
    const { result } = await judge(encode());
    expect(result.problems.map((p) => p.code).join(",")).toBe("");
    expect(result.ok).toBe(true);
  });

  it("PLAN-009c a destination substitution is caught on the decoded selector", async () => {
    // The summary still says "Base Sepolia". Only the calldata says otherwise.
    const { result } = await judge(encode({ selector: SEPOLIA_SELECTOR }));
    expectRejection(result, "CCIP-V-DESTINATION");
  });

  it("PLAN-010b a receiver substitution is caught on the decoded receiver", async () => {
    const { result } = await judge(encode({ receiver: ATTACKER }));
    expectRejection(result, "CCIP-V-RECEIVER");
  });

  it("PLAN-012d an amount substitution is caught on the decoded amount", async () => {
    const { result } = await judge(encode({ amount: 999_999_999n }));
    expectRejection(result, "CCIP-V-AMOUNT");
  });

  it("a send to something that is not the verified router is refused", async () => {
    const { result } = await judge(encode(), intent(), constraints(), ATTACKER);
    expectRejection(result, "CCIP-V-ROUTER");
  });

  it("PLAN-017c a programmable transfer is refused unless the Blueprint names it", async () => {
    const { n, result } = await judge(encode({ data: "0xdeadbeef" }));
    expect(n.actionType).toBe("PROGRAMMABLE_TRANSFER");
    expectRejection(result, "CCIP-V-ACTION-NOT-PERMITTED");
  });

  it("an unknown selector is refused rather than guessed at", async () => {
    const { result } = await judge(encode({ selector: "123456789012345678" }));
    expectRejection(result, "CCIP-V-UNKNOWN-SELECTOR");
  });

  it("calldata that is not a Router call is refused rather than partly read", async () => {
    await expect(exec.decodeTransaction(prep("0xdeadbeef"))).rejects.toThrow(/CCIP-NOT-ROUTER-CALL/);
  });
});

describe("provider chained plans are untrusted", () => {
  const step = (over: Record<string, unknown> = {}) => ({
    type: "SWAP", chainId: SEPOLIA, to: OWNER, data: "0xabcdef", value: "0", ...over,
  });

  it("PLAN-018 a well-formed chained plan is ingested, and every step needs its own capability", () => {
    const r = ingestChainedPlan({ routing: "CHAINED", steps: [step({ type: "APPROVE" }), step()] }, { chainId: SEPOLIA });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.steps).toHaveLength(2);
    expect(r.steps.every((s) => s.requiresOwnCapability === true)).toBe(true);
    expect(r.steps.map((s) => s.type)).toEqual(["APPROVE", "SWAP"]);
  });

  it("PLAN-018b an unrecognised step type stops the whole plan rather than being skipped", () => {
    const r = ingestChainedPlan({ routing: "CHAINED", steps: [step(), step({ type: "FLASH_LOAN" })] }, { chainId: SEPOLIA });
    expect(r).toMatchObject({ ok: false, reason: CHAINED_REASONS.UNKNOWN_STEP_TYPE, atIndex: 1 });
  });

  it("PLAN-019 provider steps are decoded one at a time, never adopted wholesale", () => {
    const r = ingestChainedPlan(
      { routing: "CHAINED", steps: [step({ summary: { lie: "this is a harmless approval" } })] },
      { chainId: SEPOLIA },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    // The provider's own description is kept for display and is not a field anything decides on.
    expect(r.steps[0]!.providerSummary).toEqual({ lie: "this is a harmless approval" });
    expect(r.steps[0]!.data).toBe("0xabcdef");
  });

  it("PLAN-019b a chained plan for another chain is refused", () => {
    const r = ingestChainedPlan({ routing: "CHAINED", steps: [step({ chainId: 1 })] }, { chainId: SEPOLIA });
    expect(r).toMatchObject({ ok: false, reason: CHAINED_REASONS.CHAIN_MISMATCH });
  });

  it("PLAN-020c a mainnet chained plan is refused: FND-V2-007 stands", () => {
    const r = ingestChainedPlan({ routing: "CHAINED", steps: [step({ chainId: 1 })] }, { chainId: 1 });
    expect(r).toMatchObject({ ok: false, reason: CHAINED_REASONS.MAINNET_ONLY });
  });

  it("a non-chained response is not silently treated as a plan", () => {
    const r = ingestChainedPlan({ routing: "CLASSIC", steps: [step()] }, { chainId: SEPOLIA });
    expect(r).toMatchObject({ ok: false, reason: CHAINED_REASONS.UNSUPPORTED_ROUTING });
  });

  it("an empty plan authorizes nothing and is refused as such", () => {
    const r = ingestChainedPlan({ routing: "CHAINED", steps: [] }, { chainId: SEPOLIA });
    expect(r).toMatchObject({ ok: false, reason: CHAINED_REASONS.EMPTY });
  });

  it("a step with neither calldata nor value cannot be bounded, so it is refused", () => {
    const r = ingestChainedPlan({ routing: "CHAINED", steps: [step({ data: "0x", value: "0" })] }, { chainId: SEPOLIA });
    expect(r).toMatchObject({ ok: false, reason: CHAINED_REASONS.UNBOUNDED_STEP });
  });
});

describe("plan scenarios", () => {
  it("every blocked scenario names an exact reason code", () => {
    const s = generatePlanScenarios(bridgePlan());
    expect(s.length).toBeGreaterThan(12);
    for (const sc of s) {
      if (sc.expected.outcome === "BLOCKED") expect(sc.expected.reasonCode, `${sc.id}`).toMatch(/^(PLAN|XCHAIN)-[A-Z-]+$/);
      else expect(sc.expected.reasonCode).toBeNull();
    }
  });

  it("generation is deterministic", () => {
    expect(generatePlanScenarios(bridgePlan())).toEqual(generatePlanScenarios(bridgePlan()));
  });

  it("the suite covers duplicate messages, out-of-order arrival and honest partial failure", () => {
    const ids = generatePlanScenarios(bridgePlan()).map((s) => s.id);
    for (const id of ["XCHAIN-DUPLICATE-MESSAGE", "XCHAIN-OUT-OF-ORDER", "XCHAIN-STEP2-FAILS", "XCHAIN-PLAN-MUTATION"]) {
      expect(ids).toContain(id);
    }
  });
});

describe("the plan graph", () => {
  it("groups steps by chain and marks the crossing as not atomic", () => {
    const g = projectPlanGraph(bridgePlan());
    expect(g.nodes.filter((n) => n.kind === "ChainGroup").map((n) => n.label))
      .toEqual(["Ethereum Sepolia", "Base Sepolia"]);
    const crossing = g.edges.find((e) => e.kind === "crosschain")!;
    expect(crossing.label).toContain("not atomic");
    expect(crossing.label).toContain("min");
  });

  it("draws arrival and policy as their own steps, because they are", () => {
    const g = projectPlanGraph(bridgePlan());
    expect(g.nodes.find((n) => n.kind === "Arrival")).toBeTruthy();
    expect(g.nodes.find((n) => n.kind === "Policy")!.sublabel).toContain("re-authorizes");
  });

  it("a step whose dependency is unmet is drawn BLOCKED and says what it waits on", () => {
    const g = projectPlanGraph(bridgePlan());
    const supply = g.nodes.find((n) => n.id === "step:supply")!;
    expect(supply.state).toBe("BLOCKED");
    expect(supply.detail.find((d) => d.label === "waiting on")!.value).toBe("bridge");
  });

  it("an unknown step value is rendered as UNKNOWN, never as a number", () => {
    const p = bridgePlan();
    p.steps[1]!.authorizationRequirement.valueUsdCents = null;
    const supply = projectPlanGraph(p).nodes.find((n) => n.id === "step:supply")!;
    expect(supply.detail.find((d) => d.label === "value")!.value).toContain("UNKNOWN");
  });

  it("the graph headline state matches the steps rather than being stored", () => {
    let p = withStatus(bridgePlan(), "bridge", "CONFIRMED");
    p = withStatus(p, "supply", "FAILED");
    expect(projectPlanGraph(p).state).toBe("PARTIAL");
  });

  it("projection is deterministic", () => {
    expect(projectPlanGraph(bridgePlan())).toEqual(projectPlanGraph(bridgePlan()));
  });
});
