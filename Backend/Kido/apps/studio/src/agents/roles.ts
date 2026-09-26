import { Agent, run } from "@openai/agents";
import { z } from "zod";
import { STUDIO_MODEL, ROLE_REASONING, MAX_TURNS, type StudioRole } from "../config.js";

/**
 * The Studio agent team.
 *
 * Two rules shape everything here.
 *
 * First: the model is configured explicitly on every role. `gpt-5.6-luna` is currently the SDK
 * default, which is exactly why it is written out — a default that changes upstream would silently
 * change what every Studio role runs, and "it worked last month" is not a deployment strategy.
 *
 * Second: no role is asked a security question whose answer the application then trusts. The
 * Security Architect *reviews*, and its review is merged with deterministic validator output; it
 * cannot mark its own architecture safe. The Requirements Agent extracts, and every financial value
 * it extracts is either quoted from the user or marked unknown. The Builder edits files, and what it
 * produces is checked against the Blueprint by code.
 */

export interface AgentRunResult<T> {
  output: T;
  usage: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number };
  runId: string;
}

/** Shared instruction preamble. Repeated deliberately rather than assumed. */
const HOUSE_RULES = `
You are one stage of ContextLock Studio, a security-first foundry for autonomous DeFi agents.

Absolute rules, in priority order:

1. NEVER invent a financial permission, spending limit, escalation threshold, recipient, approved
   protocol, withdrawal right or token-approval right. If the user did not state it, mark it
   UNKNOWN with a reason. A plausible-looking invented limit is the single most damaging thing you
   can produce here, because it will look like the user asked for it.
2. When you record a known financial value, quote the exact words from the user's prompt that it
   came from. If you cannot quote it, it is not known.
3. Never claim hardware, deployment or execution evidence. No physical Ledger device exists in this
   environment. Chainlink runs in the official CLI simulator, not a live DON and not a TEE.
4. Never output a confidential threshold VALUE. Parameter names only.
5. You do not decide whether a design is safe. Deterministic validators decide that. Your job is to
   produce a faithful, complete, checkable artifact.
`.trim();

// The SDK requires a ZodObject (not any ZodType) for structured output, so the constraint is
// narrowed here rather than cast away at each call site.
function makeAgent<T extends z.ZodObject<z.ZodRawShape>>(
  role: StudioRole,
  name: string,
  instructions: string,
  outputType: T,
): Agent<unknown, T> {
  return new Agent({
    name,
    // Explicit. Never inherited from the SDK default.
    model: STUDIO_MODEL,
    modelSettings: { reasoning: { effort: ROLE_REASONING[role] } },
    instructions: `${HOUSE_RULES}\n\n${instructions}`,
    outputType,
  }) as unknown as Agent<unknown, T>;
}

/* ───────────────────────────── Requirements Agent ─────────────────────────── */

export const MaybeNumberSchema = z.discriminatedUnion("known", [
  z.object({ known: z.literal(true), value: z.number(), sourceQuote: z.string() }),
  z.object({ known: z.literal(false), reason: z.string(), requiredBefore: z.enum(["BUILD", "DEPLOY"]) }),
]);

