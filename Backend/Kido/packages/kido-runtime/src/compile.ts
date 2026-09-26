import type { BaseAction, Chain } from "@kido/agents";
import {
  ActionKind,
  ZERO32,
  addressToBytes32,
  assertActionIsSubset,
  suiObjectToBytes32,
  type ActionIntent,
  type AgentLease,
  type Bytes32,
  type RootPolicy,
} from "@kido/amane-bridge";
import type { SemanticStep } from "./plan.js";

export interface AdapterBinding {
  adapterId: Bytes32;
  adapterName: string;
  adapterVersion: number;
}

export interface EndpointBinding {
  chain: Chain;
  chainRef: Bytes32;
  account: Bytes32;
  assets: Record<string, Bytes32>;
  adapters: Partial<Record<BaseAction, AdapterBinding>>;
  /** Approved payees by human label, exactly as pinned in the Root Policy. */
  payees: Record<string, { recipientId: Bytes32; label: string }>;
  /** Pinned REPAY beneficiaries by label. */
  beneficiaries: Record<string, { recipientId: Bytes32; label: string }>;
  /** asset symbol → id of the debt token REPAY reduces, as pinned in the policy. */
  debtTokens: Record<string, Bytes32>;
  /** The endpoint's core enforces REPAY. */
  repay: boolean;
}

export interface CompileContext {
  accountId: Bytes32;
  policy: RootPolicy;
  lease: AgentLease;
  bindings: Record<Chain, EndpointBinding>;
  nextNonce: () => bigint;
  now: () => bigint;
  ttlSeconds: bigint;
}

export type Compiled = { ok: true; intent: ActionIntent } | { ok: false; code: string; detail: string };

const KIND: Partial<Record<BaseAction, number>> = { PAY: ActionKind.PAY, SWAP: ActionKind.SWAP, REPAY: ActionKind.REPAY, BRIDGE: ActionKind.BRIDGE };

function recipientFor(step: SemanticStep, b: EndpointBinding): { recipientId: Bytes32; label: string } {
  if (step.payee === null) return { recipientId: ZERO32, label: "" };
  const known = (step.action === "REPAY" ? b.beneficiaries : b.payees)[step.payee];
  if (known) return known;
  // An unknown payee is still encoded faithfully. Kido's preflight rejects it; if Kido itself is
  // compromised and skips preflight, Amane rejects it on-chain because it is not a pinned member.
  if (/^0x[0-9a-fA-F]{40}$/.test(step.payee)) return { recipientId: addressToBytes32(step.payee as `0x${string}`), label: step.payee };
  if (/^0x[0-9a-fA-F]{1,64}$/.test(step.payee)) return { recipientId: suiObjectToBytes32(step.payee), label: step.payee };
  return { recipientId: ZERO32, label: step.payee };
}

/**
 * Compiles one semantic step into an exact Amane ActionIntent. With `preflight`, the intent is
 * checked against the same subset rules the chain enforces, so an out-of-policy proposal never
 * reaches a relayer. Preflight is defence in depth, not the security boundary.
 */
export function compileStep(step: SemanticStep, planHash: Bytes32, planStep: number, ctx: CompileContext, opts: { preflight: boolean }): Compiled {
  const b = ctx.bindings[step.chain];
  const kind = KIND[step.action];
  if (kind === undefined) return { ok: false, code: "KIDO_PLAN_ACTION_UNSUPPORTED", detail: `${step.action} has no Amane enforcement rule` };
  const adapter = b.adapters[step.action];
  if (!adapter) return { ok: false, code: "KIDO_REGISTRY_NO_ADAPTER", detail: `${step.action} on ${step.chain}` };
  const assetId = b.assets[step.asset];
  if (!assetId) return { ok: false, code: "KIDO_PLAN_UNKNOWN_ASSET", detail: `${step.asset} on ${step.chain}` };
  // SWAP names its output asset; REPAY's "output" is the pinned debt token of the input asset.
  let assetOut: Bytes32 | undefined = assetId;
  if (step.action === "SWAP") {
    assetOut = step.assetOut ? b.assets[step.assetOut] : undefined;
    if (!assetOut) return { ok: false, code: "KIDO_PLAN_UNKNOWN_ASSET", detail: `swap output ${step.assetOut} on ${step.chain}` };
  } else if (step.action === "BRIDGE") {
    // Kido bridges only to this account's own endpoint on another chain, never to a payee: the
    // chain would accept any pinned recipient, so this is Kido's stricter rule on top.
    const dest = step.payee?.startsWith("amane-") ? ctx.bindings[step.payee.slice("amane-".length) as Chain] : undefined;
    if (!dest || dest.chain === step.chain) return { ok: false, code: "KIDO_PLAN_BRIDGE_NOT_TO_OWN_ENDPOINT", detail: `a bridge may only deliver to this agent's own Amane account on another chain, not ${step.payee ?? "nobody"}` };
    assetOut = step.assetOut ? dest.assets[step.assetOut] : assetId;
    if (!assetOut) return { ok: false, code: "KIDO_PLAN_UNKNOWN_ASSET", detail: `bridge arrival ${step.assetOut} on ${dest.chain}` };
  } else if (step.action === "REPAY") {
    assetOut = b.debtTokens[step.asset];
    if (!assetOut) return { ok: false, code: "KIDO_PLAN_UNKNOWN_ASSET", detail: `no pinned debt token for ${step.asset} on ${step.chain}` };
  }
  const r = recipientFor(step, b);
  const intent: ActionIntent = {
    accountId: ctx.accountId,
    chainRef: b.chainRef,
    account: b.account,
    policyVersion: ctx.policy.policyVersion,
    leaseId: ctx.lease.leaseId,
    nonce: ctx.nextNonce(),
    actionKind: kind,
    adapterId: adapter.adapterId,
    adapterName: adapter.adapterName,
    adapterVersion: adapter.adapterVersion,
    assetIn: assetId,
    assetOut,
    amountIn: step.amount,
    minAmountOut: 0n,
    recipient: r.recipientId,
    recipientLabel: r.label,
    deadline: ctx.now() + ctx.ttlSeconds,
    planHash,
    planStep,
  };
  if (opts.preflight) {
    try {
      assertActionIsSubset(ctx.policy, ctx.lease, intent, { now: ctx.now(), chainRef: b.chainRef, account: b.account, repay: b.repay });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "AMANE_UNKNOWN";
      return { ok: false, code: `KIDO_PLAN_OUT_OF_POLICY:${code}`, detail: (err as Error).message };
    }
  }
  return { ok: true, intent };
}
