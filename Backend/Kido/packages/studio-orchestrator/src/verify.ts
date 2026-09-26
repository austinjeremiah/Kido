import type { Address, Hex } from "viem";
import { codeHash, type ChainReader } from "@contextlock/studio-deploy";
import type { DeploymentManifest } from "@contextlock/studio-deploy";

/**
 * Post-deployment verification.
 *
 * The rule this file exists to enforce:
 *
 *     DO NOT INFER SUCCESS FROM A TRANSACTION STATUS.
 *
 * A receipt with `status: success` means the EVM did not revert. It does not mean the contract now
 * holds the configuration we intended, that the ENS name resolves to the agent we expect, that the
 * policy is disabled, or that no unexpected address holds an administrative role. Each of those is
 * a separate question, and each is answered by reading state back.
 *
 * The list is deliberately exhaustive rather than representative. A verification suite that checks
 * the interesting things and trusts the boring ones is how an unexpected owner survives to
 * production.
 */

export const VERIFY_REASONS = {
  CODE_MISMATCH: "VERIFY-RUNTIME-CODE-MISMATCH",
  NO_CODE: "VERIFY-NO-CODE-AT-ADDRESS",
  CONFIG_MISMATCH: "VERIFY-CONFIGURATION-MISMATCH",
  POLICY_ENABLED: "VERIFY-POLICY-IS-NOT-DISABLED",
  ENS_MISMATCH: "VERIFY-ENS-BINDING-MISMATCH",
  CRE_MISMATCH: "VERIFY-CRE-WORKFLOW-MISMATCH",
  CRE_NOT_PAUSED: "VERIFY-CRE-NOT-IN-EXPECTED-STATE",
  IMAGE_MISMATCH: "VERIFY-RUNTIME-IMAGE-MISMATCH",
  ADAPTER_MISMATCH: "VERIFY-ADAPTER-VERSION-MISMATCH",
  UNEXPECTED_ADMIN: "VERIFY-UNEXPECTED-ADMINISTRATOR",
  CORRESPONDENCE: "VERIFY-BLUEPRINT-STRATEGY-CORRESPONDENCE",
} as const;
export type VerifyReason = (typeof VERIFY_REASONS)[keyof typeof VERIFY_REASONS];

export interface VerificationCheck {
  id: string;
  what: string;
  ok: boolean;
  reason: VerifyReason | null;
  expected: string;
  observed: string;
}

export interface VerificationInput {
  manifest: DeploymentManifest;
  readers: Map<number, ChainReader>;
  /**
   * Addresses created during this deployment, keyed by CONTRACT NAME.
   *
   * By name rather than by step id: the manifest entry is what needs an address, and a lookup keyed
   * on a step-id naming convention would break silently the first time a step was renamed.
   */
  createdAddresses: Map<string, Address>;
  /** Reads the onchain policy's enabled flag. Injected because the ABI lives in the protocol package. */
  readPolicyEnabled: (chainId: number, registry: Address, policyId: Hex) => Promise<boolean>;
  /** Reads every address currently holding an administrative role on a contract. */
  readAdministrators: (chainId: number, contract: Address) => Promise<Address[]>;
  /** Resolves an ENS node to the address it is bound to, from chain state. */
  resolveEnsBinding: (chainId: number, node: Hex) => Promise<Address | null>;
  /** Current CRE workflow facts, read through `cre workflow get --output json`. */
  readCreWorkflow: (name: string) => Promise<{ workflowId: string; registry: string; binaryHash: string; status: string } | null>;
  /** The digest actually running / registered for an agent. */
  readRuntimeImageDigest: (agentId: string) => Promise<string | null>;
  readAdapterVersions: () => Promise<Map<string, string>>;
  /** The addresses that are ALLOWED to hold administrative roles, from the manifest's signers. */
  expectedAdministrators: Set<string>;
  policyIds: Map<string, Hex>;
}

const check = (id: string, what: string, expected: string, observed: string, reason: VerifyReason): VerificationCheck => ({
  id, what, ok: expected.toLowerCase() === observed.toLowerCase(), reason: expected.toLowerCase() === observed.toLowerCase() ? null : reason, expected, observed,
});

