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
export type PlannedBinding = { providerId: string; chain: ChainId; name: string; parent?: string; label?: string } & Record<string, unknown>;
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
export interface Health { ok: boolean; interviewModel: 'rule' | 'openai'; simulationSigners: boolean }
