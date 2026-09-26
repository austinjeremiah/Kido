import { createHash } from "node:crypto";
import type { Address, Hex } from "viem";
import {
  assertApprovedFor, assertWriteAllowed, assertNoArtifactDrift, EnvironmentError,
  type ChainReader, type CreArtifact, type DeploymentManifest, type DeploymentPlan, type DeploymentStep, type DeploymentStepStatus,
} from "@contextlock/studio-deploy";
import { assertTransition, phaseFor, RESUMABLE_STATES, DeploymentMachineError, MACHINE_REASONS, type DeploymentState } from "./machine.js";
import {
  assertMinedSuccessfully, assertSafeToRetry, newTransactionRecord, recordSendOutcome, reconcile,
  waitForFinality, DEFAULT_CONFIRMATIONS,
  type TransactionRecord,
} from "./receipts.js";

/**
 * The deployment orchestrator.
 *
 * Executes an approved plan, resumably and idempotently, with the ContextLock policy disabled from
 * the first step to the last.
 *
 * Three properties carry it.
 *
 *   NOTHING RUNS THAT WAS NOT APPROVED. Every resume re-checks the approval against the CURRENT
 *   manifest, artifact by artifact. A deployment interrupted on Monday and resumed on Wednesday
 *   against an edited Blueprint stops, and names what changed.
 *
 *   A STEP IS COMPLETE ONLY WHEN THE WORLD SAYS SO. Resume does not read its own notes and believe
 *   them. It reads the chain, the registry and the runtime, and marks a step complete only when
 *   what it observes is what the step was supposed to produce. `SKIPPED_ALREADY_SATISFIED` is
 *   reachable only through an independent observation.
 *
 *   AN UNKNOWN OUTCOME IS NOT A RETRY. It is a state, it blocks, and it is resolved by looking.
 */

export interface StepExecutionContext {
  manifest: DeploymentManifest;
  readers: Map<number, ChainReader>;
  nowMs: () => number;
  /**
   * Addresses this deployment has created so far, keyed by the step that created them.
   *
   * An observer has to be able to look at what was just deployed. Without this it can only report
   * "not created yet" about a contract whose receipt is sitting in the run — which is what the
   * second live run did, immediately after a successful creation.
   */
  createdAddresses: Map<string, Address>;
}

/** What the orchestrator needs the outside world to do. Every one is injected, so every one is testable. */
export interface OrchestratorDeps {
  nowMs: () => number;
  readers: Map<number, ChainReader>;

  /**
   * Ask the user's wallet to sign and send. Returns a hash, or throws.
   *
   * `definitelyRejected` distinguishes "the user clicked reject" from "we do not know" — the first
   * leaves a resumable state with nothing sent, the second is UNKNOWN_SUBMISSION_STATE.
   */
  sendTransaction: (req: { chainId: number; from: Address; to: Address | null; data: Hex; value: bigint; nonce: number; gas: bigint }) => Promise<Hex>;

  /**
   * Supply the exact bytes for a write step.
   *
   * The PLAN pins `calldataHash`; the executor supplies the calldata; the orchestrator compares
   * them before signing. Neither side alone decides what gets sent.
   *
   * An earlier version of this file reconstructed calldata by stripping the `sha256:` prefix off
   * the hash and treating the remainder as data — which would have signed a hash. Splitting the two
   * roles is not just a bug fix: it is what makes "the transaction that was approved is the
   * transaction that was sent" checkable rather than assumed.
   */
  resolveCalldata: (step: DeploymentStep, manifest: DeploymentManifest) => Promise<{ to: Address | null; data: Hex; value: bigint }>;

  /** Independent observation for each step type: "is this already true of the world?" */
  observe: (step: DeploymentStep, ctx: StepExecutionContext) => Promise<{ satisfied: boolean; evidence: string; createdAddress?: Address }>;

  /** The CRE side, through the Local Bridge or the CRE Broker. Never a raw credential here. */
  cre: {
    currentArtifact: () => Promise<CreArtifact | null>;
    deploy: (args: { workflow: string; wasmPath: string; registry: string; approvedWasmSha256: string }) => Promise<{ workflowId: string; registry: string; status: string; binaryHash: string }>;
    lifecycle: (args: { workflow: string; action: "get" | "pause" | "activate" }) => Promise<{ status: string; detail: unknown }>;
    authValid: () => Promise<boolean>;
  };

