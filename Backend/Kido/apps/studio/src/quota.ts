import type { DB } from "./db.js";
import { DEFAULT_QUOTA, type StudioQuotaPolicy, type StudioRole, estimateCostUsd, STUDIO_MODEL } from "./config.js";

/**
 * Why a simulation ran. Determines whether it is charged to the user's allowance.
 */
export type SimulationClass = "MANDATORY_SECURITY" | "ADAPTER_REGRESSION" | "USER_REQUESTED";

/**
 * Server-side quota enforcement.
 *
 * The important property is atomicity. A frontend check is a courtesy; a check-then-act on the
 * server is a race. Two requests that both read "58 of 60 used" will both proceed, and the limit
 * silently becomes a suggestion.
 *
 * So spending is a two-phase operation:
 *
 *   reserve()  — inside one synchronous SQLite transaction, re-read the totals and insert a
 *                reservation row, or refuse. better-sqlite3 is synchronous and the transaction is
 *                serialized, so no interleaving is possible between the read and the insert.
 *   settle()   — after the model call returns, replace the reservation with the SDK's actual usage.
 *
 * A reservation covers the *worst case* (`reservedOutputTokensPerRequest`), which is what makes it
 * safe to start a call at all: a build cannot begin a turn it lacks the budget to finish.
 */

export type QuotaKind =
  | "MODEL_REQUESTS"
  | "INPUT_TOKENS"
  | "OUTPUT_TOKENS"
  | "REPAIR_LOOPS"
  | "USER_SIMULATIONS"
  | "MANDATORY_SIMULATION_CEILING"
  | "MANDATORY_PASS_CEILING"
  | "SANDBOX_WALL_CLOCK"
  | "GENERATED_FILES"
  | "NEW_BUILDS"
  | "CONCURRENT_BUILDS"
  | "EXPORT_SIZE";

export class QuotaExceededError extends Error {
  constructor(
    readonly kind: QuotaKind,
    readonly used: number,
    readonly limit: number,
  ) {
    super(`quota exceeded: ${kind} (${used}/${limit})`);
    this.name = "QuotaExceededError";
  }
}

export interface UsageSnapshot {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  simulations: number;
  /** Charged against the user's allowance. */
  userSimulations: number;
  /** Security verification. Recorded and shown, never charged. */
  mandatorySimulations: number;
  repairCycles: number;
  generatedFiles: number;
  estimatedCostUsd: number | null;
  limits: StudioQuotaPolicy;
  /** Highest fraction of any enforced budget consumed. Drives the 80% warning. */
  peakFraction: number;
  warned: boolean;
}

export class QuotaManager {
  constructor(
    private readonly db: DB,
    readonly policy: StudioQuotaPolicy = DEFAULT_QUOTA,
  ) {}

  /* ── build creation ─────────────────────────────────────────────────────── */

