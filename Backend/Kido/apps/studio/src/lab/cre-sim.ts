import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "../db.js";

/**
 * The official Chainlink CRE simulation, run on demand for a project.
 *
 * This runs the real `cre workflow simulate` against the ContextLock policy workflow in
 * `workflows/cre-policy/contextlock-cre` — the same binary every agent uses, because the policy is
 * implemented exactly once (see the generated `workflows/cre/policy.ts`, which supplies only the
 * agent-specific configuration). What the run proves is that the real workflow binary evaluates
 * under the CLI's production limits; what it does not prove is stated on the Simulation Center card
 * and is not repeated here.
 *
 * Nothing about the outcome is interpreted charitably. A run that compiled but could not fetch its
 * trigger is a run that did not simulate, and it is recorded as such with the CLI's own last line.
 */

/** The workflow project the CLI is pointed at, relative to the repository root. */
export const CRE_WORKFLOW_DIR = "workflows/cre-policy/contextlock-cre";

/**
 * The trigger the simulation replays.
 *
 * A real Sepolia transaction whose event the policy workflow subscribes to — the same one the P28
 * demo used, so a run here and the recorded run are comparable. The simulator fetches its receipt
 * through the workflow's configured Sepolia RPC.
 */
export const CRE_TRIGGER = {
  txHash: "0x62753fddb9c92d2ff9989c430e2ca47224f992ac3243eb77bea05eda21679843",
  eventIndex: 0,
  triggerIndex: 0,
} as const;

export const CRE_SIM_TIMEOUT_MS = 300_000;

export interface CreSimulationResult {
  /** True when the simulator initialised and evaluated the workflow. False on any earlier stop. */
  ran: boolean;
  /** `ran`, under the CLI's production limits, with a verdict the workflow returned. */
  passed: boolean;
  binaryHash: string | null;
  configHash: string | null;
  /** The workflow's returned string, e.g. `ALLOW:ALLOW_POLICY_MATCH:LOW`. `none` when it returned nothing. */
  verdict: string;
  productionLimits: boolean;
  exitCode: number | null;
  durationMs: number;
  /**
   * The command, with the trigger transaction named by its role.
   *
   * The hash itself is in `triggerTxHash`: a 32-byte hex value inside a plain string array trips
   * the public-surface scanner (it cannot tell a transaction hash from a key by inspection), and
   * the scanner is right to be suspicious of a field called `commandLine`.
   */
  commandLine: string[];
  triggerTxHash: string;
  cliVersion: string | null;
  /** The CLI's last lines, bounded. Where the reason for a failure lives. */
  outputTail: string[];
  /** The failure the CLI reported, when it reported one. */
  failure: string | null;
}

export interface CreSimulationDeps {
  binary?: string;
  cwd?: string;
  timeoutMs?: number;
  nowMs?: () => number;
  /** Injected so tests drive the parser without a CLI. */
  spawnFn?: typeof spawn;
  /**
   * A Sepolia RPC to use for the trigger fetch instead of the one in the workflow's `.env`.
   *
   * The simulator reads the trigger transaction's receipt through the workflow's configured RPC,
   * and a rate-limited key there stops the run before it simulates anything. `STUDIO_CRE_SEPOLIA_RPC`
   * supplies this in a normal run. The workflow's `.env` is never edited: the override is passed
   * to the CLI as a separate env file that exists only for the run.
   */
  sepoliaRpcOverride?: string;
}

const defaultBinary = (): string => `${process.env.HOME}/.cre/bin/cre`;

/** Whether the CLI is on this machine at all. Probed, never assumed. */
export function creCliAvailable(binary = defaultBinary()): boolean {
  return existsSync(binary);
}

export function creSimulateArgv(envFile?: string): string[] {
  return [
    "workflow", "simulate", "policy", "--target", "staging-settings", "--non-interactive",
    "--trigger-index", String(CRE_TRIGGER.triggerIndex),
    "--evm-tx-hash", CRE_TRIGGER.txHash,
    "--evm-event-index", String(CRE_TRIGGER.eventIndex),
    ...(envFile ? ["-e", envFile] : []),
  ];
}

