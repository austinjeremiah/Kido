import { describe, expect, it } from "vitest";
import { type Address, type Hex } from "viem";
import {
  DeploymentOrchestrator, OrchestratorError, ORCHESTRATOR_REASONS,
  assertTransition, isTerminal, phaseFor, DEPLOYMENT_TRANSITIONS, RESUMABLE_STATES, DeploymentMachineError, MACHINE_REASONS,
  newTransactionRecord, recordSendOutcome, reconcile, assertSafeToRetry, assertMinedSuccessfully, isFinal, estimateAccuracy, ReceiptError, RECEIPT_REASONS,
  assertPromotable, assertDigestMatchesManifest, assertAttestationsCorrespond, ImageGateError, IMAGE_REASONS, DEFAULT_IMAGE_POLICY,
  verifyDeployment, assertVerified, VerificationError, VERIFY_REASONS,
  ACTIVATION_STEPS, DEACTIVATION_STEPS, KILL_HIERARCHY, assertActivationStep, advanceActivation, emergencyStopOrder, runtimeStopClaim, assertNotClaimingSecurityKill, ActivationError, ACTIVATION_REASONS,
  sealReceipt, buildRecoveryPlan, DeploymentReceiptSchema,
} from "../src/index.js";
import {
  manifestHash, deploymentPlanHash, scanForSecrets, DeploymentSecretError, assertApprovedFor, ApprovalError, mainnetEnvironment,
} from "@contextlock/studio-deploy";
import {
  NOW, DEPLOYER, ATTACKER, SEPOLIA_CORE, clone, sepoliaReader, fakeChain, codeFor, canonicalManifest, creArtifact,
  harness, approvedPlan, imageArtifact, vulnReport, TIMEOUT, REJECTED,
} from "./fixtures.js";

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};
const asyncReasonOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};
const statusOf = (run: { plan: { steps: Array<{ id: string; status: string }> } }, id: string) =>
  run.plan.steps.find((s) => s.id === id)!.status;

/* ══════════════════════════ resume and idempotency ══════════════════════════ */

describe("resumability", () => {
  it("DEP-001 a deployment resumes after a process restart, from the first unsatisfied step", async () => {
    const h = harness();
    // Run three steps, then throw the orchestrator away entirely — a new process has no memory of
    // what it was doing, only the persisted run.
    await h.orchestrator.resume(h.run, h.manifest);
    for (let i = 0; i < 3; i++) {
      const s = h.orchestrator.nextStep(h.run)!;
      await h.orchestrator.executeStep(h.run, s, h.manifest);
    }
    const doneBefore = h.run.plan.steps.filter((s) => s.status === "VERIFIED").map((s) => s.id);
    expect(doneBefore.length).toBe(3);

    const persisted = { ...h.run, plan: clone(h.run.plan) };
    const fresh = new DeploymentOrchestrator(h.deps);
    await fresh.resume(persisted, h.manifest);
    // The steps that were done stay done; the next step is the first that is not.
    for (const id of doneBefore) expect(statusOf(persisted, id)).not.toBe("PENDING");
    const next = fresh.nextStep(persisted)!;
    expect(doneBefore).not.toContain(next.id);

    const finished = await fresh.runToCompletion(persisted, h.manifest);
    expect(finished.state).toBe("READY_TO_ACTIVATE");
  });

  it("DEP-002 a duplicate deploy request is idempotent: the effect is observed, not repeated", async () => {
    const h = harness({ alreadySatisfied: new Set(["deploy-cre-consumer", "register-policy-disabled"]) });
    await h.orchestrator.runToCompletion(h.run, h.manifest);
    // Both writes were already true of the chain, so neither was sent again.
    expect(h.sends.map((s) => s.stepId)).not.toContain("deploy-cre-consumer");
    expect(h.sends.map((s) => s.stepId)).not.toContain("register-policy-disabled");
    expect(statusOf(h.run, "deploy-cre-consumer")).toBe("SKIPPED_ALREADY_SATISFIED");
    expect(h.run.state).toBe("READY_TO_ACTIVATE");

    // And a repeat request against a finished deployment is refused outright rather than replaying
    // it. "Idempotent" here means the second call cannot deploy anything a second time — refusing
    // and doing nothing are both acceptable answers; silently redeploying is not.
    const before = h.sends.length;
    expect(await asyncReasonOf(() => h.orchestrator.runToCompletion(h.run, h.manifest))).toBe(MACHINE_REASONS.NOT_RESUMABLE);
    expect(h.sends.length).toBe(before);
  });

  it("DEP-002c a repeat of an in-progress deployment re-observes rather than re-sends", async () => {
    const h = harness();
    await h.orchestrator.resume(h.run, h.manifest);
    // Perform the two writes.
    for (let i = 0; i < 4; i++) {
      const s = h.orchestrator.nextStep(h.run);
      if (!s) break;
      await h.orchestrator.executeStep(h.run, s, h.manifest);
    }
    const sent = h.sends.map((s) => s.stepId);
    expect(sent).toContain("deploy-cre-consumer");

    // A second orchestrator, resuming the same run, observes those effects and skips them.
    const again = new DeploymentOrchestrator(h.deps);
    await again.resume(h.run, h.manifest);
    expect(h.sends.map((s) => s.stepId)).toEqual(sent);
  });

  it("DEP-002b a step is complete only when the world says so, never because a prior response said so", async () => {
    // The transaction succeeds, and the effect is nonetheless absent. A receipt-trusting
    // orchestrator would call this done.
    const h = harness({ effectMissing: new Set(["register-policy-disabled"]) });
    await h.orchestrator.resume(h.run, h.manifest);
    let err: OrchestratorError | null = null;
    try {
      await h.orchestrator.runToCompletion(h.run, h.manifest);
    } catch (e) { err = e as OrchestratorError; }
    expect(err?.reason).toBe(ORCHESTRATOR_REASONS.STEP_FAILED);
    expect(err?.message).toMatch(/succeeded but the intended state is not present/);
    expect(statusOf(h.run, "register-policy-disabled")).toBe("FAILED");
    expect(h.run.state).toBe("DEPLOYMENT_PARTIAL");
  });

  it("DEP-030b resume re-checks the approval against the current manifest before touching anything", async () => {
    const h = harness();
    const edited = clone(h.manifest);
    edited.creWorkflows[0]!.binaryHash = "f".repeat(64);
    expect(await asyncReasonOf(() => h.orchestrator.resume(h.run, edited))).toBe("DEPLOYMENT_ARTIFACT_DRIFT");
    // Nothing was observed and nothing was sent — the drift check runs before the chain is read.
    expect(h.observations).toEqual([]);
    expect(h.sends).toEqual([]);
  });
});

