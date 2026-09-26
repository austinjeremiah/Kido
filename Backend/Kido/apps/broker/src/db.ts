import Database from "better-sqlite3";

/**
 * Operational and audit storage.
 *
 * IMPORTANT: this database is NOT a source of financial authority. Authority is reconstructed
 * from the signed capability plus current on-chain state. The database exists for idempotency,
 * request status and an auditable history. If it disappeared, no one would gain permission —
 * issuance would simply fail closed.
 *
 * It stores hashes and IDs, never private keys, never raw private policy, never Key Ring plaintext.
 */
export type DB = Database.Database;

export function openDb(url: string): DB {
  const path = url.startsWith("file:") ? url.slice("file:".length) : url;
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS capability_requests (
      id                  TEXT PRIMARY KEY,
      idempotency_key     TEXT NOT NULL UNIQUE,
      agent_ens_name      TEXT NOT NULL,
      agent_address       TEXT NOT NULL,
      agent_identity_hash TEXT,
      policy_hash         TEXT NOT NULL,
      action_kind         TEXT NOT NULL,
      intent_hash         TEXT NOT NULL,
      target              TEXT NOT NULL,
      value               TEXT NOT NULL,
      calldata            TEXT NOT NULL,
      calldata_hash       TEXT NOT NULL,
      amount              TEXT NOT NULL,
      status              TEXT NOT NULL,
      reason_code         TEXT,
      identity_source     TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cre_authorizations (
      authorization_id   TEXT PRIMARY KEY,
      request_id         TEXT NOT NULL,
      request_hash       TEXT NOT NULL,
      verdict            TEXT NOT NULL,
      reason_code        TEXT NOT NULL,
      context_commitment TEXT NOT NULL,
      evaluated_at       INTEGER NOT NULL,
      approved_until     INTEGER NOT NULL,
      source             TEXT NOT NULL,
      observed_tx_hash   TEXT,
      FOREIGN KEY(request_id) REFERENCES capability_requests(id)
    );

    CREATE TABLE IF NOT EXISTS capabilities (
      digest           TEXT PRIMARY KEY,
      request_id       TEXT NOT NULL,
      nonce            TEXT NOT NULL,
      issued_at        INTEGER NOT NULL,
      expires_at       INTEGER NOT NULL,
      status           TEXT NOT NULL,
      execution_tx_hash TEXT,
      FOREIGN KEY(request_id) REFERENCES capability_requests(id)
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT,
      type       TEXT NOT NULL,
      detail     TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_events(request_id);
  `);
}

export const AuditType = {
  REQUEST_RECEIVED: "REQUEST_RECEIVED",
  REQUEST_REJECTED_VALIDATION: "REQUEST_REJECTED_VALIDATION",
  IDEMPOTENT_REPLAY: "IDEMPOTENT_REPLAY",
  ENS_IDENTITY_VALIDATED: "ENS_IDENTITY_VALIDATED",
  ENS_IDENTITY_FAILED: "ENS_IDENTITY_FAILED",
  POLICY_CHECK_PASSED: "POLICY_CHECK_PASSED",
  POLICY_CHECK_FAILED: "POLICY_CHECK_FAILED",
  EVALUATION_REQUESTED: "EVALUATION_REQUESTED",
  AUTHORIZATION_OBSERVED: "AUTHORIZATION_OBSERVED",
  AUTHORIZATION_RECORDED_ONCHAIN: "AUTHORIZATION_RECORDED_ONCHAIN",
  CAPABILITY_MINTED: "CAPABILITY_MINTED",
  ESCALATION_CREATED: "ESCALATION_CREATED",
  DENIED: "DENIED",
  OPERATIONAL_FAILURE: "OPERATIONAL_FAILURE",
} as const;
export type AuditType = (typeof AuditType)[keyof typeof AuditType];

export function audit(db: DB, requestId: string | null, type: AuditType, detail: unknown): void {
  db.prepare(
    "INSERT INTO audit_events (request_id, type, detail, created_at) VALUES (?, ?, ?, ?)",
  ).run(requestId, type, JSON.stringify(detail), new Date().toISOString());
}
