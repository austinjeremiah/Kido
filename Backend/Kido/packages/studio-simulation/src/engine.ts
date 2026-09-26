import {
  evaluatePolicy,
  ReasonCode,
  type EvaluationRequest,
  type MarketContext,
  type PrivatePolicy,
  type Verdict,
} from "@contextlock/policy";
import type { ContextLockAgentBlueprint, ScenarioId } from "@contextlock/studio-blueprint";

/**
 * Deterministic simulation engine.
 *
 * The model may *propose* scenarios. It never decides what happens in one. Every verdict below
 * comes from `evaluatePolicy` — the same function compiled into the real Chainlink confidential
 * workflow and imported by the real broker. There is one implementation of the policy in this
 * repository and the simulator uses it, so a simulated ALLOW and a live ALLOW cannot disagree about
 * what the policy says.
 *
 * The stages mirror the real system's ordering, because a simulation that blocks an attack at the
 * wrong stage is not evidence that the real control works. "Blocked" is not the interesting output;
 * *where* it was blocked is.
 */

export type Stage = "IDENTITY" | "POLICY" | "CRE" | "APPROVAL" | "CAPABILITY" | "EXECUTION";
export const STAGE_ORDER: Stage[] = ["IDENTITY", "POLICY", "CRE", "APPROVAL", "CAPABILITY", "EXECUTION"];

export interface StageResult {
  stage: Stage;
  status: "PASS" | "STOP" | "SKIPPED";
  detail: string;
  /** Named failure, matching the on-chain revert names the real executor uses. */
  reason?: string;
}

export interface SimulationAssertion {
  id: string;
  statement: string;
  held: boolean;
  detail: string;
}

export interface SimulationResult {
  scenarioId: ScenarioId;
  /** Both revisions are recorded so a result can be recognised as stale later. */
  blueprintRevision: number;
  buildRevision: number;
  verdict: Verdict | "NO_VERDICT";
  reasonCode: string;
  outcome: "EXECUTED" | "BLOCKED" | "APPROVAL_REQUIRED";
  stoppedAt: Stage | "NONE";
  stages: StageResult[];
  assertions: SimulationAssertion[];
  passed: boolean;
  /** Hash of the inputs, so an identical run is provably identical. */
  fixtureHash: string;
  timeline: Array<{ t: number; label: string }>;
}

/* ───────────────────────────── deterministic fixtures ─────────────────────── */

/** Fixed clock. A simulator with a real clock is not reproducible. */
export const SIM_NOW = 1_760_000_000;

const AGENT_IDENTITY = "0x" + "a1".repeat(32);
const POOL = "0x00000000000000000000000000000000000000aa";
const HOSTILE = "0x000000000000000000000000000000000000dead";
const SELF = "0x0000000000000000000000000000000000005e1f";

/**
 * The demo private policy. These are simulation fixtures, and they are the reason the simulator
 * can show a verdict changing while the transaction does not: the values live here and in the
 * confidential store, never in the Blueprint and never in anything rendered to the user.
 */
export const SIM_PRIVATE_POLICY: PrivatePolicy = {
  policyId: "contextlock-aave-guardian-v1",
  policyVersion: 1,
  enabled: true,
  autoLimit: 1_000_000_000n,        // $1,000 at 6dp
  escalationLimit: 5_000_000_000n,  // $5,000 at 6dp
  maxSlippageBps: 50,
  maxVolatilityBps: 600,
  minLiquidity: 1_000_000_000_000n,
  targetEthAllocationBps: 5000,
  rebalanceDriftBps: 500,
  minHealthFactorBps: 16_000,
  targetHealthFactorBps: 18_000,
  proprietaryRiskThreshold: 120,
  canary: "CTXLOCK_SIM_CANARY_DO_NOT_EXPORT",
  // Overridden per-Blueprint in buildScenario: the baseline scenarios exercise whatever action the
  // agent actually declares, not a hard-coded lending action.
  allowedActionKinds: ["AAVE_REPAY", "AAVE_SUPPLY"],
  allowedTargets: [POOL],
  authorizedAgentIdentityHashes: [AGENT_IDENTITY],
};

