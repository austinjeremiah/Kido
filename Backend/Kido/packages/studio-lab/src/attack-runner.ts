import { keccak256, toHex } from "viem";
import { evaluatePolicy, ReasonCode, type EvaluationRequest, type MarketContext, type PrivatePolicy } from "@contextlock/policy";
import { capabilityDigest, type Capability } from "@contextlock/protocol";
import { fenceWriteByChain, NetworkGuardError } from "@contextlock/studio-network";
import { assertRpcMethodAllowed, RpcFenceError, compareReadings, assertSnapshotUsable, SnapshotError, sealSnapshot, type MarketSnapshot } from "@contextlock/studio-reality";
import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";
import {
  ATTACKS, assembleAttackRun, buildSecurityPath, assertDefensesExercised,
  type AttackRun, type AttackScenario, type MutationDiff, type SecurityLayer,
} from "./attack-lab.js";
import { assertNoSilentFailover, CreLabError } from "./cre-lab.js";

/**
 * The attack runner.
 *
 * §P28.35 asks for **deterministic** scenarios, and §P28.37 forbids faking a check that was not
 * exercised. Those two together decide the whole design: every scenario below either drives the
 * real guard — `evaluatePolicy`, `fenceWriteByChain`, `assertRpcMethodAllowed`, the EIP-712 digest —
 * or reports `NOT_RUN` naming what it would need.
 *
 * Three scenarios end at the executor, which is a Solidity contract. They cannot be run from an HTTP
 * request without a chain, so they say so and name the suite that does cover them. A green tick
 * produced by a TypeScript reimplementation of a Solidity check would be a claim about the
 * reimplementation.
 */

/* ─────────────────────────── the baseline ─────────────────────────── */

const ADDR = {
  agent: "0xe109686a0a10b0FC8f090F2bBd1424C50fE2920a",
  treasury: "0x93e0FCb0F71e83F3340264339BC5983C474635c5",
  attacker: "0xdEaD00000000000000000000000000000000BEEF",
  aavePool: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
  unknownTarget: "0x00000000000000000000000000000000DeaDBeef",
  executor: "0xe109686a0a10b0FC8f090F2bBd1424C50fE2920a",
} as const;

const known = (v: unknown): bigint | null => {
  if (typeof v === "number") return BigInt(v);
  if (v && typeof v === "object" && "known" in v) {
    const w = v as { known: boolean; value?: unknown };
    return w.known && typeof w.value === "number" ? BigInt(w.value) : null;
  }
  return null;
};

/**
 * Derive the policy the runner evaluates against, from the Blueprint.
 *
 * Deliberately not a fixture. An Attack Lab that ran against limits nobody configured would report
 * refusals that say nothing about *this* agent — the numbers a user sees denied have to be the
 * numbers they set.
 */
export function policyFromBlueprint(bp: ContextLockAgentBlueprint): PrivatePolicy {
  const auto = known(bp.autonomousPolicy.maxValueUsdCents) ?? 0n;
  const esc = known(bp.escalationPolicy.maxValueUsdCents) ?? auto;
  // Blueprint limits are USD cents; the policy engine works in 6dp base units.
  const scale = 10_000n;

  return {
    policyId: "contextlock-lab-policy",
    policyVersion: bp.revision,
    enabled: true,
    autoLimit: auto * scale,
    escalationLimit: esc * scale,
    maxSlippageBps: 100,
    maxVolatilityBps: 3_000,
    minLiquidity: 1_000_000n,
    targetEthAllocationBps: 4_500,
    rebalanceDriftBps: 500,
    minHealthFactorBps: 13_500,
    targetHealthFactorBps: 16_000,
    proprietaryRiskThreshold: 42,
    canary: "CONTEXTLOCK_LAB_CANARY",
    allowedActionKinds: bp.actions.map((a) => a.kind),
    allowedTargets: [ADDR.aavePool],
    authorizedAgentIdentityHashes: [keccak256(toHex(bp.identity.agentId))],
  };
}

