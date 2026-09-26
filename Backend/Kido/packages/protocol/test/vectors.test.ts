import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import {
  type Capability,
  capabilityDigest,
  domainSeparator,
  hashStruct,
  requestHash,
  CAPABILITY_TYPEHASH,
  REQUEST_TYPEHASH,
} from "../src/capability.js";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "test-vectors", "capability-vectors.json"), "utf8"),
) as {
  capabilityTypehash: Hex;
  requestTypehash: Hex;
  vectors: Array<{
    name: string;
    capability: Record<string, string | number>;
    structHash: Hex;
    domainSeparator: Hex;
    digest: Hex;
    requestHash: Hex;
  }>;
};

function revive(c: Record<string, string | number>): Capability {
  return {
    version: Number(c.version),
    agentIdentityHash: c.agentIdentityHash as Hex,
    agent: c.agent as Address,
    chainId: BigInt(c.chainId as string),
    executor: c.executor as Address,
    target: c.target as Address,
    value: BigInt(c.value as string),
    calldataHash: c.calldataHash as Hex,
    intentHash: c.intentHash as Hex,
    policyHash: c.policyHash as Hex,
    authorizationId: c.authorizationId as Hex,
    contextCommitment: c.contextCommitment as Hex,
    issuedAt: BigInt(c.issuedAt as string),
    expiresAt: BigInt(c.expiresAt as string),
    nonce: BigInt(c.nonce as string),
  };
}

describe("golden vectors (TypeScript side)", () => {
  it("reproduces the committed typehashes", () => {
    expect(CAPABILITY_TYPEHASH).toBe(fixture.capabilityTypehash);
    expect(REQUEST_TYPEHASH).toBe(fixture.requestTypehash);
  });

  for (const v of fixture.vectors) {
    it(`reproduces vector "${v.name}"`, () => {
      const cap = revive(v.capability);
      expect(hashStruct(cap)).toBe(v.structHash);
      expect(domainSeparator(cap.chainId, cap.executor)).toBe(v.domainSeparator);
      expect(capabilityDigest(cap)).toBe(v.digest);
      expect(requestHash(cap)).toBe(v.requestHash);
    });
  }

  it("binds every security-relevant field: each single-field mutation moves the digest", () => {
    const baseline = fixture.vectors.find((v) => v.name === "baseline")!;
    const others = fixture.vectors.filter((v) => v.name !== "baseline");
    expect(others.length).toBe(15);
    for (const v of others) {
      expect(v.digest, `mutating ${v.name} must change the digest`).not.toBe(baseline.digest);
    }
    expect(new Set(fixture.vectors.map((v) => v.digest)).size).toBe(fixture.vectors.length);
  });

  it("requestHash ignores nonce/expiry/authorizationId but binds the transaction", () => {
    const by = (n: string) => fixture.vectors.find((v) => v.name === n)!;
    const baseline = by("baseline");

    // Capability-scoped fields must NOT change the evaluated request.
    for (const n of ["nonce", "expiresAt", "issuedAt", "authorizationId", "contextCommitment", "version"]) {
      expect(by(n).requestHash, `${n} should not affect requestHash`).toBe(baseline.requestHash);
    }
    // Transaction-scoped fields MUST change it.
    for (const n of ["target", "value", "calldataHash", "agent", "chainId", "executor", "policyHash"]) {
      expect(by(n).requestHash, `${n} must affect requestHash`).not.toBe(baseline.requestHash);
    }
  });

  it("hashStruct differs from the full digest (domain separation is applied)", () => {
    for (const v of fixture.vectors) expect(v.structHash).not.toBe(v.digest);
  });
});
