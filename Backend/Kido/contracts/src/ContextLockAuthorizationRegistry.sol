// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IContextLockAuthorizationRegistry} from "./interfaces/IContextLockAuthorizationRegistry.sol";

/// @title ContextLockAuthorizationRegistry
/// @notice Stores the policy verdict for one exact evaluation request.
///
/// @dev PHASE 1 uses a trusted authorizer address as the writer. PHASE 4 replaces that writer with
///      the Chainlink CRE forwarder/report path. The executor's read path is unchanged across that
///      swap, which is exactly why the authorizer is behind `setAuthorizer` rather than baked in.
///
///      This contract is NOT the CRE integration and does not claim to be. It is the consumer
///      shape the CRE write path will populate. Calling this "Chainlink integration" today would
///      be a false sponsor claim.
contract ContextLockAuthorizationRegistry is IContextLockAuthorizationRegistry {
    error NotAuthorizer();
    error NotOwner();
    error AuthorizationExists();
    error InvalidVerdict();
    error InvalidWindow();
    error ZeroOwner();

    address public owner;

    /// @notice The only address permitted to record authorizations.
    address public authorizer;

    mapping(bytes32 authorizationId => Authorization) internal _authorizations;

    event AuthorizerSet(address indexed previous, address indexed current);
    event AuthorizationRecorded(
        bytes32 indexed authorizationId,
        bytes32 indexed requestHash,
        Verdict verdict,
        uint64 evaluatedAt,
        uint64 approvedUntil
    );

    constructor(address owner_, address authorizer_) {
        // Owner zero would permanently lock `setAuthorizer`, bricking the CRE migration path.
        // NOTE: `authorizer_ == address(0)` is deliberately ALLOWED — it means "no writer", which
        // is fail-closed and is the correct state before a consumer is deployed.
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
        authorizer = authorizer_;
        emit AuthorizerSet(address(0), authorizer_);
    }

    function setAuthorizer(address next) external {
        if (msg.sender != owner) revert NotOwner();
        emit AuthorizerSet(authorizer, next);
        authorizer = next;
    }

    /// @notice Record a verdict. Authorizations are write-once: an authorizationId can never be
    ///         re-pointed at a different request or upgraded from ESCALATE/DENY to ALLOW.
    function recordAuthorization(
        bytes32 authorizationId,
        bytes32 requestHash,
        bytes32 policyHash,
        bytes32 contextCommitment,
        uint64 evaluatedAt,
        uint64 approvedUntil,
        Verdict verdict
    ) external {
        if (msg.sender != authorizer) revert NotAuthorizer();
        if (verdict == Verdict.NONE) revert InvalidVerdict();
        if (approvedUntil <= evaluatedAt) revert InvalidWindow();
        if (_authorizations[authorizationId].verdict != Verdict.NONE) revert AuthorizationExists();

        _authorizations[authorizationId] = Authorization({
            requestHash: requestHash,
            policyHash: policyHash,
            contextCommitment: contextCommitment,
            evaluatedAt: evaluatedAt,
            approvedUntil: approvedUntil,
            verdict: verdict
        });

        emit AuthorizationRecorded(authorizationId, requestHash, verdict, evaluatedAt, approvedUntil);
    }

    function getAuthorization(bytes32 authorizationId) external view returns (Authorization memory) {
        return _authorizations[authorizationId];
    }
}