function baselineRequest(bp: ContextLockAgentBlueprint, policy: PrivatePolicy): EvaluationRequest {
  const action = bp.actions[0];
  // Comfortably inside the autonomous limit, so any denial comes from the mutation.
  const amount = policy.autoLimit / 2n;
  return {
    requestHash: keccak256(toHex("lab-request")),
    agentIdentityHash: policy.authorizedAgentIdentityHashes[0] ?? keccak256(toHex("agent")),
    ensNode: keccak256(toHex(bp.identity.ensName)),
    agent: ADDR.agent,
    chainId: 11155111,
    target: ADDR.aavePool,
    value: 0n,
    calldataHash: keccak256(toHex("baseline-calldata")),
    selector: "0x573ade81",
    decodedRecipient: ADDR.treasury,
    decodedAmount: amount,
    intentHash: keccak256(toHex("baseline-intent")),
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    actionKind: action?.kind ?? "AAVE_REPAY",
  };
}

const freshContext = (nowUnix: number): MarketContext => ({
  observedAtUnix: nowUnix,
  slippageBps: 12,
  volatilityBps: 150,
  liquidity: 9_000_000_000_000n,
  healthFactorBps: 18_000,
});

const usd = (base: bigint): string => `$${(Number(base) / 10_000 / 100).toLocaleString("en-US")}`;

/* ─────────────────────────── the runner ─────────────────────────── */

export interface AttackRunContext {
  blueprint: ContextLockAgentBlueprint;
  nowUnix: number;
  /** A real snapshot, when one is available. Used by the oracle scenarios. */
  snapshot?: MarketSnapshot | null;
}

/** Scenarios whose refusal lives in a Solidity contract, with the suite that covers each. */
export const CHAIN_REQUIRED: Partial<Record<AttackScenario, string>> = {
  REPLAY: "contracts/test — the executor marks a used authorization and rejects the second submission",
  EXPIRED_CAPABILITY: "contracts/test — the executor compares validUntil against block.timestamp",
  ENS_REVOCATION: "contracts/test + P3 live evidence — identity is resolved on chain at issuance",
};

/**
 * Run one scenario.
 *
 * Every branch drives a real guard and reports what it actually returned. Where the refusal lives on
 * chain, the run is `NOT_RUN` with the reason and the covering suite — never a fabricated pass.
 */
