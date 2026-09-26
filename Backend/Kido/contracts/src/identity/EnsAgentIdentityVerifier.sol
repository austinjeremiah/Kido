// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAgentIdentityVerifier} from "../interfaces/IAgentIdentityVerifier.sol";

/// @notice Minimal view of the ENSv2 PermissionedRegistry that ContextLock depends on.
/// @dev Signatures taken from the published ENSv2 deployment artifacts, not from memory.
interface IEnsV2Registry {
    /// @return The current owner, or address(0) once the name has expired.
    function ownerOf(uint256 tokenId) external view returns (address);
    /// @return The historical owner, which SURVIVES expiry. Never use this for authorization.
    function latestOwnerOf(uint256 tokenId) external view returns (address);
    function getExpiry(uint256 anyId) external view returns (uint64);
    /// @dev Token ids are regenerated on role changes and on re-registration.
    function getTokenId(uint256 anyId) external view returns (uint256);
    function getResolver(string calldata label) external view returns (address);
}

/// @title EnsAgentIdentityVerifier
/// @notice Makes ENSv2 load-bearing: an outstanding, correctly-signed, unexpired capability stops
///         working the moment the underlying ENS name is unregistered, expires, or is rebound.
///
/// @dev This contract is read at EXECUTION time by `ContextLockExecutor`, not merely at issuance.
///      That is the whole point. A cached off-chain resolution could not produce this property,
///      because the executor would have no way to notice a revocation that happened after the
///      capability was signed.
///
///      Three deliberate choices:
///
///      1. `ownerOf` is used, never `latestOwnerOf`. ENSv2 returns `address(0)` from `ownerOf`
///         once a name expires while `latestOwnerOf` still returns the historical owner. Using
///         the latter would make an expired name look valid — the exact bug ID-003 tests for.
///
///      2. The agent identity hash commits to the ENS **token id**, which ENSv2 regenerates on
///         `grantRoles`/`revokeRoles` and on re-registration of an expired name. So an ENS role
///         change is itself an identity change, and invalidates outstanding capabilities without
///         ContextLock needing to observe the specific role.
///
///      3. Every failure path returns false. There is no branch that can return true on a
///         resolution error, which is what "fail closed" has to mean in code.
contract EnsAgentIdentityVerifier is IAgentIdentityVerifier {
    error NotOwner();
    error ZeroOwner();
    error AlreadyBound();
    error NotBound();

    struct Binding {
        /// The ENSv2 registry this identity is anchored to.
        IEnsV2Registry registry;
        /// Label hash used as the registry id for this name.
        uint256 labelId;
        /// The ENS name's owner at bind time. If the name is transferred, this stops matching
        /// and every outstanding capability for this identity dies — an ENS-level rebind.
        address expectedNameOwner;
        /// The agent address this identity authorizes.
        address expectedAgent;
        /// Token id observed at bind time. A change means roles or registration changed.
        uint256 boundTokenId;
        /// ContextLock-side binding version, an independent revocation lever.
        uint64 bindingVersion;
        bool exists;
    }

    address public owner;
    mapping(bytes32 agentIdentityHash => Binding) public bindings;

    /// @notice Test-only switch that simulates an unreachable registry, so ID-006 fail-closed
    ///         behaviour is provable on a real deployment without breaking ENS itself.
    bool public simulateRegistryOutage;

    event AgentBound(
        bytes32 indexed agentIdentityHash,
        address indexed registry,
        uint256 labelId,
        address indexed expectedAgent,
        address expectedNameOwner,
        uint256 boundTokenId,
        uint64 bindingVersion
    );
    event AgentUnbound(bytes32 indexed agentIdentityHash);
    event RegistryOutageSimulated(bool enabled);

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

    /// @notice Compute the identity hash. Deterministic and reproduced identically off-chain by
    ///         `packages/ens`, so the broker and the executor agree on what "this agent" means.
    function computeIdentityHash(
        address registry,
        uint256 labelId,
        address nameOwner,
        address agent,
        uint256 tokenId,
        uint64 bindingVersion
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(registry, labelId, nameOwner, agent, tokenId, bindingVersion));
    }

    /// @notice Bind an agent to a live ENS name. Reads current registry state at bind time, so
    ///         the identity is anchored to the name AS IT IS NOW.
    function bind(IEnsV2Registry registry, uint256 labelId, address expectedAgent, uint64 bindingVersion)
        external
        onlyOwner
        returns (bytes32 agentIdentityHash)
    {
        uint256 tokenId = registry.getTokenId(labelId);
        address nameOwner = registry.ownerOf(tokenId);
        require(nameOwner != address(0), "ENS name not currently registered");

        agentIdentityHash =
            computeIdentityHash(address(registry), labelId, nameOwner, expectedAgent, tokenId, bindingVersion);

        if (bindings[agentIdentityHash].exists) revert AlreadyBound();

        bindings[agentIdentityHash] = Binding({
            registry: registry,
            labelId: labelId,
            expectedNameOwner: nameOwner,
            expectedAgent: expectedAgent,
            boundTokenId: tokenId,
            bindingVersion: bindingVersion,
            exists: true
        });

        emit AgentBound(
            agentIdentityHash, address(registry), labelId, expectedAgent, nameOwner, tokenId, bindingVersion
        );
    }

    function unbind(bytes32 agentIdentityHash) external onlyOwner {
        if (!bindings[agentIdentityHash].exists) revert NotBound();
        delete bindings[agentIdentityHash];
        emit AgentUnbound(agentIdentityHash);
    }

    function setSimulateRegistryOutage(bool v) external onlyOwner {
        simulateRegistryOutage = v;
        emit RegistryOutageSimulated(v);
    }

    /// @notice Full live check. Every negative path returns false; none can return true on error.
    function isIdentityCurrent(bytes32 agentIdentityHash, address agent) external view returns (bool) {
        if (simulateRegistryOutage) return false;

        Binding memory b = bindings[agentIdentityHash];
        if (!b.exists) return false;
        if (b.expectedAgent != agent) return false;

        // Registration + expiry. `ownerOf` returns address(0) for an expired name; a low-level
        // staticcall keeps a reverting or missing registry from bubbling up as anything other
        // than "not current".
        (bool okOwner, bytes memory ownerRet) =
            address(b.registry).staticcall(abi.encodeCall(IEnsV2Registry.ownerOf, (b.boundTokenId)));
        if (!okOwner || ownerRet.length < 32) return false;
        address currentOwner = abi.decode(ownerRet, (address));
        // address(0) means unregistered OR expired — ENSv2 zeroes ownerOf past expiry.
        if (currentOwner == address(0)) return false;
        // A transfer of the name is an ENS-level rebind: authority does not follow the token.
        if (currentOwner != b.expectedNameOwner) return false;

        (bool okExpiry, bytes memory expiryRet) =
            address(b.registry).staticcall(abi.encodeCall(IEnsV2Registry.getExpiry, (b.labelId)));
        if (!okExpiry || expiryRet.length < 32) return false;
        uint64 expiry = abi.decode(expiryRet, (uint64));
        if (expiry <= block.timestamp) return false;

        // Token id: changes on role grant/revoke and on re-registration. Catching this means an
        // ENS permission change invalidates outstanding ContextLock authority automatically.
        (bool okToken, bytes memory tokenRet) =
            address(b.registry).staticcall(abi.encodeCall(IEnsV2Registry.getTokenId, (b.labelId)));
        if (!okToken || tokenRet.length < 32) return false;
        uint256 currentTokenId = abi.decode(tokenRet, (uint256));
        if (currentTokenId != b.boundTokenId) return false;

        // Finally, the hash must reproduce from live state — so a rebind to a different agent, or
        // any drift in the committed fields, fails even if each field looked individually fine.
        bytes32 recomputed = computeIdentityHash(
            address(b.registry), b.labelId, currentOwner, b.expectedAgent, currentTokenId, b.bindingVersion
        );
        return recomputed == agentIdentityHash;
    }

    /// @notice Diagnostic breakdown, so a failure can be explained precisely in the demo and in
    ///         evidence rather than reported as an opaque false.
    function diagnose(bytes32 agentIdentityHash, address agent)
        external
        view
        returns (
            bool bound,
            bool agentMatches,
            bool ownerMatches,
            address currentOwner,
            uint64 expiry,
            bool expired,
            uint256 boundTokenId,
            uint256 currentTokenId,
            bool tokenIdMatches
        )
    {
        Binding memory b = bindings[agentIdentityHash];
        bound = b.exists;
        if (!bound) return (false, false, false, address(0), 0, true, 0, 0, false);
        agentMatches = b.expectedAgent == agent;
        boundTokenId = b.boundTokenId;
        try b.registry.ownerOf(b.boundTokenId) returns (address o) {
            currentOwner = o;
        } catch {}
        ownerMatches = currentOwner == b.expectedNameOwner;
        try b.registry.getExpiry(b.labelId) returns (uint64 e) {
            expiry = e;
        } catch {}
        expired = expiry <= block.timestamp;
        try b.registry.getTokenId(b.labelId) returns (uint256 t) {
            currentTokenId = t;
        } catch {}
        tokenIdMatches = currentTokenId == boundTokenId;
    }
}
