import { describe, expect, it } from "vitest";
import { ScriptedSpecialistRunner } from "@kido/agents";
import { ActionKind, AuthMode, PriceMode, ZERO32, actionMask, type AgentLease, type RootPolicy } from "@kido/amane-bridge";
import { MonitorEngine, ReasoningGate, compileStep, invoiceMonitor, payInvoiceResponder, validateProposal, type CompileContext, type Invoice, type PaymentWorld } from "../src/index.js";

const h = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;
const EVM_REF = h("a1");
const SUI_REF = h("b2");
const EVM_ACCT = `0x${"00".repeat(12)}${"11".repeat(20)}` as `0x${string}`;
const SUI_ACCT = h("22");
const USD_EVM = `0x${"00".repeat(12)}${"33".repeat(20)}` as `0x${string}`;
const USD_SUI = h("44");
const PAY_EVM = h("55");
const PAY_SUI = h("66");
const MERCHANT_EVM = `0x${"00".repeat(12)}${"77".repeat(20)}` as `0x${string}`;
const MERCHANT_SUI = h("88");
const ATTACKER = "0x000000000000000000000000000000000000dEaD";

const limit = (asset: `0x${string}`) => ({ assetId: asset, maxPerAction: 20_000000n, maxPerEpoch: 40_000000n, maxTotal: 60_000000n });
const policy: RootPolicy = {
  accountId: h("99"),
  policyVersion: 1n,
  parentPolicyHash: ZERO32,
  allowedActions: actionMask(ActionKind.PAY),
  priceMode: PriceMode.TESTNET_FIXED,
  maxLeaseLifetime: 86_400n,
  activateBefore: 2_000_000_000n,
  endpoints: [
    { chainRef: EVM_REF, account: EVM_ACCT, epochSeconds: 3600n, adapters: [{ adapterId: PAY_EVM, adapterName: "Transfer Pay", adapterVersion: 1 }], assets: [limit(USD_EVM)], recipients: [{ recipientId: MERCHANT_EVM, label: "acme-supplies" }], beneficiaries: [], swapFloors: [], recoveryDestinations: [] },
    { chainRef: SUI_REF, account: SUI_ACCT, epochSeconds: 3600n, adapters: [{ adapterId: PAY_SUI, adapterName: "Transfer Pay", adapterVersion: 1 }], assets: [limit(USD_SUI)], recipients: [{ recipientId: MERCHANT_SUI, label: "acme-supplies" }], beneficiaries: [], swapFloors: [], recoveryDestinations: [] },
  ],
  leaseIssuers: [],
};
const lease: AgentLease = {
  accountId: h("99"),
  policyVersion: 1n,
  leaseId: h("aa"),
  agent: "0x0000000000000000000000000000000000000abc",
  issuer: "0x0000000000000000000000000000000000000def",
  validAfter: 1_800_000_000n,
  expiresAt: 1_800_003_600n,
  activateBefore: 1_800_000_600n,
  allowedActions: actionMask(ActionKind.PAY),
  authMode: AuthMode.AGENT_SIGNED,
  endpoints: [
    { chainRef: EVM_REF, account: EVM_ACCT, adapters: [PAY_EVM], assets: [limit(USD_EVM)], recipients: [MERCHANT_EVM], beneficiaries: [] },
    { chainRef: SUI_REF, account: SUI_ACCT, adapters: [PAY_SUI], assets: [limit(USD_SUI)], recipients: [MERCHANT_SUI], beneficiaries: [] },
  ],
};
let nonce = 0n;
const ctx: CompileContext = {
  accountId: h("99"),
  policy,
  lease,
  bindings: {
    "ethereum-sepolia": { chain: "ethereum-sepolia", chainRef: EVM_REF, account: EVM_ACCT, assets: { AMUSD: USD_EVM }, adapters: { PAY: { adapterId: PAY_EVM, adapterName: "Transfer Pay", adapterVersion: 1 } }, payees: { "acme-supplies": { recipientId: MERCHANT_EVM, label: "acme-supplies" } } },
    "sui-testnet": { chain: "sui-testnet", chainRef: SUI_REF, account: SUI_ACCT, assets: { AMUSD: USD_SUI }, adapters: { PAY: { adapterId: PAY_SUI, adapterName: "Transfer Pay", adapterVersion: 1 } }, payees: { "acme-supplies": { recipientId: MERCHANT_SUI, label: "acme-supplies" } } },
  },
  nextNonce: () => ++nonce,
  now: () => 1_800_000_100n,
  ttlSeconds: 300n,
};
const world = (evm: bigint, sui: bigint): PaymentWorld => ({
  approvedPayees: { "ethereum-sepolia": ["acme-supplies"], "sui-testnet": ["acme-supplies"] },
  perActionCap: { "ethereum-sepolia": 20_000000n, "sui-testnet": 20_000000n },
  vaultBalance: { "ethereum-sepolia": evm, "sui-testnet": sui },
});
const inv = (id: string, amount: bigint, payee = "acme-supplies", memo = ""): Invoice => ({ id, payee, asset: "AMUSD", amount, preferredChain: "ethereum-sepolia", memo });
const gate = new ReasoningGate([payInvoiceResponder]);
const known = { chains: ["ethereum-sepolia", "sui-testnet"] as const, assets: ["AMUSD"] };

async function eventsFor(invoices: Invoice[]) {
  const engine = new MonitorEngine([invoiceMonitor("invoices", async () => invoices, () => 1_800_000_100_000)], () => 1_800_000_100_000);
  return engine.tick();
}

