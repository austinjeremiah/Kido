import { z } from "zod";

/** Bible §21. Kido reasons only in these; adapters build chain-native transactions from them. */
export const BASE_ACTIONS = [
  "SWAP", "SUPPLY", "REPAY", "BORROW", "WITHDRAW", "STAKE", "UNSTAKE", "ADD_LIQUIDITY", "REMOVE_LIQUIDITY", "PAY", "BRIDGE",
] as const;
export const BaseActionSchema = z.enum(BASE_ACTIONS);
export type BaseAction = z.infer<typeof BaseActionSchema>;

export const CHAINS = ["ethereum-sepolia", "sui-testnet"] as const;
export const ChainSchema = z.enum(CHAINS);
export type Chain = z.infer<typeof ChainSchema>;

const baseUnits = z.string().regex(/^[1-9][0-9]{0,30}$/, "amount must be a positive integer in token base units");

/**
 * One proposed step. There is deliberately no target, calldata, adapter address or signature field:
 * a specialist names a semantic action and a payee, and Kido's compiler plus Amane decide whether
 * that becomes executable. `.strict()` makes any extra field a schema rejection (KIDO-REASON-003).
 */
export const ProposedStepSchema = z
  .object({
    stepId: z.string().regex(/^[a-z0-9-]{1,32}$/),
    chain: ChainSchema,
    action: BaseActionSchema,
    asset: z.string().min(1).max(16),
    /** SWAP only: the asset received. Null for every other action. */
    assetOut: z.string().min(1).max(16).nullable(),
    amount: baseUnits,
    payee: z.string().max(80).nullable(),
    dependsOn: z.array(z.string()).max(8),
    rationale: z.string().max(600),
  })
  .strict();
export type ProposedStep = z.infer<typeof ProposedStepSchema>;

export const PlanProposalSchema = z
  .object({
    objective: z.string().max(300),
    decision: z.enum(["PROPOSE_PLAN", "NO_COMPLIANT_PLAN", "NEEDS_HUMAN"]),
    steps: z.array(ProposedStepSchema).max(6),
    requests: z.array(z.object({ action: BaseActionSchema, reason: z.string().max(300) }).strict()).max(4),
    summary: z.string().max(600),
  })
  .strict();
export type PlanProposal = z.infer<typeof PlanProposalSchema>;
