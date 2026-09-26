// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./AmaneBase.sol";
import {AmaneSig} from "../src/AmaneTypes.sol";
import {MaliciousAdapter, ReentrantAdapter, PayloadStore, ProxyAdapter, FeeOnTransferToken} from "./mocks/Mocks.sol";
import {TransferPayAdapter} from "../src/adapters/TransferPayAdapter.sol";

contract PolicyTest is AmaneBase {
    function test_AM_POL_001_valid_policy_stores_exact_hash() public {
        RootPolicy memory p = _policy(1);
        bytes32 d = this.hPolicy(p);
        _install(p);
        assertEq(acct.policyVersion(), 1);
        assertEq(AmaneHash.digest(acct.policyHash()), d);
    }

    function test_AM_POL_002_policy_mutated_after_signature() public {
        RootPolicy memory p = _policy(1);
        bytes[] memory sigs = _both(this.hPolicy(p));
        p.endpoints[0].assets[0].maxTotal += 1;
        vm.expectRevert();
        acct.installPolicy(p, sigs);
    }

    function test_AM_POL_003_wrong_account() public {
        RootPolicy memory p = _policy(1);
        p.accountId = keccak256("other");
        bytes[] memory sigs = _both(this.hPolicy(p));
        _reject(Codes.POLICY_WRONG_ACCOUNT);
        acct.installPolicy(p, sigs);
    }

    function test_AM_POL_004_policy_without_this_endpoint() public {
        RootPolicy memory p = _policy(1);
        p.endpoints[0].account = a32(address(0xdead));
        bytes[] memory sigs = _both(this.hPolicy(p));
        _reject(Codes.POLICY_WRONG_ENDPOINT);
        acct.installPolicy(p, sigs);
    }

    function test_AM_POL_005_stale_or_skipped_version() public {
        _install(_policy(1));
        RootPolicy memory p = _policy(1);
        bytes[] memory sigs = _both(this.hPolicy(p));
        _reject(Codes.POLICY_VERSION_MISMATCH);
        acct.installPolicy(p, sigs);
        p = _policy(3);
        sigs = _both(this.hPolicy(p));
        _reject(Codes.POLICY_VERSION_MISMATCH);
        acct.installPolicy(p, sigs);
    }

    function test_AM_POL_006_authority_change_needs_threshold() public {
        RootPolicy memory p = _policy(1);
        bytes[] memory one = new bytes[](1);
        one[0] = _sign(pkA, this.hPolicy(p));
        _reject(Codes.CONTROLLER_THRESHOLD);
        acct.installPolicy(p, one);

        bytes[] memory dup = new bytes[](2);
        dup[0] = one[0];
        dup[1] = one[0];
        _reject(Codes.CONTROLLER_UNSORTED);
        acct.installPolicy(p, dup);

        bytes[] memory withAttacker = new bytes[](2);
        (uint256 x, uint256 y) = ctrlA < attacker ? (pkA, pkAttacker) : (pkAttacker, pkA);
        withAttacker[0] = _sign(x, this.hPolicy(p));
        withAttacker[1] = _sign(y, this.hPolicy(p));
        _reject(Codes.CONTROLLER_NOT_AUTHORIZED);
        acct.installPolicy(p, withAttacker);
    }

    function test_AM_POL_007_pause_needs_one_unpause_needs_threshold() public {
        _ready();
        PauseAccount memory pa = _pauseMsg(keccak256("incident-1"));
        bytes memory sig = _sign(pkB, this.hPause(pa));
        vm.prank(attacker);
        acct.pause(pa, sig);
        assertTrue(acct.paused());

        UnpauseAccount memory ua = _unpauseMsg(pa.pauseId);
        bytes[] memory one = new bytes[](1);
        one[0] = _sign(pkA, this.hUnpause(ua));
        _reject(Codes.CONTROLLER_THRESHOLD);
        acct.unpause(ua, one);
        acct.unpause(ua, _both(this.hUnpause(ua)));
        assertFalse(acct.paused());
        assertEq(acct.pauseEpoch(), 1);
    }

    function test_F0207_old_pause_cannot_be_replayed_after_unpause() public {
        _ready();
        PauseAccount memory pa = _pauseMsg(keccak256("incident-1"));
        bytes memory sig = _sign(pkB, this.hPause(pa));
        acct.pause(pa, sig);
        UnpauseAccount memory ua = _unpauseMsg(pa.pauseId);
        acct.unpause(ua, _both(this.hUnpause(ua)));
        _reject(Codes.REPLAY_PAUSE_EPOCH);
        acct.pause(pa, sig);
    }

    function test_F0200_withheld_unpause_cannot_lift_a_newer_pause() public {
        _ready();
        PauseAccount memory p1 = _pauseMsg(keccak256("incident-1"));
        acct.pause(p1, _sign(pkB, this.hPause(p1)));
        UnpauseAccount memory ua = _unpauseMsg(p1.pauseId);
        bytes[] memory withheld = _both(this.hUnpause(ua));
        PauseAccount memory p2 = _pauseMsg(keccak256("incident-2"));
        acct.pause(p2, _sign(pkA, this.hPause(p2)));
        _reject(Codes.REPLAY_PAUSE_EPOCH);
        acct.unpause(ua, withheld);
        assertTrue(acct.paused());
    }

    function test_F0200_unpause_expires() public {
        _ready();
        PauseAccount memory p1 = _pauseMsg(keccak256("incident-1"));
        acct.pause(p1, _sign(pkB, this.hPause(p1)));
        UnpauseAccount memory ua = _unpauseMsg(p1.pauseId);
        bytes[] memory sigs = _both(this.hUnpause(ua));
        vm.warp(ua.deadline + 1);
        _reject(Codes.ACTION_EXPIRED);
        acct.unpause(ua, sigs);
    }

    function test_F0202_controller_cannot_exhaust_pause() public {
        _ready();
        PauseAccount memory pa = PauseAccount(ACCOUNT_ID, type(uint64).max, keccak256("x"), uint64(block.timestamp + 60));
        bytes memory sig = _sign(pkB, this.hPause(pa));
        _reject(Codes.REPLAY_PAUSE_EPOCH);
        acct.pause(pa, sig);
    }

    function test_pause_by_non_controller_rejected() public {
        PauseAccount memory pa = _pauseMsg(keccak256("x"));
        bytes memory sig = _sign(pkAttacker, this.hPause(pa));
        _reject(Codes.CONTROLLER_NOT_AUTHORIZED);
        acct.pause(pa, sig);
    }

    function test_F0203_policy_must_extend_current_policy() public {
        _install(_policy(1));
        RootPolicy memory p = _policy(2);
        p.parentPolicyHash = keccak256("abandoned draft lineage");
        bytes[] memory sigs = _both(this.hPolicy(p));
        _reject(Codes.POLICY_PARENT_MISMATCH);
        acct.installPolicy(p, sigs);
    }

    function test_F0203_signed_policy_expires() public {
        RootPolicy memory p = _policy(1);
        bytes[] memory sigs = _both(this.hPolicy(p));
        vm.warp(p.activateBefore + 1);
        _reject(Codes.POLICY_ACTIVATION_EXPIRED);
        acct.installPolicy(p, sigs);
    }

    function test_F0208_zero_numerator_floor_rejected() public {
        RootPolicy memory p = _policy(1);
        p.endpoints[0].swapFloors[0].minOutNumerator = 0;
        bytes[] memory sigs = _both(this.hPolicy(p));
        _reject(Codes.POLICY_BAD_FLOOR);
        acct.installPolicy(p, sigs);
    }

    function test_policy_duplicate_entries_rejected() public {
        RootPolicy memory p = _policy(1);
        p.endpoints[0].assets[1] = p.endpoints[0].assets[0];
        bytes[] memory sigs = _both(this.hPolicy(p));
        _reject(Codes.POLICY_DUPLICATE_ENTRY);
        acct.installPolicy(p, sigs);
    }

    function test_policy_issuer_may_not_be_controller() public {
        RootPolicy memory p = _policy(1);
        p.leaseIssuers[0].issuer = ctrlA;
        bytes[] memory sigs = _both(this.hPolicy(p));
        _reject(Codes.POLICY_ISSUER_IS_CONTROLLER);
        acct.installPolicy(p, sigs);
    }
}

