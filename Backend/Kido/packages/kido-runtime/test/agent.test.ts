import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { ActionKind, AuthMode, PriceMode, ZERO32, actionMask, type AgentLease, type RootPolicy } from "@kido/amane-bridge";
import { ActionExecutor, AgentRuntime, MemoryEventLog, MonitorEngine, executePlan, repayAmountFor, repayResponder, type AavePosition, type CompileContext, type MonitorSpec, type SemanticStep } from "../src/index.js";

const h = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;
const REF = h("a1");
const ACCT = `0x${"00".repeat(12)}${"11".repeat(20)}` as `0x${string}`;
const USDC = `0x${"00".repeat(12)}${"33".repeat(20)}` as `0x${string}`;
const VDEBT = `0x${"00".repeat(12)}${"34".repeat(20)}` as `0x${string}`;
const REPAY = h("55");
const PAY = h("56");
const OWNER = `0x${"00".repeat(12)}${"77".repeat(20)}` as `0x${string}`;
const MERCHANT = `0x${"00".repeat(12)}${"78".repeat(20)}` as `0x${string}`;
const cap = { assetId: USDC, maxPerAction: 25_000000n, maxPerEpoch: 50_000000n, maxTotal: 100_000000n };
const policy: RootPolicy = {
  accountId: h("99"), policyVersion: 1n, parentPolicyHash: ZERO32, allowedActions: actionMask(ActionKind.REPAY, ActionKind.PAY), priceMode: PriceMode.TESTNET_FIXED, maxLeaseLifetime: 86_400n, activateBefore: 2_000_000_000n,
  endpoints: [{ chainRef: REF, account: ACCT, epochSeconds: 3600n, adapters: [{ adapterId: REPAY, adapterName: "Aave V3 Repay", adapterVersion: 1 }, { adapterId: PAY, adapterName: "Transfer Pay", adapterVersion: 1 }], assets: [cap], recipients: [{ recipientId: MERCHANT, label: "acme" }], beneficiaries: [{ recipientId: OWNER, label: "owner position" }], swapFloors: [{ assetIn: USDC, assetOut: VDEBT, minOutNumerator: 9999n, minOutDenominator: 10000n }], recoveryDestinations: [] }],
  leaseIssuers: [],
};
const lease: AgentLease = {
  accountId: h("99"), policyVersion: 1n, leaseId: h("aa"), agent: "0x0000000000000000000000000000000000000abc", issuer: "0x0000000000000000000000000000000000000def", validAfter: 1_800_000_000n, expiresAt: 1_800_003_600n, activateBefore: 1_800_000_600n, allowedActions: actionMask(ActionKind.REPAY, ActionKind.PAY), authMode: AuthMode.AGENT_SIGNED,
  endpoints: [{ chainRef: REF, account: ACCT, adapters: [REPAY, PAY], assets: [cap], recipients: [MERCHANT], beneficiaries: [OWNER] }],
};
let nonce = 0n;
const ctx = (): CompileContext => ({
  accountId: h("99"), policy, lease,
  bindings: { "ethereum-sepolia": { chain: "ethereum-sepolia", chainRef: REF, account: ACCT, assets: { USDC }, adapters: { REPAY: { adapterId: REPAY, adapterName: "Aave V3 Repay", adapterVersion: 1 }, PAY: { adapterId: PAY, adapterName: "Transfer Pay", adapterVersion: 1 } }, payees: { acme: { recipientId: MERCHANT, label: "acme" } }, beneficiaries: { "owner position": { recipientId: OWNER, label: "owner position" } }, debtTokens: { USDC: VDEBT }, repay: true } } as CompileContext["bindings"],
  nextNonce: () => ++nonce, now: () => 1_800_000_100n, ttlSeconds: 300n,
});
const step = (o: Partial<SemanticStep>): SemanticStep => ({ stepId: "r", chain: "ethereum-sepolia", action: "REPAY", asset: "USDC", assetOut: null, amount: 10_000000n, payee: "owner position", dependsOn: [], origin: "DETERMINISTIC", ...o });

