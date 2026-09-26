/**
 * Run the P28.42 market shocks against the real P27 mainnet snapshot and record the comparison.
 *
 * Everything here is derived. The price is the Chainlink ETH/USD reading sealed at mainnet block
 * 25948178; the shocks are overlays applied to a copy of it; the verdicts come from the same policy
 * engine the CRE workflow runs. Nothing is asserted about a market that was not read.
 *
 * The interesting result is that a fixed-size action moves ACROSS a limit when the price moves —
 * 0.5 WETH is a different amount of money at $2,438 than at $1,707 — which is the whole reason the
 * comparison exists.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { keccak256, toHex } from "viem";
import { MarketSnapshotSchema } from "../packages/studio-reality/src/index.js";
import {
  SHOCK_PRESETS, shockPresets, runShock, decideOnSnapshot, compareScenarios, assertSyntheticLabelled,
} from "../packages/studio-lab/src/scenario-lab.js";
import { policyFromBlueprint } from "../packages/studio-lab/src/attack-runner.js";
import type { ContextLockAgentBlueprint } from "../packages/studio-blueprint/src/schema.js";

const snapshot = MarketSnapshotSchema.parse(JSON.parse(readFileSync("reports/phase-27/evidence/p27-market-snapshot.json", "utf8")));
const bp = JSON.parse(readFileSync("reports/phase-28/evidence/p28-blueprint.json", "utf8")) as ContextLockAgentBlueprint;
const policy = policyFromBlueprint(bp);

const common = {
  policy,
  priceMetric: "weth/usd:price",
  amount: 500_000_000_000_000_000n,
  amountDecimals: 18,
  amountLabel: "repay 0.5 WETH of Aave debt",
  actionKind: bp.actions[0]?.kind ?? "AAVE_REPAY",
  agentIdentityHash: keccak256(toHex(bp.identity.agentId)),
  target: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
  recipient: "0x93e0FCb0F71e83F3340264339BC5983C474635c5",
  nowMs: snapshot.observedAtMs,
  maxSnapshotAgeMs: 5_400_000,
};

const presets = shockPresets(snapshot);
console.log(`base snapshot ${snapshot.snapshotId} @ mainnet block ${snapshot.anchorBlock}`);
console.log(`policy: autonomous ≤ $${Number(policy.autoLimit) / 1e6}, escalation ≤ $${Number(policy.escalationLimit) / 1e6}\n`);
console.log("PRESETS");
for (const p of presets) console.log(`  ${p.applicable ? "AVAILABLE  " : "UNAVAILABLE"} ${p.name}${p.unavailableReason ? ` — ${p.unavailableReason}` : ""}`);

const base = decideOnSnapshot({ snapshot, ...common });
console.log(`\nBASE  ${base.verdict.padEnd(9)} ${base.reasonCode.padEnd(24)} ${base.valuedAt ?? "—"}  (${base.layer})`);

const runs = [];
for (const preset of SHOCK_PRESETS) {
  if (!presets.find((v) => v.overlayId === preset.overlayId)?.applicable) continue;
  const result = runShock(snapshot, preset, { snapshotId: `scn-${preset.overlayId}` });
  const decision = decideOnSnapshot({ snapshot: result.snapshot, ...common });
  console.log(`      ${decision.verdict.padEnd(9)} ${decision.reasonCode.padEnd(24)} ${decision.valuedAt ?? "—"}  (${decision.layer})  ${preset.name}`);
  runs.push({ overlay: preset, result, decision });
}

const rows = compareScenarios({ decision: base, snapshotHash: snapshot.snapshotHash }, runs);
assertSyntheticLabelled(rows, "p28 scenario compare");

writeFileSync(
  "reports/phase-28/evidence/p28-scenarios.json",
  JSON.stringify({
    baseSnapshotId: snapshot.snapshotId,
    baseSnapshotHash: snapshot.snapshotHash,
    anchorChainId: snapshot.anchorChainId,
    anchorBlock: snapshot.anchorBlock,
    action: common.amountLabel,
    policy: { autonomousUsd: Number(policy.autoLimit) / 1e6, escalationUsd: Number(policy.escalationLimit) / 1e6 },
    presets,
    basis: base.basis,
    rows,
  }, null, 2) + "\n",
);
console.log(`\nwrote reports/phase-28/evidence/p28-scenarios.json — ${rows.length} rows`);
