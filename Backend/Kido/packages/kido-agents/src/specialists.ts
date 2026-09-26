import type { BaseAction } from "./vocabulary.js";

/** Bible §25: each specialist owns a narrow semantic responsibility and cannot widen it. */
export interface SpecialistContract {
  name: string;
  owns: BaseAction[];
  mayRequest: BaseAction[];
  mayNotPropose: BaseAction[];
  mayReasonAbout: string[];
}

export const SPECIALISTS = {
  RepayDebtAgent: {
    name: "RepayDebtAgent",
    owns: ["REPAY"],
    mayRequest: ["SWAP", "BRIDGE"],
    mayNotPropose: ["BORROW", "WITHDRAW"],
    mayReasonAbout: ["funding source", "repayment amount", "repayment order"],
  },
  SwapAgent: {
    name: "SwapAgent",
    owns: ["SWAP"],
    mayRequest: ["BRIDGE"],
    mayNotPropose: ["BORROW", "WITHDRAW"],
    mayReasonAbout: ["which pair and pool", "swap size against the owner floor", "timing"],
  },
  PaymentAgent: {
    name: "PaymentAgent",
    owns: ["PAY"],
    mayRequest: ["SWAP", "BRIDGE"],
    mayNotPropose: ["BORROW", "WITHDRAW"],
    mayReasonAbout: ["which approved payee", "which chain endpoint funds the payment", "splitting a payment across endpoints"],
  },
  RecoveryAgent: {
    name: "RecoveryAgent",
    owns: ["PAY", "SWAP", "REPAY"],
    mayRequest: ["BRIDGE"],
    mayNotPropose: ["BORROW", "WITHDRAW"],
    mayReasonAbout: ["completed steps", "remaining budget", "safe termination"],
  },
} as const satisfies Record<string, SpecialistContract>;

export type SpecialistName = keyof typeof SPECIALISTS;
