import { z } from "zod";

export const ORGANIZATION_SCHEMA_VERSION = "contextlock.organization/v1" as const;

/**
 * The Organization Blueprint.
 *
 * An organization is several agents, each a SEPARATE SECURITY PRINCIPAL. It is emphatically not one
 * agent with several prompts — the whole value is that compromising one tells you nothing about the
 * others and gets you none of their authority.
 *
 * Everything here exists to keep that true: distinct ENS identities, distinct policies, distinct
 * nonce domains, and an aggregate budget that individual limits cannot sum past.
 */

const agentId = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, "lowercase kebab agent id");
const ensLabel = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase ENS label");

/**
 * What an agent may do, by class.
 *
 * `NONE` is a real value and the reason it exists is the reporting agent: an agent that reads and
 * never transacts must be unable to transact, not merely uninclined to. The Blueprint validator
 * rejects any execution capability on a NONE agent.
 */
export const ExecutionClassSchema = z.enum(["NONE", "READ_ONLY", "EXECUTE"]);
export type ExecutionClass = z.infer<typeof ExecutionClassSchema>;

export const OrgAgentSchema = z.object({
  id: agentId,
  displayName: z.string().min(1),
  /** Label under the organization's agent namespace, e.g. "guardian" in guardian.agents.acme.eth. */
  ensLabel,
  /** Full name, derived — stored so a reader never has to reconstruct it. */
  ensName: z.string().min(3),
  executionClass: ExecutionClassSchema,
  /** Adapter capabilities this agent may use. Empty for a reporting agent. */
  executionCapabilities: z.array(z.string()),
  dataCapabilities: z.array(z.string()),
  /** Per-agent autonomous ceiling in USD cents. Null means unresolved, never unlimited. */
  autonomousMaxUsdCents: z.number().int().nonnegative().nullable(),
  escalationMaxUsdCents: z.number().int().nonnegative().nullable(),
  /** Per-agent rolling-day ceiling. */
  dailyMaxUsdCents: z.number().int().nonnegative().nullable(),
  deniedActions: z.array(z.string()),
  /**
   * Nonce/execution domain. Distinct per agent so a capability issued for one is not replayable as
   * another — the domain is part of what the capability binds.
   */
  executionDomain: z.string().min(1),
  /** ContextLock policy id. Separate policies, not one policy with branches. */
  policyId: z.string().min(1),
});
export type OrgAgent = z.infer<typeof OrgAgentSchema>;

export const SharedResourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["treasury", "data-source", "credential"]),
  description: z.string(),
  /** Agents permitted to touch it. Presence here is not authority — policy still decides. */
  agentIds: z.array(agentId),
});

export const AggregateLimitSchema = z.object({
  id: z.string().min(1),
  /** USD cents across ALL agents in the window. */
  maxUsdCents: z.number().int().nonnegative(),
  windowMs: z.number().int().positive(),
  description: z.string(),
});

/**
 * Communication rules.
 *
 * Inter-agent messages are untrusted input, always. This section describes what agents may TALK
 * about; it confers no authority, and the schema has no field that could grant any — an agent
 * cannot delegate authority to another because there is nowhere to express it.
 */
export const CommunicationRuleSchema = z.object({
  from: agentId,
  to: agentId,
  /** Informational only. A message is a request, never an approval. */
  messageKinds: z.array(z.enum(["observation", "request", "status"])),
});

export const OrganizationSchema = z.object({
  schemaVersion: z.literal(ORGANIZATION_SCHEMA_VERSION),
  orgId: z.string().min(1),
  revision: z.number().int().positive(),
  /** Root ENS name, e.g. acme.eth. */
  rootEns: z.string().min(3),
  /** Namespace holding the agents, e.g. agents.acme.eth. */
  agentNamespace: z.string().min(3),
  agents: z.array(OrgAgentSchema).min(1),
  sharedResources: z.array(SharedResourceSchema),
  aggregateLimits: z.array(AggregateLimitSchema),
  communicationRules: z.array(CommunicationRuleSchema),
  /**
   * Delegation is deliberately absent as a capability.
   *
   * There is no field by which one agent grants another authority. The literal false records the
   * decision so a later reader knows it was made rather than forgotten.
   */
  delegationEnabled: z.literal(false),
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const buildEnsName = (label: string, namespace: string) => `${label}.${namespace}`;
