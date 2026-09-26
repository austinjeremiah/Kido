// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Execution-time check that an agent identity is STILL valid right now.
///
/// @dev    This is the seam that makes ENS load-bearing rather than cosmetic. Phase 1 backs it
///         with a local admin-controlled verifier; Phase 3 replaces that with one that reads live
///         ENSv2 Sepolia state. The executor calls it identically either way.
///
///         The check must be live. A capability whose EIP-712 signature is still mathematically
///         valid and whose expiry has not passed MUST still fail once the underlying name is
///         unregistered, expired, or rebound to a different agent address.
interface IAgentIdentityVerifier {
    /// @return ok True only if `agentIdentityHash` currently resolves to `agent` under live state.
    /// @dev MUST fail closed: any resolution error, missing record or expiry yields false or a
    ///      revert. It must never return true from a cache that could outlive a revocation.
    function isIdentityCurrent(bytes32 agentIdentityHash, address agent) external view returns (bool ok);
}
