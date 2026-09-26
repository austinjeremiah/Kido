import type Database from "better-sqlite3";
import type { Organization } from "./schema.js";

/**
 * The shared-treasury ledger.
 *
 * Several agents spend from one pot concurrently. The interesting failure is not a single agent
 * exceeding its limit — that is a comparison — it is two agents each passing the check against the
 * same balance and then both spending. So spending is `reserve → act → settle`, and the reservation
 * itself is what a later check sees.
 *
 * Reservations count against the totals from the moment they exist. An agent that reserves and
 * crashes holds its reservation until it is released or expires; that is deliberate, because the
 * alternative is releasing budget for an action that may still land on chain.
 */

export const ORG_BUDGET_REASONS = {
  UNKNOWN_AGENT: "ORG-BUDGET-UNKNOWN-AGENT",
  NOT_EXECUTOR: "ORG-BUDGET-NOT-EXECUTOR",
  REVOKED: "ORG-BUDGET-AGENT-REVOKED",
  UNKNOWN_LIMIT: "ORG-BUDGET-UNKNOWN-LIMIT",
  PER_ACTION: "ORG-BUDGET-PER-ACTION",
  AGENT_DAILY: "ORG-BUDGET-AGENT-DAILY",
  AGGREGATE: "ORG-BUDGET-AGGREGATE",
  OVERSPEND: "ORG-BUDGET-OVERSPEND",
  NO_RESERVATION: "ORG-BUDGET-NO-RESERVATION",
} as const;
export type OrgBudgetReason = (typeof ORG_BUDGET_REASONS)[keyof typeof ORG_BUDGET_REASONS];

export class OrgBudgetError extends Error {
  constructor(
    readonly reason: OrgBudgetReason,
    readonly detail: { agentId: string; requestedUsdCents?: number; usedUsdCents?: number; limitUsdCents?: number },
  ) {
    super(`${reason}: agent ${detail.agentId}`);
    this.name = "OrgBudgetError";
  }
}

export const ORG_BUDGET_SCHEMA = `
CREATE TABLE IF NOT EXISTS org_spend (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  usd_cents     INTEGER NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('HELD','SETTLED','RELEASED')),
  action_ref    TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_spend_window ON org_spend (org_id, created_at_ms, state);

CREATE TABLE IF NOT EXISTS org_revocations (
  org_id       TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  revoked_at_ms INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  PRIMARY KEY (org_id, agent_id)
);
`;

export interface BudgetWindowTotals {
  agentUsdCents: number;
  orgUsdCents: number;
}

export class OrgBudgetLedger {
  constructor(
    private readonly db: Database.Database,
    private readonly org: Organization,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.db.exec(ORG_BUDGET_SCHEMA);
  }

  /** The organization-wide window. One aggregate limit is the common case; the tightest wins. */
  private aggregate() {
    return [...this.org.aggregateLimits].sort((a, b) => a.maxUsdCents - b.maxUsdCents)[0];
  }