contract LeaseTest is AmaneBase {
    function setUp() public override {
        super.setUp();
        _install(_policy(1));
    }

    function test_AM_LEASE_001_strict_subset_accepted() public {
        _activate(_lease(ctrlA), pkA);
        assertEq(acct.lease(leaseId).status, 1);
    }

    function test_AM_LEASE_002_action_not_in_root() public {
        AgentLease memory l = _lease(ctrlA);
        l.allowedActions |= uint32(1 << 3);
        _activateReject(l, pkA, Codes.LEASE_ACTION_NOT_IN_ROOT);
    }

    function test_AM_LEASE_003_adapter_not_in_root() public {
        AgentLease memory l = _lease(ctrlA);
        l.endpoints[0].adapters[0] = keccak256("unknown");
        _activateReject(l, pkA, Codes.LEASE_ADAPTER_NOT_IN_ROOT);
    }

    function test_AM_LEASE_004_asset_not_in_root() public {
        AgentLease memory l = _lease(ctrlA);
        l.endpoints[0].assets[0].assetId = a32(address(0xbeef));
        _activateReject(l, pkA, Codes.LEASE_ASSET_NOT_IN_ROOT);
    }

    function test_AM_LEASE_005_006_007_caps_above_root() public {
        AgentLease memory l = _lease(ctrlA);
        l.endpoints[0].assets[0].maxPerAction = 100_000001;
        _activateReject(l, pkA, Codes.LEASE_CAP_EXCEEDS_ROOT);
        l = _lease(ctrlA);
        l.endpoints[0].assets[0].maxPerEpoch = 200_000001;
        _activateReject(l, pkA, Codes.LEASE_CAP_EXCEEDS_ROOT);
        l = _lease(ctrlA);
        l.endpoints[0].assets[0].maxTotal = 500_000001;
        _activateReject(l, pkA, Codes.LEASE_CAP_EXCEEDS_ROOT);
    }

    function test_AM_LEASE_008_lifetime_beyond_root() public {
        AgentLease memory l = _lease(ctrlA);
        l.expiresAt = l.validAfter + 86_401;
        _activateReject(l, pkA, Codes.LEASE_LIFETIME_EXCEEDED);
    }

    function test_AM_LEASE_009_action_signed_by_wrong_agent() public {
        _activate(_lease(ctrlA), pkA);
        ActionIntent memory a = _pay(1, 1_000000);
        bytes memory sig = _sign(pkAttacker, this.hAction(a));
        _reject(Codes.ACTION_WRONG_AGENT);
        acct.executeAction(a, sig);
    }

    function test_AM_LEASE_010_revoked_lease_fails() public {
        _activate(_lease(ctrlA), pkA);
        RevokeLease memory r = RevokeLease(ACCOUNT_ID, leaseId);
        bytes memory sig = _sign(pkB, this.hRevoke(r));
        vm.prank(attacker);
        acct.revokeLease(r, sig);
        _execReject(_pay(1, 1_000000), Codes.LEASE_NOT_ACTIVE);
    }

    function test_revoke_before_activation_kills_signed_lease() public {
        AgentLease memory l = _lease(ctrlA);
        bytes memory leaseSig = _sign(pkA, this.hLease(l));
        RevokeLease memory r = RevokeLease(ACCOUNT_ID, leaseId);
        acct.revokeLease(r, _sign(pkA, this.hRevoke(r)));
        _reject(Codes.REPLAY_LEASE_ID);
        acct.activateLease(l, leaseSig);
    }

    function test_AM_LEASE_011_unlisted_issuer() public {
        AgentLease memory l = _lease(attacker);
        _activateReject(l, pkAttacker, Codes.LEASE_ISSUER_NOT_AUTHORIZED);
    }

    function test_AM_LEASE_011_issuer_field_does_not_match_signer() public {
        AgentLease memory l = _lease(ctrlA);
        _activateReject(l, pkAttacker, Codes.LEASE_ISSUER_NOT_AUTHORIZED);
    }

    function test_AM_LEASE_012_issuer_caps() public {
        AgentLease memory l = _lease(issuer);
        l.endpoints[0].assets[0].maxTotal = 100_000001;
        _activateReject(l, pkIssuer, Codes.LEASE_CAP_EXCEEDS_ISSUER);

        l = _lease(issuer);
        l.expiresAt = l.validAfter + 3601;
        _activateReject(l, pkIssuer, Codes.LEASE_LIFETIME_EXCEEDED);

        l = _lease(issuer);
        l.agent = attacker;
        _activateReject(l, pkIssuer, Codes.LEASE_AGENT_NOT_ALLOWED);

        _activate(_lease(issuer), pkIssuer);
    }

    function test_AM_LEASE_013_agent_cannot_sign_own_lease() public {
        AgentLease memory l = _lease(agent);
        _activateReject(l, pkAgent, Codes.LEASE_AGENT_IS_ISSUER);
    }

    function test_lease_activation_deadline() public {
        AgentLease memory l = _lease(ctrlA);
        vm.warp(l.activateBefore + 1);
        _activateReject(l, pkA, Codes.LEASE_ACTIVATION_EXPIRED);
    }

    function test_lease_id_cannot_be_reactivated() public {
        AgentLease memory l = _lease(ctrlA);
        _activate(l, pkA);
        _activateReject(l, pkA, Codes.REPLAY_LEASE_ID);
    }

    function test_AM_REPLAY_001_lease_without_this_endpoint() public {
        AgentLease memory l = _lease(ctrlA);
        l.endpoints[0].account = a32(address(0xdead));
        _activateReject(l, pkA, Codes.LEASE_WRONG_ENDPOINT);
    }

    function test_F0205_issuer_cannot_pre_revoke_foreign_lease() public {
        RevokeLease memory r = RevokeLease(ACCOUNT_ID, leaseId);
        bytes memory sig = _sign(pkIssuer, this.hRevoke(r));
        _reject(Codes.CONTROLLER_NOT_AUTHORIZED);
        acct.revokeLease(r, sig);
    }

    function test_issuer_may_revoke_its_own_active_lease() public {
        _activate(_lease(issuer), pkIssuer);
        RevokeLease memory r = RevokeLease(ACCOUNT_ID, leaseId);
        acct.revokeLease(r, _sign(pkIssuer, this.hRevoke(r)));
        assertEq(acct.lease(leaseId).status, 2);
    }

    function test_lease_policy_version_mismatch() public {
        AgentLease memory l = _lease(ctrlA);
        l.policyVersion = 2;
        _activateReject(l, pkA, Codes.POLICY_VERSION_MISMATCH);
    }
}

