import { keccak256, toHex, type Address, type PublicClient, type WalletClient } from "viem";
import type { ChainId, KidoAgentBlueprint } from "@kido/blueprint";
import { AmaneEvmEndpoint, addressToBytes32, signAmane, type AgentLease, type AmaneDeploymentManifest, type AmaneOutcome, type Bytes32, type RootPolicy, type TypedDataSigner } from "@kido/amane-bridge";
import type { ProviderRegistry } from "@kido/registry";
import { compileAmaneAuthority, type AuthorityResult } from "@kido/runtime";
import { authorityEndpoints } from "./endpoints.js";

export interface EvmDeployment {
  accountId: Bytes32;
  endpoint: AmaneEvmEndpoint;
  deployTx: string;
  authority: Extract<AuthorityResult, { ok: true }>;
}

/**
 * Deploys an Amane EVM account for a built blueprint and compiles its authority against the real
 * endpoint. The owner's controllers are addresses only: Kido never holds a controller key, and the
 * returned policy must be signed by the owner before `installPolicy`.
 */
export async function deployEvmAuthority(a: {
  bp: KidoAgentBlueprint;
  manifest: AmaneDeploymentManifest;
  registry: ProviderRegistry;
  publicClient: PublicClient;
  relayer: WalletClient;
  controllers: Address[];
  threshold: number;
  issuer: Address;
  agent: Address;
  ownerRecovery: Address;
  now: bigint;
}): Promise<EvmDeployment> {
  const chain: ChainId = "ethereum-sepolia";
  if (!a.bp.chains.includes(chain)) throw new Error("blueprint does not operate on Ethereum");
  const accountId = keccak256(toHex(`kido:${a.bp.kidoAgentId}:r${a.bp.revision}:${a.now}`));
  const { endpoint, tx } = await AmaneEvmEndpoint.deploy({ publicClient: a.publicClient as never, relayer: a.relayer as never, accountId, controllers: a.controllers, threshold: a.threshold, registry: a.manifest.evm.adapterRegistry as Address, ext: (a.manifest.evm.accountExt ?? fail("BLOCKED_ENV: the Amane manifest has no evm.accountExt for core v3 accounts")) as Address });
  const endpoints = authorityEndpoints(a.bp, a.manifest, a.registry, { [chain]: endpoint.account32 }, undefined, { [chain]: addressToBytes32(a.ownerRecovery) }).filter((e) => e.chain === chain);
  const authority = compileAmaneAuthority({ ...a.bp, chains: [chain] }, endpoints, { controllers: a.controllers, issuer: a.issuer, agent: a.agent, now: a.now, accountId });
  if (!authority.ok) throw new Error(`authority does not compile: ${authority.blockers.join("; ")}`);
  return { accountId, endpoint, deployTx: tx, authority };
}

/** Installs the owner-signed policy, then activates a lease signed by Kido's issuer key. */
export async function activateEvmAuthority(d: EvmDeployment, ownerSigs: `0x${string}`[], issuer: TypedDataSigner, leaseId: Bytes32, now: bigint): Promise<{ policy: RootPolicy; lease: AgentLease; install: AmaneOutcome; activate: AmaneOutcome }> {
  const policy = d.authority.policy;
  const install = await d.endpoint.installPolicy(policy, ownerSigs);
  if (install.kind !== "EXECUTED") return { policy, lease: d.authority.lease(leaseId, now), install, activate: install };
  const lease = d.authority.lease(leaseId, now);
  const activate = await d.endpoint.activateLease(lease, await signAmane(issuer, "AgentLease", lease));
  return { policy, lease, install, activate };
}

function fail(msg: string): never {
  throw new Error(msg);
}
