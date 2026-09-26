import { z } from "zod";

/**
 * The runtime provider abstraction.
 *
 * One interface, two implementations: Docker for local operation, ECS/Fargate as the first hosted
 * reference. The interface exists so the product is provider-neutral — but the more important thing
 * it does is force each provider to DECLARE what it can enforce, rather than inheriting claims from
 * the interface it implements.
 *
 * This is the same lesson P21 learned about sandboxes and wrote down in `capabilities.ts`: Docker's
 * `networkMode: 'none'` is enforced by the daemon, and copying that claim to a hosted provider
 * because the interface matched would be a statement that is true of the code and false of the
 * deployment. §24.8 says it in as many words — "Do not copy P11's `networkMode: none` claim to a
 * provider that cannot enforce it" — so capabilities are declared per provider and the control
 * plane reads them.
 */

export const RUNTIME_PROVIDERS = ["docker", "ecs-fargate"] as const;
export type RuntimeProviderId = (typeof RUNTIME_PROVIDERS)[number];

export const RuntimeRevisionSchema = z.object({
  revisionId: z.string().min(1),
  deploymentId: z.string().min(1),
  agentId: z.string().min(1),
  /** The immutable digest. Never a tag: a tag is a mutable pointer to whatever was pushed last. */
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  createdAtMs: z.number().int().positive(),
  /** Every revision names the one it replaced, so rollback has a pinned target rather than a guess. */
  previousRevisionId: z.string().nullable(),
  desiredState: z.enum(["INACTIVE", "RUNNING", "PAUSED", "STOPPED"]),
});
export type RuntimeRevision = z.infer<typeof RuntimeRevisionSchema>;

/**
 * What a provider can actually enforce.
 *
 * Every field is a property a hostile process inside the container would run into. A provider that
 * cannot enforce one says so, and the control plane compensates by changing what it DOES — not by
 * restating a claim it cannot back.
 */
export interface RuntimeCapabilities {
  providerId: string;
  locality: "local" | "hosted";
  /** NONE / ALLOWLIST / OPEN / UNKNOWN. UNKNOWN is treated exactly like OPEN. */
  networkEgress: "NONE" | "ALLOWLIST" | "OPEN" | "UNKNOWN";
  readOnlyRootFilesystem: boolean;
  nonRootUser: boolean;
  noNewPrivileges: boolean;
  dropAllCapabilities: boolean;
  cpuLimit: boolean;
  memoryLimit: boolean;
  pidLimit: boolean;
  healthChecks: boolean;
  /** Can the provider roll back to a previous revision automatically when a rollout is unhealthy? */
  automaticRollback: boolean;
  /** Does the provider guarantee the running container is the digest we asked for? */
  digestPinning: boolean;
  caveats: string[];
}

export interface StartRuntimeArgs {
  revision: RuntimeRevision;
  /** Non-secret configuration only. The provider asserts this before it starts anything. */
  environment: Record<string, string>;
  /** The scoped runtime credential, delivered as a file rather than an environment variable. */
  runtimeTokenPath: string;
  runtimeToken: string;
  healthPort: number;
  cpu: string;
  memoryMb: number;
  pidLimit: number;
}

export interface RuntimeStatus {
  revisionId: string;
  providerId: string;
  running: boolean;
  /** What the provider says is running, read back rather than assumed from what we asked for. */
  observedImageDigest: string | null;
  health: string;
  restarts: number;
  detail: string;
}

/**
 * The provider interface.
 *
 * `pause` and `stop` are separate from anything that touches policy, and deliberately so. Neither
 * of them is the security kill switch, and neither of them is allowed to report that it disabled
 * anything — see the kill hierarchy in the orchestrator.
 */
export interface AgentRuntimeProvider {
  readonly id: RuntimeProviderId;
  readonly capabilities: RuntimeCapabilities;
  deploy(args: StartRuntimeArgs): Promise<RuntimeRevision>;
  activate(revisionId: string): Promise<RuntimeStatus>;
  pause(revisionId: string): Promise<RuntimeStatus>;
  resume(revisionId: string): Promise<RuntimeStatus>;
  update(args: StartRuntimeArgs): Promise<RuntimeRevision>;
  rollback(toRevisionId: string): Promise<RuntimeRevision>;
  stop(revisionId: string): Promise<RuntimeStatus>;
  inspect(revisionId: string): Promise<RuntimeStatus>;
  health(revisionId: string): Promise<RuntimeStatus>;
}

