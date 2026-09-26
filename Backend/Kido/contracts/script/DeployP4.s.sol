// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ContextLockGateway} from "../src/ContextLockGateway.sol";
import {ContextLockCreConsumer} from "../src/ContextLockCreConsumer.sol";
import {ContextLockAuthorizationRegistry} from "../src/ContextLockAuthorizationRegistry.sol";

/// @notice Adds the Phase 4 CRE boundary to the EXISTING Sepolia deployment.
/// @dev The executor, policy registry, identity verifier and target are reused unchanged — their
///      interfaces are unaffected by the CRE integration, which is the point of the
///      IContextLockAuthorizationRegistry seam.
contract DeployP4 is Script {
    function run() external {
        console2.log("chainId          =", block.chainid);
        require(block.chainid == 11155111, "ABORT: not Ethereum Sepolia");
        console2.log("network          = Ethereum Sepolia");

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address executor = vm.envAddress("EXECUTOR_ADDRESS");
        address authRegistry = vm.envAddress("AUTH_REGISTRY_ADDRESS");
        address forwarder = vm.envAddress("CRE_FORWARDER_ADDRESS");
        address deployer = vm.addr(pk);

        console2.log("deployer         =", deployer);
        console2.log("reusing executor =", executor);
        console2.log("reusing authReg  =", authRegistry);
        console2.log("cre forwarder    =", forwarder);

        vm.startBroadcast(pk);
        ContextLockGateway gateway = new ContextLockGateway(executor);
        ContextLockCreConsumer consumer =
            new ContextLockCreConsumer(deployer, forwarder, ContextLockAuthorizationRegistry(authRegistry));
        // Repoint the registry's writer: the Phase 1/2 trusted EOA can no longer mint.
        ContextLockAuthorizationRegistry(authRegistry).setAuthorizer(address(consumer));
        vm.stopBroadcast();

        console2.log("GATEWAY          =", address(gateway));
        console2.log("CRE_CONSUMER     =", address(consumer));
        console2.log("authorizer now   =", ContextLockAuthorizationRegistry(authRegistry).authorizer());
    }
}
