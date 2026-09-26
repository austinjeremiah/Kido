// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {Capability, ContextLockTypes} from "../src/ContextLockTypes.sol";
import {ContextLockExecutor} from "../src/ContextLockExecutor.sol";
import {IContextLockPolicyRegistry} from "../src/interfaces/IContextLockPolicyRegistry.sol";
import {IContextLockAuthorizationRegistry as IAuthReg} from "../src/interfaces/IContextLockAuthorizationRegistry.sol";
import {IAgentIdentityVerifier} from "../src/interfaces/IAgentIdentityVerifier.sol";
import {MockTreasuryTarget} from "../src/mocks/MockTreasuryTarget.sol";
import {MockERC1271Issuer} from "../src/mocks/MockERC1271Issuer.sol";
import {IContextLockApprovalRegistry} from "../src/ContextLockExecutor.sol";

/// @notice CAP-001 .. CAP-012 — capability binding, replay and signature validation.
contract CapabilityTest is Base {
    /// CAP-001: a valid capability executes the exact call, exactly once.
    function test_CAP_001_validCapabilityExecutesExactCall() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();

        assertEq(target.callCount(), 0, "precondition: target untouched");

        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);

        assertEq(target.callCount(), 1, "target called exactly once");
        assertEq(target.lastRecipient(), recipient, "exact recipient");
        assertEq(target.lastAmount(), AMOUNT, "exact amount");
        assertEq(target.balanceOf(recipient), AMOUNT, "state matches expectation");
        assertTrue(executor.nonceUsed(cap.agentIdentityHash, cap.nonce), "nonce consumed");
    }

    /// CAP-002: flipping one calldata byte reverts before the target is touched.
    function test_CAP_002_mutatedCalldataByteRejected() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();

        bytes memory mutated = cd;
        mutated[mutated.length - 1] = bytes1(uint8(mutated[mutated.length - 1]) ^ 0x01);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ContextLockExecutor.CalldataHashMismatch.selector, keccak256(mutated), cap.calldataHash
            )
        );
        executor.execute(cap, sig, mutated, ACTION_KIND);

        assertEq(target.callCount(), 0, "target never called");
    }

    /// ADV-003 / CAP-002 variant: the agent keeps the intent but redirects the recipient.
    function test_ADV_003_recipientSubstitutionRejected() public {
        (Capability memory cap, bytes memory sig,) = _ready();
        address attacker = address(0xDEAD);

        bytes memory attackerCd = abi.encodeCall(MockTreasuryTarget.transferTo, (attacker, AMOUNT));

        vm.prank(relayer);
        vm.expectRevert();
        executor.execute(cap, sig, attackerCd, ACTION_KIND);

        assertEq(target.balanceOf(attacker), 0, "attacker received nothing");
        assertEq(target.callCount(), 0, "target never called");
    }

    /// ADV-003: mutating the amount while keeping everything else invalidates the signature.
    function test_ADV_003_amountMutationRejected() public {
        (Capability memory cap, bytes memory sig,) = _ready();

        bytes memory bigCd = abi.encodeCall(MockTreasuryTarget.transferTo, (recipient, 1_000_000 ether));

        vm.prank(relayer);
        vm.expectRevert();
        executor.execute(cap, sig, bigCd, ACTION_KIND);
        assertEq(target.callCount(), 0);

        // Re-hashing the capability to match does not help: the issuer signature no longer covers
        // it, and the CRE authorization was recorded against the original request hash.
        Capability memory mutatedCap = _copy(cap);
        mutatedCap.calldataHash = keccak256(bigCd);

        vm.prank(relayer);
        vm.expectRevert(ContextLockExecutor.InvalidSignature.selector);
        executor.execute(mutatedCap, sig, bigCd, ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    /// CAP-003: changing the target reverts.
    function test_CAP_003_mutatedTargetRejected() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();
        MockTreasuryTarget other = new MockTreasuryTarget();

        Capability memory m = _copy(cap);
        m.target = address(other);

        // Signature is over the original target, so this fails at signature validation.
        vm.prank(relayer);
        vm.expectRevert(ContextLockExecutor.InvalidSignature.selector);
        executor.execute(m, sig, cd, ACTION_KIND);

        // Even correctly re-signed, the target is not allowlisted and the authorization was
        // recorded for a different request hash.
        bytes memory resigned = _sign(m, issuerPk);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.TargetNotAllowed.selector, address(other)));
        executor.execute(m, resigned, cd, ACTION_KIND);

        assertEq(other.callCount(), 0);
    }

    /// CAP-004: changing `value` reverts.
    function test_CAP_004_mutatedValueRejected() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();

        Capability memory m = _copy(cap);
        m.value = 1 ether;
        bytes memory resigned = _sign(m, issuerPk);

        // Sending the declared value still fails: the authorization covers value = 0.
        vm.deal(relayer, 2 ether);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ContextLockExecutor.AuthorizationRequestMismatch.selector,
                ContextLockTypes.requestHash(cap),
                ContextLockTypes.requestHash(m)
            )
        );
        executor.execute{value: 1 ether}(m, resigned, cd, ACTION_KIND);

        // And msg.value must equal cap.value exactly.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.ValueMismatch.selector, 0, 1 ether));
        executor.execute(m, resigned, cd, ACTION_KIND);
    }

    /// CAP-005: a capability signed for another chain is not valid here.
    function test_CAP_005_wrongChainRejected() public {
        Capability memory m = _baseCapability();
        m.chainId = 1; // mainnet
        _authorizeAllow(m);
        bytes memory sig = _sign(m, issuerPk);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.ChainMismatch.selector, 1, block.chainid));
        executor.execute(m, sig, _callData(), ACTION_KIND);
    }

    /// CAP-005b: the EIP-712 domain itself is chain-bound — a signature made under a different
    /// domain chainId does not verify, independently of the struct field.
    function test_CAP_005b_domainSeparatorIsChainBound() public {
        (Capability memory cap,, bytes memory cd) = _ready();

        bytes32 foreignDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ContextLock"),
                keccak256("1"),
                uint256(1),
                address(executor)
            )
        );
        bytes32 foreignDigest = keccak256(abi.encodePacked("\x19\x01", foreignDomain, ContextLockTypes.hashStruct(cap)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(issuerPk, foreignDigest);

        vm.prank(relayer);
        vm.expectRevert(ContextLockExecutor.InvalidSignature.selector);
        executor.execute(cap, abi.encodePacked(r, s, v), cd, ACTION_KIND);
    }

    /// CAP-006: a capability naming a different executor cannot be spent here.
    function test_CAP_006_wrongExecutorRejected() public {
        Capability memory m = _baseCapability();
        m.executor = address(0xE1EC);
        _authorizeAllow(m);
        bytes memory sig = _sign(m, issuerPk);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ContextLockExecutor.ExecutorMismatch.selector, address(0xE1EC), address(executor))
        );
        executor.execute(m, sig, _callData(), ACTION_KIND);
    }

    /// CAP-007: expired by exactly one second.
    function test_CAP_007_expiredByOneSecond() public {
        Capability memory cap = _baseCapability();
        // Give the authorization a window that outlives the capability, so this test isolates the
        // expiry boundary rather than tripping the (separately tested) staleness check first.
        _authorize(cap, IAuthReg.Verdict.ALLOW, uint64(block.timestamp + 10_000));
        bytes memory sig = _sign(cap, issuerPk);
        bytes memory cd = _callData();

        vm.warp(cap.expiresAt); // still valid on the boundary
        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 1, "valid exactly at expiresAt");

        // A second capability, one second past expiry.
        Capability memory m = _baseCapability();
        m.nonce = 2;
        // Distinct authorization id: authorizations are write-once, so reusing "auth-1" would
        // (correctly) revert AuthorizationExists and never reach the expiry check under test.
        m.authorizationId = keccak256("auth-expiry");
        m.issuedAt = uint64(block.timestamp);
        m.expiresAt = uint64(block.timestamp + 100);
        _authorize(m, IAuthReg.Verdict.ALLOW, uint64(block.timestamp + 10_000));
        bytes memory sig2 = _sign(m, issuerPk);

        vm.warp(uint256(m.expiresAt) + 1);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ContextLockExecutor.CapabilityExpired.selector, m.expiresAt, block.timestamp)
        );
        executor.execute(m, sig2, cd, ACTION_KIND);
        assertEq(target.callCount(), 1, "no second call");
    }

    /// CAP-008: issuedAt unreasonably in the future.
    function test_CAP_008_issuedInFutureRejected() public {
        Capability memory m = _baseCapability();
        m.issuedAt = uint64(block.timestamp + 3600);
        m.expiresAt = uint64(block.timestamp + 3700);
        _authorizeAllow(m);
        bytes memory sig = _sign(m, issuerPk);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ContextLockExecutor.IssuedInFuture.selector, m.issuedAt, block.timestamp)
        );
        executor.execute(m, sig, _callData(), ACTION_KIND);
    }

    /// CAP-008b: clock skew inside tolerance is accepted, outside is not.
    function test_CAP_008b_clockSkewBoundary() public {
        Capability memory ok_ = _baseCapability();
        ok_.issuedAt = uint64(block.timestamp + executor.MAX_CLOCK_SKEW());
        ok_.expiresAt = ok_.issuedAt + 100;
        _authorizeAllow(ok_);
        bytes memory okSig = _sign(ok_, issuerPk);
        vm.prank(relayer);
        executor.execute(ok_, okSig, _callData(), ACTION_KIND);
        assertEq(target.callCount(), 1);

        Capability memory bad = _baseCapability();
        bad.nonce = 9;
        bad.authorizationId = keccak256("auth-skew");
        bad.issuedAt = uint64(block.timestamp + executor.MAX_CLOCK_SKEW() + 1);
        bad.expiresAt = bad.issuedAt + 100;
        _authorizeAllow(bad);
        bytes memory badSig = _sign(bad, issuerPk);
        bytes memory badCd = _callData();
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ContextLockExecutor.IssuedInFuture.selector, bad.issuedAt, block.timestamp)
        );
        executor.execute(bad, badSig, badCd, ACTION_KIND);
        assertEq(target.callCount(), 1, "no second call");
    }

    /// CAP-009 / ADV-004: replaying the same nonce after a successful execution reverts.
    function test_CAP_009_replayRejected() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();

        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 1);

        // Byte-identical resubmission by anyone, including a thief who captured it off the wire.
        vm.prank(address(0xDEAD));
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.NonceUsed.selector, cap.nonce));
        executor.execute(cap, sig, cd, ACTION_KIND);

        assertEq(target.callCount(), 1, "replay did not reach the target");
        assertEq(target.balanceOf(recipient), AMOUNT, "no double spend");
    }

    /// CAP-010: two submissions of the same capability — at most one succeeds.
    function test_CAP_010_concurrentSubmissionsAtMostOne() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();

        uint256 successes;
        vm.prank(relayer);
        try executor.execute(cap, sig, cd, ACTION_KIND) {
            successes++;
        } catch {}
        vm.prank(address(0xDEAD));
        try executor.execute(cap, sig, cd, ACTION_KIND) {
            successes++;
        } catch {}

        assertEq(successes, 1, "exactly one submission succeeded");
        assertEq(target.callCount(), 1, "target called once");
    }

    /// CAP-011: signed by anyone other than the configured issuer.
    function test_CAP_011_wrongSignerRejected() public {
        Capability memory cap = _baseCapability();
        _authorizeAllow(cap);
        bytes memory badSig = _sign(cap, wrongPk);

        vm.prank(relayer);
        vm.expectRevert(ContextLockExecutor.InvalidSignature.selector);
        executor.execute(cap, badSig, _callData(), ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    /// CAP-011b: malformed and malleable signatures are rejected, not merely mis-recovered.
    function test_CAP_011b_malformedAndMalleableSignatures() public {
        (Capability memory cap,, bytes memory cd) = _ready();

        vm.prank(relayer);
        vm.expectRevert(ContextLockExecutor.InvalidSignature.selector);
        executor.execute(cap, hex"1234", cd, ACTION_KIND);

        // High-s malleable variant of a valid signature must not verify.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(issuerPk, _digest(cap));
        uint256 N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(N - uint256(s));
        uint8 flipped = v == 27 ? 28 : 27;

        vm.prank(relayer);
        vm.expectRevert(ContextLockExecutor.InvalidSignature.selector);
        executor.execute(cap, abi.encodePacked(r, highS, flipped), cd, ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    /// CAP-012: ERC-1271 contract issuer — accepts the correct magic value, rejects a wrong one.
    function test_CAP_012_erc1271Issuer() public {
        MockERC1271Issuer contractIssuer = new MockERC1271Issuer(issuer);

        ContextLockExecutor exec2 = new ContextLockExecutor(
            address(contractIssuer),
            IContextLockPolicyRegistry(address(policy)),
            IAuthReg(address(auth)),
            IAgentIdentityVerifier(address(identity)),
            IContextLockApprovalRegistry(address(approvals))
        );
        vm.prank(admin);
        policy.setTargetAllowed(agentIdentityHash, policyHash, address(target), true);

        Capability memory cap = _baseCapability();
        cap.executor = address(exec2);
        cap.authorizationId = keccak256("auth-1271");
        _authorizeAllow(cap);

        bytes32 d = keccak256(abi.encodePacked("\x19\x01", exec2.DOMAIN_SEPARATOR(), ContextLockTypes.hashStruct(cap)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(issuerPk, d);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Wrong magic value => rejected.
        contractIssuer.setReturnWrongMagic(true);
        vm.prank(relayer);
        vm.expectRevert(ContextLockExecutor.InvalidSignature.selector);
        exec2.execute(cap, sig, _callData(), ACTION_KIND);
        assertEq(target.callCount(), 0);

        // Correct magic value => accepted.
        contractIssuer.setReturnWrongMagic(false);
        vm.prank(relayer);
        exec2.execute(cap, sig, _callData(), ACTION_KIND);
        assertEq(target.callCount(), 1);
    }

    /// Unsupported schema version is rejected.
    function test_unsupportedVersionRejected() public {
        Capability memory m = _baseCapability();
        m.version = 2;
        _authorizeAllow(m);
        bytes memory sig = _sign(m, issuerPk);
        bytes memory cd = _callData();
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.UnsupportedVersion.selector, 2, 1));
        executor.execute(m, sig, cd, ACTION_KIND);
    }

    /// A capability with an absurdly long lifetime is rejected — freshness is structural.
    function test_excessiveLifetimeRejected() public {
        Capability memory m = _baseCapability();
        m.expiresAt = uint64(block.timestamp + 2 hours);
        _authorizeAllow(m);
        bytes memory sig = _sign(m, issuerPk);
        bytes memory cd = _callData();
        vm.prank(relayer);
        vm.expectRevert(ContextLockExecutor.InvalidTimeWindow.selector);
        executor.execute(m, sig, cd, ACTION_KIND);
    }
}
