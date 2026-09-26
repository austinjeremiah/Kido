/**
 * Group B integration demo, run headlessly end to end.
 *
 * Real gpt-5.6-luna, real Docker sandbox, real adapter decoders. The adapter scenarios are executed
 * against constructed provider responses — including hostile ones — so what is reported is what the
 * adapters actually did, not what they were expected to do.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { buildServer } from "../../apps/studio/src/api.js";
import { buildRegistry, resolveBlueprintAdapters } from "../../apps/studio/src/adapters.js";

const DB = "./studio-groupb.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) rmSync(f);

const PROMPT = process.argv.slice(2).join(" ") ||
  "Build a treasury rebalancing agent. Use verified Chainlink price data for ETH/USD. " +
  "Use The Graph for historical portfolio activity. If ETH allocation falls below 40%, swap up to " +
  "500 USDC into ETH through Uniswap. Anything over $2,000 must escalate. Never send assets to an " +
  "external recipient. If verified price data is stale, do nothing.";

const rule = (s: string) => console.log(`\n\x1b[1m── ${s} ──\x1b[0m`);
const t0 = Date.now();

rule("REGISTERED ADAPTERS");
const registry = buildRegistry();
for (const m of registry.list()) {
  console.log(
    `  ${(m.id + "@" + m.version).padEnd(36)} ${m.adapterType.padEnd(22)} ${m.trustClass.padEnd(30)} chains ${m.supportedChains.join(",")}`,
  );
}

rule("DETERMINISTIC RESOLUTION");
const requirements = [
  { key: "ethUsd", kind: "eth_usd_price", chainId: 11155111, minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 30_000, confidential: false, historical: false },
  { key: "positionHealth", kind: "aave_position_health_factor", chainId: 11155111, minimumTrustClass: "DIRECT_CHAIN_DATA", maxAgeMs: 60_000, confidential: false, historical: false },
];
const report = resolveBlueprintAdapters(registry, { dataRequirements: requirements } as never);
for (const b of report.bindings) console.log(`  ${b.configRef.padEnd(18)} -> ${b.adapterId}@${b.adapterVersion}\n     ${b.rationale}`);
for (const u of report.unresolved) {
  console.log(`  ${u.key.padEnd(18)} -> \x1b[31mNO_COMPATIBLE_ADAPTER\x1b[0m (${u.minimumTrustClass}, <=${u.maxAgeMs}ms)`);
  for (const r of u.rejected) console.log(`        rejected ${r.ref}: ${r.reason}`);
}

rule("TRUST ENFORCEMENT: an indexer cannot satisfy a verified-oracle requirement");
const downgrade = resolveBlueprintAdapters(registry, {
  dataRequirements: [{ key: "ethUsd", kind: "aave_position_health_factor", chainId: 11155111, minimumTrustClass: "VERIFIED_ORACLE", maxAgeMs: 30_000, confidential: false, historical: false }],
} as never);
console.log(`  bindings: ${downgrade.bindings.length}  unresolved: ${downgrade.unresolved.length}`);
for (const r of downgrade.unresolved[0]?.rejected ?? []) console.log(`    rejected ${r.ref}: ${r.reason}`);

rule("STUDIO BUILD  (real gpt-5.6-luna)");
console.log(PROMPT);
const { app, pipeline, quota, bus, db } = buildServer({});
const created = await app.inject({
  method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "group-b" },
  payload: { prompt: PROMPT, idempotencyKey: `gb-${Date.now()}` },
});
const id = created.json().id;
const design = await pipeline.runToApproval(id);
const bp = design.blueprint;

console.log(`\nblueprint revision ${bp.revision}`);
console.log(`  adapters bound: ${bp.adapters.length}`);
for (const b of bp.adapters) console.log(`     ${b.role.padEnd(22)} ${b.adapterId}@${b.adapterVersion}  -> ${b.configRef}`);
console.log(`  data requirements: ${bp.dataRequirements.map((r) => `${r.key}(${r.minimumTrustClass})`).join(", ")}`);
console.log(`  scenarios: ${bp.simulationScenarios.length}`);

const g = (await app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json().graph;
console.log(`\ngraph: ${g.nodes.length} nodes, ${g.edges.length} edges`);
for (const n of g.nodes.filter((x: { kind: string }) => x.kind === "Adapter")) {
  console.log(`   ADAPTER ${n.label}`);
  for (const d of n.detail) console.log(`       ${d.label}: ${d.value}`);
}

const criticals = design.issues.filter((i) => i.severity === "CRITICAL");
console.log(`\nvalidation: ${design.issues.length} issue(s), ${criticals.length} CRITICAL`);
for (const i of design.issues.slice(0, 8)) console.log(`   ${i.severity.padEnd(9)} ${i.code} ${i.message.slice(0, 110)}`);

const unknowns = JSON.stringify(bp).match(/"known":false[^}]*}/g) ?? [];
console.log(`\nunknowns: ${unknowns.length}`);
for (const u of unknowns.slice(0, 6)) console.log(`   ${u.slice(0, 150)}`);

if (pipeline.get(id)!.stage !== "AWAITING_APPROVAL") {
  console.log(`\nstopped at ${pipeline.get(id)!.stage} — ${pipeline.get(id)!.status}`);
  await app.close();
  process.exit(1);
}

rule("APPROVE + BUILD");
pipeline.approve(id, criticals.filter((c) => c.code.startsWith("SEC-")).map((c) => c.code));
const built = await pipeline.runBuild(id);
console.log(`files: ${built.files.length}`);
for (const f of built.files.filter((x) => x.includes("adapters"))) console.log(`   ${f}`);

rule("SIMULATIONS");
for (const s of built.simulations) {
  console.log(`   ${s.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${s.scenarioId.padEnd(28)} ${s.outcome.padEnd(18)} stop=${String(s.stoppedAt).padEnd(10)} ${s.reasonCode}`);
}
console.log(`\n${built.simulations.filter((s) => s.passed).length}/${built.simulations.length} passed`);

rule("ADAPTER ATTACK RESULTS (executed, not asserted)");
for (const s of built.simulations.filter((x) => /^(UNI|REF)-/.test(x.scenarioId))) {
  console.log(`   ${s.scenarioId.padEnd(30)} ${s.outcome.padEnd(10)} ${s.reasonCode}`);
}

const view = (await app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json();
rule("FINAL");
console.log(`stage=${view.build.stage}  status=${view.build.status}`);
console.log(`score ${view.score.total}/${view.score.max} ${view.score.band}`);
const u = quota.snapshot(id);
console.log(`usage: ${u.requests} calls, ${u.inputTokens} in / ${u.outputTokens} out, ~$${u.estimatedCostUsd?.toFixed(4)}`);
console.log(`simulations: ${u.userSimulations} user (charged) + ${u.mandatorySimulations} security (not charged)`);
console.log(`events: ${bus.history(id).length}  elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);

mkdirSync("reports/group-b/evidence", { recursive: true });
writeFileSync("reports/group-b/evidence/group-b-usage.json", JSON.stringify({
  adapters: registry.list().map((m) => ({ id: m.id, version: m.version, type: m.adapterType, trust: m.trustClass, chains: m.supportedChains })),
  bound: bp.adapters, usage: u, score: view.score,
  simulations: built.simulations.map((s) => ({ id: s.scenarioId, outcome: s.outcome, stoppedAt: s.stoppedAt, reason: s.reasonCode, passed: s.passed })),
  elapsedMs: Date.now() - t0,
}, null, 2));

console.log(`\n${built.ok ? "\x1b[32mBUILD PASS\x1b[0m" : "\x1b[31mBUILD DID NOT REACH EXPORT_READY\x1b[0m"}`);
void db;
await app.close();
process.exit(built.ok ? 0 : 1);
