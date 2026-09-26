import { keccak256, encodeAbiParameters, hashTypedData, type Address, type Hex } from "viem";

/**
 * Canonical ContextLock capability schema.
 *
 * This is an INDEPENDENT implementation of the same schema defined in
 * `contracts/src/ContextLockTypes.sol`. The two are deliberately not derived from each other:
 * cross-language agreement is proven by golden vectors in `test-vectors/`, which both sides
 * recompute. If one implementation drifts, the vectors fail.
 *
 * Canonicalization rules (bible, "Capability Hashing and Canonicalization Rules"):
 *  - token amounts are integer base units as `bigint`, never floating point
 *  - addresses are 20-byte values; checksum casing is presentation only
 *  - chain identifiers are integers
 *  - field order is fixed by the EIP-712 struct definition, never by map iteration order
 */
export const CAPABILITY_VERSION = 1 as const;

export type Capability = {
  version: number;
  agentIdentityHash: Hex;
  agent: Address;
  chainId: bigint;
  executor: Address;
  target: Address;
  value: bigint;
  calldataHash: Hex;
  intentHash: Hex;
  policyHash: Hex;
  authorizationId: Hex;
  contextCommitment: Hex;
  issuedAt: bigint;
  expiresAt: bigint;
  nonce: bigint;
};

/** EIP-712 type definition. Field order here IS the schema. */
export const CAPABILITY_TYPES = {
  Capability: [
    { name: "version", type: "uint8" },
    { name: "agentIdentityHash", type: "bytes32" },
    { name: "agent", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "executor", type: "address" },
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "calldataHash", type: "bytes32" },
    { name: "intentHash", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "authorizationId", type: "bytes32" },
    { name: "contextCommitment", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const CAPABILITY_TYPE_STRING =
  "Capability(uint8 version,bytes32 agentIdentityHash,address agent,uint256 chainId,address executor,address target,uint256 value,bytes32 calldataHash,bytes32 intentHash,bytes32 policyHash,bytes32 authorizationId,bytes32 contextCommitment,uint64 issuedAt,uint64 expiresAt,uint256 nonce)";

export const REQUEST_TYPE_STRING =
  "EvaluationRequest(bytes32 agentIdentityHash,address agent,uint256 chainId,address executor,address target,uint256 value,bytes32 calldataHash,bytes32 intentHash,bytes32 policyHash)";

export const CAPABILITY_TYPEHASH = keccak256(
  new TextEncoder().encode(CAPABILITY_TYPE_STRING) as unknown as Uint8Array,
);
export const REQUEST_TYPEHASH = keccak256(
  new TextEncoder().encode(REQUEST_TYPE_STRING) as unknown as Uint8Array,
);

export function domain(chainId: bigint, executor: Address) {
  return { name: "ContextLock", version: "1", chainId, verifyingContract: executor } as const;
}

/** EIP-712 domain separator, computed from the spec rather than read from the contract. */
export function domainSeparator(chainId: bigint, executor: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        keccak256(
          new TextEncoder().encode(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
          ) as unknown as Uint8Array,
        ),
        keccak256(new TextEncoder().encode("ContextLock") as unknown as Uint8Array),
        keccak256(new TextEncoder().encode("1") as unknown as Uint8Array),
        chainId,
        executor,
      ],
    ),
  );
}

/** keccak256 of the EIP-712 encoded struct (not the full digest). */
export function hashStruct(cap: Capability): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }, { type: "address" },
        { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" },
        { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
        { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }, { type: "uint256" },
      ],
      [
        CAPABILITY_TYPEHASH, cap.version, cap.agentIdentityHash, cap.agent,
        cap.chainId, cap.executor, cap.target, cap.value,
        cap.calldataHash, cap.intentHash, cap.policyHash, cap.authorizationId,
        cap.contextCommitment, cap.issuedAt, cap.expiresAt, cap.nonce,
      ],
    ),
  );
}

/**
 * Full EIP-712 digest.
 *
 * Computed via viem's `hashTypedData`, which implements EIP-712 from the standard. That makes
 * this a genuinely independent path from the Solidity `abi.encode` construction, so agreement
 * between them is evidence rather than tautology.
 */
export function capabilityDigest(cap: Capability): Hex {
  return hashTypedData({
    domain: domain(cap.chainId, cap.executor),
    types: CAPABILITY_TYPES,
    primaryType: "Capability",
    message: cap,
  });
}

/**
 * The canonical evaluation request the policy evaluator rules on.
 *
 * Covers the full transaction identity (target, value, calldataHash) but not nonce, expiry or
 * authorizationId — those belong to a capability issued against an approved request, not to the
 * request itself. The executor recomputes this from the capability it is asked to execute, so an
 * ALLOW granted for one transaction can never be spent on a different one.
 */
export function requestHash(cap: Capability): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" },
        { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" },
        { type: "bytes32" }, { type: "bytes32" },
      ],
      [
        REQUEST_TYPEHASH, cap.agentIdentityHash, cap.agent, cap.chainId,
        cap.executor, cap.target, cap.value, cap.calldataHash,
        cap.intentHash, cap.policyHash,
      ],
    ),
  );
}
