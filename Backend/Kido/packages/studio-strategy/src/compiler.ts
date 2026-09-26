import { trustRank, satisfiesTrust, type DataTrustClass } from "@contextlock/studio-adapters";
import {
  assertAddable,
  assertComparable,
  describeUnit,
  ratioToBps,
  rescale,
  tokenToUsd,
  UnitMismatchError,
  UNITS,
  type Unit,
} from "./units.js";
import { StrategySchema, type ConditionNode, type OperandNode, type Strategy } from "./ir.js";
import { fenceWrite } from "@contextlock/studio-network";

/**
 * The strategy compiler.
 *
 * Luna proposes a Strategy IR; everything here is deterministic code that decides whether it may
 * be built. The compiler answers four questions the model cannot be trusted to answer about its own
 * output:
 *
 *   1. do the units line up?
 *   2. is every derived value at least as trusted as the decision that uses it?
 *   3. is every derived value fresh enough for the decision that uses it?
 *   4. does every action have an explicit policy disposition?
 *
 * The fourth is the one that matters most. "Condition true, therefore execute" is the shape of every
 * agent that lost money, and it is not expressible here.
 */

export interface CompileProblem {
  code: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  path: string;
  message: string;
  remediation: string;
}

export interface NodeProvenance {
  unit: Unit;
  /** The weakest trust among everything this value depends on. */
  trustClass: DataTrustClass;
  /** The loosest freshness bound among dependencies — the value is only as fresh as its stalest input. */
  maxAgeMs: number;
  dependsOn: string[];
}

export interface CompileResult {
  ok: boolean;
  buildable: boolean;
  problems: CompileProblem[];
  /** Provenance for every input and transform, computed rather than declared. */
  provenance: Record<string, NodeProvenance>;
  /** Deterministic topological order, so the same IR always compiles the same way. */
  order: string[];
  unknowns: Strategy["unknowns"];
  requiresCapability: string[];
}

const P = (
  code: string,
  severity: CompileProblem["severity"],
  path: string,
  message: string,
  remediation: string,
): CompileProblem => ({ code, severity, path, message, remediation });

/* ───────────────────────── trust and freshness flow ───────────────────────── */

/**
 * Trust propagates DOWN to the weakest input.
 *
 * A portfolio value derived from a verified price and a direct chain balance is not
 * verified-oracle-grade — it is only as good as the chain read. Letting a derived value inherit its
 * strongest dependency would be a laundering step: combine a weak source with a strong one and the
 * output is suddenly acceptable to a policy that would have rejected the weak source alone.
 */
export function propagateTrust(inputs: DataTrustClass[]): DataTrustClass {
  if (inputs.length === 0) return "USER_UNTRUSTED";
  return inputs.reduce((weakest, c) => (trustRank(c) < trustRank(weakest) ? c : weakest));
}

/**
 * Freshness propagates to the STALEST input.
 *
 * A value computed from a 3-second price and a 2-minute position is a 2-minute value. The tighter
 * bound tells you nothing about the pair.
 */
export function propagateFreshness(inputs: number[]): number {
  if (inputs.length === 0) return 0;
  return Math.max(...inputs);
}

/* ──────────────────────────── unit inference ──────────────────────────────── */

function transformOutputUnit(
  op: string,
  inputUnits: Unit[],
  toDecimals: number | undefined,
  path: string,
): { unit: Unit } | { problem: CompileProblem } {
  const wrap = (e: unknown): { problem: CompileProblem } => ({
    problem: P(
      e instanceof UnitMismatchError ? e.code : "STRAT-UNIT-INVALID",
      "CRITICAL",
      path,
      (e as Error).message,
      "Add an explicit conversion, or fix the operands so their units match.",
    ),
  });

  try {
    switch (op) {
      case "TOKEN_TO_USD": {
        if (inputUnits.length !== 2) throw new Error("TOKEN_TO_USD takes exactly an amount and a price");
        const out = tokenToUsd({ value: 1n, unit: inputUnits[0]! }, { value: 1n, unit: inputUnits[1]! });
        return { unit: out.unit };
      }
      case "RATIO_TO_BPS": {
        if (inputUnits.length !== 2) throw new Error("RATIO_TO_BPS takes exactly a part and a whole");
        const out = ratioToBps({ value: 1n, unit: inputUnits[0]! }, { value: 1n, unit: inputUnits[1]! });
        return { unit: out.unit };
      }
      case "PERCENT_TO_BPS": {
        if (inputUnits[0]?.kind !== "PERCENT") throw new Error("PERCENT_TO_BPS expects a PERCENT");
        return { unit: UNITS.bps };
      }
      case "SUM":
      case "DIFFERENCE": {
        const [first, ...rest] = inputUnits;
        if (!first) throw new Error(`${op} needs at least one operand`);
        for (const r of rest) assertAddable(first, r, op);
        return { unit: first };
      }
      case "RESCALE": {
        const first = inputUnits[0];
        if (!first) throw new Error("RESCALE needs an operand");
        if (toDecimals === undefined) throw new Error("RESCALE requires toDecimals");
        return { unit: rescale({ value: 1n, unit: first }, toDecimals).unit };
      }
      default:
        throw new Error(`unknown transform op "${op}"`);
    }
  } catch (e) {
    return wrap(e);
  }
}

