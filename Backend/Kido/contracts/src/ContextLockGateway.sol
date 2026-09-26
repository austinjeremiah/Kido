// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ContextLockTypes} from "./ContextLockTypes.sol";

/// @title ContextLockGateway
/// @notice Records a capability-evaluation request and emits the canonical event the Chainlink CRE
///         workflow subscribes to with an EVM Log Trigger.
///
/// @dev The event carries the FULL calldata, not just its hash, because the confidential workflow
///      independently decodes the real recipient and amount from those bytes rather than trusting
///      anything the agent declared. See CRE-014.
contract ContextLockGateway {
    error ZeroTarget();

    struct Request {
        bytes32 agentIdentityHash;
        address agent;
        address target;
        uint256 value;
        bytes32 calldataHash;
        bytes32 policyId;
        uint64 policyVersion;
        uint64 firstRequestedAt;
        uint64 lastRequestedAt;
        /// How many times evaluation has been asked for. Re-requests are legitimate: a stale
        /// authorization must be re-evaluated against fresh context.
        uint64 requestCount;
        bool exists;
    }

    mapping(bytes32 requestHash => Request) public requests;

    event CapabilityRequested(
        bytes32 indexed requestHash,
        bytes32 indexed agentIdentityHash,
        address indexed agent,
        bytes32 ensNode,
        address target,
        uint256 value,
        bytes callData,
        bytes32 intentHash,
        bytes32 policyId,
        uint64 policyVersion,
        bytes32 actionKind
    );

    /// @notice Submit a request for confidential evaluation.
    ///
    /// @dev Anyone may submit — this only requests an opinion, it grants nothing. Authority comes
    ///      exclusively from the verdict the CRE workflow later writes, and from the executor's
    ///      own checks. Making this permissionless keeps a compromised relayer from being able to
    ///      block evaluation, while giving it no ability to influence the outcome.
    ///
    ///      Repeat requests for the SAME transaction are explicitly allowed and re-emit the event.
    ///      That is required by the freshness model: a short `approvedUntil` window means a stale
    ///      authorization must be re-evaluated against current context, and the request hash
    ///      deliberately excludes nonce and expiry so it stays identical to the one the executor
    ///      recomputes. An earlier write-once version of this function made re-evaluation
    ///      impossible and let anyone permanently burn a victim's request hash — see FND-010.
    function requestEvaluation(
        bytes32 agentIdentityHash,
        address agent,
        bytes32 ensNode,
        address target,
        uint256 value,
        bytes calldata callData,
        bytes32 intentHash,
        bytes32 policyId,
        uint64 policyVersion,
        bytes32 actionKind
    ) external returns (bytes32 requestHash) {
        if (target == address(0)) revert ZeroTarget();

        // Exactly the canonical request identity the executor recomputes from the capability it
        // executes. Must not diverge: that binding is what stops an ALLOW issued for one
        // transaction being spent on another.
        requestHash = keccak256(
            abi.encode(
                ContextLockTypes.REQUEST_TYPEHASH,
                agentIdentityHash,
                agent,
                block.chainid,
                _executorBinding,
                target,
                value,
                keccak256(callData),
                intentHash,
                policyId
            )
        );

        Request storage r = requests[requestHash];
        if (!r.exists) {
            r.agentIdentityHash = agentIdentityHash;
            r.agent = agent;
            r.target = target;
            r.value = value;
            r.calldataHash = keccak256(callData);
            r.policyId = policyId;
            r.firstRequestedAt = uint64(block.timestamp);
            r.exists = true;
        }
        // Policy version and timing are refreshed on every request so the record reflects the
        // most recent evaluation ask.
        r.policyVersion = policyVersion;
        r.lastRequestedAt = uint64(block.timestamp);
        r.requestCount += 1;

        emit CapabilityRequested(
            requestHash,
            agentIdentityHash,
            agent,
            ensNode,
            target,
            value,
            callData,
            intentHash,
            policyId,
            policyVersion,
            actionKind
        );
    }

    address internal immutable _executorBinding;

    constructor(address executor_) {
        // The executor address is baked into every request hash this gateway produces. A zero
        // value would silently generate hashes that no executor can ever match.
        if (executor_ == address(0)) revert ZeroTarget();
        _executorBinding = executor_;
    }

    function executor() external view returns (address) {
        return _executorBinding;
    }
}
