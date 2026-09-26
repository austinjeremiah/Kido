// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ContextLockApprovalRegistry} from "../src/ContextLockApprovalRegistry.sol";
import {ContextLockExecutor, IContextLockApprovalRegistry} from "../src/ContextLockExecutor.sol";
import {IContextLockPolicyRegistry} from "../src/interfaces/IContextLockPolicyRegistry.sol";
import {IContextLockAuthorizationRegistry as IAuthReg} from "../src/interfaces/IContextLockAuthorizationRegistry.sol";
import {IAgentIdentityVerifier} from "../src/interfaces/IAgentIdentityVerifier.sol";

/// @notice Phase 7: deploys the approval registry and a NEW executor wired to it.
/// @dev Per ADR-001 the executor gains an ESCALATE-only approval check. Executor state is
///      immutable, so this is a fresh deployment. The policy registry, authorization registry and
///      ENS identity verifier are REUSED — their interfaces are unchanged.
contract DeployP7 is Script {
    function run() external {
        console2.log("chainId          =", block.chainid);
        require(block.chainid == 11155111, "ABORT: not Ethereum Sepolia");
        console2.log("network          = Ethereum Sepolia");

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address issuer = vm.envAddress("CAPABILITY_ISSUER_ADDRESS");
        address approverAddr = vm.envAddress("LEDGER_APPROVER_ADDRESS");
        address policyReg = vm.envAddress("POLICY_REGISTRY_ADDRESS");
        address authReg = vm.envAddress("AUTH_REGISTRY_ADDRESS");
        address identity = vm.envAddress("IDENTITY_ADDRESS");

        console2.log("deployer         =", deployer);
        console2.log("capabilityIssuer =", issuer);
        console2.log("ledger approver  =", approverAddr);
        require(approverAddr != issuer, "ABORT: approver must differ from the capability issuer");
        require(approverAddr != deployer, "ABORT: approver must differ from the deployer");

        vm.startBroadcast(pk);
        ContextLockApprovalRegistry approvals = new ContextLockApprovalRegistry(deployer, approverAddr);
        ContextLockExecutor executor = new ContextLockExecutor(
            issuer,
            IContextLockPolicyRegistry(policyReg),
            IAuthReg(authReg),
            IAgentIdentityVerifier(identity),
            IContextLockApprovalRegistry(address(approvals))
        );
        approvals.setExecutor(address(executor));
        vm.stopBroadcast();

        console2.log("APPROVAL_REGISTRY=", address(approvals));
        console2.log("EXECUTOR_V2      =", address(executor));
    }
}
