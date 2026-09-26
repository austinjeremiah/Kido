/**
 * What each sandbox provider can actually enforce.
 *
 * This file exists because of one specific temptation. P11's headline security claim is
 * `networkMode: 'none'` — generated code runs with no network at all, so an `npm test` written by
 * a model cannot exfiltrate anything. That claim is enforced by Docker, at the container level.
 *
 * A hosted provider is a different product with different properties, and copying the claim across
 * because the interface matches would be the worst kind of false statement: one that is true of the
 * code and false of the deployment.
 *
 * So capabilities are declared per provider, the Studio reads them rather than assuming, and
 * anything a provider cannot enforce changes what the Studio DOES rather than what it says.
 */

export type NetworkIsolation =
  /** No network namespace at all. Nothing can be reached, including DNS. */
  | "NONE"
  /** Egress restricted to an allow-list the provider enforces. */
  | "ALLOWLIST"
  /** Unrestricted outbound. */
  | "OPEN"
  /** The provider does not document or guarantee this. Treated as OPEN. */
  | "UNKNOWN";

export interface SandboxCapabilities {
  providerId: string;
  /** Where this provider runs. Local providers cannot leak to a vendor; hosted ones can. */
  locality: "local" | "hosted";
  networkIsolation: NetworkIsolation;
  /** True only if the provider can restore a workspace in a DIFFERENT process. */
  crossProcessResume: boolean;
  snapshots: boolean;
  filesystemWrite: boolean;
  /** Can the host inject environment variables? If yes, that is a leak path to audit. */
  environmentInjection: boolean;
  exposedPorts: boolean;
  /** Wall-clock ceiling the provider itself enforces, or null if the Studio must enforce it. */
  providerEnforcedTimeoutMs: number | null;
  /**
   * What is NOT guaranteed. Written as prose because the consequence is what matters, and a
   * boolean cannot carry "and therefore we do this instead".
   */
  caveats: string[];
}

export const DOCKER_CAPABILITIES: SandboxCapabilities = {
  providerId: "docker",
  locality: "local",
  // Enforced by the daemon, not by us, and not overridable from config. See FND-V2-003.
  networkIsolation: "NONE",
  crossProcessResume: false,
  snapshots: false,
  filesystemWrite: true,
  environmentInjection: true,
  exposedPorts: false,
  providerEnforcedTimeoutMs: null,
  caveats: [
    "Resume works only within the process that created the sandbox; after a restart a build is rebuilt from persisted artifacts rather than reconnected.",
    "The Studio, not Docker, enforces the wall-clock limit.",
  ],
};

/**
 * E2B.
 *
 * `networkIsolation` is UNKNOWN rather than NONE, and that is a deliberate, load-bearing choice.
 * E2B sandboxes are hosted microVMs whose purpose includes running code that installs packages and
 * calls APIs; the client exposes no equivalent of Docker's `networkMode: 'none'`, and this project
 * has not obtained evidence that outbound traffic can be switched off.
 *
 * Until such evidence exists, the Studio treats a hosted sandbox as network-capable and compensates
 * by changing the architecture — no secrets in the sandbox, no privileged tools, provider calls
 * routed through the broker — rather than by restating the local claim. See P21.19 and
 * BLK-V2-E2B-LIVE.
 */
export const E2B_CAPABILITIES: SandboxCapabilities = {
  providerId: "e2b",
  locality: "hosted",
  networkIsolation: "UNKNOWN",
  crossProcessResume: true,
  snapshots: true,
  filesystemWrite: true,
  environmentInjection: true,
  exposedPorts: true,
  providerEnforcedTimeoutMs: 60 * 60 * 1000,
  caveats: [
    "Network isolation is NOT established. The Studio must not repeat P11's `networkMode: none` claim for hosted builds.",
    "Because egress cannot be assumed closed, no ContextLock secret may enter a hosted sandbox and no privileged tool may be exposed inside it.",
    "Workspace state leaves this machine. A hosted build is subject to the vendor's retention, not ours.",
    "Resume is a provider feature and is only as durable as the provider's session state.",
  ],
};

const REGISTRY = new Map<string, SandboxCapabilities>([
  ["docker", DOCKER_CAPABILITIES],
  ["e2b", E2B_CAPABILITIES],
]);

export function capabilitiesFor(providerId: string): SandboxCapabilities {
  const c = REGISTRY.get(providerId);
  if (c) return c;
  // An unknown provider is assumed to guarantee nothing. Failing open here would mean a provider
  // added later inherits Docker's claims by omission.
  return {
    providerId,
    locality: "hosted",
    networkIsolation: "UNKNOWN",
    crossProcessResume: false,
    snapshots: false,
    filesystemWrite: true,
    environmentInjection: true,
    exposedPorts: true,
    providerEnforcedTimeoutMs: null,
    caveats: [`"${providerId}" declares no capabilities; nothing about it is assumed.`],
  };
}

export function registerCapabilities(c: SandboxCapabilities): void {
  REGISTRY.set(c.providerId, c);
}

/**
 * May a secret be placed inside a sandbox from this provider?
 *
 * Only when the provider genuinely has no network. Anything else and a secret in the sandbox is a
 * secret one `curl` away from leaving — and the code in that sandbox was written by a model from a
 * prompt we do not control.
 */
export const secretsMayEnter = (c: SandboxCapabilities): boolean => c.networkIsolation === "NONE";

/** The claim the Studio is entitled to make about a provider, in words a user can check. */
export function isolationStatement(c: SandboxCapabilities): string {
  switch (c.networkIsolation) {
    case "NONE":
      return "No network. The sandbox has no network namespace, so generated code cannot reach anything.";
    case "ALLOWLIST":
      return "Restricted egress. The provider enforces an allow-list; traffic to anything else is refused.";
    case "OPEN":
      return "Open egress. Generated code can reach the internet, so no secret is placed in this sandbox.";
    case "UNKNOWN":
      return "Egress not established. This provider makes no isolation guarantee we have verified, so it is treated as open: no secret is placed in this sandbox and no privileged tool is exposed inside it.";
  }
}
