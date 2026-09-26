// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Capability, ContextLockTypes} from "../src/ContextLockTypes.sol";
import {ContextLockExecutor} from "../src/ContextLockExecutor.sol";
import {ContextLockPolicyRegistry} from "../src/ContextLockPolicyRegistry.sol";
import {ContextLockAuthorizationRegistry} from "../src/ContextLockAuthorizationRegistry.sol";
import {IContextLockAuthorizationRegistry as IAuthReg} from "../src/interfaces/IContextLockAuthorizationRegistry.sol";
import {IContextLockPolicyRegistry} from "../src/interfaces/IContextLockPolicyRegistry.sol";
import {IAgentIdentityVerifier} from "../src/interfaces/IAgentIdentityVerifier.sol";
import {LocalAgentIdentityVerifier} from "../src/identity/LocalAgentIdentityVerifier.sol";
import {MockTreasuryTarget} from "../src/mocks/MockTreasuryTarget.sol";
import {IContextLockApprovalRegistry} from "../src/ContextLockExecutor.sol";

/// @notice Drives the executor with adversarially-shaped input and tallies ground truth.
contract Handler is Test {
    ContextLockExecutor public executor;
    ContextLockPolicyRegistry public policy;
    ContextLockAuthorizationRegistry public auth;
    LocalAgentIdentityVerifier public identity;
    MockTreasuryTarget public target;

    uint256 internal issuerPk;
    address internal admin;
    address internal authorizer;
    bytes32 public agentIdentityHash;
    bytes32 public policyHash;
    bytes32 public constant ACTION_KIND = keccak256("MOCK_TRANSFER");

    /// @dev Ground truth maintained by the handler, compared against contract state.
    mapping(uint256 nonce => uint256) public successCountByNonce;
    uint256 public totalSuccesses;
    uint256 public targetCallsWhenPolicyDisabled;
    bool public policyEnabled = true;

    constructor(
        ContextLockExecutor e,
        ContextLockPolicyRegistry p,
        ContextLockAuthorizationRegistry a,
        LocalAgentIdentityVerifier i,
        MockTreasuryTarget t,
        uint256 pk,
        address admin_,
        address authorizer_,
        bytes32 aih,
        bytes32 ph
    ) {
        executor = e;
        policy = p;
        auth = a;
        identity = i;
        target = t;
        issuerPk = pk;
        admin = admin_;
        authorizer = authorizer_;
        agentIdentityHash = aih;
        policyHash = ph;
    }

    function _cd(uint256 amount) internal view returns (bytes memory) {
        return abi.encodeCall(MockTreasuryTarget.transferTo, (address(0xC0FFEE), amount));
    }

    /// Attempt a well-formed execution with a fuzzed nonce.
    function tryExecute(uint256 nonce, uint96 amount) external {
        nonce = bound(nonce, 1, 8);
        bytes memory cd = _cd(uint256(amount));

        Capability memory cap = Capability({
            version: 1,
            agentIdentityHash: agentIdentityHash,
            agent: address(0xA6E7),
            chainId: block.chainid,
            executor: address(executor),
            target: address(target),
            value: 0,
            calldataHash: keccak256(cd),
            intentHash: keccak256("fuzz"),
            policyHash: policyHash,
            authorizationId: keccak256(abi.encode(nonce, amount)),
            contextCommitment: keccak256("ctx"),
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 300),
            nonce: nonce
        });

        if (auth.getAuthorization(cap.authorizationId).verdict == IAuthReg.Verdict.NONE) {
            vm.prank(authorizer);
            try auth.recordAuthorization(
                cap.authorizationId,
                ContextLockTypes.requestHash(cap),
                cap.policyHash,
                cap.contextCommitment,
                uint64(block.timestamp),
                uint64(block.timestamp + 120),
                IAuthReg.Verdict.ALLOW
            ) {} catch {
                return;
            }
        }

        bytes32 d =
            keccak256(abi.encodePacked("\x19\x01", executor.DOMAIN_SEPARATOR(), ContextLockTypes.hashStruct(cap)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(issuerPk, d);

        uint256 before = target.callCount();
        try executor.execute(cap, abi.encodePacked(r, s, v), cd, ACTION_KIND) {
            successCountByNonce[nonce] += 1;
            totalSuccesses += 1;
            if (!policyEnabled) targetCallsWhenPolicyDisabled += 1;
        } catch {
            // A failed validation must not have touched the target.
            require(target.callCount() == before, "INVARIANT: target mutated on failed validation");
        }
    }

    function togglePolicy(bool enable) external {
        policyEnabled = enable;
        vm.prank(admin);
        policy.setPolicy(agentIdentityHash, policyHash, enable, 10 ether);
    }

    function revokeIdentity() external {
        vm.prank(admin);
        identity.revoke(agentIdentityHash);
    }

    function restoreIdentity() external {
        vm.prank(admin);
        identity.bind(agentIdentityHash, address(0xA6E7));
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 400));
    }
}

