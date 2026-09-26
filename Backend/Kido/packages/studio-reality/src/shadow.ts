import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertExecutionAllowed, fenceWriteByChain, isProductionChain, lookupNetwork, NetworkGuardError,
  type NetworkRef,
} from "@contextlock/studio-network";
import { assertSnapshotUsable, type MarketSnapshot } from "./snapshot.js";
import { assertAddressBelongsToChain, mapAssetToChain, AssetIdentityError } from "./assets.js";
import { assertEnvironmentBinding, type EnvironmentBinding, type ForkDescriptor, forkNetworkRef } from "./fork.js";

/**
 * The Shadow Agent.
 *
 * It watches the real market and never trades on it. Concretely: it reads mainnet, evaluates a real
 * strategy against real conditions, runs the CRE simulator and ContextLock policy, and then
 * executes on a local fork or an approved testnet.
 *
 * The interesting question is not how it observes mainnet — that is just reading. It is what
 * happens to the *decision*, because a decision made under mainnet conditions is naturally expressed
 * in mainnet terms: mainnet addresses, mainnet pool fees, mainnet calldata. Carrying that object to
 * a testnet is where this goes wrong, and §P27.33 names the specific wrong way:
 *
 *     Never mutate only `chainId = 1 → 11155111` on mainnet calldata.
 *
 * The calldata encodes addresses. Rewriting the chain id leaves every address pointing at whatever
 * happens to occupy those bytes on the target network — nothing, usually, and someone else's
 * contract occasionally. An approval aimed at that is a loss with no attacker required.
 *
 * So a shadow decision carries a **semantic** action, and execution requires recompiling it against
 * the target network's own registry. There is no function here that takes calldata and a chain id.
 */

/* ───────────────────────────── the semantic action ───────────────────────────── */

export const SEMANTIC_ACTIONS = ["SUPPLY", "WITHDRAW", "BORROW", "REPAY", "SWAP", "TRANSFER", "APPROVE", "NONE"] as const;
export const SemanticActionKindSchema = z.enum(SEMANTIC_ACTIONS);
export type SemanticActionKind = z.infer<typeof SemanticActionKindSchema>;

/**
 * What the strategy would conceptually do.
 *
 * §P27.32 is explicit that this is **not executable mainnet calldata**, and the schema enforces it:
 * assets are canonical ids, not addresses; amounts are decimal strings with an explicit exponent;
 * there is no `to`, no `data`, no `value`, no `chainId`. There is nothing here to sign.
 */
export const SemanticActionSchema = z.object({
  kind: SemanticActionKindSchema,
  /** Canonical asset ids. Never addresses — that is the entire point. */
  assetId: z.string().min(1),
  counterAssetId: z.string().nullable(),
  /** Decimal string scaled by `decimals`, so it survives without a float. */
  amount: z.string().regex(/^\d+$/),
  decimals: z.number().int().min(0).max(36),
  /** The protocol by name, resolved per-network at compile time. */
  protocol: z.string().min(1),
  rationale: z.string().min(1),
});
export type SemanticAction = z.infer<typeof SemanticActionSchema>;

/** Fields that would make a semantic action executable. Enumerated so their absence is testable. */
export const FORBIDDEN_SEMANTIC_FIELDS = ["to", "data", "calldata", "value", "chainId", "nonce", "gas", "gasPrice", "signature", "v", "r", "s"] as const;

/* ───────────────────────────── the decision ───────────────────────────── */

export const SHADOW_VERDICTS = ["ALLOW", "ESCALATE", "DENY", "NO_VALID_CONTEXT"] as const;
export const ShadowVerdictSchema = z.enum(SHADOW_VERDICTS);
export type ShadowVerdict = z.infer<typeof ShadowVerdictSchema>;

export const ShadowDecisionSchema = z.object({
  decisionId: z.string().min(1),
  /** The exact market picture this was decided against. */
  marketSnapshotHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** Set when the decision was made against a scenario rather than the raw snapshot. */
  scenarioHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  strategyRevision: z.number().int().nonnegative(),
  blueprintRevision: z.number().int().nonnegative(),
  creSimulationId: z.string().nullable(),
  verdict: ShadowVerdictSchema,
  reasonCode: z.string().min(1),
  /** What it would do under mainnet conditions. Not executable. */
  proposedMainnetSemanticAction: SemanticActionSchema,
  /** Where it actually ran. Never mainnet. */
  executionEnvironment: z.enum(["LOCAL_FORK", "TESTNET", "NONE"]),
  environmentId: z.string().nullable(),
  executionChainId: z.number().int().positive().nullable(),
  simulatedExecutionResult: z.object({
    executed: z.boolean(),
    txHash: z.string().nullable(),
    label: z.string().nullable(),
    detail: z.string(),
  }),
  decidedAtMs: z.number().int().positive(),
});
export type ShadowDecision = z.infer<typeof ShadowDecisionSchema>;

