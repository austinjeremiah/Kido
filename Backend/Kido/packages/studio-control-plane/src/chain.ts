import { z } from "zod";
import type { Address, Hex } from "viem";
import { codeHash, type ChainReader } from "@contextlock/studio-deploy";
import { observed, unavailable, DEFAULT_TTLS, type Observation } from "./freshness.js";

/**
 * The chain observer.
 *
 * §25.17 is the mandatory rule of this phase, and it is short:
 *
 *     THE PROMINENT "POLICY ENABLED / DISABLED" INDICATOR MUST COME FROM A FRESH CHAIN READ.
 *
 * Not from the last button pressed, not from the deployment manifest, not from a database row. P23
 * already paid for the general version of this lesson — three bugs, all from trusting local state —
 * and P25 is where it becomes structural.
 *
 * The mechanism: `readPolicyState` takes a `ChainReader` and returns an `Observation`, which
 * carries the moment of the read and expires. There is no function in this file that returns a
 * policy value without one, and no path that consults a database. A cache exists one layer up, in
 * `reconcile`, and its only job is to be COMPARED against a fresh read rather than substituted for
 * one.
 */

const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);

export const PolicyStateSchema = z.object({
  registry: z.string(),
  agentIdentityHash: hex32,
  policyHash: hex32,
  /** The load-bearing field. Read from chain, every time. */
  enabled: z.boolean(),
  maxValueHardCap: z.string().regex(/^\d+$/),
  /** 0 means the identity was never configured, which is different from "configured and disabled". */
  bindingVersion: z.string().regex(/^\d+$/),
  policyAdmin: z.string(),
  blockNumber: z.string().regex(/^\d+$/),
});
export type PolicyState = z.infer<typeof PolicyStateSchema>;

export const IdentityStateSchema = z.object({
  name: z.string(),
  node: hex32,
  resolver: z.string(),
  /** Null when the name resolves to nothing — revoked, expired, or never bound. */
  boundAgent: z.string().nullable(),
  revoked: z.boolean(),
  blockNumber: z.string().regex(/^\d+$/),
});
export type IdentityState = z.infer<typeof IdentityStateSchema>;

export const ContractStateSchema = z.object({
  name: z.string(),
  address: z.string(),
  /** Empty means no code — a contract that was expected and is not there. */
  runtimeCodeHash: hex32,
  hasCode: z.boolean(),
  blockNumber: z.string().regex(/^\d+$/),
});
export type ContractState = z.infer<typeof ContractStateSchema>;

/** What the observer needs the chain to be able to answer. Injected, so it is testable. */
export interface ChainQueries {
  readPolicy(registry: Address, agentIdentityHash: Hex, policyHash: Hex): Promise<{ enabled: boolean; cap: bigint; bindingVersion: bigint; admin: Address }>;
  resolveIdentity(node: Hex): Promise<{ boundAgent: Address | null; revoked: boolean; resolver: Address }>;
  readAdministrators(contract: Address): Promise<Address[]>;
}

export interface ChainObserverDeps {
  reader: ChainReader;
  queries: ChainQueries;
  nowMs: () => number;
  ttls?: { policy?: number; identity?: number; chain?: number };
}

export class ChainObserver {
  constructor(private readonly deps: ChainObserverDeps) {}

  /**
   * Read the policy from chain. No cache, no fallback, no default.
   *
   * A failure produces a FAILED observation with a null value — never `enabled: false`. Guessing
   * "disabled" on an RPC error would be the safe-looking wrong answer: it would show an operator a
   * green "policy disabled" indicator for an agent whose policy is, as far as anyone knows, enabled.
   */
  async readPolicyState(args: { registry: Address; agentIdentityHash: Hex; policyHash: Hex }): Promise<Observation<PolicyState>> {
    const ttlMs = this.deps.ttls?.policy ?? DEFAULT_TTLS.policy;
    const source = `chain:${this.deps.reader.chainId}`;
    try {
      const block = await this.deps.reader.getBlockNumber();
      const p = await this.deps.queries.readPolicy(args.registry, args.agentIdentityHash, args.policyHash);
      return observed<PolicyState>(
        {
          registry: args.registry,
          agentIdentityHash: args.agentIdentityHash,
          policyHash: args.policyHash,
          enabled: p.enabled,
          maxValueHardCap: p.cap.toString(),
          bindingVersion: p.bindingVersion.toString(),
          policyAdmin: p.admin,
          blockNumber: block.toString(),
        },
        { atMs: this.deps.nowMs(), source, ttlMs },
      );
    } catch (e) {
      return unavailable<PolicyState>("FAILED", {
        atMs: this.deps.nowMs(), source, ttlMs,
        reason: `the policy could not be read from chain ${this.deps.reader.chainId}: ${(e as Error).message}. Policy state is UNKNOWN — it is not assumed disabled.`,
      });
    }
  }

