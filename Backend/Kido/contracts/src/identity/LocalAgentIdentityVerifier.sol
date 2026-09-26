// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAgentIdentityVerifier} from "../interfaces/IAgentIdentityVerifier.sol";

/// @title LocalAgentIdentityVerifier
/// @notice PHASE 1 ONLY. A local, admin-controlled stand-in for live ENS identity.
///
/// @dev This exists so the executor's identity invariant can be tested before ENS is wired, and
///      so Phase 3 can swap in `EnsAgentIdentityVerifier` without touching executor semantics.
///      It is NOT an ENS integration and must never be described as one.
contract LocalAgentIdentityVerifier is IAgentIdentityVerifier {
    error NotOwner();
    error ZeroOwner();

    address public owner;

    /// @notice agentIdentityHash => currently bound agent address (address(0) == revoked).
    mapping(bytes32 => address) public boundAgent;

    /// @notice Simulates a resolver/registry read failure so ID-006 fail-closed can be tested.
    bool public resolutionBroken;

    event IdentityBound(bytes32 indexed agentIdentityHash, address indexed agent);
    event IdentityRevoked(bytes32 indexed agentIdentityHash);
    event ResolutionBrokenSet(bool broken);

    constructor(address owner_) {
        // Owner zero would make bindings permanently immutable, so a revoked identity could never
        // be rebound and the verifier could never be corrected.
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function bind(bytes32 agentIdentityHash, address agent) external onlyOwner {
        boundAgent[agentIdentityHash] = agent;
        emit IdentityBound(agentIdentityHash, agent);
    }

    function revoke(bytes32 agentIdentityHash) external onlyOwner {
        delete boundAgent[agentIdentityHash];
        emit IdentityRevoked(agentIdentityHash);
    }

    function setResolutionBroken(bool broken) external onlyOwner {
        resolutionBroken = broken;
        emit ResolutionBrokenSet(broken);
    }

    /// @inheritdoc IAgentIdentityVerifier
    function isIdentityCurrent(bytes32 agentIdentityHash, address agent) external view returns (bool) {
        // Fail closed on resolution failure. Returning `true` here on error would be the exact
        // bug this interface exists to prevent.
        if (resolutionBroken) return false;
        address bound = boundAgent[agentIdentityHash];
        if (bound == address(0)) return false;
        return bound == agent;
    }
}
