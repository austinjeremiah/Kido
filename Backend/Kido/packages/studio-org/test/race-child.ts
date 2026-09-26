/**
 * One competing process in the cross-process race test.
 *
 * This file exists because an in-process test cannot distinguish an atomic reservation from a naive
 * check-then-act: better-sqlite3 is synchronous, so nothing can interleave between the read and the
 * write inside one process however the code is written. Real concurrency needs real processes, and
 * a race that is not real proves nothing about the one that happens in production.
 *
 * Each child opens the shared database, spins to a shared start instant, makes exactly one
 * reservation, and prints the outcome as JSON.
 */
import DatabaseCtor from "better-sqlite3";
import { OrgBudgetLedger, OrgBudgetError } from "../src/budget.js";
import { raceOrg } from "./fixtures.js";

const [dbPath, startAtMs, amount, agentId] = process.argv.slice(2);

const db = new DatabaseCtor(dbPath!, { timeout: 20_000 });
const ledger = new OrgBudgetLedger(db, raceOrg(), () => 1_700_000_000_000);

const start = Number(startAtMs);
// Spin rather than sleep: a timer would reintroduce the scheduling jitter we are trying to remove.
while (Date.now() < start) { /* wait for the shared instant */ }

try {
  const id = ledger.reserve(agentId!, Number(amount), `race-${process.pid}`);
  ledger.settle(id, Number(amount));
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (e) {
  const reason = e instanceof OrgBudgetError ? e.reason : `UNEXPECTED:${(e as Error).message}`;
  process.stdout.write(JSON.stringify({ ok: false, reason }));
}
db.close();