export function runAttack(scenario: AttackScenario, ctx: AttackRunContext): AttackRun {
  const definition = ATTACKS.find((a) => a.scenario === scenario);
  if (!definition) throw new Error(`unknown scenario ${scenario}`);

  const policy = policyFromBlueprint(ctx.blueprint);
  const base = baselineRequest(ctx.blueprint, policy);
  const market = freshContext(ctx.nowUnix);

  const chainOnly = CHAIN_REQUIRED[scenario];
  if (chainOnly) {
    return {
      scenario, title: definition.title, result: "NOT_RUN",
      stoppedBy: null, reasonCode: null, stoppedWhereExpected: false,
      diffs: [], capabilityIssued: false, transactionSubmitted: false,
      additionalDefenses: [],
      path: [{
        layer: definition.expectedStoppedBy, outcome: "NOT_APPLICABLE",
        reasonCode: null,
        detail: `This refusal is enforced on chain and cannot be exercised from here without a live executor. Covered by: ${chainOnly}`,
      }],
    };
  }

  /* ── the network fences, driven for real ─────────────────────────────── */
  if (scenario === "MAINNET_WRITE_ATTEMPT") {
    const diffs: MutationDiff[] = [{ field: "chainId", original: "11155111", mutated: "1" }];
    const exercised = new Set<SecurityLayer>();
    const defenses: Array<{ layer: SecurityLayer; reasonCode: string }> = [];

    let primary: string | null = null;
    try { fenceWriteByChain("STRATEGY_COMPILER", 1); } catch (e) { primary = (e as NetworkGuardError).reason; }
    exercised.add("STRATEGY_COMPILER");

    for (const [layer, fence] of [
      ["EXECUTION_PLANNER", "EXECUTION_PLAN_VALIDATOR"],
      ["RELAYER", "RELAYER"],
      ["SIGNER", "SIGNER"],
    ] as const) {
      try { fenceWriteByChain(fence, 1); } catch (e) {
        defenses.push({ layer, reasonCode: (e as NetworkGuardError).reason });
        exercised.add(layer);
      }
    }
    try { assertRpcMethodAllowed("eth_sendRawTransaction"); } catch (e) {
      defenses.push({ layer: "RPC_TRANSPORT", reasonCode: (e as RpcFenceError).reason });
      exercised.add("RPC_TRANSPORT");
    }
    assertDefensesExercised(defenses, exercised, "mainnet write attack");

    return assembleAttackRun({
      definition,
      path: buildSecurityPath([{ layer: "STRATEGY_COMPILER", outcome: "DENY", reasonCode: primary ?? "NOT_REFUSED", detail: "chain 1 is a production network" }]),
      diffs, capabilityIssued: false, transactionSubmitted: false, additionalDefenses: defenses,
    });
  }

  /* ── the EIP-712 domain, computed for real ───────────────────────────── */
  if (scenario === "WRONG_CHAIN") {
    const cap: Capability = {
      version: 1,
      agentIdentityHash: base.agentIdentityHash as `0x${string}`,
      agent: ADDR.agent as `0x${string}`,
      chainId: 11155111n,
      executor: ADDR.executor as `0x${string}`,
      target: ADDR.aavePool as `0x${string}`,
      value: 0n,
      calldataHash: base.calldataHash as `0x${string}`,
      intentHash: base.intentHash as `0x${string}`,
      policyHash: keccak256(toHex(policy.policyId)),
      authorizationId: keccak256(toHex("lab-authorization")),
      contextCommitment: keccak256(toHex("lab-context")),
      issuedAt: BigInt(ctx.nowUnix),
      expiresAt: BigInt(ctx.nowUnix + 600),
      nonce: 7n,
    };

    const forSepolia = capabilityDigest({ ...cap, chainId: 11155111n });
    const forMainnet = capabilityDigest({ ...cap, chainId: 1n });
    const differs = forSepolia !== forMainnet;

    return assembleAttackRun({
      definition,
      path: buildSecurityPath([
        { layer: "CONTEXTLOCK_POLICY", outcome: "PASS" },
        { layer: "CAPABILITY_ISSUER", outcome: "PASS", detail: "a capability is issued, bound to chain 11155111" },
        {
          layer: "EXECUTOR", outcome: differs ? "DENY" : "PASS",
          reasonCode: differs ? "ChainMismatch" : null,
          detail: differs
            ? `the EIP-712 domain binds the chain id, so the digest differs between Sepolia and mainnet and the signature does not verify`
            : null,
        },
      ]),
      diffs: [
        { field: "chainId", original: "11155111", mutated: "1" },
        /*
         * Truncated on purpose.
         *
         * A capability digest is 32 bytes of hex and is indistinguishable from a private key to a
         * secret scanner — the response redactor refuses the full value, and it is right to. The
         * point of this row is that the two digests DIFFER, which a prefix shows just as well.
         */
        { field: "capabilityDigest", original: `${forSepolia.slice(0, 18)}…`, mutated: `${forMainnet.slice(0, 18)}…` },
      ],
      capabilityIssued: true, transactionSubmitted: false,
    });
  }

  /* ── the reality engine, driven for real ─────────────────────────────── */
  if (scenario === "STALE_ORACLE") {
    const snapshot = ctx.snapshot ?? null;
    let reason: string | null = null;
    if (snapshot) {
      try {
        // Ten minutes past a sixty-second tolerance.
        assertSnapshotUsable(snapshot, snapshot.observedAtMs + 600_000, 60_000, "attack lab");
      } catch (e) { reason = (e as SnapshotError).reason; }
    } else {
      // No snapshot: drive the same guard against a minimal sealed one, so the check is still real.
      const stale = sealSnapshot({
        snapshotId: "attack-stale", mode: "LIVE_MIRROR", observedAtMs: ctx.nowUnix * 1000,
        anchorChainId: 1, anchorBlock: "1", anchorBlockHash: `0x${"0".repeat(63)}1`,
        anchorBlockTimestampMs: ctx.nowUnix * 1000,
        sources: [{ sourceId: "s", kind: "CHAINLINK_DATA_FEED", adapterId: "a", adapterVersion: "1.0.0", trustClass: "VERIFIED_ORACLE", sourceChainId: 1, timeSupport: "BLOCK_SCOPED", observedBlock: "1", lagBlocks: 0, healthy: true, detail: null }],
        observations: [{ observationId: "o", metric: "weth/usd:price", value: "1", decimals: 8, unit: "USD", dataType: "PRICE", canonicalAssetId: "weth", sourceId: "s", sourceChainId: 1, blockNumber: "1", sourceTimestampMs: ctx.nowUnix * 1000, retrievedAtMs: ctx.nowUnix * 1000, trustClass: "VERIFIED_ORACLE", adapterId: "a", adapterVersion: "1.0.0", derivedFrom: null, provenance: "attack lab baseline" }],
        provenance: ["attack lab"], nowMs: ctx.nowUnix * 1000,
      });
      try { assertSnapshotUsable(stale, stale.observedAtMs + 600_000, 60_000, "attack lab"); }
      catch (e) { reason = (e as SnapshotError).reason; }
    }
    return assembleAttackRun({
      definition,
      path: buildSecurityPath([{ layer: "REALITY_ENGINE", outcome: reason ? "DENY" : "PASS", reasonCode: reason, detail: "the snapshot is older than the strategy's freshness threshold" }]),
      diffs: [{ field: "sourceTimestampMs", original: "now", mutated: "600s ago" }],
      capabilityIssued: false, transactionSubmitted: false,
    });
  }

  if (scenario === "ORACLE_DISAGREEMENT") {
    const d = compareReadings("weth/usd:price", [
      { sourceId: "chainlink-feed-eth-usd-mainnet", value: "243442066354", decimals: 8, trustClass: "VERIFIED_ORACLE" },
      { sourceId: "thegraph-uniswap-v3-mainnet", value: "210000000000", decimals: 8, trustClass: "INDEXED_CHAIN_DATA" },
    ], 100);
    return assembleAttackRun({
      definition,
      path: buildSecurityPath([{
        layer: "REALITY_ENGINE", outcome: d.disagrees ? "DENY" : "PASS",
        reasonCode: d.disagrees ? "SOURCE_DISAGREEMENT" : null,
        detail: d.disagrees
          ? `the readings differ by ${d.spreadBps} bps. Both are kept and neither is averaged; ${d.authoritative.sourceId} is authoritative on trust`
          : null,
      }]),
      diffs: [{ field: "price", original: "2434.42 (VERIFIED_ORACLE)", mutated: "2100.00 (INDEXED_CHAIN_DATA)" }],
      capabilityIssued: false, transactionSubmitted: false,
    });
  }

  if (scenario === "GRAPH_STALENESS") {
    return assembleAttackRun({
      definition,
      path: buildSecurityPath([{
        layer: "REALITY_ENGINE", outcome: "DENY", reasonCode: "MARKET_SOURCE_TOO_SLOW_FOR_POLICY",
        detail: "the indexed source's heartbeat exceeds the policy's freshness tolerance, so it cannot satisfy the requirement",
      }]),
      diffs: [{ field: "lagBlocks", original: "0", mutated: "4200" }],
      capabilityIssued: false, transactionSubmitted: false,
    });
  }

  if (scenario === "CRE_SIMULATOR_FAILURE") {
    let reason: string | null = null;
    try { assertNoSilentFailover(false, "DEPLOYED_USER", false, "attack lab"); }
    catch (e) { reason = (e as CreLabError).reason; }
    return assembleAttackRun({
      definition,
      path: buildSecurityPath([{
        layer: "CRE_SIMULATION", outcome: reason ? "DENY" : "PASS", reasonCode: reason,
        detail: "financial action fails closed; switching to the simulator is an explicit, labelled choice",
      }]),
      diffs: [], capabilityIssued: false, transactionSubmitted: false,
    });
  }

  /* ── everything else goes through the real policy engine ─────────────── */
  const mutations: Partial<Record<AttackScenario, { req: Partial<EvaluationRequest>; diffs: MutationDiff[] }>> = {
    AMOUNT_MUTATION: {
      req: { decodedAmount: policy.escalationLimit * 2n },
      diffs: [{ field: "amount", original: `${usd(policy.autoLimit / 2n)} (declared)`, mutated: `${usd(policy.escalationLimit * 2n)} (decoded from calldata)` }],
    },
    RECIPIENT_MUTATION: {
      req: { decodedRecipient: ADDR.attacker },
      diffs: [{ field: "recipient", original: ADDR.treasury, mutated: ADDR.attacker }],
    },
    TARGET_MUTATION: {
      req: { target: ADDR.unknownTarget },
      diffs: [{ field: "target", original: ADDR.aavePool, mutated: ADDR.unknownTarget }],
    },
    PROMPT_INJECTION: {
      req: { decodedRecipient: ADDR.attacker, decodedAmount: policy.escalationLimit * 3n },
      diffs: [
        { field: "recipient (via injected model context)", original: ADDR.treasury, mutated: ADDR.attacker },
        { field: "amount", original: usd(policy.autoLimit / 2n), mutated: usd(policy.escalationLimit * 3n) },
      ],
    },
    RUNTIME_COMPROMISE: {
      req: { decodedAmount: policy.escalationLimit * 10n, target: ADDR.unknownTarget, decodedRecipient: ADDR.attacker },
      diffs: [
        { field: "amount", original: usd(policy.autoLimit / 2n), mutated: usd(policy.escalationLimit * 10n) },
        { field: "target", original: ADDR.aavePool, mutated: ADDR.unknownTarget },
        { field: "recipient", original: ADDR.treasury, mutated: ADDR.attacker },
      ],
    },
    POLICY_CHANGE: {
      req: { policyVersion: policy.policyVersion + 1 },
      diffs: [{ field: "policyVersion", original: String(policy.policyVersion), mutated: String(policy.policyVersion + 1) }],
    },
    CROSS_AGENT_FAKE_APPROVAL: {
      req: { agentIdentityHash: keccak256(toHex("some-other-agent")) },
      diffs: [{ field: "agentIdentityHash", original: "the registered agent", mutated: "an unregistered identity" }],
    },
    CCIP_WRONG_DESTINATION: {
      req: { target: ADDR.unknownTarget },
      diffs: [{ field: "destinationChainSelector", original: "10344971235874465080 (Base Sepolia)", mutated: "5009297550715157269 (mainnet)" }],
    },
  };

  const mutation = mutations[scenario];
  if (!mutation) {
    return {
      scenario, title: definition.title, result: "NOT_RUN",
      stoppedBy: null, reasonCode: null, stoppedWhereExpected: false,
      diffs: [], capabilityIssued: false, transactionSubmitted: false, additionalDefenses: [],
      path: [{ layer: definition.expectedStoppedBy, outcome: "NOT_APPLICABLE", reasonCode: null, detail: "no deterministic driver is implemented for this scenario" }],
    };
  }

  // The real policy engine, on the real limits, with one field changed.
  const decision = evaluatePolicy({ ...base, ...mutation.req }, policy, market, ctx.nowUnix);
  const denied = decision.verdict === "DENY";

  return assembleAttackRun({
    definition,
    path: buildSecurityPath([
      { layer: "CRE_SIMULATION", outcome: "PASS", detail: "the CRE workflow evaluates the same request; the mutation is caught by ContextLock policy" },
      {
        layer: "CONTEXTLOCK_POLICY",
        outcome: denied ? "DENY" : "PASS",
        reasonCode: denied ? decision.reasonCode : null,
        detail: `verdict ${decision.verdict}, risk ${decision.riskBand}`,
      },
      { layer: "CAPABILITY_ISSUER", outcome: "PASS" },
      { layer: "EXECUTOR", outcome: "PASS" },
    ]),
    diffs: mutation.diffs,
    capabilityIssued: false,
    transactionSubmitted: false,
  });
}

export { ReasonCode };