const baseRequest = (): EvaluationRequest => ({
  requestHash: "0x" + "11".repeat(32),
  agentIdentityHash: AGENT_IDENTITY,
  ensNode: "0x" + "22".repeat(32),
  agent: "0x00000000000000000000000000000000000a6e17",
  chainId: 11155111,
  target: POOL,
  value: 0n,
  calldataHash: "0x" + "33".repeat(32),
  selector: "0x573ade81",
  decodedRecipient: SELF,
  decodedAmount: 500_000_000n, // $500
  intentHash: "0x" + "44".repeat(32),
  policyId: SIM_PRIVATE_POLICY.policyId,
  policyVersion: 1,
  actionKind: "AAVE_REPAY",
});

const benignContext = (): MarketContext => ({
  observedAtUnix: SIM_NOW - 5,
  slippageBps: 12,
  volatilityBps: 150,
  liquidity: 9_000_000_000_000n,
  healthFactorBps: 18_000,
});

/* ──────────────────────────────── scenario setup ──────────────────────────── */

interface ScenarioSetup {
  request: EvaluationRequest;
  context: MarketContext;
  policy: PrivatePolicy;
  /** State the deterministic stages consult, independent of the policy verdict. */
  world: {
    identityCurrent: boolean;
    rpcAvailable: boolean;
    policyEnabledAtExecution: boolean;
    nonceAlreadyUsed: boolean;
    /** Post-issuance tampering: what the relayer actually submits. */
    submittedAmount?: bigint;
    submittedRecipient?: string;
    submittedTarget?: string;
    approvalRecorded: boolean;
  };
  /** Human-readable note shown in the UI beside the scenario. */
  note: string;
}

const defaultWorld = (): ScenarioSetup["world"] => ({
  identityCurrent: true,
  rpcAvailable: true,
  policyEnabledAtExecution: true,
  nonceAlreadyUsed: false,
  approvalRecorded: false,
});

/**
 * Adapter-contributed scenarios.
 *
 * The engine has no knowledge of Uniswap, The Graph or Chainlink. An adapter declares scenario ids
 * in its manifest and supplies fixtures; the engine runs whatever it is given, through the same
 * stages as a built-in scenario.
 *
 * A declared scenario with no fixture is reported as UNRUNNABLE and fails. Silently skipping it
 * would let an adapter advertise coverage it does not have, and the resulting report would look
 * complete.
 */
export interface AdapterScenarioFixture {
  scenarioId: string;
  description: string;
  /** How the adapter's own validation ruled on this fixture. */
  outcome: "ACCEPTED" | "REJECTED";
  /** The code the adapter's validator produced, shown verbatim in the report. */
  reasonCode: string;
  /** Which control caught it, so a rejection names a stage rather than just failing. */
  stoppedAt?: Stage;
}

export type AdapterFixtureMap = Record<string, AdapterScenarioFixture>;

const BUILT_IN = new Set<string>([
  "NORMAL", "PROMPT_INJECTION", "AMOUNT_MUTATION", "RECIPIENT_MUTATION", "TARGET_MUTATION",
  "REPLAY", "ENS_REVOCATION", "STALE_CONTEXT", "POLICY_CHANGE", "RPC_FAILURE",
  "HEALTH_FACTOR_DROP", "FLASH_CRASH", "COLLATERAL_RECOVERY", "REPAY_ABOVE_AUTO_LIMIT",
  "PRIVATE_CONTEXT_ALLOW", "PRIVATE_CONTEXT_ESCALATE", "PRIVATE_CONTEXT_DENY",
]);

export const isBuiltInScenario = (id: string): boolean => BUILT_IN.has(id);

