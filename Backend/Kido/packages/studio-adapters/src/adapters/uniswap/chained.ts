import { z } from "zod";

/**
 * Ingestion of a provider-generated CHAINED routing plan.
 *
 * The Trading API can answer a quote with `routing: "CHAINED"` and an ordered list of steps it
 * wants executed in sequence. That list is a SUGGESTION from a third party. It arrives over the
 * network, it is not signed by anyone we trust, and it describes transactions that move money.
 *
 * So it is parsed, never adopted. Each provider step is:
 *
 *   1. schema-checked — anything unrecognised is a refusal, not a passthrough;
 *   2. mapped onto a ContextLock PlanStep with its own step authorization;
 *   3. left to the ordinary decode-and-validate path, which re-derives every field from calldata.
 *
 * What is deliberately absent: any code path that submits a provider step as given. The provider
 * decides the ROUTE. ContextLock decides whether anything executes.
 */

export const CHAINED_REASONS = {
  UNSUPPORTED_ROUTING: "UNI-CHAINED-UNSUPPORTED-ROUTING",
  UNKNOWN_STEP_TYPE: "UNI-CHAINED-UNKNOWN-STEP-TYPE",
  EMPTY: "UNI-CHAINED-EMPTY",
  MALFORMED: "UNI-CHAINED-MALFORMED",
  CHAIN_MISMATCH: "UNI-CHAINED-CHAIN-MISMATCH",
  MAINNET_ONLY: "UNI-CHAINED-MAINNET-ONLY",
  RECIPIENT_NOT_SELF: "UNI-CHAINED-RECIPIENT-NOT-SELF",
  UNBOUNDED_STEP: "UNI-CHAINED-UNBOUNDED-STEP",
} as const;
export type ChainedReason = (typeof CHAINED_REASONS)[keyof typeof CHAINED_REASONS];

/**
 * The subset of provider step types this build understands.
 *
 * Closed on purpose. A provider adding a new step type must not silently gain the ability to make
 * this system execute something it has never seen — an unknown type is `UNI-CHAINED-UNKNOWN-STEP-TYPE`
 * and stops the whole plan.
 */
const SUPPORTED_STEP_TYPES = ["APPROVE", "SWAP", "WRAP", "UNWRAP"] as const;
export type ChainedStepType = (typeof SUPPORTED_STEP_TYPES)[number];

const ProviderStepSchema = z.object({
  type: z.string(),
  chainId: z.number().int().positive(),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  value: z.string().regex(/^\d+$/).default("0"),
  /** Provider's own description. Recorded for display, never used to decide anything. */
  summary: z.record(z.string(), z.unknown()).optional(),
});

export const ProviderChainedPlanSchema = z.object({
  routing: z.string(),
  steps: z.array(ProviderStepSchema),
});
export type ProviderChainedPlan = z.infer<typeof ProviderChainedPlanSchema>;

export interface IngestedStep {
  index: number;
  type: ChainedStepType;
  chainId: number;
  to: string;
  data: string;
  value: string;
  /** Every step gets its own authorization. There is no plan-level grant. */
  requiresOwnCapability: true;
  /** What the provider said, kept beside the decoded truth so the two can be compared in the UI. */
  providerSummary: Record<string, unknown> | null;
}

export type ChainedIngestResult =
  | { ok: true; steps: IngestedStep[] }
  | { ok: false; reason: ChainedReason; detail: string; atIndex?: number };

const MAINNET = new Set([1, 8453, 42161, 10, 137, 43114, 56]);

export function ingestChainedPlan(
  raw: unknown,
  expected: { chainId: number; allowMainnet?: boolean },
): ChainedIngestResult {
  const parsed = ProviderChainedPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: CHAINED_REASONS.MALFORMED, detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const plan = parsed.data;

  if (plan.routing !== "CHAINED") {
    return { ok: false, reason: CHAINED_REASONS.UNSUPPORTED_ROUTING, detail: `routing "${plan.routing}" is not CHAINED` };
  }
  if (plan.steps.length === 0) {
    return { ok: false, reason: CHAINED_REASONS.EMPTY, detail: "a chained plan with no steps authorizes nothing and executes nothing" };
  }

  const steps: IngestedStep[] = [];
  for (const [index, s] of plan.steps.entries()) {
    if (!SUPPORTED_STEP_TYPES.includes(s.type as ChainedStepType)) {
      return {
        ok: false,
        reason: CHAINED_REASONS.UNKNOWN_STEP_TYPE,
        detail: `step type "${s.type}" is not one this build decodes; refusing the whole plan rather than skipping a step that moves money`,
        atIndex: index,
      };
    }
    if (s.chainId !== expected.chainId) {
      return { ok: false, reason: CHAINED_REASONS.CHAIN_MISMATCH, detail: `step is for chain ${s.chainId}, expected ${expected.chainId}`, atIndex: index };
    }
    if (MAINNET.has(s.chainId) && !expected.allowMainnet) {
      return { ok: false, reason: CHAINED_REASONS.MAINNET_ONLY, detail: `chain ${s.chainId} is mainnet; this build is testnet-only (FND-V2-007)`, atIndex: index };
    }
    if (s.data === "0x" && s.value === "0") {
      return { ok: false, reason: CHAINED_REASONS.UNBOUNDED_STEP, detail: "step has neither calldata nor value; nothing can be decoded or bounded", atIndex: index };
    }
    steps.push({
      index,
      type: s.type as ChainedStepType,
      chainId: s.chainId,
      to: s.to,
      data: s.data,
      value: s.value,
      requiresOwnCapability: true,
      providerSummary: s.summary ?? null,
    });
  }

  return { ok: true, steps };
}