export const RequirementsSchema = z.object({
  objective: z.string(),
  protocols: z.array(z.string()),
  assets: z.array(z.string()),
  allowedActions: z.array(z.string()),
  forbiddenActions: z.array(z.string()),
  autonomousLimitUsd: MaybeNumberSchema,
  escalationFloorUsd: MaybeNumberSchema,
  escalationCeilingUsd: MaybeNumberSchema,
  escalationMechanism: z.enum(["ledger-device", "unspecified"]),
  privateConditions: z.array(z.string()),
  contextDependencies: z.array(z.string()),
  triggers: z.array(z.string()),
  deploymentNetwork: z.enum(["sepolia", "unspecified"]),
  /** Everything the user did not say. Named, so the UI can ask instead of the model guessing. */
  unknowns: z.array(z.object({ field: z.string(), reason: z.string() })),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

export const requirementsAgent = () =>
  makeAgent(
    "requirements",
    "ContextLock Requirements",
    `
Extract structured requirements from the user's description of the DeFi agent they want.

Extract only what the user actually said. A user who says "repay up to $1,000 automatically" has
told you the autonomous limit; a user who says "keep me safe" has not told you anything numeric, and
you must record every financial field as UNKNOWN.

Forbidden actions matter as much as allowed ones. "Never withdraw collateral" is a requirement, not
an absence of one. If the user did not mention withdrawals at all, do NOT add a prohibition and do
NOT add a permission — list it in unknowns.

Amounts are in whole US dollars.
`.trim(),
    RequirementsSchema,
  );

/* ───────────────────────────── Architecture Agent ─────────────────────────── */

export const ArchitectureChoiceSchema = z.object({
  agentId: z.string(),
  ensName: z.string(),
  objective: z.string(),
  /** Semantic topology only. The model never emits coordinates, node ids or edges. */
  requiredModules: z.array(
    z.enum([
      "contextlock-core",
      "ens-identity",
      "cre-confidential-policy",
      "ledger-keyring",
      "ledger-escalation",
      "protocol-adapter",
      "agent-runtime",
      "tests",
    ]),
  ),
  /** Each allowed permission names the action it authorizes, so nothing runs unauthorized. */
  allowedPermissions: z.array(
    z.object({
      statement: z.string(),
      /** One of the action ids listed in the input catalogue, or null if it covers none directly. */
      actionRef: z.string().nullable(),
    }),
  ),
  deniedPermissions: z.array(z.string()),
  confidentialParameterNames: z.array(z.string()),
  capabilityTtlSeconds: z.number().int(),

  /**
   * External data this agent needs, described by REQUIREMENT rather than by provider.
   *
   * The model says "I need an ETH/USD price, verified, no older than 30 seconds". It does not say
   * "use Chainlink". Which adapter satisfies that is resolved deterministically from the registry,
   * so a model preference can never become a trust downgrade.
   */
  dataRequirements: z.array(
    z.object({
      key: z.string(),
      kind: z.string(),
      minimumTrustClass: z.enum([
        "CONFIDENTIAL_VERIFIED_COMPUTE",
        "VERIFIED_ORACLE",
        "INDEXED_CHAIN_DATA",
        "DIRECT_CHAIN_DATA",
        "EXTERNAL_API",
        "USER_UNTRUSTED",
      ]),
      maxAgeMs: z.number().int().positive(),
      historical: z.boolean(),
      justification: z.string(),
    }),
  ),

  /**
   * Execution capabilities the agent needs, by CAPABILITY NAME from the registry (e.g.
   * "TOKEN_SWAP"). Never an adapter id: the compiler resolves the exact adapter and version.
   */
  requiredExecutionCapabilities: z.array(z.string()),

  rationale: z.string(),
});
export type ArchitectureChoice = z.infer<typeof ArchitectureChoiceSchema>;

/* ─────────────────────────── Strategy Agent (P17) ─────────────────────────── */

const OperandProposal = z.union([
  z.object({ type: z.literal("ref"), id: z.string() }),
  z.object({
    type: z.literal("literal"),
    value: z.string(),
    unitKind: z.enum(["TOKEN_AMOUNT", "USD_VALUE", "PRICE", "PERCENT", "BASIS_POINTS", "HEALTH_FACTOR", "TIMESTAMP", "BLOCK_NUMBER", "COUNT", "BOOLEAN"]),
    unitDecimals: z.number().int(),
    unitSubject: z.string().nullable(),
  }),
]);

export const StrategyProposalSchema = z.object({
  planId: z.string(),
  triggers: z.array(z.object({ id: z.string(), kind: z.enum(["threshold", "schedule", "evm-event", "manual"]), description: z.string() })),
  inputs: z.array(
    z.object({
      id: z.string(),
      requirementKey: z.string(),
      dataKind: z.string(),
      unitKind: z.enum(["TOKEN_AMOUNT", "USD_VALUE", "PRICE", "PERCENT", "BASIS_POINTS", "HEALTH_FACTOR", "TIMESTAMP", "BLOCK_NUMBER", "COUNT", "BOOLEAN"]),
      unitDecimals: z.number().int(),
      unitSubject: z.string().nullable(),
      minimumTrustClass: z.enum(["CONFIDENTIAL_VERIFIED_COMPUTE", "VERIFIED_ORACLE", "INDEXED_CHAIN_DATA", "DIRECT_CHAIN_DATA", "EXTERNAL_API", "USER_UNTRUSTED"]),
      maxAgeMs: z.number().int().positive(),
      description: z.string(),
    }),
  ),
  transforms: z.array(
    z.object({
      id: z.string(),
      op: z.enum(["TOKEN_TO_USD", "RATIO_TO_BPS", "SUM", "DIFFERENCE", "PERCENT_TO_BPS", "RESCALE"]),
      inputs: z.array(z.string()),
      toDecimals: z.number().int().nullable(),
      description: z.string(),
    }),
  ),
  decisions: z.array(
    z.object({
      id: z.string(),
      compareOp: z.enum(["LT", "LTE", "GT", "GTE", "EQ", "NEQ"]),
      left: OperandProposal,
      right: OperandProposal,
      actionRef: z.string(),
      autonomousMaxUsdCents: z.number().int().nullable(),
      escalationMaxUsdCents: z.number().int().nullable(),
      description: z.string(),
    }),
  ),
  actions: z.array(
    z.object({
      id: z.string(),
      capability: z.string(),
      actionKind: z.string(),
      spendsAsset: z.string().nullable(),
      recipientPolicy: z.enum(["self-only", "allow-list"]),
      description: z.string(),
    }),
  ),
  unknowns: z.array(z.object({ field: z.string(), reason: z.string(), requiredBefore: z.enum(["BUILD", "DEPLOY"]) })),
  /** Set when the strategy genuinely needs more than one transaction. */
  needsMultiStepPlan: z.boolean(),
  rationale: z.string(),
});
export type StrategyProposal = z.infer<typeof StrategyProposalSchema>;

export const strategyAgent = () =>
  makeAgent(
    "architecture",
    "ContextLock Strategy Compiler",
    `
Turn the user's description into a typed strategy graph: inputs, transforms, decisions, actions.

You PROPOSE this graph. A deterministic compiler then type-checks it, unit-checks it, and verifies
that every action has a policy disposition. A proposal that fails those checks is rejected with a
reason — it is not negotiated.

UNITS are the thing to get right, and the thing most easily got wrong:

- Every value carries a unit KIND, DECIMALS and, where relevant, a SUBJECT.
- A health factor is HEALTH_FACTOR at 18 decimals. 1.6 is "1600000000000000000".
- A USD value is USD_VALUE at 8 decimals unless stated otherwise. $1,000 is "100000000000".
- A percentage threshold is best expressed as BASIS_POINTS at 4 decimals: 40% is "4000".
- A token amount is TOKEN_AMOUNT with the token's own decimals and its symbol as the subject.
- You cannot compare across kinds, subjects or scales. If a comparison needs a conversion, add a
  transform: TOKEN_TO_USD, RATIO_TO_BPS, PERCENT_TO_BPS or RESCALE.

DECISIONS:

- Every action must be routed by at least one decision. There is no "condition true therefore
  execute" — the compiler rejects an action nothing decides.
- autonomousMaxUsdCents and escalationMaxUsdCents are in US CENTS. $500 is 50000.
- If the user did not state a limit, put it in unknowns with requiredBefore "BUILD" and leave the
  field null. NEVER invent a plausible-looking number. A boundary the user never stated is the one
  thing you must not supply.

needsMultiStepPlan: set TRUE when the strategy genuinely needs more than one transaction — for
example "if I have enough USDC repay, otherwise swap something first and then repay". Do not
approximate it as a single action. Recognising the need is the correct answer; the multi-step
capability does not exist yet and inventing a single-transaction stand-in would be worse than
saying so.
`.trim(),
    StrategyProposalSchema,
  );

export const runStrategy = (input: string, o: RunOpts = {}) =>
  runAgentInternal<StrategyProposal>("architecture", strategyAgent(), input, o);

/* ─────────────────────── organization ─────────────────────── */

export const OrganizationProposalSchema = z.object({
  orgName: z.string(),
  rootEns: z.string(),
  agents: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      ensLabel: z.string(),
      /** NONE for an agent that only reads. The Studio enforces it; it is not a hint. */
      executionClass: z.enum(["NONE", "READ_ONLY", "EXECUTE"]),
      executionCapabilities: z.array(z.string()),
      dataCapabilities: z.array(z.string()),
      autonomousMaxUsdCents: z.number().int().nullable(),
      escalationMaxUsdCents: z.number().int().nullable(),
      dailyMaxUsdCents: z.number().int().nullable(),
      deniedActions: z.array(z.string()),
      purpose: z.string(),
    }),
  ),
  sharedResources: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["treasury", "data-source", "credential"]),
      description: z.string(),
      agentIds: z.array(z.string()),
    }),
  ),
  aggregateLimits: z.array(
    z.object({
      id: z.string(),
      maxUsdCents: z.number().int().nullable(),
      windowMs: z.number().int().positive(),
      description: z.string(),
    }),
  ),
  communicationRules: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      messageKinds: z.array(z.enum(["observation", "request", "status"])),
      why: z.string(),
    }),
  ),
  unknowns: z.array(z.object({ field: z.string(), reason: z.string(), requiredBefore: z.enum(["BUILD", "DEPLOY"]) })),
  rationale: z.string(),
});
export type OrganizationProposal = z.infer<typeof OrganizationProposalSchema>;

