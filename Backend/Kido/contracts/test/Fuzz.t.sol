// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {Capability, ContextLockTypes} from "../src/ContextLockTypes.sol";
import {ContextLockExecutor} from "../src/ContextLockExecutor.sol";
import {IContextLockAuthorizationRegistry as IAuthReg} from "../src/interfaces/IContextLockAuthorizationRegistry.sol";

contract FuzzTest is Base {
    /// Any calldata whose hash differs from the commitment is rejected, at any length.
    function testFuzz_arbitraryCalldataRejected(bytes calldata attackerCalldata) public {
        (Capability memory cap, bytes memory sig,) = _ready();
        vm.assume(keccak256(attackerCalldata) != cap.calldataHash);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ContextLockExecutor.CalldataHashMismatch.selector, keccak256(attackerCalldata), cap.calldataHash
            )
        );
        executor.execute(cap, sig, attackerCalldata, ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    /// No nonce other than the signed one is spendable, and the signature does not transfer.
    function testFuzz_nonceCannotBeSubstituted(uint256 otherNonce) public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();
        vm.assume(otherNonce != cap.nonce);

        Capability memory m = _copy(cap);
        m.nonce = otherNonce;

        vm.prank(relayer);
        vm.expectRevert(ContextLockExecutor.InvalidSignature.selector);
        executor.execute(m, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    /// Execution is impossible at any timestamp strictly after expiry.
    function testFuzz_neverExecutesAfterExpiry(uint64 skip) public {
        Capability memory cap = _baseCapability();
        _authorize(cap, IAuthReg.Verdict.ALLOW, type(uint64).max - 1);
        bytes memory sig = _sign(cap, issuerPk);
        bytes memory cd = _callData();

        skip = uint64(bound(skip, 1, 3650 days));
        vm.warp(uint256(cap.expiresAt) + skip);

        vm.prank(relayer);
        vm.expectRevert();
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    /// Any signer other than the issuer is refused, whatever key they hold.
    function testFuzz_onlyIssuerSignatureAccepted(uint256 pk) public {
        pk = bound(pk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        vm.assume(vm.addr(pk) != issuer);

        Capability memory cap = _baseCapability();
        _authorizeAllow(cap);
        bytes memory sig = _sign(cap, pk);
        bytes memory cd = _callData();

        vm.prank(relayer);
        vm.expectRevert(ContextLockExecutor.InvalidSignature.selector);
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 0);
    }

    /// Mutating ANY single security-relevant field invalidates the capability. This is the
    /// mutation suite the bible requires, driven by a fuzzer over field index.
    function testFuzz_singleFieldMutationAlwaysFails(uint8 fieldIndex, bytes32 noise) public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();
        vm.assume(noise != bytes32(0));
        fieldIndex = uint8(bound(fieldIndex, 0, 13));

        Capability memory m = _copy(cap);
        if (fieldIndex == 0) m.version = uint8(uint256(noise) % 200 + 2);
        else if (fieldIndex == 1) m.agentIdentityHash = noise;
        else if (fieldIndex == 2) m.agent = address(uint160(uint256(noise)));
        else if (fieldIndex == 3) m.chainId = uint256(noise);
        else if (fieldIndex == 4) m.executor = address(uint160(uint256(noise)));
        else if (fieldIndex == 5) m.target = address(uint160(uint256(noise)));
        else if (fieldIndex == 6) m.value = uint256(noise);
        else if (fieldIndex == 7) m.calldataHash = noise;
        else if (fieldIndex == 8) m.intentHash = noise;
        else if (fieldIndex == 9) m.policyHash = noise;
        else if (fieldIndex == 10) m.authorizationId = noise;
        else if (fieldIndex == 11) m.contextCommitment = noise;
        else if (fieldIndex == 12) m.expiresAt = uint64(uint256(noise));
        else m.nonce = uint256(noise);

        // Skip the degenerate case where the fuzzer picked the identical value.
        vm.assume(ContextLockTypes.hashStruct(m) != ContextLockTypes.hashStruct(cap));

        vm.prank(relayer);
        vm.expectRevert();
        executor.execute(m, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 0, "no mutation reached the target");
    }

    /// Changing any request-relevant field changes the request hash, so a CRE ALLOW for one
    /// transaction is never spendable on another.
    function testFuzz_requestHashIsCollisionSensitive(bytes32 noise) public view {
        Capability memory cap = _baseCapability();
        bytes32 baseline = ContextLockTypes.requestHash(cap);

        Capability memory m = _copy(cap);
        m.calldataHash = noise;
        if (noise != cap.calldataHash) {
            assertTrue(ContextLockTypes.requestHash(m) != baseline, "calldata change must move requestHash");
        }

        Capability memory t = _copy(cap);
        t.target = address(uint160(uint256(noise)));
        if (t.target != cap.target) {
            assertTrue(ContextLockTypes.requestHash(t) != baseline, "target change must move requestHash");
        }

        Capability memory v = _copy(cap);
        v.value = uint256(noise);
        if (v.value != cap.value) {
            assertTrue(ContextLockTypes.requestHash(v) != baseline, "value change must move requestHash");
        }
    }
}
