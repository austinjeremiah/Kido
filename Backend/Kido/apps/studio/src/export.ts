import type { ContextLockAgentBlueprint, SecurityScore } from "@contextlock/studio-blueprint";
import type { SimulationResult } from "@contextlock/studio-simulation";
import type { DB } from "./db.js";
import { DEFAULT_QUOTA } from "./config.js";

/**
 * Export bundle.
 *
 * The security property here is negative: whatever else the bundle contains, it must not contain a
 * credential. Generated projects ship `.env.example` with names and empty values, and the export is
 * scanned before it is handed over — because "we were careful" is not something a user can verify
 * and a scan is.
 */

export interface ExportFile {
  path: string;
  content: string;
}

export class ExportTooLargeError extends Error {
  constructor(bytes: number, limit: number) {
    super(`export is ${bytes} bytes, limit is ${limit}`);
    this.name = "ExportTooLargeError";
  }
}

export class ExportContainsSecretError extends Error {
  constructor(readonly matches: string[]) {
    super(`export blocked: possible credential in ${matches.join(", ")}`);
    this.name = "ExportContainsSecretError";
  }
}

/**
 * Patterns that must never appear in an exported file.
 *
 * Deliberately shaped to match *assigned values*, not the variable names themselves — an
 * `.env.example` listing `SEPOLIA_RPC_URL=` is correct and must pass, while the same key with a
 * value after it must not. Getting this backwards produces a scanner that blocks every honest
 * export and trains its operator to bypass it.
 */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "hex private key", re: /\b0x[0-9a-fA-F]{64}\b/ },
  { name: "assigned private key", re: /(PRIVATE_KEY|SECRET|WALLET_PASS)\s*[=:]\s*["']?[^\s"'\n#]{8,}/ },
  { name: "OpenAI key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "seed phrase", re: /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b(?=[\s"']*(?:seed|mnemonic))/i },
  { name: "RPC url with embedded key", re: /https?:\/\/[^\s"']*\/(?:v2|v3)\/[A-Za-z0-9_-]{16,}/ },
];

export function scanExportForSecrets(files: ExportFile[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(f.content)) hits.push(`${f.path} (${p.name})`);
    }
  }
  return hits;
}

export function buildExport(args: {
  db: DB;
  buildId: string;
  blueprint: ContextLockAgentBlueprint;
  simulations: SimulationResult[];
  score: SecurityScore;
}): ExportFile[] {
  const { db, buildId, blueprint, simulations, score } = args;

  const artifacts = db
    .prepare(
      `SELECT path, content FROM studio_artifacts
       WHERE build_id = ? AND build_revision = (SELECT MAX(build_revision) FROM studio_artifacts WHERE build_id = ?)
       ORDER BY path`,
    )
    .all(buildId, buildId) as Array<{ path: string; content: string }>;

  const files: ExportFile[] = artifacts.map((a) => ({ path: a.path, content: a.content }));

  files.push({
    path: "contextlock/blueprint.json",
    content: JSON.stringify(blueprint, null, 2),
  });

  files.push({
    path: "contextlock/SIMULATION_REPORT.md",
    content: renderSimulationReport(blueprint, simulations),
  });

  files.push({
    path: "contextlock/SECURITY_REPORT.md",
    content: renderSecurityReport(blueprint, score),
  });

  const bytes = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  if (bytes > DEFAULT_QUOTA.exportBytes) throw new ExportTooLargeError(bytes, DEFAULT_QUOTA.exportBytes);

  const hits = scanExportForSecrets(files);
  if (hits.length > 0) throw new ExportContainsSecretError(hits);

  return files;
}

function renderSimulationReport(bp: ContextLockAgentBlueprint, sims: SimulationResult[]): string {
  const rows = sims
    .map(
      (s) =>
        `| ${s.scenarioId} | ${s.verdict} | ${s.outcome} | ${s.stoppedAt} | ${s.reasonCode} | ${s.passed ? "PASS" : "**FAIL**"} |`,
    )
    .join("\n");
  const trio = sims.filter((s) => s.scenarioId.startsWith("PRIVATE_CONTEXT"));
  return `# Simulation report

Blueprint \`${bp.blueprintId}\` revision ${bp.revision}, build revision ${sims[0]?.buildRevision ?? "—"}.

Every result below is bound to those two revisions. If either changes, these results are **stale**
and must not be read as evidence about the current design.

| Scenario | Verdict | Outcome | Stopped at | Reason | Result |
|---|---|---|---|---|---|
${rows}

**${sims.filter((s) => s.passed).length}/${sims.length} scenarios met their declared expectations.**

## The result worth reading

${
  trio.length === 3
    ? `The same transaction — same amount, same agent, same target, same policy version — produced
**${trio.map((t) => t.verdict).join(", ")}** depending only on confidential context the transaction
does not reveal.

| Scenario | Verdict | Reason code |
|---|---|---|
${trio.map((t) => `| ${t.scenarioId} | ${t.verdict} | ${t.reasonCode} |`).join("\n")}

The reason codes name a cause without disclosing the threshold that produced it.`
    : "The private-context scenarios did not all run, so this build does not demonstrate context-dependent verdicts."
}

## What these simulations are

Deterministic. The verdict comes from the same policy function compiled into the Chainlink
confidential workflow and imported by the ContextLock broker — not from a model, and not from a
separate reimplementation that could disagree with the real one.

They are **not** a live-network test. They do not prove the deployed contracts behave this way; they
prove this design, evaluated by the real policy function, produces these verdicts.
`;
}

function renderSecurityReport(bp: ContextLockAgentBlueprint, score: SecurityScore): string {
  return `# Security report

**${score.total}/${score.max} — ${score.band}**${score.criticalOutstanding > 0 ? `  \n**${score.criticalOutstanding} CRITICAL issue(s) outstanding.**` : ""}

This score is computed by deterministic code, not by a language model. Every point requires an
artifact that exists: a Blueprint field, a passing test, a passing simulation. A category with no
evidence scores zero even where the design is fine — "we believe it is safe" and "we demonstrated
it" should not produce the same number.

| Category | Score | Basis |
|---|---:|---|
${score.categories
  .map(
    (c) =>
      `| ${c.label} | ${c.points}/${c.max} | ${c.reasons.join("; ") || "no evidence"}${c.missing.length ? ` — **missing:** ${c.missing.join("; ")}` : ""} |`,
  )
  .join("\n")}

## Authority model

- Autonomous: ${bp.autonomousPolicy.maxValueUsdCents.known ? `up to $${(bp.autonomousPolicy.maxValueUsdCents.value / 100).toLocaleString()}` : "**UNRESOLVED**"}
- Human approval: ${bp.escalationPolicy.minValueUsdCents.known && bp.escalationPolicy.maxValueUsdCents.known ? `$${(bp.escalationPolicy.minValueUsdCents.value / 100).toLocaleString()}–$${(bp.escalationPolicy.maxValueUsdCents.value / 100).toLocaleString()}` : "**UNRESOLVED**"}
- Above that: DENY, with no path to execution.

## Denied

${bp.permissions.denied.map((p) => `- ${p.statement}`).join("\n")}

## Honest status

| | |
|---|---|
| Chainlink CRE | \`${bp.cre.mode}\` — not a live DON, not a TEE |
| Ledger hardware evidence | **None**${bp.ledger.blockerRef ? ` (${bp.ledger.blockerRef})` : ""} |
| Escalation mechanism | \`${bp.escalationPolicy.mechanism}\` |
| Audited | No |
| Network | Sepolia testnet only |

The ${score.categories.find((c) => c.id === "human-escalation")?.max ?? 10}-point human-escalation
category cannot reach full marks in this environment: three of its points require physical Ledger
evidence, which does not exist. That gap is deliberate and is not scored around.
`;
}
