#[test_only]
module amane::account_tests;

use amane::account::{Self, Account};
use amane::mock_swap::{Self, MockSwapV1, EvilSwapV1};
use amane::scenario_fixtures as f;
use amane::test_coins::{USD, SUI2};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts, Scenario};

const ADMIN: address = @0xA11CE;
const EXECUTOR: address = @0xE0E0;

fun setup(): (Scenario, Clock) {
    let mut s = ts::begin(ADMIN);
    let id = account::create(f::account_id(), f::chain_ref(), f::controllers(), 2, s.ctx());
    assert!(object::id_to_bytes(&id) == f::account_object());
    s.next_tx(ADMIN);
    let mut clock = clock::create_for_testing(s.ctx());
    clock.set_for_testing(f::t0() * 1000);
    let mut a = s.take_shared<Account>();
    a.deposit(coin::mint_for_testing<USD>(1_000_000000, s.ctx()));
    ts::return_shared(a);
    s.next_tx(EXECUTOR);
    (s, clock)
}

fun ready(): (Scenario, Clock, Account) {
    let (s, clock) = setup();
    let mut a = s.take_shared<Account>();
    a.install_policy(f::policy_v1(), f::policy_v1_sigs());
    a.activate_lease(f::lease_ctrl(), f::lease_ctrl_sigs()[0], &clock);
    (s, clock, a)
}

fun policy_only(): (Scenario, Clock, Account) {
    let (s, clock) = setup();
    let mut a = s.take_shared<Account>();
    a.install_policy(f::policy_v1(), f::policy_v1_sigs());
    (s, clock, a)
}

fun finish(s: Scenario, clock: Clock, a: Account) {
    ts::return_shared(a);
    clock.destroy_for_testing();
    s.end();
}

fun sig(v: vector<vector<u8>>): vector<u8> { v[0] }

// ---------------------------------------------------------------- policy

#[test]
fun am_pol_001_install_policy() {
    let (s, clock) = setup();
    let mut a = s.take_shared<Account>();
    a.install_policy(f::policy_v1(), f::policy_v1_sigs());
    assert!(a.policy_version() == 1);
    assert!(a.policy_hash() == amane::eip712::hash_root_policy(&f::policy_v1()));
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EControllerThreshold)]
fun am_pol_006_one_signature_is_not_enough() {
    let (s, clock) = setup();
    let mut a = s.take_shared<Account>();
    a.install_policy(f::policy_v1_one_sig(), f::policy_v1_one_sig_sigs());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EControllerNotAuthorized)]
fun am_pol_006_attacker_cosigner_rejected() {
    let (s, clock) = setup();
    let mut a = s.take_shared<Account>();
    a.install_policy(f::policy_v1_attacker(), f::policy_v1_attacker_sigs());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EControllerUnsorted)]
fun am_pol_006_duplicate_signature_rejected() {
    let (s, clock) = setup();
    let mut a = s.take_shared<Account>();
    let one = f::policy_v1_sigs()[0];
    a.install_policy(f::policy_v1(), vector[one, one]);
    finish(s, clock, a);
}

#[test, expected_failure]
fun am_pol_002_policy_mutated_after_signature() {
    let (s, clock) = setup();
    let mut a = s.take_shared<Account>();
    a.install_policy(f::policy_v1_issuer_is_controller(), f::policy_v1_sigs());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EPolicyWrongEndpoint)]
fun am_pol_004_policy_without_this_endpoint() {
    let (s, clock) = setup();
    let mut a = s.take_shared<Account>();
    a.install_policy(f::policy_v1_wrong_endpoint(), f::policy_v1_wrong_endpoint_sigs());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EPolicyIssuerIsController)]
fun policy_issuer_may_not_be_controller() {
    let (s, clock) = setup();
    let mut a = s.take_shared<Account>();
    a.install_policy(f::policy_v1_issuer_is_controller(), f::policy_v1_issuer_is_controller_sigs());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EPolicyVersionMismatch)]
fun am_pol_005_stale_policy_version() {
    let (s, clock, mut a) = ready();
    a.install_policy(f::policy_v1(), f::policy_v1_sigs());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EPolicyVersionMismatch)]
