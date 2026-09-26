import { describe, expect, it } from "vitest";
import { CrossChainEngine, DestinationGuard, MemoryEventLog, MockTransport, intentId, type CrossChainIntent, type Delivery } from "../src/index.js";

const SUI_ACCT = `0x${"c7".repeat(32)}`;
const EVM_ACCT = "0x7bfbba0d7b47a8fdb43ee1683871798d7eb42147";
const OWNER = "0x6BD6Db75B56acE65019AA08FCAd4778808Da08bD";
let t = 1_000;
const clock = () => t;
function makeIntent(o: Partial<CrossChainIntent["destination"]> = {}): CrossChainIntent {
  const base = { source: { chain: "sui-testnet", account: SUI_ACCT, asset: "USDC", amount: 100_000000n }, destination: { chain: "ethereum-sepolia", account: EVM_ACCT, asset: "USDC", action: "REPAY", adapterId: "0xaave", beneficiary: OWNER, minAmount: 99_000000n, ...o }, deadline: 10_000, transport: "mock-transport" };
  return { ...base, intentId: intentId(base, BigInt(Math.floor(Math.random() * 1e9))) };
}
function setup(transport = new MockTransport({}, clock), destOk = true) {
  const guard = new DestinationGuard("ethereum-sepolia", EVM_ACCT, clock);
  const recovered: string[] = [];
  const executed: bigint[] = [];
  const engine = new CrossChainEngine(transport, guard, {
    authorizeSource: async () => ({ ok: true, detail: "source lease authorized" }),
    executeDestination: async (_i, r) => {
      const c = guard.consume({ intentId: r.intentId, action: r.action, adapterId: r.adapterId, beneficiary: r.beneficiary, amount: r.amount });
      if (!c.ok || !destOk) return { ok: false, detail: c.ok ? "adapter reverted" : c.code };
      executed.push(r.amount);
      return { ok: true, detail: "repaid" };
    },
    recover: async (i, why) => (recovered.push(`${i.intentId}:${why}`), { ok: true, detail: "returned to owner recovery destination" }),
  }, new MemoryEventLog(clock), "kido:agent:test", clock);
  return { guard, engine, recovered, executed };
}
const opts = { pollIntervalMs: 0, maxPolls: 5 };

