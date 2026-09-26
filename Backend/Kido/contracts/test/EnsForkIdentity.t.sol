// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {EnsAgentIdentityVerifier, IEnsV2Registry} from "../src/identity/EnsAgentIdentityVerifier.sol";

/// @notice ID-003: proves the ENS EXPIRY branch against REAL live Sepolia state.
///
/// @dev Method, stated plainly: this is a Foundry fork test. The ENSv2 registry, the registered
///      ContextLock name and its real expiry are all live Sepolia state, read over RPC. The only
///      thing simulated is the passage of time (`vm.warp`). Expiry cannot be forced on-chain
///      because a name registered through ETHRegistrar does not grant its owner ROLE_UNREGISTER
///      or ROLE_RENEW (see reports/phase-03/findings/FND-009), and the name expires in 2027.
///
///      This is reported as a fork test everywhere it appears. It is not presented as a live
///      transaction.
contract EnsForkIdentityTest is Test {
    IEnsV2Registry constant ENS_REGISTRY = IEnsV2Registry(0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2);
    uint256 constant LABEL_ID = 45167563548464372371267871489323564930560539045322615271368248379128849036792;
    address constant AGENT = 0xA263b2cA150B5A1cA7bf08adF966B847c487F50f;

    EnsAgentIdentityVerifier internal verifier;
    address internal admin = address(this);
    uint256 internal forkId;

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        forkId = vm.createSelectFork(rpc);
        verifier = new EnsAgentIdentityVerifier(admin);
    }

    function test_ID_003_expiredNameFailsClosed() public {
        // vm.skip marks the test SKIPPED. Returning early would report PASS without proving
        // anything, which is worse than a failure because it looks like evidence.
        vm.skip(bytes(vm.envOr("SEPOLIA_RPC_URL", string(""))).length == 0);

        uint256 tokenId = ENS_REGISTRY.getTokenId(LABEL_ID);
        address nameOwner = ENS_REGISTRY.ownerOf(tokenId);
        uint64 expiry = ENS_REGISTRY.getExpiry(LABEL_ID);

        console2.log("=== ID-003 fork test against live Sepolia ENSv2 ===");
        console2.log("block.timestamp (live)", block.timestamp);
        console2.log("name expiry           ", expiry);
        console2.log("current owner         ", nameOwner);
        assertTrue(nameOwner != address(0), "precondition: name is currently registered");
        assertGt(expiry, block.timestamp, "precondition: name has NOT yet expired");

        bytes32 aih = verifier.bind(ENS_REGISTRY, LABEL_ID, AGENT, 1);
        console2.log("agentIdentityHash:");
        console2.logBytes32(aih);

        // Before expiry: identity is current.
        assertTrue(verifier.isIdentityCurrent(aih, AGENT), "identity should be current before expiry");
        console2.log("isIdentityCurrent BEFORE expiry = true");

        // Advance past the real registered expiry. Everything else is live state.
        vm.warp(uint256(expiry) + 1);
        console2.log("warped to             ", block.timestamp);

        // ENSv2 zeroes ownerOf past expiry while latestOwnerOf keeps the historical owner.
        address ownerAfter = ENS_REGISTRY.ownerOf(tokenId);
        address latestAfter = ENS_REGISTRY.latestOwnerOf(tokenId);
        console2.log("ownerOf AFTER expiry       ", ownerAfter);
        console2.log("latestOwnerOf AFTER expiry ", latestAfter);
        assertEq(ownerAfter, address(0), "ownerOf must be zero past expiry");
        assertTrue(latestAfter != address(0), "latestOwnerOf survives expiry - must NOT be used for auth");

        assertFalse(verifier.isIdentityCurrent(aih, AGENT), "expired name must fail closed");
        console2.log("isIdentityCurrent AFTER expiry = false");
        console2.log("ID-003 PASS: an expired ENS name invalidates the agent identity");
    }

    /// Guards against the specific bug this design avoids: using latestOwnerOf would make an
    /// expired name look valid forever.
    function test_ID_003b_latestOwnerOfWouldHaveBeenWrong() public {
        vm.skip(bytes(vm.envOr("SEPOLIA_RPC_URL", string(""))).length == 0);
        uint256 tokenId = ENS_REGISTRY.getTokenId(LABEL_ID);
        uint64 expiry = ENS_REGISTRY.getExpiry(LABEL_ID);
        vm.warp(uint256(expiry) + 365 days);
        assertEq(ENS_REGISTRY.ownerOf(tokenId), address(0), "ownerOf: correctly zero");
        assertTrue(
            ENS_REGISTRY.latestOwnerOf(tokenId) != address(0),
            "latestOwnerOf: still returns an owner a year past expiry - this is the trap"
        );
    }
}