fun am_pol_005_skipped_policy_version() {
    let (s, clock, mut a) = ready();
    a.install_policy(f::policy_v3(), f::policy_v3_sigs());
    finish(s, clock, a);
}

// ---------------------------------------------------------------- lease

#[test]
fun am_lease_001_controller_and_issuer_leases() {
    let (s, clock, mut a) = ready();
    assert!(a.lease_status(f::lease_id()) == 1);
    a.activate_lease(f::lease_issuer(), sig(f::lease_issuer_sigs()), &clock);
    assert!(a.lease_status(f::issuer_lease_id()) == 1);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ELeaseIdReplay)]
fun lease_id_cannot_be_reactivated() {
    let (s, clock, mut a) = ready();
    a.activate_lease(f::lease_ctrl(), sig(f::lease_ctrl_sigs()), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ELeaseCapExceedsIssuer)]
fun am_lease_012_issuer_over_cap() {
    let (s, clock, mut a) = ready();
    a.activate_lease(f::lease_issuer_over_cap(), sig(f::lease_issuer_over_cap_sigs()), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ELeaseLifetimeExceeded)]
fun am_lease_012_issuer_lifetime() {
    let (s, clock, mut a) = ready();
    a.activate_lease(f::lease_issuer_long(), sig(f::lease_issuer_long_sigs()), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ELeaseAgentNotAllowed)]
fun am_lease_012_issuer_agent_not_allowed() {
    let (s, clock, mut a) = ready();
    a.activate_lease(f::lease_issuer_wrong_agent(), sig(f::lease_issuer_wrong_agent_sigs()), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ELeaseAgentIsIssuer)]
fun am_lease_013_agent_signs_own_lease() {
    let (s, clock, mut a) = policy_only();
    a.activate_lease(f::lease_by_agent(), sig(f::lease_by_agent_sigs()), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ELeaseIssuerNotAuthorized)]
fun am_lease_011_unlisted_issuer() {
    let (s, clock, mut a) = policy_only();
    a.activate_lease(f::lease_unlisted(), sig(f::lease_unlisted_sigs()), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ELeaseIssuerNotAuthorized)]
fun am_lease_011_issuer_field_forged() {
    let (s, clock, mut a) = policy_only();
    a.activate_lease(f::lease_forged_issuer_field(), sig(f::lease_forged_issuer_field_sigs()), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ELeaseActionNotInRoot)]
fun am_lease_002_action_not_in_root() {
    let (s, clock, mut a) = policy_only();
    a.activate_lease(f::lease_borrow(), sig(f::lease_borrow_sigs()), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ELeaseCapExceedsRoot)]
fun am_lease_006_cap_over_root() {
    let (s, clock, mut a) = policy_only();
    a.activate_lease(f::lease_cap_over_root(), sig(f::lease_cap_over_root_sigs()), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ELeaseAdapterNotInRoot)]
fun am_lease_003_adapter_not_in_root() {
    let (s, clock, mut a) = policy_only();
    a.activate_lease(f::lease_unknown_adapter(), sig(f::lease_unknown_adapter_sigs()), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ELeaseWrongEndpoint)]
fun am_replay_001_lease_for_other_endpoint() {
    let (s, clock, mut a) = policy_only();
    a.activate_lease(f::lease_wrong_endpoint(), sig(f::lease_wrong_endpoint_sigs()), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ELeaseLifetimeExceeded)]
fun am_lease_008_lifetime_beyond_root() {
    let (s, clock, mut a) = policy_only();
    a.activate_lease(f::lease_too_long(), sig(f::lease_too_long_sigs()), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ELeaseActivationExpired)]
fun lease_activation_deadline() {
    let (s, mut clock) = setup();
    let mut a = s.take_shared<Account>();
    a.install_policy(f::policy_v1(), f::policy_v1_sigs());
    clock.set_for_testing((f::t0() + 601) * 1000);
    a.activate_lease(f::lease_ctrl(), sig(f::lease_ctrl_sigs()), &clock);
    finish(s, clock, a);
}

// ---------------------------------------------------------------- PAY

