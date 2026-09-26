/**
 * The Testnet Lab API client.
 *
 * Thin by design. Every value a Lab screen renders is computed by the backend and returned whole;
 * this file transports it and nothing else.
 *
 * That is not a style preference. §P28.6 says *Luna may explain these rules, Luna does not decide
 * them* — and the same applies to the browser. A client that derived "denied", or composed a
 * capability sentence, or decided a source was healthy, would be making a security claim about what
 * the frontend believes. `PRODUCT-005` through `PRODUCT-007` assert there is nothing here to forge.
 */

/**
 * A failed Lab request, carrying the status.
 *
 * The status matters to a screen. A 404 from these routes usually means *this project does not have
 * that yet* — no compiled Blueprint, no recorded shadow run — which is a normal state with a normal
 * explanation, not a fault. A 500 is a fault. Rendering both as the same red box teaches a user to
 * ignore the red box.
 */
export class LabApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LabApiError";
  }
  /** True when the project simply has nothing of this kind, rather than something being wrong. */
  get isAbsent(): boolean {
    return this.status === 404;
  }
}

const j = async <T>(r: Response): Promise<T> => {
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string; detail?: unknown };
    throw new LabApiError(body.error ?? `${r.status} ${r.statusText}`, r.status);
  }
  return r.json() as Promise<T>;
};

/* ─────────────────────────── the lifecycle ─────────────────────────── */

export type LabProjectState =
  | "DRAFT" | "ARCHITECTURE_READY" | "REVIEW_REQUIRED" | "BUILDING" | "BUILD_READY"
  | "SIMULATION_READY" | "PREFLIGHT_REQUIRED" | "READY_TO_DEPLOY" | "DEPLOYING"
  | "READY_TO_ACTIVATE" | "LAB_ACTIVE" | "PAUSED" | "EMERGENCY_LOCKED" | "DEGRADED" | "FAILED";

export interface LabStateView {
  projectId: string;
  state: LabProjectState;
  because: string;
  hasFinancialAuthority: boolean;
  nextAction: string | null;
  degradedDependencies: string[];
  label: { headline: string; detail: string };
  headlineClaim: string;
  mode: {
    mode: string;
    execution: { networks: Array<{ chainId: number; name: string; role: string }>; summary: string };
    mainnet: { access: string; summary: string };
    cre: { default: string; summary: string };
    financialPolicy: { owner: string; summary: string };
    runtime: { isolation: string; summary: string };
    monitoring: { owner: string; summary: string };
    productionChainExecution: string;
  };
  /** The inputs the state was computed from, so a reader can check the answer rather than trust it. */
  computedFrom: Record<string, unknown>;
}

/* ─────────────────────────── summary & permissions ─────────────────────────── */

export interface CapabilityLine { kind: "CAN" | "CANNOT"; statement: string; derivedFrom: string }

export interface NetworkBadge {
  chainId: number; name: string; role: string; roleLabel: string;
  purpose: "MARKET_SOURCE" | "EXECUTION_TARGET";
}

export interface LabSummaryView {
  summary: {
    name: string; goal: string;
    execution: NetworkBadge extends never ? never : { chainId: number; name: string; role: string; label: string };
    realityData: { chainId: number; name: string; role: string; label: string } | null;
    protocols: string[]; verifiedMarketData: string[];
    cre: { required: boolean; mode: string };
    autonomous: string; humanApproval: string; hardDeny: string;
    forbidden: string[]; blueprintRevision: number;
    /**
     * §P28.57's second half. A per-action entry may only ever tighten the global limits, so a row
     * here is always narrower than the pair above it — never wider.
     */
    perActionLimits: Array<{
      action: string; autonomous: string; humanApproval: string; hardDeny: string; sourceQuote: string;
    }>;
  };
  capabilities: CapabilityLine[];
  unestablishedBoundaries: string[];
  networks: { marketSource: NetworkBadge; executionTarget: NetworkBadge };
}

/* ─────────────────────────── reality ─────────────────────────── */

export interface RealityMode {
  mode: "LIVE_MAINNET_MIRROR" | "HISTORICAL_REPLAY" | "LOCAL_MAINNET_FORK" | "SYNTHETIC";
  label: string;
  availability: "AVAILABLE" | "LIMITED" | "BLOCKED";
  reason: string | null;
  blocker: string | null;
  remedy: string | null;
  effect: string | null;
}

