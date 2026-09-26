// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import "../src/AmaneTypes.sol";
import {Golden} from "./generated/Golden.sol";

contract HashHarness {
    using AmaneHash for *;

    function policy(RootPolicy calldata x) external pure returns (bytes32, bytes32) {
        return (x.hash(), AmaneHash.digest(x.hash()));
    }

    function lease(AgentLease calldata x) external pure returns (bytes32, bytes32) {
        return (x.hash(), AmaneHash.digest(x.hash()));
    }

    function action(ActionIntent calldata x) external pure returns (bytes32, bytes32) {
        return (x.hash(), AmaneHash.digest(x.hash()));
    }

    function pause(PauseAccount calldata x) external pure returns (bytes32, bytes32) {
        return (x.hash(), AmaneHash.digest(x.hash()));
    }

    function unpause(UnpauseAccount calldata x) external pure returns (bytes32, bytes32) {
        return (x.hash(), AmaneHash.digest(x.hash()));
    }

    function revoke(RevokeLease calldata x) external pure returns (bytes32, bytes32) {
        return (x.hash(), AmaneHash.digest(x.hash()));
    }

    function withdraw(Withdraw calldata x) external pure returns (bytes32, bytes32) {
        return (x.hash(), AmaneHash.digest(x.hash()));
    }

    function recover(bytes32 d, bytes calldata sig) external pure returns (address) {
        return AmaneSig.recover(d, sig);
    }
}