describe("monitor + reasoning gate", () => {
  it("KIDO-MON-001/002 a known in-policy invoice takes the deterministic path and no model runs", async () => {
    const runner = new ScriptedSpecialistRunner(() => {
      throw new Error("model must not be invoked");
    });
    const [e] = await eventsFor([inv("1", 10_000000n)]);
    const d = gate.decide(e!, world(50_000000n, 50_000000n));
    expect(d.path).toBe("DETERMINISTIC");
    expect(runner.calls).toBe(0);
  });

  it("the same condition observed twice is one event", async () => {
    const engine = new MonitorEngine([invoiceMonitor("invoices", async () => [inv("1", 1n)], () => 1)], () => 1);
    expect((await engine.tick()).length).toBe(1);
    expect((await engine.tick()).length).toBe(0);
  });

  it("KIDO-REASON-001 local shortfall wakes the PaymentAgent", async () => {
    const [e] = await eventsFor([inv("2", 15_000000n)]);
    const d = gate.decide(e!, world(5_000000n, 50_000000n));
    expect(d).toMatchObject({ path: "REASONING_REQUIRED", condition: "RESOURCE_SHORTFALL", specialist: "PaymentAgent" });
  });

  it("KIDO-REASON-002 a normal event wakes no specialist", async () => {
    const [e] = await eventsFor([inv("3", 1_000000n)]);
    expect(gate.decide(e!, world(50_000000n, 0n)).path).toBe("DETERMINISTIC");
  });

  it("an unapproved payee is a policy fact, not a reasoning problem", async () => {
    const [e] = await eventsFor([inv("4", 1_000000n, ATTACKER)]);
    expect(gate.decide(e!, world(50_000000n, 50_000000n)).path).toBe("NO_ACTION");
  });
});

describe("specialist proposals are untrusted", () => {
  const step = (o: Record<string, unknown> = {}) => ({ stepId: "s1", chain: "sui-testnet", action: "PAY", asset: "AMUSD", amount: "5000000", payee: "acme-supplies", dependsOn: [], rationale: "", ...o });
  const plan = (steps: unknown[], o: Record<string, unknown> = {}) => ({ objective: "pay invoice", decision: "PROPOSE_PLAN", steps, requests: [], summary: "", ...o });

  it("a compliant split plan validates and gets a stable plan hash", () => {
    const v = validateProposal(plan([step(), step({ stepId: "s2", chain: "ethereum-sepolia", dependsOn: ["s1"] })]), "PaymentAgent", known as never);
    expect(v.ok).toBe(true);
    const again = validateProposal(plan([step(), step({ stepId: "s2", chain: "ethereum-sepolia", dependsOn: ["s1"] })]), "PaymentAgent", known as never);
    expect(v.ok && again.ok && v.planHash === again.planHash).toBe(true);
  });

  it("KIDO-REASON-003 raw target/calldata is rejected by schema", () => {
    const v = validateProposal(plan([step({ target: ATTACKER, calldata: "0xa9059cbb" })]), "PaymentAgent", known as never);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reasons.join()).toMatch(/KIDO_REASON_SCHEMA/);
  });

  it("KIDO-REASON-004 a proposed BORROW is rejected", () => {
    const v = validateProposal(plan([step({ action: "BORROW" })]), "PaymentAgent", known as never);
    expect(!v.ok && v.reasons.join()).toMatch(/KIDO_REASON_FORBIDDEN_ACTION/);
  });

  it("an action outside the specialist contract is rejected", () => {
    const v = validateProposal(plan([step({ action: "STAKE" })]), "PaymentAgent", known as never);
    expect(!v.ok && v.reasons.join()).toMatch(/KIDO_REASON_OUTSIDE_CONTRACT/);
  });

  it("KIDO-PLAN-001 dependencies must point at earlier steps", () => {
    const v = validateProposal(plan([step({ dependsOn: ["s9"] })]), "PaymentAgent", known as never);
    expect(!v.ok && v.reasons.join()).toMatch(/KIDO_PLAN_BAD_DEPENDENCY/);
  });
});

describe("compiler preflight (defence in depth before Amane)", () => {
  const base = { stepId: "s1", chain: "sui-testnet" as const, action: "PAY" as const, asset: "AMUSD", amount: 5_000000n, payee: "acme-supplies", dependsOn: [], origin: "PaymentAgent" as const };

  it("an in-policy step compiles to an exact intent bound to endpoint, lease and plan", () => {
    const c = compileStep(base, h("cc"), 0, ctx, { preflight: true });
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.intent.account).toBe(SUI_ACCT);
      expect(c.intent.recipient).toBe(MERCHANT_SUI);
      expect(c.intent.planHash).toBe(h("cc"));
    }
  });

  it("KIDO-SEC-001 a prompt-injected payee never becomes executable through Kido", () => {
    const c = compileStep({ ...base, chain: "ethereum-sepolia", payee: ATTACKER }, h("cc"), 0, ctx, { preflight: true });
    expect(c).toMatchObject({ ok: false, code: "KIDO_PLAN_OUT_OF_POLICY:AMANE_ACTION_RECIPIENT_NOT_ALLOWED" });
  });

  it("KIDO-INT-004 an over-budget step is refused before any relay", () => {
    const c = compileStep({ ...base, amount: 20_000001n }, h("cc"), 0, ctx, { preflight: true });
    expect(c).toMatchObject({ ok: false, code: "KIDO_PLAN_OUT_OF_POLICY:AMANE_BUDGET_PER_ACTION" });
  });

  it("without preflight (assumed compromised Kido) the intent is still encoded faithfully for Amane to reject", () => {
    const c = compileStep({ ...base, chain: "ethereum-sepolia", payee: ATTACKER }, h("cc"), 0, ctx, { preflight: false });
    expect(c.ok && c.intent.recipient.toLowerCase()).toBe(`0x${"00".repeat(12)}${ATTACKER.slice(2).toLowerCase()}`);
  });
});
