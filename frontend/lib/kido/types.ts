/**
 * Response shapes of the Kido API (Backend/Kido/apps/kido). They mirror the backend types; fields a
 * screen does not use are left loose rather than restated.
 */

export type ChainId = 'ethereum-sepolia' | 'sui-testnet' | string;
export type ProjectStage = 'INTERVIEW' | 'BLUEPRINT' | 'REVIEWED' | 'SIMULATED' | 'BUILT';
export type Freshness = 'CURRENT' | 'STALE' | 'NONE';

export interface Choice { value: string; label: string }
export interface Question { key: string; topic: string; text: string; choices?: Choice[]; reask: boolean }
export interface TranscriptEntry { role: 'user' | 'kido'; text: string; key?: string }
export interface Requirement { key: string; topic: string; critical: boolean; status: 'UNKNOWN' | 'RESOLVED' | 'UNSATISFIABLE' | 'NOT_APPLICABLE'; value: unknown; confirmed: boolean }

export interface LimitSpec { chain: ChainId; asset: string; perAction: string; perWindow: string; windowSeconds: number; total: string }
export interface PayeeSpec { label: string; chain: ChainId; address: string }
export interface MonitorSpec { id: string; dataSource: string; metric: string; op: string; threshold: string | null; thresholdPrivateRef: string | null; response: string; action: string | null; target: { asset: string; share: string } | null }
export interface Blueprint {
  schemaVersion: string;
  projectId: string;
  kidoAgentId: string;
  revision: number;
  parentRevisionHash: string | null;
  objective: { statement: string; summary: string | null };
  chains: ChainId[];
  identity: { public: boolean | null; bindings: { provider: 'ens' | 'suins'; chain: ChainId; name: string | null; status: string }[] } & Record<string, unknown>;
  protocols: Array<{ providerId: string; chain: ChainId } & Record<string, unknown>>;
  assets: Array<Record<string, unknown>>;
  dataSources: Array<Record<string, unknown>>;
  privacy: { required: boolean | null; values: Array<Record<string, unknown>>; providers: Array<{ providerId: string; chain: ChainId; capabilities: string[]; satisfies: string[] }> } & Record<string, unknown>;
  authority: {
    mode: string | null;
    provider: 'AMANE' | 'OWNER_WALLET' | null;
    autonomy: string | null;
    allowedActions: string[];
    forbiddenActions: string[];
    limits: LimitSpec[];
    payees: PayeeSpec[];
    beneficiaries: PayeeSpec[];
    bridgeAllowed: boolean | null;
    leaseLifetimeSeconds: number;
    swapFloors: Array<{ chain: ChainId; assetIn: string; assetOut: string; minOutPerIn: string }>;
  } & Record<string, unknown>;
  monitors: MonitorSpec[];
  triggers: Array<{ id: string; kind: string; monitor: string | null }>;
  actions: Array<{ action: string; chain: ChainId; providerId: string; deterministic: boolean }>;
  agents: Array<{ role: string; owns: string[]; mayRequest: string[]; knowledgePacks: string[] }>;
  recovery: Record<string, unknown>;
  crossChain?: Record<string, unknown>;
  simulationScenarios: Array<Record<string, unknown>>;
  securityAssertions: Array<Record<string, unknown>>;
  deployment: { environment: 'testnet'; chains: ChainId[] };
}

export interface Blocker { code: string; detail: string }
export interface SecurityFinding { id: string; class: string; severity: string; evidence: string; blocking: boolean }
export interface SecurityReport { blueprintRevision: number; findings: SecurityFinding[]; blocking: boolean; generatedAt: number; freshness: Freshness }
export interface ScenarioResult { id: string; family: string; expected: string; actual: string; code: string | null; passed: boolean; note: string }
export interface SimulationReport { blueprintRevision: number; results: ScenarioResult[]; passed: boolean; generatedAt: number; freshness: Freshness }
export type PlannedBinding = { providerId: string; chain: ChainId; name: string; parent?: string; label?: string; role?: string; liveCapable?: boolean; blockers?: string[]; records?: Record<string, string> } & Record<string, unknown>;
export interface BuildArtifact {
  blueprintRevision: number;
  buildRevision: number;
  agents: { role: string; knowledgePacks: string[]; contextChars: number; missingPacks: string[] }[];
  monitors: string[];
  authority: { mode: string | null; provider: string | null; crossChainTotal: Record<string, string>; excludedActions: string[] };
  identity: PlannedBinding[];
  privacy: Record<string, unknown>;
  generatedAt: number;
  freshness: Freshness;
}

export interface ProjectRow {
  projectId: string;
  name: string;
  objective: string;
  createdAt: number;
  stage: ProjectStage;
  revision: number | null;
  kidoAgentId: string | null;
  chains: ChainId[];
  agents: string[];
}

export interface ProjectSummary extends ProjectRow {
  interview: { question: Question | null; transcript: TranscriptEntry[]; warnings: string[]; questionsAsked: number; requirements: Requirement[]; unresolved: unknown };
  blueprint: Blueprint | null;
  blueprintHash: string | null;
  blockers: Blocker[];
  privacyPlan: Record<string, unknown> | null;
  identityPlan: PlannedBinding[];
  security: SecurityReport | null;
  simulation: SimulationReport | null;
  build: BuildArtifact | null;
}

