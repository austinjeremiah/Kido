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

export type ProviderStatus = "VERIFIED_LIVE" | "VERIFIED_DOCS" | "UNVERIFIED" | "MOCK_ONLY" | "BLOCKED_ENV";

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
  /** Why the status is what it is, e.g. which environment a live test needs. */
  statusNote: string;
  knowledgePack: string;
  /** Maps semantic actions to the adapter that executes them when Amane authority is selected. */
  execution?: { action: string; adapter: string; amaneAdapter: string | null; shipped: boolean }[];
}

export interface AssetEntry {
  symbol: string;
  chain: ChainId;
  ref: string;
  decimals: number;
  testnetOnly: boolean;
  economicClass: string;
  note: string;
}
