// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ContextLockPolicyRegistry} from "../src/ContextLockPolicyRegistry.sol";
import {ContextLockAuthorizationRegistry} from "../src/ContextLockAuthorizationRegistry.sol";
import {LocalAgentIdentityVerifier} from "../src/identity/LocalAgentIdentityVerifier.sol";
import {ContextLockExecutor} from "../src/ContextLockExecutor.sol";
import {MockTreasuryTarget} from "../src/mocks/MockTreasuryTarget.sol";
import {IContextLockPolicyRegistry} from "../src/interfaces/IContextLockPolicyRegistry.sol";
import {IContextLockAuthorizationRegistry as IAuthReg} from "../src/interfaces/IContextLockAuthorizationRegistry.sol";
import {IAgentIdentityVerifier} from "../src/interfaces/IAgentIdentityVerifier.sol";
import {IContextLockApprovalRegistry} from "../src/ContextLockExecutor.sol";
import {ContextLockApprovalRegistry} from "../src/ContextLockApprovalRegistry.sol";

/// @notice Deploys the ContextLock core. Refuses any chain but Sepolia unless explicitly told
///         this is a local run.
contract Deploy is Script {
    uint256 internal constant SEPOLIA = 11155111;

    function run() external {
        bool allowLocal = vm.envOr("ALLOW_LOCAL_CHAIN", false);

        console2.log("chainId        =", block.chainid);
        if (block.chainid != SEPOLIA) {
            console2.log("expected       = 11155111 (Ethereum Sepolia)");
            require(allowLocal, "REFUSING: not Sepolia. Set ALLOW_LOCAL_CHAIN=true only for Anvil.");
            console2.log("network        = LOCAL (ALLOW_LOCAL_CHAIN=true)");
        } else {
            console2.log("network        = Ethereum Sepolia");
        }
        require(block.chainid != 1, "REFUSING: mainnet");

        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);
        address issuer = vm.envAddress("CAPABILITY_ISSUER_ADDRESS");
        address authorizer = vm.envAddress("AUTHORIZER_ADDRESS");

        console2.log("deployer       =", deployer);
        console2.log("capabilityIssuer=", issuer);
        console2.log("authorizer     =", authorizer);

        vm.startBroadcast(deployerPk);

        ContextLockPolicyRegistry policy = new ContextLockPolicyRegistry();
        ContextLockAuthorizationRegistry auth = new ContextLockAuthorizationRegistry(deployer, authorizer);
        LocalAgentIdentityVerifier identity = new LocalAgentIdentityVerifier(deployer);
        MockTreasuryTarget target = new MockTreasuryTarget();
        ContextLockExecutor executor = new ContextLockExecutor(
            issuer,
            IContextLockPolicyRegistry(address(policy)),
            IAuthReg(address(auth)),
            IAgentIdentityVerifier(address(identity)),
            IContextLockApprovalRegistry(address(0))
        );

        vm.stopBroadcast();

        console2.log("POLICY_REGISTRY=", address(policy));
        console2.log("AUTH_REGISTRY  =", address(auth));
        console2.log("IDENTITY       =", address(identity));
        console2.log("EXECUTOR       =", address(executor));
        console2.log("MOCK_TARGET    =", address(target));
    }
}
