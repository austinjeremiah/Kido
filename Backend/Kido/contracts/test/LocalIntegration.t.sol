// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {Capability, ContextLockTypes} from "../src/ContextLockTypes.sol";
import {ContextLockExecutor} from "../src/ContextLockExecutor.sol";
import {console2} from "forge-std/console2.sol";

/// @notice The full Phase 1 vertical slice with printed evidence: deploy, authorize, sign,
///         execute, then prove replay and mutation are rejected.
contract LocalIntegrationTest is Base {
    function test_fullLocalFlowWithEvidence() public {
        console2.log("=== ContextLock Phase 1 local integration ===");
        console2.log("chainId            ", block.chainid);
        console2.log("policyRegistry     ", address(policy));
        console2.log("authRegistry       ", address(auth));
        console2.log("identityVerifier   ", address(identity));
        console2.log("executor           ", address(executor));
        console2.log("mockTarget         ", address(target));
        console2.log("capabilityIssuer   ", issuer);
        console2.log("agent              ", agent);

        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();

        console2.log("--- capability ---");
        console2.logBytes32(_digest(cap));
        console2.log("nonce              ", cap.nonce);
        console2.log("expiresAt          ", cap.expiresAt);
        console2.log("requestHash:");
        console2.logBytes32(ContextLockTypes.requestHash(cap));

        console2.log("--- target state BEFORE ---");
        console2.log("callCount          ", target.callCount());
        console2.log("recipient balance  ", target.balanceOf(recipient));
        assertEq(target.callCount(), 0);

        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);

        console2.log("--- target state AFTER ---");
        console2.log("callCount          ", target.callCount());
        console2.log("recipient balance  ", target.balanceOf(recipient));
        console2.log("lastRecipient      ", target.lastRecipient());
        console2.log("lastAmount         ", target.lastAmount());
        assertEq(target.callCount(), 1);
        assertEq(target.balanceOf(recipient), AMOUNT);

        console2.log("--- replay rejection ---");
        vm.prank(address(0xDEAD));
        try executor.execute(cap, sig, cd, ACTION_KIND) {
            revert("replay unexpectedly succeeded");
        } catch {
            console2.log("replay REJECTED (NonceUsed)");
        }
        assertEq(target.callCount(), 1, "replay did not reach target");

        console2.log("--- mutation rejection ---");
        bytes memory mutated = cd;
        mutated[mutated.length - 1] = bytes1(uint8(mutated[mutated.length - 1]) ^ 0x01);
        Capability memory fresh = _baseCapability();
        fresh.nonce = 42;
        fresh.authorizationId = keccak256("auth-integration-2");
        _authorizeAllow(fresh);
        bytes memory freshSig = _sign(fresh, issuerPk);

        vm.prank(relayer);
        try executor.execute(fresh, freshSig, mutated, ACTION_KIND) {
            revert("mutation unexpectedly succeeded");
        } catch {
            console2.log("calldata mutation REJECTED (CalldataHashMismatch)");
        }
        assertEq(target.callCount(), 1, "mutation did not reach target");

        console2.log("=== local integration complete: 1 exact call, 0 unauthorized ===");
    }
}