contract GoldenTest is Test {
    HashHarness h = new HashHarness();

    function _check(bytes32 s, bytes32 d, bytes32 es, bytes32 ed) internal pure {
        assertEq(s, es, "struct hash");
        assertEq(d, ed, "digest");
    }

    function test_CRYPTO_SOL_001_domain_and_typehashes() public pure {
        assertEq(AmaneHash.domainSeparator(), Golden.DOMAIN_SEPARATOR);
        assertEq(AmaneHash.ROOT_POLICY_TYPEHASH, Golden.TH_RootPolicy);
        assertEq(AmaneHash.AGENT_LEASE_TYPEHASH, Golden.TH_AgentLease);
        assertEq(AmaneHash.ACTION_INTENT_TYPEHASH, Golden.TH_ActionIntent);
        assertEq(AmaneHash.POLICY_ENDPOINT_TYPEHASH, Golden.TH_PolicyEndpoint);
        assertEq(AmaneHash.LEASE_ENDPOINT_TYPEHASH, Golden.TH_LeaseEndpoint);
        assertEq(AmaneHash.LEASE_ISSUER_TYPEHASH, Golden.TH_LeaseIssuer);
        assertEq(AmaneHash.PAUSE_ACCOUNT_TYPEHASH, Golden.TH_PauseAccount);
        assertEq(AmaneHash.UNPAUSE_ACCOUNT_TYPEHASH, Golden.TH_UnpauseAccount);
        assertEq(AmaneHash.REVOKE_LEASE_TYPEHASH, Golden.TH_RevokeLease);
        assertEq(AmaneHash.WITHDRAW_TYPEHASH, Golden.TH_Withdraw);
    }

    function test_AM_CRYPTO_001_root_policy_parity() public view {
        (bytes32 s, bytes32 d) = h.policy(Golden.root_policy());
        _check(s, d, Golden.ROOT_POLICY_STRUCT, Golden.ROOT_POLICY_DIGEST);
        assertEq(h.recover(d, Golden.ROOT_POLICY_SIG_0), Golden.ROOT_POLICY_SIGNER_0);
        assertEq(h.recover(d, Golden.ROOT_POLICY_SIG_1), Golden.ROOT_POLICY_SIGNER_1);
    }

    function test_AM_CRYPTO_001_lease_parity() public view {
        (bytes32 s, bytes32 d) = h.lease(Golden.lease_by_controller());
        _check(s, d, Golden.LEASE_BY_CONTROLLER_STRUCT, Golden.LEASE_BY_CONTROLLER_DIGEST);
        assertEq(h.recover(d, Golden.LEASE_BY_CONTROLLER_SIG_0), Golden.LEASE_BY_CONTROLLER_SIGNER_0);
        (s, d) = h.lease(Golden.lease_by_issuer());
        _check(s, d, Golden.LEASE_BY_ISSUER_STRUCT, Golden.LEASE_BY_ISSUER_DIGEST);
        assertEq(h.recover(d, Golden.LEASE_BY_ISSUER_SIG_0), Golden.LEASE_BY_ISSUER_SIGNER_0);
    }

    function test_AM_CRYPTO_001_action_parity() public view {
        (bytes32 s, bytes32 d) = h.action(Golden.action_pay_sui());
        _check(s, d, Golden.ACTION_PAY_SUI_STRUCT, Golden.ACTION_PAY_SUI_DIGEST);
        assertEq(h.recover(d, Golden.ACTION_PAY_SUI_SIG_0), Golden.ACTION_PAY_SUI_SIGNER_0);
        (s, d) = h.action(Golden.action_swap_sepolia());
        _check(s, d, Golden.ACTION_SWAP_SEPOLIA_STRUCT, Golden.ACTION_SWAP_SEPOLIA_DIGEST);
        assertEq(h.recover(d, Golden.ACTION_SWAP_SEPOLIA_SIG_0), Golden.ACTION_SWAP_SEPOLIA_SIGNER_0);
    }

    function test_AM_CRYPTO_001_control_message_parity() public view {
        (bytes32 s, bytes32 d) = h.pause(Golden.pause());
        _check(s, d, Golden.PAUSE_STRUCT, Golden.PAUSE_DIGEST);
        assertEq(h.recover(d, Golden.PAUSE_SIG_0), Golden.PAUSE_SIGNER_0);
        (s, d) = h.unpause(Golden.unpause());
        _check(s, d, Golden.UNPAUSE_STRUCT, Golden.UNPAUSE_DIGEST);
        (s, d) = h.revoke(Golden.revoke());
        _check(s, d, Golden.REVOKE_STRUCT, Golden.REVOKE_DIGEST);
        (s, d) = h.withdraw(Golden.withdraw());
        _check(s, d, Golden.WITHDRAW_STRUCT, Golden.WITHDRAW_DIGEST);
        assertEq(h.recover(d, Golden.WITHDRAW_SIG_1), Golden.WITHDRAW_SIGNER_1);
    }

    function test_AM_CRYPTO_002_high_s_twin_rejected() public {
        vm.expectRevert(AmaneSig.HighS.selector);
        h.recover(Golden.ACTION_PAY_SUI_DIGEST, Golden.NEG_0_SIG);
    }

    function test_AM_CRYPTO_004_non_27_28_v_rejected() public {
        vm.expectRevert(AmaneSig.BadV.selector);
        h.recover(Golden.ACTION_PAY_SUI_DIGEST, Golden.NEG_1_SIG);
        vm.expectRevert(AmaneSig.BadV.selector);
        h.recover(Golden.ACTION_PAY_SUI_DIGEST, Golden.NEG_2_SIG);
        vm.expectRevert(AmaneSig.BadV.selector);
        h.recover(Golden.ACTION_PAY_SUI_DIGEST, Golden.NEG_3_SIG);
    }

    function test_AM_CRYPTO_003_malformed_length_rejected() public {
        vm.expectRevert(AmaneSig.BadSignatureLength.selector);
        h.recover(Golden.ACTION_PAY_SUI_DIGEST, Golden.NEG_4_SIG);
    }

    function test_AM_CRYPTO_005_wrong_domain_and_attacker_recover_other_signer() public view {
        assertTrue(h.recover(Golden.ACTION_PAY_SUI_DIGEST, Golden.NEG_5_SIG) != Golden.ACTION_PAY_SUI_SIGNER_0);
        assertTrue(h.recover(Golden.ACTION_PAY_SUI_DIGEST, Golden.NEG_6_SIG) != Golden.ACTION_PAY_SUI_SIGNER_0);
    }
}
