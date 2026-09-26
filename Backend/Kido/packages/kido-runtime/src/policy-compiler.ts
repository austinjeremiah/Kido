import type { Chain } from "@kido/agents";
import {
  ActionKind,
  AuthMode,
  PriceMode,
  ZERO32,
  actionMask,
  assertLeaseIsSubset,
  assertPolicyWellFormed,
  type AgentLease,
  type Bytes32,
  type RootPolicy,
} from "@kido/amane-bridge";
import type { AdapterBinding, EndpointBinding } from "./compile.js";

export interface AssetCaps {
  maxPerAction: bigint;
  maxPerEpoch: bigint;
  maxTotal: bigint;
}

/** A payment mandate as the owner states it. Everything financial is explicit; nothing is inferred. */
export interface PaymentMandate {
  accountId: Bytes32;
  asset: string;
  epochSeconds: bigint;
  rootCaps: AssetCaps;
  leaseCaps: AssetCaps;
  issuerCaps: AssetCaps;
  maxLeaseLifetime: bigint;
  issuer: `0x${string}`;
  agent: `0x${string}`;
  payees: { label: string; recipient: Record<Chain, Bytes32> }[];
  recovery: Record<Chain, { recipientId: Bytes32; label: string }>;
}

export interface EndpointFacts {
  chain: Chain;
  chainRef: Bytes32;
  account: Bytes32;
  assetId: Bytes32;
  pay: AdapterBinding;
}

export interface CompiledAuthority {
  policy: RootPolicy;
  lease: (leaseId: Bytes32, now: bigint, lifetime: bigint) => AgentLease;
  bindings: Record<Chain, EndpointBinding>;
  /** Worst-case exposure across chains is the sum of per-endpoint limits (bible §2.11). */
  crossChainTotal: bigint;
  forbidden: string[];
}

/**
 * Compiles an owner mandate into the exact Amane Root Policy and lease template the owner signs.
 * The result is checked with the same well-formedness and subset rules the chains enforce, so the
 * displayed semantics and the signed authority cannot drift (KIDO-INT-001).
 */
export function compilePaymentMandate(m: PaymentMandate, endpoints: EndpointFacts[], controllers: `0x${string}`[], now: bigint): CompiledAuthority {
  const limit = (assetId: Bytes32, c: AssetCaps) => ({ assetId, ...c });
  const policy: RootPolicy = {
    accountId: m.accountId,
    policyVersion: 1n,
    parentPolicyHash: ZERO32,
    allowedActions: actionMask(ActionKind.PAY),
    priceMode: PriceMode.TESTNET_FIXED,
    maxLeaseLifetime: m.maxLeaseLifetime,
    activateBefore: now + 900n,
    endpoints: endpoints.map((e) => ({
      chainRef: e.chainRef,
      account: e.account,
      epochSeconds: m.epochSeconds,
      adapters: [e.pay],
      assets: [limit(e.assetId, m.rootCaps)],
      recipients: m.payees.map((p) => ({ recipientId: p.recipient[e.chain], label: p.label })),
      beneficiaries: [],
      swapFloors: [],
      recoveryDestinations: [m.recovery[e.chain]],
    })),
    leaseIssuers: [
      {
        issuer: m.issuer,
        maxLeaseLifetime: m.maxLeaseLifetime,
        allowedAgents: [m.agent],
        limits: endpoints.map((e) => ({ chainRef: e.chainRef, assetId: e.assetId, ...m.issuerCaps })),
      },
    ],
  };
  for (const e of endpoints) assertPolicyWellFormed(policy, { controllers, chainRef: e.chainRef, account: e.account, now });

  const lease = (leaseId: Bytes32, t: bigint, lifetime: bigint): AgentLease => {
    const l: AgentLease = {
      accountId: m.accountId,
      policyVersion: 1n,
      leaseId,
      agent: m.agent,
      issuer: m.issuer,
      validAfter: t - 60n,
      expiresAt: t - 60n + lifetime,
      activateBefore: t + 900n,
      allowedActions: actionMask(ActionKind.PAY),
      authMode: AuthMode.AGENT_SIGNED,
      endpoints: endpoints.map((e) => ({
        chainRef: e.chainRef,
        account: e.account,
        adapters: [e.pay.adapterId],
        assets: [limit(e.assetId, m.leaseCaps)],
        recipients: m.payees.map((p) => p.recipient[e.chain]),
        beneficiaries: [],
      })),
    };
    for (const e of endpoints) assertLeaseIsSubset(policy, l, { now: t, controllers, chainRef: e.chainRef, account: e.account });
    return l;
  };

  const bindings = Object.fromEntries(
    endpoints.map((e) => [
      e.chain,
      {
        chain: e.chain,
        chainRef: e.chainRef,
        account: e.account,
        assets: { [m.asset]: e.assetId },
        adapters: { PAY: e.pay },
        payees: Object.fromEntries(m.payees.map((p) => [p.label, { recipientId: p.recipient[e.chain], label: p.label }])),
      } satisfies EndpointBinding,
    ]),
  ) as Record<Chain, EndpointBinding>;

  return {
    policy,
    lease,
    bindings,
    crossChainTotal: m.rootCaps.maxTotal * BigInt(endpoints.length),
    forbidden: ["BORROW", "WITHDRAW (agent)", "ARBITRARY_TRANSFER", "SWAP", "REPAY", "BRIDGE"],
  };
}
