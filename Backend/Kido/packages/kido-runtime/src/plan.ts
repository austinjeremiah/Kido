import { PlanProposalSchema, SPECIALISTS, type BaseAction, type Chain, type PlanProposal, type SpecialistName } from "@kido/agents";
import { keccak256, toHex } from "viem";

export interface SemanticStep {
  stepId: string;
  chain: Chain;
  action: BaseAction;
  asset: string;
  amount: bigint;
  payee: string | null;
  dependsOn: string[];
  origin: "DETERMINISTIC" | SpecialistName;
}

export type PlanValidation = { ok: true; steps: SemanticStep[]; planHash: `0x${string}` } | { ok: false; reasons: string[] };

/**
 * Turns an untrusted specialist proposal into semantic steps, or rejects it. This is Kido's own
 * gate, applied before Amane; Amane still enforces independently on-chain.
 */
export function validateProposal(raw: unknown, specialist: SpecialistName, known: { chains: Chain[]; assets: string[] }): PlanValidation {
  const parsed = PlanProposalSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reasons: parsed.error.issues.map((i) => `KIDO_REASON_SCHEMA: ${i.path.join(".")} ${i.message}`) };
  const p: PlanProposal = parsed.data;
  if (p.decision !== "PROPOSE_PLAN") return { ok: false, reasons: [`KIDO_REASON_${p.decision}`] };
  const c = SPECIALISTS[specialist];
  const allowed = new Set<BaseAction>([...c.owns, ...c.mayRequest]);
  const forbidden = new Set<BaseAction>(c.mayNotPropose);
  const reasons: string[] = [];
  const ids = new Set<string>();
  for (const s of p.steps) {
    if (ids.has(s.stepId)) reasons.push(`KIDO_PLAN_DUPLICATE_STEP: ${s.stepId}`);
    ids.add(s.stepId);
    if (forbidden.has(s.action)) reasons.push(`KIDO_REASON_FORBIDDEN_ACTION: ${specialist} may not propose ${s.action}`);
    else if (!allowed.has(s.action)) reasons.push(`KIDO_REASON_OUTSIDE_CONTRACT: ${specialist} does not own ${s.action}`);
    if (!known.chains.includes(s.chain)) reasons.push(`KIDO_PLAN_UNKNOWN_CHAIN: ${s.chain}`);
    if (!known.assets.includes(s.asset)) reasons.push(`KIDO_PLAN_UNKNOWN_ASSET: ${s.asset}`);
    for (const d of s.dependsOn) if (!ids.has(d)) reasons.push(`KIDO_PLAN_BAD_DEPENDENCY: ${s.stepId} → ${d}`);
  }
  if (p.steps.length === 0) reasons.push("KIDO_PLAN_EMPTY");
  if (reasons.length) return { ok: false, reasons };
  const steps = p.steps.map((s) => ({ ...s, amount: BigInt(s.amount), origin: specialist }));
  return { ok: true, steps, planHash: planHash(steps) };
}

export function planHash(steps: SemanticStep[]): `0x${string}` {
  const canonical = steps.map((s) => [s.stepId, s.chain, s.action, s.asset, s.amount.toString(), s.payee ?? "", [...s.dependsOn].sort().join(",")]);
  return keccak256(toHex(JSON.stringify(canonical)));
}