/** `creSimulateArgv` as recorded on a public surface: the trigger by role, the env file by role. */
export function recordedCommandLine(binary: string, overridden: boolean): string[] {
  return [binary, ...creSimulateArgv(overridden ? "<studio-env-override>" : undefined).map((a) => (a === CRE_TRIGGER.txHash ? "<trigger-tx>" : a))];
}

/**
 * The workflow's env with one line replaced, in a private temporary file.
 *
 * Returns null when there is nothing to override. The caller removes the file when the run ends;
 * its mode is owner-only for the moments it exists.
 */
export function overriddenEnvFile(cwd: string, sepoliaRpc: string | undefined): { path: string; dir: string } | null {
  if (!sepoliaRpc) return null;
  const source = join(cwd, ".env");
  const base = existsSync(source) ? readFileSync(source, "utf8") : "";
  const lines = base.split("\n").filter((l) => !l.startsWith("CRE_SECRET_RPC_SEPOLIA="));
  lines.push(`CRE_SECRET_RPC_SEPOLIA=${sepoliaRpc}`);
  const dir = mkdtempSync(join(tmpdir(), "contextlock-cre-"));
  const path = join(dir, ".env");
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
  return { path, dir };
}

/**
 * Parse the CLI's output.
 *
 * Exported so the parser is tested against recorded transcripts rather than only against a live
 * CLI: the two recorded shapes — a full run, and a run that stopped at the trigger fetch — are the
 * ones the tests pin.
 */
export function parseCreOutput(out: string, exitCode: number | null): Omit<CreSimulationResult, "durationMs" | "commandLine" | "cliVersion" | "triggerTxHash"> {
  const lines = out.split("\n").map((l) => l.replace(/\r$/, ""));
  const binaryHash = /Binary hash: ([0-9a-f]{64})/.exec(out)?.[1] ?? null;
  const configHash = /Config hash: ([0-9a-f]{64})/.exec(out)?.[1] ?? null;
  const productionLimits = /Simulation limits enabled/.test(out);
  const verdict = /^"(.+)"$/m.exec(out)?.[1] ?? "none";
  const failureLine = lines.map((l) => l.trim()).filter((l) => l.startsWith("✗")).at(-1) ?? null;
  const ran = /Simulator Initialized/.test(out) && failureLine === null && verdict !== "none";
  return {
    ran,
    passed: ran && productionLimits && exitCode === 0,
    binaryHash,
    configHash,
    verdict,
    productionLimits,
    exitCode,
    outputTail: lines.filter((l) => l.trim().length > 0).slice(-12),
    failure: failureLine ? failureLine.replace(/^✗\s*/, "") : exitCode !== 0 && exitCode !== null ? `the CLI exited with code ${exitCode}` : null,
  };
}

