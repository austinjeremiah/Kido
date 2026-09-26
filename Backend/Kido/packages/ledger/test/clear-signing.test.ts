import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadDescriptor, validateDescriptor, buildApprovalSummary } from "../src/clear-signing.js";

const DESCRIPTOR = join(import.meta.dirname, "../erc7730/contextlock-approval.json");

describe("LED-H20 / P7.6 — ERC-7730 descriptor", () => {
  it("the ContextLock descriptor loads and validates", () => {
    const d = loadDescriptor(DESCRIPTOR);
    const r = validateDescriptor(d);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("declares an EIP-712 schema matching the on-chain approval typehash fields", () => {
    const d = loadDescriptor(DESCRIPTOR);
    const schema = d.context.eip712?.schemas.find((s) => s.primaryType === "ContextLockApproval");
    expect(schema).toBeDefined();
    const fields = (schema!.types as Record<string, Array<{ name: string; type: string }>>)["ContextLockApproval"]!;
    // Must mirror ContextLockApprovalRegistry.APPROVAL_TYPEHASH exactly.
    expect(fields.map((f) => `${f.type} ${f.name}`)).toEqual([
      "bytes32 capabilityDigest",
      "address approver",
      "uint64 expiresAt",
    ]);
  });

  it("displays EVERY signed field — a partial display is treated as an error", () => {
    const d = loadDescriptor(DESCRIPTOR);
    const shown = d.display.formats["ContextLockApproval"]!.fields.map((f) => f.path);
    expect(shown).toContain("capabilityDigest");
    expect(shown).toContain("approver");
    expect(shown).toContain("expiresAt");
  });

  it("the validator REJECTS a descriptor that hides a material field", () => {
    const d = loadDescriptor(DESCRIPTOR);
    // Drop the expiry from the display, keeping it in the signed struct.
    d.display.formats["ContextLockApproval"]!.fields =
      d.display.formats["ContextLockApproval"]!.fields.filter((f) => f.path !== "expiresAt");
    const r = validateDescriptor(d);
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("expiresAt");
    expect(r.errors.join(" ")).toContain("not displayed");
  });

  it("the validator rejects an unknown field format", () => {
    const d = loadDescriptor(DESCRIPTOR);
    d.display.formats["ContextLockApproval"]!.fields[0]!.format = "totally-made-up";
    const r = validateDescriptor(d);
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("unknown format");
  });

  it("the human summary is derived from the same values as the digest", () => {
    const s = buildApprovalSummary({
      ensName: "contextlock-20260906-a83dc9.eth",
      actionKind: "MOCK_TRANSFER",
      amount: 5_000_000_000n,
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      recipient: "0x00000000000000000000000000000000c0ffee00",
      target: "0xf20B833b26b981F8A2211473f46cf457430CE153",
      policyId: "0x29322eb6b834d9ce687dd2911f2f572a8132ed22fd11d3b910f3846b6c94910a",
      policyVersion: 1,
      expiresAt: 1800000300n,
      capabilityDigest: "0xabc123",
    });
    expect(s.protocol).toBe("ContextLock");
    expect(s.spend).toBe("5000 USDC");
    expect(s.agent).toContain(".eth");
    // Every material field a human needs is present; none is omitted "to make it prettier".
    for (const k of ["protocol", "agent", "action", "spend", "destination", "target", "policy", "expiry", "capabilityDigest"]) {
      expect(s[k as keyof typeof s], `${k} must be present`).toBeTruthy();
    }
  });

  it("formats fractional amounts without losing precision", () => {
    const s = buildApprovalSummary({
      ensName: "a.eth", actionKind: "X", amount: 5_000_500_000n, tokenSymbol: "USDC", tokenDecimals: 6,
      recipient: "0x0", target: "0x0", policyId: "0x00", policyVersion: 1,
      expiresAt: 1800000300n, capabilityDigest: "0x0",
    });
    expect(s.spend).toBe("5000.5 USDC");
  });
});