contract ActionTest is AmaneBase {
    function setUp() public override {
        super.setUp();
        _ready();
    }

    function test_AM_ACT_001_exact_action_executes_once() public {
        uint256 before = usd.balanceOf(merchant);
        assertEq(_exec(_pay(1, 10_000000)), 10_000000);
        assertEq(usd.balanceOf(merchant) - before, 10_000000);
        assertTrue(acct.nonceUsed(leaseId, 1));
    }

    function test_AM_ACT_002_kind_outside_lease() public {
        ActionIntent memory a = _pay(1, 1_000000);
        a.actionKind = 3;
        _execReject(a, Codes.ACTION_KIND_NOT_ALLOWED);
    }

    function test_AM_ACT_003_wrong_adapter() public {
        ActionIntent memory a = _pay(1, 1_000000);
        a.adapterId = keccak256("x");
        _execReject(a, Codes.ACTION_ADAPTER_NOT_ALLOWED);
        a = _pay(1, 1_000000);
        a.adapterId = swapId;
        _execReject(a, Codes.ACTION_ADAPTER_NAME_MISMATCH);
    }

    function test_AM_ACT_004_wrong_input_asset() public {
        ActionIntent memory a = _pay(1, 1_000000);
        a.assetIn = a32(address(0xbeef));
        a.assetOut = a.assetIn;
        _execReject(a, Codes.ACTION_ASSET_NOT_ALLOWED);
    }

    function test_AM_ACT_005_wrong_output_asset() public {
        ActionIntent memory a = _swap(1, 1_000000, 0);
        a.assetOut = a32(address(0xbeef));
        _execReject(a, Codes.ACTION_ASSET_NOT_ALLOWED);
    }

    function test_AM_ACT_006_per_action_cap() public {
        _execReject(_pay(1, 25_000001), Codes.BUDGET_PER_ACTION);
    }

    function test_AM_ACT_007_epoch_cap() public {
        _exec(_pay(1, 25_000000));
        _exec(_pay(2, 25_000000));
        _execReject(_pay(3, 1), Codes.BUDGET_EPOCH);
    }

    function test_AM_ACT_008_total_cap() public {
        AgentLease memory l = _lease(ctrlA);
        l.leaseId = leaseId = keccak256("long");
        l.expiresAt = uint64(T0 + 86_400);
        _activate(l, pkA);
        uint64 n;
        for (uint256 epoch; epoch < 2; ++epoch) {
            _exec(_pay(++n, 25_000000));
            _exec(_pay(++n, 25_000000));
            vm.warp(block.timestamp + 3600);
        }
        _execReject(_pay(++n, 1), Codes.BUDGET_TOTAL);
    }

    function test_AM_ACT_009_after_deadline() public {
        ActionIntent memory a = _pay(1, 1_000000);
        vm.warp(a.deadline + 1);
        _execReject(a, Codes.ACTION_EXPIRED);
    }

    function test_AM_ACT_010_before_lease_valid() public {
        AgentLease memory l = _lease(ctrlA);
        l.leaseId = keccak256("future");
        l.validAfter = uint64(T0 + 100);
        l.expiresAt = uint64(T0 + 1000);
        _activate(l, pkA);
        ActionIntent memory a = _pay(1, 1_000000);
        a.leaseId = l.leaseId;
        _execReject(a, Codes.LEASE_NOT_YET_VALID);
    }

    function test_expired_lease() public {
        ActionIntent memory a = _pay(1, 1_000000);
        vm.warp(T0 + 3601);
        a.deadline = uint64(block.timestamp + 10);
        _execReject(a, Codes.LEASE_EXPIRED);
    }

    function test_AM_ACT_011_012_replay_same_nonce() public {
        ActionIntent memory a = _pay(1, 1_000000);
        bytes memory sig = _agentSig(a);
        acct.executeAction(a, sig);
        _reject(Codes.REPLAY_NONCE);
        acct.executeAction(a, sig);
    }

    function test_AM_ACT_013_mutated_plan_step_breaks_signature() public {
        ActionIntent memory a = _pay(1, 1_000000);
        bytes memory sig = _agentSig(a);
        a.planStep = 1;
        _reject(Codes.ACTION_WRONG_AGENT);
        acct.executeAction(a, sig);
    }

    function test_AM_RECIP_001_swap_output_returns_to_account() public {
        uint256 out = _exec(_swap(1, 1_000000, 0));
        assertEq(out, 1_000_000000);
        assertEq(amsui.balanceOf(address(acct)), 1_000_000000);
    }

    function test_AM_RECIP_002_swap_output_redirect_rejected() public {
        ActionIntent memory a = _swap(1, 1_000000, 0);
        a.recipient = a32(executor);
        _execReject(a, Codes.ACTION_RECIPIENT_NOT_ALLOWED);
    }

    function test_AM_RECIP_003_arbitrary_pay_recipient() public {
        ActionIntent memory a = _pay(1, 1_000000);
        a.recipient = a32(attacker);
        _execReject(a, Codes.ACTION_RECIPIENT_NOT_ALLOWED);
    }

    function test_theft_with_exhausted_budget_reports_the_recipient_not_the_budget() public {
        _exec(_pay(1, 25_000000));
        _exec(_pay(2, 25_000000));
        ActionIntent memory a = _pay(3, 20_000000);
        a.recipient = a32(attacker);
        _execReject(a, Codes.ACTION_RECIPIENT_NOT_ALLOWED);
    }

    function test_pay_label_must_match_root() public {
        ActionIntent memory a = _pay(1, 1_000000);
        a.recipientLabel = "Merchant";
        _execReject(a, Codes.ACTION_RECIPIENT_NOT_ALLOWED);
    }

    function test_AM_NAME_001_adapter_name_version_mismatch() public {
        ActionIntent memory a = _pay(1, 1_000000);
        a.adapterName = "Transfer Pay v2";
        _execReject(a, Codes.ACTION_ADAPTER_NAME_MISMATCH);
        a = _pay(1, 1_000000);
        a.adapterVersion = 2;
        _execReject(a, Codes.ACTION_ADAPTER_NAME_MISMATCH);
    }

    function test_AM_PRICE_001_agent_may_demand_better_price() public {
        _exec(_swap(1, 1_000000, 999_000000));
        _execReject(_swap(2, 1_000000, 1_000_000001), Codes.ACTION_BELOW_MIN_OUT);
    }

    function test_AM_PRICE_002_004_floor_enforced_against_bad_pool() public {
        FixedRateSwapAdapter bad = new FixedRateSwapAdapter(900, 1);
        bytes32 badId = registry.register(address(bad));
        RootPolicy memory p = _policy(2);
        p.endpoints[0].adapters[1] = AdapterRef(badId, "Fixture Swap", 1);
        _install(p);
        AgentLease memory l = _lease(ctrlA);
        l.policyVersion = 2;
        l.leaseId = keccak256("lease.2");
        l.endpoints[0].adapters[1] = badId;
        _activate(l, pkA);
        ActionIntent memory a = _swap(1, 1_000000, 0);
        a.policyVersion = 2;
        a.leaseId = l.leaseId;
        a.adapterId = badId;
        _execReject(a, Codes.ACTION_BELOW_MIN_OUT);
    }

    function test_swap_without_floor_fails_closed() public {
        RootPolicy memory p = _policy(2);
        p.endpoints[0].swapFloors = new SwapFloor[](0);
        _install(p);
        AgentLease memory l = _lease(ctrlA);
        l.policyVersion = 2;
        l.leaseId = keccak256("lease.2");
        _activate(l, pkA);
        ActionIntent memory a = _swap(1, 1_000000, 0);
        a.policyVersion = 2;
        a.leaseId = l.leaseId;
        _execReject(a, Codes.ACTION_NO_PRICE_FLOOR);
    }

    function test_AM_PAUSE_001_paused_account_rejects_agent() public {
        PauseAccount memory pa = _pauseMsg(keccak256("incident"));
        acct.pause(pa, _sign(pkA, this.hPause(pa)));
        _execReject(_pay(1, 1_000000), Codes.ACTION_ACCOUNT_PAUSED);
    }

    function test_AM_REPLAY_002_action_for_other_account() public {
        ActionIntent memory a = _pay(1, 1_000000);
        a.account = SUI_ACCOUNT;
        _execReject(a, Codes.ACTION_WRONG_ENDPOINT);
        a = _pay(1, 1_000000);
        a.chainRef = SUI_CHAIN_REF;
        _execReject(a, Codes.ACTION_WRONG_ENDPOINT);
    }

    function test_new_policy_version_invalidates_old_leases() public {
        _install(_policy(2));
        ActionIntent memory a = _pay(1, 1_000000);
        _execReject(a, Codes.POLICY_VERSION_MISMATCH);
    }

    function test_issuer_counters_bound_all_issuer_leases() public {
        for (uint256 i; i < 3; ++i) {
            AgentLease memory l = _lease(issuer);
            l.leaseId = keccak256(abi.encode("issuer-lease", i));
            _activate(l, pkIssuer);
        }
        uint64 n;
        for (uint256 i; i < 2; ++i) {
            ActionIntent memory a = _pay(++n, 25_000000);
            a.leaseId = keccak256(abi.encode("issuer-lease", i));
            _exec(a);
            a = _pay(++n, 25_000000);
            a.leaseId = keccak256(abi.encode("issuer-lease", i));
            _exec(a);
        }
        ActionIntent memory over = _pay(++n, 1);
        over.leaseId = keccak256(abi.encode("issuer-lease", uint256(2)));
        _execReject(over, Codes.BUDGET_EPOCH);
    }

    function test_AM_BUDGET_002_epoch_boundary_no_double_window() public {
        AgentLease memory l = _lease(ctrlA);
        l.leaseId = leaseId = keccak256("long");
        l.expiresAt = uint64(T0 + 86_400);
        _activate(l, pkA);
        uint256 boundary = (block.timestamp / 3600 + 1) * 3600;
        vm.warp(boundary - 1);
        _exec(_pay(1, 25_000000));
        _exec(_pay(2, 25_000000));
        _execReject(_pay(3, 1), Codes.BUDGET_EPOCH);
        vm.warp(boundary);
        _execReject(_pay(3, 1_000000), Codes.BUDGET_EPOCH);
        vm.warp(boundary - 1 + 1800);
        _exec(_pay(3, 25_000000));
        _execReject(_pay(4, 1_000000), Codes.BUDGET_EPOCH);
        vm.warp(boundary - 1 + 1800 + 3600);
        _exec(_pay(4, 25_000000));
        _execReject(_pay(5, 1), Codes.BUDGET_TOTAL);
    }

    function test_AM_OWNER_001_agent_cannot_withdraw() public {
        Withdraw memory w = Withdraw(ACCOUNT_ID, acct.chainRef(), a32(address(acct)), a32(address(usd)), 1, a32(recovery), 0, uint64(block.timestamp + 60));
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(pkAgent, this.hWithdraw(w));
        _reject(Codes.CONTROLLER_NOT_AUTHORIZED);
        acct.withdraw(w, sigs);
    }

    function test_AM_OWNER_002_recovery_to_pinned_destination() public {
        Withdraw memory w = Withdraw(ACCOUNT_ID, acct.chainRef(), a32(address(acct)), a32(address(usd)), 7, a32(recovery), 0, uint64(block.timestamp + 60));
        acct.withdraw(w, _both(this.hWithdraw(w)));
        assertEq(usd.balanceOf(recovery), 7);
        bytes[] memory again = _both(this.hWithdraw(w));
        _reject(Codes.REPLAY_OP_NONCE);
        acct.withdraw(w, again);
    }

    function test_AM_OWNER_003_recovery_to_unapproved_destination() public {
        Withdraw memory w = Withdraw(ACCOUNT_ID, acct.chainRef(), a32(address(acct)), a32(address(usd)), 7, a32(attacker), 0, uint64(block.timestamp + 60));
        bytes[] memory sigs = _both(this.hWithdraw(w));
        _reject(Codes.OWNER_DESTINATION_NOT_ALLOWED);
        acct.withdraw(w, sigs);
    }

    function test_AM_CRYPTO_002_high_s_agent_signature_rejected() public {
        ActionIntent memory a = _pay(1, 1_000000);
        bytes memory sig = _agentSig(a);
        bytes32 r;
        bytes32 s;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
        }
        uint8 v = uint8(sig[64]) == 27 ? 28 : 27;
        bytes memory twin = abi.encodePacked(r, bytes32(SECP_N - uint256(s)), v);
        vm.expectRevert(AmaneSig.HighS.selector);
        acct.executeAction(a, twin);
    }

    function testFuzz_amount_never_exceeds_per_action(uint256 amount) public {
        amount = bound(amount, 1, 200_000000);
        ActionIntent memory a = _pay(1, amount);
        bytes memory sig = _agentSig(a);
        if (amount > 25_000000) {
            _reject(Codes.BUDGET_PER_ACTION);
            acct.executeAction(a, sig);
        } else {
            acct.executeAction(a, sig);
            assertEq(usd.balanceOf(merchant), amount);
        }
    }
}