export interface SourceStatus {
  sourceId: string; displayName: string;
  status: "HEALTHY" | "STALE" | "UNAVAILABLE" | "NOT_CONFIGURED";
  reason: string | null; effect: string | null; securityImpact: string | null;
  blocker: string | null; tone: "GREEN" | "AMBER" | "GREY";
}

export interface RealityView {
  modes: RealityMode[];
  sources: SourceStatus[];
  networks: { marketSource: NetworkBadge; executionTarget: NetworkBadge };
}

/* ─────────────────────────── CRE ─────────────────────────── */

export interface CreView {
  status: {
    mode: string; executionMode: string; account: string; organizationId: string | null;
    workflowBinary: string | null; productionLimits: string;
    donDeployment: "YES" | "NO"; hardwareTee: "YES" | "NO"; teeAttestation: "YES" | "NO";
    deployAccess: string; registries: string[];
  };
  connection: {
    connected: boolean; organizationId: string | null; organizationName: string | null;
    deployAccess: boolean | null; registries: string[]; cliVersion: string | null;
    credentialLocation: string;
  };
  promotion: { available: boolean; reason: string; message: string; blocker: string | null };
}

/* ─────────────────────────── deploy ─────────────────────────── */

export interface DeployGate {
  label: string; status: "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN"; detail: string; blocker: string | null;
}

export interface DeployView {
  readiness: {
    gates: DeployGate[]; canDeploy: boolean; blockedBy: string[];
    executionNetwork: { chainId: number; name: string; role: string };
    /* Literals, because the backend returns literals — widening them here would let a client render
     * a value the API cannot produce. */
    mainnetWrites: "PROHIBITED"; policyInitialState: "DISABLED";
  };
  phases: ReadonlyArray<{ key: string; label: string }>;
  controlSemantics: Record<string, { label: string; kind: string; effect: string; doesNot: string }>;
}

/* ─────────────────────────── attacks ─────────────────────────── */

export interface SecurityPathStep {
  layer: string;
  outcome: "PASS" | "DENY" | "NOT_REACHED" | "NOT_APPLICABLE";
  reasonCode: string | null;
  detail: string | null;
}

export interface MutationDiff { field: string; original: string; mutated: string }

export interface AttackRun {
  scenario: string; title: string;
  result: "DENIED" | "ALLOWED" | "NOT_RUN";
  stoppedBy: string | null; reasonCode: string | null; stoppedWhereExpected: boolean;
  diffs: MutationDiff[]; path: SecurityPathStep[];
  capabilityIssued: boolean; transactionSubmitted: boolean;
  additionalDefenses: Array<{ layer: string; reasonCode: string }>;
}

export interface AttackDefinition {
  scenario: string; title: string; description: string;
  mutatedField: string | null; expectedStoppedBy: string; expectedReasonCode: string;
}

export interface AttackCatalogue {
  applicable: AttackDefinition[];
  notApplicable: Array<{ scenario: string; title: string; requires: string }>;
}

/* ─────────────────────────── safety report ─────────────────────────── */

export interface PrivacyClaim {
  claim: string; answer: "VERIFIED" | "NO" | "NOT_ESTABLISHED";
  evidence: string | null; blocker: string | null;
}

export interface SafetyReportView {
  schemaVersion: string; reportId: string; generatedAtMs: number;
  agent: { goal: string; ensIdentity: string | null; blueprintHash: string; strategyHash: string; blueprintRevision: number };
  execution: { networks: Array<{ chainId: number; name: string; role: string }>; productionChainExecution: string; productionWriteEvidence: string[] };
  reality: {
    sources: Array<{ sourceId: string; kind: string; trustClass: string; status: string; blocker: string | null }>;
    chainlinkSource: string | null; theGraphState: string; archiveReplayState: string;
    marketSnapshotHash: string | null; anchorBlock: string | null;
  };
  cre: { mode: string; executionMode: string; wasmHash: string | null; productionLimits: string; donDeployment: string; hardwareTee: string; teeAttestation: string; deployAccess: string };
  runtime: { imageDigest: string | null; adapterVersions: string[] };
  testing: { securitySimulations: { passed: number; total: number }; attacks: Array<{ scenario: string; result: string; stoppedBy: string | null; reasonCode: string | null }> };
  deployments: Array<{ name: string; address: string; chainId: number; txHash: string; explorerUrl: string | null }>;
  privacy: PrivacyClaim[];
  knownBlockers: Array<{ id: string; effect: string }>;
  reportHash: string;
}

