import { hashStruct, hashTypedData, keccak256, toHex, encodeAbiParameters, type TypedDataDomain } from 'viem';
import type {
  ActionIntent,
  AgentLease,
  PauseAccount,
  RevokeLease,
  RootPolicy,
  UnpauseAccount,
  Withdraw,
} from './types.js';

export const AMANE_SIGNING_CHAIN_ID = 11155111;

// Every Amane signature, including those verified on Sui, uses the Sepolia domain with no
// verifyingContract: wallets refuse typed data for a chain they are not connected to, and the
// same signature must verify on several endpoints. Endpoint binding lives in struct fields.
export const AMANE_DOMAIN = {
  name: 'Amane',
  version: '1',
  chainId: AMANE_SIGNING_CHAIN_ID,
} as const satisfies TypedDataDomain;

const AssetLimit = [
  { name: 'assetId', type: 'bytes32' },
  { name: 'maxPerAction', type: 'uint256' },
  { name: 'maxPerEpoch', type: 'uint256' },
  { name: 'maxTotal', type: 'uint256' },
] as const;

const AdapterRef = [
  { name: 'adapterId', type: 'bytes32' },
  { name: 'adapterName', type: 'string' },
  { name: 'adapterVersion', type: 'uint32' },
] as const;

const Recipient = [
  { name: 'recipientId', type: 'bytes32' },
  { name: 'label', type: 'string' },
] as const;

const SwapFloor = [
  { name: 'assetIn', type: 'bytes32' },
  { name: 'assetOut', type: 'bytes32' },
  { name: 'minOutNumerator', type: 'uint256' },
  { name: 'minOutDenominator', type: 'uint256' },
] as const;

const PolicyEndpoint = [
  { name: 'chainRef', type: 'bytes32' },
  { name: 'account', type: 'bytes32' },
  { name: 'epochSeconds', type: 'uint64' },
  { name: 'adapters', type: 'AdapterRef[]' },
  { name: 'assets', type: 'AssetLimit[]' },
  { name: 'recipients', type: 'Recipient[]' },
  { name: 'beneficiaries', type: 'Recipient[]' },
  { name: 'swapFloors', type: 'SwapFloor[]' },
  { name: 'recoveryDestinations', type: 'Recipient[]' },
] as const;

const IssuerLimit = [
  { name: 'chainRef', type: 'bytes32' },
  { name: 'assetId', type: 'bytes32' },
  { name: 'maxPerAction', type: 'uint256' },
  { name: 'maxPerEpoch', type: 'uint256' },
  { name: 'maxTotal', type: 'uint256' },
] as const;

const LeaseIssuer = [
  { name: 'issuer', type: 'address' },
  { name: 'maxLeaseLifetime', type: 'uint64' },
  { name: 'allowedAgents', type: 'address[]' },
  { name: 'limits', type: 'IssuerLimit[]' },
] as const;

const RootPolicy = [
  { name: 'accountId', type: 'bytes32' },
  { name: 'policyVersion', type: 'uint64' },
  { name: 'parentPolicyHash', type: 'bytes32' },
  { name: 'allowedActions', type: 'uint32' },
  { name: 'priceMode', type: 'uint8' },
  { name: 'maxLeaseLifetime', type: 'uint64' },
  { name: 'activateBefore', type: 'uint64' },
  { name: 'endpoints', type: 'PolicyEndpoint[]' },
  { name: 'leaseIssuers', type: 'LeaseIssuer[]' },
] as const;

const LeaseEndpoint = [
  { name: 'chainRef', type: 'bytes32' },
  { name: 'account', type: 'bytes32' },
  { name: 'adapters', type: 'bytes32[]' },
  { name: 'assets', type: 'AssetLimit[]' },
  { name: 'recipients', type: 'bytes32[]' },
  { name: 'beneficiaries', type: 'bytes32[]' },
] as const;

const AgentLease = [
  { name: 'accountId', type: 'bytes32' },
  { name: 'policyVersion', type: 'uint64' },
  { name: 'leaseId', type: 'bytes32' },
  { name: 'agent', type: 'address' },
  { name: 'issuer', type: 'address' },
  { name: 'validAfter', type: 'uint64' },
  { name: 'expiresAt', type: 'uint64' },
  { name: 'activateBefore', type: 'uint64' },
  { name: 'allowedActions', type: 'uint32' },
  { name: 'authMode', type: 'uint8' },
  { name: 'endpoints', type: 'LeaseEndpoint[]' },
] as const;