contract InvariantTest is Test {
    Handler internal handler;
    ContextLockExecutor internal executor;
    ContextLockPolicyRegistry internal policy;
    ContextLockAuthorizationRegistry internal auth;
    LocalAgentIdentityVerifier internal identity;
    MockTreasuryTarget internal target;

    bytes32 internal agentIdentityHash = keccak256("invariant-identity");
    bytes32 internal policyHash = keccak256("invariant-policy");
    address internal admin = address(0xAD11);
    address internal authorizer = address(0xA07);
    uint256 internal issuerPk = 0xA11CE;

    function setUp() public {
        vm.warp(1_800_000_000);
        policy = new ContextLockPolicyRegistry();
        auth = new ContextLockAuthorizationRegistry(admin, authorizer);
        identity = new LocalAgentIdentityVerifier(admin);
        target = new MockTreasuryTarget();
        executor = new ContextLockExecutor(
            vm.addr(issuerPk),
            IContextLockPolicyRegistry(address(policy)),
            IAuthReg(address(auth)),
            IAgentIdentityVerifier(address(identity)),
            IContextLockApprovalRegistry(address(0))
        );

        policy.setPolicyAdmin(agentIdentityHash, admin);
        vm.startPrank(admin);
        policy.setPolicy(agentIdentityHash, policyHash, true, 10 ether);
        policy.setTargetAllowed(agentIdentityHash, policyHash, address(target), true);
        policy.setActionAllowed(agentIdentityHash, policyHash, keccak256("MOCK_TRANSFER"), true);
        identity.bind(agentIdentityHash, address(0xA6E7));
        vm.stopPrank();

        handler = new Handler(
            executor, policy, auth, identity, target, issuerPk, admin, authorizer, agentIdentityHash, policyHash
        );
        targetContract(address(handler));
    }

    /// INV-1: successfulExecutionsByNonce[n] <= 1 for every nonce.
    function invariant_atMostOneSuccessPerNonce() public view {
        for (uint256 n = 1; n <= 8; n++) {
            assertLe(handler.successCountByNonce(n), 1, "a nonce executed more than once");
        }
    }

    /// INV-2: the target is called exactly as many times as executions succeeded. A failed
    /// validation can never have produced a target state change.
    function invariant_targetCallsEqualSuccesses() public view {
        assertEq(target.callCount(), handler.totalSuccesses(), "target calls diverged from successes");
    }

    /// INV-3: a disabled policy admits no successful protected execution.
    function invariant_disabledPolicyNeverExecutes() public view {
        assertEq(handler.targetCallsWhenPolicyDisabled(), 0, "execution succeeded while policy disabled");
    }

    /// INV-4: every consumed nonce corresponds to a recorded success.
    function invariant_nonceFlagsMatchSuccesses() public view {
        uint256 flagged;
        for (uint256 n = 1; n <= 8; n++) {
            if (executor.nonceUsed(agentIdentityHash, n)) flagged++;
        }
        assertEq(flagged, handler.totalSuccesses(), "nonce flags diverged from successful executions");
    }
}
