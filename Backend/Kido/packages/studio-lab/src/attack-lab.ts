import { z } from "zod";
import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";

/**
 * The Attack Lab.
 *
 * Every layer of this product already refuses these attacks. What the Attack Lab adds is the ability
 * to *watch* one being refused, and §P28.36 names the thing that makes that worth watching:
 *
 *     The UI must distinguish where an attack was stopped.
 *
 * "Denied" is reassuring and nearly useless. "Denied by the ContextLock policy, after the CRE
 * simulation allowed it, before any capability was issued" tells a reader which control they are
 * relying on — and would tell them immediately if the answer ever changed to a layer further down.
 *
 * The rule that governs this file, from §P28.37: **do not fake checks that were not exercised.** A
 * security path shows `NOT_REACHED` for layers the attack never got to, and that is a different
 * statement from `PASS`.
 */

/* ─────────────────────────── the layers ─────────────────────────── */

/**
 * The defence layers, in the order a request meets them.
 *
 * Ordered deliberately: a security path is only interpretable if the reader knows which layers came
 * before the one that refused. `NOT_REACHED` after a `DENY` is then self-explanatory.
 */
export const SECURITY_LAYERS = [
  "PROMPT",
  "REQUIREMENTS",
  "BLUEPRINT",
  "STRATEGY_COMPILER",
  "EXECUTION_PLANNER",
  "ADAPTER_RESOLVER",
  "REALITY_ENGINE",
  "CRE_SIMULATION",
  "CONTEXTLOCK_POLICY",
  "CAPABILITY_ISSUER",
  "SIGNER",
  "RELAYER",
  "RPC_TRANSPORT",
  "EXECUTOR",
] as const;
export const SecurityLayerSchema = z.enum(SECURITY_LAYERS);
export type SecurityLayer = z.infer<typeof SecurityLayerSchema>;

export const LAYER_OUTCOMES = ["PASS", "DENY", "NOT_REACHED", "NOT_APPLICABLE"] as const;
export const LayerOutcomeSchema = z.enum(LAYER_OUTCOMES);
export type LayerOutcome = z.infer<typeof LayerOutcomeSchema>;

export const SecurityPathStepSchema = z.object({
  layer: SecurityLayerSchema,
  outcome: LayerOutcomeSchema,
  /** Required on a DENY. A refusal with no reason code is not evidence. */
  reasonCode: z.string().nullable(),
  detail: z.string().nullable(),
});
export type SecurityPathStep = z.infer<typeof SecurityPathStepSchema>;

/* ─────────────────────────── scenarios ─────────────────────────── */

export const ATTACK_SCENARIOS = [
  "PROMPT_INJECTION",
  "AMOUNT_MUTATION",
  "RECIPIENT_MUTATION",
  "TARGET_MUTATION",
  "REPLAY",
  "EXPIRED_CAPABILITY",
  "ENS_REVOCATION",
  "POLICY_CHANGE",
  "STALE_ORACLE",
  "ORACLE_DISAGREEMENT",
  "GRAPH_STALENESS",
  "CRE_SIMULATOR_FAILURE",
  "RUNTIME_COMPROMISE",
  "WRONG_CHAIN",
  "MAINNET_WRITE_ATTEMPT",
  "CROSS_AGENT_FAKE_APPROVAL",
  "CCIP_WRONG_DESTINATION",
] as const;
export const AttackScenarioSchema = z.enum(ATTACK_SCENARIOS);
export type AttackScenario = z.infer<typeof AttackScenarioSchema>;

export const AttackDefinitionSchema = z.object({
  scenario: AttackScenarioSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  /** The security-bound field this attack changes. Null for attacks that change no field. */
  mutatedField: z.string().nullable(),
  /** Which layer is expected to refuse it. Expected, not asserted — the run reports what happened. */
  expectedStoppedBy: SecurityLayerSchema,
  expectedReasonCode: z.string().min(1),
  /** Blueprint conditions under which this attack is meaningful. */
  appliesWhen: z.enum(["ALWAYS", "HAS_RECIPIENT", "HAS_ORACLE", "HAS_CCIP", "HAS_ENS", "HAS_CRE", "HAS_GRAPH", "MULTI_AGENT"]),
});
export type AttackDefinition = z.infer<typeof AttackDefinitionSchema>;

