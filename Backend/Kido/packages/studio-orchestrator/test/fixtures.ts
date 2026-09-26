import { keccak256, type Address, type Hex } from "viem";
import type { ChainReader, DeploymentManifest, DeploymentPlan, DeploymentStep, CreArtifact } from "@contextlock/studio-deploy";
import { approve, buildApprovalScreen, RpcError, sha256Hex } from "@contextlock/studio-deploy";
import type { OrchestratorDeps, DeploymentRun, StepExecutionContext } from "../src/index.js";
import { DeploymentOrchestrator } from "../src/index.js";
import type { RuntimeImageArtifact, VulnerabilityReport } from "../src/image.js";

/*
 * The orchestrator's fixtures deliberately re-use P22's canonical manifest and plan, imported by
 * relative path rather than re-declared. A second copy of the manifest would drift from the first,
 * and the tests would stop testing the thing the preflight actually produces.
 */
export {
  NOW, DEPLOYER, ISSUER, AGENT, ATTACKER, SEPOLIA_CORE, clone,
  fakeChain, sepoliaReader, codeFor, hashOfFixtureCode,
  canonicalManifest, canonicalPlan, stepCost, creStatus, creArtifact, creQuota, creLimits,
} from "../../studio-deploy/test/fixtures.js";
import {
  NOW, DEPLOYER, canonicalManifest, canonicalPlan, sepoliaReader, creArtifact,
} from "../../studio-deploy/test/fixtures.js";

/** An approved plan — the only kind the orchestrator will touch. */
export function approvedPlan(manifest = canonicalManifest()): DeploymentPlan {
  const plan = canonicalPlan(manifest);
  const screen = buildApprovalScreen({
    manifest, plan,
    funding: [{ chainId: 11155111, symbol: "ETH", decimals: 18, baseWei: 1n, bufferWei: 1n, bufferBps: 2000, recommendedWei: 2n, holder: DEPLOYER, balanceWei: 10n ** 18n, sufficient: true, shortfallWei: 0n, quotedAtMs: NOW, fromLiveNode: true }],
    cre: { registry: "private", deployAccess: true, workflowSlots: { used: 0, allowed: 3 }, binaryHash: creArtifact().binaryHash, workflowHash: creArtifact().workflowHash, limitsSimulated: true },
    blockers: [],
  });
  return approve({ manifest, plan, screen, approvedBy: "kaushikh", nowMs: NOW });
}

export interface HarnessOptions {
  /** Steps whose observation should report the effect already present. */
  alreadySatisfied?: Set<string>;
  /** Steps whose observation should report the effect ABSENT even after a successful transaction. */
  effectMissing?: Set<string>;
  /** Make `sendTransaction` throw. `rejected` means the user declined; otherwise unknown. */
  sendFails?: { stepId: string; error: Error; rejected?: boolean };
  creAuthValid?: boolean;
  creStatusSequence?: string[];
  creDeployedBinaryHash?: string;
  currentArtifact?: CreArtifact | null;
  imageScanPromotable?: boolean;
  receiptStatus?: "success" | "reverted";
  nonceStart?: number;
}

export interface Harness {
  orchestrator: DeploymentOrchestrator;
  run: DeploymentRun;
  manifest: DeploymentManifest;
  deps: OrchestratorDeps;
  sends: Array<{ stepId: string; nonce: number }>;
  creDeploys: Array<{ workflow: string; approvedWasmSha256: string; registry: string }>;
  observations: string[];
  now: { ms: number };
}

/**
 * A harness with everything wired.
 *
 * The chain reader is a real `ChainReader` whose receipts are driven by the sends, so
 * "reconciliation reads the chain" is really a read of something that really changed — a mock that
 * returned a canned receipt regardless of what was sent would make every reconciliation test vacuous.
 */
