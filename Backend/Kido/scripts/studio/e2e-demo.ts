/**
 * The canonical Phase 11 demo, run headlessly end to end.
 *
 * Real gpt-5.6-luna, real Docker sandbox, real generated files, real compilation. Nothing here is
 * mocked; if the model or the sandbox is unavailable this script fails rather than substituting a
 * fixture, because a demo that can pass without its dependencies proves nothing about them.
 */
import { rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { buildServer } from "../../apps/studio/src/api.js";
import { projectGraph, computeSecurityScore, validateBlueprint } from "@contextlock/studio-blueprint";

const DB = "./studio-e2e.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) rmSync(f);
process.env.STUDIO_DB_URL = `file:${DB}`;

const PROMPT =
  "I want an Aave agent that protects me from liquidation. Keep my health factor above 1.6. " +
  "Repay up to $1,000 automatically. $1,000–$5,000 requires Ledger. Never withdraw collateral.";

const t0 = Date.now();
const { app, pipeline, quota, bus, db } = buildServer({ db: undefined });

const log = (s: string) => console.log(s);
const rule = (s: string) => console.log(`\n\x1b[1m── ${s} ──\x1b[0m`);

rule("SCENE 1  user prompt");
log(PROMPT);

const res = await app.inject({
  method: "POST",
  url: "/api/studio/builds",
  headers: { "x-studio-user": "demo-user" },
  payload: { prompt: PROMPT, name: "Aave Liquidation Guardian", idempotencyKey: "demo-1" },
});
const build = res.json();
log(`\nbuild ${build.id}  stage=${build.stage}  status=${build.status}`);

// STUDIO-028: the same idempotency key must not consume a second build credit.
const dup = await app.inject({
  method: "POST",
  url: "/api/studio/builds",
  headers: { "x-studio-user": "demo-user" },
  payload: { prompt: PROMPT, idempotencyKey: "demo-1" },
});
log(`duplicate request → HTTP ${dup.statusCode}, build ${dup.json().id} (${dup.json().id === build.id ? "same build, no extra credit" : "DIFFERENT — BUG"})`);

rule("SCENE 2-3  requirements → blueprint → security review  (real gpt-5.6-luna)");
const designed = await pipeline.runToApproval(build.id);
const bp = designed.blueprint;
log(`blueprint revision ${bp.revision}`);
log(`  objective        ${bp.objective}`);
log(`  autonomous       ${bp.autonomousPolicy.maxValueUsdCents.known ? "$" + (bp.autonomousPolicy.maxValueUsdCents.value / 100).toLocaleString() + `  (quoted: "${bp.autonomousPolicy.maxValueUsdCents.sourceQuote}")` : "UNKNOWN — " + (bp.autonomousPolicy.maxValueUsdCents as any).reason}`);
log(`  escalation       ${bp.escalationPolicy.minValueUsdCents.known && bp.escalationPolicy.maxValueUsdCents.known ? `$${(bp.escalationPolicy.minValueUsdCents.value/100).toLocaleString()}–$${(bp.escalationPolicy.maxValueUsdCents.value/100).toLocaleString()}` : "UNKNOWN"}`);
log(`  mechanism        ${bp.escalationPolicy.mechanism}`);
log(`  denied:`);
for (const d of bp.permissions.denied) log(`     - ${d.statement}`);
log(`  confidential parameter names (values never present): ${bp.confidentialPolicy.parameterNames.join(", ")}`);

const g = projectGraph(bp);
log(`\ngraph: ${g.nodes.length} nodes, ${g.edges.length} edges (deterministic layout)`);
for (const n of g.nodes) log(`   ${n.rank}  ${n.kind.padEnd(22)} ${n.label}${n.sublabel ? `  [${n.sublabel}]` : ""}`);

log(`\nvalidation: ${designed.issues.length} issue(s)`);
for (const i of designed.issues) log(`   ${i.severity.padEnd(8)} ${i.code} ${i.path}: ${i.message.slice(0, 100)}`);

const afterDesign = pipeline.get(build.id)!;
log(`\nstage=${afterDesign.stage}  status=${afterDesign.status}`);
if (afterDesign.stage !== "AWAITING_APPROVAL") {
  log("\nBuild stopped before the approval boundary — inspect the issues above.");
  process.exit(1);
}
log("STOPPED at the approval boundary. No sandbox created, no code generated yet.");

rule("SCENE 4  user approves");
const usageBefore = quota.snapshot(build.id);
log(`estimated usage so far: ${usageBefore.requests} requests, ${usageBefore.inputTokens} in / ${usageBefore.outputTokens} out tokens, est $${usageBefore.estimatedCostUsd?.toFixed(4)}`);
/*
 * A CRITICAL raised by the advisory security review must be acknowledged by code before the build
 * may proceed. It does not silently block (a model opinion is not a gate) and it does not silently
 * pass. Here the demo acknowledges them explicitly, which is what a user clicking through the
 * review panel would be doing.
 */
const modelCriticals = designed.issues.filter((i) => i.severity === "CRITICAL" && i.code.startsWith("SEC-"));
if (modelCriticals.length > 0) {
  log(`security review raised ${modelCriticals.length} CRITICAL finding(s) that must be acknowledged:`);
  for (const c of modelCriticals) log(`   ${c.code}  ${c.message.slice(0, 140)}`);
  try {
    pipeline.approve(build.id);
    log("   BUG: approval succeeded without acknowledgement");
  } catch (e) {
    log(`   approval correctly refused: ${(e as Error).message.slice(0, 120)}`);
  }
}
pipeline.approve(build.id, modelCriticals.map((c) => c.code));
log("BUILD THIS AGENT → approved");

rule("SCENE 5-7  sandbox build, tests, simulations");
const built = await pipeline.runBuild(build.id);
log(`generated ${built.files.length} files:`);
for (const f of built.files) log(`   ${f}`);

rule("SCENE 8-9  simulations");
for (const s of built.simulations) {
  log(`   ${s.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${s.scenarioId.padEnd(26)} ${String(s.verdict).padEnd(11)} ${s.outcome.padEnd(18)} stop=${s.stoppedAt.padEnd(10)} ${s.reasonCode}`);
}
const trio = built.simulations.filter((s) => s.scenarioId.startsWith("PRIVATE_CONTEXT"));
log(`\nsame transaction, different confidential context:`);
for (const t of trio) log(`   ${t.scenarioId.padEnd(28)} → ${t.verdict}  (${t.reasonCode})`);

rule("SCENE 10-11  final state");
const full = await app.inject({ method: "GET", url: `/api/studio/builds/${build.id}` });
const view = full.json();
log(`stage=${view.build.stage}  status=${view.build.status}`);
log(`tests: ${JSON.stringify(view.tests)}`);
log(`security score: ${view.score.total}/${view.score.max}  band=${view.score.band}  critical=${view.score.criticalOutstanding}`);
for (const c of view.score.categories) log(`   ${String(c.points).padStart(2)}/${c.max}  ${c.label}${c.missing.length ? "   missing: " + c.missing.join("; ") : ""}`);
log(`stale simulations: ${view.staleSimulations}   code stale: ${view.codeStale}`);

rule("SCENE 12  export");
const exp = await app.inject({ method: "GET", url: `/api/studio/builds/${build.id}/export` });
if (exp.statusCode === 200) {
  const e = exp.json();
  log(`export: ${e.files.length} files, ${e.totalBytes} bytes, no secrets found`);
  for (const f of e.files) log(`   ${f.path}`);
} else {
  log(`export refused ${exp.statusCode}: ${JSON.stringify(exp.json())}`);
}

rule("actual model usage (OpenAI Agents SDK accounting)");
const u = quota.snapshot(build.id);
log(`requests      ${u.requests} / ${u.limits.modelRequestsPerBuild}`);
log(`input tokens  ${u.inputTokens.toLocaleString()} / ${u.limits.inputTokensPerBuild.toLocaleString()}`);
log(`output tokens ${u.outputTokens.toLocaleString()} / ${u.limits.outputTokensPerBuild.toLocaleString()}`);
log(`simulations   ${u.simulations} / ${u.limits.simulationsPerBuild}`);
log(`files         ${u.generatedFiles} / ${u.limits.generatedFiles}`);
log(`estimated cost  $${u.estimatedCostUsd?.toFixed(4)} (estimate, not a bill)`);
log(`peak budget use ${(u.peakFraction * 100).toFixed(1)}%`);

const perRole = db.prepare(`SELECT role, SUM(requests) r, SUM(input_tokens) i, SUM(output_tokens) o FROM studio_usage GROUP BY role`).all();
log(`per role: ${JSON.stringify(perRole)}`);

log(`\nevents persisted: ${bus.history(build.id).length}`);
log(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

mkdirSync("reports/phase-11/evidence", { recursive: true });
writeFileSync(
  "reports/phase-11/evidence/p11-e2e-usage.json",
  JSON.stringify({ usage: u, perRole, events: bus.history(build.id).length, elapsedMs: Date.now() - t0, score: view.score }, null, 2),
);

log(`\n${built.ok ? "\x1b[32mBUILD PASS\x1b[0m" : "\x1b[31mBUILD DID NOT REACH EXPORT_READY\x1b[0m"}`);
await app.close();
process.exit(built.ok ? 0 : 1);
