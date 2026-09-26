import { describe, expect, it } from "vitest";
import { MonitorEngine, allocationMonitor, rebalanceResponder } from "../src/index.js";

// Pool price: 1000 raw AMSUI per raw AMUSD (1 AMSUI per AMUSD at 9 vs 6 decimals).
const price = async () => ({ num: 1000n, den: 1n });
const monitor = (q: bigint, b: bigint) => allocationMonitor({ id: "alloc", chain: "sui-testnet", quote: "AMUSD", base: "AMSUI", target: 0.5, driftPct: 5, maxAgeMs: 10_000, balance: async (a) => (a === "AMUSD" ? q : b), price, clock: () => 1 });

describe("allocation rebalancing", () => {
  it("prices holdings from the pool and sells the over-weight asset back to target, capped by the lease", async () => {
    const [ev] = await new MonitorEngine([monitor(60_000000n, 0n)], () => 1).tick();
    expect(ev!.data).toMatchObject({ share: 1, target: 0.5 });
    const r = rebalanceResponder({ chain: "sui-testnet", quote: "AMUSD", base: "AMSUI", floorDirections: [["AMUSD", "AMSUI"]] });
    expect(r.respond(ev!, { perActionCap: { AMUSD: 50_000000n } })).toMatchObject({ kind: "ACTIONS", steps: [{ action: "SWAP", asset: "AMUSD", assetOut: "AMSUI", amount: 30_000000n }] });
    expect(r.respond(ev!, { perActionCap: { AMUSD: 10_000000n } })).toMatchObject({ steps: [{ amount: 10_000000n }] });
  });

  it("within the drift band nothing happens", async () => {
    // 52 AMUSD vs 48 AMUSD-worth of AMSUI → 52 %, inside ±5 points
    expect(await new MonitorEngine([monitor(52_000000n, 48_000000_000n)], () => 1).tick()).toEqual([]);
  });

  it("never trades a direction without an owner floor", async () => {
    const [ev] = await new MonitorEngine([monitor(0n, 60_000000_000n)], () => 1).tick();
    const r = rebalanceResponder({ chain: "sui-testnet", quote: "AMUSD", base: "AMSUI", floorDirections: [["AMUSD", "AMSUI"]] });
    expect(r.respond(ev!, { perActionCap: { AMSUI: 10n ** 12n } })).toMatchObject({ kind: "NO_ACTION" });
  });
});
