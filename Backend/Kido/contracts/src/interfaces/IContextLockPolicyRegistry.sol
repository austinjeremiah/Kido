// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Public, on-chain ContextLock policy: which agent identity may do what, to whom, up to
///         how much. This is where FINANCIAL authority lives.
///
/// @dev    Deliberately NOT in ENS. ENSv2 Enhanced Access Control defines roles per contract, and
///         the stock PermissionedRegistry roles are all name administration — ROLE_REGISTRAR,
///         ROLE_UNREGISTER, ROLE_RENEW, ROLE_SET_RESOLVER, ROLE_SET_SUBREGISTRY, ROLE_SET_PARENT,
///         ROLE_SET_URI, ROLE_UPGRADE, ROLE_REGISTER_RESERVED, ROLE_CAN_TRANSFER_ADMIN. None of
///         them mean "may spend". Verified against current docs in
///         reports/phase-00/findings/FND-003. ENS supplies identity and revocation; ContextLock
///         supplies spend authority.
interface IContextLockPolicyRegistry {
    function isPolicyEnabled(bytes32 agentIdentityHash, bytes32 policyHash) external view returns (bool);
    function isTargetAllowed(bytes32 agentIdentityHash, bytes32 policyHash, address target)
        external
        view
        returns (bool);
    function isActionAllowed(bytes32 agentIdentityHash, bytes32 policyHash, bytes32 actionKind)
        external
        view
        returns (bool);
    function maxValueHardCap(bytes32 agentIdentityHash, bytes32 policyHash) external view returns (uint256);

    /// @notice Monotonic binding version. Bumping it invalidates every outstanding capability
    ///         issued under the previous binding, even one correctly signed and unexpired.
    function bindingVersion(bytes32 agentIdentityHash) external view returns (uint64);
}
