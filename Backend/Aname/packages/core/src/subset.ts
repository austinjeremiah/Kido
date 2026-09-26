import { getAddress, type Address } from 'viem';
import { ActionKind, type ActionIntent, type AgentLease, type Bytes32, type LeaseEndpoint, type PolicyEndpoint, type RootPolicy } from './types.js';
import { ZERO32 } from './ids.js';

export type AmaneRejectCode =
  | 'AMANE_POLICY_VERSION_MISMATCH'
  | 'AMANE_POLICY_WRONG_ACCOUNT'
  | 'AMANE_LEASE_WRONG_ENDPOINT'
  | 'AMANE_LEASE_BAD_WINDOW'
  | 'AMANE_LEASE_LIFETIME_EXCEEDED'
  | 'AMANE_LEASE_ACTIVATION_EXPIRED'
  | 'AMANE_LEASE_ACTION_NOT_IN_ROOT'
  | 'AMANE_LEASE_ADAPTER_NOT_IN_ROOT'
  | 'AMANE_LEASE_ASSET_NOT_IN_ROOT'
  | 'AMANE_LEASE_CAP_EXCEEDS_ROOT'
  | 'AMANE_LEASE_RECIPIENT_NOT_IN_ROOT'
  | 'AMANE_LEASE_BENEFICIARY_NOT_IN_ROOT'
  | 'AMANE_LEASE_ISSUER_NOT_AUTHORIZED'
  | 'AMANE_LEASE_AGENT_IS_ISSUER'
  | 'AMANE_LEASE_AGENT_NOT_ALLOWED'
  | 'AMANE_LEASE_CAP_EXCEEDS_ISSUER'
  | 'AMANE_LEASE_BAD_AUTH_MODE'
  | 'AMANE_LEASE_DUPLICATE_ENTRY'
  | 'AMANE_ACTION_WRONG_ENDPOINT'
  | 'AMANE_ACTION_WRONG_LEASE'
  | 'AMANE_ACTION_EXPIRED'
  | 'AMANE_ACTION_KIND_NOT_ALLOWED'
  | 'AMANE_ACTION_ADAPTER_NOT_ALLOWED'
  | 'AMANE_ACTION_ADAPTER_NAME_MISMATCH'
  | 'AMANE_ACTION_ASSET_NOT_ALLOWED'
  | 'AMANE_ACTION_RECIPIENT_NOT_ALLOWED'
  | 'AMANE_ACTION_ZERO_AMOUNT'
  | 'AMANE_BUDGET_PER_ACTION'
  | 'AMANE_ACTION_NO_PRICE_FLOOR'
  | 'AMANE_POLICY_WRONG_ENDPOINT'
  | 'AMANE_POLICY_BAD_PRICE_MODE'
  | 'AMANE_POLICY_BAD_EPOCH'
  | 'AMANE_POLICY_BAD_FLOOR'
  | 'AMANE_POLICY_DUPLICATE_ENTRY'
  | 'AMANE_POLICY_ISSUER_IS_CONTROLLER';

