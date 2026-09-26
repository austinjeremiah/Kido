import { z } from "zod";
import { MaybeUnknown } from "./unknown.js";

export const BLUEPRINT_SCHEMA_VERSION = "contextlock.agent.blueprint/v1" as const;

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address");
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase kebab id");

/* ─────────────────────────── identity & objective ─────────────────────────── */

export const IdentitySchema = z.object({
  agentId: idSchema,
  /** ENSv2 name the agent's identity is bound to. */
  ensName: z.string().min(3),
  network: z.literal("sepolia"),
  chainId: z.literal(11155111),
  /** Address the agent runtime signs its *requests* with. It holds no financial authority. */
  agentAddress: MaybeUnknown(addressSchema),
});

/* ────────────────────────────── protocols & assets ────────────────────────── */

export const ProtocolSchema = z.object({
  id: idSchema,
  displayName: z.string().min(1),
  kind: z.enum(["lending", "dex", "staking", "mock"]),
  chainId: z.literal(11155111),
  /** Every contract the agent may ever be authorized to call, enumerated. */
  contracts: z.array(z.object({ role: z.string().min(1), address: MaybeUnknown(addressSchema) })).min(1),
});

export const AssetSchema = z.object({
  symbol: z.string().min(1).max(16),
  address: MaybeUnknown(addressSchema),
  decimals: z.number().int().min(0).max(36),
  chainId: z.literal(11155111),
});

/* ──────────────────────────────── triggers ────────────────────────────────── */

export const TriggerSchema = z.object({
  id: idSchema,
  kind: z.enum(["threshold", "schedule", "evm-event", "manual"]),
  description: z.string().min(1),
  /**
   * True when the numeric threshold that fires this trigger is confidential. The value itself is
   * NEVER stored in the Blueprint — only the fact that one exists and where it lives.
   */
  thresholdIsConfidential: z.boolean(),
  confidentialParameterName: z.string().optional(),
  publicThreshold: MaybeUnknown(z.string()).optional(),
});

/* ───────────────────────────────── actions ────────────────────────────────── */

/**
 * How a call target is chosen. `arbitrary` is the dangerous one and is deliberately verbose:
 * choosing it requires a written justification that a human reads.
 */
export const TargetPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("fixed-allowlist"), allowed: z.array(MaybeUnknown(addressSchema)).min(1) }),
  z.object({ mode: z.literal("protocol-resolved"), protocolRef: idSchema, contractRole: z.string().min(1) }),
  z.object({ mode: z.literal("arbitrary"), justification: z.string().min(40) }),
]);

export const RecipientPolicySchema = z.discriminatedUnion("mode", [
  /** Value can only ever return to the position/account it came from. */
  z.object({ mode: z.literal("self-only") }),
  z.object({ mode: z.literal("fixed-allowlist"), allowed: z.array(MaybeUnknown(addressSchema)).min(1) }),
  z.object({ mode: z.literal("arbitrary"), justification: z.string().min(40) }),
]);

export const ActionSchema = z.object({
  id: idSchema,
  /** Stable kind used to derive the on-chain actionKind hash. */
  kind: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  displayName: z.string().min(1),
  protocolRef: idSchema,
  targetPolicy: TargetPolicySchema,
  recipientPolicy: RecipientPolicySchema,
  /** Assets that leave the user's control when this action runs. */
  spendsAssets: z.array(z.string()),
  /** Token approvals this action requires, if any. */
  approvals: z.array(
    z.object({
      assetSymbol: z.string(),
      spenderRole: z.string(),
      unlimited: z.literal(false),
      maxAmountPolicy: z.enum(["exact-action-amount", "declared-cap"]),
    }),
  ),
});

/* ─────────────────────────────── permissions ──────────────────────────────── */

export const PermissionSchema = z.object({
  id: idSchema,
  statement: z.string().min(1),
  actionRef: idSchema.optional(),
});

export const PermissionsSchema = z.object({
  allowed: z.array(PermissionSchema),
  /**
   * Denials are not the complement of the allow list. They are explicit, because "we never
   * mentioned withdrawals" and "withdrawals are forbidden" produce identical allow lists and very
   * different agents. The validator requires the dangerous ones to be named.
   */
  denied: z.array(PermissionSchema).min(1),
});

/* ────────────────────────── autonomy & escalation ─────────────────────────── */