export async function runOfficialCreSimulation(deps: CreSimulationDeps = {}): Promise<CreSimulationResult> {
  const binary = deps.binary ?? defaultBinary();
  const cwd = deps.cwd ?? CRE_WORKFLOW_DIR;
  const now = deps.nowMs ?? Date.now;
  const override = deps.sepoliaRpcOverride ?? process.env.STUDIO_CRE_SEPOLIA_RPC;
  // The recorded command line names the override by its role, not its path or its contents.
  const commandLine = recordedCommandLine(binary, override !== undefined);
  const started = now();

  if (!creCliAvailable(binary)) {
    return {
      ran: false, passed: false, binaryHash: null, configHash: null, verdict: "none", productionLimits: false,
      exitCode: null, durationMs: 0, commandLine, triggerTxHash: CRE_TRIGGER.txHash, cliVersion: null, outputTail: [],
      failure: `the CRE CLI is not installed at ${binary}. Install it from Chainlink and run \`cre login\` on this machine; ContextLock never asks for the credential.`,
    };
  }

  const envFile = overriddenEnvFile(cwd, override);
  const args = creSimulateArgv(envFile?.path);

  const spawnFn = deps.spawnFn ?? spawn;
  // The CLI's own environment: PATH and HOME for its credential directory, nothing of the Studio's.
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

  const cliVersion = await new Promise<string | null>((resolve) => {
    let buf = "";
    const child = spawnFn(binary, ["version"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (d: Buffer) => { buf += d.toString(); });
    child.on("error", () => resolve(null));
    child.on("exit", () => resolve(/v?(\d+\.\d+\.\d+)/.exec(buf)?.[1] ?? null));
  });

  try {
    const { out, exitCode } = await new Promise<{ out: string; exitCode: number | null }>((resolve) => {
      let buf = "";
      const child = spawnFn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => { child.kill("SIGKILL"); buf += `\n✗ the simulation exceeded ${deps.timeoutMs ?? CRE_SIM_TIMEOUT_MS}ms and was stopped\n`; }, deps.timeoutMs ?? CRE_SIM_TIMEOUT_MS);
      child.stdout?.on("data", (d: Buffer) => { buf += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { buf += d.toString(); });
      child.on("error", (e) => { clearTimeout(timer); resolve({ out: `${buf}\n✗ ${e.message}\n`, exitCode: null }); });
      child.on("exit", (code) => { clearTimeout(timer); resolve({ out: buf, exitCode: code }); });
    });
    return { ...parseCreOutput(out, exitCode), durationMs: now() - started, commandLine, triggerTxHash: CRE_TRIGGER.txHash, cliVersion };
  } finally {
    if (envFile) rmSync(envFile.dir, { recursive: true, force: true });
  }
}

/* ───────────────────────────── persistence ───────────────────────────── */

export const LAB_RUN_KINDS = ["CRE_SIMULATION"] as const;
export type LabRunKind = (typeof LAB_RUN_KINDS)[number];

export interface LabRunRow {
  id: string;
  projectId: string;
  buildId: string | null;
  blueprintRevision: number | null;
  kind: LabRunKind;
  status: "RUNNING" | "PASSED" | "FAILED";
  result: unknown;
  startedAt: string;
  finishedAt: string | null;
}

export function beginLabRun(db: DB, args: { projectId: string; buildId: string | null; blueprintRevision: number | null; kind: LabRunKind }): string {
  const id = `run_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO studio_lab_runs (id, project_id, build_id, blueprint_revision, kind, status, result, started_at) VALUES (?, ?, ?, ?, ?, 'RUNNING', '{}', ?)`,
  ).run(id, args.projectId, args.buildId, args.blueprintRevision, args.kind, new Date().toISOString());
  return id;
}

export function finishLabRun(db: DB, id: string, status: "PASSED" | "FAILED", result: unknown): void {
  db.prepare(`UPDATE studio_lab_runs SET status = ?, result = ?, finished_at = ? WHERE id = ?`)
    .run(status, JSON.stringify(result), new Date().toISOString(), id);
}

const rowOf = (r: Record<string, unknown>): LabRunRow => ({
  id: r.id as string,
  projectId: r.project_id as string,
  buildId: (r.build_id as string | null) ?? null,
  blueprintRevision: (r.blueprint_revision as number | null) ?? null,
  kind: r.kind as LabRunKind,
  status: r.status as LabRunRow["status"],
  result: JSON.parse(r.result as string) as unknown,
  startedAt: r.started_at as string,
  finishedAt: (r.finished_at as string | null) ?? null,
});

export function latestLabRun(db: DB, projectId: string, kind: LabRunKind): LabRunRow | null {
  const r = db.prepare(`SELECT * FROM studio_lab_runs WHERE project_id = ? AND kind = ? ORDER BY started_at DESC LIMIT 1`).get(projectId, kind) as Record<string, unknown> | undefined;
  return r ? rowOf(r) : null;
}

export function listLabRuns(db: DB, projectId: string, kind: LabRunKind, limit = 20): LabRunRow[] {
  return (db.prepare(`SELECT * FROM studio_lab_runs WHERE project_id = ? AND kind = ? ORDER BY started_at DESC LIMIT ?`).all(projectId, kind, limit) as Record<string, unknown>[]).map(rowOf);
}

/** Runs left RUNNING by a process that died. Reconciled on start, like orphaned builds. */
export function reconcileOrphanedLabRuns(db: DB): string[] {
  const rows = db.prepare(`SELECT id FROM studio_lab_runs WHERE status = 'RUNNING'`).all() as Array<{ id: string }>;
  for (const r of rows) {
    finishLabRun(db, r.id, "FAILED", { failure: "the Studio server stopped while this run was in progress", ran: false, passed: false });
  }
  return rows.map((r) => r.id);
}
