import { z } from "zod";
import { lookupNetwork } from "@contextlock/studio-network";

/**
 * "Why did it act?"
 *
 * §P28.34. The answer has to come from the deterministic record — the reason code the policy
 * engine emitted, the snapshot hash the decision cited, the network the capability was bound to —
 * and not from a model asked to narrate afterwards. A generated explanation is a plausible story
 * about a decision rather than the decision, and the two diverge exactly when it matters.
 *
 * The other half is what this must NOT show. The confidential policy's parameter values live in the
 * CRE workflow and stay there. Rather than omitting them silently, the view names what it withheld:
 * a user who can see that four thresholds exist and are not shown understands the boundary, and a
 * user who sees nothing assumes there was nothing.
 */

export const DECISION_VERDICTS = ["ALLOW", "ESCALATE", "DENY", "NO_ACTION"] as const;
export const DecisionVerdictSchema = z.enum(DECISION_VERDICTS);
export type DecisionVerdict = z.infer<typeof DecisionVerdictSchema>;

export const DecisionFieldSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  /** Where the value came from. A field with no provenance is a number on a screen. */
  source: z.string().min(1),
});
export type DecisionField = z.infer<typeof DecisionFieldSchema>;

export const DecisionDetailSchema = z.object({
  correlationId: z.string().min(1),
  verdict: DecisionVerdictSchema,
  reasonCode: z.string().min(1),
  /** The plain-language reading of the reason code — a lookup, not a generated sentence. */
  reasonPlain: z.string().min(1),
  fields: z.array(DecisionFieldSchema),
  /** What is deliberately not shown, and why. Named rather than absent. */
  withheld: z.array(z.object({ what: z.string().min(1), why: z.string().min(1) })),
  /** Set when the decision was made against a scenario rather than a live reading. */
  synthetic: z.boolean(),
});
export type DecisionDetail = z.infer<typeof DecisionDetailSchema>;

/**
 * Reason codes in words.
 *
 * A closed table. An unknown code renders as itself rather than as an invented explanation — being
 * told `DENY_LIQUIDITY_V2` and nothing else is worse than a guess only until the guess is wrong.
 */
export const REASON_PLAIN: Record<string, string> = {
  ALLOW_POLICY_MATCH: "The action matched the policy and stayed inside the autonomous limit.",
  ESCALATE_AMOUNT: "The amount is above the autonomous limit and below the hard cap, so it needs a human.",
  ESCALATE_RISK: "Market conditions were outside the band the policy allows to proceed unattended.",
  ESCALATE_POLICY_RULE: "A policy rule requires approval for this action regardless of amount.",
  DENY_AMOUNT_TOO_HIGH: "The amount is above the hard cap. No approval path exists for it.",
  DENY_TARGET_NOT_ALLOWED: "The contract being called is not on the allowlist for this action.",
  DENY_ACTION_NOT_ALLOWED: "This action is not one the agent is permitted to take.",
  DENY_AGENT_NOT_AUTHORIZED: "The agent's identity did not resolve to an authorized principal.",
  DENY_CONTEXT_STALE: "The market context was older than the policy allows.",
  DENY_SLIPPAGE: "The expected slippage exceeded the configured bound.",
  DENY_VOLATILITY: "Volatility was above the level the policy will act through.",
  DENY_LIQUIDITY: "Available liquidity was below what this size requires.",
  DENY_POLICY_DISABLED: "The ContextLock policy is disabled. No capability can be issued.",
  DENY_MALFORMED_CONTEXT: "The context did not parse, so nothing could be evaluated against it.",
  NO_VALID_CONTEXT: "No usable market context existed at decision time.",
};

export interface DecisionInputs {
  correlationId: string;
  verdict: DecisionVerdict;
  reasonCode: string;
  /** Denominated and formatted by the caller from the canonical record. */
  amount: string | null;
  /** The policy's identity and version — never its parameter values. */
  policyRef: string;
  marketSnapshotHash: string;
  scenarioHash: string | null;
  verifiedPrice: { metric: string; value: string; sourceId: string; trustClass: string } | null;
  executionChainId: number | null;
  recipient: string | null;
  recipientPolicy: string;
  creMode: string;
}

