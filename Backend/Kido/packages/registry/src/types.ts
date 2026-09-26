import type { ChainId } from "@kido/blueprint";

export type ProviderKind = "identity" | "privacy" | "protocol" | "transport" | "data" | "authority";

/** Closed capability vocabularies per kind (bible §11.1, §24.2, §27.1). */
export const CAPABILITIES = {
  identity: ["RESOLVE", "REVERSE_RESOLVE", "REGISTER", "SUBNAME", "TEXT_RECORDS", "ADDRESS_RECORD", "SCOPED_RECORD_MANAGER", "REVOKE", "EXPIRY"],
  privacy: ["SECRET_STORAGE", "SECRET_ACCESS_CONTROL", "PRIVATE_API_ACCESS", "CONFIDENTIAL_COMPUTE", "VERIFIABLE_COMPUTE", "ENCRYPTED_STATE", "DECISION_ONLY_OUTPUT"],
  protocol: ["LENDING_POSITION_STATE", "LENDING_REPAY", "LENDING_SUPPLY", "DEX_QUOTE", "DEX_SWAP", "DEX_POOL_STATE", "PAYMENT"],
  transport: ["TOKEN_TRANSFER", "MESSAGE", "DELIVERY_PROOF"],
  data: ["RPC_STATE", "PRICE_FEED", "INDEXED_HISTORY"],
  authority: ["BOUNDED_EXECUTION", "LEASES", "PAUSE", "REVOKE", "RECOVERY_WITHDRAWAL"],
} as const satisfies Record<ProviderKind, readonly string[]>;

/** NOT_SHIPPED: documented and planned, but the execution adapter it needs does not exist yet. */
export type ProviderStatus = "VERIFIED_LIVE" | "VERIFIED_DOCS" | "UNVERIFIED" | "MOCK_ONLY" | "BLOCKED_ENV" | "NOT_SHIPPED";

/**
 * What has actually been proven for an integration, separate from how well its facts are researched.
 * Never collapse SIMULATED into TESTNET_LIVE, or IMPLEMENTED_LOCAL into LIVE_ATTESTED.
 */
export type ImplementationStatus =
  | "NOT_IMPLEMENTED"
  | "IMPLEMENTED_LOCAL"
  | "SIMULATED"
  | "TESTNET_LIVE"
  | "LIVE_ATTESTED"
  | "BLOCKED_ENV"
  | "BLOCKED_AUTH"
  | "BLOCKED_UPSTREAM";

/** What each status means, stated once so agents, reports and graders read the same definitions. */
export const IMPLEMENTATION_STATUS_MEANING: Record<ImplementationStatus, string> = {
  NOT_IMPLEMENTED: "not built; nothing about it may be claimed",
  IMPLEMENTED_LOCAL: "built and tested locally (unit or local-chain tests); not live on a testnet, not attested, and not a simulated stand-in",
  SIMULATED: "exercised only through a simulator or mock; never presented as live or verified",
  TESTNET_LIVE: "proven by live runs on a public testnet, with evidence",
  LIVE_ATTESTED: "live with hardware or protocol attestation verified",
  BLOCKED_ENV: "cannot run here until a missing environment prerequisite exists",
  BLOCKED_AUTH: "cannot run until an interactive authentication step is completed by the operator",
  BLOCKED_UPSTREAM: "cannot run until an upstream dependency changes",
};

export interface Implementation {
  status: ImplementationStatus;
  /** Claims backed by evidence (tests, live runs). */
  proven: string[];
  /** Claims that must not be made yet. */
  notProven: string[];
  /** Things this provider does not do at all, stated so no one infers them. */
  doesNotProvide?: string[];
  blocker?: { type: "BLOCKED_ENV" | "BLOCKED_AUTH" | "BLOCKED_UPSTREAM"; actionRequired: string; evidence: string };
  /** Per-capability status where it differs (e.g. resolve live, register blocked). */
  capabilities?: Record<string, ImplementationStatus>;
  /** Free-form structured facts (e.g. { liveReceiver: true, liveWorkflow: false }). */
  facts?: Record<string, boolean | string>;
  evidence: string[];
}

export const LIVE_IMPLEMENTATION: ImplementationStatus[] = ["TESTNET_LIVE", "LIVE_ATTESTED"];

export interface TrustProfile {
  providerId: string;
  protects: string[];
  verifies: string[];
  requiresTrustIn: string[];
  doesNotProtectAgainst: string[];
  version: string;
  sourceRefs: string[];
}

export interface ProviderManifest {
  schemaVersion: "kido.provider/v1";
  providerId: string;
  displayName: string;
  /** Words a user may use to name this provider ("Aave", "Uniswap"). */
  aliases: string[];
  kind: ProviderKind;
  category: string;
  chains: ChainId[];
  capabilities: string[];
  version: string;
  sdk: { package: string; version: string }[];
  deployments: Partial<Record<ChainId, Record<string, string>>>;
  trust: TrustProfile;
  failureModes: string[];
  limitations: string[];
  sources: { url: string; retrieved: string }[];
  status: ProviderStatus;
  /** What Kido has proven about its own integration with this provider. */
  implementation: Implementation;
  /** Why the status is what it is, e.g. which environment a live test needs. */
  statusNote: string;
  /** Capabilities whose live status differs from the provider's (e.g. resolve live, register blocked). */
  capabilityStatus?: Record<string, { status: ProviderStatus; note: string }>;
  knowledgePack: string;
  /** Provider-specific operating parameters (e.g. a threshold), kept as data rather than code. */
  parameters?: Record<string, string | number>;
  /** Authority providers: repository path of the deployment manifest the runtime reads addresses from. */
  deploymentManifestRef?: string;
  /** Privacy providers: audiences that can see a protected value in plaintext at this provider. */
  plaintextVisibleTo?: string[];
  /** Maps semantic actions to the adapter that executes them when Amane authority is selected. */
  execution?: { action: string; capability: string; adapter: string; amaneAdapter: string | null; shipped: boolean }[];
}

export interface AssetEntry {
  symbol: string;
  chain: ChainId;
  ref: string;
  decimals: number;
  testnetOnly: boolean;
  economicClass: string;
  note: string;
  /** Providers whose actions can spend this asset on this chain. */
  usableWith: string[];
  /** Debt token a lending provider's REPAY reduces for this asset (provider id → token ref). */
  debtTokens?: Record<string, string>;
}
