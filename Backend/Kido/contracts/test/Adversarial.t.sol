// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {Capability, ContextLockTypes} from "../src/ContextLockTypes.sol";
import {ContextLockExecutor} from "../src/ContextLockExecutor.sol";
import {IContextLockAuthorizationRegistry as IAuthReg} from "../src/interfaces/IContextLockAuthorizationRegistry.sol";
import {ContextLockAuthorizationRegistry} from "../src/ContextLockAuthorizationRegistry.sol";
import {MockTreasuryTarget} from "../src/mocks/MockTreasuryTarget.sol";
import {ReentrantTarget} from "../src/mocks/ReentrantTarget.sol";

/// @notice ADV-* plus identity and authorization-freshness enforcement.
contract AdversarialTest is Base {
    /// ADV-004: a capability captured off the wire cannot be replayed by the attacker.
    function test_ADV_004_capturedCapabilityReplay() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();

        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);

        address thief = address(0xDEAD);
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.NonceUsed.selector, cap.nonce));
        executor.execute(cap, sig, cd, ACTION_KIND);

        assertEq(target.callCount(), 1);
    }

    /// ADV-008: a malicious target that calls back into the executor cannot nest an execution.
    function test_ADV_008_reentrantTargetBlocked() public {
        ReentrantTarget evil = new ReentrantTarget();

        vm.prank(admin);
        policy.setTargetAllowed(agentIdentityHash, policyHash, address(evil), true);

        Capability memory cap = _baseCapability();
        cap.target = address(evil);
        bytes memory cd = abi.encodeCall(ReentrantTarget.poke, (recipient, AMOUNT));
        cap.calldataHash = keccak256(cd);
        _authorizeAllow(cap);
        bytes memory sig = _sign(cap, issuerPk);

        // Arm the target to re-enter with the identical capability.
        evil.arm(address(executor), abi.encodeCall(ContextLockExecutor.execute, (cap, sig, cd, ACTION_KIND)));

        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);

        assertTrue(evil.attempted(), "target did attempt re-entry");
        assertTrue(evil.reentryReverted(), "nested execution was rejected");
        assertTrue(executor.nonceUsed(cap.agentIdentityHash, cap.nonce), "nonce consumed exactly once");
    }

    /// ID-002 (local stand-in): revoking identity kills an outstanding unexpired capability.
    /// The live ENSv2 version of this is Phase 3 / DEMO-004.
    function test_ID_002_identityRevokedInvalidatesOutstandingCapability() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();

        vm.prank(admin);
        identity.revoke(agentIdentityHash);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ContextLockExecutor.IdentityNotCurrent.selector, agentIdentityHash, agent)
        );
        executor.execute(cap, sig, cd, ACTION_KIND);

        assertLt(block.timestamp, cap.expiresAt, "capability had NOT expired; identity is why it failed");
        assertEq(target.callCount(), 0);
    }

    /// ID-004 (local stand-in): rebinding the identity to a different agent invalidates the old one.
    function test_ID_004_identityReboundInvalidatesOldCapability() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();

        vm.prank(admin);
        identity.bind(agentIdentityHash, address(0xBEEF01));

        vm.prank(relayer);
        vm.expectRevert();
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    /// ID-006: a resolver/registry read failure must fail CLOSED, never open.
    function test_ID_006_identityResolutionFailureFailsClosed() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();

        vm.prank(admin);
        identity.setResolutionBroken(true);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ContextLockExecutor.IdentityNotCurrent.selector, agentIdentityHash, agent)
        );
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 0, "outage did not broaden authority");
    }

    /// CRE-005 (local stand-in): an authorization issued for a DIFFERENT request cannot be reused.
    function test_CRE_005_authorizationRequestMismatchRejected() public {
        Capability memory cap = _baseCapability();

        // Authorize a benign transfer...
        _authorizeAllow(cap);

        // ...then try to spend that authorization on a different recipient.
        bytes memory attackerCd = abi.encodeCall(MockTreasuryTarget.transferTo, (address(0xDEAD), AMOUNT));
        Capability memory m = _copy(cap);
        m.calldataHash = keccak256(attackerCd);
        bytes memory sig = _sign(m, issuerPk);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ContextLockExecutor.AuthorizationRequestMismatch.selector,
                ContextLockTypes.requestHash(cap),
                ContextLockTypes.requestHash(m)
            )
        );
        executor.execute(m, sig, attackerCd, ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    /// ADV-006 / CRE-006: once the approval window lapses the capability stops working.
    function test_ADV_006_staleAuthorizationRejected() public {
        Capability memory cap = _baseCapability();
        uint64 approvedUntil = uint64(block.timestamp + 30);
        _authorize(cap, IAuthReg.Verdict.ALLOW, approvedUntil);
        bytes memory sig = _sign(cap, issuerPk);
        bytes memory cd = _callData();

        vm.warp(uint256(approvedUntil) + 1);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ContextLockExecutor.AuthorizationStale.selector, approvedUntil, block.timestamp)
        );
        executor.execute(cap, sig, cd, ACTION_KIND);

        assertLt(block.timestamp, cap.expiresAt, "capability itself had NOT expired");
        assertEq(target.callCount(), 0);
    }

    /// CRE-003/004: ESCALATE and DENY are not autonomous authority.
    function test_CRE_003_004_escalateAndDenyAreNotAllow() public {
        Capability memory esc = _baseCapability();
        esc.authorizationId = keccak256("auth-escalate");
        _authorize(esc, IAuthReg.Verdict.ESCALATE, uint64(block.timestamp + 60));
        bytes memory escSig = _sign(esc, issuerPk);

        // Post-ADR-001 the ESCALATE branch reverts HumanApprovalRequired rather than
        // AuthorizationNotAllow. The security property is identical and unchanged — ESCALATE has
        // no autonomous path — but the error is now specific about WHY, which is strictly better
        // for a reviewer. The assertion that matters is that nothing executed.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.HumanApprovalRequired.selector, _digest(esc)));
        executor.execute(esc, escSig, _callData(), ACTION_KIND);

        Capability memory den = _baseCapability();
        den.nonce = 77;
        den.authorizationId = keccak256("auth-deny");
        _authorize(den, IAuthReg.Verdict.DENY, uint64(block.timestamp + 60));
        bytes memory denSig = _sign(den, issuerPk);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ContextLockExecutor.AuthorizationNotAllow.selector, uint8(IAuthReg.Verdict.DENY))
        );
        executor.execute(den, denSig, _callData(), ACTION_KIND);

        assertEq(target.callCount(), 0);
    }

    /// A capability with no authorization at all cannot execute.
    function test_missingAuthorizationRejected() public {
        Capability memory cap = _baseCapability();
        bytes memory sig = _sign(cap, issuerPk);
        bytes memory cd = _callData();

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.AuthorizationMissing.selector, cap.authorizationId));
        executor.execute(cap, sig, cd, ACTION_KIND);
    }

    /// CRE-007: only the configured authorizer may record verdicts.
    function test_CRE_007_untrustedAuthorizerRejected() public {
        Capability memory cap = _baseCapability();

        vm.prank(address(0xDEAD));
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
    }

    /// An authorization cannot be overwritten — no ESCALATE/DENY to ALLOW upgrade.
    function test_authorizationIsWriteOnce() public {
        Capability memory cap = _baseCapability();
        _authorize(cap, IAuthReg.Verdict.DENY, uint64(block.timestamp + 60));

        vm.prank(authorizer);
        vm.expectRevert(ContextLockAuthorizationRegistry.AuthorizationExists.selector);
        auth.recordAuthorization(
            cap.authorizationId,
            ContextLockTypes.requestHash(cap),
            cap.policyHash,
            cap.contextCommitment,
            uint64(block.timestamp),
            uint64(block.timestamp + 60),
            IAuthReg.Verdict.ALLOW
        );
    }

    /// ID-005: bumping the ContextLock binding version is an independent revocation lever.
    /// (Enforced via the identity hash in Phase 3; here we assert the registry mechanism.)
    function test_ID_005_bindingVersionBump() public {
        uint64 before = policy.bindingVersion(agentIdentityHash);
        vm.prank(admin);
        uint64 next = policy.bumpBindingVersion(agentIdentityHash);
        assertEq(next, before + 1, "binding version is monotonic");
        assertEq(policy.bindingVersion(agentIdentityHash), next);
    }

    /// Honest nonce semantics: a target revert rolls the whole transaction back, INCLUDING the
    /// nonce consumption. The bible requires this be tested accurately rather than claiming
    /// permanent one-shot consumption that a revert does not actually provide.
    function test_nonceRollsBackWhenTargetReverts() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();

        target.setShouldRevert(true);
        vm.prank(relayer);
        vm.expectRevert();
        executor.execute(cap, sig, cd, ACTION_KIND);

        assertFalse(
            executor.nonceUsed(cap.agentIdentityHash, cap.nonce),
            "nonce consumption rolled back with the reverted transaction"
        );

        // The same capability therefore remains spendable once the target recovers. This is
        // documented MVP behaviour, not an oversight.
        target.setShouldRevert(false);
        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 1);
        assertTrue(executor.nonceUsed(cap.agentIdentityHash, cap.nonce));
    }
}
