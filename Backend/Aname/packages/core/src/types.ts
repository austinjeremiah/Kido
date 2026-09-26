import type { Address, Hex } from 'viem';

export type Bytes32 = Hex;

export const ActionKind = {
  SWAP: 0,
  SUPPLY: 1,
  REPAY: 2,
  BORROW: 3,
  WITHDRAW: 4,
  STAKE: 5,
  UNSTAKE: 6,
  ADD_LIQUIDITY: 7,
  REMOVE_LIQUIDITY: 8,
  PAY: 9,
  BRIDGE: 10,
} as const;
export type ActionKindName = keyof typeof ActionKind;
export type ActionKindId = (typeof ActionKind)[ActionKindName];

export const PriceMode = { TESTNET_FIXED: 1 } as const;
export const AuthMode = { AGENT_SIGNED: 1 } as const;

export interface AssetLimit {
  assetId: Bytes32;
  maxPerAction: bigint;
  maxPerEpoch: bigint;
  maxTotal: bigint;
}

export interface AdapterRef {
  adapterId: Bytes32;
  adapterName: string;
  adapterVersion: number;
}

export interface Recipient {
  recipientId: Bytes32;
  label: string;
}

export interface SwapFloor {
  assetIn: Bytes32;
  assetOut: Bytes32;
  minOutNumerator: bigint;
  minOutDenominator: bigint;
}

export interface PolicyEndpoint {
  chainRef: Bytes32;
  account: Bytes32;
  epochSeconds: bigint;
  adapters: AdapterRef[];
  assets: AssetLimit[];
  recipients: Recipient[];
  beneficiaries: Recipient[];
  swapFloors: SwapFloor[];
  recoveryDestinations: Recipient[];
}

export interface IssuerLimit {
  chainRef: Bytes32;
  assetId: Bytes32;
  maxPerAction: bigint;
  maxPerEpoch: bigint;
  maxTotal: bigint;
}

export interface LeaseIssuer {
  issuer: Address;
  maxLeaseLifetime: bigint;
  allowedAgents: Address[];
  limits: IssuerLimit[];
}

export interface RootPolicy {
  accountId: Bytes32;
  policyVersion: bigint;
  allowedActions: number;
  priceMode: number;
  maxLeaseLifetime: bigint;
  endpoints: PolicyEndpoint[];
  leaseIssuers: LeaseIssuer[];
}

export interface LeaseEndpoint {
  chainRef: Bytes32;
  account: Bytes32;
  adapters: Bytes32[];
  assets: AssetLimit[];
  recipients: Bytes32[];
  beneficiaries: Bytes32[];
}

export interface AgentLease {
  accountId: Bytes32;
  policyVersion: bigint;
  leaseId: Bytes32;
  agent: Address;
  issuer: Address;
  validAfter: bigint;
  expiresAt: bigint;
  activateBefore: bigint;
  allowedActions: number;
  authMode: number;
  endpoints: LeaseEndpoint[];
}

export interface ActionIntent {
  accountId: Bytes32;
  chainRef: Bytes32;
  account: Bytes32;
  policyVersion: bigint;
  leaseId: Bytes32;
  nonce: bigint;
  actionKind: number;
  adapterId: Bytes32;
  adapterName: string;
  adapterVersion: number;
  assetIn: Bytes32;
  assetOut: Bytes32;
  amountIn: bigint;
  minAmountOut: bigint;
  recipient: Bytes32;
  recipientLabel: string;
  deadline: bigint;
  planHash: Bytes32;
  planStep: number;
}

export interface PauseAccount {
  accountId: Bytes32;
  pauseNonce: bigint;
}

export interface UnpauseAccount {
  accountId: Bytes32;
  chainRef: Bytes32;
  account: Bytes32;
  opNonce: bigint;
}

export interface RevokeLease {
  accountId: Bytes32;
  leaseId: Bytes32;
}

export interface Withdraw {
  accountId: Bytes32;
  chainRef: Bytes32;
  account: Bytes32;
  assetId: Bytes32;
  amount: bigint;
  destination: Bytes32;
  opNonce: bigint;
  deadline: bigint;
}