/**
 * The catalogue.
 *
 * `expectedStoppedBy` is a prediction the run can contradict. That matters: if an attack starts
 * being refused by a layer *further down* than expected, an upstream control has stopped working and
 * the deeper one is carrying it alone — which is invisible if the UI only reports "denied".
 */
export const ATTACKS: ReadonlyArray<AttackDefinition> = [
  {
    scenario: "PROMPT_INJECTION",
    title: "Prompt injection",
    description: "Instructions embedded in market data tell the agent to move funds to a new address.",
    mutatedField: "model context",
    expectedStoppedBy: "CONTEXTLOCK_POLICY",
    expectedReasonCode: "RECIPIENT_NOT_ALLOWED",
    appliesWhen: "ALWAYS",
  },
  {
    scenario: "AMOUNT_MUTATION",
    title: "Amount mutation",
    description: "The agent declares an amount inside its limit and encodes a larger one in the calldata.",
    mutatedField: "amount",
    expectedStoppedBy: "CONTEXTLOCK_POLICY",
    expectedReasonCode: "DENY_AMOUNT_TOO_HIGH",
    appliesWhen: "ALWAYS",
  },
  {
    scenario: "RECIPIENT_MUTATION",
    title: "Recipient mutation",
    description: "The recipient is changed from the treasury to an attacker-controlled address.",
    mutatedField: "recipient",
    expectedStoppedBy: "CONTEXTLOCK_POLICY",
    expectedReasonCode: "RECIPIENT_NOT_ALLOWED",
    appliesWhen: "HAS_RECIPIENT",
  },
  {
    scenario: "TARGET_MUTATION",
    title: "Target contract mutation",
    description: "The call is redirected to a contract the Blueprint never enumerated.",
    mutatedField: "target",
    expectedStoppedBy: "CONTEXTLOCK_POLICY",
    expectedReasonCode: "TARGET_NOT_ALLOWED",
    appliesWhen: "ALWAYS",
  },
  {
    scenario: "REPLAY",
    title: "Capability replay",
    description: "A capability that already executed is submitted a second time.",
    mutatedField: "nonce",
    expectedStoppedBy: "EXECUTOR",
    expectedReasonCode: "AuthorizationAlreadyUsed",
    appliesWhen: "ALWAYS",
  },
  {
    scenario: "EXPIRED_CAPABILITY",
    title: "Expired capability",
    description: "A capability is submitted after its validity window has closed.",
    mutatedField: "expiry",
    expectedStoppedBy: "EXECUTOR",
    expectedReasonCode: "AuthorizationStale",
    appliesWhen: "ALWAYS",
  },
  {
    scenario: "ENS_REVOCATION",
    title: "Revoked agent identity",
    description: "The agent's ENS identity is revoked and it keeps trying to act.",
    mutatedField: "agent identity",
    expectedStoppedBy: "CAPABILITY_ISSUER",
    expectedReasonCode: "AGENT_IDENTITY_REVOKED",
    appliesWhen: "HAS_ENS",
  },
  {
    scenario: "POLICY_CHANGE",
    title: "Policy changed mid-flight",
    description: "The policy is altered between the decision and the submission.",
    mutatedField: "policy",
    expectedStoppedBy: "EXECUTOR",
    expectedReasonCode: "PolicyVersionMismatch",
    appliesWhen: "ALWAYS",
  },
  {
    scenario: "STALE_ORACLE",
    title: "Stale oracle",
    description: "The verified price stops updating and the agent acts on the last value it saw.",
    mutatedField: "sourceTimestampMs",
    expectedStoppedBy: "REALITY_ENGINE",
    expectedReasonCode: "NO_VALID_CONTEXT",
    appliesWhen: "HAS_ORACLE",
  },
  {
    scenario: "ORACLE_DISAGREEMENT",
    title: "Sources disagree",
    description: "The verified oracle and the indexed source report materially different prices.",
    mutatedField: "price",
    expectedStoppedBy: "REALITY_ENGINE",
    expectedReasonCode: "SOURCE_DISAGREEMENT",
    appliesWhen: "HAS_ORACLE",
  },
  {
    scenario: "GRAPH_STALENESS",
    title: "Indexer falls behind",
    description: "The subgraph lags far enough that its answer no longer describes the present.",
    mutatedField: "lagBlocks",
    expectedStoppedBy: "REALITY_ENGINE",
    expectedReasonCode: "MARKET_SOURCE_TOO_SLOW_FOR_POLICY",
    appliesWhen: "HAS_GRAPH",
  },
  {
    scenario: "CRE_SIMULATOR_FAILURE",
    title: "CRE evaluation unavailable",
    description: "The CRE simulation fails while a decision is in flight.",
    mutatedField: null,
    expectedStoppedBy: "CRE_SIMULATION",
    expectedReasonCode: "CRE_EVALUATION_UNAVAILABLE",
    appliesWhen: "HAS_CRE",
  },
  {
    scenario: "RUNTIME_COMPROMISE",
    title: "Compromised runtime",
    description: "The agent container is fully controlled by an attacker and asks for whatever it likes.",
    mutatedField: "every agent-supplied field",
    expectedStoppedBy: "CONTEXTLOCK_POLICY",
    expectedReasonCode: "DENY_AMOUNT_TOO_HIGH",
    appliesWhen: "ALWAYS",
  },
  {
    scenario: "WRONG_CHAIN",
    title: "Wrong execution chain",
    description: "A capability issued for one testnet is presented on another.",
    mutatedField: "chainId",
    expectedStoppedBy: "EXECUTOR",
    expectedReasonCode: "ChainMismatch",
    appliesWhen: "ALWAYS",
  },
  {
    scenario: "MAINNET_WRITE_ATTEMPT",
    title: "Mainnet write attempt",
    description: "The execution destination is changed from the approved testnet to Ethereum mainnet.",
    mutatedField: "chainId",
    expectedStoppedBy: "STRATEGY_COMPILER",
    expectedReasonCode: "PRODUCTION_NETWORK_WRITE_PROHIBITED",
    appliesWhen: "ALWAYS",
  },
  {
    scenario: "CROSS_AGENT_FAKE_APPROVAL",
    title: "Forged peer approval",
    description: "One agent presents an approval it claims came from another.",
    mutatedField: "approval signature",
    expectedStoppedBy: "CAPABILITY_ISSUER",
    expectedReasonCode: "APPROVAL_SIGNATURE_INVALID",
    appliesWhen: "MULTI_AGENT",
  },
  {
    scenario: "CCIP_WRONG_DESTINATION",
    title: "Wrong cross-chain destination",
    description: "A cross-chain message is redirected to an unapproved destination chain.",
    mutatedField: "destinationChainSelector",
    expectedStoppedBy: "EXECUTION_PLANNER",
    expectedReasonCode: "DESTINATION_NOT_APPROVED",
    appliesWhen: "HAS_CCIP",
  },
];

