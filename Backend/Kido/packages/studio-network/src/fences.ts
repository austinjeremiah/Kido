import { assertExecutionAllowed, lookupNetwork, NetworkGuardError, type NetworkRef, type NetworkRole } from "./roles.js";

/**
 * The named write fences.
 *
 * §"Defense in depth": a single check is insufficient. Every subsystem that could produce a write
 * calls the guard through its own named fence, so a failure names the layer that caught it — and so
 * that removing one leaves the others.
 *
 * The list is closed and exported, which is what lets a test assert that every fence exists and
 * that each one independently refuses. A fence added to this list without a call site is a test
 * failure, not a silent gap.
 */
export const WRITE_FENCES = [
  "BLUEPRINT_VALIDATOR",
  "STRATEGY_COMPILER",
  "EXECUTION_PLAN_VALIDATOR",
  "ADAPTER_RESOLVER",
  "DEPLOYMENT_PREFLIGHT",
  "CONTEXTLOCK_BROKER",
  "SIGNER",
  "RELAYER",
  "AGENT_RUNTIME",
  "CRE_BROADCAST",
] as const;
export type WriteFence = (typeof WRITE_FENCES)[number];

/**
 * The single call every fence makes.
 *
 * Thin on purpose. The value is not in what this function does — it is that ten subsystems reach
 * the same guard, so approving a network is one decision in one registry rather than ten
 * conditionals that drift.
 */
export function fenceWrite(fence: WriteFence, ref: NetworkRef, intent: "PUBLIC_WRITE" | "LOCAL_WRITE" = "PUBLIC_WRITE"): void {
  assertExecutionAllowed(ref, intent, fence);
}

/**
 * Fence a write when the caller has a chain id and no role.
 *
 * Most write-capable subsystems are in exactly this position: the broker, the signer, the relayer
 * and the runtime each hold a configured `chainId` and nothing more. Making them assert a role
 * would be the mistake this whole model exists to prevent — **the role is a claim and the chain id
 * is the fact**, so a caller that guessed `TESTNET_EXECUTION` for a local fork would be refused for
 * claiming the wrong thing rather than permitted for doing the right thing.
 *
 * So the registry supplies the role, and the intent follows from it: a `LOCAL_FORK` write is a
 * `LOCAL_WRITE`, a `TESTNET_EXECUTION` write is a `PUBLIC_WRITE`. A production chain is refused
 * before either lookup happens, so nothing here can widen the boundary — an unknown chain is
 * refused too, because a chain nobody approved is not a chain we execute on.
 */
export function fenceWriteByChain(fence: WriteFence, chainId: number, opts: { forkedFrom?: number | null; forkBlock?: string | null } = {}): void {
  const known = lookupNetwork(chainId);
  const role: NetworkRole = known?.role ?? "TESTNET_EXECUTION";
  const intent = role === "LOCAL_FORK" ? "LOCAL_WRITE" : "PUBLIC_WRITE";
  assertExecutionAllowed(
    { chainId, role, forkedFrom: opts.forkedFrom ?? null, forkBlock: opts.forkBlock ?? null },
    intent,
    fence,
  );
}

/**
 * Fence a whole plan at once.
 *
 * Returns every rejection rather than the first, because a plan with two mainnet steps should
 * report both — an operator who fixes one and re-runs to find the other loses a cycle for nothing.
 */
export function fencePlan(fence: WriteFence, refs: ReadonlyArray<{ id: string; network: NetworkRef; intent?: "PUBLIC_WRITE" | "LOCAL_WRITE" }>): Array<{ id: string; reason: string; message: string }> {
  const rejections: Array<{ id: string; reason: string; message: string }> = [];
  for (const r of refs) {
    try {
      fenceWrite(fence, r.network, r.intent ?? "PUBLIC_WRITE");
    } catch (e) {
      const err = e as NetworkGuardError;
      rejections.push({ id: r.id, reason: err.reason, message: err.message });
    }
  }
  return rejections;
}

/**
 * A data source may inform a decision and may not authorize execution.
 *
 * The central rule of the whole group, expressed where a compiler can reach it: given the networks a
 * decision READ from and the network it wants to WRITE to, the write is judged entirely on its own
 * network. Nothing about the read set can make a write legal.
 */
export function assertDataCannotGrantExecution(
  readSources: ReadonlyArray<NetworkRef>,
  executionTarget: NetworkRef,
  fence: WriteFence,
): void {
  // Reads are unrestricted and deliberately not consulted below. Naming the parameter and ignoring
  // it is the point: a future edit that starts consulting it would be visible in review.
  void readSources;
  fenceWrite(fence, executionTarget, "PUBLIC_WRITE");
}