  assertCanCreateBuild(userId: string, now = Date.now()): void {
    const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    /*
     * The daily allowance rations WORK, not rows.
     *
     * It used to count every build created in the window, which meant a build that died before it
     * did anything — a server restart, a missing credential, a crash on the first call — still
     * consumed one of three. The user was charged for the system's failure, and unlike the
     * concurrency slot there is no way to give it back: the window is time-based.
     *
     * So a build counts if it spent something, completed, or is still going. Only a build that
     * ended WITHOUT completing and WITHOUT spending is free — which is exactly "it died before it
     * did anything", and nothing about that is an allowance's business.
     *
     * `COMPLETED` is in the list independently of the usage rows. A finished build did the work by
     * definition, and the count should not depend on the accounting table having been written.
     *
     * Reservation state matters, and it is the difference between the two failures that prompted
     * this. `RELEASED` is the system saying *this call did not happen* — a credential missing before
     * any request left the machine — and it is free. `HELD` is a reservation nobody ever resolved,
     * which means the process died mid-call and the provider may well have been paid; that is not
     * free, and treating it as free would hand out a build every time a request was interrupted.
     *
     * This cannot be farmed. Concurrency is capped at one, so at most a single in-flight build is
     * uncounted at any moment, and the create route has its own per-user rate limit above this.
     */
    const recent = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM studio_builds b
          WHERE b.user_id = ? AND b.created_at >= ?
            AND ( EXISTS (SELECT 1 FROM studio_usage u WHERE u.build_id = b.id)
               OR EXISTS (SELECT 1 FROM studio_usage_reservations r WHERE r.build_id = b.id AND r.state IN ('SETTLED','HELD'))
               OR b.status IN ('RUNNING','AWAITING_APPROVAL','PAUSED','COMPLETED') )`,
      )
      .get(userId, since) as { n: number };
    if (this.policy.newBuildsPerRollingDay !== null && recent.n >= this.policy.newBuildsPerRollingDay) {
      throw new QuotaExceededError("NEW_BUILDS", recent.n, this.policy.newBuildsPerRollingDay);
    }
    const active = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM studio_builds
         WHERE user_id = ? AND status IN ('RUNNING','AWAITING_APPROVAL','PAUSED')`,
      )
      .get(userId) as { n: number };
    if (active.n >= this.policy.concurrentBuilds) {
      throw new QuotaExceededError("CONCURRENT_BUILDS", active.n, this.policy.concurrentBuilds);
    }
  }

  /* ── model spend ────────────────────────────────────────────────────────── */

  /**
   * Reserve budget for one model request. Returns the reservation id.
   * Throws QuotaExceededError if the request cannot be afforded.
   */
  reserve(buildId: string, role: StudioRole, estimatedInputTokens: number): number {
    const reserveOut = this.policy.reservedOutputTokensPerRequest;
    const txn = this.db.transaction((): number => {
      const t = this.totals(buildId);
      if (t.requests + 1 > this.policy.modelRequestsPerBuild) {
        throw new QuotaExceededError("MODEL_REQUESTS", t.requests, this.policy.modelRequestsPerBuild);
      }
      if (t.inputTokens + estimatedInputTokens > this.policy.inputTokensPerBuild) {
        throw new QuotaExceededError("INPUT_TOKENS", t.inputTokens, this.policy.inputTokensPerBuild);
      }
      if (t.outputTokens + reserveOut > this.policy.outputTokensPerBuild) {
        throw new QuotaExceededError("OUTPUT_TOKENS", t.outputTokens, this.policy.outputTokensPerBuild);
      }
      const info = this.db
        .prepare(
          `INSERT INTO studio_usage_reservations (build_id, role, input_tokens, output_tokens, state, created_at)
           VALUES (?, ?, ?, ?, 'HELD', ?)`,
        )
        .run(buildId, role, estimatedInputTokens, reserveOut, new Date().toISOString());
      return Number(info.lastInsertRowid);
    });
    // `.immediate()` takes the write lock at BEGIN. With the default deferred mode the lock is
    // acquired on first write, which is exactly the gap two concurrent reservations would race in.
    return txn.immediate();
  }

  /** Replace a reservation with the SDK's authoritative usage. */
  settle(
    reservationId: number,
    buildId: string,
    role: StudioRole,
    runId: string,
    usage: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number },
  ): void {
    const txn = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE studio_usage_reservations SET state = 'SETTLED' WHERE id = ?`)
        .run(reservationId);
      this.db
        .prepare(
          `INSERT INTO studio_usage (build_id, role, run_id, model, requests, input_tokens, output_tokens, total_tokens, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          buildId,
          role,
          runId,
          STUDIO_MODEL,
          usage.requests,
          usage.inputTokens,
          usage.outputTokens,
          usage.totalTokens,
          new Date().toISOString(),
        );
    });
    txn();
  }

  /** Release a reservation whose call never happened (e.g. an upstream 429 before any tokens). */
  release(reservationId: number): void {
    this.db.prepare(`UPDATE studio_usage_reservations SET state = 'RELEASED' WHERE id = ?`).run(reservationId);
  }

  /* ── other budgets ──────────────────────────────────────────────────────── */

  /**
   * Simulation budgets, split by class.
   *
   * `MANDATORY_SECURITY` and `ADAPTER_REGRESSION` are not charged to the user. They are the suite
   * that proves the design does what it claims, and metering them meant a rebuild after an edit ran
   * a truncated subset while looking like a complete one (FND-V2-005).
   *
   * They are still BOUNDED — by a per-pass ceiling, a per-build pass ceiling, and (in the pipeline)
   * by sandbox wall clock. Not charged is not the same as unlimited.
   */
  assertCanSimulate(buildId: string, cls: SimulationClass = "USER_REQUESTED"): void {
    if (cls === "USER_REQUESTED") {
      const n = (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM studio_simulations WHERE build_id = ? AND sim_class = 'USER_REQUESTED'`)
          .get(buildId) as { n: number }
      ).n;
      if (n >= this.policy.userRequestedSimulationsPerBuild) {
        throw new QuotaExceededError("USER_SIMULATIONS", n, this.policy.userRequestedSimulationsPerBuild);
      }
      return;
    }

    const passCount = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT pass_id) AS n FROM studio_simulations WHERE build_id = ? AND sim_class <> 'USER_REQUESTED'`,
        )
        .get(buildId) as { n: number }
    ).n;
    if (passCount > this.policy.maxMandatoryPassesPerBuild) {
      throw new QuotaExceededError("MANDATORY_PASS_CEILING", passCount, this.policy.maxMandatoryPassesPerBuild);
    }
  }

  /** Bound on a single mandatory pass, checked before it starts rather than partway through. */
  assertMandatoryPassSize(planned: number): void {
    if (planned > this.policy.maxMandatorySimulationsPerPass) {
      throw new QuotaExceededError("MANDATORY_SIMULATION_CEILING", planned, this.policy.maxMandatorySimulationsPerPass);
    }
  }

  assertCanRepair(buildId: string): void {
    const row = this.db.prepare(`SELECT repair_cycles AS n FROM studio_builds WHERE id = ?`).get(buildId) as
      | { n: number }
      | undefined;
    const n = row?.n ?? 0;
    if (n >= this.policy.autoRepairLoops) {
      throw new QuotaExceededError("REPAIR_LOOPS", n, this.policy.autoRepairLoops);
    }
  }

  assertCanWriteFile(buildId: string, buildRevision: number): void {
    const n = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM studio_artifacts WHERE build_id = ? AND build_revision = ?`)
        .get(buildId, buildRevision) as { n: number }
    ).n;
    if (n >= this.policy.generatedFiles) {
      throw new QuotaExceededError("GENERATED_FILES", n, this.policy.generatedFiles);
    }
  }

  assertSandboxWithinWallClock(startedAtMs: number, now = Date.now()): void {
    const elapsed = now - startedAtMs;
    if (elapsed > this.policy.sandboxWallClockMs) {
      throw new QuotaExceededError("SANDBOX_WALL_CLOCK", elapsed, this.policy.sandboxWallClockMs);
    }
  }

  /* ── reporting ──────────────────────────────────────────────────────────── */

  /** Settled usage plus anything currently held, so a snapshot never under-reports in flight. */
  private totals(buildId: string) {
    const settled = this.db
      .prepare(
        `SELECT COALESCE(SUM(requests),0) AS requests,
                COALESCE(SUM(input_tokens),0) AS inputTokens,
                COALESCE(SUM(output_tokens),0) AS outputTokens
         FROM studio_usage WHERE build_id = ?`,
      )
      .get(buildId) as { requests: number; inputTokens: number; outputTokens: number };
    const held = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(input_tokens),0) AS inputTokens,
                COALESCE(SUM(output_tokens),0) AS outputTokens
         FROM studio_usage_reservations WHERE build_id = ? AND state = 'HELD'`,
      )
      .get(buildId) as { requests: number; inputTokens: number; outputTokens: number };
    return {
      requests: settled.requests + held.requests,
      inputTokens: settled.inputTokens + held.inputTokens,
      outputTokens: settled.outputTokens + held.outputTokens,
    };
  }

  snapshot(buildId: string): UsageSnapshot {
    const t = this.totals(buildId);
    const sims = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM studio_simulations WHERE build_id = ?`).get(buildId) as { n: number }
    ).n;
    const userSims = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM studio_simulations WHERE build_id = ? AND sim_class = 'USER_REQUESTED'`)
        .get(buildId) as { n: number }
    ).n;
    const mandatorySims = sims - userSims;
    const repair = (
      (this.db.prepare(`SELECT repair_cycles AS n FROM studio_builds WHERE id = ?`).get(buildId) as
        | { n: number }
        | undefined)?.n ?? 0
    );
    const files = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM studio_artifacts WHERE build_id = ?`).get(buildId) as { n: number }
    ).n;

    const fractions = [
      t.requests / this.policy.modelRequestsPerBuild,
      t.inputTokens / this.policy.inputTokensPerBuild,
      t.outputTokens / this.policy.outputTokensPerBuild,
      userSims / this.policy.userRequestedSimulationsPerBuild,
      files / this.policy.generatedFiles,
    ];
    const peakFraction = Math.max(...fractions);

    return {
      requests: t.requests,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      totalTokens: t.inputTokens + t.outputTokens,
      simulations: sims,
      userSimulations: userSims,
      mandatorySimulations: mandatorySims,
      repairCycles: repair,
      generatedFiles: files,
      estimatedCostUsd: estimateCostUsd(STUDIO_MODEL, t.inputTokens, t.outputTokens),
      limits: this.policy,
      peakFraction,
      warned: peakFraction >= this.policy.warnAtFraction,
    };
  }
}
