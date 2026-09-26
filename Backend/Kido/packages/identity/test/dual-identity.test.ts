import { describe, expect, it } from "vitest";
import { emptyBlueprint, nextRevision, blueprintHash } from "@kido/blueprint";
import { MemoryIdentityProvider, buildPublicManifest, verifyBinding } from "../src/index.js";

const bp1 = nextRevision(emptyBlueprint("treasury", "salt", "dual-chain treasury"), { chains: ["ethereum-sepolia", "sui-testnet"] });
const bp2 = nextRevision(bp1, { objective: { statement: "dual-chain treasury (revised)", summary: null } });
const EVM_ACCT = "0x7bfbba0d7b47a8fdb43ee1683871798d7eb42147";
const SUI_ACCT = `0x${"c7".repeat(32)}`;
const names = [{ provider: "ens", chain: "ethereum-sepolia", name: "payment.acme.eth" }, { provider: "suins", chain: "sui-testnet", name: "payment.acme.sui" }];
const records = (bp: typeof bp1) => {
  const m = buildPublicManifest(bp, blueprintHash(bp), { bindings: names, accounts: { "ethereum-sepolia": EVM_ACCT, "sui-testnet": SUI_ACCT } });
  return { "agent-context": JSON.stringify(m), "kido-agent-id": m.kidoAgentId };
};

async function setup() {
  const ens = new MemoryIdentityProvider("ens", "ethereum-sepolia");
  const suins = new MemoryIdentityProvider("suins", "sui-testnet");
  await ens.createSubIdentity("acme.eth", "payment", records(bp1));
  await suins.createSubIdentity("acme.sui", "payment", records(bp1));
  return { ens, suins };
}

describe("one KidoAgentId across ENS and SuiNS (local conformance)", () => {
  it("both names resolve to the same KidoAgentId and list each other; neither is the root", async () => {
    const { ens, suins } = await setup();
    const e = await verifyBinding(ens, "payment.acme.eth", { kidoAgentId: bp1.kidoAgentId, blueprintCommitment: blueprintHash(bp1), account: EVM_ACCT });
    const s = await verifyBinding(suins, "payment.acme.sui", { kidoAgentId: bp1.kidoAgentId, blueprintCommitment: blueprintHash(bp1), account: SUI_ACCT });
    expect([e.verdict, s.verdict]).toEqual(["VERIFIED", "VERIFIED"]);
    expect(e.manifest!.kidoAgentId).toBe(s.manifest!.kidoAgentId);
    expect(e.manifest!.bindings).toEqual(names);
  });

  it("rotation: after a new revision the old records are STALE until republished", async () => {
    const { ens } = await setup();
    expect((await verifyBinding(ens, "payment.acme.eth", { kidoAgentId: bp2.kidoAgentId, blueprintCommitment: blueprintHash(bp2) })).verdict).toBe("STALE");
    await ens.publishRecords("payment.acme.eth", records(bp2));
    expect((await verifyBinding(ens, "payment.acme.eth", { kidoAgentId: bp2.kidoAgentId, blueprintCommitment: blueprintHash(bp2) })).verdict).toBe("VERIFIED");
  });

  it("revocation, wrong name, wrong agent and wrong address are all refused", async () => {
    const { ens, suins } = await setup();
    expect((await verifyBinding(ens, "payment.acme.eth", { kidoAgentId: bp1.kidoAgentId, account: "0x000000000000000000000000000000000000dEaD" })).verdict).toBe("WRONG_ADDRESS");
    expect((await verifyBinding(ens, "payment.acme.eth", { kidoAgentId: "kido:agent:aaaaaaaaaaaaaaaa" })).verdict).toBe("WRONG_AGENT");
    expect((await verifyBinding(ens, "Payment.ACME.eth", { kidoAgentId: bp1.kidoAgentId })).verdict).toBe("INVALID_NAME");
    expect((await verifyBinding(ens, "payment.acme.sui", { kidoAgentId: bp1.kidoAgentId })).verdict).toBe("INVALID_NAME");
    expect((await verifyBinding(ens, "other.acme.eth", { kidoAgentId: bp1.kidoAgentId })).verdict).toBe("NOT_FOUND");
    await suins.revoke("payment.acme.sui", "CLEAR_RECORDS");
    expect((await verifyBinding(suins, "payment.acme.sui", { kidoAgentId: bp1.kidoAgentId })).verdict).toBe("REVOKED");
    // revoking one chain's name leaves the other binding intact
    expect((await verifyBinding(ens, "payment.acme.eth", { kidoAgentId: bp1.kidoAgentId })).verdict).toBe("VERIFIED");
  });

  it("a planned but unregistered binding is reported as such, not as found", async () => {
    const suins = new MemoryIdentityProvider("suins", "sui-testnet");
    expect((await verifyBinding(suins, "payment.acme.sui", { kidoAgentId: bp1.kidoAgentId, planned: true })).verdict).toBe("PLANNED_NOT_REGISTERED");
  });
});
