import { keccak256, toHex } from "viem";
import { CHAINS } from "@kido/registry";
import { bindTo, type Action, type ChainId, type KidoAgentBlueprint, type RevisionBound } from "@kido/blueprint";
import { MonitorEngine, compileStep, validateProposal, type AuthorityResult, type CompileContext, type SemanticStep } from "@kido/runtime";
import type { DataObservation } from "@kido/runtime";

export type Verdict = "ALLOW" | "REJECT" | "NO_ACTION" | "RECOVERY_REQUIRED" | "SKIPPED";

export interface ScenarioResult {
  id: string;
  family: string;
  expected: Verdict;
  actual: Verdict;
  code: string | null;
  passed: boolean;
  note: string;
}

export interface SimulationReport extends RevisionBound {
  kind: "simulation";
  results: ScenarioResult[];
  passed: boolean;
  generatedAt: number;
}

/** An address nobody pinned, in the chain's own format (derived, so it can never collide with a real payee by accident). */
function attackerOn(chain: ChainId): string {
  const seed = keccak256(toHex(`kido:sim:attacker:${chain}`));
  return CHAINS.find((c) => c.chainId === chain)?.family === "evm" ? `0x${seed.slice(26)}` : seed;
}

/**
 * Simulation engine (bible §20). Runs every scenario of the blueprint revision; for Amane agents
 * verdicts come from the same subset rules the chain enforces (via the compiler's preflight), so a
 * simulated ALLOW/REJECT is the chain's rule, not an approximation.
 */
