import { describe, expect, it } from "vitest";

/**
 * P8.19 — the hardware boundary, made machine-visible.
 *
 * These tests do NOT test the device. They assert which tests are blocked and why, so the gap is
 * enumerated in the suite rather than merely absent from it. A missing test looks the same as a
 * passing one when you only read a summary line; this makes the difference explicit.
 *
 * Nothing here is marked PASS on the device's behalf.
 */
export const BLOCKED_BY_BLK_002 = [
  { id: "LED-001", what: "Real Ledger Key Ring initialized via `wallet-cli ring init`", needs: "physical device + operator WALLET_PASS" },
  { id: "LED-002", what: "Protected credential encrypt/decrypt round-trip through a real ring", needs: "a provisioned ring" },
  { id: "LED-H03", what: "Physical device approval of an ESCALATE capability", needs: "physical device" },
  { id: "LED-H04", what: "Physical on-device rejection", needs: "physical device" },
  { id: "LED-H15", what: "Device disconnected mid-approval fails closed", needs: "physical device" },
  { id: "LED-H16", what: "Ledger software/transport error fails closed", needs: "physical device" },
  { id: "LED-H20-PHYS", what: "Physical Clear Signing render of the ERC-7730 descriptor", needs: "physical device" },
] as const;

/** Things people might assume are blocked, but are NOT — these run today. */
const NOT_BLOCKED = [
  "LED-003 broker uses the protected service; agent cannot retrieve the secret",
  "LED-004 no getSecret exists on any reachable surface",
  "LED-005/006/007 secret absent from responses, logs and database",
  "LED-008-KR missing/empty WALLET_PASS fails closed",
  "LED-009-KR Key Ring network unavailable fails closed",
  "LED-010-KR no plaintext fallback exists",
  "LED-011-KR errors and stack traces carry no secret",
  "LED-012-KR agent cannot invoke arbitrary ring commands",
  "LED-013-KR ring metadata leaks nothing",
  "LED-014-KR canary absent from production surfaces in git history",
  "LED-H01/H02 escalation challenge; no signature means no execution",
  "LED-H05/H06 expired and replayed approvals fail",
  "LED-H07 wrong signer fails",
  "LED-H08..H11 amount/recipient/target/calldata mutation after approval fails",
  "LED-H12 policy change after approval fails",
  "LED-H13 ENS revocation after approval fails",
  "LED-H14 CRE invalidation after approval fails",
  "LED-H17 agent cannot self-approve",
  "LED-H18 ALLOW path stays autonomous",
  "LED-H19 DENY cannot be escalated",
];

describe("P8.19 Ledger hardware boundary", () => {
  it("enumerates exactly what is blocked, and why", () => {
    expect(BLOCKED_BY_BLK_002.length).toBe(7);
    for (const b of BLOCKED_BY_BLK_002) {
      expect(b.needs).toMatch(/physical device|provisioned ring/);
      expect(b.what.length).toBeGreaterThan(20);
    }
  });

  it("the blocked set is SMALL relative to what already runs without hardware", () => {
    // 7 blocked against 20 running. Stated numerically so the ratio cannot be glossed either way.
    expect(NOT_BLOCKED.length).toBeGreaterThan(BLOCKED_BY_BLK_002.length * 2);
  });

  it("no blocked test is anywhere reported as PASS", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dirname, "../../..");
    const reports = [
      "reports/phase-06/TEST_RESULTS.md",
      "reports/phase-07/TEST_RESULTS.md",
    ].map((p) => join(root, p)).filter(existsSync);

    expect(reports.length).toBeGreaterThan(0);
    for (const file of reports) {
      const text = readFileSync(file, "utf8");
      for (const b of BLOCKED_BY_BLK_002) {
        const line = text.split("\n").find((l) => l.includes(`| ${b.id} |`) || l.includes(`| **${b.id}**`));
        if (!line) continue;
        // A blocked row must never be marked a plain PASS.
        expect(line, `${b.id} is marked PASS in ${file}`).not.toMatch(/\*\*PASS\*\*/);
      }
    }
  });

  it("no report claims Clear Signing was physically rendered", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dirname, "../../..");
    for (const p of ["reports/phase-07/CLEAR_SIGNING_STATUS.md", "README.md", "FEEDBACK_LEDGER.md"]) {
      const f = join(root, p);
      if (!existsSync(f)) continue;
      const t = readFileSync(f, "utf8").toLowerCase();
      // Forbidden claim shapes. Descriptions of what is NOT done are fine.
      expect(t).not.toMatch(/clear signing (works|verified|confirmed) on (the )?device/);
      expect(t).not.toMatch(/rendered on (a|the) ledger/);
    }
  });
});
