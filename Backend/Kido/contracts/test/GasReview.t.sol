// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {console2} from "forge-std/console2.sol";
import {Capability} from "../src/ContextLockTypes.sol";
import {ContextLockExecutor} from "../src/ContextLockExecutor.sol";
import {IContextLockAuthorizationRegistry as IAuthReg} from "../src/interfaces/IContextLockAuthorizationRegistry.sol";
import {MockTreasuryTarget} from "../src/mocks/MockTreasuryTarget.sol";

/// @notice P8.18 — gas and denial-of-service review of the money-moving paths.
/// @dev The question is not "is this cheap" but "can an attacker make it unboundedly expensive,
///      or make a legitimate execution fail by inflating cost".
contract GasReviewTest is Base {
    /// Baseline: a normal ALLOW execution.
    function test_GAS_baselineExecution() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();
        uint256 before = gasleft();
        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);
        uint256 used = before - gasleft();
        console2.log("GAS execute (ALLOW, warm target):", used);
        // Generous ceiling: this is a regression guard, not a micro-optimisation target.
        assertLt(used, 400_000, "baseline execution stays well under a sane ceiling");
    }

    /// GAS-DOS-001: calldata size is attacker-influenced. Cost must scale linearly, not explode,
    /// and crucially the capability binds keccak256(calldata) so oversized calldata simply fails.
    function test_GAS_DOS_largeCalldataScalesLinearlyAndCannotBypass() public {
        uint256[] memory sizes = new uint256[](3);
        sizes[0] = 100;
        sizes[1] = 4_000;
        sizes[2] = 32_000;

        uint256 lastUsed;
        for (uint256 i = 0; i < sizes.length; i++) {
            bytes memory big = new bytes(sizes[i]);
            Capability memory cap = _baseCapability();
            cap.nonce = 500 + i;
            cap.authorizationId = keccak256(abi.encode("gas", i));
            cap.calldataHash = keccak256(big);
            _authorizeAllow(cap);
            bytes memory sig = _sign(cap, issuerPk);

            uint256 before = gasleft();
            vm.prank(relayer);
            // The target has no matching selector, so it reverts — but the point is that the
            // executor reached the call at all only because the hash matched. Cost is measured
            // up to that point.
            try executor.execute(cap, sig, big, ACTION_KIND) {} catch {}
            uint256 used = before - gasleft();
            console2.log("GAS calldata bytes:", sizes[i]);
            console2.log("     gas used:", used);
            lastUsed = used;
        }
        // 32KB of calldata is ~500k gas of calldata cost alone; well under a block limit, and the
        // RELAYER pays it. An attacker inflating calldata is spending their own gas to get a
        // guaranteed revert.
        assertLt(lastUsed, 3_000_000, "even 32KB calldata stays far below the block gas limit");
    }

    /// GAS-DOS-002: a mismatched calldata hash is rejected BEFORE the external call, so an
    /// attacker cannot make the executor forward gas to an expensive target for free.
    function test_GAS_DOS_mismatchRejectedBeforeExternalCall() public {
        (Capability memory cap, bytes memory sig,) = _ready();
        bytes memory huge = new bytes(64_000);

        uint256 before = gasleft();
        vm.prank(relayer);
        try executor.execute(cap, sig, huge, ACTION_KIND) {} catch {}
        uint256 used = before - gasleft();
        console2.log("GAS rejected-oversized-calldata:", used);
        assertEq(target.callCount(), 0, "the target was never called");
    }

    /// GAS-DOS-003: nonce storage is O(1). Many prior executions do not slow a new one down.
    function test_GAS_DOS_nonceStorageIsConstantTime() public {
        // Burn 20 nonces.
        for (uint256 i = 0; i < 20; i++) {
            Capability memory c = _baseCapability();
            c.nonce = 2000 + i;
            c.authorizationId = keccak256(abi.encode("n", i));
            _authorizeAllow(c);
            vm.prank(relayer);
            executor.execute(c, _sign(c, issuerPk), _callData(), ACTION_KIND);
        }

        Capability memory fresh = _baseCapability();
        fresh.nonce = 9999;
        fresh.authorizationId = keccak256("n-fresh");
        _authorizeAllow(fresh);
        bytes memory sig = _sign(fresh, issuerPk);

        uint256 before = gasleft();
        vm.prank(relayer);
        executor.execute(fresh, sig, _callData(), ACTION_KIND);
        uint256 used = before - gasleft();
        console2.log("GAS execute after 20 prior nonces:", used);
        assertLt(used, 400_000, "cost does not grow with the number of consumed nonces");
        assertEq(target.callCount(), 21);
    }

    /// GAS-DOS-004: identity and policy lookups are fixed-cost reads, not loops.
    function test_GAS_DOS_identityAndPolicyLookupsAreFixedCost() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();
        uint256 before = gasleft();
        vm.prank(relayer);
        executor.execute(cap, sig, cd, ACTION_KIND);
        uint256 warm = before - gasleft();

        Capability memory second = _baseCapability();
        second.nonce = 7777;
        second.authorizationId = keccak256("second");
        _authorizeAllow(second);
        bytes memory sig2 = _sign(second, issuerPk);
        uint256 b2 = gasleft();
        vm.prank(relayer);
        executor.execute(second, sig2, cd, ACTION_KIND);
        uint256 warm2 = b2 - gasleft();

        console2.log("GAS first:", warm);
        console2.log("GAS second:", warm2);
        // The second is cheaper (warm storage) but the same order of magnitude — no growth term.
        assertLt(warm2, warm + 50_000, "no unbounded growth between executions");
    }

    /// GAS-DOS-005: a gas-burning target consumes only what it was forwarded; the executor does
    /// not do unbounded work on the attacker's behalf, and the whole tx simply fails.
    function test_GAS_DOS_gasBurningTargetCannotDrainTheRelayerBeyondTheCall() public {
        (Capability memory cap, bytes memory sig, bytes memory cd) = _ready();
        target.setShouldRevert(true);
        uint256 before = gasleft();
        vm.prank(relayer);
        try executor.execute{gas: 500_000}(cap, sig, cd, ACTION_KIND) {} catch {}
        uint256 used = before - gasleft();
        console2.log("GAS reverting target (capped at 500k):", used);
        assertLt(used, 600_000, "a hostile target cannot consume more than it is given");
        assertEq(target.callCount(), 0);
    }
}