export interface Implementation { status: string; proven: string[]; notProven: string[]; doesNotProvide?: string[]; blocker?: { type: string; actionRequired: string; evidence: string }; evidence: string[] }
export interface ProviderRow { providerId: string; kind: string; chains: ChainId[]; status: string; statusNote?: string; capabilityStatus: Record<string, string>; implementation: Implementation }

export interface ProviderState { providerId: string; role: string; status: string; statusMeaning: string; live: boolean; proven: string[]; notProven: string[]; doesNotProvide: string[]; blocker: string | null }
export interface SelfModel {
  kidoAgentId: string;
  objective: string;
  blueprint: { revision: number; hash: string };
  chains: ChainId[];
  allowedActions: string[];
  forbiddenActions: string[];
  providers: ProviderState[];
  execution: Array<{ action: string; chain: ChainId; providerId: string; providerVersion: string; adapter: { name: string; version: number } | null; upstream: Record<string, unknown>; enforcement: string[] }>;
  authority: { mode: string | null; amaneActive: boolean; limits: Array<LimitSpec & { readable?: string }>; payees: PayeeSpec[]; beneficiaries: PayeeSpec[]; lease: unknown };
  capabilitiesNotAvailable: string[];
  failureBehaviour: Record<string, string>;
  monitors: Array<{ id: string; metric: string; op: string; threshold: string; response: string; action: string | null; health: string }>;
  privacy: { required: boolean | null; protectedInputs: Array<{ id: string; kind: string; hiddenFrom: string[]; plaintextMayExistIn: string; mayLeave: string; protectedBy: string[] }> };
  identity: Array<{ provider: string; chain: ChainId; name: string | null; status: string }>;
  upstreamChangePolicy: string;
}
export interface Introspection { question: string; topics: string[]; facts: Record<string, unknown>; known: boolean }
export interface Health { ok: boolean; interviewModel: 'rule' | 'openai'; simulationSigners: boolean; chatModel?: boolean }

export interface TxRequest { chainId: number; to?: `0x${string}`; data: `0x${string}`; label: string }
export interface TypedDataWire { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }
export interface DeploymentChain { account?: string; deployTx?: string; install?: string; activate?: string }
export interface DeploymentWire {
  status: 'STARTED' | 'ACCOUNTS_READY' | 'POLICY_SIGNED' | 'ACTIVE';
  owner: `0x${string}`;
  accountId: `0x${string}`;
  blueprintRevision: number;
  issuer: `0x${string}`;
  agent: `0x${string}`;
  chains: Record<string, DeploymentChain>;
  leaseId?: `0x${string}`;
}
export interface ProjectEvent { at: number; type: string; chain?: string; detail: string; tx?: string }
export interface DeploymentStatus { deployment: DeploymentWire | null; events: ProjectEvent[]; issuerConfigured: boolean; suiRelayer: boolean; evmRpc: boolean }
export interface RuntimeChain { chain: string; account: string | null; policyVersion: number | null; paused: boolean | null; pauseEpoch: number | null; leaseStatus: number | null; balances: { symbol: string; amount: string; decimals: number }[]; error: string | null }
export interface Runtime { deployed: boolean; status: DeploymentWire['status'] | null; accountId?: string; owner?: string; leaseId?: string | null; chains: RuntimeChain[] }
export interface ControlMessage { chain: string; primaryType: string; message: Record<string, unknown>; typedData: TypedDataWire }

export type LabLayer = 'KIDO_VALIDATOR' | 'KIDO_COMPILER' | 'AMANE_RULES' | 'NONE';
export interface LabVerdict { verdict: 'ALLOW' | 'REJECT'; code: string | null; detail: string; layer: LabLayer; intent?: Record<string, string | number> }
export interface WhatIf { chain: ChainId; action: string; asset: string; assetOut?: string | null; amount: string; recipient: string | null; atSecondsFromNow?: number }
export interface InjectionResult { stages: { layer: string; outcome: 'PASSED' | 'REFUSED'; reason: string }[]; verdict: LabVerdict }
export interface ChatAnswer { answer: string; toolCalls: number; model: string }
export interface RealityProbe { chain: ChainId; label: string; ref: string; ok: boolean; detail: string }
export interface Reality {
  heads: { chain: ChainId; head: string | null; error: string | null }[];
  probes: RealityProbe[];
  refusals: { chain: ChainId; probe: string; refused: boolean; detail: string }[];
  deployed: boolean;
  accounts: Record<string, string | null>;
}

export interface Holding { symbol: string; ref: string; decimals: number; economicClass: string; amount: string; reserved: string; quarantined: string; usdNominal: number | null }
export interface PortfolioChain { chain: ChainId; account: string; holdings: Holding[]; budget: { symbol: string; decimals: number; total: string; perAction: string; spent: string }[]; error: string | null }
export interface LendingPosition { protocol: string; chain: ChainId; label: string; address: string; collateralUsd?: number; debtUsd?: number; healthFactor?: number | null; liquidationThresholdPct?: number; debtAsset?: string; monitor?: { id: string; metric: string; op: string; threshold: string | null; private: boolean } | null; block?: string; error?: string }
export interface Portfolio {
  deployed: boolean;
  status: DeploymentWire['status'] | null;
  accountId: string | null;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  chains: PortfolioChain[];
  owner: { chain: ChainId; address: string; native: { symbol: string; amount: string; decimals: number } | null; holdings: Holding[] } | null;
  positions: LendingPosition[];
  readAt: number;
}