  async readIdentityState(args: { name: string; node: Hex }): Promise<Observation<IdentityState>> {
    const ttlMs = this.deps.ttls?.identity ?? DEFAULT_TTLS.identity;
    const source = `chain:${this.deps.reader.chainId}`;
    try {
      const block = await this.deps.reader.getBlockNumber();
      const r = await this.deps.queries.resolveIdentity(args.node);
      return observed<IdentityState>(
        { name: args.name, node: args.node, resolver: r.resolver, boundAgent: r.boundAgent, revoked: r.revoked, blockNumber: block.toString() },
        { atMs: this.deps.nowMs(), source, ttlMs },
      );
    } catch (e) {
      return unavailable<IdentityState>("FAILED", { atMs: this.deps.nowMs(), source, ttlMs, reason: `identity could not be resolved: ${(e as Error).message}` });
    }
  }

  async readContractState(name: string, address: Address): Promise<Observation<ContractState>> {
    const ttlMs = this.deps.ttls?.chain ?? DEFAULT_TTLS.chain;
    const source = `chain:${this.deps.reader.chainId}`;
    try {
      const block = await this.deps.reader.getBlockNumber();
      const code = await this.deps.reader.getCode(address);
      const has = !!code && code !== "0x";
      return observed<ContractState>(
        { name, address, runtimeCodeHash: codeHash(code), hasCode: has, blockNumber: block.toString() },
        { atMs: this.deps.nowMs(), source, ttlMs, ...(has ? {} : { state: "DEGRADED" as const, reason: `no code at ${address}` }) },
      );
    } catch (e) {
      return unavailable<ContractState>("FAILED", { atMs: this.deps.nowMs(), source, ttlMs, reason: `code could not be read: ${(e as Error).message}` });
    }
  }

  async readAdministrators(contract: Address): Promise<Observation<string[]>> {
    const ttlMs = this.deps.ttls?.chain ?? DEFAULT_TTLS.chain;
    try {
      const admins = await this.deps.queries.readAdministrators(contract);
      return observed<string[]>(admins.map((a) => a.toLowerCase()), { atMs: this.deps.nowMs(), source: `chain:${this.deps.reader.chainId}`, ttlMs });
    } catch (e) {
      return unavailable<string[]>("FAILED", { atMs: this.deps.nowMs(), source: `chain:${this.deps.reader.chainId}`, ttlMs, reason: (e as Error).message });
    }
  }
}

/* ─────────────────────────────── drift ─────────────────────────────── */

export const DRIFT_KINDS = [
  "POLICY_ENABLED_UNEXPECTEDLY",
  "POLICY_DISABLED_UNEXPECTEDLY",
  "POLICY_ADMIN_CHANGED",
  "ADMIN_CHANGED",
  "BYTECODE_DRIFT",
  "IDENTITY_CHANGED",
  "IDENTITY_REVOKED_UNEXPECTEDLY",
  "RUNTIME_IMAGE_DRIFT",
  "BINDING_VERSION_CHANGED",
  "CONTRACT_MISSING",
] as const;
export const DriftKindSchema = z.enum(DRIFT_KINDS);
export type DriftKind = z.infer<typeof DriftKindSchema>;

