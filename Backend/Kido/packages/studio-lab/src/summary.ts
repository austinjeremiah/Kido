import { z } from "zod";
import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";
import { lookupNetwork, networkLabel, type NetworkRole } from "@contextlock/studio-network";

/**
 * The build summary and the permissions review.
 *
 * §P28.5 and §P28.6 both attach the same condition, in different words:
 *
 *     Everything comes from canonical Blueprint/Strategy. No independent frontend interpretation.
 *     Luna may explain these rules. Luna does not decide them.
 *
 * The failure being prevented is specific and quiet. A screen that says "this agent cannot withdraw
 * collateral" is a security claim, and if a frontend composes that sentence from its own reading of
 * the requirements text, it is a claim about what the *frontend believes* rather than about what the
 * agent can do. The two agree right up until someone edits one of them.
 *
 * So everything below is a projection of the Blueprint, derived deterministically. There is no
 * model in this file and no string that is not traceable to a Blueprint field.
 */

export const CapabilityLineSchema = z.object({
  /** `CAN` or `CANNOT`. Two kinds of statement, never merged into a single scored list. */
  kind: z.enum(["CAN", "CANNOT"]),
  statement: z.string().min(1),
  /** The Blueprint field this came from, so a surprising line can be traced. */
  derivedFrom: z.string().min(1),
});
export type CapabilityLine = z.infer<typeof CapabilityLineSchema>;

const usd = (cents: number): string => {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
};

/**
 * Unwrap a `MaybeUnknown` financial value.
 *
 * The Blueprint wraps every financial parameter as `{ known: true, value, sourceQuote }` or
 * `{ known: false, reason, requiredBefore }` — there is deliberately no bare number and no absent
 * state a reader could mistake for a default. Treating the wrapper as a plain value reads every
 * established limit as UNKNOWN, which is the failure this helper exists to avoid.
 */
const knownNumber = (v: unknown): number | null => {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "known" in v) {
    const w = v as { known: boolean; value?: unknown };
    return w.known && typeof w.value === "number" ? w.value : null;
  }
  return null;
};

export interface BuildSummary {
  name: string;
  goal: string;
  execution: { chainId: number; label: string; role: NetworkRole; name: string };
  realityData: { chainId: number; label: string; role: NetworkRole; name: string } | null;
  protocols: string[];
  verifiedMarketData: string[];
  cre: { required: boolean; mode: string };
  autonomous: string;
  humanApproval: string;
  hardDeny: string;
  forbidden: string[];
  blueprintRevision: number;
  /**
   * Per-action tightenings, shown separately from the global limits.
   *
   * Folding them into one number would hide the fact that this agent has two different limit sets —
   * which is the whole reason the primitive exists.
   */
  perActionLimits: Array<{ action: string; autonomous: string; humanApproval: string; hardDeny: string; sourceQuote: string }>;
}

/**
 * The summary card.
 *
 * Every field maps to a Blueprint field. Where the Blueprint says `UNKNOWN`, this says so rather
 * than substituting a default — §P28.4's "must not invent missing financial boundaries" is a
 * property of this function as much as of the requirements agent.
 */
