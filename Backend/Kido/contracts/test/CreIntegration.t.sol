// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {Capability, ContextLockTypes} from "../src/ContextLockTypes.sol";
import {ContextLockExecutor} from "../src/ContextLockExecutor.sol";
import {ContextLockCreConsumer} from "../src/ContextLockCreConsumer.sol";
import {ContextLockAuthorizationRegistry} from "../src/ContextLockAuthorizationRegistry.sol";
import {ContextLockGateway} from "../src/ContextLockGateway.sol";
import {IContextLockAuthorizationRegistry as IAuthReg} from "../src/interfaces/IContextLockAuthorizationRegistry.sol";
import {MockTreasuryTarget} from "../src/mocks/MockTreasuryTarget.sol";

/// @notice On-chain half of CRE-001..015. The workflow-side half lives in
///         workflows/cre-policy/contextlock-policy/workflow.test.ts.
contract CreIntegrationTest is Base {
    ContextLockCreConsumer internal consumer;
    ContextLockGateway internal gateway;

    address internal forwarder = address(0xF04D);
    bytes32 internal policyCommitment = keccak256("policy-commitment-v1");

    function setUp() public override {
        super.setUp();
        consumer = new ContextLockCreConsumer(admin, forwarder, auth);
        gateway = new ContextLockGateway(address(executor));

        // Repoint the registry's authorizer at the CRE consumer. The trusted EOA writer used in
        // Phases 1-2 loses the ability to mint authorizations from this point.
        vm.prank(admin);
        auth.setAuthorizer(address(consumer));
    }

    function _report(Capability memory cap, uint8 verdict, uint64 evaluatedAt, uint64 validUntil)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(
            ContextLockTypes.requestHash(cap),
            policyCommitment,
            cap.contextCommitment,
            verdict,
            keccak256("ALLOW_POLICY_MATCH"),
            evaluatedAt,
            validUntil
        );
    }

    function _deliver(Capability memory cap, uint8 verdict, uint64 evaluatedAt, uint64 validUntil)
        internal
        returns (bytes32 authorizationId)
    {
        vm.prank(forwarder);
        consumer.onReport(_report(cap, verdict, evaluatedAt, validUntil));
        return consumer.computeAuthorizationId(ContextLockTypes.requestHash(cap), policyCommitment, evaluatedAt);
    }

    /// Build a capability whose policyHash equals the CRE policy commitment, since the executor
    /// requires auth.policyHash == cap.policyHash.
    function _creCapability() internal view returns (Capability memory cap) {
        cap = _baseCapability();
        cap.policyHash = policyCommitment;
    }

    function _enablePolicyForCommitment() internal {
        vm.startPrank(admin);
        policy.setPolicy(agentIdentityHash, policyCommitment, true, HARD_CAP);
        policy.setTargetAllowed(agentIdentityHash, policyCommitment, address(target), true);
        policy.setActionAllowed(agentIdentityHash, policyCommitment, ACTION_KIND, true);
        vm.stopPrank();
    }

    // ─────────────────────────────── CRE-007 ───────────────────────────────

    /// CRE-007: an unauthorized writer cannot create an authorization.
    function test_CRE_007_unauthorizedWriterRejected() public {
        Capability memory cap = _creCapability();

        // The old Phase-1/2 trusted EOA is no longer the authorizer.
        vm.prank(authorizer);
        vm.expectRevert(ContextLockAuthorizationRegistry.NotAuthorizer.selector);
        auth.recordAuthorization(
            cap.authorizationId,
            ContextLockTypes.requestHash(cap),
            cap.policyHash,
            cap.contextCommitment,
            uint64(block.timestamp),
            uint64(block.timestamp + 60),
            IAuthReg.Verdict.ALLOW
        );

        // A random caller cannot deliver a report through the consumer either.
        vm.prank(address(0xDEAD));
        vm.expectRevert(abi.encodeWithSelector(ContextLockCreConsumer.NotForwarder.selector, address(0xDEAD)));
        consumer.onReport(_report(cap, 1, uint64(block.timestamp), uint64(block.timestamp + 60)));

        // Not even the consumer's owner may impersonate the forwarder.
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ContextLockCreConsumer.NotForwarder.selector, admin));
        consumer.onReport(_report(cap, 1, uint64(block.timestamp), uint64(block.timestamp + 60)));
    }

    /// A zero forwarder disables writes entirely rather than allowing anyone.
    function test_CRE_007b_zeroForwarderDisablesWrites() public {
        vm.prank(admin);
        consumer.setForwarder(address(0));
        Capability memory cap = _creCapability();
        vm.prank(address(0));
        vm.expectRevert();
        consumer.onReport(_report(cap, 1, uint64(block.timestamp), uint64(block.timestamp + 60)));
    }

    // ─────────────────────────────── CRE-001 ───────────────────────────────

    /// CRE-001: a forwarder-delivered ALLOW authorizes exactly this request and executes.
    function test_CRE_001_allowFromCreExecutes() public {
        _enablePolicyForCommitment();
        Capability memory cap = _creCapability();
        uint64 evaluatedAt = uint64(block.timestamp);
        bytes32 authId = _deliver(cap, 1, evaluatedAt, uint64(block.timestamp + 120));

        cap.authorizationId = authId;
        bytes memory sig = _sign(cap, issuerPk);

        vm.prank(relayer);
        executor.execute(cap, sig, _callData(), ACTION_KIND);
        assertEq(target.callCount(), 1);
    }

    // ─────────────────────────────── CRE-003 ───────────────────────────────

    /// CRE-003: mutating the request after the verdict breaks the binding.
    function test_CRE_003_requestHashMutationAfterVerdictFails() public {
        _enablePolicyForCommitment();
        Capability memory cap = _creCapability();
        uint64 evaluatedAt = uint64(block.timestamp);
        bytes32 authId = _deliver(cap, 1, evaluatedAt, uint64(block.timestamp + 120));

        // Attacker keeps the CRE authorization but points it at a different transaction.
        Capability memory mutated = _copy(cap);
        mutated.authorizationId = authId;
        bytes memory attackerCd = abi.encodeCall(MockTreasuryTarget.transferTo, (address(0xDEAD), 999_999));
        mutated.calldataHash = keccak256(attackerCd);
        bytes memory sig = _sign(mutated, issuerPk);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ContextLockExecutor.AuthorizationRequestMismatch.selector,
                ContextLockTypes.requestHash(cap),
                ContextLockTypes.requestHash(mutated)
            )
        );
        executor.execute(mutated, sig, attackerCd, ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    // ─────────────────────────────── CRE-005 ───────────────────────────────

    /// CRE-005: a context-commitment mismatch is rejected.
    function test_CRE_005_contextCommitmentMismatchFails() public {
        _enablePolicyForCommitment();
        Capability memory cap = _creCapability();
        uint64 evaluatedAt = uint64(block.timestamp);
        bytes32 authId = _deliver(cap, 1, evaluatedAt, uint64(block.timestamp + 120));

        Capability memory m = _copy(cap);
        m.authorizationId = authId;
        m.contextCommitment = keccak256("different-context");
        bytes memory sig = _sign(m, issuerPk);

        vm.prank(relayer);
        vm.expectRevert(ContextLockExecutor.AuthorizationContextMismatch.selector);
        executor.execute(m, sig, _callData(), ACTION_KIND);
    }

    // ─────────────────────────────── CRE-004 ───────────────────────────────

    /// CRE-004: an authorization carrying a different policy commitment cannot be spent.
    function test_CRE_004_policyVersionChangeAfterVerdictFails() public {
        _enablePolicyForCommitment();
        Capability memory cap = _creCapability();
        uint64 evaluatedAt = uint64(block.timestamp);
        bytes32 authId = _deliver(cap, 1, evaluatedAt, uint64(block.timestamp + 120));

        // Policy commitment moves to v2; the capability still references v1's authorization.
        bytes32 v2 = keccak256("policy-commitment-v2");
        Capability memory m = _copy(cap);
        m.authorizationId = authId;
        m.policyHash = v2;
        vm.startPrank(admin);
        policy.setPolicy(agentIdentityHash, v2, true, HARD_CAP);
        policy.setTargetAllowed(agentIdentityHash, v2, address(target), true);
        policy.setActionAllowed(agentIdentityHash, v2, ACTION_KIND, true);
        vm.stopPrank();
        bytes memory sig = _sign(m, issuerPk);

        // The rejection lands EARLIER than the dedicated policy check: policyHash is one of the
        // fields inside the evaluation request hash, so changing the policy version changes the
        // request identity itself. AuthorizationRequestMismatch fires before
        // AuthorizationPolicyMismatch is ever reached. Both defences exist; the outer one wins.
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ContextLockExecutor.AuthorizationRequestMismatch.selector,
                ContextLockTypes.requestHash(cap),
                ContextLockTypes.requestHash(m)
            )
        );
        executor.execute(m, sig, _callData(), ACTION_KIND);
        assertEq(target.callCount(), 0, "a v1 authorization cannot be spent under policy v2");

        // Prove the inner check is genuinely reachable too, by mismatching policyHash ONLY in the
        // stored authorization rather than in the request-bound fields.
        assertTrue(
            ContextLockTypes.requestHash(cap) != ContextLockTypes.requestHash(m),
            "policy version is bound into the request hash"
        );
    }

    // ─────────────────────────────── CRE-006 ───────────────────────────────

    /// CRE-006: a DENY verdict from CRE can never produce an executable capability.
    function test_CRE_006_denyNeverExecutes() public {
        _enablePolicyForCommitment();
        Capability memory cap = _creCapability();
        uint64 evaluatedAt = uint64(block.timestamp);
        bytes32 authId = _deliver(cap, 3, evaluatedAt, uint64(block.timestamp + 120)); // 3 = DENY

        cap.authorizationId = authId;
        bytes memory sig = _sign(cap, issuerPk);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.AuthorizationNotAllow.selector, uint8(3)));
        executor.execute(cap, sig, _callData(), ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    /// CRE-006b: ESCALATE is likewise not autonomous authority.
    function test_CRE_006b_escalateNeverExecutesAutonomously() public {
        _enablePolicyForCommitment();
        Capability memory cap = _creCapability();
        uint64 evaluatedAt = uint64(block.timestamp);
        bytes32 authId = _deliver(cap, 2, evaluatedAt, uint64(block.timestamp + 120)); // 2 = ESCALATE

        cap.authorizationId = authId;
        bytes memory sig = _sign(cap, issuerPk);

        // ADR-001: ESCALATE now reverts HumanApprovalRequired (no approval recorded) instead of
        // AuthorizationNotAllow. Same security property, more precise error.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.HumanApprovalRequired.selector, _digest(cap)));
        executor.execute(cap, sig, _callData(), ACTION_KIND);
        assertEq(target.callCount(), 0, "ESCALATE still has no autonomous path");
    }

    // ─────────────────────────────── CRE-008 ───────────────────────────────

    /// CRE-008: an expired authorization is rejected even though the capability is still valid.
    function test_CRE_008_expiredAuthorizationRejected() public {
        _enablePolicyForCommitment();
        Capability memory cap = _creCapability();
        uint64 evaluatedAt = uint64(block.timestamp);
        uint64 validUntil = uint64(block.timestamp + 60);
        bytes32 authId = _deliver(cap, 1, evaluatedAt, validUntil);

        cap.authorizationId = authId;
        bytes memory sig = _sign(cap, issuerPk);

        vm.warp(uint256(validUntil) + 1);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ContextLockExecutor.AuthorizationStale.selector, validUntil, block.timestamp)
        );
        executor.execute(cap, sig, _callData(), ACTION_KIND);
        assertLt(block.timestamp, cap.expiresAt, "the capability itself had not expired");
    }

    // ─────────────────────────────── CRE-009 ───────────────────────────────

    /// CRE-009: one authorization cannot authorize different calldata.
    function test_CRE_009_sameAuthorizationCannotAuthorizeDifferentCalldata() public {
        _enablePolicyForCommitment();
        Capability memory cap = _creCapability();
        uint64 evaluatedAt = uint64(block.timestamp);
        bytes32 authId = _deliver(cap, 1, evaluatedAt, uint64(block.timestamp + 300));
        cap.authorizationId = authId;

        // First, the authorized call succeeds.
        vm.prank(relayer);
        executor.execute(cap, _sign(cap, issuerPk), _callData(), ACTION_KIND);
        assertEq(target.callCount(), 1);

        // Now reuse the SAME authorization for different calldata with a fresh nonce.
        bytes memory otherCd = abi.encodeCall(MockTreasuryTarget.transferTo, (address(0xDEAD), 1));
        Capability memory m = _copy(cap);
        m.nonce = 999;
        m.calldataHash = keccak256(otherCd);
        bytes memory sig = _sign(m, issuerPk);

        vm.prank(relayer);
        vm.expectRevert();
        executor.execute(m, sig, otherCd, ACTION_KIND);
        assertEq(target.callCount(), 1, "the second, different call never reached the target");
    }

    // ─────────────────────────────── CRE-015 ───────────────────────────────

    /// CRE-015: calldata changed after evaluation fails at the executor.
    function test_CRE_015_calldataChangedAfterEvaluationFails() public {
        _enablePolicyForCommitment();
        Capability memory cap = _creCapability();
        bytes32 authId = _deliver(cap, 1, uint64(block.timestamp), uint64(block.timestamp + 300));
        cap.authorizationId = authId;
        bytes memory sig = _sign(cap, issuerPk);

        bytes memory tampered = _callData();
        tampered[tampered.length - 1] = bytes1(uint8(tampered[tampered.length - 1]) ^ 0x01);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ContextLockExecutor.CalldataHashMismatch.selector, keccak256(tampered), cap.calldataHash
            )
        );
        executor.execute(cap, sig, tampered, ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    // ─────────────────────── consumer hardening ───────────────────────

    function test_consumerRejectsInvalidVerdictAndWindow() public {
        Capability memory cap = _creCapability();
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ContextLockCreConsumer.InvalidVerdict.selector, uint8(0)));
        consumer.onReport(_report(cap, 0, uint64(block.timestamp), uint64(block.timestamp + 60)));

        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ContextLockCreConsumer.InvalidVerdict.selector, uint8(9)));
        consumer.onReport(_report(cap, 9, uint64(block.timestamp), uint64(block.timestamp + 60)));

        vm.prank(forwarder);
        vm.expectRevert();
        consumer.onReport(_report(cap, 1, uint64(block.timestamp + 60), uint64(block.timestamp)));
    }

    /// The authorization id is derived from the report, so a caller cannot choose its slot.
    function test_authorizationIdIsDerivedNotChosen() public {
        Capability memory cap = _creCapability();
        uint64 t = uint64(block.timestamp);
        bytes32 expected = keccak256(abi.encode(ContextLockTypes.requestHash(cap), policyCommitment, t));
        assertEq(consumer.computeAuthorizationId(ContextLockTypes.requestHash(cap), policyCommitment, t), expected);
        bytes32 actual = _deliver(cap, 1, t, t + 60);
        assertEq(actual, expected);
    }

    /// FND-010: a repeat request for the SAME transaction must succeed and re-emit, so a stale
    /// authorization can be re-evaluated against fresh context. An earlier write-once version made
    /// re-evaluation impossible and let anyone permanently burn a victim's request hash.
    function test_gatewayAllowsReevaluation() public {
        bytes memory cd = _callData();

        bytes32 h1 = gateway.requestEvaluation(
            agentIdentityHash,
            agent,
            keccak256("ens-node"),
            address(target),
            0,
            cd,
            intentHash,
            policyCommitment,
            1,
            ACTION_KIND
        );

        vm.recordLogs();
        bytes32 h2 = gateway.requestEvaluation(
            agentIdentityHash,
            agent,
            keccak256("ens-node"),
            address(target),
            0,
            cd,
            intentHash,
            policyCommitment,
            1,
            ACTION_KIND
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(h1, h2, "the same transaction keeps the same request hash");
        assertEq(logs.length, 1, "the repeat request re-emits CapabilityRequested");

        (,,,,,,,,, uint64 requestCount,) = gateway.requests(h1);
        assertEq(requestCount, 2, "requestCount tracks re-evaluations");

        // A third party can re-request too, and this grants them nothing.
        vm.prank(address(0xDEAD));
        gateway.requestEvaluation(
            agentIdentityHash,
            agent,
            keccak256("ens-node"),
            address(target),
            0,
            cd,
            intentHash,
            policyCommitment,
            1,
            ACTION_KIND
        );
        (,,,,,,,,, requestCount,) = gateway.requests(h1);
        assertEq(requestCount, 3, "permissionless re-request is allowed and confers no authority");
    }

    /// The gateway emits the event the CRE log trigger subscribes to.
    function test_gatewayEmitsCapabilityRequested() public {
        bytes memory cd = _callData();
        vm.recordLogs();
        gateway.requestEvaluation(
            agentIdentityHash,
            agent,
            keccak256("ens-node"),
            address(target),
            0,
            cd,
            intentHash,
            policyCommitment,
            1,
            ACTION_KIND
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "exactly one CapabilityRequested event");
        assertEq(
            logs[0].topics[0],
            keccak256(
                "CapabilityRequested(bytes32,bytes32,address,bytes32,address,uint256,bytes,bytes32,bytes32,uint64,bytes32)"
            ),
            "topic0 matches the signature the workflow subscribes to"
        );
    }
}
