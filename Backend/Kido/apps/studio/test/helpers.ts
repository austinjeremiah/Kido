import { openStudioDb, type DB } from "../src/db.js";
import type { PipelineDeps } from "../src/pipeline.js";
import type { Requirements, ArchitectureChoice, SecurityReview, FinalReview } from "../src/agents/roles.js";

/** In-memory DB so tests are isolated, fast, and leave nothing behind. */
export function testDb(): DB {
  return openStudioDb(":memory:");
}

const usage = (i = 100, o = 50) => ({ requests: 1, inputTokens: i, outputTokens: o, totalTokens: i + o });

/**
 * Scripted agents.
 *
 * Tests that spend real model tokens are slow, non-deterministic and expensive, and they test the
 * model rather than the pipeline. The real model is exercised separately by the end-to-end demo,
 * whose output is recorded as evidence; these fakes exist so the pipeline's own logic — quota,
 * ordering, gating, staleness — is tested deterministically.
 */
export function scriptedAgents(over: Partial<{
  requirements: Requirements;
  architecture: ArchitectureChoice;
  security: SecurityReview;
  reviewer: FinalReview;
  failOn: "requirements" | "architecture" | "security" | "reviewer";
  error: Error;
}> = {}): NonNullable<PipelineDeps["agents"]> {
  const requirements: Requirements = over.requirements ?? {
    objective: "Protect an Aave position from liquidation.",
    protocols: ["Aave"],
    assets: ["USDC"],
    allowedActions: ["repay debt", "add collateral"],
    forbiddenActions: ["withdraw collateral"],
    autonomousLimitUsd: { known: true, value: 1000, sourceQuote: "Repay up to $1,000 automatically" },
    escalationFloorUsd: { known: true, value: 1000, sourceQuote: "$1,000-$5,000 requires Ledger" },
    escalationCeilingUsd: { known: true, value: 5000, sourceQuote: "$1,000-$5,000 requires Ledger" },
    escalationMechanism: "ledger-device",
    privateConditions: ["health factor floor"],
    contextDependencies: ["position health", "collateral price"],
    triggers: ["health factor below the confidential floor"],
    deploymentNetwork: "sepolia",
    unknowns: [],
  };

  const architecture: ArchitectureChoice = over.architecture ?? {
    agentId: "aave-guardian",
    ensName: "guardian.test.eth",
    objective: "Protect an Aave position from liquidation.",
    requiredModules: [
      "contextlock-core", "ens-identity", "cre-confidential-policy",
      "ledger-keyring", "ledger-escalation", "protocol-adapter", "agent-runtime", "tests",
    ],
    allowedPermissions: [
      { statement: "repay outstanding debt", actionRef: "repay-debt" },
      { statement: "add collateral", actionRef: "add-collateral" },
    ],
    deniedPermissions: ["withdraw collateral", "arbitrary transfer", "arbitrary token approval"],
    confidentialParameterNames: ["healthFactorFloorBps", "autoRepayLimitUsdCents"],
    capabilityTtlSeconds: 45,
    dataRequirements: [],
    requiredExecutionCapabilities: [],
    rationale: "Composes the audited ContextLock modules.",
  };

  const security: SecurityReview = over.security ?? { findings: [], modelOpinion: "No additional findings." };

  const reviewer: FinalReview = over.reviewer ?? {
    readiness: "EXPORT_READY",
    summary: "Matches the request.",
    discrepancies: [],
    honestyCheck: {
      claimsHardwareEvidence: false,
      claimsLiveCreDeployment: false,
      claimsTeeExecution: false,
      exposesConfidentialValues: false,
    },
  };

  const maybeFail = (role: string) => {
    if (over.failOn === role) throw over.error ?? new Error(`scripted failure in ${role}`);
  };

  return {
    requirements: async () => { maybeFail("requirements"); return { output: requirements, usage: usage(850, 470), runId: "run_req" }; },
    architecture: async () => { maybeFail("architecture"); return { output: architecture, usage: usage(960, 520), runId: "run_arch" }; },
    security: async () => { maybeFail("security"); return { output: security, usage: usage(3000, 1800), runId: "run_sec" }; },
    reviewer: async () => { maybeFail("reviewer"); return { output: reviewer, usage: usage(4100, 860), runId: "run_rev" }; },
  };
}

/**
 * A sandbox provider that records what it was asked to do without starting a container.
 *
 * Used only where the test is about pipeline behaviour rather than isolation. The tests that assert
 * isolation (STUDIO-012, STUDIO-032) use the REAL Docker provider, because a fake sandbox proves
 * nothing about sandboxing.
 */
export class RecordingSandbox {
  readonly id = "sbx_test";
  readonly provider = "recording";
  readonly files = new Map<string, string>();
  readonly commands: string[] = [];
  constructor(private readonly execResult: (cmd: string) => { stdout: string; exitCode: number } = () => ({ stdout: "", exitCode: 0 })) {}
  async exec(cmd: string) {
    this.commands.push(cmd);
    const r = this.execResult(cmd);
    return { stdout: r.stdout, stderr: "", exitCode: r.exitCode, wallTimeSeconds: 0 };
  }
  async writeFile(path: string, content: string) { this.files.set(path, content); }
  async readFile(path: string) { return this.files.get(path) ?? ""; }
  async listFiles() { return [...this.files.keys()].map((p) => ({ path: p, type: "file" as const })); }
  async destroy() {}
}