export function harness(opts: HarnessOptions = {}): Harness {
  const now = { ms: NOW };
  const manifest = canonicalManifest();
  const plan = approvedPlan(manifest);
  const sends: Array<{ stepId: string; nonce: number }> = [];
  const creDeploys: Array<{ workflow: string; approvedWasmSha256: string; registry: string }> = [];
  const observations: string[] = [];
  const satisfiedAfter = new Set<string>();

  const receipts = new Map<string, { status: "success" | "reverted"; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint; contractAddress: Address | null }>();
  const nonces = new Map<string, bigint>([[DEPLOYER.toLowerCase(), BigInt(opts.nonceStart ?? 7)]]);
  const base = sepoliaReader({ nonces });
  const reader: ChainReader = {
    ...base,
    async getTransactionReceipt(hash) { return receipts.get(hash.toLowerCase()) ?? null; },
    async getTransactionCount(a) { return nonces.get(a.toLowerCase()) ?? 0n; },
    async getBlockNumber() { return 11_673_900n; },
  };

  let creStatusIdx = 0;
  const creStatuses = opts.creStatusSequence ?? ["PAUSED", "PAUSED"];

  const deps: OrchestratorDeps = {
    nowMs: () => now.ms,
    readers: new Map([[11155111, reader]]),

    async resolveCalldata(step) {
      // The bytes a real executor would build. Hashed by the orchestrator against the plan's pin,
      // so a fixture that produced different bytes would be caught by the same check a real
      // deployment relies on.
      const data = (`0x${sha256Hex(`calldata:${step.id}`)}` as Hex);
      return { to: (step.target ?? null) as Address | null, data, value: 0n };
    },

    async sendTransaction(req) {
      const stepId = currentStepId;
      sends.push({ stepId, nonce: req.nonce });
      if (opts.sendFails && opts.sendFails.stepId === stepId) throw opts.sendFails.error;
      const hash = keccak256(`0x${sha256Hex(`${stepId}:${req.nonce}`)}` as Hex).toLowerCase() as Hex;
      receipts.set(hash, {
        status: opts.receiptStatus ?? "success",
        blockNumber: 11_673_890n,
        gasUsed: 405_158n,
        effectiveGasPrice: 1_184_473_646n,
        contractAddress: req.to === null ? ("0x1111111111111111111111111111111111111111" as Address) : null,
      });
      nonces.set(req.from.toLowerCase(), BigInt(req.nonce + 1));
      satisfiedAfter.add(stepId);
      return hash;
    },

    async observe(step: DeploymentStep, _ctx: StepExecutionContext) {
      observations.push(step.id);
      if (opts.effectMissing?.has(step.id)) {
        return { satisfied: false, evidence: `the state "${step.id}" was supposed to produce is not present on chain` };
      }
      if (opts.alreadySatisfied?.has(step.id)) {
        return { satisfied: true, evidence: `observed on chain: ${step.id} was already done`, ...(step.type === "DEPLOY_CONTRACT" ? { createdAddress: "0x2222222222222222222222222222222222222222" as Address } : {}) };
      }
      /*
       * A CHECK observes true because performing it IS checking. An ACTION observes true only once
       * its effect exists.
       *
       * The distinction is not cosmetic: `resume()` marks any step whose effect it can observe as
       * SKIPPED_ALREADY_SATISFIED, so a fixture that reported every action as already done would
       * make the orchestrator skip the entire deployment and still report success — which is
       * exactly what the first run of these tests did.
       */
      const CHECKS = ["VERIFY_CHAIN", "VERIFY_CORE", "CHECK_CRE_ACCESS", "BUILD_CRE_WASM", "VERIFY_CRE_HASH", "POST_DEPLOY_VERIFY"];
      if (CHECKS.includes(step.type)) return { satisfied: true, evidence: `${step.type} checked` };
      return satisfiedAfter.has(step.id)
        ? { satisfied: true, evidence: `the effect of ${step.id} is present` }
        : { satisfied: false, evidence: `${step.id} has not been performed yet` };
    },

    cre: {
      async currentArtifact() { return opts.currentArtifact !== undefined ? opts.currentArtifact : creArtifact(); },
      async deploy(a) {
        creDeploys.push({ workflow: a.workflow, approvedWasmSha256: a.approvedWasmSha256, registry: a.registry });
        satisfiedAfter.add("deploy-cre-private");
        return { workflowId: "wf_live_0001", registry: a.registry, status: "PAUSED", binaryHash: opts.creDeployedBinaryHash ?? creArtifact().binaryHash };
      },
      async lifecycle(a) {
        satisfiedAfter.add("pause-cre");
        const status = creStatuses[Math.min(creStatusIdx++, creStatuses.length - 1)]!;
        return { status, detail: { workflow: a.workflow, action: a.action } };
      },
      async authValid() { return opts.creAuthValid ?? true; },
    },

    image: {
      async build() { satisfiedAfter.add("build-runtime-image"); return { imageDigest: `sha256:${sha256Hex("guardian-image-v1")}` }; },
      async scan(d) {
        if (opts.imageScanPromotable !== false) satisfiedAfter.add("scan-runtime-image");
        return opts.imageScanPromotable === false
          ? { promotable: false, detail: `IMAGE-VULNERABILITY-GATE-FAILED: ${d} has 1 unaccepted CRITICAL finding` }
          : { promotable: true, detail: `scanned ${d}: 0 findings at or above the blocking severity` };
      },
      async publish() { satisfiedAfter.add("publish-runtime-image"); return { published: true as const }; },
      async createDisabled(a) { satisfiedAfter.add("create-runtime-disabled"); return { revisionId: `rev_${a.imageDigest.slice(7, 15)}` }; },
    },
  };

  /* `sendTransaction` needs to know which step it is serving. The orchestrator executes exactly one
   * step at a time — deliberately, so a nonce cannot be raced — which makes a module-scoped cursor
   * correct here and would make it wrong the moment that changed. */
  let currentStepId = "";
  const orchestrator = new DeploymentOrchestrator(deps);
  const origExecute = orchestrator.executeStep.bind(orchestrator);
  orchestrator.executeStep = async (run, step, m) => { currentStepId = step.id; return origExecute(run, step, m); };

  const run = orchestrator.newRun("dep_0001", plan);
  return { orchestrator, run, manifest, deps, sends, creDeploys, observations, now };
}

