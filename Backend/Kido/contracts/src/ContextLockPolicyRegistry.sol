// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IContextLockPolicyRegistry} from "./interfaces/IContextLockPolicyRegistry.sol";

/// @title ContextLockPolicyRegistry
/// @notice Public financial authority for ContextLock agent identities.
/// @dev See IContextLockPolicyRegistry for why this is not expressed as ENS roles.
contract ContextLockPolicyRegistry is IContextLockPolicyRegistry {
    error NotAdmin();
    error ZeroAdmin();

    struct Policy {
        bool enabled;
        uint256 maxValueHardCap;
    }

    /// @notice Owner of an agent identity's policy configuration.
    mapping(bytes32 agentIdentityHash => address) public policyAdmin;

    mapping(bytes32 agentIdentityHash => mapping(bytes32 policyHash => Policy)) internal _policies;
    mapping(bytes32 agentIdentityHash => mapping(bytes32 policyHash => mapping(address => bool))) internal
        _allowedTarget;
    mapping(bytes32 agentIdentityHash => mapping(bytes32 policyHash => mapping(bytes32 => bool))) internal
        _allowedAction;
    mapping(bytes32 agentIdentityHash => uint64) internal _bindingVersion;

    event PolicyAdminSet(bytes32 indexed agentIdentityHash, address indexed admin);
    event PolicySet(
        bytes32 indexed agentIdentityHash, bytes32 indexed policyHash, bool enabled, uint256 maxValueHardCap
    );
    event TargetAllowed(
        bytes32 indexed agentIdentityHash, bytes32 indexed policyHash, address indexed target, bool allowed
    );
    event ActionAllowed(
        bytes32 indexed agentIdentityHash, bytes32 indexed policyHash, bytes32 indexed actionKind, bool allowed
    );
    event BindingVersionBumped(bytes32 indexed agentIdentityHash, uint64 newVersion);

    modifier onlyAdmin(bytes32 agentIdentityHash) {
        if (msg.sender != policyAdmin[agentIdentityHash]) revert NotAdmin();
        _;
    }

    /// @notice Claim administration of an unowned agent identity, or transfer it as current admin.
    function setPolicyAdmin(bytes32 agentIdentityHash, address admin) external {
        if (admin == address(0)) revert ZeroAdmin();
        address current = policyAdmin[agentIdentityHash];
        if (current != address(0) && msg.sender != current) revert NotAdmin();
        policyAdmin[agentIdentityHash] = admin;
        // A fresh identity starts at binding version 1 so that 0 always means "never configured".
        if (_bindingVersion[agentIdentityHash] == 0) {
            _bindingVersion[agentIdentityHash] = 1;
            emit BindingVersionBumped(agentIdentityHash, 1);
        }
        emit PolicyAdminSet(agentIdentityHash, admin);
    }

    function setPolicy(bytes32 agentIdentityHash, bytes32 policyHash, bool enabled, uint256 cap)
        external
        onlyAdmin(agentIdentityHash)
    {
        _policies[agentIdentityHash][policyHash] = Policy({enabled: enabled, maxValueHardCap: cap});
        emit PolicySet(agentIdentityHash, policyHash, enabled, cap);
    }

    function setTargetAllowed(bytes32 agentIdentityHash, bytes32 policyHash, address target, bool allowed)
        external
        onlyAdmin(agentIdentityHash)
    {
        _allowedTarget[agentIdentityHash][policyHash][target] = allowed;
        emit TargetAllowed(agentIdentityHash, policyHash, target, allowed);
    }

    function setActionAllowed(bytes32 agentIdentityHash, bytes32 policyHash, bytes32 actionKind, bool allowed)
        external
        onlyAdmin(agentIdentityHash)
    {
        _allowedAction[agentIdentityHash][policyHash][actionKind] = allowed;
        emit ActionAllowed(agentIdentityHash, policyHash, actionKind, allowed);
    }

    /// @notice Invalidate every outstanding capability for this identity in one transaction.
    /// @dev This is the ContextLock-side revocation lever, independent of ENS. Used by ID-005.
    function bumpBindingVersion(bytes32 agentIdentityHash) external onlyAdmin(agentIdentityHash) returns (uint64 v) {
        v = _bindingVersion[agentIdentityHash] + 1;
        _bindingVersion[agentIdentityHash] = v;
        emit BindingVersionBumped(agentIdentityHash, v);
    }

    function isPolicyEnabled(bytes32 a, bytes32 p) external view returns (bool) {
        return _policies[a][p].enabled;
    }

    function isTargetAllowed(bytes32 a, bytes32 p, address t) external view returns (bool) {
        return _allowedTarget[a][p][t];
    }

    function isActionAllowed(bytes32 a, bytes32 p, bytes32 k) external view returns (bool) {
        return _allowedAction[a][p][k];
    }

    function maxValueHardCap(bytes32 a, bytes32 p) external view returns (uint256) {
        return _policies[a][p].maxValueHardCap;
    }

    function bindingVersion(bytes32 a) external view returns (uint64) {
        return _bindingVersion[a];
    }
}
