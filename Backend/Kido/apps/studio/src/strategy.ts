import {
  compileStrategy,
  generateStrategyScenarios,
  STRATEGY_IR_VERSION,
  type CompileResult,
  type Strategy,
  type Unit,
} from "@contextlock/studio-strategy";
import type { StrategyProposal } from "./agents/roles.js";

/**
 * Turn the model's proposal into a Strategy IR, then compile it.
 *
 * The proposal is a flatter, easier-to-emit shape; this is the only place it becomes the IR, and it
 * is a pure translation — no defaults are supplied, nothing is inferred. A null limit stays null and
 * surfaces as an unknown, because the one thing the model must not do is fill in a financial
 * boundary the user never stated.
 */

const toUnit = (kind: string, decimals: number, subject: string | null): Unit =>
  subject === null ? ({ kind, decimals } as Unit) : ({ kind, decimals, subject } as Unit);

export function proposalToStrategy(p: StrategyProposal, revision: number): Strategy {
  return {
    schemaVersion: STRATEGY_IR_VERSION,
    planId: p.planId,
    revision,
    triggers: p.triggers.length > 0 ? p.triggers : [{ id: "manual", kind: "manual", description: "Manually triggered." }],
    inputs: p.inputs.map((i) => ({
      id: i.id,
      requirementKey: i.requirementKey,
      dataKind: i.dataKind,
      unit: toUnit(i.unitKind, i.unitDecimals, i.unitSubject),
      minimumTrustClass: i.minimumTrustClass,
      maxAgeMs: i.maxAgeMs,
      description: i.description,
    })),
    transforms: p.transforms.map((t) => ({
      id: t.id,
      op: t.op,
      inputs: t.inputs,
      ...(t.toDecimals !== null ? { toDecimals: t.toDecimals } : {}),
      description: t.description,
    })),
    decisions: p.decisions.map((d) => ({
      id: d.id,
      when: {
        type: "compare" as const,
        op: d.compareOp,
        left: d.left.type === "ref" ? { type: "ref" as const, id: d.left.id } : { type: "literal" as const, value: d.left.value, unit: toUnit(d.left.unitKind, d.left.unitDecimals, d.left.unitSubject) },
        right: d.right.type === "ref" ? { type: "ref" as const, id: d.right.id } : { type: "literal" as const, value: d.right.value, unit: toUnit(d.right.unitKind, d.right.unitDecimals, d.right.unitSubject) },
      },
      actionRef: d.actionRef,
      autonomousMaxUsdCents: d.autonomousMaxUsdCents,
      escalationMaxUsdCents: d.escalationMaxUsdCents,
      // Not a field the model can set. Above the ceiling the answer is DENY, always.
      aboveCeiling: "DENY" as const,
      description: d.description,
    })),
    actions: p.actions.map((a) => ({
      id: a.id,
      capability: a.capability,
      actionKind: a.actionKind,
      ...(a.spendsAsset !== null ? { spendsAsset: a.spendsAsset } : {}),
      recipientPolicy: a.recipientPolicy,
      description: a.description,
    })),
    unknowns: p.unknowns,
    invariants: [],
    // The model says whether a multi-step plan is needed; the capability marker is ours.
    requiresCapability: p.needsMultiStepPlan ? ["REQUIRES_P19_CAPABILITY"] : [],
  };
}

export interface CompiledStrategy {
  strategy: Strategy;
  compiled: CompileResult;
  scenarios: ReturnType<typeof generateStrategyScenarios>;
}

export function compileProposal(p: StrategyProposal, revision: number): CompiledStrategy {
  const strategy = proposalToStrategy(p, revision);
  const compiled = compileStrategy(strategy);
  return { strategy, compiled, scenarios: generateStrategyScenarios(strategy, compiled) };
}

/**
 * Data requirements the strategy needs, for the generic adapter resolver.
 *
 * The strategy states WHAT it needs; the registry decides WHO provides it. No provider is named
 * anywhere on this path.
 */
export function strategyDataRequirements(s: Strategy): Array<{
  key: string;
  kind: string;
  chainId: 11155111;
  minimumTrustClass: string;
  maxAgeMs: number;
  confidential: boolean;
  historical: boolean;
}> {
  const seen = new Set<string>();
  const out: ReturnType<typeof strategyDataRequirements> = [];
  for (const i of s.inputs) {
    if (seen.has(i.requirementKey)) continue;
    seen.add(i.requirementKey);
    out.push({
      key: i.requirementKey,
      kind: i.dataKind,
      chainId: 11155111,
      minimumTrustClass: i.minimumTrustClass,
      maxAgeMs: i.maxAgeMs,
      confidential: false,
      historical: i.maxAgeMs > 600_000,
    });
  }
  return out;
}

export function strategyExecutionCapabilities(s: Strategy): string[] {
  return [...new Set(s.actions.map((a) => a.capability))];
}
