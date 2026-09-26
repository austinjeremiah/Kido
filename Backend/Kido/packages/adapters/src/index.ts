import { encodeFunctionData, keccak256, isAddress, getAddress, type Address, type Hex } from "viem";
import { z } from "zod";

/**
 * Typed transaction adapters.
 *
 * This is the boundary that stops an untrusted LLM from inventing calldata for a privileged
 * executor. The agent supplies *semantic parameters*; the adapter deterministically produces the
 * bytes. There is deliberately NO generic "arbitrary call" adapter — one would undermine the
 * entire claim that the agent holds narrowly scoped authority.
 *
 * Every adapter must also produce a `summarize()` derived from THE SAME parameters used to encode
 * calldata. That shared derivation is what makes the human-facing summary trustworthy: it is not
 * possible for the display to say one thing while the bytes do another (test LED-007 in Phase 7
 * depends on this).
 */

export const ActionKind = {
  MOCK_TRANSFER: "MOCK_TRANSFER",
  REPAY_VIRTUAL_DEBT: "REPAY_VIRTUAL_DEBT",
} as const;
export type ActionKind = (typeof ActionKind)[keyof typeof ActionKind];

/** On-chain action kind identifier, matching the policy registry's `bytes32 actionKind`. */
export function actionKindHash(kind: ActionKind): Hex {
  return keccak256(new TextEncoder().encode(kind) as unknown as Uint8Array);
}

// `strict: false` disables viem's checksum-casing requirement. Per the canonicalization rules,
// an address is a 20-byte value and checksum casing is presentation only — so we accept any
// casing here and normalize with getAddress, rather than rejecting a structurally valid address
// for a display convention.
const addressSchema = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), { message: "not a valid EVM address" })
  .transform((v) => getAddress(v) as Address);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * A recipient address that must not be a burn address.
 *
 * Found by fuzzing (FND-014). Format validation alone accepted `0x000…000`, which would mint a
 * perfectly valid capability to destroy value irreversibly. Under ContextLock's own threat model
 * the agent is assumed compromised, and "cannot steal but can burn" is not an acceptable outcome —
 * a policy that permits a transfer to nowhere is not a spending policy.
 *
 * Note this is a *semantic* check, deliberately separate from the format check above. Rejecting it
 * at the adapter means the bytes are never even built, so nothing downstream has to catch it.
 */
const recipientSchema = addressSchema.refine((v) => v.toLowerCase() !== ZERO_ADDRESS, {
  message: "recipient must not be the zero address (funds would be unrecoverable)",
});

/**
 * Integer base units as a decimal string. Never a float — see the canonicalization rules.
 *
 * Implemented as a single `superRefine` rather than `.regex().refine().refine()`. Zod runs every
 * check on a string without short-circuiting, so a chained `.refine(v => BigInt(v) > 0n)` still
 * executes on input the regex already rejected — and `BigInt("1.5")` THROWS rather than returning
 * false, escaping validation as an unhandled 500. A validator must be total: it returns an issue,
 * it never throws. See reports/phase-02/findings/FND-007.
 */
const baseUnitsSchema = z.string().superRefine((v, ctx) => {
  if (!/^[0-9]+$/.test(v)) {
    ctx.addIssue({ code: "custom", message: "amount must be integer base units as a decimal string" });
    return;
  }
  const n = BigInt(v);
  if (n <= 0n) {
    ctx.addIssue({ code: "custom", message: "amount must be positive" });
    return;
  }
  if (n > 2n ** 128n) {
    ctx.addIssue({ code: "custom", message: "amount unreasonably large" });
  }
});

export const mockTransferParams = z
  .object({ recipient: recipientSchema, amount: baseUnitsSchema })
  .strict();
export type MockTransferParams = z.infer<typeof mockTransferParams>;

export const repayVirtualDebtParams = z
  .object({ amount: baseUnitsSchema })
  .strict();

export type CandidateTransaction = {
  chainId: number;
  target: Address;
  value: bigint;
  calldata: Hex;
  calldataHash: Hex;
  actionKind: ActionKind;
  actionKindHash: Hex;
  /** Human-readable fields derived from the same params that produced `calldata`. */
  semanticSummary: Record<string, string>;
};

export type AdapterContext = { chainId: number; target: Address };

export interface TransactionAdapter<TIn> {
  readonly actionKind: ActionKind;
  readonly schema: z.ZodType<TIn>;
  build(params: TIn, ctx: AdapterContext): CandidateTransaction;
}

const MOCK_TREASURY_ABI = [
  {
    type: "function",
    name: "transferTo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const mockTransferAdapter: TransactionAdapter<MockTransferParams> = {
  actionKind: ActionKind.MOCK_TRANSFER,
  schema: mockTransferParams,
  build(params, ctx) {
    // Single source of truth for both the bytes and the summary.
    const recipient = params.recipient;
    const amount = BigInt(params.amount);

    const calldata = encodeFunctionData({
      abi: MOCK_TREASURY_ABI,
      functionName: "transferTo",
      args: [recipient, amount],
    });

    return {
      chainId: ctx.chainId,
      target: ctx.target,
      value: 0n,
      calldata,
      calldataHash: keccak256(calldata),
      actionKind: ActionKind.MOCK_TRANSFER,
      actionKindHash: actionKindHash(ActionKind.MOCK_TRANSFER),
      semanticSummary: {
        action: "Transfer treasury units",
        recipient,
        amount: amount.toString(),
        target: ctx.target,
        value: "0",
      },
    };
  },
};

const registry: Record<string, TransactionAdapter<never>> = {
  [ActionKind.MOCK_TRANSFER]: mockTransferAdapter as unknown as TransactionAdapter<never>,
};

export class UnknownActionKindError extends Error {
  constructor(kind: string) {
    super(`Unknown or unsupported actionKind: ${kind}`);
    this.name = "UnknownActionKindError";
  }
}

export function getAdapter(kind: string): TransactionAdapter<never> {
  const a = registry[kind];
  if (!a) throw new UnknownActionKindError(kind);
  return a;
}

export function supportedActionKinds(): string[] {
  return Object.keys(registry);
}
