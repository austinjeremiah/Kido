import { createPublicClient, http, encodeAbiParameters, keccak256, labelhash, namehash, type Address, type Hex, type PublicClient } from "viem";
import { sepolia } from "viem/chains";
import { OperationalError, ReasonCode, assertSepolia } from "@contextlock/protocol";
import { ENS_V2_SEPOLIA, ETH_REGISTRY_ABI } from "@contextlock/ens";
import type { AgentIdentity, EnsIdentityProvider } from "./interfaces.js";

/**
 * LIVE ENSv2 Sepolia identity provider (Phase 3).
 *
 * Replaces `StubEnsIdentityProvider`. Reads current registry state on every call.
 *
 * Two properties this must preserve, because the executor's guarantee depends on them:
 *
 *  1. **No caching that can outlive a revocation.** There is deliberately no memo/TTL cache here.
 *     A cached identity would let the broker mint a capability for a name that was revoked
 *     seconds ago. The executor would still catch it on-chain, but the broker should not be
 *     issuing authority it has reason to know is dead.
 *
 *  2. **Fail closed on every error path.** An RPC failure, a missing name or an expired name all
 *     raise an `OperationalError`. There is no branch that returns an identity on error, and an
 *     outage is never reported as a policy decision.
 *
 * The identity hash derivation is byte-identical to `EnsAgentIdentityVerifier.computeIdentityHash`
 * in Solidity, so the broker and the executor agree on what "this agent" means.
 */
export class LiveEnsIdentityProvider implements EnsIdentityProvider {
  private readonly client: PublicClient;
  private readonly registry: Address;

  constructor(
    rpcUrl: string,
    /** Maps an ENS name to the agent address ContextLock expects it to authorize. */
    private readonly agentForName: Record<string, Address>,
    private readonly bindingVersion: bigint = 1n,
    registry: Address = ENS_V2_SEPOLIA.ethRegistry,
  ) {
    this.client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) }) as PublicClient;
    this.registry = registry;
  }

  /** Mirrors EnsAgentIdentityVerifier.computeIdentityHash exactly. */
  static computeIdentityHash(
    registry: Address, labelId: bigint, nameOwner: Address, agent: Address, tokenId: bigint, bindingVersion: bigint,
  ): Hex {
    return keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }],
        [registry, labelId, nameOwner, agent, tokenId, bindingVersion],
      ),
    );
  }

  async resolve(ensName: string): Promise<AgentIdentity> {
    const expectedAgent = this.agentForName[ensName.toLowerCase()];
    if (!expectedAgent) {
      throw new OperationalError(ReasonCode.IDENTITY_NOT_FOUND, `No ContextLock binding configured for ${ensName}`);
    }

    const label = ensName.split(".")[0]!;
    const labelId = BigInt(labelhash(label));

    let tokenId: bigint;
    let nameOwner: Address;
    let expiry: bigint;
    try {
      const chainId = await this.client.getChainId();
      assertSepolia(chainId);

      tokenId = await this.client.readContract({ address: this.registry, abi: ETH_REGISTRY_ABI, functionName: "getTokenId", args: [labelId] }) as bigint;
      nameOwner = await this.client.readContract({ address: this.registry, abi: ETH_REGISTRY_ABI, functionName: "ownerOf", args: [tokenId] }) as Address;
      expiry = BigInt(await this.client.readContract({ address: this.registry, abi: ETH_REGISTRY_ABI, functionName: "getExpiry", args: [labelId] }) as bigint);
    } catch (e: unknown) {
      // Any read failure is operational and fails closed. Never a denial, never an identity.
      throw new OperationalError(
        ReasonCode.IDENTITY_UNAVAILABLE,
        `ENS registry read failed for ${ensName}`,
        (e as Error)?.name,
      );
    }

    // ENSv2 zeroes ownerOf past expiry. latestOwnerOf would still return the historical owner —
    // using it here would make an expired name look valid, so it is deliberately not used.
    if (nameOwner === "0x0000000000000000000000000000000000000000") {
      throw new OperationalError(ReasonCode.IDENTITY_NOT_FOUND, `${ensName} is not currently registered`);
    }
    if (expiry <= BigInt(Math.floor(Date.now() / 1000))) {
      throw new OperationalError(ReasonCode.IDENTITY_EXPIRED, `${ensName} has expired`);
    }

    return {
      ensName,
      node: namehash(ensName),
      agent: expectedAgent,
      bindingVersion: this.bindingVersion,
      agentIdentityHash: LiveEnsIdentityProvider.computeIdentityHash(
        this.registry, labelId, nameOwner, expectedAgent, tokenId, this.bindingVersion,
      ),
      source: "ensv2-sepolia",
    };
  }
}
