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
import {ContextLockApprovalRegistry} from "../src/ContextLockApprovalRegistry.sol";
import {IContextLockApprovalRegistry} from "../src/ContextLockExecutor.sol";

/// @notice Shared fixture. Builds a fully valid, executable capability so every negative test is
///         exactly one mutation away from a known-good baseline.
abstract contract Base is Test {
    ContextLockPolicyRegistry internal policy;
    ContextLockAuthorizationRegistry internal auth;
    LocalAgentIdentityVerifier internal identity;
    ContextLockExecutor internal executor;
    MockTreasuryTarget internal target;
    ContextLockApprovalRegistry internal approvals;

    /// @dev Cached so `_digest`/`_sign` perform NO external call. A helper that reads the
    ///      executor, inlined into an argument list after `vm.expectRevert`, would arm the
    ///      cheatcode against that read instead of against `execute` — and the test would then
    ///      report "did not revert" while the contract was behaving correctly.
    bytes32 internal domainSeparator;

    uint256 internal approverPk = 0x1EDBE4;
    address internal approver;

    uint256 internal issuerPk = 0xA11CE;
    address internal issuer;
    uint256 internal wrongPk = 0xBAD;

    address internal admin = address(0xAD11);
    address internal authorizer = address(0xA07);
    address internal agent = address(0xA6E7);
    address internal relayer = address(0xBEEF);
    address internal recipient = address(0xC0FFEE);

    bytes32 internal agentIdentityHash = keccak256("treasury.agents.contextlock.eth#1");
    bytes32 internal policyHash = keccak256("policy-v1");
    bytes32 internal intentHash = keccak256("REBALANCE_SWAP:500 units to recipient");
    bytes32 internal contextCommitment = keccak256("ctx-commitment-v1");
    bytes32 internal constant ACTION_KIND = keccak256("MOCK_TRANSFER");
    bytes32 internal authorizationId = keccak256("auth-1");

    uint256 internal constant AMOUNT = 500;
    uint256 internal constant HARD_CAP = 10 ether;

    function setUp() public virtual {
        issuer = vm.addr(issuerPk);

        policy = new ContextLockPolicyRegistry();
        auth = new ContextLockAuthorizationRegistry(admin, authorizer);
        identity = new LocalAgentIdentityVerifier(admin);
        target = new MockTreasuryTarget();
        approver = vm.addr(approverPk);
        approvals = new ContextLockApprovalRegistry(admin, approver);

        executor = new ContextLockExecutor(
            issuer,
            IContextLockPolicyRegistry(address(policy)),
            IAuthReg(address(auth)),
            IAgentIdentityVerifier(address(identity)),
            IContextLockApprovalRegistry(address(approvals))
        );
        vm.prank(admin);
        approvals.setExecutor(address(executor));

        policy.setPolicyAdmin(agentIdentityHash, admin);
        vm.startPrank(admin);
        policy.setPolicy(agentIdentityHash, policyHash, true, HARD_CAP);
        policy.setTargetAllowed(agentIdentityHash, policyHash, address(target), true);
        policy.setActionAllowed(agentIdentityHash, policyHash, ACTION_KIND, true);
        identity.bind(agentIdentityHash, agent);
        vm.stopPrank();

        domainSeparator = executor.DOMAIN_SEPARATOR();

        vm.warp(1_800_000_000);
    }

    function _callData() internal view returns (bytes memory) {
        return abi.encodeCall(MockTreasuryTarget.transferTo, (recipient, AMOUNT));
    }

    function _baseCapability() internal view returns (Capability memory cap) {
        cap = Capability({
            version: 1,
            agentIdentityHash: agentIdentityHash,
            agent: agent,
            chainId: block.chainid,
            executor: address(executor),
            target: address(target),
            value: 0,
            calldataHash: keccak256(_callData()),
            intentHash: intentHash,
            policyHash: policyHash,
            authorizationId: authorizationId,
            contextCommitment: contextCommitment,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 300),
            nonce: 1
        });
    }

    function _authorize(Capability memory cap, IAuthReg.Verdict verdict, uint64 approvedUntil) internal {
        vm.prank(authorizer);
        auth.recordAuthorization(
            cap.authorizationId,
            ContextLockTypes.requestHash(cap),
            cap.policyHash,
            cap.contextCommitment,
            uint64(block.timestamp),
            approvedUntil,
            verdict
        );
    }

    function _authorizeAllow(Capability memory cap) internal {
        _authorize(cap, IAuthReg.Verdict.ALLOW, uint64(block.timestamp + 60));
    }

    function _digest(Capability memory cap) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, ContextLockTypes.hashStruct(cap)));
    }

    /// @notice Deep copy. `Capability memory b = a;` aliases the same memory in Solidity rather
    ///         than copying, so mutating `b` would silently mutate the baseline `a` — making a
    ///         negative test compare a value against itself and pass for the wrong reason.
    function _copy(Capability memory c) internal pure returns (Capability memory o) {
        o = Capability({
            version: c.version,
            agentIdentityHash: c.agentIdentityHash,
            agent: c.agent,
            chainId: c.chainId,
            executor: c.executor,
            target: c.target,
            value: c.value,
            calldataHash: c.calldataHash,
            intentHash: c.intentHash,
            policyHash: c.policyHash,
            authorizationId: c.authorizationId,
            contextCommitment: c.contextCommitment,
            issuedAt: c.issuedAt,
            expiresAt: c.expiresAt,
            nonce: c.nonce
        });
    }

    function _sign(Capability memory cap, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(cap));
        return abi.encodePacked(r, s, v);
    }

    function _ready() internal returns (Capability memory cap, bytes memory sig, bytes memory cd) {
        cap = _baseCapability();
        _authorizeAllow(cap);
        sig = _sign(cap, issuerPk);
        cd = _callData();
    }
}
