import { z } from "zod";
import { DataTrustClassSchema } from "@contextlock/studio-adapters";
import { UnitSchema } from "./units.js";

export const STRATEGY_IR_VERSION = "contextlock.strategy/v1" as const;

/**
 * The Strategy IR.
 *
 * Sits between the Blueprint and the generated runtime. Luna proposes one; deterministic code
 * validates it and nothing else ever executes.
 *
 * The load-bearing decision is that a condition is an AST, not an expression string. A string would
 * eventually be evaluated, and evaluating model-generated code to decide whether money moves is the
 * single worst thing this system could do. An AST of a closed set of node types can be inspected,
 * type-checked, unit-checked and rendered — and cannot express anything the compiler does not
 * already understand.
 */

const id = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/, "lowercase kebab id");

/* ─────────────────────────────── inputs ───────────────────────────────────── */

export const StrategyInputSchema = z.object({
  id,
  /** Blueprint data-requirement key this input reads. */
  requirementKey: z.string(),
  dataKind: z.string(),
  unit: UnitSchema,
  minimumTrustClass: DataTrustClassSchema,
  maxAgeMs: z.number().int().positive(),
  description: z.string(),
});
export type StrategyInput = z.infer<typeof StrategyInputSchema>;

/* ───────────────────────────── transforms ─────────────────────────────────── */

/**
 * A closed set of transforms.
 *
 * Deliberately small. Every one has known unit semantics and known trust/freshness propagation, so
 * a derived value's provenance is computable rather than asserted. Adding a transform means
 * deciding both, which is the point.
 */
export const TransformSchema = z.object({
  id,
  op: z.enum(["TOKEN_TO_USD", "RATIO_TO_BPS", "SUM", "DIFFERENCE", "PERCENT_TO_BPS", "RESCALE"]),
  inputs: z.array(z.string()).min(1),
  /** Required for RESCALE; ignored otherwise. */
  toDecimals: z.number().int().min(0).max(36).optional(),
  description: z.string(),
});
export type Transform = z.infer<typeof TransformSchema>;

/* ───────────────────────────── conditions ─────────────────────────────────── */

/**
 * Condition AST.
 *
 * `ref` names an input or a transform. `literal` carries its own unit, so a threshold cannot be a
 * bare number whose scale nobody wrote down.
 */
export type ConditionNode =
  | { type: "compare"; op: "LT" | "LTE" | "GT" | "GTE" | "EQ" | "NEQ"; left: OperandNode; right: OperandNode }
  | { type: "and"; children: ConditionNode[] }
  | { type: "or"; children: ConditionNode[] }
  | { type: "not"; child: ConditionNode };

export type OperandNode =
  | { type: "ref"; id: string }
  | { type: "literal"; value: string; unit: z.infer<typeof UnitSchema> };

export const OperandSchema: z.ZodType<OperandNode> = z.union([
  z.object({ type: z.literal("ref"), id: z.string() }),
  z.object({ type: z.literal("literal"), value: z.string().regex(/^\d+$/, "integer base units"), unit: UnitSchema }),
]);

export const ConditionSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal("compare"),
      op: z.enum(["LT", "LTE", "GT", "GTE", "EQ", "NEQ"]),
      left: OperandSchema,
      right: OperandSchema,
    }),
    z.object({ type: z.literal("and"), children: z.array(ConditionSchema).min(2) }),
    z.object({ type: z.literal("or"), children: z.array(ConditionSchema).min(2) }),
    z.object({ type: z.literal("not"), child: ConditionSchema }),
  ]),
);

/* ───────────────────────────── decisions ──────────────────────────────────── */

/**
 * A decision maps a condition to a policy disposition.
 *
 * Every branch has a disposition — there is no "condition true, therefore execute". Money moving is
 * always a decision ContextLock made, never a consequence of a boolean.
 */
export const DecisionSchema = z.object({
  id,
  when: ConditionSchema,
  /** The action this decision may authorize. */
  actionRef: z.string(),
  /** Amount bands, in USD cents, that route to each disposition. */
  autonomousMaxUsdCents: z.number().int().nonnegative().nullable(),
  escalationMaxUsdCents: z.number().int().nonnegative().nullable(),
  /** Above the escalation ceiling. Always DENY; present so the IR states it rather than implying it. */
  aboveCeiling: z.literal("DENY"),
  description: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/* ───────────────────────────── actions ────────────────────────────────────── */

export const StrategyActionSchema = z.object({
  id,
  /** Execution capability required, resolved to an adapter by the registry. */
  capability: z.string(),
  actionKind: z.string(),
  /** Assets that leave the user's control. */
  spendsAsset: z.string().optional(),
  recipientPolicy: z.enum(["self-only", "allow-list"]),
  description: z.string(),
  /**
   * The chain this action would execute on, when the strategy names one.
   *
   * Optional, because most strategies inherit the deployment's chain and never mention one. It
   * exists so that a strategy which DOES name a chain has somewhere honest to put it — and so the
   * compiler's write fence has something to check.
   *
   * Without this field the fence in `compileStrategy` could never fire, which would make it read as
   * coverage while checking nothing. A model emitting `chainId: 1` here is the realistic threat, and
   * this is what turns that into a refusal rather than a field that gets silently dropped.
   */
  chainId: z.number().int().positive().optional(),
});
export type StrategyAction = z.infer<typeof StrategyActionSchema>;

/* ──────────────────────────── the strategy ────────────────────────────────── */

export const UnknownRequirementSchema = z.object({
  field: z.string(),
  reason: z.string(),
  requiredBefore: z.enum(["BUILD", "DEPLOY"]),
});

export const StrategySchema = z.object({
  schemaVersion: z.literal(STRATEGY_IR_VERSION),
  planId: z.string(),
  revision: z.number().int().positive(),

  triggers: z.array(z.object({ id, kind: z.enum(["threshold", "schedule", "evm-event", "manual"]), description: z.string() })).min(1),
  inputs: z.array(StrategyInputSchema),
  transforms: z.array(TransformSchema),
  decisions: z.array(DecisionSchema).min(1),
  actions: z.array(StrategyActionSchema).min(1),

  /** Structured unknowns. A missing financial limit lives here, never as an invented default. */
  unknowns: z.array(UnknownRequirementSchema),

  invariants: z.array(z.object({ id: z.string(), statement: z.string() })),

  /**
   * Set when the strategy genuinely needs a multi-transaction plan.
   *
   * P17 does not implement chaining. Recognising the need and saying so is the correct output;
   * inventing a single-transaction approximation would be worse than refusing.
   */
  requiresCapability: z.array(z.literal("REQUIRES_P19_CAPABILITY")),
});
export type Strategy = z.infer<typeof StrategySchema>;