export const RUNTIME_REASONS = {
  UNKNOWN_PROVIDER: "RUNTIME-UNKNOWN-PROVIDER",
  PROVIDER_NOT_SELECTABLE: "RUNTIME-PROVIDER-NOT-SELECTABLE-BY-PAYLOAD",
  UNAVAILABLE: "RUNTIME-PROVIDER-UNAVAILABLE",
  SECRET_IN_ENVIRONMENT: "RUNTIME-SECRET-IN-ENVIRONMENT",
  DIGEST_MISMATCH: "RUNTIME-DIGEST-MISMATCH",
  NO_ROLLBACK_TARGET: "RUNTIME-NO-ROLLBACK-TARGET",
  MUTATION_ATTEMPTED: "RUNTIME-IN-PLACE-MUTATION-REFUSED",
  PAUSED: "RUNTIME-PAUSED",
} as const;
export type RuntimeReason = (typeof RUNTIME_REASONS)[keyof typeof RUNTIME_REASONS];

export class RuntimeProviderError extends Error {
  constructor(readonly reason: RuntimeReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "RuntimeProviderError";
  }
}

/* ────────────────────────────── the registry ────────────────────────────── */

const providers = new Map<string, () => AgentRuntimeProvider>();

export function registerRuntimeProvider(id: RuntimeProviderId, factory: () => AgentRuntimeProvider): void {
  providers.set(id, factory);
}

/**
 * Resolve a provider.
 *
 * `allowedByOperator` is not decoration. RUN-026 requires that neither Luna nor a user payload can
 * choose where an agent runs: a model that could name its own runtime provider could name one with
 * no egress restrictions, in an account nobody is watching. The selection is an operator decision,
 * so the allow-list is a parameter that callers must supply from configuration — there is no
 * default that accepts anything.
 */
export function getRuntimeProvider(id: string, allowedByOperator: readonly string[]): AgentRuntimeProvider {
  if (!allowedByOperator.includes(id)) {
    throw new RuntimeProviderError(
      RUNTIME_REASONS.PROVIDER_NOT_SELECTABLE,
      `"${id}" is not in the operator-configured provider allow-list [${allowedByOperator.join(", ") || "empty"}]. Where an agent runs is an operator decision; it is never taken from a model output, a Blueprint, or a request payload.`,
    );
  }
  const factory = providers.get(id);
  if (!factory) {
    throw new RuntimeProviderError(RUNTIME_REASONS.UNKNOWN_PROVIDER, `no provider "${id}" is registered. Available: ${[...providers.keys()].join(", ") || "none"}.`);
  }
  return factory();
}

export const registeredRuntimeProviders = (): string[] => [...providers.keys()];

/**
 * Capabilities of a provider nobody declared.
 *
 * Guarantees nothing. Failing open here would mean a provider added later silently inherits
 * Docker's claims by omission, which is precisely the mistake this whole file exists to prevent.
 */
export function unknownCapabilities(providerId: string): RuntimeCapabilities {
  return {
    providerId,
    locality: "hosted",
    networkEgress: "UNKNOWN",
    readOnlyRootFilesystem: false,
    nonRootUser: false,
    noNewPrivileges: false,
    dropAllCapabilities: false,
    cpuLimit: false,
    memoryLimit: false,
    pidLimit: false,
    healthChecks: false,
    automaticRollback: false,
    digestPinning: false,
    caveats: [`"${providerId}" declares no capabilities; nothing about it is assumed.`],
  };
}

/** The claim the product is entitled to make about a provider's network posture. */
export function egressStatement(c: RuntimeCapabilities): string {
  switch (c.networkEgress) {
    case "NONE":
      return "No network. The runtime has no network namespace — which also means it cannot reach the gateways, so this is only usable for a runtime that does no outbound work.";
    case "ALLOWLIST":
      return `Restricted egress, enforced by ${c.providerId}: only the ContextLock gateways are reachable.`;
    case "OPEN":
      return "Open egress. The runtime can reach the internet, so no privileged credential is placed in it and every provider call goes through a broker.";
    case "UNKNOWN":
      return `Egress is not established for ${c.providerId}. It is treated as open: no privileged credential is placed in the runtime and no provider call is made from it directly.`;
  }
}
