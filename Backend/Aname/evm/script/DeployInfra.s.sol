// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {AmaneTestToken} from "../src/AmaneTestToken.sol";
import {TransferPayAdapter} from "../src/adapters/TransferPayAdapter.sol";

/// Deploys the chain-wide Amane infrastructure. Accounts are deployed per user by the SDK.
contract DeployInfra is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        AdapterRegistry registry = new AdapterRegistry();
        AmaneTestToken amusd = new AmaneTestToken("Amane Test USD", "AMUSD", 6);
        TransferPayAdapter pay = new TransferPayAdapter();
        bytes32 payId = registry.register(address(pay));
        vm.stopBroadcast();

        console2.log("registry", address(registry));
        console2.log("amusd", address(amusd));
        console2.log("transferPay", address(pay));
        console2.logBytes32(payId);
        console2.logBytes32(registry.chainRef());
    }
}