export const organizationAgent = () =>
  makeAgent(
    "architecture",
    "ContextLock Organization",
    `
Split the user's description into separate agents under one organization.

Each agent is a SEPARATE SECURITY PRINCIPAL, not a persona. It gets its own ENS identity, its own
policy, its own execution domain and its own limits. The reason is blast radius: if one agent is
compromised, nothing about the others should be reachable through it.

So the question to ask of every boundary you draw is not "would a human split this role?" but
"would I be content for whoever takes this agent to hold everything on this side of the line?"

Rules you cannot bend, because the deterministic validator enforces them and will reject the build:

- Never give two agents the same policy, the same execution domain, or the same ENS label.
- An agent that only reads and reports gets executionClass NONE and an EMPTY executionCapabilities
  list. Do not give it a capability "just in case" — the point of a reporting agent is that taking
  it wins the attacker nothing.
- A capability that moves value (withdraw, borrow, transfer, swap, repay, approve) belongs in
  executionCapabilities on an EXECUTE agent. It is never a data capability.
- Never share a credential between agents. A shared credential is a shared principal.
- If several executing agents draw on one treasury, propose an aggregate limit. Without one the
  organization's exposure is the SUM of every agent's limit, which is never what the user meant.
- Set the aggregate BELOW the sum of the per-agent daily caps. An aggregate at or above that sum
  can never bind, and the user will believe it protects them.

THE ENS ROOT is the one field you must never fill in from imagination.

Every other omission here is a number the user forgot. This one is a NAME, and a plausible guess
like "acme.eth" is very likely registered to a stranger. Set rootEns ONLY if the user's description
names a domain they control. Otherwise return an EMPTY STRING and record it in unknowns with
requiredBefore "BUILD" — the Studio will ask them for it.

LIMITS are in US CENTS. $500 is 50000.

If the user did not state a limit, set the field to null and record it in unknowns with
requiredBefore "BUILD". Never invent one. An invented ceiling is indistinguishable from a real one
once it is written down, and this is the single most damaging thing you can do here.

COMMUNICATION: propose only channels the user's description actually needs, and say why. A message
between agents is untrusted data — it can inform a decision, never authorise one. There is no way
for one agent to grant another authority, so do not describe one.
`.trim(),
    OrganizationProposalSchema,
  );

