import Database from "better-sqlite3";

/**
 * Studio persistence. Same engine and conventions as the broker.
 *
 * A build's lifetime belongs here, not to a browser tab. Everything needed to reconstruct a build —
 * stage, blueprint revisions, events, files, tests, simulations, usage — is written as it happens,
 * so a refresh or a crashed frontend loses a view, never a build.
 *
 * It stores no secret: no API key, no private policy value, no sandbox credential.
 */
export type DB = Database.Database;

export function openStudioDb(url: string): DB {
  const path = url.startsWith("file:") ? url.slice("file:".length) : url;
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_projects (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS studio_builds (
      id                 TEXT PRIMARY KEY,
      project_id         TEXT NOT NULL,
      user_id            TEXT NOT NULL,
      stage              TEXT NOT NULL,
      status             TEXT NOT NULL,
      blueprint_revision INTEGER,
      build_revision     INTEGER NOT NULL DEFAULT 0,
      sandbox_id         TEXT,
      sandbox_started_at INTEGER,
      repair_cycles      INTEGER NOT NULL DEFAULT 0,
      approved_at        TEXT,
      failure_reason     TEXT,
      idempotency_key    TEXT UNIQUE,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES studio_projects(id)
    );

    CREATE TABLE IF NOT EXISTS studio_blueprints (
      build_id   TEXT NOT NULL,
      revision   INTEGER NOT NULL,
      document   TEXT NOT NULL,
      validation TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (build_id, revision),
      FOREIGN KEY(build_id) REFERENCES studio_builds(id)
    );

    CREATE TABLE IF NOT EXISTS studio_build_events (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      build_id   TEXT NOT NULL,
      type       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(build_id) REFERENCES studio_builds(id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_build ON studio_build_events(build_id, seq);

    -- One row per model request. The SDK's usage accounting is the source; nothing here is
    -- estimated from text length.
    CREATE TABLE IF NOT EXISTS studio_usage (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      build_id      TEXT NOT NULL,
      role          TEXT NOT NULL,
      run_id        TEXT NOT NULL,
      model         TEXT NOT NULL,
      requests      INTEGER NOT NULL,
      input_tokens  INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens  INTEGER NOT NULL,
      created_at    TEXT NOT NULL,
      FOREIGN KEY(build_id) REFERENCES studio_builds(id)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_build ON studio_usage(build_id);

    -- Reservations are how the quota stays atomic. A request reserves its worst case before the
    -- call, then settles to actual usage after. Two concurrent callers cannot both see budget that
    -- only one of them can have.
    CREATE TABLE IF NOT EXISTS studio_usage_reservations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      build_id       TEXT NOT NULL,
      role           TEXT NOT NULL,
      input_tokens   INTEGER NOT NULL,
      output_tokens  INTEGER NOT NULL,
      state          TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      FOREIGN KEY(build_id) REFERENCES studio_builds(id)
    );
    CREATE INDEX IF NOT EXISTS idx_resv_build ON studio_usage_reservations(build_id, state);

    -- blueprint_revision is recorded alongside build_revision because code generated from an
    -- earlier Blueprint is stale even when no rebuild has happened since. Without it, editing the
    -- design would leave the Code view showing files that no longer implement it, with nothing
    -- saying so.
    CREATE TABLE IF NOT EXISTS studio_artifacts (
      build_id           TEXT NOT NULL,
      build_revision     INTEGER NOT NULL,
      blueprint_revision INTEGER NOT NULL DEFAULT 0,
      path               TEXT NOT NULL,
      content            TEXT NOT NULL,
      bytes              INTEGER NOT NULL,
      updated_at         TEXT NOT NULL,
      PRIMARY KEY (build_id, build_revision, path),
      FOREIGN KEY(build_id) REFERENCES studio_builds(id)
    );

    -- sim_class decides whether a run is charged to the user's allowance. Security verification is
    -- not a metered feature: charging it made a rebuild after a Blueprint edit silently run a
    -- truncated subset (FND-V2-005). pass_id groups one sweep so the pass ceiling is countable.
    CREATE TABLE IF NOT EXISTS studio_simulations (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      build_id           TEXT NOT NULL,
      scenario_id        TEXT NOT NULL,
      sim_class          TEXT NOT NULL DEFAULT 'MANDATORY_SECURITY',
      pass_id            TEXT NOT NULL DEFAULT 'p0',
      blueprint_revision INTEGER NOT NULL,
      build_revision     INTEGER NOT NULL,
      result             TEXT NOT NULL,
      passed             INTEGER NOT NULL,
      created_at         TEXT NOT NULL,
      FOREIGN KEY(build_id) REFERENCES studio_builds(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sim_build ON studio_simulations(build_id);

    CREATE TABLE IF NOT EXISTS studio_security_findings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      build_id   TEXT NOT NULL,
      code       TEXT NOT NULL,
      severity   TEXT NOT NULL,
      path       TEXT NOT NULL,
      message    TEXT NOT NULL,
      source     TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(build_id) REFERENCES studio_builds(id)
    );

    CREATE TABLE IF NOT EXISTS studio_test_results (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      build_id       TEXT NOT NULL,
      build_revision INTEGER NOT NULL,
      suite          TEXT NOT NULL,
      passed         INTEGER NOT NULL,
      failed         INTEGER NOT NULL,
      output         TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      FOREIGN KEY(build_id) REFERENCES studio_builds(id)
    );

    /*
     * Organizations are stored whole rather than shredded into agent rows. The document is the
     * unit that gets validated, versioned and reasoned about; a half-applied edit across four
     * tables would be an organization nobody designed.
     */
    /*
     * ── P25: the control plane's persisted state ──────────────────────────────
     *
     * The browser is not the control plane. Everything a reconnecting client needs is either in
     * these tables or re-read from the system it describes; nothing lives only in a page's memory.
     */

    /*
     * RuntimeEvents. Append-only.
     *
     * event_id is a PRIMARY KEY derived from the event's content, which is what makes ingestion
     * idempotent at the database level too: a replayed observation collides rather than duplicating.
     * There is deliberately no UPDATE path — a correction is a new row whose corrects_event_id
     * names the one it supersedes.
     */
    CREATE TABLE IF NOT EXISTS control_runtime_events (
      event_id             TEXT PRIMARY KEY,
      schema_version       TEXT NOT NULL,
      organization_id      TEXT,
      project_id           TEXT NOT NULL,
      deployment_id        TEXT NOT NULL,
      agent_id             TEXT,
      source               TEXT NOT NULL,
      type                 TEXT NOT NULL,
      severity             TEXT NOT NULL,
      timestamp            INTEGER NOT NULL,
      observed_at          INTEGER NOT NULL,
      correlation_id       TEXT NOT NULL,
      agent_run_id         TEXT,
      model_run_id         TEXT,
      strategy_evaluation_id TEXT,
      cre_execution_id     TEXT,
      authorization_id     TEXT,
      capability_id        TEXT,
      chain_id             INTEGER,
      block_number         TEXT,
      tx_hash              TEXT,
      cre_workflow_id      TEXT,
      adapter_id           TEXT,
      runtime_revision     TEXT,
      build_revision       INTEGER,
      deployment_revision  TEXT,
      corrects_event_id    TEXT,
      public_metadata      TEXT NOT NULL
    );
    -- The timeline is read by deployment and time, and navigated by correlation or a tx hash.
    CREATE INDEX IF NOT EXISTS idx_cre_events_deployment ON control_runtime_events(deployment_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_cre_events_correlation ON control_runtime_events(correlation_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_cre_events_tx ON control_runtime_events(tx_hash);
    CREATE INDEX IF NOT EXISTS idx_cre_events_source ON control_runtime_events(deployment_id, source, timestamp);

    /*
     * Alerts, keyed by FINGERPRINT rather than by occurrence.
     *
     * The UNIQUE constraint is what stops a 15-second polling loop filing 240 rows an hour for one
     * problem. A repeat observation updates occurrences and last_seen; it does not insert.
     */
    CREATE TABLE IF NOT EXISTS control_alerts (
      alert_id             TEXT PRIMARY KEY,
      fingerprint          TEXT NOT NULL,
      rule                 TEXT NOT NULL,
      severity             TEXT NOT NULL,
      state                TEXT NOT NULL,
      project_id           TEXT NOT NULL,
      deployment_id        TEXT NOT NULL,
      subject              TEXT NOT NULL,
      reason               TEXT NOT NULL,
      evidence             TEXT NOT NULL,
      first_seen_at        INTEGER NOT NULL,
      last_seen_at         INTEGER NOT NULL,
      occurrences          INTEGER NOT NULL,
      acknowledged_by      TEXT,
      acknowledged_at      INTEGER,
      resolved_at          INTEGER,
      resolved_by          TEXT,
      resolution_evidence  TEXT,
      requires_reconciliation INTEGER NOT NULL
    );
    -- One OPEN row per fingerprint. A resolved one may coexist so a recurrence is a new row.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_open ON control_alerts(fingerprint) WHERE state != 'RESOLVED';
    CREATE INDEX IF NOT EXISTS idx_alerts_deployment ON control_alerts(deployment_id, state, severity);

    /*
     * Control commands.
     *
     * idempotency_key is UNIQUE, so the same intent submitted twice is one row and the second
     * submission reads back the first one's outcome rather than performing it again.
     */
    CREATE TABLE IF NOT EXISTS control_commands (
      command_id           TEXT PRIMARY KEY,
      idempotency_key      TEXT NOT NULL UNIQUE,
      project_id           TEXT NOT NULL,
      deployment_id        TEXT NOT NULL,
      operation            TEXT NOT NULL,
      actor_id             TEXT NOT NULL,
      actor_capabilities   TEXT NOT NULL,
      target               TEXT NOT NULL,
      expected_revision    TEXT NOT NULL,
      issued_at            INTEGER NOT NULL,
      expires_at           INTEGER NOT NULL,
      completed_at         INTEGER,
      outcome              TEXT NOT NULL,
      detail               TEXT,
      result               TEXT,
      reason               TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_commands_deployment ON control_commands(deployment_id, issued_at);

    /*
     * The last observation of each external system.
     *
     * A cache, and named one. observed_at is stored so a reader can compute age; nothing reads
     * value without it. This exists to be COMPARED against a fresh read, never substituted for
     * one — §25.17.
     */
    CREATE TABLE IF NOT EXISTS control_observations (
      deployment_id        TEXT NOT NULL,
      kind                 TEXT NOT NULL,
      subject              TEXT NOT NULL,
      state                TEXT NOT NULL,
      value                TEXT,
      observed_at          INTEGER NOT NULL,
      ttl_ms               INTEGER NOT NULL,
      source               TEXT NOT NULL,
      reason               TEXT,
      PRIMARY KEY (deployment_id, kind, subject)
    );

    /* Emergency locks, with per-step state so a retry cannot hide a prior success. */
    CREATE TABLE IF NOT EXISTS control_emergency_locks (
      lock_id              TEXT PRIMARY KEY,
      idempotency_key      TEXT NOT NULL UNIQUE,
      deployment_id        TEXT NOT NULL,
      initiated_by         TEXT NOT NULL,
      initiated_at         INTEGER NOT NULL,
      state                TEXT NOT NULL,
      steps                TEXT NOT NULL,
      financial_policy_disabled INTEGER NOT NULL,
      include_identity_revocation INTEGER NOT NULL,
      completed_at         INTEGER
    );

    /* Chain scan cursors. Resumed with reorg overlap; see resumeFrom(). */
    CREATE TABLE IF NOT EXISTS control_chain_cursors (
      chain_id             INTEGER NOT NULL,
      contract             TEXT NOT NULL,
      event_signature      TEXT NOT NULL,
      last_finalized_block TEXT NOT NULL,
      last_processed_log_id TEXT,
      updated_at           INTEGER NOT NULL,
      PRIMARY KEY (chain_id, contract, event_signature)
    );

    CREATE TABLE IF NOT EXISTS studio_organizations (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      prompt     TEXT NOT NULL,
      revision   INTEGER NOT NULL,
      doc        TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    /*
     * Lab runs a user starts by hand against a project: the official CRE simulation, for now.
     *
     * One row per run, never overwritten. The Lab reads the LATEST row for a project and kind, so
     * a rerun that fails after a pass is what the screen shows — a stored "passed" flag that
     * survived a later failure would be the stale green indicator the whole Lab exists to avoid.
     */
    CREATE TABLE IF NOT EXISTS studio_lab_runs (
      id                 TEXT PRIMARY KEY,
      project_id         TEXT NOT NULL,
      build_id           TEXT,
      blueprint_revision INTEGER,
      kind               TEXT NOT NULL,
      status             TEXT NOT NULL,
      result             TEXT NOT NULL,
      started_at         TEXT NOT NULL,
      finished_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lab_runs_project ON studio_lab_runs(project_id, kind, started_at);

    /*
     * Deployments to a local mainnet fork.
     *
     * The row is the durable part: which project, which Blueprint revision, what phase it reached
     * and the record of what was deployed where. The fork process and the agent loop live only as
     * long as the server does, and a row whose process died is reconciled to STOPPED on the next
     * start rather than left claiming a runtime nobody is running.
     */
    CREATE TABLE IF NOT EXISTS studio_fork_deployments (
      id                 TEXT PRIMARY KEY,
      project_id         TEXT NOT NULL,
      build_id           TEXT,
      blueprint_revision INTEGER NOT NULL,
      state              TEXT NOT NULL,
      phase              TEXT NOT NULL,
      revision           TEXT NOT NULL,
      record             TEXT NOT NULL,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fork_deployments_project ON studio_fork_deployments(project_id, created_at);
  `);

  /*
   * The ENS name the user gave a single agent, when they gave one.
   *
   * Added after the fact, so it is an ALTER guarded by a column probe rather than part of the
   * CREATE: existing databases keep their rows and gain the column empty, which is the truthful
   * state for a project created before the field existed.
   */
  const projectColumns = (db.prepare(`PRAGMA table_info(studio_projects)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!projectColumns.includes("ens_name")) db.exec(`ALTER TABLE studio_projects ADD COLUMN ens_name TEXT`);
}
