import { z } from "zod";

export const BLUEPRINT_SCHEMA_VERSION = "kido.agent-blueprint/v2" as const;

export const CHAIN_IDS = ["ethereum-sepolia", "sui-testnet"] as const;
export const ChainIdSchema = z.enum(CHAIN_IDS);
export type ChainId = z.infer<typeof ChainIdSchema>;

export const ACTIONS = ["SWAP", "SUPPLY", "REPAY", "BORROW", "WITHDRAW", "STAKE", "UNSTAKE", "ADD_LIQUIDITY", "REMOVE_LIQUIDITY", "PAY", "BRIDGE"] as const;
export const ActionSchema = z.enum(ACTIONS);
export type Action = z.infer<typeof ActionSchema>;

/* ── requirement resolution (bible §9.3) ─────────────────────────────────── */

export const RequirementClassSchema = z.enum(["USER_REQUIRED", "SAFE_DEFAULT", "INFERABLE"]);
export type RequirementClass = z.infer<typeof RequirementClassSchema>;

export const TOPICS = ["AUTHORITY", "CHAIN", "ACTIONS", "LIMITS", "IDENTITY", "PRIVACY", "DATA", "RECOVERY", "OPERATIONS", "OBJECTIVE"] as const;
export const TopicSchema = z.enum(TOPICS);
export type Topic = z.infer<typeof TopicSchema>;

export const ProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("USER_ANSWER"), quote: z.string().max(2000), turn: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("SAFE_DEFAULT"), reason: z.string() }),
  z.object({ kind: z.literal("INFERRED"), from: z.array(z.string()), rule: z.string() }),
]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const RequirementStatusSchema = z.enum(["UNKNOWN", "RESOLVED", "UNSATISFIABLE", "NOT_APPLICABLE"]);

export const RequirementResolutionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  topic: TopicSchema,
  class: RequirementClassSchema,
  critical: z.boolean(),
  status: RequirementStatusSchema,
  value: z.unknown().optional(),
  provenance: ProvenanceSchema.optional(),
  /** A confirmed resolution is immutable until the user explicitly edits it (new revision). */
  confirmed: z.boolean(),
});
export type RequirementResolution = z.infer<typeof RequirementResolutionSchema>;

/* ── identity (bible §24–§26) ────────────────────────────────────────────── */

export const IdentityBindingSchema = z.object({
  provider: z.enum(["ens", "suins"]),
  chain: ChainIdSchema,
  name: z.string().max(253).nullable(),
  status: z.enum(["PLANNED", "ACTIVE", "REVOKED"]),
});

export const IdentitySpecSchema = z.object({
  public: z.boolean().nullable(),
  organization: z.string().max(63).nullable(),
  bindings: z.array(IdentityBindingSchema),
  advertisedCapabilities: z.array(z.string().max(64)),
  endpoints: z.object({ web: z.string().url().optional(), api: z.string().url().optional(), mcp: z.string().url().optional() }),
});
export type IdentitySpec = z.infer<typeof IdentitySpecSchema>;

/* ── privacy (bible §27) ─────────────────────────────────────────────────── */

export const PRIVACY_KINDS = [
  "SECRET_STORAGE", "PRIVATE_INPUT", "PRIVATE_API_CREDENTIAL", "PRIVATE_API_RESPONSE", "PRIVATE_STRATEGY",
  "PRIVATE_POLICY", "CONFIDENTIAL_COMPUTE", "VERIFIABLE_COMPUTE", "ENCRYPTED_STATE", "PRIVATE_MODEL_CONTEXT",
] as const;
export const HIDDEN_FROM = ["PUBLIC_CHAIN", "OTHER_USERS", "AI_AGENT", "NORMAL_KIDO_BACKEND", "CLOUD_HOST", "PROTOCOL_ADAPTER", "EVERYONE_EXCEPT_APPROVED_ENCLAVE"] as const;
export const DISCLOSURES = ["FULL_RESULT", "REDACTED_RESULT", "BUCKETED_RESULT", "BOOLEAN_RESULT", "DECISION_ONLY", "COMMITMENT_ONLY"] as const;