/**
 * Drift kinds that are CRITICAL and may not be auto-resolved (§25.43).
 *
 * The distinction matters. An adapter going stale and coming back is noise. A policy that turned
 * itself on, an administrator that changed, or bytecode that no longer matches is somebody doing
 * something — and the next poll returning normal does not mean it did not happen. Those require an
 * explicit reconciliation record with evidence.
 */
export const CRITICAL_DRIFT: ReadonlySet<DriftKind> = new Set<DriftKind>([
  "POLICY_ENABLED_UNEXPECTEDLY",
  "POLICY_ADMIN_CHANGED",
  "ADMIN_CHANGED",
  "BYTECODE_DRIFT",
  "IDENTITY_CHANGED",
  "RUNTIME_IMAGE_DRIFT",
  "CONTRACT_MISSING",
]);

export const DriftSchema = z.object({
  kind: DriftKindSchema,
  severity: z.enum(["WARNING", "CRITICAL"]),
  subject: z.string(),
  expected: z.string(),
  observed: z.string(),
  detail: z.string(),
  observedAtMs: z.number().int().positive(),
  blockNumber: z.string().nullable(),
  /** True when this kind may not be cleared by a later poll alone. */
  requiresReconciliation: z.boolean(),
});
export type Drift = z.infer<typeof DriftSchema>;

const drift = (kind: DriftKind, subject: string, expected: string, obs: string, detail: string, atMs: number, block: string | null): Drift => ({
  kind,
  severity: CRITICAL_DRIFT.has(kind) ? "CRITICAL" : "WARNING",
  subject, expected, observed: obs, detail, observedAtMs: atMs, blockNumber: block,
  requiresReconciliation: CRITICAL_DRIFT.has(kind),
});

/**
 * What the deployment record says should be true.
 *
 * Deliberately called "expected" and never "current". This object is a claim made at deployment
 * time; the chain is the fact. `reconcile` compares them and never lets the claim stand in for the
 * fact — which is the whole point of P25.16.
 */
export interface ExpectedState {
  policyEnabled: boolean;
  policyAdmin: string;
  bindingVersion: string | null;
  contracts: Array<{ name: string; address: string; runtimeCodeHash: string }>;
  administrators: string[];
  identity: { node: string; boundAgent: string } | null;
  runtimeImageDigest: string | null;
}

export interface ObservedState {
  policy: Observation<PolicyState>;
  identity: Observation<IdentityState> | null;
  contracts: Array<Observation<ContractState>>;
  administrators: Observation<string[]> | null;
  runtimeImageDigest: string | null;
}

/**
 * Compare the deployment record against fresh chain state.
 *
 * Returns drift rather than throwing, because an operator needs to see ALL of it at once — finding
 * out about a changed administrator only after fixing a bytecode mismatch is how the second problem
 * gets missed.
 *
 * A FAILED observation produces no drift. "We could not read it" is not "it changed", and reporting
 * an RPC outage as a critical security event is how alerting gets muted.
 */
