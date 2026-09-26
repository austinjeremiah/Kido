/**
 * One competing process for the quota race.
 *
 * The in-process test (STUDIO-016) proves the invariant but not the mechanism: better-sqlite3 is
 * synchronous, so nothing can interleave between the read and the write inside one process however
 * the code is written. Only separate processes can tell an atomic reservation apart from a
 * check-then-act that happens to be correct today.
 */
import { openStudioDb } from "../src/db.js";
import { QuotaManager, QuotaExceededError } from "../src/quota.js";
import { DEFAULT_QUOTA } from "../src/config.js";

const [dbPath, startAtMs, requestBudget] = process.argv.slice(2);

const db = openStudioDb(`file:${dbPath}`);
db.pragma("busy_timeout = 20000");
const q = new QuotaManager(db, { ...DEFAULT_QUOTA, modelRequestsPerBuild: Number(requestBudget) });

const start = Number(startAtMs);
while (Date.now() < start) { /* spin to the shared instant */ }

try {
  const id = q.reserve("b1", "requirements", 10);
  q.settle(id, "b1", "requirements", `run-${process.pid}`, {
    requests: 1,
    inputTokens: 10,
    outputTokens: 10,
    totalTokens: 20,
  });
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (e) {
  const kind = e instanceof QuotaExceededError ? e.kind : `UNEXPECTED:${(e as Error).message}`;
  process.stdout.write(JSON.stringify({ ok: false, kind }));
}
db.close();