export function imageArtifact(over: Partial<RuntimeImageArtifact> = {}): RuntimeImageArtifact {
  return {
    agentId: "guardian",
    tag: "contextlock/agent-runtime:guardian-2",
    imageDigest: `sha256:${sha256Hex("guardian-image-v1")}`,
    baseImageDigest: `sha256:${sha256Hex("node22-slim-base")}`,
    sbomDigest: `sha256:${sha256Hex("sbom-v1")}`,
    sbomFormat: "spdx-json",
    provenanceDigest: `sha256:${sha256Hex("provenance-v1")}`,
    provenanceFormat: "in-toto/slsa-provenance-v0.2",
    vulnerabilityReportDigest: `sha256:${sha256Hex("vuln-v1")}`,
    labels: {
      "org.opencontainers.image.revision": "c8849a08c44ff56308330199cf9de43dd76544eb",
      "org.opencontainers.image.created": "2026-09-10T00:00:00Z",
      "com.contextlock.build-id": "bld_0001",
      "com.contextlock.blueprint-hash": `sha256:${sha256Hex("blueprint-v3")}`,
      "com.contextlock.strategy-hash": `sha256:${sha256Hex("strategy-v3")}`,
      "com.contextlock.agent-id": "guardian",
    },
    runsAsUser: "contextlock",
    runsAsRoot: false,
    builtAtMs: NOW,
    attestationMethod: "BUILDKIT_INTOTO_OCI",
    ...over,
  };
}

export function vulnReport(over: Partial<VulnerabilityReport> = {}): VulnerabilityReport {
  return {
    scanner: "syft+grype",
    scannerVersion: "1.0.0",
    scannedAtMs: NOW,
    imageDigest: `sha256:${sha256Hex("guardian-image-v1")}`,
    counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 2, LOW: 5, NEGLIGIBLE: 0, UNKNOWN: 0 },
    findings: [],
    ran: true,
    unavailableReason: null,
    ...over,
  };
}

export const TIMEOUT = new RpcError("TIMEOUT", "socket hang up after send");
export const REJECTED = new Error("user rejected the request");