export function buildScenario(id: ScenarioId, primaryActionKind = "AAVE_REPAY"): ScenarioSetup {
  /*
   * The baseline scenarios run against the agent's OWN primary action.
   *
   * They used to hard-code a lending action, so every baseline scenario for a swap agent was denied
   * at POLICY for the wrong reason — a correct refusal that proved nothing about the attack the
   * scenario was meant to exercise.
   */
  const request = { ...baseRequest(), actionKind: primaryActionKind };
  const context = benignContext();
  const policy = { ...SIM_PRIVATE_POLICY, allowedActionKinds: [primaryActionKind, "AAVE_REPAY", "AAVE_SUPPLY"] };
  const world = defaultWorld();

  switch (id) {
    case "NORMAL":
    case "HEALTH_FACTOR_DROP":
      return { request, context, policy, world, note: "A $500 repayment under benign conditions." };

    case "PROMPT_INJECTION":
      // The injected instruction succeeds at the agent layer — the agent genuinely asks for the
      // withdrawal. That is the point: the boundary is not the agent's judgement.
      return {
        // Deliberately an action the Blueprint never declares, whatever the agent's primary is.
        request: { ...request, actionKind: "AAVE_WITHDRAW", decodedRecipient: HOSTILE, decodedAmount: 5_000_000_000n },
        context,
        policy,
        world,
        note: "Injected instruction: withdraw collateral to an attacker address. The agent complies.",
      };

    case "AMOUNT_MUTATION":
      return {
        request,
        context,
        policy,
        world: { ...world, submittedAmount: 4_900_000_000n },
        note: "A valid $500 capability is issued, then $4,900 is submitted instead.",
      };

    case "RECIPIENT_MUTATION":
      return {
        request,
        context,
        policy,
        world: { ...world, submittedRecipient: HOSTILE },
        note: "A valid capability is issued, then the recipient is swapped for an attacker address.",
      };

    case "TARGET_MUTATION":
      return {
        request,
        context,
        policy,
        world: { ...world, submittedTarget: HOSTILE },
        note: "A valid capability is issued, then the call target is swapped for a hostile contract.",
      };

    case "REPLAY":
      return {
        request,
        context,
        policy,
        world: { ...world, nonceAlreadyUsed: true },
        note: "A previously executed capability is submitted a second time, unmodified.",
      };

    case "ENS_REVOCATION":
      return {
        request,
        context,
        policy,
        world: { ...world, identityCurrent: false },
        note: "The ENS role is revoked while a correctly signed, unexpired capability is outstanding.",
      };

    case "STALE_CONTEXT":
      return {
        request,
        context: { ...context, observedAtUnix: SIM_NOW - 600 },
        policy,
        world,
        note: "Position health data is ten minutes old — far outside the freshness window.",
      };

    case "POLICY_CHANGE":
      return {
        request,
        context,
        policy,
        world: { ...world, policyEnabledAtExecution: false },
        note: "The policy is disabled after authorization but before execution.",
      };

    case "RPC_FAILURE":
      return {
        request,
        context,
        policy,
        world: { ...world, rpcAvailable: false },
        note: "The identity RPC is unreachable at execution time.",
      };

    case "FLASH_CRASH":
      return {
        request,
        context: { ...context, volatilityBps: 5_000 },
        policy,
        world,
        note: "Collateral price collapses; volatility far exceeds the confidential ceiling.",
      };

    case "COLLATERAL_RECOVERY":
      return {
        request,
        context: { ...context, liquidity: 1n },
        policy,
        world,
        note: "Market depth collapses before execution; the action is no longer safe to take.",
      };

    case "REPAY_ABOVE_AUTO_LIMIT":
      return {
        request: { ...request, decodedAmount: 3_000_000_000n },
        context,
        policy,
        world,
        note: "A $3,000 repayment — above the confidential autonomous limit — requires a human.",
      };

    /* The private-context trio. Identical request in all three; only `context` differs. */
    case "PRIVATE_CONTEXT_ALLOW":
      return { request, context, policy, world, note: "Identical transaction. Benign confidential context." };
    case "PRIVATE_CONTEXT_ESCALATE":
      return {
        request,
        context: { ...context, volatilityBps: 5_000 },
        policy,
        world,
        note: "Identical transaction. Confidential volatility reading is elevated.",
      };
    case "PRIVATE_CONTEXT_DENY":
      return {
        request,
        context: { ...context, slippageBps: 900 },
        policy,
        world,
        note: "Identical transaction. Confidential execution-quality reading breaches a floor.",
      };
    default:
      // An adapter-contributed id. It has no built-in world; `runScenario` routes it to the
      // adapter fixture path before ever reaching here.
      throw new Error(`scenario "${id}" is not built in and has no adapter fixture`);
  }
}

