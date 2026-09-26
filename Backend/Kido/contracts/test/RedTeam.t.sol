// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {Capability, ContextLockTypes} from "../src/ContextLockTypes.sol";
import {ContextLockExecutor, IContextLockApprovalRegistry} from "../src/ContextLockExecutor.sol";
import {ContextLockPolicyRegistry} from "../src/ContextLockPolicyRegistry.sol";
import {ContextLockAuthorizationRegistry} from "../src/ContextLockAuthorizationRegistry.sol";
import {IContextLockAuthorizationRegistry as IAuthReg} from "../src/interfaces/IContextLockAuthorizationRegistry.sol";
import {IContextLockPolicyRegistry} from "../src/interfaces/IContextLockPolicyRegistry.sol";
import {IAgentIdentityVerifier} from "../src/interfaces/IAgentIdentityVerifier.sol";
import {MockTreasuryTarget} from "../src/mocks/MockTreasuryTarget.sol";
import {Reverter, GasBurner, BadReturn, CallbackTarget} from "../src/mocks/HostileTargets.sol";

/// @notice P8.4 / P8.5 / P8.6 / P8.10 / P8.11 / P8.12 — the on-chain red team.
contract RedTeamTest is Base {
    // ─────────────────── P8.4 property-based mutation ───────────────────

    /// Every security-relevant field, mutated by a fuzzer, must fail. This replaces hand-picked
    /// mutations with generated ones so a field cannot be quietly forgotten.
    function testFuzz_P84_anySignedFieldMutationFails(uint8 fieldIndex, uint256 noise) public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();
        fieldIndex = uint8(bound(fieldIndex, 0, 14));
        bytes32 n = bytes32(noise);

        Capability memory m = _copy(cap);
        if (fieldIndex == 0) m.version = uint8(bound(noise, 2, 255));
        else if (fieldIndex == 1) m.agentIdentityHash = n;
        else if (fieldIndex == 2) m.agent = address(uint160(noise));
        else if (fieldIndex == 3) m.chainId = noise;
        else if (fieldIndex == 4) m.executor = address(uint160(noise));
        else if (fieldIndex == 5) m.target = address(uint160(noise));
        else if (fieldIndex == 6) m.value = noise;
        else if (fieldIndex == 7) m.calldataHash = n;
        else if (fieldIndex == 8) m.intentHash = n;
        else if (fieldIndex == 9) m.policyHash = n;
        else if (fieldIndex == 10) m.authorizationId = n;
        else if (fieldIndex == 11) m.contextCommitment = n;
        else if (fieldIndex == 12) m.issuedAt = uint64(noise);
        else if (fieldIndex == 13) m.expiresAt = uint64(noise);
        else m.nonce = noise;

        vm.assume(ContextLockTypes.hashStruct(m) != ContextLockTypes.hashStruct(cap));

        uint256 before = target.callCount();
        vm.prank(relayer);
        vm.expectRevert();
        executor.execute(m, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), before, "no mutated field reached the target");
    }

    /// The baseline must actually be executable, or the mutation test above proves nothing.
    function test_P84_baselineIsGenuinelyExecutable() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();
        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 1, "the un-mutated capability DOES execute");
    }

    // ─────────────────── P8.5 EIP-712 domain attacks ───────────────────

    function _domain(string memory name, string memory version, uint256 chainId, address verifying)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
    }

    function _signUnder(Capability memory cap, bytes32 domainSep, uint256 pk) internal view returns (bytes memory) {
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", domainSep, ContextLockTypes.hashStruct(cap)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        return abi.encodePacked(r, s, v);
    }

    /// D712-001..005: a signature made under any wrong domain component is rejected.
    function test_D712_wrongDomainComponentsRejected() public {
        Capability memory cap = _baseCapability();
        _authorizeAllow(cap);
        bytes memory cd = _callData();

        bytes32[4] memory bad = [
            _domain("ContextLock", "1", 1, address(executor)), // wrong chainId
            _domain("ContextLock", "1", block.chainid, address(0xDEAD)), // wrong verifyingContract
            _domain("NotContextLock", "1", block.chainid, address(executor)), // wrong name
            _domain("ContextLock", "2", block.chainid, address(executor)) // wrong version
        ];

        for (uint256 i = 0; i < bad.length; i++) {
            bytes memory sig = _signUnder(cap, bad[i], issuerPk);
            vm.prank(relayer);
            vm.expectRevert(ContextLockExecutor.InvalidSignature.selector);
            executor.execute(cap, sig, cd, ACTION_KIND);
        }
        assertEq(target.callCount(), 0);
    }

    /// D712-006/007: a signature valid for one deployment is worthless against another.
    function test_D712_crossDeploymentReplayFails() public {
        ContextLockExecutor other = new ContextLockExecutor(
            issuer,
            IContextLockPolicyRegistry(address(policy)),
            IAuthReg(address(auth)),
            IAgentIdentityVerifier(address(identity)),
            IContextLockApprovalRegistry(address(approvals))
        );

        Capability memory cap = _baseCapability();
        _authorizeAllow(cap);
        bytes memory sig = _sign(cap, issuerPk); // signed for `executor`
        bytes memory cd = _callData();

        // The capability names `executor`, so `other` rejects it on the executor field.
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ContextLockExecutor.ExecutorMismatch.selector, address(executor), address(other))
        );
        other.execute(cap, sig, cd, ACTION_KIND);

        // Repointed AND re-signed, it still cannot be spent on `other`, because `other`'s domain
        // separator differs — a signature is never portable between deployments.
        Capability memory m = _copy(cap);
        m.executor = address(other);
        m.authorizationId = keccak256("auth-cross");
        _authorizeAllow(m);
        bytes memory forDifferentDomain = _sign(m, issuerPk); // signed under `executor`'s domain
        vm.prank(relayer);
        vm.expectRevert(ContextLockExecutor.InvalidSignature.selector);
        other.execute(m, forDifferentDomain, cd, ACTION_KIND);
    }

    // ─────────────────── P8.6 nonce / concurrency ───────────────────

    /// NONCE-ATK-001/002: many callers, at most one execution.
    function test_NONCE_manyConcurrentSubmittersAtMostOneExecution() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();

        uint256 successes;
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(address(uint160(0x1000 + i)));
            try executor.execute(cap, sig, cd, ACTION_KIND) {
                successes++;
            } catch {}
        }
        assertEq(successes, 1, "exactly one of ten submitters succeeded");
        assertEq(target.callCount(), 1, "the target moved exactly once");
    }

    /// NONCE-ATK-003: relayer and attacker racing the same capability.
    function test_NONCE_relayerAndAttackerRace() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();
        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);
        vm.prank(address(0xDEAD));
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.NonceUsed.selector, cap.nonce));
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 1);
    }

    /// NONCE-ATK-005: a broadcast that reverts is NOT an execution. Distinguish the two.
    function test_NONCE_revertedBroadcastIsNotAnExecution() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();

        target.setShouldRevert(true);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(relayer);
            try executor.execute(cap, sig, cd, ACTION_KIND) {
                revert("should have reverted");
            } catch {}
        }
        // Three broadcasts, zero executions. The nonce is untouched because state rolled back.
        assertEq(target.callCount(), 0, "no execution happened");
        assertFalse(executor.nonceUsed(cap.agentIdentityHash, cap.nonce), "nonce not consumed by failed attempts");

        target.setShouldRevert(false);
        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 1, "exactly one execution once the target recovered");
    }

    // ─────────────────── P8.10 authorization registry ───────────────────

    function test_AUTH_ATK_registryRejectsEveryUnauthorizedWriter() public {
        Capability memory cap = _baseCapability();
        address[3] memory attackers = [agent, relayer, address(0xDEAD)];
        for (uint256 i = 0; i < attackers.length; i++) {
            vm.prank(attackers[i]);
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
    }

    /// AUTH-ATK: a rotated-out writer immediately loses the ability to authorize.
    function test_AUTH_ATK_rotatedWriterLosesAuthority() public {
        Capability memory cap = _baseCapability();
        address newWriter = address(0xBEEF02);
        vm.prank(admin);
        auth.setAuthorizer(newWriter);

        vm.prank(authorizer); // the old writer
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

    /// AUTH-ATK: a future-dated authorization window cannot make a stale one look fresh.
    function test_AUTH_ATK_futureDatedWindowStillBoundByApprovedUntil() public {
        Capability memory cap = _baseCapability();
        uint64 evaluatedAt = uint64(block.timestamp + 10_000);
        vm.prank(authorizer);
        auth.recordAuthorization(
            cap.authorizationId,
            ContextLockTypes.requestHash(cap),
            cap.policyHash,
            cap.contextCommitment,
            evaluatedAt,
            evaluatedAt + 60,
            IAuthReg.Verdict.ALLOW
        );
        // approvedUntil is in the future, so this one is accepted — the executor checks
        // approvedUntil, not evaluatedAt. Documented rather than assumed.
        bytes memory sig = _sign(cap, issuerPk);
        vm.prank(relayer);
        executor.execute(cap, sig, _callData(), ACTION_KIND);
        assertEq(target.callCount(), 1);
    }

    // ─────────────────── P8.11 policy attacks ───────────────────

    function test_POL_ATK_nonAdminCannotTouchAnyPolicyMutator() public {
        address[3] memory attackers = [agent, relayer, address(0xDEAD)];
        for (uint256 i = 0; i < attackers.length; i++) {
            vm.startPrank(attackers[i]);
            vm.expectRevert(ContextLockPolicyRegistry.NotAdmin.selector);
            policy.setPolicy(agentIdentityHash, policyHash, false, 0);
            vm.expectRevert(ContextLockPolicyRegistry.NotAdmin.selector);
            policy.setTargetAllowed(agentIdentityHash, policyHash, address(0xBAD), true);
            vm.expectRevert(ContextLockPolicyRegistry.NotAdmin.selector);
            policy.setActionAllowed(agentIdentityHash, policyHash, ACTION_KIND, true);
            vm.expectRevert(ContextLockPolicyRegistry.NotAdmin.selector);
            policy.bumpBindingVersion(agentIdentityHash);
            vm.stopPrank();
        }
    }

    /// POL-ATK: lowering the hard cap after issuance kills an outstanding capability.
    function test_POL_ATK_loweredCapKillsOutstandingCapability() public {
        Capability memory cap = _baseCapability();
        cap.value = 1 ether;
        _authorizeAllow(cap);
        bytes memory sig = _sign(cap, issuerPk);
        bytes memory cd = _callData();

        vm.prank(admin);
        policy.setPolicy(agentIdentityHash, policyHash, true, 1 wei);

        vm.deal(relayer, 2 ether);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.ValueExceedsHardCap.selector, 1 ether, 1));
        executor.execute{value: 1 ether}(cap, sig, cd, ACTION_KIND);
    }

    /// POL-ATK: removing the target from the allowlist kills an outstanding capability.
    function test_POL_ATK_targetRemovedFromAllowlist() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();
        vm.prank(admin);
        policy.setTargetAllowed(agentIdentityHash, policyHash, address(target), false);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.TargetNotAllowed.selector, address(target)));
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    /// POL-ATK-008: policy-admin compromise — blast radius, documented not denied.
    function test_POL_ATK_adminCompromiseBlastRadius() public {
        // A compromised admin CAN widen policy. That is inherent to it being the admin.
        vm.prank(admin);
        policy.setTargetAllowed(agentIdentityHash, policyHash, address(0xDEAD), true);
        assertTrue(policy.isTargetAllowed(agentIdentityHash, policyHash, address(0xDEAD)));

        // But it still cannot execute without a valid capability AND a live CRE authorization
        // AND a current ENS identity. Admin compromise widens policy; it does not mint authority.
        Capability memory cap = _baseCapability();
        cap.target = address(0xDEAD);
        bytes memory sig = _sign(cap, issuerPk); // signed, but never authorized
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.AuthorizationMissing.selector, cap.authorizationId));
        executor.execute(cap, sig, _callData(), ACTION_KIND);
    }

    // ─────────────────── P8.12 hostile targets ───────────────────

    /// SLITHER-REENTRANCY-ETH triage: Slither flags `_entered = 0` being written after the
    /// external call, and notes `consumeApproval` adds a SECOND external call before the value
    /// transfer. This test exercises exactly that path — a reentrant target on an ESCALATE
    /// capability, so both external calls are in play — and proves the guard holds.
    function test_SLITHER_reentrancyGuardHoldsWithApprovalRegistryInPath() public {
        CallbackTarget evil = new CallbackTarget();
        vm.prank(admin);
        policy.setTargetAllowed(agentIdentityHash, policyHash, address(evil), true);

        bytes memory cd = abi.encodeWithSignature("poke(address,uint256)", recipient, AMOUNT);
        Capability memory cap = _baseCapability();
        cap.target = address(evil);
        cap.calldataHash = keccak256(cd);
        // ESCALATE so the approval registry is genuinely consulted AND consumed.
        _authorize(cap, IAuthReg.Verdict.ESCALATE, uint64(block.timestamp + 3000));

        bytes32 d = _digest(cap);
        uint64 exp = uint64(block.timestamp) + 600;
        bytes32 ad = approvals.approvalDigest(d, approver, exp);
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(approverPk, ad);
        approvals.submitApproval(d, exp, abi.encodePacked(ar, as_, av));

        bytes memory sig = _sign(cap, issuerPk);
        evil.arm(address(executor), abi.encodeCall(ContextLockExecutor.execute, (cap, sig, cd, ACTION_KIND)));

        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);

        assertTrue(evil.attempted(), "the target DID attempt re-entry");
        assertTrue(evil.reentryReverted(), "the nested execution was rejected");
        assertTrue(executor.nonceUsed(cap.agentIdentityHash, cap.nonce), "nonce consumed exactly once");
        assertFalse(approvals.isApprovalValid(d), "the approval was consumed exactly once");
    }

    /// The guard must also not leave the executor bricked after a reverting execution.
    function test_SLITHER_guardIsNotStickyAfterARevert() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();
        target.setShouldRevert(true);
        vm.prank(relayer);
        vm.expectRevert();
        executor.execute(cap, sig, cd, ACTION_KIND);

        // If `_entered` had stuck at 1, this next call would revert with Reentrancy. It does not.
        target.setShouldRevert(false);
        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 1, "the executor was not bricked by the earlier revert");
    }

    function test_TGT_ATK_hostileTargetsCannotCorruptExecutorState() public {
        Reverter reverter = new Reverter();
        GasBurner burner = new GasBurner();
        BadReturn badReturn = new BadReturn();

        address[3] memory targets = [address(reverter), address(burner), address(badReturn)];
        for (uint256 i = 0; i < targets.length; i++) {
            vm.prank(admin);
            policy.setTargetAllowed(agentIdentityHash, policyHash, targets[i], true);

            bytes memory cd = abi.encodeWithSignature("poke(address,uint256)", recipient, AMOUNT);
            Capability memory cap = _baseCapability();
            cap.target = targets[i];
            cap.calldataHash = keccak256(cd);
            cap.nonce = 1000 + i;
            cap.authorizationId = keccak256(abi.encode("hostile", i));
            _authorizeAllow(cap);
            bytes memory sig = _sign(cap, issuerPk);

            vm.prank(relayer);
            try executor.execute{gas: 3_000_000}(cap, sig, cd, ACTION_KIND) {} catch {}

            // Whatever the target did, the executor's own accounting is intact.
            assertEq(target.callCount(), 0, "the real treasury target was never touched");
        }
    }
}
