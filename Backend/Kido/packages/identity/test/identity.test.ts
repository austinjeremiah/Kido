import { describe, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { blueprintHash, emptyBlueprint, nextRevision, type KidoAgentBlueprint } from "@kido/blueprint";
import { ProviderRegistry } from "@kido/registry";
import { EnsIdentityAdapter, SuiNsIdentityAdapter, UnsafePublicRecordError, assertPublicSafe, buildPublicManifest, compileIdentityPlan, dnsEncode } from "../src/index.js";

const reg = new ProviderRegistry();
const ens = reg.get("ens")!.deployments["ethereum-sepolia"]!;

function bp(chains: KidoAgentBlueprint["chains"], isPublic: boolean | null, extra: Partial<KidoAgentBlueprint> = {}): KidoAgentBlueprint {
  const b = emptyBlueprint("acme-treasury", "salt", "treasury agent");
  return nextRevision(b, {
    chains,
    identity: { ...b.identity, public: isPublic, organization: "acme", advertisedCapabilities: ["kido:repay"] },
    agents: [{ role: "RepayDebtAgent", owns: ["REPAY"], mayRequest: [], knowledgePacks: [] }],
    ...extra,
  });
}

describe("identity core", () => {
  it("DNS wire encoding", () => {
    expect(dnsEncode("repay.acme.eth")).toBe("0x0572657061790461636d650365746800");
  });

  it("Ethereum-only public agent → one ENS name carrying its KidoAgentId, plus a subname per specialist", () => {
    const b = bp(["ethereum-sepolia"], true);
    const plan = compileIdentityPlan(b, reg, buildPublicManifest(b, blueprintHash(b)));
    expect(plan.filter((p) => !p.role).map((p) => [p.providerId, p.name])).toEqual([["ens", "repaydebt.acme-kido.eth"]]);
    const subs = plan.filter((p) => p.role);
    expect(subs.map((p) => p.role)).toEqual(b.agents.map((a) => a.role));
    for (const sp of subs) {
      expect(sp.parent).toBe("repaydebt.acme-kido.eth");
      expect(sp.name).toBe(`${sp.label}.repaydebt.acme-kido.eth`);
      expect(sp.records).toEqual({ "kido-agent-id": b.kidoAgentId, "kido-agent-role": sp.role });
    }
    expect(plan[0]!.records["kido-agent-id"]).toBe(b.kidoAgentId);
    expect(JSON.parse(plan[0]!.records["agent-context"]!).authorityNote).toMatch(/not financial authority/);
  });

  it("Sui-only public agent → SuiNS only, with the registration blocker surfaced (no fake success)", () => {
    const b = bp(["sui-testnet"], true);
    const plan = compileIdentityPlan(b, reg, buildPublicManifest(b, blueprintHash(b)));
    expect(plan.filter((p) => !p.role).map((p) => p.providerId)).toEqual(["suins"]);
    expect(plan.filter((p) => p.role).every((p) => p.providerId === "suins" && !p.liveCapable)).toBe(true);
    expect(plan[0]!.liveCapable).toBe(false);
    expect(plan[0]!.blockers.join()).toMatch(/BC-SUINS-1/);
    expect(plan[0]!.records).toEqual({}); // SuiNS has no free-form text records
  });

  it("dual-chain agent → ENS + SuiNS bindings of the same KidoAgentId", () => {
    const b = bp(["ethereum-sepolia", "sui-testnet"], true);
    const plan = compileIdentityPlan(b, reg, buildPublicManifest(b, blueprintHash(b)));
    expect(plan.filter((p) => !p.role).map((p) => p.providerId).sort()).toEqual(["ens", "suins"]);
    expect(plan.find((p) => p.providerId === "ens" && !p.role)!.records["kido-agent-id"]).toBe(b.kidoAgentId);
  });

  it("internal agents get no public binding", () => {
    expect(compileIdentityPlan(bp(["ethereum-sepolia"], false), reg, buildPublicManifest(bp(["ethereum-sepolia"], false), "0x" + "0".repeat(64)))).toEqual([]);
  });

  it("public records never contain limits, private thresholds or secrets", () => {
    const b = bp(["ethereum-sepolia"], true, {
      authority: { ...emptyBlueprint("x", "y", "z").authority, limits: [{ chain: "ethereum-sepolia", asset: "USDC", perAction: "250000000", perWindow: "500000000", windowSeconds: 3600, total: "2000000000" }] },
      monitors: [{ id: "hf", dataSource: "aave", metric: "HEALTH_FACTOR", op: "LT", threshold: "1.5", thresholdPrivateRef: "risk-threshold", response: "NOTIFY", action: null }],
    });
    const m = buildPublicManifest(b, blueprintHash(b));
    expect(() => assertPublicSafe({ "agent-context": JSON.stringify(m) }, b)).not.toThrow();
    expect(() => assertPublicSafe({ "agent-context": "limit 500000000" }, b)).toThrow(UnsafePublicRecordError);
    expect(() => assertPublicSafe({ "agent-context": "acts below 1.5" }, b)).toThrow(/private threshold/);
    expect(() => assertPublicSafe({ note: "api_key: abc" }, b)).toThrow(/secret-shaped/);
  });

  it("the manifest schema refuses unknown fields such as limits", () => {
    const b = bp(["ethereum-sepolia"], true);
    const m = buildPublicManifest(b, blueprintHash(b));
    expect(Object.keys(m)).not.toContain("limits");
    expect(m.kidoAgentId).toBe(b.kidoAgentId);
  });

  it("adapters declare real capability differences", () => {
    const e = new EnsIdentityAdapter(createPublicClient({ chain: sepolia, transport: http("http://127.0.0.1:1") }) as never, null, ens as never);
    expect(e.capabilities()).toEqual(["RESOLVE", "TEXT_RECORDS", "EXPIRY"]);
    const s = new SuiNsIdentityAdapter({} as never);
    expect(s.capabilities()).not.toContain("TEXT_RECORDS");
    expect(s.capabilities()).not.toContain("REGISTER");
  });
});

const LIVE = process.env.KIDO_LIVE_TESTNET === "1" && !!process.env.SEPOLIA_RPC_URL;

describe.skipIf(!LIVE)("identity live reads (TESTNET tier)", () => {
  it("SuiNS resolves demo.sui forward and reverse", async () => {
    const s = new SuiNsIdentityAdapter(new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" }));
    const r = await s.resolve("demo.sui");
    expect(r.found).toBe(true);
    expect(r.address).toBe("0xee5ad470308acbee1943d929b6f511b98ae067cd855bc5fee1400cf4350ae92e");
    const back = await s.reverseResolve(r.address!);
    expect(back.name).toBe("demo.sui");
  }, 30_000);

  it("ENSv2 on Sepolia resolves an existing name through the UniversalResolver", async () => {
    const e = new EnsIdentityAdapter(createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) }) as never, null, ens as never);
    const r = await e.resolve("tokologies.eth", []);
    expect(r.found).toBe(true);
    expect(r.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 30_000);
});
