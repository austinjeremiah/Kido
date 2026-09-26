import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CrossChainEngine, MemoryEventLog, type CrossChainIntent } from "@kido/runtime";
import { AmaneOnChainDestination, WormholeAmaneTransport, parseTransferVaa, type WormholeFacts } from "../src/wormhole.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/wormhole-l1-vaa.json", import.meta.url), "utf8")) as { vaa: string };
const vaa = new Uint8Array(Buffer.from(fixture.vaa, "base64"));

// Facts as the manifest records them; only the shape matters for these offline tests.
const facts: WormholeFacts = {
  vaaApi: "https://vaa.test/api/v1/vaas",
  sui: { chainId: 21, tokenBridgeEmitter: "0x40440411a170b4842ae7dee4f4a7b7a58bc0a98566e998850a7bb87bf5dc05b9", route: { adapterPackage: "0xa", bridge: "0xb", coinType: "0xc::amusd::AMUSD", tokenBridge: { package: "0xd", state: "0xe" }, wormhole: { package: "0xf", state: "0x1" } } },
  evm: { chainId: 10002, core: "0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78", tokenBridge: "0xDB5492265f6038831E89f495670FF909aDe94bd9", adapterId: "0x01" },
};

describe("Wormhole transport (live VAA fixture)", () => {
  it("parses the Token Bridge transfer-with-payload the Amane Sui adapter sent", () => {
    const t = parseTransferVaa(vaa);
    expect(t.emitterChain).toBe(21);
    expect(t.toChain).toBe(10002);
    expect(t.amount).toBe(20_000000n);
    // Payload = source intent digest ‖ destination endpoint (the Sepolia Amane account).
    expect(t.intent).toBe("0x5813235b3883ece2078bec715a3adcdbd11a710a9d1fb054225f7fe79e90ce0a");
    expect(t.destination).toBe("0x0000000000000000000000003883b57de1cc72ad44bd353796a344990c4521d0");
  });

  it("drives the state machine with the destination Amane account as the only reservation authority", async () => {
    const intentId = "0x5813235b3883ece2078bec715a3adcdbd11a710a9d1fb054225f7fe79e90ce0a" as const;
    const authority = { src: { planHash: "0x" } as never, srcSig: "0x" as const, dest: { asset: "0xasset", adapterId: "0xbridge", recipient: "0xsui" } as never };
    const calls: string[] = [];
    const sui = { bridgeOutWormhole: async () => (calls.push("sui.bridgeOut"), { kind: "EXECUTED", chain: "sui-testnet", tx: "SUIDIGEST" }), wormholeSequence: async () => 1429n };
    const evm = { receiveCrossChain: async (_s: unknown, _g: unknown, _d: unknown, _t: unknown, proof: string) => (calls.push(`evm.receive ${proof.length}`), { kind: "EXECUTED", chain: "ethereum-sepolia", tx: "0xreceive" }) };
    const fetchStub = (async (url: string) => (calls.push(url), { ok: true, json: async () => ({ data: { vaa: fixture.vaa } }) })) as unknown as typeof fetch;
    const transport = new WormholeAmaneTransport({ sui: sui as never }, facts, fetchStub);
    const dest = new AmaneOnChainDestination("ethereum-sepolia", "0x3883b57de1cc72ad44bd353796a344990c4521d0", { evm: evm as never }, facts);
    const intent: CrossChainIntent = {
      intentId,
      source: { chain: "sui-testnet", account: "0x757e", asset: "AMUSD", amount: 20_000000n },
      destination: { chain: "ethereum-sepolia", account: "0x3883b57de1cc72ad44bd353796a344990c4521d0", asset: "wAMUSD", action: "BRIDGE", adapterId: "0xbridge", beneficiary: "0xsui", minAmount: 20_000000n },
      deadline: Date.now() + 60_000,
      transport: "wormhole",
      authority,
    };
    const engine = new CrossChainEngine(transport, dest, { authorizeSource: async () => ({ ok: true, detail: "lease allows BRIDGE" }), executeDestination: async () => ({ ok: true, detail: "reserved BRIDGE back" }), recover: async () => ({ ok: true, detail: "" }) }, new MemoryEventLog(), "agent");
    const run = await engine.run(intent, { pollIntervalMs: 0, maxPolls: 1 });
    expect(run.state).toBe("COMPLETE");
    expect(calls[0]).toBe("sui.bridgeOut");
    expect(calls[1]).toBe(`${facts.vaaApi}/21/40440411a170b4842ae7dee4f4a7b7a58bc0a98566e998850a7bb87bf5dc05b9/1429`);
    expect(calls[2]).toMatch(/^evm\.receive \d+$/);
    expect(run.history.find((h) => h.state === "RESERVED")?.detail).toContain("enforced on-chain 0xreceive");
  });

  it("maps an on-chain refusal to DESTINATION_FAILED → recovery", async () => {
    const intentId = "0x5813235b3883ece2078bec715a3adcdbd11a710a9d1fb054225f7fe79e90ce0a" as const;
    const sui = { bridgeOutWormhole: async () => ({ kind: "EXECUTED", chain: "sui-testnet", tx: "D" }), wormholeSequence: async () => 1429n };
    const evm = { receiveCrossChain: async () => ({ kind: "REJECTED_BY_AMANE", chain: "ethereum-sepolia", code: "AMANE_XCHAIN_SPEC_MISMATCH" }) };
    const fetchStub = (async () => ({ ok: true, json: async () => ({ data: { vaa: fixture.vaa } }) })) as unknown as typeof fetch;
    const dest = new AmaneOnChainDestination("ethereum-sepolia", "0x3883", { evm: evm as never }, facts);
    let recovered = "";
    const engine = new CrossChainEngine(new WormholeAmaneTransport({ sui: sui as never }, facts, fetchStub), dest, { authorizeSource: async () => ({ ok: true, detail: "" }), executeDestination: async () => ({ ok: true, detail: "" }), recover: async (_i, why) => ((recovered = why), { ok: true, detail: "quarantine" }) }, new MemoryEventLog(), "agent");
    const intent = { intentId, source: { chain: "sui-testnet", account: "a", asset: "x", amount: 1n }, destination: { chain: "ethereum-sepolia", account: "0x3883", asset: "y", action: "BRIDGE", adapterId: "b", beneficiary: "c", minAmount: 1n }, deadline: Date.now() + 60_000, transport: "wormhole", authority: { src: {}, srcSig: "0x", dest: {} } } as CrossChainIntent;
    const run = await engine.run(intent, { pollIntervalMs: 0, maxPolls: 1 });
    expect(run.rejection).toBe("AMANE_XCHAIN_SPEC_MISMATCH");
    expect(run.state).toBe("RECOVERED");
    expect(recovered).toContain("AMANE_XCHAIN_SPEC_MISMATCH");
  });

  it("a source refusal commits nothing", async () => {
    const sui = { bridgeOutWormhole: async () => ({ kind: "REJECTED_BY_AMANE", chain: "sui-testnet", code: "AMANE_ACTION_RECIPIENT_NOT_ALLOWED" }) };
    const engine = new CrossChainEngine(new WormholeAmaneTransport({ sui: sui as never }, facts), new AmaneOnChainDestination("ethereum-sepolia", "0x1", {}, facts), { authorizeSource: async () => ({ ok: true, detail: "" }), executeDestination: async () => ({ ok: true, detail: "" }), recover: async () => ({ ok: true, detail: "" }) }, new MemoryEventLog(), "agent");
    const intent = { intentId: "0x01", source: { chain: "sui-testnet", account: "a", asset: "x", amount: 1n }, destination: { chain: "ethereum-sepolia", account: "0x1", asset: "y", action: "BRIDGE", adapterId: "b", beneficiary: "c", minAmount: 1n }, deadline: Date.now() + 60_000, transport: "wormhole", authority: {} } as CrossChainIntent;
    const run = await engine.run(intent, { pollIntervalMs: 0, maxPolls: 1 });
    expect(run.state).toBe("SOURCE_AUTHORIZED");
    expect(run.rejection).toContain("AMANE_ACTION_RECIPIENT_NOT_ALLOWED");
  });
});