export class AmaneReject extends Error {
  constructor(public readonly code: AmaneRejectCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const fail = (code: AmaneRejectCode, detail?: string): never => {
  throw new AmaneReject(code, detail);
};

export const actionMask = (...kinds: number[]) => kinds.reduce((m, k) => m | (1 << k), 0);
export const maskIncludes = (mask: number, kind: number) => kind >= 0 && kind < 32 && ((mask >>> kind) & 1) === 1;
export const isSubsetMask = (child: number, parent: number) => (child & ~parent) === 0;

const ZERO_LIMIT = { maxPerAction: 0n, maxPerEpoch: 0n, maxTotal: 0n };

const eq32 = (a: Bytes32, b: Bytes32) => a.toLowerCase() === b.toLowerCase();

function assertUnique(values: Bytes32[]) {
  const seen = new Set<string>();
  for (const v of values) {
    const k = v.toLowerCase();
    if (seen.has(k)) fail('AMANE_LEASE_DUPLICATE_ENTRY', v);
    seen.add(k);
  }
}

export function findPolicyEndpoint(policy: RootPolicy, chainRef: Bytes32, account: Bytes32): PolicyEndpoint | undefined {
  return policy.endpoints.find((e) => eq32(e.chainRef, chainRef) && eq32(e.account, account));
}

export function findLeaseEndpoint(lease: AgentLease, chainRef: Bytes32, account: Bytes32): LeaseEndpoint | undefined {
  return lease.endpoints.find((e) => eq32(e.chainRef, chainRef) && eq32(e.account, account));
}

function assertUniqueWith(values: string[], code: AmaneRejectCode) {
  const seen = new Set<string>();
  for (const v of values) {
    const k = v.toLowerCase();
    if (seen.has(k)) fail(code, v);
    seen.add(k);
  }
}

// Mirrors the checks every endpoint performs in installPolicy, for the endpoint given.
export function assertPolicyWellFormed(policy: RootPolicy, ctx: { controllers: Address[]; chainRef: Bytes32; account: Bytes32 }): void {
  if (policy.priceMode !== 1) fail('AMANE_POLICY_BAD_PRICE_MODE');
  const own = policy.endpoints.filter((e) => eq32(e.chainRef, ctx.chainRef) && eq32(e.account, ctx.account));
  if (own.length === 0) fail('AMANE_POLICY_WRONG_ENDPOINT');
  if (own.length > 1) fail('AMANE_POLICY_DUPLICATE_ENTRY');
  const e = own[0]!;
  if (e.epochSeconds === 0n) fail('AMANE_POLICY_BAD_EPOCH');
  const dup = 'AMANE_POLICY_DUPLICATE_ENTRY' as const;
  assertUniqueWith(e.adapters.map((a) => a.adapterId), dup);
  assertUniqueWith(e.assets.map((a) => a.assetId), dup);
  assertUniqueWith(e.recipients.map((a) => a.recipientId), dup);
  assertUniqueWith(e.beneficiaries.map((a) => a.recipientId), dup);
  assertUniqueWith(e.recoveryDestinations.map((a) => a.recipientId), dup);
  assertUniqueWith(e.swapFloors.map((f) => `${f.assetIn}:${f.assetOut}`), dup);
  for (const f of e.swapFloors) if (f.minOutDenominator === 0n) fail('AMANE_POLICY_BAD_FLOOR');
  assertUniqueWith(policy.leaseIssuers.map((i) => i.issuer), dup);
  for (const i of policy.leaseIssuers) {
    if (ctx.controllers.some((c) => getAddress(c) === getAddress(i.issuer))) fail('AMANE_POLICY_ISSUER_IS_CONTROLLER');
    assertUniqueWith(i.limits.filter((l) => eq32(l.chainRef, ctx.chainRef)).map((l) => l.assetId), dup);
  }
}

export interface LeaseCheckContext {
  now: bigint;
  controllers: Address[];
  chainRef: Bytes32;
  account: Bytes32;
}

export function assertLeaseIsSubset(policy: RootPolicy, lease: AgentLease, ctx: LeaseCheckContext): void {
  if (!eq32(lease.accountId, policy.accountId)) fail('AMANE_POLICY_WRONG_ACCOUNT');
  if (lease.policyVersion !== policy.policyVersion) fail('AMANE_POLICY_VERSION_MISMATCH');
  if (lease.authMode !== 1) fail('AMANE_LEASE_BAD_AUTH_MODE');
  if (lease.expiresAt <= lease.validAfter) fail('AMANE_LEASE_BAD_WINDOW');
  if (ctx.now > lease.activateBefore) fail('AMANE_LEASE_ACTIVATION_EXPIRED');
  const lifetime = lease.expiresAt - lease.validAfter;
  if (lifetime > policy.maxLeaseLifetime) fail('AMANE_LEASE_LIFETIME_EXCEEDED');
  if (!isSubsetMask(lease.allowedActions, policy.allowedActions)) fail('AMANE_LEASE_ACTION_NOT_IN_ROOT');

  const agent = getAddress(lease.agent);
  const issuer = getAddress(lease.issuer);
  if (agent === issuer) fail('AMANE_LEASE_AGENT_IS_ISSUER');
  const isController = ctx.controllers.some((c) => getAddress(c) === issuer);
  const issuerEntry = policy.leaseIssuers.find((i) => getAddress(i.issuer) === issuer);
  if (!isController && !issuerEntry) fail('AMANE_LEASE_ISSUER_NOT_AUTHORIZED');
  if (ctx.controllers.some((c) => getAddress(c) === agent)) fail('AMANE_LEASE_AGENT_IS_ISSUER', 'agent must not be a controller');

  const root = findPolicyEndpoint(policy, ctx.chainRef, ctx.account) ?? fail('AMANE_LEASE_WRONG_ENDPOINT', 'no policy endpoint');
  const le = findLeaseEndpoint(lease, ctx.chainRef, ctx.account) ?? fail('AMANE_LEASE_WRONG_ENDPOINT', 'no lease endpoint');

  assertUnique(le.adapters);
  assertUnique(le.assets.map((a) => a.assetId));
  assertUnique(le.recipients);
  assertUnique(le.beneficiaries);

  for (const a of le.adapters) if (!root.adapters.some((r) => eq32(r.adapterId, a))) fail('AMANE_LEASE_ADAPTER_NOT_IN_ROOT', a);
  for (const l of le.assets) {
    const r = root.assets.find((x) => eq32(x.assetId, l.assetId)) ?? fail('AMANE_LEASE_ASSET_NOT_IN_ROOT', l.assetId);
    if (l.maxPerAction > r.maxPerAction || l.maxPerEpoch > r.maxPerEpoch || l.maxTotal > r.maxTotal) fail('AMANE_LEASE_CAP_EXCEEDS_ROOT', l.assetId);
  }
  for (const x of le.recipients) if (!root.recipients.some((r) => eq32(r.recipientId, x))) fail('AMANE_LEASE_RECIPIENT_NOT_IN_ROOT', x);
  for (const x of le.beneficiaries) if (!root.beneficiaries.some((r) => eq32(r.recipientId, x))) fail('AMANE_LEASE_BENEFICIARY_NOT_IN_ROOT', x);

  if (!isController && issuerEntry) {
    if (lifetime > issuerEntry.maxLeaseLifetime) fail('AMANE_LEASE_LIFETIME_EXCEEDED', 'issuer cap');
    if (!issuerEntry.allowedAgents.some((a) => getAddress(a) === agent)) fail('AMANE_LEASE_AGENT_NOT_ALLOWED');
    for (const l of le.assets) {
      const cap = issuerEntry.limits.find((x) => eq32(x.chainRef, ctx.chainRef) && eq32(x.assetId, l.assetId)) ?? ZERO_LIMIT;
      if (l.maxPerAction > cap.maxPerAction || l.maxPerEpoch > cap.maxPerEpoch || l.maxTotal > cap.maxTotal) fail('AMANE_LEASE_CAP_EXCEEDS_ISSUER', l.assetId);
    }
  }
}

export interface ActionCheckContext {
  now: bigint;
  chainRef: Bytes32;
  account: Bytes32;
}

// Stateless part of action validation. Budgets, replay and pause are chain state and are
// enforced only on-chain; this mirror exists so the SDK can refuse obviously bad intents early.
export function assertActionIsSubset(policy: RootPolicy, lease: AgentLease, intent: ActionIntent, ctx: ActionCheckContext): bigint {
  if (!eq32(intent.accountId, policy.accountId)) fail('AMANE_POLICY_WRONG_ACCOUNT');
  if (!eq32(intent.chainRef, ctx.chainRef) || !eq32(intent.account, ctx.account)) fail('AMANE_ACTION_WRONG_ENDPOINT');
  if (intent.policyVersion !== policy.policyVersion) fail('AMANE_POLICY_VERSION_MISMATCH');
  if (!eq32(intent.leaseId, lease.leaseId)) fail('AMANE_ACTION_WRONG_LEASE');
  if (ctx.now > intent.deadline) fail('AMANE_ACTION_EXPIRED');
  if (!maskIncludes(lease.allowedActions, intent.actionKind)) fail('AMANE_ACTION_KIND_NOT_ALLOWED');
  if (intent.amountIn === 0n) fail('AMANE_ACTION_ZERO_AMOUNT');

  const root = findPolicyEndpoint(policy, ctx.chainRef, ctx.account) ?? fail('AMANE_ACTION_WRONG_ENDPOINT');
  const le = findLeaseEndpoint(lease, ctx.chainRef, ctx.account) ?? fail('AMANE_ACTION_WRONG_ENDPOINT');

  if (!le.adapters.some((a) => eq32(a, intent.adapterId))) fail('AMANE_ACTION_ADAPTER_NOT_ALLOWED');
  const ref = root.adapters.find((a) => eq32(a.adapterId, intent.adapterId)) ?? fail('AMANE_ACTION_ADAPTER_NOT_ALLOWED');
  if (ref.adapterName !== intent.adapterName || ref.adapterVersion !== intent.adapterVersion) fail('AMANE_ACTION_ADAPTER_NAME_MISMATCH');

  const inLimit = le.assets.find((a) => eq32(a.assetId, intent.assetIn)) ?? fail('AMANE_ACTION_ASSET_NOT_ALLOWED', 'assetIn');
  if (intent.amountIn > inLimit.maxPerAction) fail('AMANE_BUDGET_PER_ACTION');

  let effectiveMinOut = intent.minAmountOut;
  if (intent.actionKind === ActionKind.SWAP) {
    if (eq32(intent.assetOut, intent.assetIn)) fail('AMANE_ACTION_ASSET_NOT_ALLOWED', 'SWAP assetOut must differ from assetIn');
    if (!le.assets.some((a) => eq32(a.assetId, intent.assetOut))) fail('AMANE_ACTION_ASSET_NOT_ALLOWED', 'assetOut');
    if (!eq32(intent.recipient, ZERO32)) fail('AMANE_ACTION_RECIPIENT_NOT_ALLOWED', 'swap output returns to the account');
    const floor =
      root.swapFloors.find((f) => eq32(f.assetIn, intent.assetIn) && eq32(f.assetOut, intent.assetOut)) ?? fail('AMANE_ACTION_NO_PRICE_FLOOR');
    const required = (intent.amountIn * floor.minOutNumerator + floor.minOutDenominator - 1n) / floor.minOutDenominator;
    if (required > effectiveMinOut) effectiveMinOut = required;
  } else if (intent.actionKind === ActionKind.PAY) {
    if (!eq32(intent.assetOut, intent.assetIn)) fail('AMANE_ACTION_ASSET_NOT_ALLOWED', 'PAY assetOut must equal assetIn');
    if (!le.recipients.some((r) => eq32(r, intent.recipient))) fail('AMANE_ACTION_RECIPIENT_NOT_ALLOWED');
    const r = root.recipients.find((x) => eq32(x.recipientId, intent.recipient)) ?? fail('AMANE_ACTION_RECIPIENT_NOT_ALLOWED');
    if (r.label !== intent.recipientLabel) fail('AMANE_ACTION_RECIPIENT_NOT_ALLOWED', 'label mismatch');
  } else if (intent.actionKind === ActionKind.REPAY) {
    if (!le.beneficiaries.some((r) => eq32(r, intent.recipient))) fail('AMANE_ACTION_RECIPIENT_NOT_ALLOWED', 'beneficiary');
    const r = root.beneficiaries.find((x) => eq32(x.recipientId, intent.recipient)) ?? fail('AMANE_ACTION_RECIPIENT_NOT_ALLOWED');
    if (r.label !== intent.recipientLabel) fail('AMANE_ACTION_RECIPIENT_NOT_ALLOWED', 'label mismatch');
  } else {
    fail('AMANE_ACTION_KIND_NOT_ALLOWED', 'no v1 enforcement rule for this action kind');
  }
  return effectiveMinOut;
}