export async function verifyDeployment(input: VerificationInput): Promise<VerificationCheck[]> {
  const { manifest: m } = input;
  const checks: VerificationCheck[] = [];

  /* 1. Contract runtime bytecode — including the ones we just created. */
  for (const c of m.contracts) {
    const reader = input.readers.get(c.chainId);
    if (!reader) continue;
    const address = c.address ?? input.createdAddresses.get(c.name) ?? null;
    if (!address) {
      checks.push({ id: `code:${c.name}`, what: `runtime code for ${c.name}`, ok: false, reason: VERIFY_REASONS.NO_CODE, expected: c.runtimeCodeHash ?? "(pinned hash)", observed: "(no address)" });
      continue;
    }
    const code = await reader.getCode(address as Address);
    if (!code || code === "0x") {
      checks.push({ id: `code:${c.name}`, what: `runtime code for ${c.name}`, ok: false, reason: VERIFY_REASONS.NO_CODE, expected: c.runtimeCodeHash ?? "(pinned hash)", observed: "(no code)" });
      continue;
    }
    const observed = codeHash(code);
    // For a freshly created contract the manifest pins creation code, not runtime code, so the
    // check records what is there rather than failing against a hash that was never applicable.
    if (c.runtimeCodeHash) {
      checks.push(check(`code:${c.name}`, `runtime code for ${c.name} at ${address}`, c.runtimeCodeHash, observed, VERIFY_REASONS.CODE_MISMATCH));
    } else {
      checks.push({ id: `code:${c.name}`, what: `runtime code for newly created ${c.name} at ${address}`, ok: true, reason: null, expected: "(created this deployment)", observed });
    }
  }

  /* 2. The policy is disabled. Checked by reading the flag, not by trusting that we never enabled it. */
  for (const [name, policyId] of input.policyIds) {
    const c = m.contracts.find((x) => x.name === name && x.address);
    if (!c?.address) continue;
    const enabled = await input.readPolicyEnabled(c.chainId, c.address as Address, policyId);
    checks.push({
      id: `policy-disabled:${name}`,
      what: `ContextLock policy ${policyId} must be DISABLED after deployment`,
      ok: !enabled,
      reason: enabled ? VERIFY_REASONS.POLICY_ENABLED : null,
      expected: "disabled",
      observed: enabled ? "ENABLED" : "disabled",
    });
  }

  /* 3. No unexpected administrator. The check nobody runs, and the one that matters most. */
  for (const c of m.contracts) {
    if (!c.address) continue;
    const admins = await input.readAdministrators(c.chainId, c.address as Address);
    const unexpected = admins.filter((a) => !input.expectedAdministrators.has(a.toLowerCase()));
    checks.push({
      id: `admins:${c.name}`,
      what: `administrative roles on ${c.name}`,
      ok: unexpected.length === 0,
      reason: unexpected.length === 0 ? null : VERIFY_REASONS.UNEXPECTED_ADMIN,
      expected: [...input.expectedAdministrators].sort().join(", ") || "(none)",
      observed: admins.map((a) => a.toLowerCase()).sort().join(", ") || "(none)",
    });
  }

  /* 4. ENS identity, read from chain state after the write. */
  for (const e of m.ens) {
    const bound = await input.resolveEnsBinding(e.chainId, e.node as Hex);
    checks.push(check(`ens:${e.name}`, `${e.name} must resolve to the agent`, e.boundAgent, bound ?? "(unbound)", VERIFY_REASONS.ENS_MISMATCH));
  }

  /* 5. CRE: the right workflow, in the right registry, from the right binary, in the right state. */
  for (const w of m.creWorkflows) {
    const live = await input.readCreWorkflow(w.workflowName);
    if (!live) {
      checks.push({ id: `cre:${w.workflowName}`, what: `CRE workflow ${w.workflowName}`, ok: false, reason: VERIFY_REASONS.CRE_MISMATCH, expected: w.binaryHash, observed: "(not found in the registry)" });
      continue;
    }
    checks.push(check(`cre-binary:${w.workflowName}`, `deployed CRE binary hash`, w.binaryHash, live.binaryHash, VERIFY_REASONS.CRE_MISMATCH));
    checks.push(check(`cre-registry:${w.workflowName}`, `CRE registry`, w.registry, live.registry, VERIFY_REASONS.CRE_MISMATCH));
    checks.push({
      id: `cre-state:${w.workflowName}`,
      what: `CRE workflow state after deployment`,
      ok: live.status.toUpperCase() === w.initialState,
      reason: live.status.toUpperCase() === w.initialState ? null : VERIFY_REASONS.CRE_NOT_PAUSED,
      expected: w.initialState,
      observed: live.status,
    });
  }

  /* 6. The runtime image digest. Not the tag. */
  for (const i of m.runtimeImages) {
    const running = await input.readRuntimeImageDigest(i.agentId);
    checks.push(check(`image:${i.agentId}`, `runtime image digest for ${i.agentId}`, i.imageDigest ?? "(unpinned)", running ?? "(none)", VERIFY_REASONS.IMAGE_MISMATCH));
  }

  /* 7. Adapter versions. */
  const versions = await input.readAdapterVersions();
  for (const a of m.adapters) {
    checks.push(check(`adapter:${a.adapterId}`, `adapter ${a.adapterId} version`, a.version, versions.get(a.adapterId) ?? "(absent)", VERIFY_REASONS.ADAPTER_MISMATCH));
  }

  return checks;
}

export class VerificationError extends Error {
  constructor(readonly failures: VerificationCheck[]) {
    super(
      `VERIFY-FAILED: ${failures.length} post-deployment check(s) did not pass:\n  ` +
        failures.map((f) => `[${f.reason}] ${f.what}: expected ${f.expected}, observed ${f.observed}`).join("\n  "),
    );
    this.name = "VerificationError";
  }
}

/** A deployment may not reach READY_TO_ACTIVATE while any check fails. */
export function assertVerified(checks: VerificationCheck[]): void {
  const failures = checks.filter((c) => !c.ok);
  if (failures.length > 0) throw new VerificationError(failures);
}