/** The public view carries a strict subset. Built by the backend from an allow-list, not filtered. */
export type PublicSafetyView = Pick<SafetyReportView, "schemaVersion" | "reportId" | "testing" | "privacy" | "reportHash"> & {
  agent: Pick<SafetyReportView["agent"], "goal" | "ensIdentity" | "blueprintHash">;
  execution: Pick<SafetyReportView["execution"], "networks" | "productionChainExecution">;
  cre: { mode: string; donDeployment: string; hardwareTee: string };
};


/* ─────────────────────────── the simulation center ─────────────────────────── */

export interface SimulationLayerView {
  key: "SECURITY_SIMULATION" | "CRE_WORKFLOW_SIMULATION" | "REALITY_TEST" | "FORK_EXECUTION";
  title: string;
  engine: string;
  status: "PASS" | "FAIL" | "NOT_RUN" | "BLOCKED";
  passed: number | null;
  total: number | null;
  detail: string;
  proves: string;
  doesNotProve: string;
  blocker: string | null;
  optional: boolean;
}

export interface SimulationCenterView {
  layers: SimulationLayerView[];
  requiredPassed: boolean;
  outstanding: string[];
}

/* ─────────────────────────── connecting CRE ─────────────────────────── */

export interface ConnectStep {
  kind: "CONTEXTLOCK" | "LOCAL_BRIDGE" | "CRE_CLI" | "CHAINLINK_BROWSER";
  label: string;
  detail: string;
  carries: string;
  bridgeOperation: string | null;
}

export interface CreConnectView {
  flow: { steps: ConnectStep[]; neverRequested: string[]; credentialLocation: string; claim: string };
  account: {
    connected: "YES" | "NO";
    organization: string;
    deployAccess: "ENABLED" | "NOT ENABLED" | "UNKNOWN";
    registries: string[];
    simulation: "AVAILABLE" | "UNAVAILABLE";
    cliVersion: string;
    credentialLocation: string;
    note: string | null;
  };
}

export interface ParityOutcome { verdict: string; reasonCode: string; riskClass: string; publicOutput: string }
export interface ParityRow {
  fixture: string;
  description: string;
  simulator: ParityOutcome | null;
  deployed: ParityOutcome | null;
  differences: string[];
  match: boolean;
  notRun: "SIMULATOR" | "DEPLOYED" | "BOTH" | null;
}
export interface ParityView {
  result: { rows: ParityRow[]; matched: number; total: number; semanticParity: boolean; comparedFields: string[]; ignoredFields: string[] };
  deployedAvailable: boolean;
  blocker: string | null;
  note: string;
}

/* ─────────────────────────── testnet assets and activation ─────────────────────────── */

export interface TokenRequirement {
  symbol: string;
  purpose: string;
  network: string;
  source: string;
  realWorldValue: "NONE";
  automaticallyRequested: false;
}
export interface TokenRequirementsView { requirements: TokenRequirement[]; note: string }

export interface ActivationRow { label: string; value: string; status: "READY" | "NOT_READY" | "STATEMENT"; detail: string }
export interface ActivationView {
  readiness: { rows: ActivationRow[]; canActivate: boolean; blockedBy: string[]; consequence: string; buttonLabel: "ACTIVATE TESTNET AGENT" };
  state: LabProjectState;
}

/* ─────────────────────────── shadow and fork ─────────────────────────── */