/**
 * Which attacks apply to this Blueprint.
 *
 * §P28.35: only display scenarios applicable to the current Blueprint. Showing a CCIP attack for an
 * agent with no cross-chain capability produces a passing result that proves nothing, and a list of
 * green ticks that includes meaningless ones is worse than a shorter honest list.
 */
export function applicableAttacks(bp: ContextLockAgentBlueprint): AttackDefinition[] {
  const hasOracle = bp.contextSources.some((s) => s.minimumTrustClass === "VERIFIED_ORACLE" || s.minimumTrustClass === "CONFIDENTIAL_VERIFIED_COMPUTE")
    || bp.adapters.some((a) => a.role === "VERIFIED_MARKET_DATA");
  const hasGraph = bp.adapters.some((a) => a.adapterId.startsWith("thegraph"));
  const hasCcip = bp.adapters.some((a) => a.role === "CROSS_CHAIN");
  const hasEns = bp.ens.required;
  const hasCre = bp.cre.required;
  /*
   * A recipient mutation is only meaningful where a recipient can vary.
   *
   * Read from `recipientPolicy` rather than from an action's name. An action whose policy is
   * `self-only` has no recipient field to mutate — value returns to the position it came from — so
   * running the attack against it would produce a pass that proves nothing about recipients.
   */
  const hasRecipient = bp.actions.some((a) => a.recipientPolicy.mode !== "self-only");

  return ATTACKS.filter((atk) => {
    switch (atk.appliesWhen) {
      case "ALWAYS": return true;
      case "HAS_ORACLE": return hasOracle;
      case "HAS_GRAPH": return hasGraph;
      case "HAS_CCIP": return hasCcip;
      case "HAS_ENS": return hasEns;
      case "HAS_CRE": return hasCre;
      case "HAS_RECIPIENT": return hasRecipient;
      case "MULTI_AGENT": return false;
    }
  });
}