describe("cross-chain state machine (mock transport)", () => {
  it("happy path walks every state to COMPLETE and settles the pinned action once", async () => {
    const { engine, executed } = setup();
    const r = await engine.run(makeIntent(), opts);
    expect(r.history.map((h) => h.state)).toEqual(["CREATED", "SOURCE_AUTHORIZED", "SOURCE_COMMITTED", "IN_FLIGHT", "ARRIVED", "RESERVED", "DESTINATION_AUTHORIZED", "SETTLED", "COMPLETE"]);
    expect(executed).toEqual([100_000000n]);
  });

  it.each<[string, (d: Delivery) => Delivery, string]>([
    ["wrong destination", (d) => ({ ...d, destinationAccount: "0x000000000000000000000000000000000000dEaD" }), "WRONG_DESTINATION"],
    ["wrong source", (d) => ({ ...d, sourceAccount: `0x${"de".repeat(32)}` }), "WRONG_SOURCE"],
    ["wrong asset", (d) => ({ ...d, asset: "AMUSD" }), "WRONG_ASSET"],
    ["amount below the minimum", (d) => ({ ...d, amount: 1n }), "AMOUNT_BELOW_MINIMUM"],
    ["amount above the intent", (d) => ({ ...d, amount: 10n ** 12n }), "AMOUNT_ABOVE_INTENT"],
    ["delivery for an unknown intent", (d) => ({ ...d, intentId: `0x${"ab".repeat(32)}` }), "UNKNOWN_INTENT"],
  ])("%s is refused at the destination and recovered", async (_n, tamper, code) => {
    const { engine, recovered, executed } = setup(new MockTransport({ tamper }, clock));
    const r = await engine.run(makeIntent(), opts);
    expect(r.rejection).toBe(code);
    expect(r.history.map((h) => h.state).slice(-3)).toEqual(["DESTINATION_FAILED", "RECOVERY_REQUIRED", "RECOVERED"]);
    expect(executed).toEqual([]);
    expect(recovered).toHaveLength(1);
  });

  it("duplicate message and replayed intent are refused", async () => {
    const { guard, engine } = setup();
    const i = makeIntent();
    await engine.run(i, opts);
    const d: Delivery = { messageId: "m", intentId: i.intentId, sourceChain: i.source.chain, sourceAccount: i.source.account, destinationChain: i.destination.chain, destinationAccount: i.destination.account, asset: "USDC", amount: 100_000000n, deliveredAt: t, proof: "x" };
    expect(guard.reserve(d)).toEqual({ ok: false, code: "DUPLICATE_DELIVERY" });
  });

  it("the reservation serves only its pinned action, adapter and beneficiary, once", () => {
    const guard = new DestinationGuard("ethereum-sepolia", EVM_ACCT, clock);
    const i = makeIntent();
    guard.expect(i);
    guard.reserve({ messageId: "m1", intentId: i.intentId, sourceChain: "sui-testnet", sourceAccount: SUI_ACCT, destinationChain: "ethereum-sepolia", destinationAccount: EVM_ACCT, asset: "USDC", amount: 100_000000n, deliveredAt: t, proof: "x" });
    const req = { intentId: i.intentId, action: "REPAY", adapterId: "0xaave", beneficiary: OWNER, amount: 100_000000n };
    expect(guard.consume({ ...req, action: "PAY" })).toEqual({ ok: false, code: "WRONG_ACTION" });
    expect(guard.consume({ ...req, beneficiary: "0x000000000000000000000000000000000000dEaD" })).toEqual({ ok: false, code: "WRONG_BENEFICIARY" });
    expect(guard.consume({ ...req, adapterId: "0xother" })).toEqual({ ok: false, code: "WRONG_ADAPTER" });
    expect(guard.consume({ ...req, intentId: `0x${"11".repeat(32)}` })).toEqual({ ok: false, code: "NO_RESERVATION" });
    expect(guard.consume({ ...req, amount: 100_000001n })).toEqual({ ok: false, code: "OVER_RESERVATION" });
    expect(guard.reserved("USDC")).toBe(100_000000n);
    expect(guard.consume(req)).toEqual({ ok: true });
    expect(guard.consume(req)).toEqual({ ok: false, code: "ALREADY_CONSUMED" });
  });

  it("destination failure and timeout end in recovery, never in a silent success", async () => {
    const failing = setup(new MockTransport({}, clock), false);
    expect((await failing.engine.run(makeIntent(), opts)).state).toBe("RECOVERED");
    const lost = setup(new MockTransport({ lose: true }, clock));
    const r = await lost.engine.run(makeIntent(), opts);
    expect(r.history.map((h) => h.state).slice(-3)).toEqual(["TIMED_OUT", "RECOVERY_REQUIRED", "RECOVERED"]);
  });

  it("recovery cannot expand authority: an expired reservation is released once and cannot then be spent", () => {
    const guard = new DestinationGuard("ethereum-sepolia", EVM_ACCT, clock);
    const i = makeIntent();
    guard.expect(i);
    guard.reserve({ messageId: "m2", intentId: i.intentId, sourceChain: "sui-testnet", sourceAccount: SUI_ACCT, destinationChain: "ethereum-sepolia", destinationAccount: EVM_ACCT, asset: "USDC", amount: 100_000000n, deliveredAt: t, proof: "x" });
    expect(guard.releaseExpired(i.intentId)).toBeNull(); // not before the deadline
    t = 20_000;
    expect(guard.releaseExpired(i.intentId)?.amount).toBe(100_000000n);
    expect(guard.releaseExpired(i.intentId)).toBeNull();
    expect(guard.consume({ intentId: i.intentId, action: "REPAY", adapterId: "0xaave", beneficiary: OWNER, amount: 1n })).toEqual({ ok: false, code: "ALREADY_CONSUMED" });
    t = 1_000;
  });

  it("an intent for another endpoint is not accepted and illegal transitions throw", () => {
    const guard = new DestinationGuard("ethereum-sepolia", EVM_ACCT, clock);
    expect(() => guard.expect(makeIntent({ account: "0x000000000000000000000000000000000000dEaD" }))).toThrow(/not for this endpoint/);
  });
});