export interface ShadowView {
  run: {
    watching: { chainId: number; name: string; role: "READ_ONLY_SOURCE"; roleLabel: string };
    decision: string;
    reasonCode: string;
    proposedAction: { kind: string; asset: string; amount: string; protocol: string };
    actualExecution: { environment: "LOCAL_FORK" | "TESTNET" | "NONE"; label: string; chainId: number | null };
    /** A literal, deliberately. There is no response shape that reports a mainnet transaction. */
    publicMainnetTransaction: "NONE";
    marketSnapshotHash: string;
    scenarioHash: string | null;
  };
  fork: {
    heading: "LOCAL MAINNET FORK";
    sourceChain: string;
    sourceBlock: string;
    sourceBlockHash: string;
    protocol: string;
    input: string;
    output: string;
    transactionHash: string;
    transaction: string;
    publicExplorer: "NONE";
    explorerNote: string;
    status: "success" | "reverted";
    gasUsed: string;
    impersonated: boolean;
  };
}

/* ─────────────────────────── market shocks ─────────────────────────── */

export interface ShockPreset {
  overlayId: string;
  name: string;
  description: string;
  mutates: string[];
  applicable: boolean;
  unavailableReason: string | null;
  label: "SYNTHETIC OVERLAY";
  trustClass: string;
}
export interface ComparisonRow {
  label: string;
  scenario: string;
  synthetic: boolean;
  verdict: string;
  reasonCode: string;
  snapshotHash: string;
  scenarioHash: string | null;
  changedFromBase: string | null;
}
export interface ScenarioView {
  presets: ShockPreset[];
  rows: ComparisonRow[];
  action: string;
  basis: { fromSnapshot: string[]; neutralised: string[]; action: string };
  baseValuedAt: string | null;
  anchorBlock: string;
}

/* ─────────────────────────── why did it act ─────────────────────────── */

export interface DecisionDetailView {
  correlationId: string;
  verdict: "ALLOW" | "ESCALATE" | "DENY" | "NO_ACTION";
  reasonCode: string;
  reasonPlain: string;
  fields: Array<{ label: string; value: string; source: string }>;
  withheld: Array<{ what: string; why: string }>;
  synthetic: boolean;
}

/* ─────────────────────────── the fork lab ─────────────────────────── */

export interface CreSimulationResult {
  ran: boolean; passed: boolean; binaryHash: string | null; configHash: string | null; verdict: string;
  productionLimits: boolean; exitCode: number | null; durationMs: number; commandLine: string[];
  cliVersion: string | null; outputTail: string[]; failure: string | null;
}
export interface CreSimulationRun {
  id: string; projectId: string; buildId: string | null; blueprintRevision: number | null;
  kind: "CRE_SIMULATION"; status: "RUNNING" | "PASSED" | "FAILED"; result: Partial<CreSimulationResult>;
  startedAt: string; finishedAt: string | null;
}