export const SHADOW_REASONS = {
  CANNOT_EXECUTE_MAINNET: "SHADOW_AGENT_CANNOT_EXECUTE_ON_MAINNET",
  CALLDATA_REWRITE: "SHADOW_CALLDATA_REWRITE_REFUSED",
  NOT_RECOMPILED: "SHADOW_INTENT_NOT_RECOMPILED",
  NO_TARGET: "SHADOW_NO_EXECUTION_TARGET",
  NO_PUBLIC_MAINNET_PATH: "NO_PUBLIC_MAINNET_SUBMISSION_PATH",
} as const;
export type ShadowReason = (typeof SHADOW_REASONS)[keyof typeof SHADOW_REASONS];

export class ShadowError extends Error {
  constructor(readonly reason: ShadowReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ShadowError";
  }
}

/* ───────────────────────────── target selection ───────────────────────────── */

/**
 * Where a shadow agent may execute.
 *
 * A closed union of two members. §P27.31: it can never select mainnet execution — and the way to
 * guarantee that is not to check for mainnet, it is to have no way to say it. `chainId` is not an
 * input to this function; the caller picks a KIND of target and the registry supplies the chain.
 */
export const SHADOW_TARGETS = ["LOCAL_FORK", "TESTNET"] as const;
export type ShadowTarget = (typeof SHADOW_TARGETS)[number];

export function shadowExecutionRef(target: ShadowTarget, opts: { fork?: ForkDescriptor; testnetChainId?: number }): NetworkRef {
  if (target === "LOCAL_FORK") {
    if (!opts.fork) throw new ShadowError(SHADOW_REASONS.NO_TARGET, "a LOCAL_FORK target needs a fork");
    return forkNetworkRef(opts.fork);
  }
  const chainId = opts.testnetChainId ?? 11155111;
  const net = lookupNetwork(chainId);
  if (!net || net.role !== "TESTNET_EXECUTION") {
    throw new ShadowError(
      SHADOW_REASONS.NO_TARGET,
      `chain ${chainId} is not an approved testnet execution network${net ? ` (it is ${net.role})` : ""}`,
    );
  }
  return { chainId, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null };
}

/**
 * A shadow agent asked to execute on a production chain.
 *
 * Reached only if a caller constructs a `NetworkRef` by hand. It is checked anyway, because
 * "unreachable" is a claim about today's call graph.
 */
export function assertShadowTargetAllowed(ref: NetworkRef, context: string): void {
  if (isProductionChain(ref.chainId) && ref.role !== "LOCAL_FORK") {
    throw new ShadowError(
      SHADOW_REASONS.CANNOT_EXECUTE_MAINNET,
      `${context}: a Shadow Agent observes mainnet and executes on a fork or an approved testnet. Chain ${ref.chainId} is a production network, and there is no mode in which this agent writes to one.`,
    );
  }
  // And through the product-wide guard, so this is fenced by the same code as every other write.
  assertExecutionAllowed(ref, ref.role === "LOCAL_FORK" ? "LOCAL_WRITE" : "PUBLIC_WRITE", context);
}

/* ───────────────────────────── recompilation ───────────────────────────── */

export interface CompiledIntent {
  /** The network this was compiled FOR. Compiling produces one intent for one network. */
  network: NetworkRef;
  protocol: string;
  /** Resolved on the TARGET chain, from the target's own registry. */
  assetAddress: string;
  counterAssetAddress: string | null;
  amount: string;
  decimals: number;
  kind: SemanticActionKind;
  /** Proof of how this was produced, for the audit trail. */
  compiledFrom: string;
  environmentBinding: EnvironmentBinding;
}

/**
 * Refuse the dangerous shortcut, by name.
 *
 * §P27.33 / §P27.34. This exists as its own function so it can be mutated on its own, and so the
 * error explains the failure rather than merely reporting it. The check is `sourceChainId !==
 * targetChainId` on an object that carries calldata: if those differ, someone is carrying an
 * encoded transaction across a network boundary, and the addresses inside it did not come along.
 */
export function assertNoChainIdRewrite(
  intent: { chainId: number; data?: string; to?: string },
  targetChainId: number,
  context: string,
): void {
  if (intent.chainId === targetChainId) return;
  throw new ShadowError(
    SHADOW_REASONS.CALLDATA_REWRITE,
    `${context}: an intent built for chain ${intent.chainId} is being retargeted at chain ${targetChainId} by changing the chain id. The calldata${
      intent.to ? ` and its \`to\` (${intent.to})` : ""
    } encode addresses from chain ${intent.chainId}; on chain ${targetChainId} those bytes are a different contract or none at all. Recompile the semantic action against the target's own registry instead.`,
  );
}