export const PrivateValueSpecSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().max(200),
  kind: z.enum(PRIVACY_KINDS),
  hiddenFrom: z.array(z.enum(HIDDEN_FROM)).min(1),
  plaintextBoundary: z.enum(["USER_DEVICE", "KIDO_SECRET_STORE", "APPROVED_ENCLAVE", "DON", "NONE"]),
  allowedDisclosure: z.enum(DISCLOSURES),
  failurePolicy: z.enum(["FAIL_CLOSED", "SKIP_ACTION", "NOTIFY_OWNER"]),
});
export type PrivateValueSpec = z.infer<typeof PrivateValueSpecSchema>;

export const PrivacyProviderBindingSchema = z.object({
  providerId: z.string(),
  chain: ChainIdSchema.nullable(),
  capabilities: z.array(z.string()),
  satisfies: z.array(z.string()),
});

export const PrivacySpecSchema = z.object({
  required: z.boolean().nullable(),
  values: z.array(PrivateValueSpecSchema),
  providers: z.array(PrivacyProviderBindingSchema),
});
export type PrivacySpec = z.infer<typeof PrivacySpecSchema>;

/* ── authority ───────────────────────────────────────────────────────────── */

export const AUTHORITY_MODES = ["NONE", "READ_ONLY", "PROPOSE_ONLY", "APPROVAL_REQUIRED", "BOUNDED_AUTONOMOUS_FINANCE"] as const;
export const AuthorityModeSchema = z.enum(AUTHORITY_MODES);
export type AuthorityMode = z.infer<typeof AuthorityModeSchema>;

const baseUnits = z.string().regex(/^(0|[1-9][0-9]{0,30})$/);

export const LimitSpecSchema = z.object({
  chain: ChainIdSchema,
  asset: z.string(),
  perAction: baseUnits,
  perWindow: baseUnits,
  windowSeconds: z.number().int().positive(),
  total: baseUnits,
});
export type LimitSpec = z.infer<typeof LimitSpecSchema>;

export const PayeeSpecSchema = z.object({ label: z.string().max(64), chain: ChainIdSchema, address: z.string().max(80) });

export const AuthoritySpecSchema = z.object({
  mode: AuthorityModeSchema.nullable(),
  provider: z.enum(["AMANE", "OWNER_WALLET"]).nullable(),
  autonomy: z.enum(["AUTOMATIC", "VERIFIABLE_CONDITION", "OWNER_APPROVAL"]).nullable(),
  allowedActions: z.array(ActionSchema),
  forbiddenActions: z.array(ActionSchema),
  limits: z.array(LimitSpecSchema),
  payees: z.array(PayeeSpecSchema),
  beneficiaries: z.array(PayeeSpecSchema),
  bridgeAllowed: z.boolean().nullable(),
  leaseLifetimeSeconds: z.number().int().positive().max(86_400),
  /** Owner price floors for SWAP (TESTNET_FIXED): minimum output per unit of input, as a decimal string. */
  swapFloors: z.array(z.object({ chain: ChainIdSchema, assetIn: z.string(), assetOut: z.string(), minOutPerIn: z.string().regex(/^[0-9]+(\.[0-9]+)?$/) })),
});
export type AuthoritySpec = z.infer<typeof AuthoritySpecSchema>;

/* ── protocols, assets, data ─────────────────────────────────────────────── */

export const ProtocolSelectionSchema = z.object({
  providerId: z.string(),
  chain: ChainIdSchema,
  capabilities: z.array(z.string()),
  version: z.string(),
});
export type ProtocolSelection = z.infer<typeof ProtocolSelectionSchema>;

export const AssetSpecSchema = z.object({ symbol: z.string().max(16), chain: ChainIdSchema, ref: z.string(), decimals: z.number().int().min(0).max(36), testnetOnly: z.boolean() });

export const TRUST_CLASSES = ["USER_UNTRUSTED", "RPC_DIRECT", "INDEXED", "VERIFIED_ORACLE", "VERIFIED_COMPUTE"] as const;
export const DataSourceSpecSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  chain: ChainIdSchema.nullable(),
  kind: z.string(),
  minTrust: z.enum(TRUST_CLASSES),
  maxAgeMs: z.number().int().positive(),
  onUnavailable: z.enum(["FAIL_CLOSED", "SKIP_ACTION", "NOTIFY_OWNER"]),
  privateValueRef: z.string().nullable(),
});