export const runOrganization = (input: string, o: RunOpts = {}) =>
  runAgentInternal<OrganizationProposal>("architecture", organizationAgent(), input, o);

export const architectureAgent = () =>
  makeAgent(
    "architecture",
    "ContextLock Architecture",
    `
Choose which verified ContextLock modules this agent needs, and state its permissions.

You are composing audited modules, not designing security primitives. Do not propose regenerating
the executor, the capability schema or the policy function — they exist and are tested.

Rules:
- Any agent touching money needs contextlock-core, ens-identity, agent-runtime and tests.
- If the user described a private/confidential condition, include cre-confidential-policy.
- If the user described human approval for a value band, include ledger-escalation.
- confidentialParameterNames are NAMES ONLY. Never a value.
- capabilityTtlSeconds should be short: tens of seconds, not hours.

deniedPermissions — read this carefully, it is the most common way to produce a broken design:

- State a denial ONLY for something the user actually prohibited. "Never withdraw collateral" is a
  denial. "The user did not mention token approvals" is NOT a denial, and writing one anyway is
  inventing a permission boundary the user never asked for.
- A denial must be as NARROW as the user's words. If you are recording a precaution rather than
  quoting the user, scope it: write "arbitrary token approval" or "unlimited token approval", never
  a blanket "token approvals are not granted".
  A blanket approval denial contradicts any action that needs an approval to function — including
  ordinary repayment — and the deterministic validator will reject the whole design as
  self-contradictory. The deny list is not free: every entry has to be compatible with the actions
  you are also asking for.
- allowedPermissions must cover EVERY action the agent may take autonomously, including enabling
  ones. If the agent may add collateral, say so, and set its actionRef. An action with no matching
  permission is rejected by deterministic validation.
- Do not restate the same prohibition several times in different words.

dataRequirements — describe WHAT you need, never WHO provides it:

- A price used to decide whether to move money needs VERIFIED_ORACLE. An indexer's price is a price
  that was true at some block, and substituting one for the other is the mistake this field exists
  to prevent.
- Historical or aggregate activity (volumes, past transfers, position history) is INDEXED_CHAIN_DATA
  and should say so — demanding VERIFIED_ORACLE for it will simply fail to resolve.
- Current on-chain state read from a node is DIRECT_CHAIN_DATA.
- maxAgeMs must reflect the decision AND be achievable. The catalogue gives
  minAchievableMaxAgeMs for every kind — never ask for a bound tighter than that. On-chain reads
  cannot beat a block time, so demanding sub-second freshness for a lending position produces a
  requirement nothing can satisfy and the build stops.
- Do NOT name a provider. Naming Chainlink or The Graph here has no effect: the compiler resolves
  adapters from the registry by requirement, and a named preference cannot lower a trust bar.

requiredExecutionCapabilities — capability names only, e.g. "TOKEN_SWAP". Include one only if the
agent actually executes that kind of action. An agent that repays a loan does not need TOKEN_SWAP.

You will be given a CATALOGUE of the data kinds, execution capabilities and action ids the registry
actually offers. Choose every "kind" value and every requiredExecutionCapabilities entry from that
catalogue, and set every allowedPermissions[].actionRef to one of the listed action ids.

The catalogue's "protocols" entry lists each protocol the Studio can build against — Aave v3,
Morpho Blue, Compound v3, Lido, and a DEX router for swaps — with the action ids each one offers
and what each action spends. Match the user's words to the protocol they named: a Morpho position
is guarded with "morpho-repay" / "morpho-supply-collateral", a Compound v3 position with
"compound-repay" / "compound-supply", ETH is staked with "stake-eth", an Aave position with
"repay-debt" / "add-collateral", and a portfolio is rebalanced on Uniswap with "swap-tokens"
(also set requiredExecutionCapabilities to include "TOKEN_SWAP"). An agent may use several
protocols when the user asked for several — if the prompt names five, the design names five. A protocol the user named that is NOT in the catalogue (Spark, Euler, …) must not be
mapped onto a different one — say so in the rationale and leave the action out, so the review can
tell the user rather than build the wrong agent.

Inventing a "kind" that is not in the catalogue does not create a data source — it produces a
requirement nothing can satisfy, and the build stops. If the agent genuinely needs data the
catalogue does not offer, say so in the rationale rather than inventing a name for it.

Do NOT emit graph coordinates, node ids or edges. A deterministic layout engine derives the diagram
from the Blueprint.
`.trim(),
    ArchitectureChoiceSchema,
  );

