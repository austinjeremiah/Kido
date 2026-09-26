import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeEventSchema, deriveEventId, RUNTIME_EVENT_VERSION } from "@contextlock/studio-events";
import { toAuditDraft, type AmaneOutcome } from "../src/index.js";

const ctx = {
  organizationId: null,
  projectId: "proj_rescue",
  deploymentId: "dep_1",
  agentId: "repay-debt-agent",
  correlationId: "corr_1",
  planHash: `0x${"ab".repeat(32)}`,
  planStep: 2,
  leaseId: `0x${"cd".repeat(32)}`,
  nonce: "7",
  adapterId: `0x${"ef".repeat(32)}`,
  chainId: 11155111,
  timestamp: 1_800_000_000_000,
};

const asEvent = (d: ReturnType<typeof toAuditDraft>) => {
  const base = { ...d, schemaVersion: RUNTIME_EVENT_VERSION } as const;
  return RuntimeEventSchema.parse({ ...base, eventId: deriveEventId(base), observedAtMs: d.timestamp });
};

describe("AmaneOutcome → audit event", () => {
  it("EXECUTED is a confirmation with a receipt, never more", () => {
    const e = asEvent(toAuditDraft({ kind: "EXECUTED", chain: "ethereum-sepolia", tx: `0x${"11".repeat(32)}`, block: "42" }, ctx));
    expect(e.type).toBe("ACTION_CONFIRMED");
    expect(e.txHash).toBe(`0x${"11".repeat(32)}`);
    expect(e.publicMetadata.settlement).toBe("RECEIPT_CONFIRMED");
  });

  it("REJECTED_BY_AMANE carries the Amane code and is a policy outcome, not an error", () => {
    const e = asEvent(toAuditDraft({ kind: "REJECTED_BY_AMANE", chain: "sui-testnet", code: "AMANE_ACTION_RECIPIENT_NOT_ALLOWED", tx: "FqxMHrmh7KqwRRMWDczFmpzYe5P76NUVLhxhcbc5WmGo" }, { ...ctx, chainId: null }));
    expect(e.type).toBe("ACTION_REJECTED_BY_AMANE");
    expect(e.source).toBe("AMANE");
    expect(e.severity).toBe("NOTICE");
    expect(e.publicMetadata.code).toBe("AMANE_ACTION_RECIPIENT_NOT_ALLOWED");
    expect(e.publicMetadata.txDigest).toBe("FqxMHrmh7KqwRRMWDczFmpzYe5P76NUVLhxhcbc5WmGo");
    expect(e.txHash).toBeNull();
  });

  it("NONCE_CONSUMED is neither success nor retryable failure", () => {
    const e = asEvent(toAuditDraft({ kind: "NONCE_CONSUMED", chain: "ethereum-sepolia" } as AmaneOutcome, ctx));
    expect(e.type).toBe("ACTION_NONCE_CONSUMED");
    expect(e.publicMetadata.settlement).toBe("VERIFY_FROM_CHAIN_EVENTS");
  });

  it("OPERATIONAL_FAILURE is an error without a policy code", () => {
    const e = asEvent(toAuditDraft({ kind: "OPERATIONAL_FAILURE", chain: "ethereum-sepolia", message: "rpc timeout" }, ctx));
    expect(e.type).toBe("EXECUTION_REVERTED");
    expect(e.severity).toBe("ERROR");
    expect(e.publicMetadata.code).toBeUndefined();
  });
});

describe("KIDO-INT-002 single Amane boundary", () => {
  const root = resolve(__dirname, "../../..");
  const skip = new Set(["node_modules", "dist", ".next", ".git", "out", "cache", "broadcast"]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(name)) files.push(p);
    }
  };
  for (const top of ["apps", "packages", "scripts"]) walk(join(root, top));

  it("only packages/amane-bridge imports the Amane SDK or core", () => {
    const offenders = files.filter((f) => !f.includes(`${join("packages", "amane-bridge")}`) && /from\s+["']@amane\/(sdk|core)["']/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