contract AdapterTest is AmaneBase {
    function test_AM_ADAPTER_001_unknown_adapter_in_policy_is_unusable() public {
        bytes32 ghost = keccak256("ghost");
        RootPolicy memory p = _policy(1);
        p.endpoints[0].adapters[0] = AdapterRef(ghost, "Transfer Pay", 1);
        _install(p);
        AgentLease memory l = _lease(ctrlA);
        l.endpoints[0].adapters[0] = ghost;
        _activate(l, pkA);
        ActionIntent memory a = _pay(1, 1_000000);
        a.adapterId = ghost;
        _execReject(a, Codes.ADAPTER_UNKNOWN);
    }

    function test_AM_ADAPTER_002_registration_is_immutable() public {
        TransferPayAdapter again = new TransferPayAdapter();
        bytes32 id2 = registry.register(address(again));
        assertTrue(id2 != payId);
        vm.expectRevert(abi.encodeWithSelector(AdapterRegistry.AlreadyRegistered.selector, id2));
        registry.register(address(again));
    }

    function test_F0204_registry_refuses_mutable_adapter_code() public {
        ProxyAdapter proxy = new ProxyAdapter(address(new TransferPayAdapter()));
        vm.expectPartialRevert(AdapterRegistry.MutableAdapterCode.selector);
        registry.register(address(proxy));
    }

    function test_AM_ADAPTER_003_new_version_requires_new_policy() public {
        _ready();
        bytes32 id2 = registry.register(address(new TransferPayAdapter()));
        ActionIntent memory a = _pay(1, 1_000000);
        a.adapterId = id2;
        _execReject(a, Codes.ACTION_ADAPTER_NOT_ALLOWED);
    }

    function test_AM_PAUSE_002_executor_cannot_call_adapter_to_move_account_funds() public {
        _ready();
        TransferPayAdapter pay = TransferPayAdapter(registry.get(payId).adapter);
        vm.prank(executor);
        vm.expectRevert();
        pay.execute(address(usd), address(usd), 1, 1, executor);
        assertEq(usd.balanceOf(executor), 0);
    }

    function test_malicious_pay_adapter_cannot_divert_funds() public {
        MaliciousAdapter evil = new MaliciousAdapter(9, attacker, "Transfer Pay");
        bytes32 evilId = registry.register(address(evil));
        RootPolicy memory p = _policy(1);
        p.endpoints[0].adapters[0] = AdapterRef(evilId, "Transfer Pay", 1);
        _install(p);
        AgentLease memory l = _lease(ctrlA);
        l.endpoints[0].adapters[0] = evilId;
        _activate(l, pkA);
        ActionIntent memory a = _pay(1, 1_000000);
        a.adapterId = evilId;
        _execReject(a, Codes.ACTION_UNDER_DELIVERED);
    }

    function test_malicious_swap_adapter_cannot_steal_input() public {
        MaliciousAdapter evil = new MaliciousAdapter(0, attacker, "Fixture Swap");
        bytes32 evilId = registry.register(address(evil));
        RootPolicy memory p = _policy(1);
        p.endpoints[0].adapters[1] = AdapterRef(evilId, "Fixture Swap", 1);
        _install(p);
        AgentLease memory l = _lease(ctrlA);
        l.endpoints[0].adapters[1] = evilId;
        _activate(l, pkA);
        ActionIntent memory a = _swap(1, 1_000000, 0);
        a.adapterId = evilId;
        _execReject(a, Codes.ACTION_BELOW_MIN_OUT);
    }

    function test_AM_EVM_001_reentrancy_during_adapter_call() public {
        PayloadStore store = new PayloadStore();
        ReentrantAdapter re = new ReentrantAdapter(address(acct), store);
        bytes32 reId = registry.register(address(re));
        RootPolicy memory p = _policy(1);
        p.endpoints[0].adapters[0] = AdapterRef(reId, "Transfer Pay", 1);
        _install(p);
        AgentLease memory l = _lease(ctrlA);
        l.endpoints[0].adapters[0] = reId;
        _activate(l, pkA);
        ActionIntent memory inner = _pay(2, 1_000000);
        inner.adapterId = reId;
        store.set(abi.encodeCall(AmaneAccount.executeAction, (inner, _agentSig(inner))));
        ActionIntent memory outer = _pay(1, 1_000000);
        outer.adapterId = reId;
        _execReject(outer, Codes.ACTION_REENTRANT);
        assertFalse(acct.nonceUsed(leaseId, 1));
    }

    function test_AM_EVM_002_fee_on_transfer_token_rejected_on_pay() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        fee.mint(address(acct), 100_000000);
        RootPolicy memory p = _policy(1);
        p.endpoints[0].assets[1] = AssetLimit(a32(address(fee)), 10_000000, 10_000000, 10_000000);
        _install(p);
        AgentLease memory l = _lease(ctrlA);
        l.endpoints[0].assets[1] = AssetLimit(a32(address(fee)), 10_000000, 10_000000, 10_000000);
        _activate(l, pkA);
        ActionIntent memory a = _pay(1, 1_000000);
        a.assetIn = a32(address(fee));
        a.assetOut = a.assetIn;
        bytes memory sig = _agentSig(a);
        vm.expectRevert(TransferPayAdapter.TransferFailed.selector);
        acct.executeAction(a, sig);
        assertEq(fee.balanceOf(merchant), 0);
        assertEq(fee.balanceOf(address(acct)), 100_000000);
        assertFalse(acct.nonceUsed(leaseId, 1));
    }
}
