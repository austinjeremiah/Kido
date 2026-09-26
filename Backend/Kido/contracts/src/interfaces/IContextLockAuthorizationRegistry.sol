// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Record of a policy evaluation for one exact request.
/// @dev    Phase 1 writes these from a trusted test authorizer. Phase 4 replaces the writer with
///         the Chainlink CRE report/forwarder path. The executor's read semantics do not change
///         between those phases — that is the point of this interface.
interface IContextLockAuthorizationRegistry {
    enum Verdict {
        NONE,
        ALLOW,
        ESCALATE,
        DENY
    }

    struct Authorization {
        bytes32 requestHash;
        bytes32 policyHash;
        bytes32 contextCommitment;
        uint64 evaluatedAt;
        uint64 approvedUntil;
        Verdict verdict;
    }

    function getAuthorization(bytes32 authorizationId) external view returns (Authorization memory);
}