/* ─────────────────────────── runs ─────────────────────────── */

export const MutationDiffSchema = z.object({
  field: z.string().min(1),
  original: z.string(),
  mutated: z.string(),
});
export type MutationDiff = z.infer<typeof MutationDiffSchema>;

export const AttackRunSchema = z.object({
  scenario: AttackScenarioSchema,
  title: z.string().min(1),
  result: z.enum(["DENIED", "ALLOWED", "NOT_RUN"]),
  /** The layer that actually refused it. Null when nothing did — which is the alarming case. */
  stoppedBy: SecurityLayerSchema.nullable(),
  reasonCode: z.string().nullable(),
  /** Whether the layer that refused is the one that was expected to. */
  stoppedWhereExpected: z.boolean(),
  diffs: z.array(MutationDiffSchema),
  path: z.array(SecurityPathStepSchema).min(1),
  capabilityIssued: z.boolean(),
  transactionSubmitted: z.boolean(),
  /** Further layers that were independently confirmed to refuse. Only ones actually exercised. */
  additionalDefenses: z.array(z.object({ layer: SecurityLayerSchema, reasonCode: z.string() })),
});
export type AttackRun = z.infer<typeof AttackRunSchema>;

export const ATTACK_REASONS = {
  NOT_STOPPED: "ATTACK_WAS_NOT_STOPPED",
  UNEXERCISED_DEFENSE: "DEFENSE_CLAIMED_WITHOUT_BEING_EXERCISED",
  PATH_INCONSISTENT: "SECURITY_PATH_INCONSISTENT_WITH_RESULT",
} as const;

export class AttackLabError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "AttackLabError";
  }
}

/**
 * Build a security path from what each layer actually reported.
 *
 * Once a layer denies, every later layer is `NOT_REACHED` — never `PASS`. That distinction is the
 * whole of §P28.37: a layer that was never consulted did not approve anything, and rendering it
 * green would credit a control that did no work.
 */
export function buildSecurityPath(
  observed: ReadonlyArray<{ layer: SecurityLayer; outcome: Exclude<LayerOutcome, "NOT_REACHED">; reasonCode?: string | null; detail?: string | null }>,
): SecurityPathStep[] {
  const byLayer = new Map(observed.map((o) => [o.layer, o]));
  const steps: SecurityPathStep[] = [];
  let denied = false;

  for (const layer of SECURITY_LAYERS) {
    const seen = byLayer.get(layer);
    if (denied) {
      // Only layers that were actually part of this flow are listed at all.
      if (seen) steps.push({ layer, outcome: "NOT_REACHED", reasonCode: null, detail: null });
      continue;
    }
    if (!seen) continue;
    steps.push({ layer, outcome: seen.outcome, reasonCode: seen.reasonCode ?? null, detail: seen.detail ?? null });
    if (seen.outcome === "DENY") denied = true;
  }
  return steps;
}