export const AutonomousPolicySchema = z.object({
  /** Upper bound, in USD cents, on what may execute with no human involved. */
  maxValueUsdCents: MaybeUnknown(z.number().int().nonnegative()),
  /** Actions permitted to run autonomously; must be a subset of permissions.allowed. */
  allowedActionRefs: z.array(idSchema),
});

/**
 * A per-action tightening of the global limits.
 *
 * The canonical P28 prompt asks for two different limit sets in one agent — $1,000/$5,000 for debt
 * repayment and $500/$2,000 for treasury rebalancing. A single global pair cannot express that, and
 * the two ways of forcing it are both silent lies: take the minimum and the repayment limits the
 * user asked for are quietly tightened; take the maximum and the rebalancing limits are quietly
 * loosened. The second is the dangerous one — a rebalance running autonomously at $1,000 when the
 * user said $500.
 *
 * **A per-action entry may only tighten.** The global limits stay the ceiling, and `validateBlueprint`
 * refuses an entry that exceeds them. That is what makes adding one safe rather than another place a
 * limit can be widened: the worst a malicious or mistaken entry can do is make an agent stricter.
 */
export const PerActionLimitSchema = z.object({
  actionRef: idSchema,
  /** Must be ≤ the global autonomous limit. */
  autonomousMaxUsdCents: MaybeUnknown(z.number().int().nonnegative()),
  escalationMinUsdCents: MaybeUnknown(z.number().int().nonnegative()),
  /** Must be ≤ the global hard cap. */
  escalationMaxUsdCents: MaybeUnknown(z.number().int().nonnegative()),
  /** The user's own words this tightening came from, like every other financial value. */
  sourceQuote: z.string().min(1).max(500),
});

export const EscalationPolicySchema = z.object({
  /** Range requiring a human. Above `maxValueUsdCents` the verdict is DENY, not "ask harder". */
  minValueUsdCents: MaybeUnknown(z.number().int().nonnegative()),
  maxValueUsdCents: MaybeUnknown(z.number().int().nonnegative()),
  mechanism: z.enum(["ledger-device", "approval-registry-standin"]),
  /**
   * Structural, not advisory. The executor has no branch from DENY to execution; this field exists
   * so the Blueprint asserts it and the validator can refuse any design that sets it false.
   */
  denyIsTerminal: z.literal(true),
});

/* ─────────────────────── confidential policy (names only) ─────────────────── */

export const ConfidentialPolicySchema = z.object({
  required: z.boolean(),
  placement: z.enum(["cre-confidential", "none"]),
  /**
   * Parameter NAMES only. A Blueprint that carried the values would put the confidential policy
   * into every artifact derived from it — the graph, the export, the report. The schema makes that
   * unrepresentable rather than discouraged.
   */
  parameterNames: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{1,63}$/)),
  reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/)),
});

/* ───────────────────────────── context sources ────────────────────────────── */

/*
 * The trust enum is defined once, in the adapter kernel, and re-exported here.
 *
 * The V2 Bible names it twice with different members — §4 uses RPC_DIRECT/INDEXED, §12.7 uses
 * DIRECT_CHAIN_DATA/INDEXED_CHAIN_DATA and adds EXTERNAL_API. Two spellings of a security-relevant
 * enum is how a trust check ends up comparing values that never match. §12.7 is the later and more
 * complete list and is authoritative here; see FND-V2-006.
 */
export { DataTrustClassSchema } from "@contextlock/studio-adapters";
import { DataTrustClassSchema } from "@contextlock/studio-adapters";

export const ContextSourceSchema = z.object({
  id: idSchema,
  dataKind: z.string().min(1),
  minimumTrustClass: DataTrustClassSchema,
  maxAgeMs: z.number().int().positive(),
  /** A silent downgrade to a weaker source is the thing this forbids. */
  fallbackAllowed: z.boolean(),
  placement: z.enum(["broker", "cre-confidential", "generated-agent"]),
});

/* ───────────────────────────── capability policy ──────────────────────────── */

export const CapabilityBindingSchema = z.enum([
  "chainId",
  "target",
  "calldataHash",
  "value",
  "nonce",
  "expiry",
  "agentIdentityHash",
  "policyHash",
  "authorizationId",
]);

export const CapabilityPolicySchema = z.object({
  ttlSeconds: z.number().int().min(15).max(3600),
  nonceStrategy: z.literal("on-chain-sequential"),
  bindings: z.array(CapabilityBindingSchema),
});

/* ─────────────────────────── sponsor requirements ─────────────────────────── */