/** Fields that would mean the confidential policy leaked into a public decision view. */
export const PRIVATE_POLICY_FIELDS = ["thresholds", "limits", "parameterValues", "policyBody", "privatePolicy", "rules"] as const;

export const DECISION_REASONS = {
  PRIVATE_POLICY_EXPOSED: "DECISION_DETAIL_EXPOSED_PRIVATE_POLICY",
  NARRATED: "DECISION_DETAIL_NOT_FROM_DETERMINISTIC_RECORD",
} as const;

export class DecisionDetailError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "DecisionDetailError";
  }
}

/**
 * Build the decision detail.
 *
 * Every field is a value the caller read from the record, and the function's contribution is the
 * shape: which fields exist, in what order, each with its source, plus the withheld list. Nothing
 * here computes a verdict — a view that could reach a different conclusion from the engine would be
 * a second policy.
 */
export function decisionDetail(input: DecisionInputs): DecisionDetail {
  const net = input.executionChainId === null ? null : lookupNetwork(input.executionChainId);

  const fields: DecisionField[] = [];
  const push = (label: string, value: string | null, source: string): void => {
    if (value !== null && value !== "") fields.push({ label, value, source });
  };

  push("Amount", input.amount, "the action record, denominated in the asset it is denominated in");
  push("Policy", input.policyRef, "the policy binding the capability was evaluated under");
  push("Reality snapshot", `${input.marketSnapshotHash.slice(0, 20)}…`, "the sealed snapshot this decision cited");
  if (input.scenarioHash !== null) {
    push("Scenario", `${input.scenarioHash.slice(0, 20)}… — SYNTHETIC OVERLAY`, "a scenario overlay applied to that snapshot");
  }
  if (input.verifiedPrice !== null) {
    push(
      "Verified price",
      `${input.verifiedPrice.metric} ${input.verifiedPrice.value}`,
      `${input.verifiedPrice.sourceId} (${input.verifiedPrice.trustClass})`,
    );
  }
  push(
    "Execution network",
    net ? `${net.name} — ${net.role.replace(/_/g, " ")}` : input.executionChainId === null ? null : `chain ${input.executionChainId}`,
    "the network the capability was bound to, from the capability itself",
  );
  push("Recipient", input.recipient, `the recipient policy for this action is ${input.recipientPolicy}`);
  push("CRE mode", input.creMode, "the mode the workflow actually ran in");

  return {
    correlationId: input.correlationId,
    verdict: input.verdict,
    reasonCode: input.reasonCode,
    reasonPlain: REASON_PLAIN[input.reasonCode] ?? input.reasonCode,
    fields,
    withheld: [
      {
        what: "The confidential policy's parameter values",
        why: "They live in the CRE workflow and are never sent to the agent, the runtime or this screen. The reason code above is the part of the evaluation that is public.",
      },
    ],
    synthetic: input.scenarioHash !== null,
  };
}

/**
 * Refuse a decision view carrying the private policy.
 *
 * Applied to the assembled object rather than to its inputs, because the leak this guards against
 * is someone adding a helpful "here are the limits it checked" field to the view later.
 */
export function assertDecisionPrivate(detail: DecisionDetail, context: string): void {
  const blob = JSON.stringify(detail).toLowerCase();
  for (const field of PRIVATE_POLICY_FIELDS) {
    if (blob.includes(`"${field.toLowerCase()}"`)) {
      throw new DecisionDetailError(
        DECISION_REASONS.PRIVATE_POLICY_EXPOSED,
        `${context}: the decision detail carries "${field}". The policy's parameter values stay in the CRE workflow; the reason code is the public half.`,
      );
    }
  }
}