export function reconcile(expected: ExpectedState, actual: ObservedState, nowMs: number): Drift[] {
  const out: Drift[] = [];
  const block = actual.policy.value?.blockNumber ?? null;

  if (actual.policy.value) {
    const p = actual.policy.value;
    if (p.enabled !== expected.policyEnabled) {
      out.push(
        p.enabled
          ? drift("POLICY_ENABLED_UNEXPECTEDLY", `policy ${p.policyHash}`, "disabled", "ENABLED",
              "The deployment record says this agent's policy is disabled and the chain says it is enabled. This agent can authorize financial execution right now.", nowMs, block)
          : drift("POLICY_DISABLED_UNEXPECTEDLY", `policy ${p.policyHash}`, "enabled", "disabled",
              "The deployment record says this agent's policy is enabled and the chain says it is disabled. The agent cannot act; something disabled it.", nowMs, block),
      );
    }
    if (p.policyAdmin.toLowerCase() !== expected.policyAdmin.toLowerCase()) {
      out.push(drift("POLICY_ADMIN_CHANGED", `policy admin for ${p.agentIdentityHash}`, expected.policyAdmin.toLowerCase(), p.policyAdmin.toLowerCase(),
        "The address that can change this agent's policy is not the one recorded at deployment.", nowMs, block));
    }
    if (expected.bindingVersion !== null && p.bindingVersion !== expected.bindingVersion) {
      out.push(drift("BINDING_VERSION_CHANGED", `binding version for ${p.agentIdentityHash}`, expected.bindingVersion, p.bindingVersion,
        "The identity binding version has moved, which invalidates capabilities issued against the previous binding.", nowMs, block));
    }
  }

  for (const c of actual.contracts) {
    if (!c.value) continue;
    const want = expected.contracts.find((x) => x.address.toLowerCase() === c.value!.address.toLowerCase());
    if (!want) continue;
    if (!c.value.hasCode) {
      out.push(drift("CONTRACT_MISSING", want.name, "code present", "no code", `No contract code at ${want.address}.`, nowMs, c.value.blockNumber));
      continue;
    }
    if (c.value.runtimeCodeHash.toLowerCase() !== want.runtimeCodeHash.toLowerCase()) {
      out.push(drift("BYTECODE_DRIFT", want.name, want.runtimeCodeHash, c.value.runtimeCodeHash,
        `The code at ${want.address} is not the code this deployment was verified against.`, nowMs, c.value.blockNumber));
    }
  }

  if (actual.administrators?.value) {
    const want = new Set(expected.administrators.map((a) => a.toLowerCase()));
    const unexpected = actual.administrators.value.filter((a) => !want.has(a));
    if (unexpected.length > 0) {
      out.push(drift("ADMIN_CHANGED", "administrative roles", [...want].sort().join(", ") || "(none)", actual.administrators.value.sort().join(", "),
        `Unexpected administrator(s): ${unexpected.join(", ")}.`, nowMs, block));
    }
  }

  if (expected.identity && actual.identity?.value) {
    const i = actual.identity.value;
    if (i.revoked) {
      out.push(drift("IDENTITY_REVOKED_UNEXPECTEDLY", i.name, expected.identity.boundAgent, "revoked", "The agent's identity has been revoked.", nowMs, i.blockNumber));
    } else if ((i.boundAgent ?? "").toLowerCase() !== expected.identity.boundAgent.toLowerCase()) {
      out.push(drift("IDENTITY_CHANGED", i.name, expected.identity.boundAgent.toLowerCase(), (i.boundAgent ?? "(unbound)").toLowerCase(),
        "The agent's identity resolves to a different address than the one recorded at deployment.", nowMs, i.blockNumber));
    }
  }

  if (expected.runtimeImageDigest && actual.runtimeImageDigest && expected.runtimeImageDigest !== actual.runtimeImageDigest) {
    out.push(drift("RUNTIME_IMAGE_DRIFT", "runtime image", expected.runtimeImageDigest, actual.runtimeImageDigest,
      "The container that is running was not built from the image this deployment pinned.", nowMs, null));
  }

  return out;
}

/* ────────────────────────────── finality ────────────────────────────── */

export const TX_LIFECYCLE = ["SUBMITTED", "MINED", "CONFIRMING", "FINALIZED", "REORGED", "REVERTED"] as const;
export const TxLifecycleSchema = z.enum(TX_LIFECYCLE);
export type TxLifecycle = z.infer<typeof TxLifecycleSchema>;

export interface TrackedTransaction {
  txHash: string;
  chainId: number;
  state: TxLifecycle;
  blockNumber: string | null;
  confirmations: number;
  gasUsed: string | null;
  effectiveGasPriceWei: string | null;
  actualNativeCostWei: string | null;
  correlationId: string;
  /** Set when a previously-reported block no longer holds this transaction. */
  reorgedFromBlock: string | null;
}

export interface FinalityPolicy {
  confirmations: number;
  /** Blocks to re-scan on restart, so a reorg during downtime is not silently skipped. */
  reorgOverlapBlocks: number;
}

export const DEFAULT_FINALITY: FinalityPolicy = { confirmations: 12, reorgOverlapBlocks: 32 };

/**
 * Advance a transaction through the lifecycle.
 *
 * §25.18: a receipt with `status: success` is not final economic truth. It is MINED. It becomes
 * FINALIZED only after the configured confirmations, and it can go backwards — a receipt that
 * disappears, or reappears in a different block, is a REORG and produces a correction event rather
 * than a silent edit.
 */
