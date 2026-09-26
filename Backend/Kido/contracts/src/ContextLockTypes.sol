// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The single canonical definition of a ContextLock capability.
/// @dev    This struct and the two typehashes below are the schema. The TypeScript package
///         `@contextlock/protocol` re-implements the same schema independently, and
///         `packages/protocol/test-vectors/` holds golden digests both sides must reproduce.
///         Changing a field here is a protocol change: regenerate vectors and bump `VERSION`.
struct Capability {
    uint8 version;
    bytes32 agentIdentityHash;
    address agent;
    uint256 chainId;
    address executor;
    address target;
    uint256 value;
    bytes32 calldataHash;
    bytes32 intentHash;
    bytes32 policyHash;
    bytes32 authorizationId;
    bytes32 contextCommitment;
    uint64 issuedAt;
    uint64 expiresAt;
    uint256 nonce;
}

library ContextLockTypes {
    /// @dev Current capability schema version. The executor rejects anything else.
    uint8 internal constant VERSION = 1;

    string internal constant CAPABILITY_TYPE =
        "Capability(uint8 version,bytes32 agentIdentityHash,address agent,uint256 chainId,address executor,address target,uint256 value,bytes32 calldataHash,bytes32 intentHash,bytes32 policyHash,bytes32 authorizationId,bytes32 contextCommitment,uint64 issuedAt,uint64 expiresAt,uint256 nonce)";

    bytes32 internal constant CAPABILITY_TYPEHASH = keccak256(bytes(CAPABILITY_TYPE));

    /// @dev The canonical evaluation request. This is what the policy evaluator (a trusted
    ///      authorizer in Phase 1, Chainlink CRE in Phase 4) is asked to rule on.
    ///
    ///      It deliberately covers the full transaction identity — target, value and
    ///      calldataHash — but NOT nonce, expiry or authorizationId. Those are properties of a
    ///      particular capability issued against an approved request, not of the request itself.
    ///      Because the executor recomputes this hash from the capability it is executing and
    ///      compares it to the stored authorization, an authorization approved for one
    ///      transaction can never be spent on a different one.
    string internal constant REQUEST_TYPE =
        "EvaluationRequest(bytes32 agentIdentityHash,address agent,uint256 chainId,address executor,address target,uint256 value,bytes32 calldataHash,bytes32 intentHash,bytes32 policyHash)";

    bytes32 internal constant REQUEST_TYPEHASH = keccak256(bytes(REQUEST_TYPE));

    function hashStruct(Capability memory cap) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CAPABILITY_TYPEHASH,
                cap.version,
                cap.agentIdentityHash,
                cap.agent,
                cap.chainId,
                cap.executor,
                cap.target,
                cap.value,
                cap.calldataHash,
                cap.intentHash,
                cap.policyHash,
                cap.authorizationId,
                cap.contextCommitment,
                cap.issuedAt,
                cap.expiresAt,
                cap.nonce
            )
        );
    }

    /// @notice Recompute the evaluation request this capability claims to have been approved under.
    function requestHash(Capability memory cap) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                REQUEST_TYPEHASH,
                cap.agentIdentityHash,
                cap.agent,
                cap.chainId,
                cap.executor,
                cap.target,
                cap.value,
                cap.calldataHash,
                cap.intentHash,
                cap.policyHash
            )
        );
    }
}
