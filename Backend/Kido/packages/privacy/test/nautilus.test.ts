import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { ProviderRegistry } from "@kido/registry";
import { BlockedEnvError, LocalEnclaveSigner, NautilusDecisionAdapter, decisionMessage, verifyDecisionSignature } from "../src/index.js";

const reg = new ProviderRegistry();
const key = keccak256(toHex("kido.decision.hf-threshold"));
const bp = keccak256(toHex("blueprint r3"));

describe("Nautilus local tier", () => {
  it("signs the exact BCS intent message the Move verifier checks", async () => {
    const signer = LocalEnclaveSigner.fromSeed(new Uint8Array(32).fill(0x2a));
    const d = await signer.sign({ decisionKey: key, act: true, blueprintHash: bp, timestampMs: 1_800_000_000_000n });
    expect(await verifyDecisionSignature(d)).toBe(true);
    // intent 0 ‖ u64 LE timestamp ‖ len-prefixed key ‖ bool ‖ len-prefixed blueprint hash
    const m = decisionMessage(d);
    expect(m[0]).toBe(0);
    expect(m.length).toBe(1 + 8 + 1 + 32 + 1 + 1 + 32);
    // The Move vectors were generated from this signer and seed; Ed25519 is deterministic.
    const vectors = readFileSync(new URL("../../../move/kido_nautilus/tests/vectors.move", import.meta.url), "utf8");
    expect(vectors).toContain(d.signature.slice(2));
    expect(vectors).toContain(signer.publicKey.slice(2));
  });

  it("a flipped or rebound decision no longer verifies", async () => {
    const d = await LocalEnclaveSigner.generate().sign({ decisionKey: key, act: true, blueprintHash: bp, timestampMs: 1n });
    expect(await verifyDecisionSignature({ ...d, act: false })).toBe(false);
    expect(await verifyDecisionSignature({ ...d, blueprintHash: keccak256(toHex("other")) })).toBe(false);
    expect(await verifyDecisionSignature({ ...d, timestampMs: 2n })).toBe(false);
  });

  it("without an attested host the adapter is BLOCKED_ENV; with a local signer it is labelled unattested", async () => {
    await expect(new NautilusDecisionAdapter(reg).decide({ key, blueprintHash: bp })).rejects.toBeInstanceOf(BlockedEnvError);
    const local = new NautilusDecisionAdapter(reg, { signer: LocalEnclaveSigner.generate(), evaluate: () => true, now: () => 5_000n });
    const r = await local.decide({ key, blueprintHash: bp });
    expect(r.trust).toBe("LOCAL_UNATTESTED_ENCLAVE");
    expect(r.act).toBe(true);
    expect(await verifyDecisionSignature(r.signed!)).toBe(true);
    expect(local.readiness().status).toBe("IMPLEMENTED_LOCAL");
    expect(local.readiness().live).toBe(false);
  });
});