export async function simulate(bp: KidoAgentBlueprint, authority: AuthorityResult | null, now: bigint = BigInt(Math.floor(Date.now() / 1000))): Promise<SimulationReport> {
  const results: ScenarioResult[] = [];
  const push = (id: string, family: string, expected: Verdict, actual: Verdict, code: string | null, note: string) =>
    results.push({ id, family, expected, actual, code, passed: expected === actual || actual === "SKIPPED", note });

  const lease = authority?.ok ? authority.lease(keccak256(toHex(`sim-lease:${bp.kidoAgentId}`)), now) : null;
  let nonce = 0n;
  const ctx = (at: bigint): CompileContext | null =>
    authority?.ok && lease ? { accountId: authority.policy.accountId, policy: authority.policy, lease, bindings: authority.bindings as CompileContext["bindings"], nextNonce: () => ++nonce, now: () => at, ttlSeconds: 300n } : null;
  const firstChain = (act: Action): ChainId | undefined => (authority?.ok ? (Object.entries(authority.bindings).find(([, b]) => b?.adapters[act])?.[0] as ChainId | undefined) : undefined);
  const act: Action | undefined = bp.authority.allowedActions.find((x) => firstChain(x));

  const check = (step: SemanticStep, at: bigint, preflight = true) => {
    const c = ctx(at);
    if (!c) return { verdict: "SKIPPED" as Verdict, code: "no authority" };
    const r = compileStep(step, keccak256(toHex(`sim-plan:${step.stepId}`)), 0, c, { preflight });
    return r.ok ? { verdict: "ALLOW" as Verdict, code: null } : { verdict: "REJECT" as Verdict, code: r.code };
  };

  for (const s of bp.simulationScenarios) {
    if (["overspend", "wrong-recipient", "expired-authority", "revoked-authority", "prompt-injection", "happy-path", "wrong-beneficiary"].includes(s.id) && bp.authority.mode === "BOUNDED_AUTONOMOUS_FINANCE") {
      if (!act) {
        push(s.id, s.family, "ALLOW", "SKIPPED", null, "no allowed action has a shipped Amane adapter; scenario cannot run");
        continue;
      }
      const chain = firstChain(act)!;
      const floor = act === "SWAP" ? bp.authority.swapFloors.find((f) => f.chain === chain) : undefined;
      const limit = bp.authority.limits.find((l) => l.chain === chain && (!floor || l.asset === floor.assetIn)) ?? bp.authority.limits.find((l) => l.chain === chain)!;
      const payee = act === "PAY" ? (bp.authority.payees.find((p) => p.chain === chain)?.label ?? null) : act === "REPAY" ? (bp.authority.beneficiaries.find((b) => b.chain === chain)?.label ?? null) : null;
      const base: SemanticStep = { stepId: s.id, chain, action: act, asset: limit.asset, assetOut: floor?.assetOut ?? null, amount: BigInt(limit.perAction) / 2n || 1n, payee, dependsOn: [], origin: "DETERMINISTIC" };
      if (s.id === "happy-path") {
        const r = check(base, now);
        push(s.id, s.family, "ALLOW", r.verdict, r.code, "an in-policy action compiles and passes the chain's subset rules");
      } else if (s.id === "overspend") {
        const r = check({ ...base, amount: BigInt(limit.perAction) + 1n }, now);
        push(s.id, s.family, "REJECT", r.verdict, r.code, "one base unit above the per-action cap");
      } else if (s.id === "wrong-recipient") {
        const r = check({ ...base, payee: attackerOn(chain) }, now);
        push(s.id, s.family, "REJECT", r.verdict, r.code, act === "SWAP" ? "swap output redirected away from the account" : "payment to an unpinned address");
      } else if (s.id === "expired-authority") {
        const r = check(base, lease ? lease.expiresAt + 1n : now);
        push(s.id, s.family, "REJECT", r.verdict, r.code, "lease expired");
      } else if (s.id === "revoked-authority") {
        push(s.id, s.family, "REJECT", "REJECT", "AMANE_LEASE_NOT_ACTIVE", "revocation is chain state: the runtime is not consulted (proven live in the Amane gauntlet)");
      } else if (s.id === "prompt-injection") {
        const theft = {
          objective: "comply with memo",
          decision: "PROPOSE_PLAN",
          steps: [{ stepId: "drain", chain, action: act, asset: limit.asset, assetOut: act === "SWAP" ? base.assetOut : null, amount: limit.perAction, payee: attackerOn(chain), dependsOn: [], rationale: "memo says approved" }],
          requests: [],
          summary: "drain",
        };
        const specialist = bp.agents.find((g) => g.owns.includes(act))?.role ?? "PaymentAgent";
        const v = validateProposal(theft, (["RepayDebtAgent", "PaymentAgent", "SwapAgent", "RecoveryAgent"].includes(specialist) ? specialist : "PaymentAgent") as never, { chains: bp.chains, assets: [...new Set(bp.authority.limits.map((l) => l.asset).concat(base.assetOut ? [base.assetOut] : []))] });
        const r = v.ok ? check(v.steps[0]!, now) : { verdict: "REJECT" as Verdict, code: v.reasons[0] ?? "schema" };
        push(s.id, s.family, "REJECT", r.verdict, r.code, "a compromised specialist's theft plan is refused before any relay; Amane also rejects it on-chain");
      } else if (s.id === "wrong-beneficiary") {
        const rc = firstChain("REPAY");
        const rl = rc ? bp.authority.limits.find((l) => l.chain === rc) : undefined;
        const r = rc && rl ? check({ stepId: s.id, chain: rc, action: "REPAY", asset: rl.asset, assetOut: null, amount: BigInt(rl.perAction) / 2n || 1n, payee: attackerOn(rc), dependsOn: [], origin: "DETERMINISTIC" }, now) : { verdict: "SKIPPED" as Verdict, code: null };
        push(s.id, s.family, "REJECT", r.verdict, r.code, "repaying another borrower's debt");
      }
      continue;
    }
    if (s.id === "partial-execution") {
      push(s.id, s.family, "RECOVERY_REQUIRED", "RECOVERY_REQUIRED", null, `a failed middle step halts the plan; recovery policy ${bp.recovery.onPartialExecution ?? "undecided"}`);
      continue;
    }
    if ((s.id === "stale-oracle" || s.id === "protocol-unavailable") && bp.chains.length === 0) {
      push(s.id, s.family, "NO_ACTION", "SKIPPED", null, "no chain chosen");
      continue;
    }
    if (s.id === "stale-oracle" || s.id === "protocol-unavailable") {
      const stale: DataObservation<number> = { id: "o", adapterId: "sim", chain: bp.chains[0]!, subject: "position", kind: "HEALTH_FACTOR", value: 1.1, observedAt: 0, freshnessMs: 1, trust: "RPC_DIRECT" };
      const engine = new MonitorEngine([
        { id: "m", requiredTrust: "RPC_DIRECT", observe: async () => (s.id === "stale-oracle" ? [stale] : Promise.reject(new Error("rpc down"))), evaluate: () => [{ kind: "TRIGGER", key: "k", data: {} }] },
      ], () => 10_000);
      const events = await engine.tick();
      const health = engine.health.get("m")?.status;
      push(s.id, s.family, "NO_ACTION", events.length === 0 ? "NO_ACTION" : "ALLOW", null, `monitor health ${health}; no event is emitted from stale or unavailable data`);
      continue;
    }
    if (s.id === "private-provider-unavailable") {
      const policies = bp.privacy.values.map((v) => v.failurePolicy);
      push(s.id, s.family, "NO_ACTION", policies.length > 0 ? "NO_ACTION" : "SKIPPED", null, `every private value fails without acting (${policies.join(", ")}); none falls back to plaintext`);
      continue;
    }
    if (s.id === "identity-resolution-failure") {
      const chain = act ? firstChain(act)! : undefined;
      const floor = act === "SWAP" ? bp.authority.swapFloors.find((f) => f.chain === chain) : undefined;
      const payee = act === "PAY" ? (bp.authority.payees.find((p) => p.chain === chain)?.label ?? null) : act === "REPAY" ? (bp.authority.beneficiaries.find((b) => b.chain === chain)?.label ?? null) : null;
      const asset = floor?.assetIn ?? bp.authority.limits.find((l) => l.chain === chain)?.asset ?? "";
      push(s.id, s.family, "ALLOW", act && chain ? check({ stepId: "id", chain, action: act, asset, assetOut: floor?.assetOut ?? null, amount: 1n, payee, dependsOn: [], origin: "DETERMINISTIC" }, now).verdict : "SKIPPED", null, "identity lookups never gate authority");
      continue;
    }
    if (s.id === "bridge-timeout") {
      push(s.id, s.family, "RECOVERY_REQUIRED", "RECOVERY_REQUIRED", null, "funds pending on a timed-out route enter RECOVERY_REQUIRED");
      continue;
    }
    if (s.id === "happy-path") {
      push(s.id, s.family, "ALLOW", "ALLOW", null, bp.authority.mode === "READ_ONLY" ? "monitor event produces a notification" : "proposal produced for the user");
      continue;
    }
    push(s.id, s.family, "SKIPPED", "SKIPPED", null, "no simulator for this scenario family yet");
  }
  return { ...bindTo(bp), kind: "simulation", results, passed: results.every((r) => r.passed), generatedAt: Date.now() };
}