  /**
   * Spend counted in a window. HELD and SETTLED both count; RELEASED does not.
   * A held reservation is money that may yet leave, so treating it as unspent would reopen the race
   * it exists to close.
   */
  totals(agentId: string, windowMs: number): BudgetWindowTotals {
    const since = this.now() - windowMs;
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN agent_id = ? THEN usd_cents ELSE 0 END), 0) AS agent_cents,
           COALESCE(SUM(usd_cents), 0) AS org_cents
         FROM org_spend
         WHERE org_id = ? AND created_at_ms > ? AND state IN ('HELD','SETTLED')`,
      )
      .get(agentId, this.org.orgId, since) as { agent_cents: number; org_cents: number };
    return { agentUsdCents: row.agent_cents, orgUsdCents: row.org_cents };
  }

  isRevoked(agentId: string): boolean {
    const r = this.db
      .prepare(`SELECT 1 FROM org_revocations WHERE org_id = ? AND agent_id = ?`)
      .get(this.org.orgId, agentId);
    return r !== undefined;
  }

  /**
   * Revoke an agent.
   *
   * Revocation stops future spending immediately and does not touch settled history: the audit
   * trail of what a compromised agent already did is the point of keeping it.
   */
  revoke(agentId: string, reason: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO org_revocations (org_id, agent_id, revoked_at_ms, reason) VALUES (?, ?, ?, ?)`,
      )
      .run(this.org.orgId, agentId, this.now(), reason);
  }

  /** Reserve budget for one action. Returns the reservation id, or throws with an exact reason. */
  reserve(agentId: string, usdCents: number, actionRef: string): number {
    const agent = this.org.agents.find((a) => a.id === agentId);
    if (!agent) throw new OrgBudgetError(ORG_BUDGET_REASONS.UNKNOWN_AGENT, { agentId });
    if (agent.executionClass !== "EXECUTE") {
      throw new OrgBudgetError(ORG_BUDGET_REASONS.NOT_EXECUTOR, { agentId });
    }
    if (agent.escalationMaxUsdCents === null || agent.dailyMaxUsdCents === null) {
      throw new OrgBudgetError(ORG_BUDGET_REASONS.UNKNOWN_LIMIT, { agentId, requestedUsdCents: usdCents });
    }

    const agg = this.aggregate();
    const windowMs = agg?.windowMs ?? 24 * 60 * 60 * 1000;
    const perAction = agent.escalationMaxUsdCents;
    const agentDaily = agent.dailyMaxUsdCents;

    const txn = this.db.transaction((): number => {
      if (this.isRevoked(agentId)) {
        throw new OrgBudgetError(ORG_BUDGET_REASONS.REVOKED, { agentId, requestedUsdCents: usdCents });
      }
      if (usdCents > perAction) {
        throw new OrgBudgetError(ORG_BUDGET_REASONS.PER_ACTION, {
          agentId,
          requestedUsdCents: usdCents,
          limitUsdCents: perAction,
        });
      }
      const t = this.totals(agentId, windowMs);
      if (t.agentUsdCents + usdCents > agentDaily) {
        throw new OrgBudgetError(ORG_BUDGET_REASONS.AGENT_DAILY, {
          agentId,
          requestedUsdCents: usdCents,
          usedUsdCents: t.agentUsdCents,
          limitUsdCents: agentDaily,
        });
      }
      if (agg && t.orgUsdCents + usdCents > agg.maxUsdCents) {
        throw new OrgBudgetError(ORG_BUDGET_REASONS.AGGREGATE, {
          agentId,
          requestedUsdCents: usdCents,
          usedUsdCents: t.orgUsdCents,
          limitUsdCents: agg.maxUsdCents,
        });
      }
      const info = this.db
        .prepare(
          `INSERT INTO org_spend (org_id, agent_id, usd_cents, state, action_ref, created_at_ms)
           VALUES (?, ?, ?, 'HELD', ?, ?)`,
        )
        .run(this.org.orgId, agentId, usdCents, actionRef, this.now());
      return Number(info.lastInsertRowid);
    });
    // Immediate: the write lock is taken at BEGIN, so two agents cannot both read the same totals
    // and then both insert. Deferred mode acquires the lock at first write — precisely the gap.
    return txn.immediate();
  }

  /** Settle a reservation to the actual amount. The actual may be lower; it may never be higher. */
  settle(reservationId: number, actualUsdCents: number): void {
    const txn = this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT agent_id, usd_cents, state FROM org_spend WHERE id = ? AND org_id = ?`)
        .get(reservationId, this.org.orgId) as { agent_id: string; usd_cents: number; state: string } | undefined;
      if (!row || row.state !== "HELD") {
        throw new OrgBudgetError(ORG_BUDGET_REASONS.NO_RESERVATION, { agentId: row?.agent_id ?? "?" });
      }
      if (actualUsdCents > row.usd_cents) {
        throw new OrgBudgetError(ORG_BUDGET_REASONS.OVERSPEND, {
          agentId: row.agent_id,
          requestedUsdCents: actualUsdCents,
          limitUsdCents: row.usd_cents,
        });
      }
      this.db
        .prepare(`UPDATE org_spend SET state = 'SETTLED', usd_cents = ? WHERE id = ?`)
        .run(actualUsdCents, reservationId);
    });
    txn.immediate();
  }

  /** Release a reservation whose action did not happen. */
  release(reservationId: number): void {
    this.db
      .prepare(`UPDATE org_spend SET state = 'RELEASED' WHERE id = ? AND org_id = ? AND state = 'HELD'`)
      .run(reservationId, this.org.orgId);
  }

  /** Attribution: what each agent actually spent, for the audit view. */
  attribution(windowMs: number): Array<{ agentId: string; usdCents: number; actions: number }> {
    const since = this.now() - windowMs;
    return this.db
      .prepare(
        `SELECT agent_id AS agentId, SUM(usd_cents) AS usdCents, COUNT(*) AS actions
         FROM org_spend
         WHERE org_id = ? AND created_at_ms > ? AND state IN ('HELD','SETTLED')
         GROUP BY agent_id ORDER BY agent_id`,
      )
      .all(this.org.orgId, since) as Array<{ agentId: string; usdCents: number; actions: number }>;
  }
}