/* ══════════════════════════ receipt certainty ══════════════════════════ */

describe("transaction receipt certainty", () => {
  it("DEP-003 an unknown receipt state is not blindly retried", async () => {
    const rec = newTransactionRecord({ deploymentStepId: "deploy-cre-consumer", chainId: 11155111, from: DEPLOYER, nonce: 7, estimatedNativeCostWei: "1000" });
    const unknown = recordSendOutcome(rec, { error: TIMEOUT }, NOW);
    expect(unknown.state).toBe("UNKNOWN_SUBMISSION_STATE");

    const r = reasonOf(() => assertSafeToRetry(unknown));
    expect(r).toBe(RECEIPT_REASONS.UNSAFE_RETRY);
    expect(() => assertSafeToRetry(unknown)).toThrow(/Reconcile it against the chain/);
    expect(() => assertSafeToRetry(unknown)).toThrow(/risks a duplicate deployment/);

    // A definite rejection is a different thing entirely: nothing was accepted, so nothing is unknown.
    const rejected = recordSendOutcome(rec, { error: REJECTED, definitelyRejected: true }, NOW);
    expect(rejected.state).toBe("NOT_SUBMITTED");
    expect(() => assertSafeToRetry(rejected)).not.toThrow();
  });

  it("DEP-003b the orchestrator refuses to proceed past an unknown send, and pauses PARTIAL", async () => {
    const h = harness({ sendFails: { stepId: "deploy-cre-consumer", error: TIMEOUT } });
    await h.orchestrator.resume(h.run, h.manifest);
    expect(await asyncReasonOf(() => h.orchestrator.runToCompletion(h.run, h.manifest))).toBe(ORCHESTRATOR_REASONS.UNKNOWN_TX);
    expect(h.run.state).toBe("DEPLOYMENT_PARTIAL");
    expect(statusOf(h.run, "deploy-cre-consumer")).toBe("UNKNOWN_SUBMISSION_STATE");
    // And a resume does not re-send it; it reconciles first.
    const sendsBefore = h.sends.length;
    await h.orchestrator.resume(h.run, h.manifest).catch(() => {});
    expect(h.sends.length).toBe(sendsBefore);
  });

  it("DEP-004 an actual receipt is reconciled, by hash when there is one and by nonce when there is not", async () => {
    const receipts = new Map([["0x" + "ab".repeat(32), { status: "success" as const, blockNumber: 100n, gasUsed: 21_000n, effectiveGasPrice: 2_000_000_000n, contractAddress: "0x3333333333333333333333333333333333333333" as Address }]]);
    const reader = fakeChain({ chainId: 11155111, receipts, nonces: new Map([[DEPLOYER.toLowerCase(), 8n]]) });

    const withHash = { ...newTransactionRecord({ deploymentStepId: "s", chainId: 11155111, from: DEPLOYER, nonce: 7, estimatedNativeCostWei: "40000000000000" }), txHash: "0x" + "ab".repeat(32), state: "UNKNOWN_SUBMISSION_STATE" as const, submittedAtMs: NOW };
    const byHash = await reconcile(withHash, reader, NOW);
    expect(byHash.state).toBe("MINED_SUCCESS");
    expect(byHash.blockNumber).toBe("100");
    expect(byHash.contractAddress).toBe("0x3333333333333333333333333333333333333333");
    expect(byHash.gasUsed).toBe("21000");
    expect(byHash.actualNativeCostWei).toBe("42000000000000");
    // The estimate survives beside the actual, so the estimator stays falsifiable.
    expect(byHash.estimatedNativeCostWei).toBe("40000000000000");

    // No hash, and the nonce has NOT advanced: definitively nothing was mined, so a retry is safe.
    const noHashFreeNonce = { ...newTransactionRecord({ deploymentStepId: "s", chainId: 11155111, from: DEPLOYER, nonce: 9, estimatedNativeCostWei: null }), state: "UNKNOWN_SUBMISSION_STATE" as const };
    const absent = await reconcile(noHashFreeNonce, reader, NOW);
    expect(absent.state).toBe("CONFIRMED_ABSENT");
    expect(() => assertSafeToRetry(absent)).not.toThrow();

    // No hash, and the nonce HAS been consumed: something was mined and we cannot say what. This
    // must stay unknown rather than becoming "probably fine".
    const noHashUsedNonce = { ...newTransactionRecord({ deploymentStepId: "s", chainId: 11155111, from: DEPLOYER, nonce: 6, estimatedNativeCostWei: null }), state: "UNKNOWN_SUBMISSION_STATE" as const };
    const consumed = await reconcile(noHashUsedNonce, reader, NOW);
    expect(consumed.state).toBe("UNKNOWN_SUBMISSION_STATE");
    expect(consumed.revertDetail).toMatch(/A transaction WAS mined from this account/);
    expect(() => assertSafeToRetry(consumed)).toThrow(ReceiptError);
  });

  it("DEP-023 a reverted transaction surfaces the exact step that failed", async () => {
    const h = harness({ receiptStatus: "reverted" });
    await h.orchestrator.resume(h.run, h.manifest);
    let err: OrchestratorError | null = null;
    try { await h.orchestrator.runToCompletion(h.run, h.manifest); } catch (e) { err = e as OrchestratorError; }
    expect(err?.reason).toBe(ORCHESTRATOR_REASONS.STEP_FAILED);
    expect(err?.stepId).toBe("deploy-cre-consumer");
    expect(err?.message).toContain("deploy-cre-consumer");
    expect(err?.message).toMatch(/reverted in block/);
  });

  it("DEP-004b a freshly sent transaction is waited for, not immediately declared unknown", async () => {
    /*
     * The first live deployment failed here: it sent a contract creation, reconciled a millisecond
     * later, found no receipt, and marked itself DEPLOYMENT_PARTIAL over a transaction that was
     * about to succeed. A bounded wait fixes that WITHOUT weakening what "unknown" means.
     */
    const { waitForReceipt, waitForFinality } = await import("../src/receipts.js");
    const receipts = new Map<string, { status: "success" | "reverted"; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint; contractAddress: Address | null }>();
    const hash = ("0x" + "cd".repeat(32)) as Hex;

    let head = 100n;
    let polls = 0;
    const reader = {
      ...fakeChain({ chainId: 11155111 }),
      async getTransactionReceipt(h: Hex) {
        polls += 1;
        // Mined on the third look, exactly as a real chain would behave.
        if (polls >= 3) receipts.set(h.toLowerCase(), { status: "success", blockNumber: 100n, gasUsed: 21_000n, effectiveGasPrice: 2n, contractAddress: null });
        return receipts.get(h.toLowerCase()) ?? null;
      },
      async getBlockNumber() { return head; },
    };

    const rec = { ...newTransactionRecord({ deploymentStepId: "s", chainId: 11155111, from: DEPLOYER, nonce: 1, estimatedNativeCostWei: null }), txHash: hash, state: "SUBMITTED" as const, submittedAtMs: NOW };
    let clock = NOW;
    const settled = await waitForReceipt(rec, reader, { intervalMs: 1, timeoutMs: 10_000, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(settled.state).toBe("MINED_SUCCESS");
    expect(polls).toBeGreaterThanOrEqual(3);

    // Mined is not final. waitForFinality keeps looking until it is buried.
    head = 100n;
    const oneConf = await waitForFinality({ ...rec, txHash: hash }, reader, 3, { intervalMs: 1, timeoutMs: 5, now: () => clock, sleep: async (ms) => { clock += ms; head += 1n; } });
    expect(oneConf.state).toBe("MINED_SUCCESS");

    // A transaction that never appears stays UNKNOWN after the wait expires — the wait changes when
    // we give up, never what giving up means.
    const neverMined = { ...newTransactionRecord({ deploymentStepId: "s2", chainId: 11155111, from: DEPLOYER, nonce: 2, estimatedNativeCostWei: null }), txHash: ("0x" + "ef".repeat(32)) as string, state: "SUBMITTED" as const, submittedAtMs: NOW };
    const silent = { ...fakeChain({ chainId: 11155111 }), async getTransactionReceipt() { return null; } };
    let c2 = NOW;
    const timedOut = await waitForReceipt(neverMined, silent, { intervalMs: 10, timeoutMs: 50, now: () => c2, sleep: async (ms) => { c2 += ms; } });
    expect(timedOut.state).toBe("UNKNOWN_SUBMISSION_STATE");
    expect(() => assertSafeToRetry(timedOut)).toThrow(ReceiptError);
  });

  it("DEP-024 the actual gas cost is recorded separately from the estimate, and the gap is reportable", () => {
    const rec = { ...newTransactionRecord({ deploymentStepId: "s", chainId: 11155111, from: DEPLOYER, nonce: 1, estimatedNativeCostWei: "1000" }), actualNativeCostWei: "1250" };
    const acc = estimateAccuracy(rec)!;
    expect(acc.deltaWei).toBe("250");
    expect(acc.ratio).toBe(1.25);
    expect(rec.estimatedNativeCostWei).toBe("1000");
    expect(estimateAccuracy({ ...rec, actualNativeCostWei: null })).toBeNull();
  });

  it("DEP-022 an RPC 429 or timeout is classified rather than swallowed, and neither means 'failed'", async () => {
    const rec = newTransactionRecord({ deploymentStepId: "s", chainId: 11155111, from: DEPLOYER, nonce: 1, estimatedNativeCostWei: null });
    for (const msg of ["429 Too Many Requests", "request timed out", "socket hang up", "ETIMEDOUT"]) {
      const r = recordSendOutcome(rec, { error: new Error(msg) }, NOW);
      expect(r.state, msg).toBe("UNKNOWN_SUBMISSION_STATE");
      expect(() => assertSafeToRetry(r), msg).toThrow(ReceiptError);
    }
    // Mined but not yet buried is not final, and depending on it would be depending on a reorg.
    const mined = { ...rec, state: "MINED_SUCCESS" as const, confirmations: 1 };
    expect(isFinal(mined)).toBe(false);
    expect(isFinal({ ...mined, confirmations: 2 })).toBe(true);
    expect(reasonOf(() => assertMinedSuccessfully({ ...rec, state: "MINED_REVERTED", revertDetail: "x" }))).toBe(RECEIPT_REASONS.REVERTED);
  });

  it("DEP-021 a signer rejection leaves a resumable state with nothing submitted", async () => {
    const h = harness({ sendFails: { stepId: "deploy-cre-consumer", error: REJECTED, rejected: true } });
    await h.orchestrator.resume(h.run, h.manifest);
    expect(await asyncReasonOf(() => h.orchestrator.runToCompletion(h.run, h.manifest))).toBe(ORCHESTRATOR_REASONS.SIGNER_REJECTED);
    expect(h.run.state).toBe("DEPLOYMENT_PAUSED_SIGNER");
    expect(RESUMABLE_STATES.has(h.run.state)).toBe(true);
    expect(h.run.transactions.get("deploy-cre-consumer")!.state).toBe("NOT_SUBMITTED");
    expect(statusOf(h.run, "deploy-cre-consumer")).toBe("READY");
  });
});

/* ══════════════════════════ order, chain and policy ══════════════════════════ */

describe("deployment order and the policy that stays disabled", () => {
  it("DEP-007 the policy is disabled throughout, and no step can enable anything", async () => {
    const h = harness();
    await h.orchestrator.runToCompletion(h.run, h.manifest);

    // The manifest's three initial states are literals, and the deployment reached READY_TO_ACTIVATE
    // rather than anything resembling "active".
    expect(h.manifest.policyInitialState).toBe("DISABLED");
    expect(h.run.state).toBe("READY_TO_ACTIVATE");

    // No step in the plan is of an enabling type, and one bolted on is refused by name.
    const enabling = h.run.plan.steps.filter((s) => ["ACTIVATE", "ENABLE_POLICY", "REGISTER_POLICY_ENABLED"].includes(s.type));
    expect(enabling).toEqual([]);
    const smuggled = { ...h.run.plan.steps[0]!, id: "enable-it", type: "ACTIVATE" as const };
    expect(await asyncReasonOf(() => h.orchestrator.executeStep(h.run, smuggled, h.manifest)))
      .toBe(ORCHESTRATOR_REASONS.POLICY_WOULD_BE_ENABLED);

    // There is no path in the state machine from any deploying state to an activated one.
    for (const [from, tos] of Object.entries(DEPLOYMENT_TRANSITIONS)) {
      for (const to of tos) expect(`${from}->${to}`).not.toMatch(/ACTIVE(?!_)/);
    }
    expect(isTerminal("READY_TO_ACTIVATE")).toBe(true);
  });

  it("DEP-007b the state machine phases follow the security-first order", () => {
    expect(phaseFor("VERIFY_CORE")).toBe("DEPLOYING_CHAIN_COMPONENTS");
    expect(phaseFor("DEPLOY_CONTRACT")).toBe("DEPLOYING_CHAIN_COMPONENTS");
    expect(phaseFor("REGISTER_POLICY_DISABLED")).toBe("CONFIGURING_POLICY_DISABLED");
    expect(phaseFor("DEPLOY_CRE_PRIVATE")).toBe("DEPLOYING_CRE");
    expect(phaseFor("POST_DEPLOY_VERIFY")).toBe("VERIFYING_DEPLOYMENT");

    expect(() => assertTransition("DEPLOYMENT_APPROVED", "DEPLOYING_CHAIN_COMPONENTS")).not.toThrow();

    // Forward skips are legal, because a plan need not have work in every phase — an agent with no
    // CRE component would otherwise have to pass through DEPLOYING_CRE claiming to deploy nothing.
    expect(() => assertTransition("DEPLOYING_CHAIN_COMPONENTS", "DEPLOYING_CRE")).not.toThrow();
    expect(() => assertTransition("DEPLOYMENT_APPROVED", "BUILDING_RUNTIME_IMAGE")).not.toThrow();

    // Going BACKWARD is not. A deployment that has begun configuring policy cannot return to
    // deploying contracts.
    expect(reasonOf(() => assertTransition("CONFIGURING_POLICY_DISABLED", "DEPLOYING_CHAIN_COMPONENTS"))).toBe(MACHINE_REASONS.ILLEGAL_TRANSITION);
    expect(reasonOf(() => assertTransition("VERIFYING_DEPLOYMENT", "DEPLOYING_CRE"))).toBe(MACHINE_REASONS.ILLEGAL_TRANSITION);

    // And verification cannot be skipped: READY_TO_ACTIVATE has exactly one predecessor.
    const predecessors = Object.entries(DEPLOYMENT_TRANSITIONS).filter(([, tos]) => tos.has("READY_TO_ACTIVATE")).map(([from]) => from);
    expect(predecessors).toEqual(["VERIFYING_DEPLOYMENT"]);

    // Nothing leaves READY_TO_ACTIVATE or the terminal failure.
    expect(reasonOf(() => assertTransition("READY_TO_ACTIVATE", "DEPLOYING_CRE"))).toBe(MACHINE_REASONS.ILLEGAL_TRANSITION);
    expect(isTerminal("DEPLOYMENT_FAILED_TERMINAL")).toBe(true);
    expect(reasonOf(() => phaseFor("SOMETHING_NEW"))).toBe(MACHINE_REASONS.ILLEGAL_TRANSITION);
  });

  it("DEP-006b the calldata that gets signed is the calldata that was approved", async () => {
    // The plan pins a hash of the transaction's bytes. The executor supplies the bytes. Neither
    // side alone decides what is sent, and a mismatch stops before the wallet is asked.
    const h = harness();
    const pinned = clone(h.run.plan);
    const step = pinned.steps.find((s) => s.id === "register-policy-disabled")!;
    step.calldataHash = `sha256:${"e".repeat(64)}`;
    h.run.plan = pinned;

    await h.orchestrator.resume(h.run, h.manifest).catch(() => undefined);
    const err = await h.orchestrator.executeStep(h.run, step, h.manifest).catch((e) => e as OrchestratorError);
    expect((err as OrchestratorError).reason).toBe("DEPLOYMENT_ARTIFACT_DRIFT");
    expect((err as Error).message).toMatch(/hashes to sha256:[0-9a-f]{64}, but sha256:e{64} was approved/);
    expect(h.sends.map((s) => s.stepId)).not.toContain("register-policy-disabled");

    // With the correct pin it goes through.
    const ok = harness();
    const good = clone(ok.run.plan);
    const goodStep = good.steps.find((s) => s.id === "register-policy-disabled")!;
    const { createHash } = await import("node:crypto");
    goodStep.calldataHash = `sha256:${createHash("sha256").update(`0x${(await import("@contextlock/studio-deploy")).sha256Hex("calldata:register-policy-disabled")}`).digest("hex")}`;
    ok.run.plan = good;
    await ok.orchestrator.runToCompletion(ok.run, ok.manifest);
    expect(ok.sends.map((s) => s.stepId)).toContain("register-policy-disabled");
  });

  it("DEP-019 a chain mismatch is rejected at the last moment, not just at preflight", async () => {
    const h = harness();
    const mainnetManifest = { ...h.manifest, environment: mainnetEnvironment() };
    const step = h.run.plan.steps.find((s) => s.id === "deploy-cre-consumer")!;
    // Approval drift catches the environment edit first — which is itself the point.
    expect(await asyncReasonOf(() => h.orchestrator.resume(h.run, mainnetManifest))).toBe("DEPLOYMENT_ARTIFACT_DRIFT");
    // And executing the step directly against it still refuses.
    expect(await asyncReasonOf(() => h.orchestrator.executeStep(h.run, step, mainnetManifest)))
      .toBe(ORCHESTRATOR_REASONS.STEP_FAILED);
  });

  it("DEP-020 a mainnet write is blocked in the orchestrator, independently of the preflight", async () => {
    const h = harness();
    const disguised = clone(h.manifest);
    disguised.environment = { ...disguised.environment, chains: [{ chainId: 1, name: "Ethereum", chainSelector: "5009297550715157269", nativeSymbol: "ETH", nativeDecimals: 18, explorer: null }] };
    const step = { ...h.run.plan.steps.find((s) => s.id === "deploy-cre-consumer")!, chainId: 1 };
    const err = await h.orchestrator.executeStep(h.run, step, disguised).catch((e) => e as OrchestratorError);
    expect((err as OrchestratorError).reason).toBe(ORCHESTRATOR_REASONS.STEP_FAILED);
    expect((err as OrchestratorError).message).toMatch(/MAINNET-WRITE-PROHIBITED|known mainnet/);
    expect(h.sends.map((s) => s.stepId)).not.toContain("deploy-cre-consumer");
  });
});

/* ══════════════════════════ post-deploy verification ══════════════════════════ */

describe("post-deployment verification", () => {
  const CREATED = "0x1111111111111111111111111111111111111111" as Address;

  /** A reader that also holds the contract this deployment created, so its code can be re-hashed. */
  const readerWithCreated = (over: Parameters<typeof sepoliaReader>[0] = {}) => {
    const base = sepoliaReader(over);
    const created = codeFor("freshly-created-cre-consumer");
    return { ...base, async getCode(a: Address) { return a.toLowerCase() === CREATED.toLowerCase() ? created : base.getCode(a); } };
  };

  const verifyInput = (over: Record<string, unknown> = {}) => {
    const manifest = canonicalManifest();
    return {
      manifest,
      readers: new Map([[11155111, readerWithCreated()]]),
      createdAddresses: new Map<string, Address>([["ContextLockCreConsumer", CREATED]]),
      readPolicyEnabled: async () => false,
      readAdministrators: async () => [DEPLOYER],
      resolveEnsBinding: async () => null,
      readCreWorkflow: async () => ({ workflowId: "wf_1", registry: "private", binaryHash: manifest.creWorkflows[0]!.binaryHash, status: "PAUSED" }),
      readRuntimeImageDigest: async () => manifest.runtimeImages[0]!.imageDigest,
      readAdapterVersions: async () => new Map([["aave-v3", "1.2.0"]]),
      expectedAdministrators: new Set([DEPLOYER.toLowerCase()]),
      policyIds: new Map([["ContextLockPolicyRegistry", `0x${"11".repeat(32)}` as Hex]]),
      ...over,
    };
  };

  it("DEP-005 contract runtime code is re-hashed from the chain after deployment", async () => {
    const checks = await verifyDeployment(verifyInput() as never);
    const code = checks.filter((c) => c.id.startsWith("code:"));
    expect(code.length).toBe(5);
    expect(code.every((c) => c.ok), JSON.stringify(code.filter((c) => !c.ok))).toBe(true);
    // A contract created by THIS deployment has no pinned runtime hash to compare — the manifest
    // pins its creation code — so its observed hash is recorded rather than compared against a
    // value that was never applicable.
    const fresh = code.find((c) => c.id === "code:ContextLockCreConsumer")!;
    expect(fresh.expected).toBe("(created this deployment)");
    expect(fresh.observed).toMatch(/^0x[0-9a-f]{64}$/);

    // Swap the code at a reused address: verification fails, naming the contract.
    const swapped = await verifyDeployment(verifyInput({
      readers: new Map([[11155111, readerWithCreated({ code: new Map([[SEPOLIA_CORE.ContextLockExecutorV2.address.toLowerCase(), "0xdeadbeef" as Hex]]) })]]),
    }) as never);
    const bad = swapped.find((c) => c.id === "code:ContextLockExecutorV2")!;
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe(VERIFY_REASONS.CODE_MISMATCH);
    expect(() => assertVerified(swapped)).toThrow(VerificationError);
  });

  it("DEP-006 configuration state is verified by reading it back, and DEP-025 a mismatch blocks activation", async () => {
    const enabled = await verifyDeployment(verifyInput({ readPolicyEnabled: async () => true }) as never);
    const policy = enabled.find((c) => c.id.startsWith("policy-disabled:"))!;
    expect(policy.ok).toBe(false);
    expect(policy.reason).toBe(VERIFY_REASONS.POLICY_ENABLED);
    expect(policy.observed).toBe("ENABLED");

    // A deployment whose verification failed cannot begin activation.
    expect(reasonOf(() => assertActivationStep({ deploymentId: "d", completed: [], startedAtMs: NOW, activatedAtMs: null }, "START_RUNTIME", false)))
      .toBe(ACTIVATION_REASONS.NOT_VERIFIED);
  });

  it("DEP-008 ENS state is verified from the chain, not inferred from a transaction status", async () => {
    const manifest = canonicalManifest({
      ens: [{ name: "guardian.contextlock.eth", node: `0x${"22".repeat(32)}`, chainId: 11155111, resolver: SEPOLIA_CORE.EnsAgentIdentityVerifier.address, boundAgent: "0x4444444444444444444444444444444444444444" as Address }],
    });
    const bound = await verifyDeployment(verifyInput({ manifest, resolveEnsBinding: async () => "0x4444444444444444444444444444444444444444" as Address }) as never);
    expect(bound.find((c) => c.id.startsWith("ens:"))!.ok).toBe(true);

    // The transaction can succeed while the resolver still points somewhere else.
    const wrong = await verifyDeployment(verifyInput({ manifest, resolveEnsBinding: async () => ATTACKER }) as never);
    const e = wrong.find((c) => c.id.startsWith("ens:"))!;
    expect(e.ok).toBe(false);
    expect(e.reason).toBe(VERIFY_REASONS.ENS_MISMATCH);

    const unbound = await verifyDeployment(verifyInput({ manifest, resolveEnsBinding: async () => null }) as never);
    expect(unbound.find((c) => c.id.startsWith("ens:"))!.observed).toBe("(unbound)");
  });

  it("DEP-026 a CRE workflow mismatch blocks activation: binary, registry and state are each checked", async () => {
    const wrongBinary = await verifyDeployment(verifyInput({ readCreWorkflow: async () => ({ workflowId: "wf_1", registry: "private", binaryHash: "f".repeat(64), status: "PAUSED" }) }) as never);
    expect(wrongBinary.find((c) => c.id.startsWith("cre-binary:"))!.reason).toBe(VERIFY_REASONS.CRE_MISMATCH);

    const wrongRegistry = await verifyDeployment(verifyInput({ readCreWorkflow: async () => ({ workflowId: "wf_1", registry: "onchain:ethereum-mainnet", binaryHash: canonicalManifest().creWorkflows[0]!.binaryHash, status: "PAUSED" }) }) as never);
    expect(wrongRegistry.find((c) => c.id.startsWith("cre-registry:"))!.ok).toBe(false);

    const running = await verifyDeployment(verifyInput({ readCreWorkflow: async () => ({ workflowId: "wf_1", registry: "private", binaryHash: canonicalManifest().creWorkflows[0]!.binaryHash, status: "ACTIVE" }) }) as never);
    const st = running.find((c) => c.id.startsWith("cre-state:"))!;
    expect(st.ok).toBe(false);
    expect(st.reason).toBe(VERIFY_REASONS.CRE_NOT_PAUSED);

    const absent = await verifyDeployment(verifyInput({ readCreWorkflow: async () => null }) as never);
    expect(absent.find((c) => c.id.startsWith("cre:"))!.observed).toMatch(/not found in the registry/);
  });

  it("DEP-027 an unexpected administrator or issuer address blocks activation", async () => {
    const clean = await verifyDeployment(verifyInput() as never);
    expect(clean.filter((c) => c.id.startsWith("admins:")).every((c) => c.ok)).toBe(true);

    const compromised = await verifyDeployment(verifyInput({ readAdministrators: async () => [DEPLOYER, ATTACKER] }) as never);
    const a = compromised.find((c) => c.id.startsWith("admins:"))!;
    expect(a.ok).toBe(false);
    expect(a.reason).toBe(VERIFY_REASONS.UNEXPECTED_ADMIN);
    expect(a.observed).toContain(ATTACKER.toLowerCase());
    expect(() => assertVerified(compromised)).toThrow(/UNEXPECTED-ADMINISTRATOR/);
  });

  it("DEP-025b adapter version drift is caught too", async () => {
    const drifted = await verifyDeployment(verifyInput({ readAdapterVersions: async () => new Map([["aave-v3", "1.3.0"]]) }) as never);
    const c = drifted.find((x) => x.id.startsWith("adapter:"))!;
    expect(c.ok).toBe(false);
    expect(c.reason).toBe(VERIFY_REASONS.ADAPTER_MISMATCH);
  });
});

/* ══════════════════════════ CRE ══════════════════════════ */

describe("CRE deployment", () => {
  it("DEP-009 the exact approved WASM is deployed, by its own sha256", async () => {
    const h = harness();
    await h.orchestrator.runToCompletion(h.run, h.manifest);
    expect(h.creDeploys).toHaveLength(1);
    expect(h.creDeploys[0]!.approvedWasmSha256).toBe(creArtifact().wasmSha256);
    expect(h.creDeploys[0]!.registry).toBe("private");
    expect(h.run.creWorkflowId).toBe("wf_live_0001");
  });

  it("DEP-010 CRE artifact drift blocks the deploy and names what moved", async () => {
    const h = harness({ currentArtifact: creArtifact({ binaryHash: "9".repeat(64) }) });
    await h.orchestrator.resume(h.run, h.manifest);
    let err: OrchestratorError | null = null;
    try { await h.orchestrator.runToCompletion(h.run, h.manifest); } catch (e) { err = e as OrchestratorError; }
    expect(err?.reason).toBe("DEPLOYMENT_ARTIFACT_DRIFT");
    expect(err?.message).toMatch(/Re-approval is required/);
    expect(h.creDeploys).toEqual([]);

    // And a missing artifact is drift too, rather than an invitation to rebuild.
    const none = harness({ currentArtifact: null });
    await none.orchestrator.resume(none.run, none.manifest);
    expect(await asyncReasonOf(() => none.orchestrator.runToCompletion(none.run, none.manifest))).toBe("DEPLOYMENT_ARTIFACT_DRIFT");
  });

  it("DEP-011 losing CRE auth pauses safely rather than failing the deployment", async () => {
    const h = harness({ creAuthValid: false });
    await h.orchestrator.resume(h.run, h.manifest);
    expect(await asyncReasonOf(() => h.orchestrator.runToCompletion(h.run, h.manifest))).toBe(ORCHESTRATOR_REASONS.CRE_AUTH_LOST);
    expect(h.run.state).toBe("DEPLOYMENT_PAUSED_CRE_AUTH");
    expect(RESUMABLE_STATES.has(h.run.state)).toBe(true);
    // The contract work that already succeeded is still recorded as done.
    expect(statusOf(h.run, "deploy-cre-consumer")).toBe("VERIFIED");
  });

  it("DEP-012 the private-registry path claims no wallet gas, and the deploy is not an onchain write", async () => {
    const h = harness();
    await h.orchestrator.runToCompletion(h.run, h.manifest);
    const creStep = h.run.plan.steps.find((s) => s.id === "deploy-cre-private")!;
    // No chain, no signer, no cost — a private-registry registration is an off-chain lifecycle call.
    expect(creStep.chainId).toBeNull();
    expect(creStep.requiredSigner).toBeNull();
    expect(creStep.cost).toBeNull();
    expect(creStep.actorType).toBe("LOCAL_BRIDGE");
    expect(h.sends.map((s) => s.stepId)).not.toContain("deploy-cre-private");
    expect(h.run.transactions.has("deploy-cre-private")).toBe(false);
  });

  it("DEP-013 CRE status is read back through the structured lifecycle call, not assumed from the pause", async () => {
    // The pause "succeeds" and the workflow is nonetheless ACTIVE. Reading back is what catches it.
    const h = harness({ creStatusSequence: ["ACTIVE", "ACTIVE"] });
    await h.orchestrator.runToCompletion(h.run, h.manifest);
    expect(h.run.creStatus).toBe("ACTIVE");
    const ev = h.run.events.find((e) => e.stepId === "pause-cre")!;
    expect(ev.message).toMatch(/read back as ACTIVE/);
    // And it says, in the same breath, what the actual control is.
    expect(ev.message).toMatch(/onchain ContextLock policy is disabled/);

    const paused = harness({ creStatusSequence: ["ACTIVE", "PAUSED"] });
    await paused.orchestrator.runToCompletion(paused.run, paused.manifest);
    expect(paused.run.creStatus).toBe("PAUSED");
  });
});

/* ══════════════════════════ the image ══════════════════════════ */

describe("the runtime image", () => {
  it("DEP-014 the image is pinned by digest, and the tag is never what launches", () => {
    const a = imageArtifact();
    expect(a.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => assertDigestMatchesManifest(a, a.imageDigest)).not.toThrow();
    expect(reasonOf(() => assertDigestMatchesManifest(a, `sha256:${"0".repeat(64)}`))).toBe(IMAGE_REASONS.DIGEST_MISMATCH);
    // A manifest that pins nothing cannot be satisfied by an image that exists.
    expect(reasonOf(() => assertDigestMatchesManifest(a, null))).toBe(IMAGE_REASONS.DIGEST_MISMATCH);
    // Same tag, different digest: the tag proves nothing.
    const moved = imageArtifact({ imageDigest: `sha256:${"1".repeat(64)}` });
    expect(moved.tag).toBe(a.tag);
    expect(reasonOf(() => assertDigestMatchesManifest(moved, a.imageDigest))).toBe(IMAGE_REASONS.DIGEST_MISMATCH);
  });

  it("DEP-015 an SBOM is required, DEP-016 provenance is required, and both must describe the running digest", () => {
    expect(() => assertPromotable(imageArtifact(), vulnReport())).not.toThrow();
    expect(reasonOf(() => assertPromotable(imageArtifact({ sbomDigest: null }), vulnReport()))).toBe(IMAGE_REASONS.NO_SBOM);
    expect(reasonOf(() => assertPromotable(imageArtifact({ provenanceDigest: null }), vulnReport()))).toBe(IMAGE_REASONS.NO_PROVENANCE);
    expect(reasonOf(() => assertPromotable(imageArtifact({ runsAsRoot: true }), vulnReport()))).toBe(IMAGE_REASONS.ROOT_USER);
    expect(reasonOf(() => assertPromotable(imageArtifact({ baseImageDigest: "node:22-slim" as never }), vulnReport()))).toBe(IMAGE_REASONS.UNPINNED_BASE);

    // RUN-029's half: attestations must be about the digest that is actually running.
    expect(() => assertAttestationsCorrespond(imageArtifact(), imageArtifact().imageDigest)).not.toThrow();
    expect(reasonOf(() => assertAttestationsCorrespond(imageArtifact(), `sha256:${"7".repeat(64)}`))).toBe(IMAGE_REASONS.DIGEST_MISMATCH);
  });

  it("DEP-017 a critical vulnerability blocks promotion, and an unrun scan is not a clean scan", () => {
    const critical = vulnReport({
      counts: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, NEGLIGIBLE: 0, UNKNOWN: 0 },
      findings: [{ id: "CVE-2026-0001", severity: "CRITICAL", package: "libssl", installedVersion: "3.0.1", fixedVersion: "3.0.2" }],
    });
    const r = reasonOf(() => assertPromotable(imageArtifact(), critical));
    expect(r).toBe(IMAGE_REASONS.VULNERABLE);
    expect(() => assertPromotable(imageArtifact(), critical)).toThrow(/CVE-2026-0001.*fixed in 3\.0\.2/s);

    // The dangerous case: the scanner was not installed, so it found nothing.
    const notRun = vulnReport({ ran: false, unavailableReason: "grype is not installed on this machine" });
    expect(reasonOf(() => assertPromotable(imageArtifact(), notRun))).toBe(IMAGE_REASONS.SCAN_NOT_RUN);
    expect(() => assertPromotable(imageArtifact(), notRun)).toThrow(/an unrun scan is not a clean scan/);
    expect(reasonOf(() => assertPromotable(imageArtifact(), null))).toBe(IMAGE_REASONS.SCAN_NOT_RUN);

    // A scan of a different image is not a scan of this one.
    expect(reasonOf(() => assertPromotable(imageArtifact(), vulnReport({ imageDigest: `sha256:${"5".repeat(64)}` })))).toBe(IMAGE_REASONS.SCAN_WRONG_DIGEST);

    // An explicitly accepted risk passes; an expired acceptance does not.
    const accepted = { ...DEFAULT_IMAGE_POLICY, acceptedRisks: [{ id: "CVE-2026-0001", reason: "no fix; not reachable from the runtime's code path", acceptedBy: "kaushikh", expiresAtMs: NOW + 86_400_000 }] };
    expect(() => assertPromotable(imageArtifact(), critical, accepted, NOW)).not.toThrow();
    expect(reasonOf(() => assertPromotable(imageArtifact(), critical, accepted, NOW + 86_400_001))).toBe(IMAGE_REASONS.EXPIRED_ACCEPTANCE);
  });

  it("DEP-017b the orchestrator's scan step fails the deployment recoverably rather than publishing", async () => {
    const h = harness({ imageScanPromotable: false });
    await h.orchestrator.resume(h.run, h.manifest);
    expect(await asyncReasonOf(() => h.orchestrator.runToCompletion(h.run, h.manifest))).toBe(ORCHESTRATOR_REASONS.IMAGE_GATE);
    expect(h.run.state).toBe("DEPLOYMENT_FAILED_RECOVERABLE");
    expect(statusOf(h.run, "publish-runtime-image")).toBe("PENDING");
  });
});

/* ══════════════════════════ receipts and recovery ══════════════════════════ */

describe("deployment receipts", () => {
  const receipt = (over: Record<string, unknown> = {}) => ({
    schemaVersion: "contextlock.deployment-receipt/v1" as const,
    deploymentId: "dep_0001",
    manifestHash: manifestHash(canonicalManifest()),
    planHash: deploymentPlanHash(approvedPlan()),
    approvedBy: "kaushikh",
    approvedAtMs: NOW,
    environmentKind: "TESTNET",
    chains: [11155111],
    walletAddresses: [DEPLOYER],
    transactions: [],
    contractAddresses: { ContextLockCreConsumer: "0x1111111111111111111111111111111111111111" },
    creWorkflowId: "wf_live_0001",
    creBinaryHash: creArtifact().binaryHash,
    creRegistry: "private",
    creStatusAtDeploy: "PAUSED",
    runtimeImageDigest: imageArtifact().imageDigest,
    sbomDigest: imageArtifact().sbomDigest,
    provenanceDigest: imageArtifact().provenanceDigest,
    actualGasCostWeiByChain: { "11155111": "479898973466068" },
    estimatedGasCostWeiByChain: { "11155111": "575878768159281" },
    verifiedAtMs: NOW,
    verificationChecks: [{ id: "code:ContextLockExecutorV2", ok: true, expected: "0xabc", observed: "0xabc" }],
    finalStates: { policy: "DISABLED" as const, runtime: "INACTIVE" as const, cre: "PAUSED", deployment: "READY_TO_ACTIVATE" },
    generatedAtMs: NOW,
    ...over,
  });

  it("DEP-018 a deployment receipt contains no secret, and says what state everything was left in", () => {
    const r = receipt();
    expect(DeploymentReceiptSchema.safeParse(r).success).toBe(true);
    expect(scanForSecrets(r, "receipt")).toEqual([]);
    const sealed = sealReceipt(r);
    expect(sealed.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Both numbers survive: what it was expected to cost, and what it did.
    expect(r.estimatedGasCostWeiByChain["11155111"]).toBeTruthy();
    expect(r.actualGasCostWeiByChain["11155111"]).toBeTruthy();
    // And the schema cannot express a receipt that says the agent was left enabled.
    expect(DeploymentReceiptSchema.safeParse({ ...r, finalStates: { ...r.finalStates, policy: "ENABLED" } }).success).toBe(false);

    // The scanner really fires on a receipt that picked up a key along the way.
    expect(() => sealReceipt({ ...r, walletAddresses: [DEPLOYER], deploymentId: "sk-proj-NOT-A-REAL-KEY-000000000wx" } as never)).toThrow(DeploymentSecretError);
  });

  it("DEP-029 a partial deployment produces a recovery document that inventories rather than promises a rollback", () => {
    const plan = buildRecoveryPlan({
      deploymentId: "dep_0001",
      created: [{ name: "ContextLockCreConsumer", address: "0x1111111111111111111111111111111111111111", chainId: 11155111 }],
      unknownTransactions: [{ stepId: "register-policy-disabled", from: DEPLOYER, nonce: 8, detail: "nonce 8 has been consumed but no hash is known" }],
      configuredSteps: ["register-policy-disabled"],
      crePublished: true,
      imagePublished: true,
    });

    expect(plan.irreversiblyCreated.map((x) => x.what)).toEqual(["ContextLockCreConsumer", "CRE workflow registration", "runtime image"]);
    // Nothing anywhere in the document offers to undo a deployed contract.
    expect(JSON.stringify(plan)).not.toMatch(/roll ?back|undeploy|revert the deployment/i);
    expect(plan.irreversiblyCreated[0]!.note).toMatch(/cannot be removed/);

    // An unknown transaction makes the deployment non-resumable until a person resolves it.
    expect(plan.resumable).toBe(false);
    expect(plan.requiresHumanDecision).toHaveLength(1);
    expect(plan.requiresHumanDecision[0]!.options.join(" ")).toMatch(/Do NOT resubmit before answering this/);

    const clean = buildRecoveryPlan({ deploymentId: "d", created: [], unknownTransactions: [], configuredSteps: [], crePublished: false, imagePublished: false });
    expect(clean.resumable).toBe(true);
    expect(clean.resumeNote).toMatch(/marks as complete only what it can independently verify/);
  });
});

/* ══════════════════════════ activation ══════════════════════════ */

describe("the activation ceremony", () => {
  it("DEP-028 activation cannot happen before the runtime is ready, and the policy is enabled last", () => {
    let p = { deploymentId: "dep_0001", completed: [] as never[], startedAtMs: NOW, activatedAtMs: null } as Parameters<typeof advanceActivation>[0];

    // Enabling the policy first is refused, with an explanation rather than a code.
    expect(reasonOf(() => assertActivationStep(p, "ENABLE_CONTEXTLOCK_POLICY", true))).toBe(ACTIVATION_REASONS.OUT_OF_ORDER);
    expect(() => assertActivationStep(p, "ENABLE_CONTEXTLOCK_POLICY", true)).toThrow(/it is the step that grants the ability to move value/);

    // Skipping the heartbeat check is refused too.
    expect(reasonOf(() => assertActivationStep(p, "RESUME_CRE_WORKFLOW", true))).toBe(ACTIVATION_REASONS.OUT_OF_ORDER);

    for (const step of ACTIVATION_STEPS) {
      expect(() => assertActivationStep(p, step, true)).not.toThrow();
      p = advanceActivation(p, step, NOW + 1000);
    }
    expect(p.activatedAtMs).toBe(NOW + 1000);
    expect(p.completed).toEqual([...ACTIVATION_STEPS]);
    // The policy really was last.
    expect(p.completed.at(-1)).toBe("ENABLE_CONTEXTLOCK_POLICY");
  });

  it("ACT-004 deactivation is the exact reverse in security importance, and the policy goes first", () => {
    const stop = emergencyStopOrder(true);
    expect(stop[0]).toBe("DISABLE_CONTEXTLOCK_POLICY");
    expect(stop).toEqual([...DEACTIVATION_STEPS]);
    expect(emergencyStopOrder(false)).toEqual(["DISABLE_CONTEXTLOCK_POLICY", "PAUSE_CRE_WORKFLOW", "STOP_RUNTIME"]);

    // Activation ends with the policy; deactivation begins with it.
    expect(ACTIVATION_STEPS.at(-1)).toBe("ENABLE_CONTEXTLOCK_POLICY");
    expect(DEACTIVATION_STEPS[0]).toBe("DISABLE_CONTEXTLOCK_POLICY");
    // Runtime is started first on the way up and stopped late on the way down.
    expect(ACTIVATION_STEPS[0]).toBe("START_RUNTIME");
    expect(DEACTIVATION_STEPS.indexOf("STOP_RUNTIME")).toBeGreaterThan(DEACTIVATION_STEPS.indexOf("DISABLE_CONTEXTLOCK_POLICY"));
  });

  it("DEP-028b stopping the runtime does not claim the policy is disabled", () => {
    const claim = runtimeStopClaim(true);
    expect(claim.stopped).toBe(true);
    expect(claim.policyDisabled).toBe(false);
    expect(claim.message).toMatch(/still ENABLED/);
    expect(claim.message).toMatch(/has not been withdrawn/);
    expect(() => assertNotClaimingSecurityKill(claim, true)).not.toThrow();

    // A UI that reported otherwise would be caught.
    expect(reasonOf(() => assertNotClaimingSecurityKill({ policyDisabled: true }, true)))
      .toBe(ACTIVATION_REASONS.RUNTIME_STOP_IS_NOT_A_SECURITY_KILL);

    // The hierarchy states which actions are and are not a security kill.
    const byId = new Map(KILL_HIERARCHY.map((k) => [k.id, k]));
    expect(byId.get("OPERATIONAL_STOP")!.isSecurityKill).toBe(false);
    expect(byId.get("CRE_STOP")!.isSecurityKill).toBe(false);
    expect(byId.get("SECURITY_STOP")!.isSecurityKill).toBe(true);
    expect(byId.get("CRE_STOP")!.doesNotStop).toMatch(/Pausing CRE is not the kill switch/);
  });
});

/* ══════════════════════════ the whole run ══════════════════════════ */

describe("a deployment, end to end", () => {
  it("DEP-030 the canonical agent deploys to READY_TO_ACTIVATE with everything disabled", async () => {
    const h = harness();
    await h.orchestrator.runToCompletion(h.run, h.manifest);

    expect(h.run.state).toBe("READY_TO_ACTIVATE");
    expect(h.run.plan.steps.every((s) => s.status === "VERIFIED" || s.status === "SKIPPED_ALREADY_SATISFIED")).toBe(true);
    expect(h.run.creWorkflowId).toBe("wf_live_0001");
    expect(h.run.creStatus).toBe("PAUSED");
    expect(h.run.runtimeImageDigest).toMatch(/^sha256:/);
    expect(h.manifest.policyInitialState).toBe("DISABLED");
    expect(h.manifest.runtimeInitialState).toBe("INACTIVE");

    const last = h.run.events.at(-1)!;
    expect(last.message).toMatch(/Activation is a separate, explicit operation/);
    // Two writes, one nonce apart, never concurrent.
    expect(h.sends.map((s) => s.stepId)).toEqual(["deploy-cre-consumer", "register-policy-disabled"]);
    expect(h.sends[1]!.nonce).toBe(h.sends[0]!.nonce + 1);
  });

  it("DEP-030c an unapproved plan is refused before anything happens", async () => {
    const h = harness();
    const unapproved = { ...h.run, plan: { ...h.run.plan, readiness: "PREFLIGHT_READY" as const, approval: null } };
    expect(await asyncReasonOf(() => h.orchestrator.resume(unapproved, h.manifest))).toBe("APPROVAL-ABSENT");
    expect(h.observations).toEqual([]);
  });
});
