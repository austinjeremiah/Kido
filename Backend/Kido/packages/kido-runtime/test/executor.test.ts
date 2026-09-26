import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { ActionExecutor, MemoryEventLog, type SemanticStep } from "../src/index.js";

const agent = privateKeyToAccount(`0x${"42".repeat(32)}`);
const intent = { accountId: `0x${"01".repeat(32)}`, chainRef: `0x${"02".repeat(32)}`, account: `0x${"03".repeat(32)}`, policyVersion: 1n, leaseId: `0x${"04".repeat(32)}`, nonce: 1n, actionKind: 0, adapterId: `0x${"05".repeat(32)}`, adapterName: "Cetus CLMM Swap", adapterVersion: 1, assetIn: `0x${"06".repeat(32)}`, assetOut: `0x${"07".repeat(32)}`, amountIn: 5n, minAmountOut: 0n, recipient: `0x${"00".repeat(32)}`, recipientLabel: "", deadline: 99n, planHash: `0x${"08".repeat(32)}`, planStep: 0 } as const;
const step = (o: Partial<SemanticStep>): SemanticStep => ({ stepId: "s", chain: "sui-testnet", action: "SWAP", asset: "AMUSD", assetOut: "AMSUI", amount: 5n, payee: null, dependsOn: [], origin: "DETERMINISTIC", ...o });

function executor(outcome: unknown) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const sui = {
    pay: async (...args: unknown[]) => (calls.push({ fn: "pay", args }), outcome),
    swapCetus: async (...args: unknown[]) => (calls.push({ fn: "swapCetus", args }), outcome),
  };
  const evm = { executeAction: async (...args: unknown[]) => (calls.push({ fn: "executeAction", args }), outcome) };
  const log = new MemoryEventLog(() => 1);
  const ex = new ActionExecutor({
    evm: evm as never,
    sui: sui as never,
    suiCoinTypes: { AMUSD: "0xt::amusd::AMUSD", AMSUI: "0xt::amsui::AMSUI" },
    suiRoutes: [{ adapterPackage: "0xa", coinA: "0xt::amusd::AMUSD", coinB: "0xt::amsui::AMSUI", pool: "0xp", globalConfig: "0xg" }],
    agent,
    log,
    agentId: "kido:agent:test",
  });
  return { ex, calls, log };
}

describe("action executor", () => {
  it("routes a Sui swap through the Cetus adapter with the right direction and logs the outcome", async () => {
    const { ex, calls, log } = executor({ kind: "EXECUTED", chain: "sui-testnet", tx: "D1g" });
    await ex.submit(intent as never, step({}));
    expect(calls[0]!.fn).toBe("swapCetus");
    expect((calls[0]!.args[0] as { a2b: boolean }).a2b).toBe(true);
    await ex.submit(intent as never, step({ asset: "AMSUI", assetOut: "AMUSD" }));
    expect((calls[1]!.args[0] as { a2b: boolean }).a2b).toBe(false);
    expect(log.list({ type: "ACTION_EXECUTED" })).toHaveLength(2);
  });

  it("records Amane rejections with their code and routes EVM actions to executeAction", async () => {
    const { ex, calls, log } = executor({ kind: "REJECTED_BY_AMANE", chain: "ethereum-sepolia", code: "AMANE_ACTION_RECIPIENT_NOT_ALLOWED", tx: "0xabc" });
    const o = await ex.submit(intent as never, step({ chain: "ethereum-sepolia", action: "REPAY", asset: "USDC", assetOut: null, payee: "owner position" }));
    expect(o.kind).toBe("REJECTED_BY_AMANE");
    expect(calls[0]!.fn).toBe("executeAction");
    expect(log.list({ type: "ACTION_REJECTED_BY_AMANE" })[0]).toMatchObject({ code: "AMANE_ACTION_RECIPIENT_NOT_ALLOWED", tx: "0xabc" });
  });

  it("an unroutable step is an operational failure, never a success", async () => {
    const { ex, log } = executor({ kind: "EXECUTED", chain: "sui-testnet" });
    const o = await ex.submit(intent as never, step({ asset: "AMUSD", assetOut: "WAL" }));
    expect(o.kind).toBe("OPERATIONAL_FAILURE");
    expect(log.list({ type: "ACTION_OPERATIONAL_FAILURE" })).toHaveLength(1);
  });
});
