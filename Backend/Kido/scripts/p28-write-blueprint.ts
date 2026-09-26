/**
 * Record the Blueprint the P28 canonical journey uses.
 *
 * The document itself lives in `scripts/lib/p28-blueprint.ts`, because the demo builds the same one
 * and two definitions drifted apart once already. This script validates it and writes it down.
 */
import { writeFileSync } from "node:fs";
import { validateBlueprint } from "../packages/studio-blueprint/src/validator.js";
import { canonicalP28Blueprint } from "./lib/p28-blueprint.js";

const bp = canonicalP28Blueprint();

const result = validateBlueprint(bp);
const blocking = result.issues.filter((i) => i.severity === "CRITICAL" || i.severity === "HIGH");
if (blocking.length > 0) {
  console.error("Blueprint does not validate:");
  for (const i of blocking) console.error(`  ${i.severity} ${i.code} ${i.path}: ${i.message}`);
  process.exit(1);
}

writeFileSync("reports/phase-28/evidence/p28-blueprint.json", JSON.stringify(bp, null, 2) + "\n");
console.log(
  `wrote p28-blueprint.json — revision ${bp.revision}, ${bp.actions.length} actions, ` +
  `${bp.permissions.denied.length} denials, ${bp.perActionLimits.length} per-action tightening(s)`,
);
console.log(`  global      autonomous $1,000 · approval $1,000–$5,000 · deny > $5,000`);
console.log(`  rebalancing autonomous   $500 · approval   $500–$2,000 · deny > $2,000  (tightened)`);