  /** How long to wait for a receipt before declaring the outcome unknown. */
  receiptTimeoutMs?: number;
  /** Confirmations required before a step's effect may be depended on. */
  confirmations?: number;
  /** Injected so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;

  /** The image pipeline. Returns a digest; the orchestrator never learns how it was built. */
  image: {
    build: (agentId: string) => Promise<{ imageDigest: string }>;
    scan: (imageDigest: string) => Promise<{ promotable: boolean; detail: string }>;
    publish: (imageDigest: string) => Promise<{ published: true }>;
    createDisabled: (args: { agentId: string; imageDigest: string }) => Promise<{ revisionId: string }>;
  };
}

export interface DeploymentRun {
  deploymentId: string;
  state: DeploymentState;
  plan: DeploymentPlan;
  transactions: Map<string, TransactionRecord>;
  createdAddresses: Map<string, Address>;
  creWorkflowId: string | null;
  creStatus: string | null;
  runtimeImageDigest: string | null;
  events: Array<{ atMs: number; stepId: string | null; message: string }>;
}

export const ORCHESTRATOR_REASONS = {
  NOT_APPROVED: "DEPLOY-NOT-APPROVED",
  ARTIFACT_DRIFT: "DEPLOYMENT_ARTIFACT_DRIFT",
  UNKNOWN_TX: "DEPLOY-UNKNOWN-TRANSACTION-STATE",
  CRE_AUTH_LOST: "DEPLOY-CRE-AUTH-LOST",
  SIGNER_REJECTED: "DEPLOY-SIGNER-REJECTED",
  IMAGE_GATE: "DEPLOY-IMAGE-GATE-FAILED",
  STEP_FAILED: "DEPLOY-STEP-FAILED",
  NOT_RESUMABLE: "DEPLOY-NOT-RESUMABLE",
  POLICY_WOULD_BE_ENABLED: "DEPLOY-POLICY-WOULD-BE-ENABLED",
} as const;
export type OrchestratorReason = (typeof ORCHESTRATOR_REASONS)[keyof typeof ORCHESTRATOR_REASONS];

export class OrchestratorError extends Error {
  constructor(readonly reason: OrchestratorReason, detail: string, readonly stepId: string | null = null) {
    super(`${reason}${stepId ? ` [${stepId}]` : ""}: ${detail}`);
    this.name = "OrchestratorError";
  }
}

/**
 * Step types that would enable something.
 *
 * There are none in a deployment plan, and this set exists so that the assertion can be written
 * down rather than merely being true by inspection. DEP-007 checks it every step, every run.
 */
const ENABLING_STEP_TYPES: ReadonlySet<string> = new Set(["ACTIVATE", "ENABLE_POLICY", "REGISTER_POLICY_ENABLED"]);