export function advanceTransaction(
  current: TrackedTransaction,
  receipt: { status: "success" | "reverted"; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint } | null,
  headBlock: bigint,
  policy: FinalityPolicy = DEFAULT_FINALITY,
): { next: TrackedTransaction; correction: { from: TxLifecycle; to: TxLifecycle; reason: string } | null } {
  if (!receipt) {
    // It was mined and now it is not. That is a reorg, and it is the case a monitoring system is
    // most likely to paper over by keeping the last good reading.
    if (current.state === "MINED" || current.state === "CONFIRMING" || current.state === "FINALIZED") {
      return {
        next: { ...current, state: "REORGED", reorgedFromBlock: current.blockNumber, confirmations: 0 },
        correction: { from: current.state, to: "REORGED", reason: `no receipt for ${current.txHash}; it was previously seen in block ${current.blockNumber}` },
      };
    }
    return { next: current, correction: null };
  }

  const confirmations = headBlock >= receipt.blockNumber ? Number(headBlock - receipt.blockNumber) + 1 : 0;
  const cost = receipt.gasUsed * receipt.effectiveGasPrice;

  if (receipt.status === "reverted") {
    return {
      next: { ...current, state: "REVERTED", blockNumber: receipt.blockNumber.toString(), confirmations, gasUsed: receipt.gasUsed.toString(), effectiveGasPriceWei: receipt.effectiveGasPrice.toString(), actualNativeCostWei: cost.toString() },
      correction: current.state === "REVERTED" ? null : { from: current.state, to: "REVERTED", reason: `transaction reverted in block ${receipt.blockNumber}` },
    };
  }

  // Mined in a different block than we last saw: a reorg that re-included it.
  const movedBlock = current.blockNumber !== null && current.blockNumber !== receipt.blockNumber.toString();
  const state: TxLifecycle = confirmations >= policy.confirmations ? "FINALIZED" : "CONFIRMING";
  const next: TrackedTransaction = {
    ...current,
    state,
    blockNumber: receipt.blockNumber.toString(),
    confirmations,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
    actualNativeCostWei: cost.toString(),
    reorgedFromBlock: movedBlock ? current.blockNumber : current.reorgedFromBlock,
  };
  if (movedBlock) {
    return { next, correction: { from: current.state, to: state, reason: `transaction moved from block ${current.blockNumber} to ${receipt.blockNumber}` } };
  }
  return { next, correction: current.state === state ? null : { from: current.state, to: state, reason: `${confirmations} confirmation(s)` } };
}

/* ────────────────────────────── event cursor ────────────────────────────── */

export const ChainCursorSchema = z.object({
  chainId: z.number().int().positive(),
  contract: z.string(),
  eventSignature: z.string(),
  lastFinalizedBlock: z.string().regex(/^\d+$/),
  lastProcessedLogId: z.string().nullable(),
  updatedAtMs: z.number().int().positive(),
});
export type ChainCursor = z.infer<typeof ChainCursorSchema>;

/**
 * Where to resume scanning.
 *
 * `lastFinalizedBlock + 1` is the obvious answer and the wrong one: a chain that reorganized while
 * the observer was down would have blocks we already processed replaced by different ones, and
 * starting after them skips whatever took their place. So resumption overlaps, and duplicates are
 * absorbed by the event store's derived identity rather than by a de-duplication pass.
 */
export function resumeFrom(cursor: ChainCursor, policy: FinalityPolicy = DEFAULT_FINALITY): bigint {
  const last = BigInt(cursor.lastFinalizedBlock);
  const overlap = BigInt(policy.reorgOverlapBlocks);
  return last > overlap ? last - overlap : 0n;
}

/** Canonical identity for a log. Block alone is not unique; a transaction alone is not either. */
export const logId = (l: { chainId: number; blockNumber: bigint | string; transactionHash: string; logIndex: number }): string =>
  `${l.chainId}:${l.blockNumber}:${l.transactionHash.toLowerCase()}:${l.logIndex}`;