export const EnsRequirementsSchema = z.object({
  required: z.literal(true),
  /** Identity must be read at execution time. A cached identity cannot be revoked. */
  identityReadAt: z.literal("execution-time"),
  revocationInvalidatesOutstanding: z.literal(true),
  /**
   * Guards against the mistake the ContextLock threat model calls out by name: representing a
   * spending permission as an ENS registry role. ENS answers *who*, never *how much*.
   */
  financialPermissionsInEns: z.literal(false),
});

export const CreRequirementsSchema = z.object({
  required: z.boolean(),
  mode: z.enum(["official-cli-simulator", "cre-live", "none"]),
  confidentialHandler: z.boolean(),
  verdicts: z.array(z.enum(["ALLOW", "ESCALATE", "DENY"])),
});

export const LedgerRequirementsSchema = z.object({
  keyRingRequired: z.boolean(),
  humanApprovalRequired: z.boolean(),
  /** Set only by hardware evidence. The Studio never sets it from software behaviour. */
  physicalDeviceEvidence: z.literal(false),
  blockerRef: z.string().optional(),
});

/* ──────────────────────────────── execution ───────────────────────────────── */

export const ExecutionSchema = z.object({
  chainId: z.literal(11155111),
  executorAddress: MaybeUnknown(addressSchema),
  relayerSubmits: z.literal(true),
  /** The agent never submits a transaction and never holds a key. Both are asserted, then checked. */
  agentHoldsNoKey: z.literal(true),
  agentHoldsCapabilityIssuerKey: z.literal(false),
  agentHoldsProtocolAdminKey: z.literal(false),
});

/* ─────────────────────────── adapter bindings ─────────────────────────────── */

/**
 * A pinned adapter the Blueprint depends on.
 *
 * Versions are exact, never ranges. Registering a newer adapter must not change what an existing
 * build resolves to: every simulation result recorded against this Blueprint was produced with a
 * specific adapter version, and silently swapping it would invalidate that evidence with nothing
 * saying so. Upgrades are an explicit revision of the Blueprint.
 */
export const BlueprintAdapterBindingSchema = z.object({
  adapterId: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
  adapterVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "exact version, never a range"),
  role: z.enum(["EXECUTION", "STATE_DATA", "VERIFIED_MARKET_DATA", "EXTERNAL_CONTEXT", "TRIGGER", "CROSS_CHAIN"]),
  /** Blueprint-local name this binding serves, matching a dataRequirement key where applicable. */
  configRef: z.string().min(1),
  /** Why this adapter, in the resolver's words. Deterministic, so it can be diffed. */
  rationale: z.string().default(""),
});

export const DataRequirementSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  kind: z.string().min(1),
  subject: z.string().optional(),
  chainId: z.literal(11155111),
  unit: z.string().optional(),
  minimumTrustClass: DataTrustClassSchema,
  maxAgeMs: z.number().int().positive(),
  confidential: z.boolean().default(false),
  historical: z.boolean().default(false),
  fallback: z
    .object({
      adapterId: z.string(),
      adapterVersion: z.string(),
      allowedTrust: DataTrustClassSchema,
      maxAgeMs: z.number().int().positive(),
    })
    .optional(),
});

/* ────────────────────────── simulation & modules ──────────────────────────── */

export const BASELINE_SCENARIOS = [
  "NORMAL",
  "PROMPT_INJECTION",
  "AMOUNT_MUTATION",
  "RECIPIENT_MUTATION",
  "TARGET_MUTATION",
  "REPLAY",
  "ENS_REVOCATION",
  "STALE_CONTEXT",
  "POLICY_CHANGE",
  "RPC_FAILURE",
] as const;

export const AAVE_SCENARIOS = [
  "HEALTH_FACTOR_DROP",
  "FLASH_CRASH",
  "COLLATERAL_RECOVERY",
  "REPAY_ABOVE_AUTO_LIMIT",
] as const;

export const PRIVATE_CONTEXT_SCENARIOS = [
  "PRIVATE_CONTEXT_ALLOW",
  "PRIVATE_CONTEXT_ESCALATE",
  "PRIVATE_CONTEXT_DENY",
] as const;

/**
 * Scenario ids.
 *
 * The built-in sets are enumerated; adapter-contributed ids are accepted by SHAPE rather than by
 * name. Listing `UNI-*`, `GRAPH-*` and `CLDATA-*` here would put provider names into the core
 * schema, which is precisely the coupling the adapter kernel exists to remove — every new provider
 * would mean editing this enum.
 *
 * The ids an adapter may contribute are still bounded: they come from its registered manifest's
 * `simulationProviders`, which the registry validates.
 */