function executorWith(outcomes: string[]) {
  const log = new MemoryEventLog(() => 1);
  const submitted: bigint[] = [];
  const evm = { executeAction: async (i: { amountIn: bigint }) => (submitted.push(i.amountIn), outcomes.shift() === "EXECUTED" ? { kind: "EXECUTED", chain: "ethereum-sepolia", tx: "0x1" } : { kind: "OPERATIONAL_FAILURE", chain: "ethereum-sepolia", message: "rpc down" }) };
  const ex = new ActionExecutor({ evm: evm as never, suiCoinTypes: {}, suiRoutes: [], agent: privateKeyToAccount(`0x${"42".repeat(32)}`), log, agentId: "kido:agent:t" });
  return { ex, log, submitted };
}

const position = (debt: bigint): AavePosition => ({ healthFactor: Number((1000n * 8000n * 100n) / (10_000n * debt)) / 100, collateralBase: 1000_00000000n, debtBase: debt * 1_00000000n, liquidationThreshold: 8000n, assetPriceBase: 1_00000000n, assetDecimals: 6 });

describe("REPAY sizing", () => {
  it("repays exactly what restores the target health factor, rounded up", () => {
    // collateral 1000, LT 80 %, debt 700 → HF 1.14; target 1.5 → debt' 533.33 → repay 166.666667 USDC
    expect(repayAmountFor(position(700n), 1.5)).toBe(166_666667n);
    expect(repayAmountFor(position(100n), 1.5)).toBe(0n);
  });

  it("caps at the lease per-action limit and wakes the specialist when the endpoint holds nothing", () => {
    const r = repayResponder({ chain: "ethereum-sepolia", asset: "USDC", beneficiaryLabel: "owner position", targetHealthFactor: 1.5 });
    const ev = { monitorId: "m", kind: "HEALTH_FACTOR_BREACH", key: "k", at: 0, data: {}, observations: [{ value: position(700n) }] } as never;
    expect(r.respond(ev, { available: 1_000_000000n, perActionCap: 25_000000n })).toMatchObject({ kind: "ACTIONS", steps: [{ amount: 25_000000n, payee: "owner position" }] });
    expect(r.respond(ev, { available: 0n, perActionCap: 25_000000n })).toMatchObject({ kind: "WAKE", condition: "RESOURCE_SHORTFALL", specialist: "RepayDebtAgent" });
  });
});

describe("monitor re-arming", () => {
  it("a condition that clears and returns is a new event", async () => {
    let hf = 1.1;
    const spec: MonitorSpec = { id: "hf", requiredTrust: "RPC_DIRECT", observe: async () => [{ id: "o", adapterId: "a", chain: "c", subject: "s", kind: "HF", value: hf, observedAt: 1, freshnessMs: 10, trust: "RPC_DIRECT" }], evaluate: (o) => [(o[0]!.value as number) < 1.5 ? { kind: "BREACH", key: "hf", data: {} } : { kind: "CLEAR", key: "hf", data: {} }] };
    const engine = new MonitorEngine([spec], () => 5);
    expect(await engine.tick()).toHaveLength(1);
    expect(await engine.tick()).toHaveLength(0);
    hf = 2;
    expect(await engine.tick()).toHaveLength(0);
    hf = 1.2;
    expect(await engine.tick()).toHaveLength(1);
  });
});