/* ──────────────────────────── Security Architect ──────────────────────────── */

export const SecurityReviewSchema = z.object({
  findings: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]),
      path: z.string(),
      message: z.string(),
      remediation: z.string(),
    }),
  ),
  /**
   * The model's own opinion, recorded but NOT trusted. The application computes buildability from
   * the deterministic validator and treats this field as advisory commentary.
   */
  modelOpinion: z.string(),
});
export type SecurityReview = z.infer<typeof SecurityReviewSchema>;

export const securityArchitectAgent = () =>
  makeAgent(
    "security",
    "ContextLock Security Architect",
    `
Review a proposed Blueprint for security problems a deterministic validator might not phrase well.

You will be shown the deterministic validator's findings. Do not repeat them; look for what they
miss — over-broad permissions, a denial that is missing, an unsafe approval, an exposure created by
the combination of two individually reasonable choices.

You cannot approve anything. Your findings are merged with the validator's, and the validator alone
decides whether the Blueprint is buildable. Saying "this looks safe" has no effect and wastes a
turn; if you find nothing, return an empty findings array and say so plainly in modelOpinion.

Never assert that hardware, deployment or TEE evidence exists.
`.trim(),
    SecurityReviewSchema,
  );

/* ────────────────────────────── Final Reviewer ────────────────────────────── */

