// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Capability, ContextLockTypes} from "./ContextLockTypes.sol";
import {IContextLockPolicyRegistry} from "./interfaces/IContextLockPolicyRegistry.sol";
import {IContextLockAuthorizationRegistry as IAuthReg} from "./interfaces/IContextLockAuthorizationRegistry.sol";
import {IAgentIdentityVerifier} from "./interfaces/IAgentIdentityVerifier.sol";

interface IContextLockApprovalRegistry {
    function isApprovalValid(bytes32 capabilityDigest) external view returns (bool);
    function consumeApproval(bytes32 capabilityDigest) external;
}

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// @title ContextLockExecutor
/// @notice The reference monitor. The only contract permitted to turn a capability into a call.
///
/// @dev Design rules this contract is built to honour:
///
///      - It is boring on purpose. It validates immutable facts, live identity, live policy, a
///        fresh authorization, nonce and the exact call. Risk reasoning belongs in the policy
///        evaluator, not here.
///      - EIP-712 provides NO replay protection (see EIP-712, Rationale). Replay protection here
///        is the explicit nonce + expiry + live-state checks below.
///      - Everything reverts BEFORE any external interaction. There is no code path that touches
///        the target before all validation has passed.
contract ContextLockExecutor {
    using ContextLockTypes for Capability;

    // ---------------------------------------------------------------- errors

    error UnsupportedVersion(uint8 got, uint8 expected);
    error ChainMismatch(uint256 got, uint256 expected);
    error ExecutorMismatch(address got, address expected);
    error CapabilityExpired(uint64 expiresAt, uint256 nowTs);
    error IssuedInFuture(uint64 issuedAt, uint256 nowTs);
    error InvalidTimeWindow();
    error NonceUsed(uint256 nonce);
    error CalldataHashMismatch(bytes32 got, bytes32 expected);
    error ValueMismatch(uint256 sent, uint256 expected);
    error InvalidSignature();
    error IdentityNotCurrent(bytes32 agentIdentityHash, address agent);
    error PolicyDisabled(bytes32 agentIdentityHash, bytes32 policyHash);
    error TargetNotAllowed(address target);
    error ValueExceedsHardCap(uint256 value, uint256 cap);
    error BindingVersionChanged(uint64 got, uint64 expected);
    error AuthorizationMissing(bytes32 authorizationId);
    error AuthorizationRequestMismatch(bytes32 got, bytes32 expected);
    error AuthorizationPolicyMismatch();
    error AuthorizationContextMismatch();
    error AuthorizationNotAllow(uint8 verdict);
    error HumanApprovalRequired(bytes32 capabilityDigest);
    error HumanApprovalUnavailable();
    error AuthorizationStale(uint64 approvedUntil, uint256 nowTs);
    error Reentrancy();
    error TargetCallFailed(bytes returnData);
    error ZeroTarget();
    error ZeroIssuer();

    // ---------------------------------------------------------------- config

    bytes32 public immutable DOMAIN_SEPARATOR;
    uint256 public immutable DEPLOY_CHAIN_ID;

    IContextLockPolicyRegistry public immutable policyRegistry;
    IAuthReg public immutable authorizationRegistry;
    IAgentIdentityVerifier public immutable identityVerifier;

    /// @notice The capability issuer (broker signing key, or an ERC-1271 contract).
    address public immutable capabilityIssuer;

    /// @notice Human (Ledger) approval registry, consulted ONLY on the ESCALATE branch.
    /// @dev See docs/adr/ADR-001. Zero address means ESCALATE has no path to execution at all,
    ///      which is the pre-Phase-7 behaviour.
    IContextLockApprovalRegistry public immutable approvalRegistry;

    /// @notice Tolerance for a capability issued slightly ahead of block time.
    uint64 public constant MAX_CLOCK_SKEW = 60;

    /// @notice Upper bound on capability lifetime. Long-lived capabilities defeat freshness.
    uint64 public constant MAX_CAPABILITY_LIFETIME = 1 hours;

    mapping(bytes32 agentIdentityHash => mapping(uint256 nonce => bool)) public nonceUsed;

    uint256 private _entered;

    event CapabilityExecuted(
        bytes32 indexed capabilityDigest,
        bytes32 indexed agentIdentityHash,
        address indexed target,
        address agent,
        uint256 value,
        uint256 nonce,
        bytes32 authorizationId
    );

    constructor(
        address capabilityIssuer_,
        IContextLockPolicyRegistry policyRegistry_,
        IAuthReg authorizationRegistry_,
        IAgentIdentityVerifier identityVerifier_,
        IContextLockApprovalRegistry approvalRegistry_
    ) {
        // A zero issuer would be a silently broken deployment: `_isValidIssuerSignature` already
        // rejects an address(0) recovery, so every execution would fail with InvalidSignature and
        // the cause would be invisible. Fail at construction instead.
        if (capabilityIssuer_ == address(0)) revert ZeroIssuer();
        capabilityIssuer = capabilityIssuer_;
        approvalRegistry = approvalRegistry_;
        policyRegistry = policyRegistry_;
        authorizationRegistry = authorizationRegistry_;
        identityVerifier = identityVerifier_;
        DEPLOY_CHAIN_ID = block.chainid;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ContextLock"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------------------------------------------------------------- views

    /// @notice EIP-712 digest of a capability under this executor's domain.
    function digest(Capability calldata cap) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, ContextLockTypes.hashStruct(cap)));
    }

    function requestHashOf(Capability calldata cap) public pure returns (bytes32) {
        return ContextLockTypes.requestHash(cap);
    }

    // ---------------------------------------------------------------- execute

    /// @notice Execute exactly the call this capability authorizes, once.
    /// @param cap        The signed capability.
    /// @param signature  Issuer signature over the EIP-712 digest (EOA 65-byte, or ERC-1271).
    /// @param callData   The exact bytes to send. keccak256 must equal cap.calldataHash.
    /// @param actionKind The declared action class, checked against public policy.
    ///
    /// @dev `msg.sender` is deliberately unconstrained: any relayer may submit. All authority
    ///      lives inside the signed capability, not in who pays gas. This is the model the bible
    ///      requires be picked explicitly and tested (executor invariant 3).
    function execute(Capability calldata cap, bytes calldata signature, bytes calldata callData, bytes32 actionKind)
        external
        payable
        returns (bytes memory result)
    {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;

        bytes32 capDigest = _validate(cap, signature, callData, actionKind);

        // Consume the nonce before the external call. Note the honest caveat: if the target
        // reverts, the whole transaction reverts and this consumption rolls back with it. That is
        // accepted MVP semantics (bible executor invariant 12) — permanent one-shot consumption
        // across a failed target would require a two-transaction reservation design. Tests assert
        // the real behaviour rather than claiming consumption that does not survive a revert.
        nonceUsed[cap.agentIdentityHash][cap.nonce] = true;

        // Consume the human approval, if this execution needed one. Single-use: an approval
        // cannot authorize a second execution.
        if (
            address(approvalRegistry) != address(0)
                && authorizationRegistry.getAuthorization(cap.authorizationId).verdict == IAuthReg.Verdict.ESCALATE
        ) {
            approvalRegistry.consumeApproval(capDigest);
        }

        (bool ok, bytes memory ret) = cap.target.call{value: cap.value}(callData);
        if (!ok) revert TargetCallFailed(ret);

        _emitExecuted(capDigest, cap);

        _entered = 0;
        return ret;
    }

    /// @dev Split out purely to keep `execute` under the stack limit without via-ir.
    function _emitExecuted(bytes32 capDigest, Capability calldata cap) private {
        emit CapabilityExecuted(
            capDigest, cap.agentIdentityHash, cap.target, cap.agent, cap.value, cap.nonce, cap.authorizationId
        );
    }

    // ---------------------------------------------------------------- validation

    function _validate(Capability calldata cap, bytes calldata signature, bytes calldata callData, bytes32 actionKind)
        internal
        view
        returns (bytes32 capDigest)
    {
        // 1. Schema version.
        if (cap.version != ContextLockTypes.VERSION) {
            revert UnsupportedVersion(cap.version, ContextLockTypes.VERSION);
        }

        // 2. Chain and executor binding. Present in the EIP-712 domain AND in the struct; the
        //    redundancy is intentional so a domain mistake cannot silently widen scope.
        if (cap.chainId != block.chainid) revert ChainMismatch(cap.chainId, block.chainid);
        if (cap.executor != address(this)) revert ExecutorMismatch(cap.executor, address(this));
        if (cap.target == address(0)) revert ZeroTarget();

        // 3. Time window.
        if (cap.expiresAt <= cap.issuedAt) revert InvalidTimeWindow();
        if (cap.expiresAt - cap.issuedAt > MAX_CAPABILITY_LIFETIME) revert InvalidTimeWindow();
        if (block.timestamp > cap.expiresAt) revert CapabilityExpired(cap.expiresAt, block.timestamp);
        if (cap.issuedAt > block.timestamp + MAX_CLOCK_SKEW) revert IssuedInFuture(cap.issuedAt, block.timestamp);

        // 4. One-time authority.
        if (nonceUsed[cap.agentIdentityHash][cap.nonce]) revert NonceUsed(cap.nonce);

        // 5. Exact transaction binding.
        bytes32 actualCalldataHash = keccak256(callData);
        if (actualCalldataHash != cap.calldataHash) {
            revert CalldataHashMismatch(actualCalldataHash, cap.calldataHash);
        }
        if (msg.value != cap.value) revert ValueMismatch(msg.value, cap.value);

        // 6. Issuer signature.
        capDigest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, ContextLockTypes.hashStruct(cap)));
        if (!_isValidIssuerSignature(capDigest, signature)) revert InvalidSignature();

        // 7. Live identity. A valid signature on an unexpired capability is not enough: the
        //    identity must still be bound right now.
        if (!identityVerifier.isIdentityCurrent(cap.agentIdentityHash, cap.agent)) {
            revert IdentityNotCurrent(cap.agentIdentityHash, cap.agent);
        }

        // 8. Live public policy.
        if (!policyRegistry.isPolicyEnabled(cap.agentIdentityHash, cap.policyHash)) {
            revert PolicyDisabled(cap.agentIdentityHash, cap.policyHash);
        }
        if (!policyRegistry.isTargetAllowed(cap.agentIdentityHash, cap.policyHash, cap.target)) {
            revert TargetNotAllowed(cap.target);
        }
        if (!policyRegistry.isActionAllowed(cap.agentIdentityHash, cap.policyHash, actionKind)) {
            revert TargetNotAllowed(cap.target);
        }
        uint256 cap_ = policyRegistry.maxValueHardCap(cap.agentIdentityHash, cap.policyHash);
        if (cap.value > cap_) revert ValueExceedsHardCap(cap.value, cap_);

        // 9. Fresh authorization for THIS exact request (and, for ESCALATE, human approval).
        _validateAuthorization(cap, capDigest);
    }

    function _validateAuthorization(Capability calldata cap, bytes32 capDigest) internal view {
        IAuthReg.Authorization memory auth = authorizationRegistry.getAuthorization(cap.authorizationId);

        if (auth.verdict == IAuthReg.Verdict.NONE) revert AuthorizationMissing(cap.authorizationId);

        // ESCALATE is structurally permitted but is NOT autonomous authority.
        //
        // ALLOW    -> proceed, the approval registry is never consulted.
        // ESCALATE -> a live, unconsumed, unexpired approval bound to THIS capability digest must
        //             already exist. The executor never reinterprets ESCALATE as ALLOW.
        // DENY     -> revert unconditionally. There is deliberately no branch here that a DENY can
        //             reach, so no human approval can rescue one. See docs/adr/ADR-001.
        if (auth.verdict == IAuthReg.Verdict.ESCALATE) {
            if (address(approvalRegistry) == address(0)) revert HumanApprovalUnavailable();
            if (!approvalRegistry.isApprovalValid(capDigest)) revert HumanApprovalRequired(capDigest);
        } else if (auth.verdict != IAuthReg.Verdict.ALLOW) {
            revert AuthorizationNotAllow(uint8(auth.verdict));
        }

        // The authorization was granted for one exact transaction. Recompute that request from
        // the capability being executed; if the agent swapped target, value or calldata, the
        // hashes diverge and an ALLOW for a different action cannot be spent here.
        bytes32 expected = ContextLockTypes.requestHash(cap);
        if (auth.requestHash != expected) revert AuthorizationRequestMismatch(auth.requestHash, expected);

        if (auth.policyHash != cap.policyHash) revert AuthorizationPolicyMismatch();
        if (auth.contextCommitment != cap.contextCommitment) revert AuthorizationContextMismatch();

        // Freshness. Context cannot be re-observed at execution time, so a bounded approval
        // window is how "stale context stops working" is actually enforced.
        if (block.timestamp > auth.approvedUntil) revert AuthorizationStale(auth.approvedUntil, block.timestamp);
    }

    function _isValidIssuerSignature(bytes32 hash, bytes calldata signature) internal view returns (bool) {
        if (capabilityIssuer.code.length == 0) {
            if (signature.length != 65) return false;
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := calldataload(signature.offset)
                s := calldataload(add(signature.offset, 32))
                v := byte(0, calldataload(add(signature.offset, 64)))
            }
            // Reject the malleable upper half of the curve order and invalid v.
            if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return false;
            if (v != 27 && v != 28) return false;
            address recovered = ecrecover(hash, v, r, s);
            return recovered != address(0) && recovered == capabilityIssuer;
        }
        // ERC-1271 contract issuer.
        try IERC1271(capabilityIssuer).isValidSignature(hash, signature) returns (bytes4 magic) {
            return magic == IERC1271.isValidSignature.selector;
        } catch {
            return false;
        }
    }
}
