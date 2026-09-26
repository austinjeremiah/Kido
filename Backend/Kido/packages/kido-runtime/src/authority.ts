import type { Action, ChainId, KidoAgentBlueprint } from "@kido/blueprint";
import {
  ActionKind,
  AuthMode,
  PriceMode,
  ZERO32,
  actionMask,
  addressToBytes32,
  assertLeaseIsSubset,
  assertPolicyWellFormed,
  suiObjectToBytes32,
  type AgentLease,
  type Bytes32,
  type RootPolicy,
} from "@kido/amane-bridge";
import type { AdapterBinding, EndpointBinding } from "./compile.js";

/** Chain-specific facts Kido needs to compile authority for one Amane endpoint. */
export interface AuthorityEndpoint {
  chain: ChainId;
  chainRef: Bytes32;
  account: Bytes32;
  /** asset symbol → Amane asset id and decimals */
  assets: Record<string, { assetId: Bytes32; decimals: number }>;
  /** semantic action → shipped Amane adapter (absent = not shipped on this chain) */
  adapters: Partial<Record<Action, AdapterBinding>>;
  recovery: { recipientId: Bytes32; label: string };
}

export interface AuthorityCompileOptions {
  controllers: `0x${string}`[];
  issuer: `0x${string}`;
  agent: `0x${string}`;
  now: bigint;
}

export type AuthorityResult =
  | {
      ok: true;
      policy: RootPolicy;
      lease: (leaseId: Bytes32, now: bigint) => AgentLease;
      bindings: Partial<Record<ChainId, EndpointBinding>>;
      crossChainTotal: Record<string, bigint>;
      excludedActions: { chain: ChainId; action: Action; reason: string }[];
    }
  | { ok: false; blockers: string[] };

const KIND: Partial<Record<Action, number>> = { PAY: ActionKind.PAY, SWAP: ActionKind.SWAP, REPAY: ActionKind.REPAY };

function recipientId(chain: ChainId, address: string, account: Bytes32): Bytes32 {
  if (address === "SELF") return account;
  return chain === "ethereum-sepolia" ? addressToBytes32(address as `0x${string}`) : suiObjectToBytes32(address);
}

/** Decimal rate × 10^(decOut−decIn) as an exact fraction, for the owner floor in base units. */
function floorFraction(rate: string, decIn: number, decOut: number): { num: bigint; den: bigint } {
  const [i, f = ""] = rate.split(".");
  let num = BigInt(i! + f);
  let den = 10n ** BigInt(f.length);
  const shift = decOut - decIn;
  if (shift >= 0) num *= 10n ** BigInt(shift);
  else den *= 10n ** BigInt(-shift);
  return { num, den };
}

/**
 * Compiles the blueprint's authority section into the Amane Root Policy the owner signs and the
 * lease template the Kido issuer signs (bible §30, §31). Only the blueprint is an input: nothing is
 * added that the user did not confirm, and actions whose adapter is not shipped are excluded and
 * reported instead of being granted optimistically.
 */
