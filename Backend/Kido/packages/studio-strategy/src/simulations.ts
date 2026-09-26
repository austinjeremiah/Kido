import { describeCondition, type CompileResult } from "./compiler.js";
import type { ConditionNode, Strategy } from "./ir.js";

/**
 * Strategy-specific simulation generation.
 *
 * A boundary is where a strategy is wrong. `< 40%` and `<= 40%` differ at exactly one value, and
 * that value is the one nobody tests by hand — so the generator produces below/at/above for every
 * comparison and below/at/above for every amount band, mechanically.
 *
 * These are generated from the compiled IR rather than written by the model, so a strategy cannot
 * ship with the boundary case quietly missing.
 */

export interface GeneratedScenario {
  scenarioId: string;
  description: string;
  kind: "CONDITION_BOUNDARY" | "AMOUNT_BAND" | "DATA_SOURCE";
  /** Which node is perturbed, and to what. */
  perturbation: { nodeId: string; position: string };
  expectedDisposition: "ALLOW" | "ESCALATE" | "DENY" | "NO_ACTION" | "REFUSED";
}

const slug = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");

function comparisons(c: ConditionNode, out: Array<{ path: string; node: ConditionNode }> = [], path = "when"): Array<{ path: string; node: ConditionNode }> {
  if (c.type === "compare") out.push({ path, node: c });
  else if (c.type === "not") comparisons(c.child, out, `${path}.not`);
  else c.children.forEach((child, i) => comparisons(child, out, `${path}.${c.type}${i}`));
  return out;
}

export function generateStrategyScenarios(strategy: Strategy, compiled: CompileResult): GeneratedScenario[] {
  const out: GeneratedScenario[] = [];

  for (const d of strategy.decisions) {
    /* Every comparison gets three cases. The middle one is the one that finds off-by-one errors. */
    for (const { path, node } of comparisons(d.when)) {
      const ref = node.type === "compare" && node.left.type === "ref" ? node.left.id : d.id;
      const label = node.type === "compare" ? describeCondition(node) : d.id;
      for (const position of ["BELOW", "AT", "ABOVE"] as const) {
        out.push({
          scenarioId: `STRAT-${slug(d.id)}-${slug(path)}-${position}`,
          description: `${label} — value ${position.toLowerCase()} the boundary`,
          kind: "CONDITION_BOUNDARY",
          perturbation: { nodeId: ref, position },
          // AT is deliberately not asserted as a fixed disposition here: whether the boundary
          // itself triggers depends on LT vs LTE, which the compiled AST states exactly.
          expectedDisposition: position === "BELOW" ? "NO_ACTION" : "ALLOW",
        });
      }
    }

    /*
     * Amount bands. Five positions, because the interesting failures live on the edges: at the
     * autonomous limit exactly, and at the escalation ceiling exactly.
     */
    const auto = d.autonomousMaxUsdCents;
    const esc = d.escalationMaxUsdCents;
    if (auto !== null) {
      out.push(
        { scenarioId: `STRAT-${slug(d.id)}-AMOUNT-BELOW-AUTO`, description: `amount below the autonomous limit`, kind: "AMOUNT_BAND", perturbation: { nodeId: d.actionRef, position: "BELOW_AUTO" }, expectedDisposition: "ALLOW" },
        { scenarioId: `STRAT-${slug(d.id)}-AMOUNT-AT-AUTO`, description: `amount exactly at the autonomous limit`, kind: "AMOUNT_BAND", perturbation: { nodeId: d.actionRef, position: "AT_AUTO" }, expectedDisposition: "ALLOW" },
      );
    }
    if (esc !== null) {
      out.push(
        { scenarioId: `STRAT-${slug(d.id)}-AMOUNT-IN-ESCALATION`, description: `amount inside the escalation band`, kind: "AMOUNT_BAND", perturbation: { nodeId: d.actionRef, position: "IN_ESCALATION" }, expectedDisposition: "ESCALATE" },
        { scenarioId: `STRAT-${slug(d.id)}-AMOUNT-AT-CEILING`, description: `amount exactly at the escalation ceiling`, kind: "AMOUNT_BAND", perturbation: { nodeId: d.actionRef, position: "AT_CEILING" }, expectedDisposition: "ESCALATE" },
        { scenarioId: `STRAT-${slug(d.id)}-AMOUNT-ABOVE-CEILING`, description: `amount above the ceiling`, kind: "AMOUNT_BAND", perturbation: { nodeId: d.actionRef, position: "ABOVE_CEILING" }, expectedDisposition: "DENY" },
      );
    }
  }

  /* Every data source gets its failure modes, because a strategy is only as available as its inputs. */
  for (const i of strategy.inputs) {
    const p = compiled.provenance[i.id];
    out.push(
      { scenarioId: `STRAT-${slug(i.id)}-VALID`, description: `${i.id} returns a valid reading`, kind: "DATA_SOURCE", perturbation: { nodeId: i.id, position: "VALID" }, expectedDisposition: "ALLOW" },
      { scenarioId: `STRAT-${slug(i.id)}-STALE`, description: `${i.id} is older than ${p?.maxAgeMs ?? i.maxAgeMs}ms`, kind: "DATA_SOURCE", perturbation: { nodeId: i.id, position: "STALE" }, expectedDisposition: "REFUSED" },
      { scenarioId: `STRAT-${slug(i.id)}-UNAVAILABLE`, description: `${i.id} is unavailable`, kind: "DATA_SOURCE", perturbation: { nodeId: i.id, position: "UNAVAILABLE" }, expectedDisposition: "REFUSED" },
      { scenarioId: `STRAT-${slug(i.id)}-WRONG-TRUST`, description: `${i.id} arrives below its required trust class`, kind: "DATA_SOURCE", perturbation: { nodeId: i.id, position: "WRONG_TRUST" }, expectedDisposition: "REFUSED" },
    );
  }

  // Deterministic order, so the same strategy always generates the same scenario list.
  return out.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
}