const ActionIntent = [
  { name: 'accountId', type: 'bytes32' },
  { name: 'chainRef', type: 'bytes32' },
  { name: 'account', type: 'bytes32' },
  { name: 'policyVersion', type: 'uint64' },
  { name: 'leaseId', type: 'bytes32' },
  { name: 'nonce', type: 'uint64' },
  { name: 'actionKind', type: 'uint8' },
  { name: 'adapterId', type: 'bytes32' },
  { name: 'adapterName', type: 'string' },
  { name: 'adapterVersion', type: 'uint32' },
  { name: 'assetIn', type: 'bytes32' },
  { name: 'assetOut', type: 'bytes32' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'minAmountOut', type: 'uint256' },
  { name: 'recipient', type: 'bytes32' },
  { name: 'recipientLabel', type: 'string' },
  { name: 'deadline', type: 'uint64' },
  { name: 'planHash', type: 'bytes32' },
  { name: 'planStep', type: 'uint32' },
] as const;

const PauseAccount = [
  { name: 'accountId', type: 'bytes32' },
  { name: 'pauseEpoch', type: 'uint64' },
  { name: 'pauseId', type: 'bytes32' },
  { name: 'deadline', type: 'uint64' },
] as const;

const UnpauseAccount = [
  { name: 'accountId', type: 'bytes32' },
  { name: 'chainRef', type: 'bytes32' },
  { name: 'account', type: 'bytes32' },
  { name: 'pauseEpoch', type: 'uint64' },
  { name: 'pauseId', type: 'bytes32' },
  { name: 'deadline', type: 'uint64' },
] as const;

const RevokeLease = [
  { name: 'accountId', type: 'bytes32' },
  { name: 'leaseId', type: 'bytes32' },
] as const;

const Withdraw = [
  { name: 'accountId', type: 'bytes32' },
  { name: 'chainRef', type: 'bytes32' },
  { name: 'account', type: 'bytes32' },
  { name: 'assetId', type: 'bytes32' },
  { name: 'amount', type: 'uint256' },
  { name: 'destination', type: 'bytes32' },
  { name: 'opNonce', type: 'uint64' },
  { name: 'deadline', type: 'uint64' },
] as const;

export const AMANE_TYPES = {
  AssetLimit,
  AdapterRef,
  Recipient,
  SwapFloor,
  PolicyEndpoint,
  IssuerLimit,
  LeaseIssuer,
  RootPolicy,
  LeaseEndpoint,
  AgentLease,
  ActionIntent,
  PauseAccount,
  UnpauseAccount,
  RevokeLease,
  Withdraw,
} as const;

export type AmanePrimaryType =
  | 'RootPolicy'
  | 'AgentLease'
  | 'ActionIntent'
  | 'PauseAccount'
  | 'UnpauseAccount'
  | 'RevokeLease'
  | 'Withdraw';

export interface AmaneMessageMap {
  RootPolicy: RootPolicy;
  AgentLease: AgentLease;
  ActionIntent: ActionIntent;
  PauseAccount: PauseAccount;
  UnpauseAccount: UnpauseAccount;
  RevokeLease: RevokeLease;
  Withdraw: Withdraw;
}

export function typedData<P extends AmanePrimaryType>(primaryType: P, message: AmaneMessageMap[P]) {
  return {
    domain: AMANE_DOMAIN,
    types: AMANE_TYPES,
    primaryType,
    message: message as unknown as Record<string, unknown>,
  } as const;
}

export function amaneDigest<P extends AmanePrimaryType>(primaryType: P, message: AmaneMessageMap[P]): `0x${string}` {
  return hashTypedData(typedData(primaryType, message) as never);
}

export function amaneStructHash<P extends AmanePrimaryType>(primaryType: P, message: AmaneMessageMap[P]): `0x${string}` {
  return hashStruct({ data: message as never, primaryType: primaryType as never, types: AMANE_TYPES as never });
}

export function domainSeparator(): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
      [
        keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId)')),
        keccak256(toHex(AMANE_DOMAIN.name)),
        keccak256(toHex(AMANE_DOMAIN.version)),
        BigInt(AMANE_DOMAIN.chainId),
      ],
    ),
  );
}

function findDeps(type: string, acc: Set<string>) {
  const fields = (AMANE_TYPES as Record<string, readonly { name: string; type: string }[]>)[type];
  if (!fields || acc.has(type)) return;
  acc.add(type);
  for (const f of fields) findDeps(f.type.replace('[]', ''), acc);
}

export function encodeType(primaryType: keyof typeof AMANE_TYPES): string {
  const deps = new Set<string>();
  findDeps(primaryType, deps);
  deps.delete(primaryType);
  const all = [primaryType, ...[...deps].sort()];
  return all
    .map((t) => `${t}(${(AMANE_TYPES as Record<string, readonly { name: string; type: string }[]>)[t]!.map((f) => `${f.type} ${f.name}`).join(',')})`)
    .join('');
}

export function typeHash(primaryType: keyof typeof AMANE_TYPES): `0x${string}` {
  return keccak256(toHex(encodeType(primaryType)));
}
