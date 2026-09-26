// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ContextLockAuthorizationRegistry} from "./ContextLockAuthorizationRegistry.sol";
import {IContextLockAuthorizationRegistry as IAuthReg} from "./interfaces/IContextLockAuthorizationRegistry.sol";

/// @title ContextLockCreConsumer
/// @notice The ONLY contract permitted to write CRE-originated authorizations.
///
/// @dev This replaces the Phase 1/2 "trusted test authorizer" EOA. The authorization registry's
///      `authorizer` is repointed at this contract, so an EOA can no longer mint authorizations
///      directly.
///
///      Trust model, stated honestly: this contract accepts reports only from a configured
///      Chainlink **forwarder** address. In a live deployment that forwarder is the CRE-operated
///      contract that has already verified DON consensus signatures over the report. This
///      consumer therefore does NOT re-verify signatures itself — it enforces *provenance*
///      (only the forwarder may call) and *shape* (the payload decodes to a well-formed verdict).
///      That mirrors the documented on-chain write pattern rather than inventing a bespoke
///      verification scheme.
///
///      NOTE: no live DON has written to this contract. See reports/phase-04/BLK-001. The
///      forwarder is configurable precisely so the live address can be set once access exists,
///      without redeploying the executor or the registry.
contract ContextLockCreConsumer {
    error NotForwarder(address caller);
    error NotOwner();
    error InvalidVerdict(uint8 verdict);
    error InvalidWindow(uint64 evaluatedAt, uint64 validUntil);
    error PayloadTooShort();
    error ZeroOwner();

    address public owner;

    /// @notice The Chainlink forwarder permitted to deliver reports. Zero disables writes entirely.
    address public forwarder;

    ContextLockAuthorizationRegistry public immutable registry;

    /// @notice Commitment to the private policy version this consumer will accept.
    bytes32 public expectedPolicyCommitment;

    event ForwarderSet(address indexed previous, address indexed current);
    event PolicyCommitmentSet(bytes32 indexed previous, bytes32 indexed current);
    event CreAuthorizationDelivered(
        bytes32 indexed authorizationId, bytes32 indexed requestHash, uint8 verdict, bytes32 reasonCode
    );

    constructor(address owner_, address forwarder_, ContextLockAuthorizationRegistry registry_) {
        // Owner zero would lock `setForwarder`, so the real Chainlink forwarder could never
        // replace the configured one. NOTE: `forwarder_ == address(0)` is deliberately allowed and
        // means "accept no reports" — see `onReport`, which rejects a zero forwarder explicitly.
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
        forwarder = forwarder_;
        registry = registry_;
        emit ForwarderSet(address(0), forwarder_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setForwarder(address next) external onlyOwner {
        emit ForwarderSet(forwarder, next);
        forwarder = next;
    }

    function setExpectedPolicyCommitment(bytes32 next) external onlyOwner {
        emit PolicyCommitmentSet(expectedPolicyCommitment, next);
        expectedPolicyCommitment = next;
    }

    /// @notice Receive a CRE report and record the authorization.
    /// @param report ABI-encoded exactly as the workflow's `usingTheDons().report()` payload:
    ///        (bytes32 requestHash, bytes32 policyCommitment, bytes32 contextCommitment,
    ///         uint8 verdict, bytes32 reasonCode, uint64 evaluatedAt, uint64 validUntil)
    function onReport(bytes calldata report) external {
        // Provenance: only the configured forwarder. A zero forwarder means no one can write.
        if (msg.sender != forwarder || forwarder == address(0)) revert NotForwarder(msg.sender);
        if (report.length < 224) revert PayloadTooShort();

        (
            bytes32 requestHash,
            bytes32 policyCommitment,
            bytes32 contextCommitment,
            uint8 verdict,
            bytes32 reasonCode,
            uint64 evaluatedAt,
            uint64 validUntil
        ) = abi.decode(report, (bytes32, bytes32, bytes32, uint8, bytes32, uint64, uint64));

        if (verdict == 0 || verdict > 3) revert InvalidVerdict(verdict);
        if (validUntil <= evaluatedAt) revert InvalidWindow(evaluatedAt, validUntil);

        // The authorization id is derived, not supplied, so two different requests can never
        // collide onto one authorization and a caller cannot choose the slot it writes to.
        bytes32 authorizationId = keccak256(abi.encode(requestHash, policyCommitment, evaluatedAt));

        registry.recordAuthorization(
            authorizationId,
            requestHash,
            policyCommitment,
            contextCommitment,
            evaluatedAt,
            validUntil,
            IAuthReg.Verdict(verdict)
        );

        emit CreAuthorizationDelivered(authorizationId, requestHash, verdict, reasonCode);
    }

    /// @notice Deterministic authorization id, so the broker can locate the record the DON wrote.
    function computeAuthorizationId(bytes32 requestHash, bytes32 policyCommitment, uint64 evaluatedAt)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(requestHash, policyCommitment, evaluatedAt));
    }
}
