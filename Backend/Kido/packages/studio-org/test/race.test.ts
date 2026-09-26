import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import DatabaseCtor from "better-sqlite3";
import { OrgBudgetLedger, ORG_BUDGET_REASONS } from "../src/budget.js";
import { raceOrg } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const childScript = join(here, "race-child.ts");

interface ChildResult {
  ok: boolean;
  reason?: string;
}

const runChild = (dbPath: string, startAt: number, amount: number, agentId: string) =>
  new Promise<ChildResult>((resolve, reject) => {
    const k = spawn("npx", ["tsx", childScript, dbPath, String(startAt), String(amount), agentId], {
      cwd: here,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    k.stdout.on("data", (d) => (out += String(d)));
    k.stderr.on("data", (d) => (err += String(d)));
    k.on("close", (code) => {
      if (out.trim() === "") reject(new Error(`child exited ${code} with no result: ${err.slice(-500)}`));
      else resolve(JSON.parse(out.trim()) as ChildResult);
    });
  });

/**
 * The real concurrency evidence.
 *
 * Six separate OS processes each reserve 30_000 cents against an aggregate of 125_000. Four fit.
 * The assertion that matters is not "about four": it is that the two that lose are refused for the
 * aggregate specifically — not lost to a lock error — and that the ledger never records more than
 * the cap.
 */
describe("cross-process aggregate race", () => {
  it(
    "ORG-038 six concurrent processes cannot spend past the organization aggregate",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "org-race-"));
      const dbPath = join(dir, "org.db");
      try {
        const seed = new DatabaseCtor(dbPath);
        seed.pragma("journal_mode = WAL");
        new OrgBudgetLedger(seed, raceOrg(), () => 1_700_000_000_000); // creates the schema once
        seed.close();

        // Children are slow to boot under tsx; give them a generous common start instant.
        const startAt = Date.now() + 6_000;
        const agents = ["guardian", "rebalancer", "guardian", "rebalancer", "guardian", "rebalancer"];
        const results = await Promise.all(agents.map((a) => runChild(dbPath, startAt, 30_000, a)));

        const ok = results.filter((r) => r.ok);
        const refused = results.filter((r) => !r.ok);
        expect(ok).toHaveLength(4);
        expect(refused.map((r) => r.reason)).toEqual([
          ORG_BUDGET_REASONS.AGGREGATE,
          ORG_BUDGET_REASONS.AGGREGATE,
        ]);

        const check = new DatabaseCtor(dbPath, { readonly: true });
        const total = check
          .prepare(`SELECT COALESCE(SUM(usd_cents),0) AS t FROM org_spend WHERE state IN ('HELD','SETTLED')`)
          .get() as { t: number };
        check.close();
        expect(total.t).toBe(120_000);
        expect(total.t).toBeLessThanOrEqual(125_000);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