/**
 * Compile a semantic action for a specific execution network.
 *
 * Every address is resolved from the target network's registry. Nothing is copied from the mainnet
 * observation — the semantic action has no addresses to copy, which is why it is shaped that way.
 *
 * The `LOCAL_FORK` case is the one worth reading twice. A mainnet fork holds mainnet state, so the
 * mainnet Aave Pool address is genuinely correct there. Addresses are therefore resolved against
 * the fork's SOURCE chain — and the resulting intent is bound to `LOCAL_FORK` plus the fork's id,
 * so the fact that it names mainnet contracts never makes it a mainnet authorization.
 */
export function compileForNetwork(
  action: SemanticAction,
  network: NetworkRef,
  opts: { fork?: ForkDescriptor; protocolAddressFor: (protocol: string, chainId: number) => string | null },
): CompiledIntent {
  assertShadowTargetAllowed(network, `compile ${action.kind}`);

  // Which chain's addresses are correct here? A fork inherits its source chain's address space.
  const addressChainId = network.role === "LOCAL_FORK" ? (network.forkedFrom ?? network.chainId) : network.chainId;

  const assetDeployment = mapAssetToChain(action.assetId, addressChainId);
  const counterDeployment = action.counterAssetId ? mapAssetToChain(action.counterAssetId, addressChainId) : null;

  const protocolAddress = opts.protocolAddressFor(action.protocol, addressChainId);
  if (!protocolAddress) {
    throw new ShadowError(
      SHADOW_REASONS.NOT_RECOMPILED,
      `${action.protocol} has no reviewed deployment on chain ${addressChainId}. A strategy cannot be recompiled onto a network where its protocol does not exist, and pointing it at the mainnet address would aim it at whatever occupies those bytes.`,
    );
  }

  // For a public testnet, every address must belong to that testnet. For a fork, they belong to the
  // source chain and the environment binding is what keeps that safe.
  if (network.role === "TESTNET_EXECUTION") {
    assertAddressBelongsToChain(assetDeployment.address, network.chainId, `compile ${action.kind} for chain ${network.chainId}`);
    if (counterDeployment) {
      assertAddressBelongsToChain(counterDeployment.address, network.chainId, `compile ${action.kind} counter-asset`);
    }
  }

  const environmentBinding: EnvironmentBinding = network.role === "LOCAL_FORK"
    ? {
        executionEnvironment: "LOCAL_FORK",
        environmentId: opts.fork?.forkId ?? "unknown-fork",
        chainId: network.chainId,
        forkedFrom: network.forkedFrom,
        forkBlock: network.forkBlock,
      }
    : {
        executionEnvironment: "TESTNET",
        environmentId: `testnet-${network.chainId}`,
        chainId: network.chainId,
        forkedFrom: null,
        forkBlock: null,
      };

  return {
    network,
    protocol: action.protocol,
    assetAddress: assetDeployment.address,
    counterAssetAddress: counterDeployment?.address ?? null,
    amount: action.amount,
    decimals: assetDeployment.decimals,
    kind: action.kind,
    compiledFrom: `semantic ${action.kind} ${action.assetId} recompiled against chain ${addressChainId} registry`,
    environmentBinding,
  };
}

/* ───────────────────────────── no mainnet submission path ───────────────────────────── */

/**
 * There is no public mainnet submission path, and this is how that is demonstrated.
 *
 * §P27.36 asks for a test proving that an attacker holding a shadow intent, fork calldata, a local
 * capability and an Anvil key still cannot make ContextLock submit to mainnet. That test needs
 * something to call, and this is it: the function a mainnet submission would have to go through,
 * which does not submit.
 *
 * It is not a stub awaiting an implementation. The product has no mainnet relayer, no mainnet
 * signer and no mainnet broadcast mode, and this function exists to name that absence so it is
 * assertable rather than merely true.
 */
export function submitToPublicMainnet(_intent: unknown): never {
  throw new ShadowError(
    SHADOW_REASONS.NO_PUBLIC_MAINNET_PATH,
    "ContextLock has no public-mainnet submission path. There is no mainnet relayer, no mainnet signer, no mainnet broadcast mode and no mainnet RPC with write capability. Possessing an intent, calldata, a capability or a key does not create one, because the thing that would use them does not exist.",
  );
}

/** Components a public mainnet write would require. None is configured; enumerated so it is testable. */
export const REQUIRED_FOR_MAINNET_WRITE = [
  "mainnet-relayer",
  "mainnet-signer",
  "mainnet-broadcast-mode",
  "mainnet-write-rpc",
  "mainnet-capability-issuer",
] as const;

/* ───────────────────────────── the agent ───────────────────────────── */