/* ── runtime ─────────────────────────────────────────────────────────────── */

export const MonitorSpecSchema = z.object({
  id: z.string(),
  dataSource: z.string(),
  metric: z.string(),
  op: z.enum(["LT", "LTE", "GT", "GTE", "DRIFT_GT", "MISSING", "STALE"]),
  threshold: z.string().nullable(),
  thresholdPrivateRef: z.string().nullable(),
  response: z.enum(["DETERMINISTIC_ACTION", "NOTIFY", "WAKE_SPECIALIST"]),
  action: ActionSchema.nullable(),
});
export type MonitorSpec = z.infer<typeof MonitorSpecSchema>;

export const ActionSpecSchema = z.object({ action: ActionSchema, chain: ChainIdSchema, providerId: z.string(), deterministic: z.boolean() });

export const AgentRoleSpecSchema = z.object({
  role: z.string(),
  owns: z.array(ActionSchema),
  mayRequest: z.array(ActionSchema),
  knowledgePacks: z.array(z.string()),
});

export const ReasoningPolicySchema = z.object({
  model: z.literal("env"),
  wakeConditions: z.array(z.string()),
  maxModelCallsPerHour: z.number().int().positive(),
});

export const RecoveryPolicySchema = z.object({
  onPartialExecution: z.enum(["WAKE_RECOVERY_AGENT", "HALT_AND_NOTIFY"]).nullable(),
  allowedRecoveryActions: z.array(ActionSchema),
  maxRecoveryAttempts: z.number().int().min(0).max(5),
  onOracleUnavailable: z.enum(["FAIL_CLOSED", "NOTIFY_OWNER"]),
});

export const CrossChainPolicySchema = z.object({
  allowed: z.boolean(),
  transports: z.array(z.enum(["wormhole", "layerzero", "mock"])),
  maxAmountPerIntent: z.array(z.object({ asset: z.string(), amount: baseUnits })),
  recoveryDeadlineSeconds: z.number().int().positive(),
});

export const AmaneBindingSpecSchema = z.object({
  manifestRef: z.string(),
  accountId: z.string().nullable(),
  endpoints: z.array(z.object({ chain: ChainIdSchema, account: z.string().nullable() })),
  policyHash: z.string().nullable(),
});

export const ScenarioSpecSchema = z.object({ id: z.string(), family: z.string(), description: z.string() });
export const SecurityAssertionSchema = z.object({ id: z.string(), statement: z.string() });
export const GeneratedModuleSpecSchema = z.object({ id: z.string(), kind: z.string(), from: z.array(z.string()) });

export const BlueprintSchema = z.object({
  schemaVersion: z.literal(BLUEPRINT_SCHEMA_VERSION),
  projectId: z.string().min(1),
  kidoAgentId: z.string().regex(/^kido:agent:[a-z2-7]{16}$/),
  revision: z.number().int().nonnegative(),
  parentRevisionHash: z.string().nullable(),
  objective: z.object({ statement: z.string().max(2000), summary: z.string().max(300).nullable() }),
  requirements: z.array(RequirementResolutionSchema),
  chains: z.array(ChainIdSchema),
  identity: IdentitySpecSchema,
  protocols: z.array(ProtocolSelectionSchema),
  assets: z.array(AssetSpecSchema),
  dataSources: z.array(DataSourceSpecSchema),
  privacy: PrivacySpecSchema,
  authority: AuthoritySpecSchema,
  monitors: z.array(MonitorSpecSchema),
  triggers: z.array(z.object({ id: z.string(), kind: z.string(), monitor: z.string().nullable() })),
  actions: z.array(ActionSpecSchema),
  reasoning: ReasoningPolicySchema,
  agents: z.array(AgentRoleSpecSchema),
  recovery: RecoveryPolicySchema,
  crossChain: CrossChainPolicySchema.optional(),
  amane: AmaneBindingSpecSchema.optional(),
  simulationScenarios: z.array(ScenarioSpecSchema),
  securityAssertions: z.array(SecurityAssertionSchema),
  generatedModules: z.array(GeneratedModuleSpecSchema),
  deployment: z.object({ environment: z.literal("testnet"), chains: z.array(ChainIdSchema) }),
});
export type KidoAgentBlueprint = z.infer<typeof BlueprintSchema>;
