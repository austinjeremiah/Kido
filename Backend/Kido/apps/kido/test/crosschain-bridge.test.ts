import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { authorityEndpoints, suiCoreFor } from "@kido/foundry";
import { createFoundry, loadConfig } from "../src/index.js";

/** A two-chain agent that may bridge: BRIDGE is a granted Amane action that only reaches the agent's own endpoints. */
const here = fileURLToPath(new URL(".", import.meta.url));
const f = createFoundry(loadConfig({ KIDO_DATA_DIR: mkdtempSync(join(tmpdir(), "kido-bridge-")), KIDO_AMANE_MANIFEST: resolve(here, "../../../../Aname/deployments/testnet.json") }));
const ANSWERS: Record<string, string> = {
  "authority.mode": "act on its own within limits",
  "authority.bridge": "yes",
  "actions.allowed": "pay approved recipients and move funds across chains",
  "authority.withdraw": "no",
  "authority.arbitrary_recipients": "no, only approved ones",
  "authority.autonomy": "automatically",
  payees: `acme on Ethereum Sepolia: 0x${"ab".repeat(20)}; harbor on Sui testnet: 0x${"cd".repeat(32)}`,
  "assets.spend": "AMUSD and wAMUSD",
  "limits.window": "50",
  "limits.total": "500",
  "identity.public": "no",
  "privacy.required": "no",
  "recovery.partial": "stop and notify me",
};

describe("cross-chain agent with BRIDGE", () => {
  it("builds a Bridge specialist whose bridges may only reach its own Amane endpoints", async () => {
    const c = await f.create("Build a treasury agent on Ethereum Sepolia and Sui testnet that pays my suppliers on both chains and bridges funds between them");
    let q = c.question;
    while (q) q = (await f.answer(c.projectId, ANSWERS[q.key]!)).next;
    const fin = f.finalize(c.projectId);
    expect(fin.blockers).toEqual([]);
    expect(fin.blueprint.authority.allowedActions).toEqual(expect.arrayContaining(["PAY", "BRIDGE"]));
    expect(fin.blueprint.agents.map((a) => a.role)).toContain("BridgeAgent");
    expect(f.securityReview(c.projectId).blocking).toBe(false);
    expect((await f.simulate(c.projectId)).passed).toBe(true);

    const bp = f.blueprint(c.projectId)!;
    const sui = bp.authority.limits.find((l) => l.chain === "sui-testnet")!;
    const bridge = (chain: string, asset: string, amount: string, recipient: string) => f.whatIf(c.projectId, { chain, action: "BRIDGE", asset, amount, recipient } as never);
    expect(bridge("ethereum-sepolia", "wAMUSD", "1000000", "amane-sui-testnet")).toMatchObject({ verdict: "ALLOW" });
    expect(bridge("sui-testnet", "AMUSD", "1000000", "amane-ethereum-sepolia")).toMatchObject({ verdict: "ALLOW" });
    // A payee is a pinned recipient the chain would accept; Kido never bridges to one.
    expect(bridge("sui-testnet", "AMUSD", "1000000", bp.authority.payees.find((p) => p.chain === "sui-testnet")!.label)).toMatchObject({ verdict: "REJECT", code: "KIDO_PLAN_BRIDGE_NOT_TO_OWN_ENDPOINT" });
    expect(bridge("sui-testnet", "AMUSD", (BigInt(sui.perAction) + 1n).toString(), "amane-ethereum-sepolia")).toMatchObject({ verdict: "REJECT", layer: "AMANE_RULES" });
    expect(bridge("sui-testnet", "AMUSD", "1000000", `0x${"ef".repeat(32)}`)).toMatchObject({ verdict: "REJECT" });

    // BRIDGE on Sui needs the core release that enforces it; every Sui adapter must be that core's.
    const m = f.manifest as unknown as { sui: { packageId: string; releases: Record<string, { packageId: string; actions: string[] }>; adapters: { name: string; core?: string; witnessType: string }[] } };
    const [, release] = Object.entries(m.sui.releases).find(([, r]) => r.actions.includes("BRIDGE"))!;
    expect(suiCoreFor(bp, f.manifest, "sui-testnet")).toBe(release.packageId);
    const suiEndpoint = authorityEndpoints(bp, f.manifest, f.registry).find((e) => e.chain === "sui-testnet")!;
    expect(Object.keys(suiEndpoint.adapters)).toEqual(expect.arrayContaining(["BRIDGE", "PAY"]));
  });
});