export function compileAmaneAuthority(bp: KidoAgentBlueprint, endpoints: AuthorityEndpoint[], o: AuthorityCompileOptions): AuthorityResult {
  const a = bp.authority;
  const blockers: string[] = [];
  if (a.mode !== "BOUNDED_AUTONOMOUS_FINANCE" || a.provider !== "AMANE") return { ok: false, blockers: ["blueprint does not select Amane bounded authority"] };
  const excludedActions: { chain: ChainId; action: Action; reason: string }[] = [];
  const policyEndpoints: RootPolicy["endpoints"] = [];
  const leaseEndpoints: AgentLease["endpoints"] = [];
  const bindings: Partial<Record<ChainId, EndpointBinding>> = {};
  const crossChainTotal: Record<string, bigint> = {};
  const granted = new Set<number>();

  for (const chain of bp.chains) {
    const ep = endpoints.find((e) => e.chain === chain);
    if (!ep) {
      blockers.push(`no Amane endpoint for ${chain}`);
      continue;
    }
    const limits = a.limits.filter((l) => l.chain === chain);
    if (limits.length === 0) blockers.push(`no limits for ${chain}`);
    const actions = a.allowedActions.filter((act) => {
      if (KIND[act] === undefined) return excludedActions.push({ chain, action: act, reason: "no Amane enforcement rule for this action" }), false;
      if (!ep.adapters[act]) return excludedActions.push({ chain, action: act, reason: `Amane adapter for ${act} not shipped on ${chain}` }), false;
      return true;
    });
    for (const act of actions) granted.add(KIND[act]!);
    const assetLimits = limits.map((l) => {
      const asset = ep.assets[l.asset];
      if (!asset) throw new Error(`asset ${l.asset} unknown on ${chain}`);
      crossChainTotal[l.asset] = (crossChainTotal[l.asset] ?? 0n) + BigInt(l.total);
      return { assetId: asset.assetId, maxPerAction: BigInt(l.perAction), maxPerEpoch: BigInt(l.perWindow), maxTotal: BigInt(l.total) };
    });
    const payees = a.payees.filter((p) => p.chain === chain).map((p) => ({ recipientId: recipientId(chain, p.address, ep.account), label: p.label }));
    const beneficiaries = a.beneficiaries.filter((p) => p.chain === chain).map((p) => ({ recipientId: recipientId(chain, p.address, ep.account), label: p.label }));
    const floors = actions.includes("SWAP")
      ? a.swapFloors.filter((f) => f.chain === chain).map((f) => {
          const ai = ep.assets[f.assetIn], ao = ep.assets[f.assetOut];
          if (!ai || !ao) throw new Error(`swap floor asset unknown on ${chain}`);
          const { num, den } = floorFraction(f.minOutPerIn, ai.decimals, ao.decimals);
          return { assetIn: ai.assetId, assetOut: ao.assetId, minOutNumerator: num, minOutDenominator: den };
        })
      : [];
    const adapters = actions.map((act) => ep.adapters[act]!);
    policyEndpoints.push({ chainRef: ep.chainRef, account: ep.account, epochSeconds: BigInt(limits[0]?.windowSeconds ?? 3600), adapters, assets: assetLimits, recipients: payees, beneficiaries, swapFloors: floors, recoveryDestinations: [ep.recovery] });
    leaseEndpoints.push({ chainRef: ep.chainRef, account: ep.account, adapters: adapters.map((x) => x.adapterId), assets: assetLimits, recipients: payees.map((p) => p.recipientId), beneficiaries: beneficiaries.map((b) => b.recipientId) });
    bindings[chain] = {
      chain,
      chainRef: ep.chainRef,
      account: ep.account,
      assets: Object.fromEntries(Object.entries(ep.assets).map(([k, v]) => [k, v.assetId])),
      adapters: Object.fromEntries(actions.map((act) => [act, ep.adapters[act]!])),
      payees: Object.fromEntries([...payees, ...beneficiaries].map((p) => [p.label, p])),
    };
  }
  if (granted.size === 0) blockers.push("no allowed action has a shipped Amane adapter");
  if (blockers.length) return { ok: false, blockers };

  const policy: RootPolicy = {
    accountId: bp.amane?.accountId as Bytes32 ?? ZERO32,
    policyVersion: 1n,
    parentPolicyHash: ZERO32,
    allowedActions: actionMask(...granted),
    priceMode: PriceMode.TESTNET_FIXED,
    maxLeaseLifetime: BigInt(a.leaseLifetimeSeconds),
    activateBefore: o.now + 900n,
    endpoints: policyEndpoints,
    leaseIssuers: [{ issuer: o.issuer, maxLeaseLifetime: BigInt(a.leaseLifetimeSeconds), allowedAgents: [o.agent], limits: policyEndpoints.flatMap((e) => e.assets.map((l) => ({ chainRef: e.chainRef, ...l }))) }],
  };
  for (const e of policyEndpoints) assertPolicyWellFormed(policy, { controllers: o.controllers, chainRef: e.chainRef, account: e.account, now: o.now });
  const lease = (leaseId: Bytes32, now: bigint): AgentLease => {
    const l: AgentLease = {
      accountId: policy.accountId,
      policyVersion: 1n,
      leaseId,
      agent: o.agent,
      issuer: o.issuer,
      validAfter: now - 60n,
      expiresAt: now - 60n + BigInt(a.leaseLifetimeSeconds),
      activateBefore: now + 900n,
      allowedActions: policy.allowedActions,
      authMode: AuthMode.AGENT_SIGNED,
      endpoints: leaseEndpoints,
    };
    for (const e of policyEndpoints) assertLeaseIsSubset(policy, l, { now, controllers: o.controllers, chainRef: e.chainRef, account: e.account });
    return l;
  };
  return { ok: true, policy, lease, bindings, crossChainTotal, excludedActions };
}