describe("plan execution and recovery", () => {
  it("an out-of-policy step refuses the whole plan before anything is submitted", async () => {
    const { ex, log, submitted } = executorWith(["EXECUTED", "EXECUTED"]);
    const run = await executePlan([step({ stepId: "a" }), step({ stepId: "b", payee: "0x000000000000000000000000000000000000dEaD", dependsOn: ["a"] })], ctx(), ex, log, { agentId: "t", recovery: "HALT_AND_NOTIFY" });
    expect(run.status).toBe("REFUSED");
    expect(submitted).toEqual([]);
  });

  it("a failure after an executed step halts and notifies under HALT_AND_NOTIFY", async () => {
    const { ex, log } = executorWith(["EXECUTED", "FAIL"]);
    const run = await executePlan([step({ stepId: "a" }), step({ stepId: "b", action: "PAY", payee: "acme", dependsOn: ["a"] })], ctx(), ex, log, { agentId: "t", recovery: "HALT_AND_NOTIFY" });
    expect(run.status).toBe("RECOVERY_REQUIRED");
    expect(run.steps.map((s) => s.status)).toEqual(["EXECUTED", "OPERATIONAL_FAILURE"]);
    expect(log.list({ type: "OWNER_NOTIFIED" })).toHaveLength(1);
    expect(run.wake).toBeUndefined();
  });

  it("WAKE_RECOVERY_AGENT asks for reasoning about the partial execution", async () => {
    const { ex, log } = executorWith(["EXECUTED", "FAIL"]);
    const run = await executePlan([step({ stepId: "a" }), step({ stepId: "b", action: "PAY", payee: "acme", dependsOn: ["a"] })], ctx(), ex, log, { agentId: "t", recovery: "WAKE_RECOVERY_AGENT" });
    expect(run.wake).toMatchObject({ condition: "PARTIAL_EXECUTION" });
  });

  it("dependencies run first; a cycle is refused", async () => {
    const { ex, log, submitted } = executorWith(["EXECUTED", "EXECUTED"]);
    await executePlan([step({ stepId: "b", amount: 2n, dependsOn: ["a"] }), step({ stepId: "a", amount: 1n })], ctx(), ex, log, { agentId: "t", recovery: "HALT_AND_NOTIFY" });
    expect(submitted).toEqual([1n, 2n]);
    const cyc = await executePlan([step({ stepId: "a", dependsOn: ["b"] }), step({ stepId: "b", dependsOn: ["a"] })], ctx(), ex, log, { agentId: "t", recovery: "HALT_AND_NOTIFY" });
    expect(cyc.status).toBe("REFUSED");
  });
});

describe("agent runtime", () => {
  const breach: MonitorSpec = { id: "hf", requiredTrust: "RPC_DIRECT", observe: async () => [{ id: "o", adapterId: "aave-v3", chain: "ethereum-sepolia", subject: OWNER, kind: "HEALTH_FACTOR", value: position(700n), observedAt: 1, freshnessMs: 10, trust: "RPC_DIRECT" }], evaluate: () => [{ kind: "HEALTH_FACTOR_BREACH", key: "hf", data: {} }] };
  const runtime = (available: bigint, specialist?: (i: unknown) => Promise<unknown>) => {
    const { ex, log, submitted } = executorWith(["EXECUTED"]);
    const rt = new AgentRuntime({
      agentId: "t", monitors: new MonitorEngine([breach], () => 5), responders: [repayResponder({ chain: "ethereum-sepolia", asset: "USDC", beneficiaryLabel: "owner position", targetHealthFactor: 1.5 })],
      world: async () => ({ available, perActionCap: 25_000000n }), compile: ctx, executor: ex, log, recovery: "HALT_AND_NOTIFY", maxRecoveryAttempts: 1,
      known: { chains: ["ethereum-sepolia"], assets: ["USDC"] }, specialist: specialist as never,
    });
    return { rt, log, submitted };
  };

  it("a breach with funds is repaid deterministically; no model runs", async () => {
    const { rt, submitted, log } = runtime(1_000_000000n, async () => {
      throw new Error("model must not run");
    });
    const r = await rt.tick();
    expect(r.decisions[0]!.path).toBe("DETERMINISTIC");
    expect(r.runs[0]!.status).toBe("COMPLETED");
    expect(submitted).toEqual([25_000000n]);
    expect(log.list({ type: "REASONING_WOKEN" })).toHaveLength(0);
  });

  it("a shortfall wakes reasoning; without a specialist the owner is notified", async () => {
    const { rt, log, submitted } = runtime(0n);
    await rt.tick();
    expect(log.list({ type: "REASONING_WOKEN" })).toHaveLength(1);
    expect(log.list({ type: "OWNER_NOTIFIED" })).toHaveLength(1);
    expect(submitted).toEqual([]);
  });

  it("a specialist proposal outside its contract is refused and moves nothing", async () => {
    const { rt, log, submitted } = runtime(0n, async () => ({ objective: "x", decision: "PROPOSE_PLAN", steps: [{ stepId: "b", chain: "ethereum-sepolia", action: "BORROW", asset: "USDC", assetOut: null, amount: "1", payee: null, dependsOn: [], rationale: "" }], requests: [], summary: "" }));
    await rt.tick();
    expect(log.list({ type: "PLAN_REFUSED" })).toHaveLength(1);
    expect(submitted).toEqual([]);
  });
});
