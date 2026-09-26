// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ContextLockPolicyRegistry} from "../src/ContextLockPolicyRegistry.sol";
import {ContextLockAuthorizationRegistry} from "../src/ContextLockAuthorizationRegistry.sol";
import {EnsAgentIdentityVerifier} from "../src/identity/EnsAgentIdentityVerifier.sol";
import {ContextLockExecutor} from "../src/ContextLockExecutor.sol";
import {MockTreasuryTarget} from "../src/mocks/MockTreasuryTarget.sol";
import {IContextLockPolicyRegistry} from "../src/interfaces/IContextLockPolicyRegistry.sol";
import {IContextLockAuthorizationRegistry as IAuthReg} from "../src/interfaces/IContextLockAuthorizationRegistry.sol";
import {IAgentIdentityVerifier} from "../src/interfaces/IAgentIdentityVerifier.sol";
import {IContextLockApprovalRegistry} from "../src/ContextLockExecutor.sol";
import {ContextLockApprovalRegistry} from "../src/ContextLockApprovalRegistry.sol";

/// @notice Deploys the ContextLock suite to Sepolia with the live ENSv2 identity verifier.
/// @dev Hard-refuses any chain other than Sepolia. There is no local-override flag here on
///      purpose: this script exists only for the real testnet deployment.
contract DeploySepolia is Script {
    uint256 internal constant SEPOLIA = 11155111;

    function run() external {
        console2.log("chainId          =", block.chainid);
        console2.log("expected         = 11155111");
        require(block.chainid == SEPOLIA, "ABORT: not Ethereum Sepolia");
        console2.log("network          = Ethereum Sepolia");

        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);
        address issuer = vm.envAddress("CAPABILITY_ISSUER_ADDRESS");
        address authorizer = vm.envAddress("AUTHORIZER_ADDRESS");

        console2.log("deployer         =", deployer);
        console2.log("capabilityIssuer =", issuer);
        console2.log("authorizer       =", authorizer);
        require(issuer != deployer, "ABORT: issuer must differ from deployer");

        vm.startBroadcast(deployerPk);

        ContextLockPolicyRegistry policy = new ContextLockPolicyRegistry();
        ContextLockAuthorizationRegistry auth = new ContextLockAuthorizationRegistry(deployer, authorizer);
        EnsAgentIdentityVerifier identity = new EnsAgentIdentityVerifier(deployer);
        MockTreasuryTarget target = new MockTreasuryTarget();
        ContextLockExecutor executor = new ContextLockExecutor(
            issuer,
            IContextLockPolicyRegistry(address(policy)),
            IAuthReg(address(auth)),
            IAgentIdentityVerifier(address(identity)),
            IContextLockApprovalRegistry(address(0))
        );

        vm.stopBroadcast();

        console2.log("POLICY_REGISTRY  =", address(policy));
        console2.log("AUTH_REGISTRY    =", address(auth));
        console2.log("ENS_IDENTITY     =", address(identity));
        console2.log("EXECUTOR         =", address(executor));
        console2.log("MOCK_TARGET      =", address(target));
    }
}
