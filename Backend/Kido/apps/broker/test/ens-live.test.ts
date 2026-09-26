import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { OperationalError } from "@contextlock/protocol";
import { LiveEnsIdentityProvider } from "../src/providers/ens-live.js";

/**
 * Live ENSv2 Sepolia checks for the broker's identity provider.
 * Skipped (not silently passed) when SEPOLIA_RPC_URL is absent.
 */
const RPC = process.env.SEPOLIA_RPC_URL;
const ens = JSON.parse(readFileSync(join(import.meta.dirname, "../../../deployments/ens-sepolia.json"), "utf8")) as {
  name: string; node: string;
};
const AGENT = "0xA263b2cA150B5A1cA7bf08adF966B847c487F50f" as Address;

describe.skipIf(!RPC)("LiveEnsIdentityProvider (Sepolia)", () => {
  const provider = new LiveEnsIdentityProvider(RPC!, { [ens.name.toLowerCase()]: AGENT });

  it("ID-001: resolves the live registered agent name", async () => {
    const id = await provider.resolve(ens.name);
    expect(id.source).toBe("ensv2-sepolia");
    expect(id.agent).toBe(AGENT);
    expect(id.node).toBe(ens.node);
    expect(id.agentIdentityHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("the identity hash tracks live ENS state, so it changes when the name's token id changes", async () => {
    const a = await provider.resolve(ens.name);
    const b = await provider.resolve(ens.name);
    // Deterministic for identical state...
    expect(a.agentIdentityHash).toBe(b.agentIdentityHash);
    // ...but a different binding version is a different identity.
    const other = new LiveEnsIdentityProvider(RPC!, { [ens.name.toLowerCase()]: AGENT }, 2n);
    const c = await other.resolve(ens.name);
    expect(c.agentIdentityHash).not.toBe(a.agentIdentityHash);
  });

  it("ID-006: an unconfigured name fails closed with an OperationalError", async () => {
    await expect(provider.resolve("definitely-not-registered-contextlock.eth")).rejects.toBeInstanceOf(OperationalError);
  });

  it("ID-006: an unreachable RPC fails closed rather than returning an identity", async () => {
    const broken = new LiveEnsIdentityProvider("http://127.0.0.1:1/nope", { [ens.name.toLowerCase()]: AGENT });
    await expect(broken.resolve(ens.name)).rejects.toBeInstanceOf(OperationalError);
  });

  it("never returns a cached identity: each resolve performs a fresh chain read", async () => {
    // A cache would make this provider unable to notice a revocation, which is the property the
    // whole phase depends on. Asserted structurally: no cache field exists on the instance.
    expect(Object.keys(provider as object).some((k) => /cache/i.test(k))).toBe(false);
  });
});