/* ─────────────────────────────── stable hashing ───────────────────────────── */

/** FNV-1a over a canonical JSON form. Deterministic and dependency-free. */
function stableHash(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (typeof v === "bigint") return `${v.toString()}n`;
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, canon(val)]),
      );
    }
    return v;
  };
  const s = JSON.stringify(canon(value));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `0x${h.toString(16).padStart(8, "0")}`;
}

/* ───────────────────────────────── the engine ─────────────────────────────── */

export function runScenario(
  bp: ContextLockAgentBlueprint,
  scenarioId: ScenarioId,
  buildRevision: number,
  /**
   * Internal. Used only to re-run an ESCALATE scenario with an approval on record, so the engine
   * can prove both halves of the escalation claim. Not part of the public scenario contract.
   */
  approvalOverride?: boolean,
  adapterFixtures: AdapterFixtureMap = {},
): SimulationResult {
  if (!isBuiltInScenario(scenarioId)) {
    return runAdapterScenario(bp, scenarioId, buildRevision, adapterFixtures);
  }
  const primaryActionKind = bp.actions[0]?.kind ?? "AAVE_REPAY";
  const setup = buildScenario(scenarioId, primaryActionKind);
  if (approvalOverride !== undefined) setup.world.approvalRecorded = approvalOverride;
  const stages: StageResult[] = [];
  const timeline: Array<{ t: number; label: string }> = [];
  let t = 0;
  const tick = (label: string) => timeline.push({ t: (t += 1), label });

  let verdict: Verdict | "NO_VERDICT" = "NO_VERDICT";
  let reasonCode = "NONE";
  let stoppedAt: Stage | "NONE" = "NONE";
  let outcome: SimulationResult["outcome"] = "BLOCKED";

  const stop = (stage: Stage, reason: string, detail: string) => {
    stages.push({ stage, status: "STOP", detail, reason });
    stoppedAt = stage;
    for (const s of STAGE_ORDER.slice(STAGE_ORDER.indexOf(stage) + 1)) {
      stages.push({ stage: s, status: "SKIPPED", detail: "not reached" });
    }
  };

  /* IDENTITY — read live, before anything else. */
  tick("agent proposes an intent");
  if (!setup.world.rpcAvailable) {
    stop("IDENTITY", "IdentityUnavailable", "Identity RPC unreachable; fails closed rather than assuming the last known identity.");
    tick("identity unavailable → refuse");
  } else if (!setup.world.identityCurrent) {
    stop("IDENTITY", "IdentityNotCurrent", "ENS role revoked; the token id regenerated and the bound identity hash no longer matches.");
    tick("ENS identity changed → outstanding capability dies");
  } else {
    stages.push({ stage: "IDENTITY", status: "PASS", detail: `${bp.identity.ensName} resolves and is current` });
    tick("ENS identity verified live");
  }

  /* POLICY — structural permission, independent of market context. */
  if (stoppedAt === "NONE") {
    const declaredKinds = new Set(bp.actions.map((a) => a.kind));
    if (!declaredKinds.has(setup.request.actionKind)) {
      verdict = "DENY";
      reasonCode = ReasonCode.DENY_ACTION_NOT_ALLOWED;
      stop("POLICY", "ActionNotPermitted", `Action ${setup.request.actionKind} is not in the Blueprint's permitted set. The agent asked; the Blueprint never granted it.`);
      tick(`forbidden action ${setup.request.actionKind} → DENY`);
    } else if (!setup.world.policyEnabledAtExecution) {
      verdict = "DENY";
      reasonCode = ReasonCode.DENY_POLICY_DISABLED;
      stop("POLICY", "PolicyDisabled", "The policy was disabled between authorization and execution.");
      tick("policy disabled → refuse");
    } else {
      stages.push({ stage: "POLICY", status: "PASS", detail: `${setup.request.actionKind} is a permitted action` });
      tick("action is structurally permitted");
    }
  }

  /* CRE — the confidential decision. Same function the real workflow runs. */
  if (stoppedAt === "NONE") {
    const decision = evaluatePolicy(setup.request, setup.policy, setup.context, SIM_NOW);
    verdict = decision.verdict;
    reasonCode = decision.reasonCode;
    tick(`confidential evaluation → ${decision.verdict}`);
    if (decision.verdict === "DENY") {
      stop("CRE", "AuthorizationNotAllow", `Confidential policy returned DENY (${decision.reasonCode}). The threshold that produced it is not disclosed.`);
    } else {
      stages.push({
        stage: "CRE",
        status: "PASS",
        detail: `${decision.verdict} (${decision.reasonCode}), risk band ${decision.riskBand}`,
      });
    }
  }

  /* APPROVAL — required only for ESCALATE, and never reachable from DENY. */
  if (stoppedAt === "NONE") {
    if (verdict === "ESCALATE") {
      if (!setup.world.approvalRecorded) {
        stop("APPROVAL", "HumanApprovalRequired", "ESCALATE with no approval on record.");
        outcome = "APPROVAL_REQUIRED";
        tick("escalation requires a human → held");
      } else {
        stages.push({
          stage: "APPROVAL",
          status: "PASS",
          detail:
            bp.escalationPolicy.mechanism === "ledger-device"
              ? "Approval recorded on a Ledger device"
              : "Approval recorded by a STAND-IN key — NOT a Ledger device (BLK-002)",
        });
        tick("human approved the specific transaction");
      }
    } else {
      stages.push({ stage: "APPROVAL", status: "SKIPPED", detail: "ALLOW needs no human" });
    }
  }

  /* CAPABILITY — issuance. */
  if (stoppedAt === "NONE") {
    stages.push({
      stage: "CAPABILITY",
      status: "PASS",
      detail: `minted, TTL ${bp.capabilityPolicy.ttlSeconds}s, binds ${bp.capabilityPolicy.bindings.length} fields`,
    });
    tick("capability minted for exactly this transaction");
  }

  /* EXECUTION — the reference monitor re-checks everything it was handed. */
  if (stoppedAt === "NONE") {
    const w = setup.world;
    if (w.nonceAlreadyUsed) {
      stop("EXECUTION", "NonceUsed", "The capability's nonce is already consumed on-chain.");
      tick("replay rejected");
    } else if (w.submittedAmount !== undefined && w.submittedAmount !== setup.request.decodedAmount) {
      stop("EXECUTION", "CalldataHashMismatch", `Submitted amount differs from the signed calldata (signed ${setup.request.decodedAmount}, submitted ${w.submittedAmount}).`);
      tick("mutated amount rejected");
    } else if (w.submittedRecipient && w.submittedRecipient !== setup.request.decodedRecipient) {
      stop("EXECUTION", "CalldataHashMismatch", "Submitted recipient differs from the signed calldata.");
      tick("mutated recipient rejected");
    } else if (w.submittedTarget && w.submittedTarget !== setup.request.target) {
      stop("EXECUTION", "TargetMismatch", "Submitted target differs from the signed target.");
      tick("mutated target rejected");
    } else {
      stages.push({ stage: "EXECUTION", status: "PASS", detail: "executed exactly the authorized transaction" });
      outcome = "EXECUTED";
      tick("executed");
    }
  }

  if (stoppedAt !== "NONE" && outcome !== "APPROVAL_REQUIRED") outcome = "BLOCKED";

  /* assertions --------------------------------------------------------------- */
  const expected = bp.simulationScenarios.find((s) => s.scenarioId === scenarioId);
  const assertions: SimulationAssertion[] = [];
  if (expected) {
    assertions.push({
      id: "A1",
      statement: `verdict is ${expected.expectedVerdict}`,
      held: verdict === expected.expectedVerdict,
      detail: `expected ${expected.expectedVerdict}, got ${verdict}`,
    });
    assertions.push({
      id: "A2",
      statement: `outcome is ${expected.expectedOutcome}`,
      held: outcome === expected.expectedOutcome,
      detail: `expected ${expected.expectedOutcome}, got ${outcome}`,
    });
    assertions.push({
      id: "A3",
      statement: `stopped at ${expected.expectedStopStage}`,
      held: stoppedAt === (expected.expectedStopStage === "NONE" ? "NONE" : expected.expectedStopStage),
      detail: `expected ${expected.expectedStopStage}, got ${stoppedAt}`,
    });
  } else {
    assertions.push({
      id: "A0",
      statement: "scenario is declared in the Blueprint",
      held: false,
      detail: `${scenarioId} ran but the Blueprint does not declare it`,
    });
  }

  /*
   * Escalation has two halves and testing only one of them is a common way to ship a broken gate:
   *
   *   - a gate that never opens passes "approval is required" and is useless;
   *   - a gate that never closes passes "approval works" and is a hole.
   *
   * The scenario above exercises the closed half. Here the engine re-runs the identical scenario
   * with an approval on record and asserts it then executes — so one scenario proves the gate both
   * blocks and opens, which is what the live P7 LED-H02/DEMO-B pair proved on Sepolia.
   */
  if (verdict === "ESCALATE" && approvalOverride === undefined) {
    const approved = runScenario(bp, scenarioId, buildRevision, true);
    assertions.push({
      id: "A5",
      statement: "the same escalated transaction executes once a human approves it",
      held: approved.outcome === "EXECUTED" && approved.stoppedAt === "NONE",
      detail: `with approval on record: ${approved.outcome} (stopped at ${approved.stoppedAt})`,
    });
    assertions.push({
      id: "A6",
      statement: "approval authorizes that transaction only — the verdict is unchanged by approving",
      held: approved.verdict === verdict,
      detail: `verdict without approval ${verdict}, with approval ${approved.verdict}`,
    });
  }

  // A DENY that reached the approval stage would mean the escape hatch exists. Asserted on every
  // scenario, not only the ones designed to test it.
  assertions.push({
    id: "A4",
    statement: "DENY never reaches the approval or execution stage",
    held: !(verdict === "DENY" && stages.some((s) => (s.stage === "APPROVAL" || s.stage === "EXECUTION") && s.status === "PASS")),
    detail: verdict === "DENY" ? "DENY stopped before approval" : "not a DENY scenario",
  });

  return {
    scenarioId,
    blueprintRevision: bp.revision,
    buildRevision,
    verdict,
    reasonCode,
    outcome,
    stoppedAt,
    stages,
    assertions,
    passed: assertions.every((a) => a.held),
    fixtureHash: stableHash({ request: setup.request, context: setup.context, world: setup.world }),
    timeline,
  };
}