export interface ShadowRunInput {
  decisionId: string;
  snapshot: MarketSnapshot;
  scenarioHash?: string | null;
  strategyRevision: number;
  blueprintRevision: number;
  creSimulationId?: string | null;
  maxContextAgeMs: number;
  nowMs: number;
  target: ShadowTarget;
  fork?: ForkDescriptor;
  testnetChainId?: number;
  /** Runs the actual policy. Injected: the Shadow Agent does not reimplement policy. */
  evaluate: (snapshot: MarketSnapshot) => { verdict: ShadowVerdict; reasonCode: string; action: SemanticAction };
  protocolAddressFor: (protocol: string, chainId: number) => string | null;
  /** Performs the write, once everything above has agreed to it. */
  executeOnTarget?: (intent: CompiledIntent) => Promise<{ txHash: string; label: string }>;
}

/**
 * One shadow evaluation, end to end.
 *
 * The order matters: context freshness, then policy, then target, then recompilation, then
 * execution. A stale snapshot stops the run before a verdict is produced, because a verdict
 * computed against a world that has moved is not a verdict worth having (§P27.42).
 */
export async function runShadowDecision(input: ShadowRunInput): Promise<ShadowDecision> {
  const base = {
    decisionId: input.decisionId,
    marketSnapshotHash: input.snapshot.snapshotHash,
    scenarioHash: input.scenarioHash ?? null,
    strategyRevision: input.strategyRevision,
    blueprintRevision: input.blueprintRevision,
    creSimulationId: input.creSimulationId ?? null,
    decidedAtMs: input.nowMs,
  };

  try {
    assertSnapshotUsable(input.snapshot, input.nowMs, input.maxContextAgeMs, `shadow decision ${input.decisionId}`);
  } catch (e) {
    return ShadowDecisionSchema.parse({
      ...base,
      verdict: "NO_VALID_CONTEXT",
      reasonCode: "NO_VALID_CONTEXT",
      proposedMainnetSemanticAction: { kind: "NONE", assetId: "none", counterAssetId: null, amount: "0", decimals: 0, protocol: "none", rationale: (e as Error).message },
      executionEnvironment: "NONE",
      environmentId: null,
      executionChainId: null,
      simulatedExecutionResult: { executed: false, txHash: null, label: null, detail: (e as Error).message },
    });
  }

  const evaluated = input.evaluate(input.snapshot);
  const action = SemanticActionSchema.parse(evaluated.action);

  if (evaluated.verdict !== "ALLOW") {
    return ShadowDecisionSchema.parse({
      ...base,
      verdict: evaluated.verdict,
      reasonCode: evaluated.reasonCode,
      proposedMainnetSemanticAction: action,
      executionEnvironment: "NONE",
      environmentId: null,
      executionChainId: null,
      simulatedExecutionResult: { executed: false, txHash: null, label: null, detail: `policy returned ${evaluated.verdict}; nothing was executed anywhere` },
    });
  }

  const network = shadowExecutionRef(input.target, { ...(input.fork ? { fork: input.fork } : {}), ...(input.testnetChainId !== undefined ? { testnetChainId: input.testnetChainId } : {}) });
  assertShadowTargetAllowed(network, `shadow decision ${input.decisionId}`);
  fenceWriteByChain(network.role === "LOCAL_FORK" ? "AGENT_RUNTIME" : "RELAYER", network.chainId, {
    forkedFrom: network.forkedFrom,
    forkBlock: network.forkBlock,
  });

  const intent = compileForNetwork(action, network, {
    ...(input.fork ? { fork: input.fork } : {}),
    protocolAddressFor: input.protocolAddressFor,
  });

  let executed = { txHash: null as string | null, label: null as string | null, detail: "no executor was supplied; the intent was compiled and not sent" };
  if (input.executeOnTarget) {
    const result = await input.executeOnTarget(intent);
    executed = { txHash: result.txHash, label: result.label, detail: `executed on ${intent.environmentBinding.executionEnvironment} ${intent.environmentBinding.environmentId}` };
  }

  return ShadowDecisionSchema.parse({
    ...base,
    verdict: "ALLOW",
    reasonCode: evaluated.reasonCode,
    proposedMainnetSemanticAction: action,
    executionEnvironment: intent.environmentBinding.executionEnvironment === "LOCAL_FORK" ? "LOCAL_FORK" : "TESTNET",
    environmentId: intent.environmentBinding.environmentId,
    executionChainId: network.chainId,
    simulatedExecutionResult: { executed: executed.txHash !== null, txHash: executed.txHash, label: executed.label, detail: executed.detail },
  });
}

export const decisionId = (seed: string): string => `shadow-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;

export { assertEnvironmentBinding, NetworkGuardError, AssetIdentityError };
