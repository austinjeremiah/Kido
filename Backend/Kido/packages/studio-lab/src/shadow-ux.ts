import { z } from "zod";
import { explorerUrlFor, LOCAL_FORK_TX_LABEL, type ForkDescriptor, type ForkTransaction } from "@contextlock/studio-reality";
import type { ShadowDecision } from "@contextlock/studio-reality";
import { lookupNetwork } from "@contextlock/studio-network";

/**
 * Shadow mode and fork execution, as a user reads them.
 *
 * §P28.40–41. The whole surface exists to hold apart two things a screen naturally merges: what the
 * agent decided *about mainnet*, and where the action actually happened. A shadow run watches the
 * real market and executes somewhere that is not it, and a panel that showed the decision above a
 * transaction hash — with nothing between them — would be describing a mainnet trade.
 *
 * Hence `publicMainnetTransaction` is a field with one possible value, and `publicExplorer` is
 * computed by asking the explorer resolver rather than by remembering not to build a URL.
 */

export const SHADOW_UX_REASONS = {
  EXPLORER_FOR_FORK: "FORK_TRANSACTION_GIVEN_PUBLIC_EXPLORER_URL",
  MAINNET_EXECUTION_CLAIMED: "SHADOW_RUN_PRESENTED_AS_MAINNET_EXECUTION",
} as const;

export class ShadowUxError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ShadowUxError";
  }
}

export const ShadowRunViewSchema = z.object({
  /** The chain being observed, named with its role. §P28.9. */
  watching: z.object({ chainId: z.number().int().positive(), name: z.string().min(1), role: z.literal("READ_ONLY_SOURCE"), roleLabel: z.string().min(1) }),
  decision: z.string().min(1),
  reasonCode: z.string().min(1),
  /** What it would have done on mainnet — semantic, never executable. */
  proposedAction: z.object({ kind: z.string().min(1), asset: z.string().nullable(), amount: z.string().nullable(), protocol: z.string().nullable() }),
  /** Where it actually ran. */
  actualExecution: z.object({ environment: z.enum(["LOCAL_FORK", "TESTNET", "NONE"]), label: z.string().min(1), chainId: z.number().int().positive().nullable() }),
  /** One possible value. There is no shape of this object that reports a mainnet transaction. */
  publicMainnetTransaction: z.literal("NONE"),
  marketSnapshotHash: z.string().min(1),
  scenarioHash: z.string().nullable(),
});
export type ShadowRunView = z.infer<typeof ShadowRunViewSchema>;

/**
 * The shadow panel for one decision.
 *
 * `watching` is derived from the decision's own anchor chain rather than passed in, so a caller
 * cannot label a testnet observation "Ethereum Mainnet".
 */
export function shadowRunView(args: {
  decision: ShadowDecision;
  watchingChainId: number;
  fork?: ForkDescriptor | null;
}): ShadowRunView {
  const net = lookupNetwork(args.watchingChainId);
  if (!net || net.role !== "READ_ONLY_SOURCE") {
    throw new ShadowUxError(
      SHADOW_UX_REASONS.MAINNET_EXECUTION_CLAIMED,
      `a shadow run watches a read-only source; chain ${args.watchingChainId} is ${net ? net.role : "unknown"}.`,
    );
  }

  const env = args.decision.executionEnvironment;
  const label =
    env === "LOCAL_FORK"
      ? `LOCAL MAINNET FORK${args.fork ? ` at block ${args.fork.forkBlock}` : ""} — SIMULATION EXECUTION`
      : env === "TESTNET"
        ? `${lookupNetwork(args.decision.executionChainId ?? 0)?.name ?? "testnet"} — TESTNET EXECUTION`
        : "Nothing was executed";

  const action = args.decision.proposedMainnetSemanticAction;
  return {
    watching: { chainId: args.watchingChainId, name: net.name, role: "READ_ONLY_SOURCE", roleLabel: "ETHEREUM MAINNET — READ ONLY" },
    decision: args.decision.verdict,
    reasonCode: args.decision.reasonCode,
    proposedAction: {
      kind: action.kind,
      asset: action.assetId,
      amount: action.amount,
      protocol: action.protocol,
    },
    actualExecution: { environment: env, label, chainId: args.decision.executionChainId },
    publicMainnetTransaction: "NONE",
    marketSnapshotHash: args.decision.marketSnapshotHash,
    scenarioHash: args.decision.scenarioHash,
  };
}

/* ─────────────────────────── fork action detail ─────────────────────────── */

export const ForkActionDetailSchema = z.object({
  heading: z.literal("LOCAL MAINNET FORK"),
  sourceChain: z.string().min(1),
  sourceBlock: z.string().regex(/^\d+$/),
  sourceBlockHash: z.string().min(1),
  protocol: z.string().min(1),
  input: z.string().min(1),
  output: z.string().min(1),
  transactionHash: z.string().min(1),
  /** Fixed. §P27.30 / §P28.41 — the hash is indistinguishable, so the label carries the truth. */
  transaction: z.literal(LOCAL_FORK_TX_LABEL),
  /** Always the string NONE. Never a URL, and never an empty field a template might fill. */
  publicExplorer: z.literal("NONE"),
  explorerNote: z.string().min(1),
  status: z.enum(["success", "reverted"]),
  gasUsed: z.string().min(1),
  impersonated: z.boolean(),
});
export type ForkActionDetail = z.infer<typeof ForkActionDetailSchema>;

/**
 * The fork action panel.
 *
 * `publicExplorer` is not hard-coded to NONE and then asserted; the resolver is *asked*, and a
 * non-null answer throws. The difference matters: if someone later teaches `explorerUrlFor` about
 * chain 31337, this fails loudly instead of quietly rendering a link to a page that will say the
 * transaction does not exist.
 */
export function forkActionDetail(args: {
  fork: ForkDescriptor;
  tx: ForkTransaction;
  protocol: string;
  input: string;
  output: string;
}): ForkActionDetail {
  const url = explorerUrlFor({ chainId: args.tx.chainId, hash: args.tx.hash });
  if (url !== null) {
    throw new ShadowUxError(
      SHADOW_UX_REASONS.EXPLORER_FOR_FORK,
      `a local fork transaction resolved to ${url}. This transaction exists only on this machine; that page would report it as not found, which reads as "not indexed yet" rather than "never happened".`,
    );
  }

  const source = lookupNetwork(args.fork.sourceChainId);
  return {
    heading: "LOCAL MAINNET FORK",
    sourceChain: `${source?.name ?? `chain ${args.fork.sourceChainId}`} — state copied, read only`,
    sourceBlock: args.fork.forkBlock,
    sourceBlockHash: args.fork.forkBlockHash,
    protocol: args.protocol,
    input: args.input,
    output: args.output,
    transactionHash: args.tx.hash,
    transaction: LOCAL_FORK_TX_LABEL,
    publicExplorer: "NONE",
    explorerNote: "This transaction exists only in the local fork. There is no public explorer for it, and pasting the hash into one would show a transaction that does not exist.",
    status: args.tx.status,
    gasUsed: args.tx.gasUsed,
    impersonated: args.tx.impersonated,
  };
}