export const ScenarioIdSchema = z.union([
  z.enum([...BASELINE_SCENARIOS, ...AAVE_SCENARIOS, ...PRIVATE_CONTEXT_SCENARIOS]),
  z.string().regex(/^[A-Z][A-Z0-9_-]{2,63}$/, "adapter scenario ids are uppercase, digits, _ and -"),
]);

export const SimulationScenarioSchema = z.object({
  scenarioId: ScenarioIdSchema,
  description: z.string().min(1),
  expectedVerdict: z.enum(["ALLOW", "ESCALATE", "DENY", "NO_VERDICT"]),
  expectedOutcome: z.enum(["EXECUTED", "BLOCKED", "APPROVAL_REQUIRED"]),
  /** Which control is expected to stop it. "Blocked" without a stage is not evidence. */
  expectedStopStage: z
    .enum(["IDENTITY", "POLICY", "CRE", "APPROVAL", "CAPABILITY", "EXECUTION", "NONE"]) ,
});

export const GeneratedModuleSchema = z.object({
  moduleId: idSchema,
  kind: z.enum([
    "contextlock-core",
    "ens-identity",
    "cre-confidential-policy",
    "ledger-keyring",
    "ledger-escalation",
    "protocol-adapter",
    "context-adapter",
    "agent-runtime",
    "tests",
    "adapter-runtime",
    "adapter-types",
    "adapter-tests",
    "adapter-config",
  ]),
  /** Path inside the generated project. The artifact validator checks this actually exists. */
  path: z.string().min(1),
  templateRef: z.string().min(1),
  /** Reuse the audited implementation rather than regenerating it. */
  reusesContextLockCore: z.boolean(),
});

export const SecurityAssertionSchema = z.object({
  id: z.string().regex(/^SA-[0-9]{3}$/),
  statement: z.string().min(1),
  /** The scenario or test that proves it. An assertion with no evidence scores zero. */
  provenBy: z.array(z.string()).min(1),
});

/* ──────────────────────────── the whole thing ─────────────────────────────── */

export const ContextLockAgentBlueprintSchema = z.object({
  schemaVersion: z.literal(BLUEPRINT_SCHEMA_VERSION),
  blueprintId: z.string().min(1),
  revision: z.number().int().positive(),
  createdAt: z.string(),

  identity: IdentitySchema,
  objective: z.string().min(1),

  protocols: z.array(ProtocolSchema).min(1),
  assets: z.array(AssetSchema).min(1),

  triggers: z.array(TriggerSchema).min(1),
  actions: z.array(ActionSchema).min(1),

  permissions: PermissionsSchema,

  autonomousPolicy: AutonomousPolicySchema,
  escalationPolicy: EscalationPolicySchema,
  /**
   * Per-action tightenings. Empty by default, so every Blueprint written before this stays valid and
   * every agent without one keeps exactly the limits it had.
   */
  perActionLimits: z.array(PerActionLimitSchema).default([]),
  confidentialPolicy: ConfidentialPolicySchema,

  contextSources: z.array(ContextSourceSchema),

  /**
   * Adapter kernel bindings (P12). Optional so every Phase 11 Blueprint stays valid — an agent
   * with no external providers legitimately has none.
   */
  adapters: z.array(BlueprintAdapterBindingSchema).default([]),
  dataRequirements: z.array(DataRequirementSchema).default([]),

  capabilityPolicy: CapabilityPolicySchema,

  ens: EnsRequirementsSchema,
  cre: CreRequirementsSchema,
  ledger: LedgerRequirementsSchema,

  execution: ExecutionSchema,

  simulationScenarios: z.array(SimulationScenarioSchema).min(1),
  generatedModules: z.array(GeneratedModuleSchema).min(1),
  securityAssertions: z.array(SecurityAssertionSchema).min(1),
});

export type ContextLockAgentBlueprint = z.infer<typeof ContextLockAgentBlueprintSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type SimulationScenario = z.infer<typeof SimulationScenarioSchema>;
export type GeneratedModule = z.infer<typeof GeneratedModuleSchema>;
export type BlueprintAdapterBinding = z.infer<typeof BlueprintAdapterBindingSchema>;
export type BlueprintDataRequirement = z.infer<typeof DataRequirementSchema>;
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;
