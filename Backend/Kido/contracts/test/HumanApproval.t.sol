// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {Capability, ContextLockTypes} from "../src/ContextLockTypes.sol";
import {ContextLockExecutor} from "../src/ContextLockExecutor.sol";
import {ContextLockApprovalRegistry} from "../src/ContextLockApprovalRegistry.sol";
import {IContextLockAuthorizationRegistry as IAuthReg} from "../src/interfaces/IContextLockAuthorizationRegistry.sol";
import {MockTreasuryTarget} from "../src/mocks/MockTreasuryTarget.sol";

/// @notice LED-H01 .. LED-H19 — the human escalation boundary.
/// @dev The device-produced signature is simulated here with `vm.sign` over the SAME EIP-712
///      digest a Ledger would sign. That proves the CONTRACT logic. It does NOT prove a physical
///      device approved anything — that is LED-H03/H04 and is blocked by BLK-002.
contract HumanApprovalTest is Base {
    uint64 internal approvalTtl = 600;

    function _escalate(Capability memory cap) internal {
        _authorize(cap, IAuthReg.Verdict.ESCALATE, uint64(block.timestamp + 3000));
    }

    function _approveWith(Capability memory cap, uint256 pk, uint64 expiresAt) internal returns (bytes32 d) {
        d = _digest(cap);
        bytes32 ad = approvals.approvalDigest(d, approver, expiresAt);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ad);
        approvals.submitApproval(d, expiresAt, abi.encodePacked(r, s, v));
    }

    function _approve(Capability memory cap) internal returns (bytes32) {
        return _approveWith(cap, approverPk, uint64(block.timestamp) + approvalTtl);
    }

    /// LED-H01/H03: ESCALATE + a valid human approval executes the exact transaction.
    function test_LED_H01_H03_approvedEscalationExecutes() public {
        Capability memory cap = _baseCapability();
        _escalate(cap);
        _approve(cap);
        bytes memory sig = _sign(cap, issuerPk);

        vm.prank(relayer);
        executor.execute(cap, sig, _callData(), ACTION_KIND);
        assertEq(target.callCount(), 1, "approved escalation executed");
        assertEq(target.lastAmount(), AMOUNT);
    }

    /// LED-H02: without a human signature, the same capability cannot execute.
    function test_LED_H02_withoutApprovalCannotExecute() public {
        Capability memory cap = _baseCapability();
        _escalate(cap);
        bytes memory sig = _sign(cap, issuerPk);
        bytes memory cd = _callData();

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.HumanApprovalRequired.selector, _digest(cap)));
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    /// LED-H04: a rejection is simply the absence of a signature — nothing is recorded, nothing runs.
    function test_LED_H04_deviceRejectionLeavesNoApproval() public {
        Capability memory cap = _baseCapability();
        _escalate(cap);
        // The human rejected on-device: no signature was ever produced.
        assertFalse(approvals.isApprovalValid(_digest(cap)), "no approval exists after a rejection");
        bytes memory sig = _sign(cap, issuerPk);
        bytes memory cd = _callData();
        vm.prank(relayer);
        vm.expectRevert();
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 0, "rejection creates no fallback path");
    }

    /// LED-H05: an expired approval cannot be used.
    function test_LED_H05_expiredApprovalFails() public {
        Capability memory cap = _baseCapability();
        _escalate(cap);
        uint64 exp = uint64(block.timestamp) + 60;
        _approveWith(cap, approverPk, exp);
        bytes memory sig = _sign(cap, issuerPk);
        bytes memory cd = _callData();

        vm.warp(uint256(exp) + 1);
        assertFalse(approvals.isApprovalValid(_digest(cap)));
        vm.prank(relayer);
        vm.expectRevert();
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    /// LED-H06: an approval is single-use.
    function test_LED_H06_approvalReplayFails() public {
        Capability memory cap = _baseCapability();
        _escalate(cap);
        _approve(cap);
        bytes memory sig = _sign(cap, issuerPk);

        vm.prank(relayer);
        executor.execute(cap, sig, _callData(), ACTION_KIND);
        assertEq(target.callCount(), 1);

        // The approval is consumed; the nonce is too. Both independently stop a second run.
        assertFalse(approvals.isApprovalValid(_digest(cap)), "approval consumed");
        vm.prank(relayer);
        vm.expectRevert();
        executor.execute(cap, sig, _callData(), ACTION_KIND);
        assertEq(target.callCount(), 1);
    }

    /// LED-H07: a signature from any other key is not a human approval.
    function test_LED_H07_wrongSignerRejected() public {
        Capability memory cap = _baseCapability();
        _escalate(cap);
        bytes32 d = _digest(cap);
        uint64 exp = uint64(block.timestamp) + approvalTtl;
        bytes32 ad = approvals.approvalDigest(d, approver, exp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, ad);

        vm.expectRevert(ContextLockApprovalRegistry.InvalidApprovalSignature.selector);
        approvals.submitApproval(d, exp, abi.encodePacked(r, s, v));
        assertFalse(approvals.isApprovalValid(d));
    }

    /// LED-H08/H09/H10/H11: approval is transaction-specific. Any mutation breaks it.
    function test_LED_H08_H11_mutationAfterApprovalFails() public {
        Capability memory approved = _baseCapability();
        _escalate(approved);
        _approve(approved);
        bytes32 approvedDigest = _digest(approved);

        // H08 amount / H09 recipient: calldata changes, capability digest unchanged -> the
        // calldata-hash check catches it first.
        bytes memory bigCd = abi.encodeCall(MockTreasuryTarget.transferTo, (recipient, AMOUNT * 10));
        bytes memory sig = _sign(approved, issuerPk);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ContextLockExecutor.CalldataHashMismatch.selector, keccak256(bigCd), approved.calldataHash
            )
        );
        executor.execute(approved, sig, bigCd, ACTION_KIND);

        // Re-signed to match the new calldata -> now a DIFFERENT capability digest, so the human
        // approval no longer covers it.
        Capability memory mutated = _copy(approved);
        mutated.calldataHash = keccak256(bigCd);
        // Distinct authorization id: authorizations are write-once, so reusing the approved
        // capability's id would revert AuthorizationExists before the approval check is reached.
        mutated.authorizationId = keccak256("auth-mutated");
        assertTrue(_digest(mutated) != approvedDigest, "mutation changes the approved digest");
        _authorize(mutated, IAuthReg.Verdict.ESCALATE, uint64(block.timestamp + 3000));
        bytes memory sig2 = _sign(mutated, issuerPk);
        vm.prank(relayer);
        vm.expectRevert();
        executor.execute(mutated, sig2, bigCd, ACTION_KIND);

        // H10 target
        Capability memory tgt = _copy(approved);
        tgt.target = address(0xDEAD);
        assertTrue(_digest(tgt) != approvedDigest);

        assertEq(target.callCount(), 0, "no mutation executed");
    }

    /// LED-H12: a policy change after approval still wins.
    function test_LED_H12_policyChangeAfterApprovalFails() public {
        Capability memory cap = _baseCapability();
        _escalate(cap);
        _approve(cap);
        bytes memory sig = _sign(cap, issuerPk);
        bytes memory cd = _callData();

        vm.prank(admin);
        policy.setPolicy(agentIdentityHash, policyHash, false, HARD_CAP);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ContextLockExecutor.PolicyDisabled.selector, agentIdentityHash, policyHash)
        );
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 0, "human approval does not override a disabled policy");
    }

    /// LED-H13: ENS identity revoked after approval still wins.
    function test_LED_H13_identityRevokedAfterApprovalFails() public {
        Capability memory cap = _baseCapability();
        _escalate(cap);
        _approve(cap);
        bytes memory sig = _sign(cap, issuerPk);
        bytes memory cd = _callData();

        vm.prank(admin);
        identity.revoke(agentIdentityHash);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ContextLockExecutor.IdentityNotCurrent.selector, agentIdentityHash, agent)
        );
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 0, "human approval does not override a revoked ENS identity");
    }

    /// LED-H14: a stale CRE authorization still wins.
    function test_LED_H14_creAuthorizationStaleAfterApprovalFails() public {
        Capability memory cap = _baseCapability();
        uint64 approvedUntil = uint64(block.timestamp + 60);
        _authorize(cap, IAuthReg.Verdict.ESCALATE, approvedUntil);
        _approveWith(cap, approverPk, uint64(block.timestamp) + 3000); // approval outlives the auth
        bytes memory sig = _sign(cap, issuerPk);
        bytes memory cd = _callData();

        vm.warp(uint256(approvedUntil) + 1);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ContextLockExecutor.AuthorizationStale.selector, approvedUntil, block.timestamp)
        );
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 0, "a live human approval does not revive a stale CRE authorization");
    }

    /// LED-H17: the agent cannot consume an approval as if it were the executor.
    function test_LED_H17_agentCannotConsumeApproval() public {
        Capability memory cap = _baseCapability();
        _escalate(cap);
        bytes32 d = _approve(cap);

        vm.prank(agent);
        vm.expectRevert(ContextLockApprovalRegistry.NotExecutor.selector);
        approvals.consumeApproval(d);

        vm.prank(relayer);
        vm.expectRevert(ContextLockApprovalRegistry.NotExecutor.selector);
        approvals.consumeApproval(d);

        assertTrue(approvals.isApprovalValid(d), "approval untouched by the impersonation attempts");
    }

    /// LED-H18: the ALLOW path never consults the approval registry.
    function test_LED_H18_allowPathNeedsNoApproval() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();
        assertFalse(approvals.isApprovalValid(_digest(cap)), "no approval exists");
        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 1, "ALLOW executed autonomously with no human approval");
    }

    /// LED-H19: a DENY cannot be overridden, even by a perfectly valid human approval.
    /// This is the single most important test in Phase 7.
    function test_LED_H19_denyCannotBeOverriddenByApproval() public {
        Capability memory cap = _baseCapability();
        _authorize(cap, IAuthReg.Verdict.DENY, uint64(block.timestamp + 3000));

        // The human signs a genuine, valid approval for this exact capability.
        _approve(cap);
        assertTrue(approvals.isApprovalValid(_digest(cap)), "a real, valid approval exists");

        bytes memory sig = _sign(cap, issuerPk);
        bytes memory cd = _callData();

        // It still cannot execute. The approval branch is unreachable from DENY.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.AuthorizationNotAllow.selector, uint8(3)));
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 0, "DENY is not escalatable");

        // And the approval was not even consumed - the code never reached it.
        assertTrue(approvals.isApprovalValid(_digest(cap)), "DENY never reaches the approval branch");
    }

    /// An approver rotation invalidates approvals signed by the previous approver.
    function test_approverRotationInvalidatesOldApprovals() public {
        Capability memory cap = _baseCapability();
        _escalate(cap);
        bytes32 d = _approve(cap);
        assertTrue(approvals.isApprovalValid(d));

        vm.prank(admin);
        approvals.setApprover(address(0xBEEF01));
        assertFalse(approvals.isApprovalValid(d), "old approver's signature no longer counts");
    }

    /// An approval cannot be submitted already expired.
    function test_cannotSubmitExpiredApproval() public {
        Capability memory cap = _baseCapability();
        _escalate(cap);
        bytes32 d = _digest(cap);
        vm.expectRevert();
        approvals.submitApproval(d, uint64(block.timestamp), hex"00");
    }

    /// Approvals are write-once: an attacker cannot overwrite one with a longer expiry.
    function test_approvalIsWriteOnce() public {
        Capability memory cap = _baseCapability();
        _escalate(cap);
        _approve(cap);

        // Everything that touches a contract is hoisted BEFORE vm.expectRevert. `_approveWith`
        // calls `approvals.approvalDigest(...)` internally, and inlining it here would arm the
        // cheatcode against that view read instead of against submitApproval — the same trap
        // recorded in FND-006.
        bytes32 d = _digest(cap);
        uint64 exp = uint64(block.timestamp) + 9999;
        bytes32 ad = approvals.approvalDigest(d, approver, exp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(approverPk, ad);
        bytes memory sig2 = abi.encodePacked(r, s, v);

        vm.expectRevert(abi.encodeWithSelector(ContextLockApprovalRegistry.ApprovalAlreadyExists.selector, d));
        approvals.submitApproval(d, exp, sig2);
    }
}