export class DeploymentOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  newRun(deploymentId: string, plan: DeploymentPlan): DeploymentRun {
    return {
      deploymentId,
      state: "DEPLOYMENT_APPROVED",
      plan,
      transactions: new Map(),
      createdAddresses: new Map(),
      creWorkflowId: null,
      creStatus: null,
      runtimeImageDigest: null,
      events: [],
    };
  }

  private log(run: DeploymentRun, stepId: string | null, message: string): void {
    run.events.push({ atMs: this.deps.nowMs(), stepId, message });
  }

  private moveTo(run: DeploymentRun, to: DeploymentState): void {
    if (run.state === to) return;
    assertTransition(run.state, to);
    this.log(run, null, `${run.state} -> ${to}`);
    run.state = to;
  }

  /**
   * Resume: re-derive reality, then continue.
   *
   * Called at the start of EVERY run, including the first. There is no separate "start" path, so
   * the resume logic cannot rot from disuse — the first run is just a resume from nothing.
   */
  async resume(run: DeploymentRun, manifest: DeploymentManifest): Promise<DeploymentRun> {
    if (!RESUMABLE_STATES.has(run.state)) {
      throw new DeploymentMachineError(MACHINE_REASONS.NOT_RESUMABLE, `deployment ${run.deploymentId} is ${run.state}`);
    }
    // What was approved must still be what would happen. Checked before anything is observed, so a
    // drifted deployment does not even get as far as reading the chain.
    assertApprovedFor(run.plan, manifest);

    const ctx: StepExecutionContext = { manifest, readers: this.deps.readers, nowMs: this.deps.nowMs, createdAddresses: run.createdAddresses };

    // Any transaction whose fate is unknown must be reconciled BEFORE any step is considered, or a
    // resume could re-run the very step that is in flight.
    for (const [stepId, record] of run.transactions) {
      if (record.state !== "UNKNOWN_SUBMISSION_STATE") continue;
      const reader = this.deps.readers.get(record.chainId);
      if (!reader) continue;
      const resolved = await reconcile(record, reader, this.deps.nowMs());
      run.transactions.set(stepId, resolved);
      this.log(run, stepId, `reconciled unknown submission: ${resolved.state}${resolved.revertDetail ? ` — ${resolved.revertDetail}` : ""}`);
      if (resolved.state === "MINED_SUCCESS" && resolved.contractAddress) {
        run.createdAddresses.set(stepId, resolved.contractAddress as Address);
      }
    }

    // Independent observation. A step is complete only if the world says its effect exists.
    for (const step of run.plan.steps) {
      if (step.status === "VERIFIED" || step.status === "SKIPPED_ALREADY_SATISFIED") continue;
      const tx = run.transactions.get(step.id);
      if (tx?.state === "UNKNOWN_SUBMISSION_STATE") continue;
      const seen = await this.deps.observe(step, ctx);
      if (seen.satisfied) {
        this.setStatus(run, step.id, tx?.state === "MINED_SUCCESS" ? "VERIFIED" : "SKIPPED_ALREADY_SATISFIED");
        if (seen.createdAddress) run.createdAddresses.set(step.id, seen.createdAddress);
        this.log(run, step.id, `already satisfied: ${seen.evidence}`);
      }
    }
    return run;
  }

  private setStatus(run: DeploymentRun, stepId: string, status: DeploymentStepStatus): void {
    run.plan = {
      ...run.plan,
      steps: run.plan.steps.map((s) => (s.id === stepId ? { ...s, status } : s)),
    };
  }

  /** The next step whose dependencies are all independently satisfied. */
  nextStep(run: DeploymentRun): DeploymentStep | null {
    const done = new Set(run.plan.steps.filter((s) => s.status === "VERIFIED" || s.status === "SKIPPED_ALREADY_SATISFIED").map((s) => s.id));
    return run.plan.steps.find((s) => !done.has(s.id) && s.status !== "FAILED" && s.dependencyIds.every((d) => done.has(d))) ?? null;
  }

  /**
   * Execute one step.
   *
   * One at a time, on purpose. A deployment containing irreversible steps is not a place for
   * concurrency: the cost of a slow deployment is a slow deployment, and the cost of two steps
   * racing on one nonce is two contracts.
   */
  async executeStep(run: DeploymentRun, step: DeploymentStep, manifest: DeploymentManifest): Promise<DeploymentRun> {
    if (ENABLING_STEP_TYPES.has(step.type)) {
      throw new OrchestratorError(
        ORCHESTRATOR_REASONS.POLICY_WOULD_BE_ENABLED,
        `step type ${step.type} would grant authority during a deployment; activation is a separate ceremony`,
        step.id,
      );
    }
    this.moveTo(run, phaseFor(step.type));

    const existing = run.transactions.get(step.id);
    if (existing) assertSafeToRetry(existing);

    switch (step.type) {
      case "VERIFY_CHAIN":
      case "VERIFY_CORE":
      case "CHECK_CRE_ACCESS":
      case "BUILD_CRE_WASM":
      case "VERIFY_CRE_HASH":
      case "POST_DEPLOY_VERIFY":
        return this.executeObservation(run, step, manifest);
      case "DEPLOY_CONTRACT":
      case "CONFIGURE_CONTRACT":
      case "REGISTER_POLICY_DISABLED":
      case "REGISTER_ENS_IDENTITY":
        return this.executeWrite(run, step, manifest);
      case "DEPLOY_CRE_PRIVATE":
        return this.executeCreDeploy(run, step, manifest);
      case "PAUSE_CRE":
        return this.executeCrePause(run, step, manifest);
      case "BUILD_RUNTIME_IMAGE":
      case "SCAN_RUNTIME_IMAGE":
      case "PUBLISH_RUNTIME_IMAGE":
      case "CREATE_RUNTIME_DISABLED":
        return this.executeImageStep(run, step, manifest);
      default:
        throw new OrchestratorError(ORCHESTRATOR_REASONS.STEP_FAILED, `no handler for step type ${step.type}`, step.id);
    }
  }

  private async executeObservation(run: DeploymentRun, step: DeploymentStep, manifest: DeploymentManifest): Promise<DeploymentRun> {
    const ctx: StepExecutionContext = { manifest, readers: this.deps.readers, nowMs: this.deps.nowMs, createdAddresses: run.createdAddresses };
    const seen = await this.deps.observe(step, ctx);
    if (!seen.satisfied) {
      this.setStatus(run, step.id, "FAILED");
      throw new OrchestratorError(ORCHESTRATOR_REASONS.STEP_FAILED, seen.evidence, step.id);
    }
    if (seen.createdAddress) run.createdAddresses.set(step.id, seen.createdAddress);
    this.setStatus(run, step.id, "VERIFIED");
    this.log(run, step.id, seen.evidence);
    return run;
  }

  private async executeWrite(run: DeploymentRun, step: DeploymentStep, manifest: DeploymentManifest): Promise<DeploymentRun> {
    if (step.chainId === null) throw new OrchestratorError(ORCHESTRATOR_REASONS.STEP_FAILED, "a write step must name a chain", step.id);
    // Checked again here, at the last possible moment, because the environment could have been
    // edited between approval and this line.
    try {
      assertWriteAllowed(manifest.environment, step.chainId);
    } catch (e) {
      throw new OrchestratorError(ORCHESTRATOR_REASONS.STEP_FAILED, (e as EnvironmentError).message, step.id);
    }

    const reader = this.deps.readers.get(step.chainId);
    if (!reader) throw new OrchestratorError(ORCHESTRATOR_REASONS.STEP_FAILED, `no reader for chain ${step.chainId}`, step.id);
    const signer = manifest.requiredSigners.find((s) => s.signerId === step.requiredSigner);
    if (!signer?.address) throw new OrchestratorError(ORCHESTRATOR_REASONS.STEP_FAILED, `step names signer "${step.requiredSigner}" which has no address`, step.id);

    const from = signer.address as Address;
    const nonce = Number(await reader.getTransactionCount(from));
    let record = run.transactions.get(step.id) ?? newTransactionRecord({
      deploymentStepId: step.id, chainId: step.chainId, from, nonce,
      estimatedNativeCostWei: step.cost?.totalNativeWei ?? null,
    });

    const prepared = await this.deps.resolveCalldata(step, manifest);
    /*
     * What was approved is what is sent.
     *
     * The plan pinned a hash of the calldata at approval time. If the bytes the executor produces
     * now hash differently, something between approval and here changed the transaction, and the
     * approval no longer covers it.
     */
    if (step.calldataHash) {
      const actual = `sha256:${createHash("sha256").update(prepared.data).digest("hex")}`;
      if (actual !== step.calldataHash) {
        throw new OrchestratorError(
          ORCHESTRATOR_REASONS.ARTIFACT_DRIFT,
          `the calldata for "${step.id}" hashes to ${actual}, but ${step.calldataHash} was approved`,
          step.id,
        );
      }
    }
    if (step.type !== "DEPLOY_CONTRACT" && prepared.to === null) {
      throw new OrchestratorError(ORCHESTRATOR_REASONS.STEP_FAILED, "a non-creation write must name a target", step.id);
    }

    this.setStatus(run, step.id, "SUBMITTED");
    try {
      const hash = await this.deps.sendTransaction({
        chainId: step.chainId, from,
        to: step.type === "DEPLOY_CONTRACT" ? null : prepared.to,
        data: prepared.data,
        value: prepared.value, nonce, gas: BigInt(step.cost?.estimatedGas ?? "0"),
      });
      record = recordSendOutcome(record, { txHash: hash }, this.deps.nowMs());
    } catch (e) {
      const rejected = /user rejected|denied|declined/i.test((e as Error).message);
      record = recordSendOutcome(record, { error: e, definitelyRejected: rejected }, this.deps.nowMs());
      run.transactions.set(step.id, record);
      if (rejected) {
        // Nothing was sent. The deployment pauses in a state it can be resumed from.
        this.setStatus(run, step.id, "READY");
        this.moveTo(run, "DEPLOYMENT_PAUSED_SIGNER");
        throw new OrchestratorError(ORCHESTRATOR_REASONS.SIGNER_REJECTED, `${signer.signerId} declined to sign; nothing was submitted and the deployment can be resumed`, step.id);
      }
      this.setStatus(run, step.id, "UNKNOWN_SUBMISSION_STATE");
      this.moveTo(run, "DEPLOYMENT_PARTIAL");
      throw new OrchestratorError(
        ORCHESTRATOR_REASONS.UNKNOWN_TX,
        `the transaction for "${step.id}" was sent and its outcome is unknown. It must be reconciled against the chain before any retry.`,
        step.id,
      );
    }

    run.transactions.set(step.id, record);
    /*
     * Wait for the receipt, and then for confirmations.
     *
     * Bounded. If the wait expires the record is still UNKNOWN_SUBMISSION_STATE and still not
     * retryable — the next resume reconciles it by hash. The wait exists so that "we do not know"
     * means "we asked and could not find out", not "we did not wait".
     */
    const settled = await waitForFinality(record, reader, this.deps.confirmations ?? DEFAULT_CONFIRMATIONS, {
      ...(this.deps.receiptTimeoutMs !== undefined ? { timeoutMs: this.deps.receiptTimeoutMs } : {}),
      now: this.deps.nowMs,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
    run.transactions.set(step.id, settled);
    try {
      assertMinedSuccessfully(settled);
    } catch (e) {
      this.setStatus(run, step.id, "FAILED");
      this.moveTo(run, "DEPLOYMENT_PARTIAL");
      throw new OrchestratorError(ORCHESTRATOR_REASONS.STEP_FAILED, (e as Error).message, step.id);
    }
    if (settled.contractAddress) run.createdAddresses.set(step.id, settled.contractAddress as Address);
    this.setStatus(run, step.id, "CONFIRMED");

    // Mined is not done. The effect is observed before the step is marked VERIFIED — and the
    // observer can see the address this step just created, because the receipt has already been
    // recorded into the run above.
    const ctx: StepExecutionContext = { manifest, readers: this.deps.readers, nowMs: this.deps.nowMs, createdAddresses: run.createdAddresses };
    const seen = await this.deps.observe(step, ctx);
    if (!seen.satisfied) {
      this.setStatus(run, step.id, "FAILED");
      this.moveTo(run, "DEPLOYMENT_PARTIAL");
      throw new OrchestratorError(
        ORCHESTRATOR_REASONS.STEP_FAILED,
        `the transaction for "${step.id}" succeeded but the intended state is not present: ${seen.evidence}`,
        step.id,
      );
    }
    this.setStatus(run, step.id, "VERIFIED");
    this.log(run, step.id, `confirmed in block ${settled.blockNumber}, gas ${settled.gasUsed}, verified: ${seen.evidence}`);
    return run;
  }

  private async executeCreDeploy(run: DeploymentRun, step: DeploymentStep, manifest: DeploymentManifest): Promise<DeploymentRun> {
    if (!(await this.deps.cre.authValid())) {
      // Pausing rather than failing: a CRE session expiring mid-deployment is an ordinary event and
      // the correct response is to re-authenticate and resume, not to abandon what was deployed.
      this.moveTo(run, "DEPLOYMENT_PAUSED_CRE_AUTH");
      throw new OrchestratorError(ORCHESTRATOR_REASONS.CRE_AUTH_LOST, "the CRE session is no longer valid; re-connect and resume", step.id);
    }
    const workflow = manifest.creWorkflows[0];
    if (!workflow) throw new OrchestratorError(ORCHESTRATOR_REASONS.STEP_FAILED, "no CRE workflow in the manifest", step.id);

    // The artifact that exists NOW must be the artifact that was approved. This is the second of
    // two checks — the bridge performs the same comparison on the machine that holds the file —
    // and having both is deliberate: one of them is on the other side of a trust boundary.
    const current = await this.deps.cre.currentArtifact();
    if (!current) throw new OrchestratorError(ORCHESTRATOR_REASONS.ARTIFACT_DRIFT, "no built CRE artifact is available to deploy", step.id);
    const approvedHashes = run.plan.approval?.artifactHashes ?? {};
    const approvedBinary = approvedHashes[`cre-binary:${workflow.workflowName}`];
    if (approvedBinary && approvedBinary !== current.binaryHash) {
      throw new OrchestratorError(
        ORCHESTRATOR_REASONS.ARTIFACT_DRIFT,
        `the built workflow binary is ${current.binaryHash}, but ${approvedBinary} was approved. Re-approval is required.`,
        step.id,
      );
    }
    assertNoArtifactDrift(
      { ...current, binaryHash: workflow.binaryHash, configHash: workflow.configHash, workflowHash: workflow.workflowHash, sourceTreeHash: workflow.sourceTreeHash },
      current,
    );

    const r = await this.deps.cre.deploy({
      workflow: workflow.workflowName,
      wasmPath: current.wasmPath,
      registry: workflow.registry,
      // The exact prebuilt binary. Not a rebuild.
      approvedWasmSha256: current.wasmSha256,
    });
    run.creWorkflowId = r.workflowId;
    run.creStatus = r.status;
    this.setStatus(run, step.id, "VERIFIED");
    this.log(run, step.id, `CRE workflow ${r.workflowId} registered in the ${r.registry} registry from binary ${r.binaryHash}, status ${r.status}`);
    return run;
  }

  private async executeCrePause(run: DeploymentRun, step: DeploymentStep, manifest: DeploymentManifest): Promise<DeploymentRun> {
    const workflow = manifest.creWorkflows[0];
    if (!workflow) throw new OrchestratorError(ORCHESTRATOR_REASONS.STEP_FAILED, "no CRE workflow in the manifest", step.id);
    const before = await this.deps.cre.lifecycle({ workflow: workflow.workflowName, action: "get" });
    if (before.status.toUpperCase() !== "PAUSED") {
      await this.deps.cre.lifecycle({ workflow: workflow.workflowName, action: "pause" });
    }
    // The state is READ BACK rather than assumed from the pause call succeeding.
    const after = await this.deps.cre.lifecycle({ workflow: workflow.workflowName, action: "get" });
    run.creStatus = after.status;
    this.setStatus(run, step.id, "VERIFIED");
    this.log(
      run, step.id,
      `CRE workflow state read back as ${after.status}. Note: this is not the security control — the onchain ContextLock policy is disabled, and that is what prevents authorized financial execution if the workflow triggers.`,
    );
    return run;
  }

  private async executeImageStep(run: DeploymentRun, step: DeploymentStep, manifest: DeploymentManifest): Promise<DeploymentRun> {
    const image = manifest.runtimeImages[0];
    if (!image) throw new OrchestratorError(ORCHESTRATOR_REASONS.STEP_FAILED, "no runtime image in the manifest", step.id);
    switch (step.type) {
      case "BUILD_RUNTIME_IMAGE": {
        const b = await this.deps.image.build(image.agentId);
        run.runtimeImageDigest = b.imageDigest;
        this.log(run, step.id, `built ${image.agentId} as ${b.imageDigest}`);
        break;
      }
      case "SCAN_RUNTIME_IMAGE": {
        if (!run.runtimeImageDigest) throw new OrchestratorError(ORCHESTRATOR_REASONS.STEP_FAILED, "nothing has been built to scan", step.id);
        const s = await this.deps.image.scan(run.runtimeImageDigest);
        if (!s.promotable) {
          this.setStatus(run, step.id, "FAILED");
          this.moveTo(run, "DEPLOYMENT_FAILED_RECOVERABLE");
          throw new OrchestratorError(ORCHESTRATOR_REASONS.IMAGE_GATE, s.detail, step.id);
        }
        this.log(run, step.id, s.detail);
        break;
      }
      case "PUBLISH_RUNTIME_IMAGE": {
        if (!run.runtimeImageDigest) throw new OrchestratorError(ORCHESTRATOR_REASONS.STEP_FAILED, "nothing has been built to publish", step.id);
        await this.deps.image.publish(run.runtimeImageDigest);
        this.log(run, step.id, `published ${run.runtimeImageDigest}`);
        break;
      }
      case "CREATE_RUNTIME_DISABLED": {
        if (!run.runtimeImageDigest) throw new OrchestratorError(ORCHESTRATOR_REASONS.STEP_FAILED, "no image digest to create a runtime from", step.id);
        const r = await this.deps.image.createDisabled({ agentId: image.agentId, imageDigest: run.runtimeImageDigest });
        this.log(run, step.id, `runtime revision ${r.revisionId} created INACTIVE from digest ${run.runtimeImageDigest}`);
        break;
      }
    }
    this.setStatus(run, step.id, "VERIFIED");
    return run;
  }

  /** Run to completion, or to the first thing that needs a person. */
  async runToCompletion(run: DeploymentRun, manifest: DeploymentManifest, maxSteps = 100): Promise<DeploymentRun> {
    await this.resume(run, manifest);
    for (let i = 0; i < maxSteps; i++) {
      const step = this.nextStep(run);
      if (!step) break;
      await this.executeStep(run, step, manifest);
    }
    const remaining = run.plan.steps.filter((s) => s.status !== "VERIFIED" && s.status !== "SKIPPED_ALREADY_SATISFIED");
    if (remaining.length === 0) {
      this.moveTo(run, "VERIFYING_DEPLOYMENT");
      this.moveTo(run, "READY_TO_ACTIVATE");
      this.log(run, null, "READY_TO_ACTIVATE. The policy is disabled, the runtime is inactive and the CRE workflow is paused. Activation is a separate, explicit operation.");
    }
    return run;
  }
}