/* ──────────────────────────── the compiler ────────────────────────────────── */

export function compileStrategy(input: unknown): CompileResult {
  const parsed = StrategySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      buildable: false,
      provenance: {},
      order: [],
      unknowns: [],
      requiresCapability: [],
      problems: parsed.error.issues.map((i) =>
        P("STRAT-SCHEMA", "CRITICAL", i.path.join("."), i.message, "Emit a strategy matching contextlock.strategy/v1."),
      ),
    };
  }

  const s = parsed.data;
  const problems: CompileProblem[] = [];
  const provenance: Record<string, NodeProvenance> = {};

  /*
   * ── The strategy write fence ───────────────────────────────────────────────
   *
   * Before any node is compiled. A strategy that would act on a production chain is not a strategy
   * that becomes acceptable once its provenance graph resolves — and compiling it first would mean
   * the model's output had already been turned into something executable before anyone checked
   * where it executes.
   *
   * Luna proposes the chain. The registry decides.
   */
  for (const node of s.actions ?? []) {
    const chainId = (node as { chainId?: number }).chainId;
    if (typeof chainId !== "number") continue;
    try {
      fenceWrite("STRATEGY_COMPILER", { chainId, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null }, "PUBLIC_WRITE");
    } catch (e) {
      problems.push(P("STRAT-NETWORK", "CRITICAL", `actions.${(node as { id?: string }).id ?? "?"}.chainId`, (e as Error).message,
        "ContextLock executes on approved testnets only. Mainnet is readable as market data and is never an execution target."));
    }
  }

  /* inputs are the roots: their provenance is declared, not derived */
  for (const i of s.inputs) {
    if (provenance[i.id]) {
      problems.push(P("STRAT-DUP-ID", "CRITICAL", `inputs.${i.id}`, `duplicate node id "${i.id}"`, "Give every node a unique id."));
      continue;
    }
    provenance[i.id] = {
      unit: i.unit,
      trustClass: i.minimumTrustClass,
      maxAgeMs: i.maxAgeMs,
      dependsOn: [],
    };
  }

  /*
   * Topological order over transforms.
   *
   * A cycle is CRITICAL rather than merely detected: a strategy whose value depends on itself has no
   * defined evaluation, and the runtime would either loop or take whichever order it happened to
   * pick.
   */
  const order: string[] = s.inputs.map((i) => i.id);
  const pending = new Map(s.transforms.map((t) => [t.id, t]));
  let progressed = true;
  while (pending.size > 0 && progressed) {
    progressed = false;
    for (const [tid, t] of [...pending]) {
      if (!t.inputs.every((dep) => provenance[dep])) continue;

      const inputUnits = t.inputs.map((dep) => provenance[dep]!.unit);
      const out = transformOutputUnit(t.op, inputUnits, t.toDecimals, `transforms.${tid}`);
      if ("problem" in out) {
        problems.push(out.problem);
        // Give it a placeholder so downstream nodes report their own problems rather than
        // cascading into "unknown reference" noise.
        provenance[tid] = { unit: UNITS.count, trustClass: "USER_UNTRUSTED", maxAgeMs: 0, dependsOn: t.inputs };
      } else {
        provenance[tid] = {
          unit: out.unit,
          trustClass: propagateTrust(t.inputs.map((d) => provenance[d]!.trustClass)),
          maxAgeMs: propagateFreshness(t.inputs.map((d) => provenance[d]!.maxAgeMs)),
          dependsOn: t.inputs,
        };
      }
      order.push(tid);
      pending.delete(tid);
      progressed = true;
    }
  }

  if (pending.size > 0) {
    const stuck = [...pending.keys()];
    const unresolvable = stuck.filter((tid) =>
      pending.get(tid)!.inputs.some((dep) => !provenance[dep] && !pending.has(dep)),
    );
    for (const tid of unresolvable) {
      const missing = pending.get(tid)!.inputs.filter((d) => !provenance[d] && !pending.has(d));
      problems.push(
        P("STRAT-UNKNOWN-REF", "CRITICAL", `transforms.${tid}`, `references unknown node(s): ${missing.join(", ")}`, "Declare the input, or correct the reference."),
      );
    }
    const cyclic = stuck.filter((t) => !unresolvable.includes(t));
    if (cyclic.length > 0) {
      problems.push(
        P("STRAT-CYCLE", "CRITICAL", `transforms`, `cyclic dependency among: ${cyclic.join(", ")}`, "A strategy graph must be acyclic; a value cannot depend on itself."),
      );
    }
  }

  /* ── conditions: type, unit and reference checking ───────────────────────── */

  const operandProvenance = (o: OperandNode, path: string): NodeProvenance | null => {
    if (o.type === "literal") {
      return { unit: o.unit, trustClass: "CONFIDENTIAL_VERIFIED_COMPUTE", maxAgeMs: Number.MAX_SAFE_INTEGER, dependsOn: [] };
    }
    const p = provenance[o.id];
    if (!p) {
      problems.push(P("STRAT-UNKNOWN-REF", "CRITICAL", path, `condition references unknown node "${o.id}"`, "Declare it as an input or a transform."));
      return null;
    }
    return p;
  };

  const usedNodes = new Set<string>();

  const checkCondition = (c: ConditionNode, path: string): void => {
    switch (c.type) {
      case "compare": {
        const l = operandProvenance(c.left, `${path}.left`);
        const r = operandProvenance(c.right, `${path}.right`);
        if (c.left.type === "ref") usedNodes.add(c.left.id);
        if (c.right.type === "ref") usedNodes.add(c.right.id);
        if (!l || !r) return;
        try {
          assertComparable(l.unit, r.unit, path);
        } catch (e) {
          problems.push(
            P(
              e instanceof UnitMismatchError ? e.code : "STRAT-UNIT-INVALID",
              "CRITICAL",
              path,
              (e as Error).message,
              "Convert one side explicitly. Comparing unlike units produces a well-formed and meaningless answer.",
            ),
          );
        }
        break;
      }
      case "and":
      case "or":
        c.children.forEach((child, i) => checkCondition(child, `${path}.${c.type}[${i}]`));
        break;
      case "not":
        checkCondition(c.child, `${path}.not`);
        break;
    }
  };

  /* ── decisions ───────────────────────────────────────────────────────────── */

  const actionIds = new Set(s.actions.map((a) => a.id));
  const decidedActions = new Set<string>();

  for (const d of s.decisions) {
    checkCondition(d.when, `decisions.${d.id}.when`);

    if (!actionIds.has(d.actionRef)) {
      problems.push(P("STRAT-UNKNOWN-ACTION", "CRITICAL", `decisions.${d.id}.actionRef`, `references unknown action "${d.actionRef}"`, "Declare the action."));
    } else {
      decidedActions.add(d.actionRef);
    }

    /*
     * An unbounded autonomous amount is an implicit ALLOW with no ceiling. The whole point of the
     * three-verdict model is that the autonomous band is bounded and everything above it needs a
     * human or a refusal.
     */
    if (d.autonomousMaxUsdCents === null && d.escalationMaxUsdCents === null) {
      problems.push(
        P("STRAT-UNBOUNDED-AMOUNT", "CRITICAL", `decisions.${d.id}`, "neither an autonomous limit nor an escalation ceiling is set; the action would have no upper bound", "Set both, or record them as unknowns so the build stops until they are."),
      );
    }
    if (
      d.autonomousMaxUsdCents !== null &&
      d.escalationMaxUsdCents !== null &&
      d.escalationMaxUsdCents < d.autonomousMaxUsdCents
    ) {
      problems.push(
        P("STRAT-BAND-INVERTED", "HIGH", `decisions.${d.id}`, `escalation ceiling ${d.escalationMaxUsdCents} is below the autonomous limit ${d.autonomousMaxUsdCents}`, "The escalation band must sit above the autonomous band."),
      );
    }

    /* trust and freshness of everything this decision reads must meet what it needs */
    const refs: string[] = [];
    const collect = (c: ConditionNode): void => {
      if (c.type === "compare") {
        if (c.left.type === "ref") refs.push(c.left.id);
        if (c.right.type === "ref") refs.push(c.right.id);
      } else if (c.type === "not") collect(c.child);
      else c.children.forEach(collect);
    };
    collect(d.when);

    const action = s.actions.find((a) => a.id === d.actionRef);
    if (action) {
      for (const ref of refs) {
        const p = provenance[ref];
        if (!p) continue;
        /*
         * A financial decision may not rest on untrusted or unattributed data. The floor is
         * DIRECT_CHAIN_DATA: something read from the chain, not something an API or the agent said.
         */
        if (!satisfiesTrust(p.trustClass, "DIRECT_CHAIN_DATA")) {
          problems.push(
            P("STRAT-TRUST-FLOOR", "CRITICAL", `decisions.${d.id}`, `decision reads "${ref}" which is ${p.trustClass}; a financial decision may not rest on data weaker than DIRECT_CHAIN_DATA`, "Raise the input's trust requirement, or route the decision through a confidential evaluation."),
          );
        }
      }
    }
  }

  /* ── actions without a decision ──────────────────────────────────────────── */

  for (const a of s.actions) {
    if (!decidedActions.has(a.id)) {
      problems.push(
        P("STRAT-ACTION-NO-DECISION", "CRITICAL", `actions.${a.id}`, `action "${a.id}" has no decision routing it; it would execute without a policy disposition`, "Add a decision, or remove the action. There is no implicit ALLOW."),
      );
    }
    if (a.recipientPolicy !== "self-only" && a.recipientPolicy !== "allow-list") {
      problems.push(P("STRAT-UNBOUNDED-RECIPIENT", "CRITICAL", `actions.${a.id}`, "recipient policy is neither self-only nor an allow-list", "Bound the recipient."));
    }
  }

  /* ── unused inputs ───────────────────────────────────────────────────────── */

  const referenced = new Set<string>(usedNodes);
  for (const t of s.transforms) for (const dep of t.inputs) referenced.add(dep);
  for (const i of s.inputs) {
    if (!referenced.has(i.id)) {
      problems.push(
        P("STRAT-UNUSED-INPUT", "MEDIUM", `inputs.${i.id}`, `input "${i.id}" is fetched but never used; it costs a call and may mislead a reader into thinking it informs the decision`, "Use it or remove it."),
      );
    }
  }
  for (const t of s.transforms) {
    if (!referenced.has(t.id)) {
      problems.push(P("STRAT-UNUSED-TRANSFORM", "MEDIUM", `transforms.${t.id}`, `transform "${t.id}" is computed but never used`, "Use it or remove it."));
    }
  }

  /* ── unknowns block the build ────────────────────────────────────────────── */

  const buildBlocking = s.unknowns.filter((u) => u.requiredBefore === "BUILD");
  for (const u of buildBlocking) {
    problems.push(
      P("STRAT-UNKNOWN-LIMIT", "CRITICAL", u.field, `"${u.field}" is unresolved: ${u.reason}`, "Supply the value. A financial boundary that was never stated must not be invented."),
    );
  }

  const hasBlocking = problems.some((p) => p.severity === "CRITICAL" || p.severity === "HIGH");
  return {
    ok: !problems.some((p) => p.severity === "CRITICAL"),
    buildable: !hasBlocking,
    problems,
    provenance,
    order,
    unknowns: s.unknowns,
    requiresCapability: s.requiresCapability,
  };
}

/** Render a condition for a human, so a compiled decision can be argued with. */
export function describeCondition(c: ConditionNode): string {
  switch (c.type) {
    case "compare": {
      const op = { LT: "<", LTE: "<=", GT: ">", GTE: ">=", EQ: "==", NEQ: "!=" }[c.op];
      const side = (o: OperandNode) => (o.type === "ref" ? o.id : `${o.value} ${describeUnit(o.unit)}`);
      return `${side(c.left)} ${op} ${side(c.right)}`;
    }
    case "and":
      return `(${c.children.map(describeCondition).join(" AND ")})`;
    case "or":
      return `(${c.children.map(describeCondition).join(" OR ")})`;
    case "not":
      return `NOT ${describeCondition(c.child)}`;
  }
}