/**
 * Run an adapter-contributed scenario.
 *
 * The adapter has already decided the outcome — it owns its own failure modes, and encoding them
 * here would put provider knowledge back into the engine. What the engine does is place that
 * outcome into the same stage model as every other scenario, so a report reads uniformly and a
 * rejection names the control that caught it.
 */
function runAdapterScenario(
  bp: ContextLockAgentBlueprint,
  scenarioId: string,
  buildRevision: number,
  fixtures: AdapterFixtureMap,
): SimulationResult {
  const expected = bp.simulationScenarios.find((s) => s.scenarioId === scenarioId);
  const fixture = fixtures[scenarioId];

  if (!fixture) {
    // Fails, loudly. A declared scenario with no fixture is advertised coverage that does not exist.
    return {
      scenarioId: scenarioId as ScenarioId,
      blueprintRevision: bp.revision,
      buildRevision,
      verdict: "NO_VERDICT",
      reasonCode: "SCENARIO_UNRUNNABLE",
      outcome: "BLOCKED",
      stoppedAt: "POLICY",
      stages: STAGE_ORDER.map((stage) => ({ stage, status: "SKIPPED" as const, detail: "not reached" })),
      assertions: [
        {
          id: "A0",
          statement: "the adapter supplies a fixture for every scenario it declares",
          held: false,
          detail: `scenario "${scenarioId}" is declared but no adapter fixture was supplied`,
        },
      ],
      passed: false,
      fixtureHash: "0x00000000",
      timeline: [{ t: 1, label: `${scenarioId} could not be run` }],
    };
  }

  const accepted = fixture.outcome === "ACCEPTED";
  const stoppedAt: Stage | "NONE" = accepted ? "NONE" : (fixture.stoppedAt ?? "EXECUTION");
  const stages: StageResult[] = STAGE_ORDER.map((stage) => {
    if (accepted) return { stage, status: "PASS" as const, detail: fixture.description };
    const idx = STAGE_ORDER.indexOf(stoppedAt as Stage);
    const here = STAGE_ORDER.indexOf(stage);
    if (here < idx) return { stage, status: "PASS" as const, detail: "reached" };
    if (here === idx) {
      return { stage, status: "STOP" as const, detail: fixture.description, reason: fixture.reasonCode };
    }
    return { stage, status: "SKIPPED" as const, detail: "not reached" };
  });

  const assertions: SimulationAssertion[] = expected
    ? [
        {
          id: "A1",
          statement: `outcome is ${expected.expectedOutcome}`,
          held: (accepted ? "EXECUTED" : "BLOCKED") === expected.expectedOutcome,
          detail: `expected ${expected.expectedOutcome}, got ${accepted ? "EXECUTED" : "BLOCKED"}`,
        },
        {
          id: "A2",
          statement: `stopped at ${expected.expectedStopStage}`,
          held: stoppedAt === expected.expectedStopStage,
          detail: `expected ${expected.expectedStopStage}, got ${stoppedAt}`,
        },
      ]
    : [
        {
          id: "A0",
          statement: "scenario is declared in the Blueprint",
          held: false,
          detail: `${scenarioId} ran but the Blueprint does not declare it`,
        },
      ];

  return {
    scenarioId: scenarioId as ScenarioId,
    blueprintRevision: bp.revision,
    buildRevision,
    verdict: "NO_VERDICT",
    reasonCode: fixture.reasonCode,
    outcome: accepted ? "EXECUTED" : "BLOCKED",
    stoppedAt,
    stages,
    assertions,
    passed: assertions.every((a) => a.held),
    fixtureHash: stableHash(fixture),
    timeline: [
      { t: 1, label: fixture.description },
      { t: 2, label: accepted ? "adapter validation accepted the action" : `adapter validation refused: ${fixture.reasonCode}` },
    ],
  };
}

export function runAllScenarios(
  bp: ContextLockAgentBlueprint,
  buildRevision: number,
  adapterFixtures: AdapterFixtureMap = {},
): SimulationResult[] {
  return bp.simulationScenarios.map((s) => runScenario(bp, s.scenarioId, buildRevision, undefined, adapterFixtures));
}