export function buildSummary(bp: ContextLockAgentBlueprint, executionChainId: number, realityChainId: number | null): BuildSummary {
  const exec = lookupNetwork(executionChainId);
  const reality = realityChainId !== null ? lookupNetwork(realityChainId) : null;

  const autoMax = knownNumber(bp.autonomousPolicy.maxValueUsdCents);
  const escMin = knownNumber(bp.escalationPolicy.minValueUsdCents);
  const escMax = knownNumber(bp.escalationPolicy.maxValueUsdCents);

  return {
    name: bp.identity.ensName,
    goal: bp.objective,
    execution: {
      chainId: executionChainId,
      name: exec?.name ?? `chain ${executionChainId}`,
      role: exec?.role ?? "TESTNET_EXECUTION",
      label: networkLabel({ chainId: executionChainId, role: exec?.role ?? "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null }),
    },
    realityData: reality
      ? {
          chainId: reality.chainId,
          name: reality.name,
          role: reality.role,
          label: networkLabel({ chainId: reality.chainId, role: reality.role, forkedFrom: null, forkBlock: null }),
        }
      : null,
    protocols: bp.protocols.map((p) => p.displayName),
    /*
     * Verified market data comes from the ADAPTER BINDINGS, not from the context sources.
     *
     * A context source declares the trust a requirement demands; an adapter binding names the
     * provider that will satisfy it. Reading the provider off the requirement would report what was
     * asked for rather than what was chosen — and the resolver is allowed to choose differently.
     */
    verifiedMarketData: bp.adapters
      .filter((a) => a.role === "VERIFIED_MARKET_DATA")
      .map((a) => `${a.adapterId}@${a.adapterVersion}`),
    cre: { required: bp.cre.required, mode: bp.cre.required ? "Official Simulator" : "Not used" },
    autonomous: autoMax === null ? "UNKNOWN — no autonomous limit was established" : `≤ ${usd(autoMax)}`,
    humanApproval:
      escMin === null || escMax === null
        ? "UNKNOWN — no escalation band was established"
        : `${usd(escMin)} – ${usd(escMax)}`,
    hardDeny: escMax === null ? "UNKNOWN — no hard cap was established" : `> ${usd(escMax)}`,
    forbidden: bp.permissions.denied.map((d) => d.statement),
    blueprintRevision: bp.revision,
    perActionLimits: bp.perActionLimits.map((l) => {
      const a = knownNumber(l.autonomousMaxUsdCents);
      const eMin = knownNumber(l.escalationMinUsdCents);
      const eMax = knownNumber(l.escalationMaxUsdCents);
      const action = bp.actions.find((x) => x.id === l.actionRef);
      return {
        action: action?.displayName ?? l.actionRef,
        autonomous: a === null ? "UNKNOWN" : `≤ ${usd(a)}`,
        humanApproval: eMin === null || eMax === null ? "UNKNOWN" : `${usd(eMin)} – ${usd(eMax)}`,
        hardDeny: eMax === null ? "UNKNOWN" : `> ${usd(eMax)}`,
        sourceQuote: l.sourceQuote,
      };
    }),
  };
}

/**
 * What this agent can and cannot do.
 *
 * The `CANNOT` list is **not** the complement of the `CAN` list, and that is the whole design. The
 * Blueprint's `permissions.denied` is explicit and required to be non-empty, because "we never
 * mentioned withdrawals" and "withdrawals are forbidden" produce identical allow lists and very
 * different agents. A screen that computed denials by subtraction would show the same reassuring
 * text for both.
 *
 * Three denials are appended that no Blueprint author writes and every agent has, because they come
 * from the product boundary rather than from the design: no production-chain execution, no
 * execution above the hard cap, and no authority for the model itself.
 */
export function capabilityReview(bp: ContextLockAgentBlueprint, executionChainId: number): CapabilityLine[] {
  const lines: CapabilityLine[] = [];

  for (const p of bp.permissions.allowed) {
    lines.push({ kind: "CAN", statement: p.statement, derivedFrom: `permissions.allowed[${p.id}]` });
  }

  const autoMax = knownNumber(bp.autonomousPolicy.maxValueUsdCents);
  if (autoMax !== null) {
    lines.push({
      kind: "CAN",
      statement: `Execute autonomously up to ${usd(autoMax)}`,
      derivedFrom: "autonomousPolicy.maxValueUsdCents",
    });
  }

  for (const s of bp.contextSources) {
    // The requirement, in the requirement's own terms: what kind of data, at what minimum trust.
    lines.push({
      kind: "CAN",
      statement: `Read ${s.dataKind} at ${s.minimumTrustClass} or better, no older than ${Math.round(s.maxAgeMs / 1000)}s`,
      derivedFrom: `contextSources[${s.id}]`,
    });
  }

  for (const l of bp.perActionLimits) {
    const a = knownNumber(l.autonomousMaxUsdCents);
    const action = bp.actions.find((x) => x.id === l.actionRef);
    if (a !== null) {
      lines.push({
        kind: "CAN",
        statement: `Execute "${action?.displayName ?? l.actionRef}" autonomously up to ${usd(a)} — tighter than the global limit`,
        derivedFrom: `perActionLimits[${l.actionRef}].autonomousMaxUsdCents`,
      });
    }
    const cap = knownNumber(l.escalationMaxUsdCents);
    if (cap !== null) {
      lines.push({
        kind: "CANNOT",
        statement: `Execute "${action?.displayName ?? l.actionRef}" above ${usd(cap)}, even though the global cap is higher`,
        derivedFrom: `perActionLimits[${l.actionRef}].escalationMaxUsdCents`,
      });
    }
  }

  for (const a of bp.adapters) {
    lines.push({
      kind: "CAN",
      statement: `Use ${a.adapterId}@${a.adapterVersion} for ${a.role.toLowerCase().replace(/_/g, " ")}`,
      derivedFrom: `adapters[${a.adapterId}]`,
    });
  }

  /* ── the denials ────────────────────────────────────────────────────────── */

  for (const d of bp.permissions.denied) {
    lines.push({ kind: "CANNOT", statement: d.statement, derivedFrom: `permissions.denied[${d.id}]` });
  }

  const escMax = knownNumber(bp.escalationPolicy.maxValueUsdCents);
  if (escMax !== null) {
    lines.push({
      kind: "CANNOT",
      statement: `Execute above ${usd(escMax)} — this is a hard deny, not a higher approval tier`,
      derivedFrom: "escalationPolicy.maxValueUsdCents + escalationPolicy.denyIsTerminal",
    });
  }

  const exec = lookupNetwork(executionChainId);
  lines.push({
    kind: "CANNOT",
    statement: `Execute on a production chain. This agent's execution network is ${exec?.name ?? executionChainId} (${exec?.role ?? "unknown role"})`,
    derivedFrom: "the network registry: no production chain is write-capable",
  });

  lines.push({
    kind: "CANNOT",
    statement: "Change its own limits. The model proposes; ContextLock decides",
    derivedFrom: "the capability policy: authority is issued by the broker, not by the agent",
  });

  return lines;
}

/**
 * A Blueprint with an unestablished financial boundary.
 *
 * §P28.4: the system may infer required *categories* — that an Aave agent needs Aave state and a
 * verified price — and must not invent missing *financial boundaries*. Those are different kinds of
 * gap: one is a technical dependency the design implies, the other is a decision only the user can
 * make, and filling in the second with a plausible default is how an agent acquires a limit nobody
 * chose.
 */
export function unestablishedBoundaries(bp: ContextLockAgentBlueprint): string[] {
  const gaps: string[] = [];
  if (knownNumber(bp.autonomousPolicy.maxValueUsdCents) === null) gaps.push("autonomous limit");
  if (knownNumber(bp.escalationPolicy.minValueUsdCents) === null) gaps.push("escalation floor");
  if (knownNumber(bp.escalationPolicy.maxValueUsdCents) === null) gaps.push("hard cap");
  if (bp.permissions.denied.length === 0) gaps.push("explicit denials");
  return gaps;
}

export const SUMMARY_REASONS = {
  UNESTABLISHED_BOUNDARY: "FINANCIAL_BOUNDARY_NOT_ESTABLISHED",
} as const;

export class SummaryError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "SummaryError";
  }
}

/** Refuse to deploy an agent whose financial boundaries were never established. */
export function assertBoundariesEstablished(bp: ContextLockAgentBlueprint, context: string): void {
  const gaps = unestablishedBoundaries(bp);
  if (gaps.length > 0) {
    throw new SummaryError(
      SUMMARY_REASONS.UNESTABLISHED_BOUNDARY,
      `${context}: ${gaps.join(", ")} ${gaps.length > 1 ? "were" : "was"} never established. A default here would be a limit nobody chose, and the user is the only one who can choose it.`,
    );
  }
}
