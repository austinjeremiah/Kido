import { keccak256, toHex } from "viem";
import type { Action, ChainId, KidoAgentBlueprint } from "@kido/blueprint";
import { compileStep, validateProposal, type AuthorityResult, type CompileContext, type SemanticStep } from "@kido/runtime";

/**
 * Attack Lab: hand-built actions and injected plans evaluated against an agent's compiled
 * authority, with the same compiler and Amane subset rules the simulation (and the chain) use.
 * Nothing here signs or submits; a verdict is what the rules say, with the layer that decided it.
 */
export interface WhatIf {
  chain: ChainId;
  action: string;
  asset: string;
  assetOut?: string | null;
  /** Base units, as a decimal string. */
  amount: string;
  /** A pinned payee/beneficiary label, or any raw address. */
  recipient: string | null;
  /** Evaluate as if this many seconds from now (e.g. after the lease expires). */
  atSecondsFromNow?: number;
}

export interface LabVerdict {
  verdict: "ALLOW" | "REJECT";
  code: string | null;
  detail: string;
  /** Which layer decided: Kido's plan compiler/validator, or the Amane subset rules the chain enforces. */
  layer: "KIDO_VALIDATOR" | "KIDO_COMPILER" | "AMANE_RULES" | "NONE";
  intent?: Record<string, string | number>;
}

const SPECIALIST_FOR: Record<string, string> = { PAY: "PaymentAgent", SWAP: "SwapAgent", REPAY: "RepayDebtAgent" };

function context(bp: KidoAgentBlueprint, authority: Extract<AuthorityResult, { ok: true }>, at: bigint): CompileContext {
  const lease = authority.lease(keccak256(toHex(`attack-lab-lease:${bp.kidoAgentId}`)), BigInt(Math.floor(Date.now() / 1000)));
  let n = 0n;
  return { accountId: authority.policy.accountId, policy: authority.policy, lease, bindings: authority.bindings as CompileContext["bindings"], nextNonce: () => ++n, now: () => at, ttlSeconds: 300n };
}

function judge(bp: KidoAgentBlueprint, authority: AuthorityResult | null, step: SemanticStep, at: bigint): LabVerdict {
  if (!authority?.ok) return { verdict: "REJECT", code: "KIDO_NO_AUTHORITY", detail: authority ? authority.blockers.join("; ") : "this blueprint grants no on-chain authority", layer: "NONE" };
  const withRules = compileStep(step, keccak256(toHex(`attack-lab:${step.stepId}`)), 0, context(bp, authority, at), { preflight: true });
  if (withRules.ok) {
    const i = withRules.intent;
    return { verdict: "ALLOW", code: null, detail: "inside the lease and the owner policy; Amane would execute it", layer: "NONE", intent: { actionKind: i.actionKind, amountIn: i.amountIn.toString(), minAmountOut: i.minAmountOut.toString(), recipientLabel: i.recipientLabel, deadline: i.deadline.toString(), leaseId: i.leaseId } };
  }
  // Separate Kido's compiler from Amane's rules: without preflight only the compiler runs.
  const compilerOnly = compileStep(step, keccak256(toHex(`attack-lab:${step.stepId}`)), 0, context(bp, authority, at), { preflight: false });
  return { verdict: "REJECT", code: withRules.code, detail: withRules.detail, layer: compilerOnly.ok ? "AMANE_RULES" : "KIDO_COMPILER" };
}

export function evaluateWhatIf(bp: KidoAgentBlueprint, authority: AuthorityResult | null, w: WhatIf): LabVerdict {
  if (!/^\d+$/.test(w.amount)) return { verdict: "REJECT", code: "KIDO_BAD_AMOUNT", detail: "amount must be whole base units", layer: "KIDO_COMPILER" };
  if (!bp.chains.includes(w.chain)) return { verdict: "REJECT", code: "KIDO_PLAN_CHAIN_NOT_IN_BLUEPRINT", detail: `${w.chain} is not one of this agent's chains; no account or policy exists there`, layer: "KIDO_COMPILER" };
  const step: SemanticStep = { stepId: `what-if-${Date.now()}`, chain: w.chain, action: w.action as Action as SemanticStep["action"], asset: w.asset, assetOut: w.assetOut ?? null, amount: BigInt(w.amount), payee: w.recipient || null, dependsOn: [], origin: "DETERMINISTIC" };
  return judge(bp, authority, step, BigInt(Math.floor(Date.now() / 1000)) + BigInt(w.atSecondsFromNow ?? 0));
}

/**
 * A compromised specialist (e.g. after a prompt injection) proposes moving `amount` to `target`.
 * Kido's validator runs first; whatever survives goes through the Amane rules.
 */
export function injectionTest(bp: KidoAgentBlueprint, authority: AuthorityResult | null, t: { instruction: string; target: string; amount: string; chain?: string | undefined }): { stages: { layer: string; outcome: "PASSED" | "REFUSED"; reason: string }[]; verdict: LabVerdict } {
  const chain = (t.chain ?? bp.chains[0]!) as ChainId;
  if (!bp.chains.includes(chain)) return { stages: [{ layer: "Kido compiler", outcome: "REFUSED", reason: `${chain} is not one of this agent's chains` }], verdict: { verdict: "REJECT", code: "KIDO_PLAN_CHAIN_NOT_IN_BLUEPRINT", detail: "no account or policy exists on that chain", layer: "KIDO_COMPILER" } };
  // The specialist a thief would hijack: one whose action is actually routed on this chain, payments first.
  const routed = bp.authority.allowedActions.filter((a) => SPECIALIST_FOR[a] && bp.actions.some((r) => r.action === a && r.chain === chain));
  const act = (routed.includes("PAY") ? "PAY" : (routed[0] ?? "PAY")) as SemanticStep["action"];
  const asset = bp.authority.limits.find((l) => l.chain === chain)?.asset ?? bp.assets[0]?.symbol ?? "";
  const plan = {
    objective: t.instruction.slice(0, 200),
    decision: "PROPOSE_PLAN",
    steps: [{ stepId: "injected", chain, action: act, asset, assetOut: null, amount: t.amount, payee: t.target, dependsOn: [], rationale: t.instruction.slice(0, 200) }],
    requests: [],
    summary: "injected instruction",
  };
  const stages: { layer: string; outcome: "PASSED" | "REFUSED"; reason: string }[] = [];
  const v = validateProposal(plan, (SPECIALIST_FOR[act] ?? "PaymentAgent") as never, { chains: bp.chains, assets: [...new Set(bp.authority.limits.map((l) => l.asset))] });
  if (!v.ok) {
    stages.push({ layer: "Kido plan validator", outcome: "REFUSED", reason: v.reasons.join("; ") });
    return { stages, verdict: { verdict: "REJECT", code: v.reasons[0] ?? "KIDO_REASON_SCHEMA", detail: "the proposal never reaches the chain", layer: "KIDO_VALIDATOR" } };
  }
  stages.push({ layer: "Kido plan validator", outcome: "PASSED", reason: "well-formed proposal from an allowed specialist" });
  const verdict = judge(bp, authority, v.steps[0]!, BigInt(Math.floor(Date.now() / 1000)));
  stages.push({ layer: verdict.layer === "KIDO_COMPILER" ? "Kido compiler" : "Amane rules (enforced on-chain)", outcome: verdict.verdict === "ALLOW" ? "PASSED" : "REFUSED", reason: verdict.verdict === "ALLOW" ? "inside the owner's limits and payees" : `${verdict.code}: ${verdict.detail}` });
  return { stages, verdict };
}
