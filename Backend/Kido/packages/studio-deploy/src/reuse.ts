import type { Address, Hex } from "viem";
import { codeHash, type ChainReader } from "./chain.js";
import type { ContractDisposition, ManifestContract } from "./manifest.js";

/**
 * Reuse vs deploy.
 *
 * The default is REUSE. Redeploying the ContextLock core for every agent would give every user a
 * private copy of the protocol, each with its own unaudited address, and would make "which
 * executor is this agent pointed at?" a question with N answers. It would also cost gas for no
 * benefit.
 *
 * But reuse has a precondition that is easy to skip and expensive to skip:
 *
 *     AN ADDRESS IS A CLAIM. THE CODE HASH IS THE EVIDENCE.
 *
 * A registry of "canonical" addresses is a file, and a file can be edited. So before any address is
 * treated as the ContextLock core, the code actually deployed there is read and hashed, and the
 * hash is compared with the one the manifest pins. A mismatch is not a warning; it stops the
 * preflight, because the alternative is an agent authorized against a contract nobody reviewed.
 */

export const REUSE_REASONS = {
  NO_CODE: "REUSE-NO-CODE-AT-ADDRESS",
  CODE_HASH_MISMATCH: "REUSE-CODE-HASH-MISMATCH",
  NO_EXPECTED_HASH: "REUSE-NO-EXPECTED-CODE-HASH",
  NO_ADDRESS: "REUSE-NO-ADDRESS",
  WRONG_CHAIN: "REUSE-WRONG-CHAIN",
} as const;
export type ReuseReason = (typeof REUSE_REASONS)[keyof typeof REUSE_REASONS];

export type ReuseVerdict =
  | { ok: true; disposition: ContractDisposition; address: Address; observedCodeHash: Hex }
  | { ok: false; reason: ReuseReason; detail: string; observedCodeHash: Hex | null };

/**
 * Verify one contract entry against chain reality.
 *
 * Entries that deploy something new pass trivially — there is nothing on chain yet to check. The
 * work is in the two that point at an existing address.
 */
export async function verifyReuse(entry: ManifestContract, reader: ChainReader): Promise<ReuseVerdict> {
  if (entry.disposition === "DEPLOY_NEW" || entry.disposition === "CREATE_AGENT_SPECIFIC") {
    // Nothing exists yet. The creation code hash is checked instead, at deploy time, against what
    // the compiler produces — see the orchestrator's post-deploy verification.
    return { ok: true, disposition: entry.disposition, address: ("0x" + "0".repeat(40)) as Address, observedCodeHash: "0x" as Hex };
  }
  if (entry.chainId !== reader.chainId) {
    return { ok: false, reason: REUSE_REASONS.WRONG_CHAIN, detail: `entry is for chain ${entry.chainId}, reader is on ${reader.chainId}`, observedCodeHash: null };
  }
  if (!entry.address) {
    return { ok: false, reason: REUSE_REASONS.NO_ADDRESS, detail: `${entry.name} is ${entry.disposition} but has no address`, observedCodeHash: null };
  }
  if (!entry.runtimeCodeHash) {
    // Refusing here rather than defaulting to "trust the address" is the whole control. A manifest
    // that forgot to pin a code hash must not silently become a manifest that verifies nothing.
    return {
      ok: false,
      reason: REUSE_REASONS.NO_EXPECTED_HASH,
      detail: `${entry.name} at ${entry.address} pins no runtime code hash, so reuse cannot be verified`,
      observedCodeHash: null,
    };
  }

  const code = await reader.getCode(entry.address as Address);
  if (!code || code === "0x") {
    return {
      ok: false,
      reason: REUSE_REASONS.NO_CODE,
      detail: `no contract code at ${entry.address} on chain ${entry.chainId}`,
      observedCodeHash: null,
    };
  }
  const observed = codeHash(code);
  if (observed.toLowerCase() !== entry.runtimeCodeHash.toLowerCase()) {
    return {
      ok: false,
      reason: REUSE_REASONS.CODE_HASH_MISMATCH,
      detail: `${entry.name} at ${entry.address}: expected ${entry.runtimeCodeHash}, chain has ${observed}`,
      observedCodeHash: observed,
    };
  }
  return { ok: true, disposition: entry.disposition, address: entry.address as Address, observedCodeHash: observed };
}

export interface ReuseReport {
  verified: Array<{ name: string; address: Address; codeHash: Hex }>;
  rejected: Array<{ name: string; reason: ReuseReason; detail: string }>;
  toDeploy: string[];
  toConfigure: string[];
}

/** Resolve every contract entry, returning a report the approval screen can render line by line. */
export async function resolveReuse(
  contracts: ManifestContract[],
  readers: Map<number, ChainReader>,
): Promise<ReuseReport> {
  const report: ReuseReport = { verified: [], rejected: [], toDeploy: [], toConfigure: [] };
  for (const c of contracts) {
    if (c.disposition === "DEPLOY_NEW" || c.disposition === "CREATE_AGENT_SPECIFIC") {
      report.toDeploy.push(c.name);
      continue;
    }
    const reader = readers.get(c.chainId);
    if (!reader) {
      report.rejected.push({ name: c.name, reason: REUSE_REASONS.WRONG_CHAIN, detail: `no reader configured for chain ${c.chainId}` });
      continue;
    }
    const v = await verifyReuse(c, reader);
    if (v.ok) {
      report.verified.push({ name: c.name, address: v.address, codeHash: v.observedCodeHash });
      if (c.disposition === "CONFIGURE_EXISTING") report.toConfigure.push(c.name);
    } else {
      report.rejected.push({ name: c.name, reason: v.reason, detail: v.detail });
    }
  }
  return report;
}

/** A preflight may not proceed while any reuse entry is unverified. */
export const reuseBlocks = (r: ReuseReport): boolean => r.rejected.length > 0;