/**
 * Assemble a run, and refuse to report one that does not hold together.
 *
 * Three consistency checks, each catching a different way a result could be flattering:
 * a `DENIED` result with no denying layer, a denial with no reason code, and a capability issued
 * after a denial.
 */
export function assembleAttackRun(args: {
  definition: AttackDefinition;
  path: ReadonlyArray<SecurityPathStep>;
  diffs: ReadonlyArray<MutationDiff>;
  capabilityIssued: boolean;
  transactionSubmitted: boolean;
  additionalDefenses?: ReadonlyArray<{ layer: SecurityLayer; reasonCode: string }>;
}): AttackRun {
  const denial = args.path.find((s) => s.outcome === "DENY") ?? null;
  const result = denial ? "DENIED" : "ALLOWED";

  if (denial && denial.reasonCode === null) {
    throw new AttackLabError(ATTACK_REASONS.PATH_INCONSISTENT, `${args.definition.scenario}: a layer denied without a reason code, which is not evidence of anything`);
  }
  /*
   * A capability after a denial is only inconsistent when the denial came BEFORE the issuer.
   *
   * A replay attack legitimately holds a capability — a genuine one, being reused — and is refused
   * at the executor, downstream of where it was issued. An unconditional check called that
   * combination a contradiction and would have forced the replay scenario to misreport itself.
   */
  const issuerIndex = SECURITY_LAYERS.indexOf("CAPABILITY_ISSUER");
  if (denial && args.capabilityIssued && SECURITY_LAYERS.indexOf(denial.layer) < issuerIndex) {
    throw new AttackLabError(
      ATTACK_REASONS.PATH_INCONSISTENT,
      `${args.definition.scenario}: the path says ${denial.layer} denied, upstream of the capability issuer, and a capability was issued anyway. One of those is wrong.`,
    );
  }
  if (args.transactionSubmitted && !args.capabilityIssued) {
    throw new AttackLabError(ATTACK_REASONS.PATH_INCONSISTENT, `${args.definition.scenario}: a transaction was submitted with no capability`);
  }

  return AttackRunSchema.parse({
    scenario: args.definition.scenario,
    title: args.definition.title,
    result,
    stoppedBy: denial?.layer ?? null,
    reasonCode: denial?.reasonCode ?? null,
    stoppedWhereExpected: denial?.layer === args.definition.expectedStoppedBy,
    diffs: [...args.diffs],
    path: [...args.path],
    capabilityIssued: args.capabilityIssued,
    transactionSubmitted: args.transactionSubmitted,
    additionalDefenses: [...(args.additionalDefenses ?? [])],
  });
}

/**
 * Refuse to list a defence that was not exercised.
 *
 * §P28.39: *only list defenses actually tested*. The mainnet-write attack is refused at several
 * layers and it is tempting to list all ten fences — but a list of defences includes ones nobody
 * ran, and the reader cannot tell which. `exercised` is the set the run actually drove.
 */
export function assertDefensesExercised(
  claimed: ReadonlyArray<{ layer: SecurityLayer; reasonCode: string }>,
  exercised: ReadonlySet<SecurityLayer>,
  context: string,
): void {
  const unexercised = claimed.filter((c) => !exercised.has(c.layer)).map((c) => c.layer);
  if (unexercised.length > 0) {
    throw new AttackLabError(
      ATTACK_REASONS.UNEXERCISED_DEFENSE,
      `${context}: ${unexercised.join(", ")} ${unexercised.length > 1 ? "are" : "is"} listed as a defence and was not exercised in this run. A defence nobody ran is a claim, not a result.`,
    );
  }
}

/** The one-line summary. Names the layer, because "DENIED" alone is what this file exists to improve on. */
export function attackSummary(run: AttackRun): string {
  if (run.result === "NOT_RUN") return `${run.title}: not run`;
  if (run.result === "ALLOWED") return `${run.title}: NOT STOPPED — no layer refused it`;
  return `${run.title}: DENIED by ${run.stoppedBy} (${run.reasonCode})${run.stoppedWhereExpected ? "" : " — stopped by a different layer than expected"}`;
}