export interface ForkGate { label: string; status: "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN"; detail: string; blocker: string | null }
export interface ForkPhase { key: string; status: "PENDING" | "RUNNING" | "DONE" | "FAILED"; startedAtMs: number | null; finishedAtMs: number | null; detail: string | null }
export interface ForkDeploymentView {
  deploymentId: string; projectId: string; buildId: string | null; blueprintRevision: number;
  state: "DEPLOYING" | "READY_TO_ACTIVATE" | "STOPPED" | "FAILED"; phase: string; revision: string;
  record: {
    agentId: string; ensName: string; agentIdentityHash: string; policyHash: string;
    upstream: { providerId: string; headBlock: string | null; forkBlock: string | null };
    fork: { forkId: string; chainId: 31337; sourceChainId: number; forkBlock: string; forkBlockHash: string; endpoint: string; anvilVersion: string; state: string } | null;
    contracts: Record<string, string> | null;
    roles: Record<string, string>;
    policy: { targetHealthFactorBps: number; restoreHealthFactorBps: number; minHealthFactorBps: number; allowedActionKinds: string[]; allowedTargets: string[] };
    position: { user: string; vault: string; scenarios: Array<{ driverId: string; protocol: string; actionKind: string; detail: string }>; unexercisedActionKinds: string[] } | null;
    snapshot: { snapshotId: string; anchorBlock: string; snapshotHash: string } | null;
    phases: ForkPhase[];
    setupTransactions: Array<{ label: string; hash: string; blockNumber: string; gasUsed: string; status: string; network: string }>;
    failure: string | null; stoppedReason: string | null;
  };
  live: { fork: boolean; runtime: boolean };
  createdAt: string; updatedAt: string;
}
export interface ForkReadiness {
  gates: ForkGate[]; canDeploy: boolean; blockedBy: string[];
  executionNetwork: { chainId: number; name: string; role: string; forkedFrom: number };
  mainnetWrites: "PROHIBITED"; policyInitialState: "DISABLED";
  phases: Array<{ key: string; label: string }>;
  existing: ForkDeploymentView | null;
}
export interface DriverObservation { driverId: string; protocol: string; label: string; healthBps: number | null; metrics: Record<string, number>; detail: string }
export interface TickSample {
  atMs: number; blockNumber: string; blockTimestampMs: number; healthFactorBps: number; ethUsd: number; vaultUsdc: number; vaultEth: number;
  policyEnabled: boolean; protocols: DriverObservation[];
  action: "NONE" | "PROPOSED" | "EXECUTED" | "ERROR"; verdict: string | null; reasonCode: string | null; correlationId: string | null;
}
export interface ForkDecision {
  correlationId: string; atMs: number; driverId: string; protocol: string; actionKind: string; label: string;
  verdict: "ALLOW" | "ESCALATE" | "DENY"; reasonCode: string; riskBand: string; amountUsd6: string; healthFactorBps: number | null; ethUsd: number;
  policyEnabled: boolean; basis: { fromFork: string[]; neutralised: string[] }; executed: boolean; approvedByHuman: boolean; txHashes: string[]; healthFactorAfterBps: number | null;
}
export interface ForkExecution {
  correlationId: string; atMs: number; driverId: string; label: string; amountUsd6: string; healthFactorBeforeBps: number | null; healthFactorAfterBps: number | null; approvedByHuman: boolean;
  txs: Array<{ hash: string; blockNumber: string; status: string; gasUsed: string; label: string; from: string; to: string | null }>;
}
export interface PendingEscalation { correlationId: string; driverId: string; protocol: string; label: string; amountUsd6: string; reasonCode: string; sinceMs: number; capabilityIds: string[]; expiresAtUnix: number }
export interface StressOption { id: string; label: string; kind: "health-target" | "amount" }
export interface ForkPositionView {
  deploymentId: string; policyEnabled: boolean | null; latest: TickSample | null; samples: TickSample[];
  decisions: ForkDecision[]; executions: ForkExecution[]; pending: PendingEscalation[];
  scenarios: Array<{ driverId: string; protocol: string; actionKind: string; detail: string; stressOptions: StressOption[] }>;
  unexercisedActionKinds: string[];
  runtime: { state: string; reasons: string[]; ticks: number; lastError: string | null; paused: boolean };
  policy: { targetHealthFactorBps: number; restoreHealthFactorBps: number; minHealthFactorBps: number; autoLimitUsd: number; escalationLimitUsd: number };
  vault: { address: string; usdc: number | null; eth: number | null };
  approver: { address: string; note: string };
  network: { chainId: 31337; role: "LOCAL_FORK"; forkedFrom: 1; forkBlock: string | null; label: string };
}

const F = (id: string): string => `/api/fork/projects/${encodeURIComponent(id)}`;
const FD = (id: string): string => `/api/fork/deployments/${encodeURIComponent(id)}`;
const post = (url: string, body?: unknown): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

export const forkApi = {
  readiness: (projectId: string): Promise<ForkReadiness> => fetch(`${F(projectId)}/readiness`).then(j<ForkReadiness>),
  deploy: (projectId: string, buildId: string | null): Promise<ForkDeploymentView> => post(`${F(projectId)}/deploy`, { buildId }).then(j<ForkDeploymentView>),
  list: async (projectId: string): Promise<ForkDeploymentView[]> => (await fetch(`${F(projectId)}/deployments`).then(j<{ deployments: ForkDeploymentView[] }>)).deployments,
  get: (deploymentId: string): Promise<ForkDeploymentView> => fetch(FD(deploymentId)).then(j<ForkDeploymentView>),
  position: (deploymentId: string): Promise<ForkPositionView> => fetch(`${FD(deploymentId)}/position`).then(j<ForkPositionView>),
  tick: (deploymentId: string): Promise<{ sample: TickSample | null }> => post(`${FD(deploymentId)}/tick`).then(j<{ sample: TickSample | null }>),
  stress: (deploymentId: string, driverId: string, option: string, value: number): Promise<{ before: DriverObservation; after: DriverObservation; detail: string; note: string }> =>
    post(`${FD(deploymentId)}/stress`, { driverId, option, value }).then(j<{ before: DriverObservation; after: DriverObservation; detail: string; note: string }>),
  approve: (deploymentId: string, correlationId: string): Promise<{ execution: ForkExecution; signer: string }> =>
    post(`${FD(deploymentId)}/approvals/${encodeURIComponent(correlationId)}`).then(j<{ execution: ForkExecution; signer: string }>),
  decline: (deploymentId: string, correlationId: string, reason: string): Promise<{ declined: boolean }> =>
    post(`${FD(deploymentId)}/approvals/${encodeURIComponent(correlationId)}/decline`, { reason }).then(j<{ declined: boolean }>),
  stop: (deploymentId: string): Promise<ForkDeploymentView> => post(`${FD(deploymentId)}/stop`, { reason: "stopped by the operator" }).then(j<ForkDeploymentView>),
};

