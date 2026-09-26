// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {Capability} from "../src/ContextLockTypes.sol";
import {ContextLockExecutor} from "../src/ContextLockExecutor.sol";
import {ContextLockPolicyRegistry} from "../src/ContextLockPolicyRegistry.sol";
import {IContextLockAuthorizationRegistry as IAuthReg} from "../src/interfaces/IContextLockAuthorizationRegistry.sol";
import {MockTreasuryTarget} from "../src/mocks/MockTreasuryTarget.sol";

/// @notice POL-001 .. POL-004 — public on-chain financial policy.
contract PolicyTest is Base {
    /// POL-001: allowed action on an allowed target executes.
    function test_POL_001_allowedActionAndTarget() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();
        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);
        assertEq(target.callCount(), 1);
    }

    /// POL-002: an action kind outside the policy is refused.
    function test_POL_002_disallowedActionKind() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();
        bytes32 forbidden = keccak256("DRAIN_TREASURY");

        vm.prank(relayer);
        vm.expectRevert();
        executor.execute(cap, sig, cd, forbidden);
        assertEq(target.callCount(), 0);
    }

    /// POL-003: a target outside the allowlist is refused even with a valid signature.
    function test_POL_003_disallowedTarget() public {
        MockTreasuryTarget rogue = new MockTreasuryTarget();

        Capability memory m = _baseCapability();
        m.target = address(rogue);
        m.calldataHash = keccak256(_callData());
        _authorizeAllow(m);
        bytes memory sig = _sign(m, issuerPk);
        bytes memory cd = _callData();

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.TargetNotAllowed.selector, address(rogue)));
        executor.execute(m, sig, cd, ACTION_KIND);
        assertEq(rogue.callCount(), 0);
    }

    /// POL-004: disabling the policy after issuance kills an outstanding, unexpired capability.
    function test_POL_004_policyDisabledAfterMint() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();

        // The capability is fully valid at this instant.
        assertTrue(policy.isPolicyEnabled(agentIdentityHash, policyHash));

        vm.prank(admin);
        policy.setPolicy(agentIdentityHash, policyHash, false, HARD_CAP);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(ContextLockExecutor.PolicyDisabled.selector, agentIdentityHash, policyHash)
        );
        executor.execute(cap, sig, cd, ACTION_KIND);

        assertEq(target.callCount(), 0, "disabled policy blocked an already-signed capability");
        assertFalse(executor.nonceUsed(cap.agentIdentityHash, cap.nonce), "nonce not burned by a failed attempt");
    }

    /// The hard cap is an on-chain ceiling independent of any off-chain evaluation.
    function test_POL_valueHardCapEnforced() public {
        vm.prank(admin);
        policy.setPolicy(agentIdentityHash, policyHash, true, 1 wei);

        Capability memory m = _baseCapability();
        m.value = 1 ether;
        _authorizeAllow(m);
        bytes memory sig = _sign(m, issuerPk);
        bytes memory cd = _callData();

        vm.deal(relayer, 2 ether);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ContextLockExecutor.ValueExceedsHardCap.selector, 1 ether, 1));
        executor.execute{value: 1 ether}(m, sig, cd, ACTION_KIND);
    }

    /// Only the policy admin may change financial authority.
    function test_POL_onlyAdminMayChangePolicy() public {
        vm.prank(agent);
        vm.expectRevert(ContextLockPolicyRegistry.NotAdmin.selector);
        policy.setPolicy(agentIdentityHash, policyHash, false, 0);

        vm.prank(agent);
        vm.expectRevert(ContextLockPolicyRegistry.NotAdmin.selector);
        policy.setTargetAllowed(agentIdentityHash, policyHash, address(0xBAD), true);

        // The compromised agent cannot grant itself authority.
        vm.prank(agent);
        vm.expectRevert(ContextLockPolicyRegistry.NotAdmin.selector);
        policy.bumpBindingVersion(agentIdentityHash);
    }
}