export const FinalReviewSchema = z.object({
  readiness: z.enum(["EXPORT_READY", "NEEDS_USER_REVIEW", "NOT_READY"]),
  summary: z.string(),
  discrepancies: z.array(z.string()),
  honestyCheck: z.object({
    claimsHardwareEvidence: z.boolean(),
    claimsLiveCreDeployment: z.boolean(),
    claimsTeeExecution: z.boolean(),
    exposesConfidentialValues: z.boolean(),
  }),
});
export type FinalReview = z.infer<typeof FinalReviewSchema>;

export const finalReviewerAgent = () =>
  makeAgent(
    "reviewer",
    "ContextLock Final Reviewer",
    `
Read-only. You cannot edit anything.

Compare the original request, the requirements, the Blueprint, the generated file list, the test
results and the simulation results. Report discrepancies between what was asked for and what was
built.

The honestyCheck fields are the important output. Set a flag TRUE if any artifact claims something
that did not happen: physical Ledger evidence, a live CRE deployment, TEE execution, or a
confidential threshold value appearing in a rendered artifact. Being wrong in the cautious
direction here is fine; being wrong in the reassuring direction is not.
`.trim(),
    FinalReviewSchema,
  );

/* ─────────────────────────────── run wrapper ──────────────────────────────── */

export class UpstreamRateLimitError extends Error {
  constructor(readonly attempts: number) {
    super(`upstream rate limit persisted after ${attempts} attempts`);
    this.name = "UpstreamRateLimitError";
  }
}

/**
 * Run one agent with a bounded turn count and bounded retries.
 *
 * Retries are for upstream 429s only, and they deliberately do NOT re-charge the user's build
 * credit: the caller reserves quota once, around this whole call. An SDK retry is the platform's
 * problem, not the user's.
 */
async function runAgentInternal<T>(
  role: StudioRole,
  // `Agent` is invariant in its output type, so a specific role's agent is not assignable to a
  // general one. Rather than widen every role's schema (which would lose the structured typing that
  // makes the output checkable), the variance is absorbed here and each role exports its own
  // precisely-typed runner below.
  agent: Agent<any, any>,
  input: string,
  opts: { maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<AgentRunResult<T>> {
  const maxRetries = opts.maxRetries ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await run(agent, input, { maxTurns: MAX_TURNS[role] });
      const u = result.state.usage;
      return {
        output: result.finalOutput as T,
        usage: {
          requests: u.requests,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          totalTokens: u.totalTokens,
        },
        runId: `run_${role}_${Date.now().toString(36)}_${attempt}`,
      };
    } catch (err) {
      lastErr = err;
      const msg = String((err as Error)?.message ?? err);
      const isRateLimit = /429|rate limit|too many requests/i.test(msg);
      if (!isRateLimit || attempt === maxRetries) break;
      await sleep(Math.min(2 ** attempt * 500, 8_000));
    }
  }
  if (/429|rate limit|too many requests/i.test(String((lastErr as Error)?.message ?? lastErr))) {
    throw new UpstreamRateLimitError(maxRetries + 1);
  }
  throw lastErr;
}


/* ─────────────────────── precisely-typed role runners ─────────────────────── */

export type RunOpts = { maxRetries?: number; sleep?: (ms: number) => Promise<void> };

export const runRequirements = (input: string, o: RunOpts = {}) =>
  runAgentInternal<Requirements>("requirements", requirementsAgent(), input, o);

export const runArchitecture = (input: string, o: RunOpts = {}) =>
  runAgentInternal<ArchitectureChoice>("architecture", architectureAgent(), input, o);

export const runSecurityArchitect = (input: string, o: RunOpts = {}) =>
  runAgentInternal<SecurityReview>("security", securityArchitectAgent(), input, o);

export const runFinalReviewer = (input: string, o: RunOpts = {}) =>
  runAgentInternal<FinalReview>("reviewer", finalReviewerAgent(), input, o);