/* ─────────────────────────── the client ─────────────────────────── */


const P = (id: string): string => `/api/lab/projects/${encodeURIComponent(id)}`;

export const labApi = {
  state: (id: string): Promise<LabStateView> => fetch(`${P(id)}/state`).then(j<LabStateView>),
  summary: (id: string): Promise<LabSummaryView> => fetch(`${P(id)}/summary`).then(j<LabSummaryView>),
  reality: (): Promise<RealityView> => fetch("/api/lab/reality/modes").then(j<RealityView>),
  cre: (id: string): Promise<CreView> => fetch(`${P(id)}/cre`).then(j<CreView>),
  deploy: (id: string, q: { gas?: string; balance?: string; required?: string } = {}): Promise<DeployView> => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined) as [string, string][]);
    return fetch(`${P(id)}/deploy-readiness${qs.toString() ? `?${qs}` : ""}`).then(j<DeployView>);
  },
  attacks: (id: string): Promise<AttackCatalogue> => fetch(`${P(id)}/attacks`).then(j<AttackCatalogue>),
  runAttack: (id: string, scenario: string): Promise<AttackRun> =>
    fetch(`${P(id)}/attacks/${encodeURIComponent(scenario)}/run`, { method: "POST" }).then(j<AttackRun>),
  safetyReport: (id: string): Promise<SafetyReportView> => fetch(`${P(id)}/safety-report`).then(j<SafetyReportView>),
  publicSafetyReport: (id: string): Promise<PublicSafetyView> => fetch(`${P(id)}/safety-report/public`).then(j<PublicSafetyView>),
  simulationCenter: (id: string): Promise<SimulationCenterView> => fetch(`${P(id)}/simulation-center`).then(j<SimulationCenterView>),
  creConnect: (id: string): Promise<CreConnectView> => fetch(`${P(id)}/cre/connect`).then(j<CreConnectView>),
  creSimulate: (id: string): Promise<{ run: CreSimulationRun | null; result?: CreSimulationResult; note?: string }> =>
    post(`${P(id)}/cre/simulate`).then(j<{ run: CreSimulationRun | null; result?: CreSimulationResult; note?: string }>),
  creSimulations: async (id: string): Promise<CreSimulationRun[]> => (await fetch(`${P(id)}/cre/simulations`).then(j<{ runs: CreSimulationRun[] }>)).runs,
  creParity: (id: string): Promise<ParityView> => fetch(`${P(id)}/cre/parity`).then(j<ParityView>),
  tokenRequirements: (id: string): Promise<TokenRequirementsView> => fetch(`${P(id)}/token-requirements`).then(j<TokenRequirementsView>),
  activation: (id: string): Promise<ActivationView> => fetch(`${P(id)}/activation-readiness`).then(j<ActivationView>),
  shadow: (id: string): Promise<ShadowView> => fetch(`${P(id)}/shadow`).then(j<ShadowView>),
  scenarios: (id: string): Promise<ScenarioView> => fetch(`${P(id)}/scenarios`).then(j<ScenarioView>),
  decision: (id: string, correlationId: string): Promise<DecisionDetailView> =>
    fetch(`${P(id)}/decisions/${encodeURIComponent(correlationId)}`).then(j<DecisionDetailView>),
};