#[test]
fun am_act_001_pay_to_pinned_member() {
    let (mut s, clock, mut a) = ready();
    a.pay<USD>(f::pay_1(), sig(f::pay_1_sigs()), &clock, s.ctx());
    assert!(a.nonce_used(f::lease_id(), 1));
    assert!(a.vault_balance<USD>() == 990_000000);
    ts::return_shared(a);
    s.next_tx(EXECUTOR);
    let c = s.take_from_address<Coin<USD>>(f::merchant());
    assert!(c.value() == 10_000000);
    ts::return_to_address(f::merchant(), c);
    let a = s.take_shared<Account>();
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionNonceReplay)]
fun am_act_011_replay_same_nonce() {
    let (mut s, clock, mut a) = ready();
    a.pay<USD>(f::pay_1(), sig(f::pay_1_sigs()), &clock, s.ctx());
    a.pay<USD>(f::pay_1(), sig(f::pay_1_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EBudgetPerAction)]
fun am_act_006_per_action_cap() {
    let (mut s, clock, mut a) = ready();
    a.pay<USD>(f::pay_over_action_cap(), sig(f::pay_over_action_cap_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EBudgetEpoch)]
fun am_act_007_epoch_cap() {
    let (mut s, clock, mut a) = ready();
    a.pay<USD>(f::pay_25_a(), sig(f::pay_25_a_sigs()), &clock, s.ctx());
    a.pay<USD>(f::pay_25_b(), sig(f::pay_25_b_sigs()), &clock, s.ctx());
    a.pay<USD>(f::pay_1_unit(), sig(f::pay_1_unit_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test]
fun am_budget_002_next_epoch_resets_window() {
    let (mut s, mut clock, mut a) = ready();
    a.pay<USD>(f::pay_25_a(), sig(f::pay_25_a_sigs()), &clock, s.ctx());
    a.pay<USD>(f::pay_25_b(), sig(f::pay_25_b_sigs()), &clock, s.ctx());
    clock.set_for_testing((f::t0() + 3599) * 1000);
    let (e0, spent, _) = a.lease_spend(f::lease_id(), f::usd());
    clock.set_for_testing((f::t0() + 3600) * 1000);
    a.pay<USD>(f::pay_late(), sig(f::pay_late_sigs()), &clock, s.ctx());
    let (e1, spent1, total) = a.lease_spend(f::lease_id(), f::usd());
    assert!(e1 == e0 + 1 && spent == 50_000000 && spent1 == 1 && total == 50_000001);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionRecipientNotAllowed)]
fun am_recip_003_arbitrary_pay_recipient() {
    let (mut s, clock, mut a) = ready();
    a.pay<USD>(f::pay_attacker_recipient(), sig(f::pay_attacker_recipient_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionRecipientNotAllowed)]
fun pay_label_must_match_root() {
    let (mut s, clock, mut a) = ready();
    a.pay<USD>(f::pay_wrong_label(), sig(f::pay_wrong_label_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionWrongAgent)]
fun am_lease_009_action_signed_by_wrong_agent() {
    let (mut s, clock, mut a) = ready();
    a.pay<USD>(f::pay_signed_by_attacker(), sig(f::pay_signed_by_attacker_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionWrongEndpoint)]
fun am_replay_002_action_for_other_account() {
    let (mut s, clock, mut a) = ready();
    a.pay<USD>(f::pay_other_account(), sig(f::pay_other_account_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionKindNotAllowed)]
fun am_act_002_kind_outside_lease() {
    let (mut s, clock, mut a) = ready();
    a.pay<USD>(f::pay_borrow_kind(), sig(f::pay_borrow_kind_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionAdapterNameMismatch)]
fun am_name_001_adapter_name_mismatch() {
    let (mut s, clock, mut a) = ready();
    a.pay<USD>(f::pay_wrong_adapter_name(), sig(f::pay_wrong_adapter_name_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionAdapterWitnessMismatch)]
fun am_act_003_adapter_id_not_bound_to_this_code_path() {
    let (mut s, clock, mut a) = ready();
    a.pay<USD>(f::pay_via_swap_adapter(), sig(f::pay_via_swap_adapter_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionAssetNotAllowed)]
fun am_sui_001_wrong_move_type_argument() {
    let (mut s, clock, mut a) = ready();
    a.deposit(coin::mint_for_testing<SUI2>(1_000_000000, s.ctx()));
    a.pay<SUI2>(f::pay_1(), sig(f::pay_1_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EBudgetPerAction)]
fun am_act_004_asset_with_zero_spend_authority() {
    let (mut s, clock, mut a) = ready();
    a.deposit(coin::mint_for_testing<SUI2>(1_000_000000, s.ctx()));
    a.pay<SUI2>(f::pay_wrong_asset(), sig(f::pay_wrong_asset_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test]
fun issuer_lease_spends_within_issuer_caps() {
    let (mut s, clock, mut a) = ready();
    a.activate_lease(f::lease_issuer(), sig(f::lease_issuer_sigs()), &clock);
    a.pay<USD>(f::pay_issuer_lease_a(), sig(f::pay_issuer_lease_a_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EPolicyVersionMismatch)]
fun new_policy_version_invalidates_old_leases() {
    let (mut s, clock, mut a) = ready();
    a.install_policy(f::policy_v2(), f::policy_v2_sigs());
    a.pay<USD>(f::pay_1(), sig(f::pay_1_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

// ---------------------------------------------------------------- revoke / pause

#[test, expected_failure(abort_code = account::ELeaseNotActive)]
fun am_lease_010_revoked_lease() {
    let (mut s, clock, mut a) = ready();
    a.revoke_lease(f::revoke_ctrl(), sig(f::revoke_ctrl_sigs()));
    a.pay<USD>(f::pay_1(), sig(f::pay_1_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EControllerNotAuthorized)]
fun revoke_by_attacker_rejected() {
    let (s, clock, mut a) = ready();
    a.revoke_lease(f::revoke_attacker(), sig(f::revoke_attacker_sigs()));
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ELeaseIdReplay)]
fun revoke_before_activation_kills_signed_lease() {
    let (s, clock) = setup();
    let mut a = s.take_shared<Account>();
    a.install_policy(f::policy_v1(), f::policy_v1_sigs());
    a.revoke_lease(f::revoke_ctrl(), sig(f::revoke_ctrl_sigs()));
    a.activate_lease(f::lease_ctrl(), sig(f::lease_ctrl_sigs()), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionPaused)]
fun am_pause_001_paused_account_rejects_agent() {
    let (mut s, clock, mut a) = ready();
    a.pause(f::pause_b(), sig(f::pause_b_sigs()));
    a.pay<USD>(f::pay_1(), sig(f::pay_1_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EControllerNotAuthorized)]
fun pause_by_attacker_rejected() {
    let (s, clock, mut a) = ready();
    a.pause(f::pause_attacker(), sig(f::pause_attacker_sigs()));
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EControllerThreshold)]
fun am_pol_007_unpause_needs_threshold() {
    let (s, clock, mut a) = ready();
    a.pause(f::pause_b(), sig(f::pause_b_sigs()));
    a.unpause(f::unpause_0_one_sig(), f::unpause_0_one_sig_sigs());
    finish(s, clock, a);
}

#[test]
fun am_pol_007_pause_then_unpause_restores_agent() {
    let (mut s, clock, mut a) = ready();
    a.pause(f::pause_b(), sig(f::pause_b_sigs()));
    assert!(a.is_paused());
    a.unpause(f::unpause_0(), f::unpause_0_sigs());
    a.pay<USD>(f::pay_1(), sig(f::pay_1_sigs()), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EReplayPauseNonce)]
fun pause_nonce_cannot_be_replayed() {
    let (s, clock, mut a) = ready();
    a.pause(f::pause_b(), sig(f::pause_b_sigs()));
    a.pause(f::pause_b(), sig(f::pause_b_sigs()));
    finish(s, clock, a);
}

// ---------------------------------------------------------------- SWAP via ActionTicket

#[test]
fun am_recip_001_swap_output_returns_to_vault() {
    let (s, clock, mut a) = ready();
    let t = a.authorize<MockSwapV1, USD>(f::swap_1(), sig(f::swap_1_sigs()), &clock);
    mock_swap::execute<USD, SUI2>(&mut a, t);
    assert!(a.vault_balance<SUI2>() == 1_000_000000);
    assert!(a.vault_balance<USD>() == 999_000000);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionBelowMinOut)]
fun am_price_001_agent_min_above_delivery() {
    let (s, clock, mut a) = ready();
    let t = a.authorize<MockSwapV1, USD>(f::swap_min_too_high(), sig(f::swap_min_too_high_sigs()), &clock);
    mock_swap::execute<USD, SUI2>(&mut a, t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionBelowMinOut)]
fun am_sui_008_adapter_under_delivers() {
    let (s, clock, mut a) = ready();
    let t = a.authorize<EvilSwapV1, USD>(f::swap_evil(), sig(f::swap_evil_sigs()), &clock);
    mock_swap::execute_evil<USD, SUI2>(&mut a, t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionRecipientNotAllowed)]
fun am_recip_002_swap_output_redirect() {
    let (s, clock, mut a) = ready();
    let t = a.authorize<MockSwapV1, USD>(f::swap_redirect(), sig(f::swap_redirect_sigs()), &clock);
    mock_swap::execute<USD, SUI2>(&mut a, t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionAssetNotAllowed)]
fun am_act_005_wrong_output_asset() {
    let (s, clock, mut a) = ready();
    let t = a.authorize<MockSwapV1, USD>(f::swap_wrong_out(), sig(f::swap_wrong_out_sigs()), &clock);
    mock_swap::execute<USD, SUI2>(&mut a, t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionAdapterWitnessMismatch)]
fun am_sui_007_ticket_for_another_adapter_package() {
    let (s, clock, mut a) = ready();
    let t = a.authorize<MockSwapV1, USD>(f::swap_evil(), sig(f::swap_evil_sigs()), &clock);
    mock_swap::execute<USD, SUI2>(&mut a, t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionAssetNotAllowed)]
fun am_sui_010_settle_with_wrong_output_type() {
    let (mut s, clock, mut a) = ready();
    a.deposit(coin::mint_for_testing<SUI2>(1, s.ctx()));
    let t = a.authorize<MockSwapV1, USD>(f::swap_1(), sig(f::swap_1_sigs()), &clock);
    mock_swap::execute<USD, USD>(&mut a, t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionAssetNotAllowed)]
fun am_sui_001_authorize_with_wrong_input_type() {
    let (s, clock, mut a) = ready();
    let t = a.authorize<MockSwapV1, SUI2>(f::swap_1(), sig(f::swap_1_sigs()), &clock);
    mock_swap::execute<SUI2, SUI2>(&mut a, t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionKindNotAllowed)]
fun authorize_refuses_pay_intents() {
    let (s, clock, mut a) = ready();
    let t = a.authorize<MockSwapV1, USD>(f::pay_1(), sig(f::pay_1_sigs()), &clock);
    mock_swap::execute<USD, SUI2>(&mut a, t);
    finish(s, clock, a);
}

// ---------------------------------------------------------------- owner recovery

#[test]
fun am_owner_002_recovery_to_pinned_destination() {
    let (mut s, clock, mut a) = ready();
    a.withdraw<USD>(f::withdraw_recovery(), f::withdraw_recovery_sigs(), &clock, s.ctx());
    assert!(a.op_nonce() == 1);
    ts::return_shared(a);
    s.next_tx(EXECUTOR);
    let c = s.take_from_address<Coin<USD>>(f::recovery());
    assert!(c.value() == 7);
    ts::return_to_address(f::recovery(), c);
    let a = s.take_shared<Account>();
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EReplayOpNonce)]
fun am_owner_002_recovery_replay() {
    let (mut s, clock, mut a) = ready();
    a.withdraw<USD>(f::withdraw_recovery(), f::withdraw_recovery_sigs(), &clock, s.ctx());
    a.withdraw<USD>(f::withdraw_recovery(), f::withdraw_recovery_sigs(), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EOwnerDestinationNotAllowed)]
fun am_owner_003_unapproved_destination() {
    let (mut s, clock, mut a) = ready();
    a.withdraw<USD>(f::withdraw_attacker_dest(), f::withdraw_attacker_dest_sigs(), &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EControllerNotAuthorized)]
fun am_owner_001_agent_cannot_withdraw() {
    let (mut s, clock, mut a) = ready();
    a.withdraw<USD>(f::withdraw_by_agent(), f::withdraw_by_agent_sigs(), &clock, s.ctx());
    finish(s, clock, a);
}
