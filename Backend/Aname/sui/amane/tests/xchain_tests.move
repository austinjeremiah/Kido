#[test_only]
/// Core v5 cross-chain: outbound BRIDGE tickets, arrivals reserved for one signed source intent,
/// reserved execution, quarantine and root recovery.
module amane::xchain_tests;

use amane::account::{Self, Account};
use amane::mock_bridge::{Self, MockBridgeV1};
use amane::scenario_fixtures as f;
use amane::test_coins::USD;
use sui::balance;
use sui::clock::{Self, Clock};
use sui::coin;
use sui::test_scenario::{Self as ts, Scenario};

const ADMIN: address = @0xA11CE;
const EXECUTOR: address = @0xE0E0;

fun setup(deposit: u64): (Scenario, Clock, Account) {
    let mut s = ts::begin(ADMIN);
    account::create(f::account_id(), f::chain_ref(), f::controllers(), 2, s.ctx());
    s.next_tx(ADMIN);
    let mut clock = clock::create_for_testing(s.ctx());
    clock.set_for_testing(f::t0() * 1000);
    let mut a = s.take_shared<Account>();
    if (deposit > 0) a.deposit(coin::mint_for_testing<USD>(deposit, s.ctx()));
    a.install_policy(f::policy_v1_xchain(), f::policy_v1_xchain_sigs(), &clock);
    a.activate_lease(f::lease_xchain(), f::lease_xchain_sigs()[0], &clock);
    ts::return_shared(a);
    s.next_tx(EXECUTOR);
    let a = s.take_shared<Account>();
    (s, clock, a)
}

fun finish(s: Scenario, clock: Clock, a: Account) {
    ts::return_shared(a);
    clock.destroy_for_testing();
    s.end();
}

fun arrive(a: &mut Account, clock: &Clock) {
    mock_bridge::deliver(a, f::src_pay(), f::src_pay_sigs()[0], f::dest_pay(), balance::create_for_testing<USD>(10_000000), f::intent_pay(), clock);
}

// ---------------------------------------------------------------- outbound

#[test]
fun bridge_out_moves_exact_input_with_intent_and_destination_payload() {
    let (s, clock, mut a) = setup(100_000000);
    let t = account::authorize_bridge<MockBridgeV1, USD>(&mut a, f::bridge_out(), f::bridge_out_sigs()[0], &clock);
    assert!(account::bridge_amount(&t) == 10_000000);
    let (sent, payload) = mock_bridge::send(t);
    assert!(sent.value() == 10_000000);
    assert!(payload.length() == 64);
    let mut dest = vector[];
    let mut i = 32;
    while (i < 64) { dest.push_back(payload[i]); i = i + 1; };
    assert!(dest == f::evm_account());
    assert!(a.vault_balance<USD>() == 90_000000);
    balance::destroy_for_testing(sent);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionRecipientNotAllowed)]
fun bridge_out_to_unpinned_endpoint_rejected() {
    let (s, clock, mut a) = setup(100_000000);
    let t = account::authorize_bridge<MockBridgeV1, USD>(&mut a, f::bridge_out_unpinned(), f::bridge_out_unpinned_sigs()[0], &clock);
    mock_bridge::settle_untaken(t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EBudgetPerAction)]
fun bridge_out_budget_applies() {
    let (s, clock, mut a) = setup(100_000000);
    let t = account::authorize_bridge<MockBridgeV1, USD>(&mut a, f::bridge_out_over_cap(), f::bridge_out_over_cap_sigs()[0], &clock);
    mock_bridge::settle_untaken(t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionOverspent)]
fun bridge_ticket_cannot_settle_without_sending_the_input() {
    let (s, clock, mut a) = setup(100_000000);
    let t = account::authorize_bridge<MockBridgeV1, USD>(&mut a, f::bridge_out(), f::bridge_out_sigs()[0], &clock);
    mock_bridge::settle_untaken(t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionNonceReplay)]
fun bridge_out_replay_rejected() {
    let (s, clock, mut a) = setup(100_000000);
    let (b1, _) = mock_bridge::send(account::authorize_bridge<MockBridgeV1, USD>(&mut a, f::bridge_out(), f::bridge_out_sigs()[0], &clock));
    let (b2, _) = mock_bridge::send(account::authorize_bridge<MockBridgeV1, USD>(&mut a, f::bridge_out(), f::bridge_out_sigs()[0], &clock));
    balance::destroy_for_testing(b1);
    balance::destroy_for_testing(b2);
    finish(s, clock, a);
}

// ---------------------------------------------------------------- inbound

#[test]
fun arrival_reserved_then_paid_to_pinned_merchant() {
    let (mut s, clock, mut a) = setup(0);
    arrive(&mut a, &clock);
    assert!(a.reserved_of<USD>() == 10_000000);
    assert!(a.intent_used(f::intent_pay()));
    a.pay_reserved<USD>(f::intent_pay(), f::pay_reserved(), f::pay_reserved_sigs()[0], &clock, s.ctx());
    assert!(a.reserved_of<USD>() == 0);
    s.next_tx(EXECUTOR);
    let paid = s.take_from_address<coin::Coin<USD>>(f::merchant());
    assert!(paid.value() == 10_000000);
    ts::return_to_address(f::merchant(), paid);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EXchainReservedFunds)]
fun other_actions_of_the_same_lease_cannot_spend_reserved_funds() {
    let (mut s, clock, mut a) = setup(0);
    arrive(&mut a, &clock);
    a.pay<USD>(f::pay_unreserved_xchain(), f::pay_unreserved_xchain_sigs()[0], &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EXchainIntentUsed)]
fun duplicate_delivery_of_the_same_intent_rejected() {
    let (s, clock, mut a) = setup(0);
    arrive(&mut a, &clock);
    arrive(&mut a, &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionWrongAgent)]
fun arrival_with_forged_source_signature_rejected() {
    let (s, clock, mut a) = setup(0);
    mock_bridge::deliver(&mut a, f::src_pay_forged(), f::src_pay_forged_sigs()[0], f::dest_pay(), balance::create_for_testing<USD>(10_000000), f::intent_pay(), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EXchainWrongDestination)]
fun arrival_for_another_endpoint_rejected() {
    let (s, clock, mut a) = setup(0);
    mock_bridge::deliver(&mut a, f::src_pay_other_endpoint(), f::src_pay_other_endpoint_sigs()[0], f::dest_pay(), balance::create_for_testing<USD>(10_000000), f::intent_pay(), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EXchainSpecMismatch)]
fun relayer_substituting_a_different_destination_action_rejected() {
    let (s, clock, mut a) = setup(0);
    mock_bridge::deliver(&mut a, f::src_pay(), f::src_pay_sigs()[0], f::dest_return(), balance::create_for_testing<USD>(10_000000), f::intent_pay(), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionRecipientNotAllowed)]
fun agent_committing_to_an_unpinned_beneficiary_rejected() {
    let (s, clock, mut a) = setup(0);
    mock_bridge::deliver(&mut a, f::src_pay_attacker_dest(), f::src_pay_attacker_dest_sigs()[0], f::dest_pay_attacker(), balance::create_for_testing<USD>(10_000000), x"00", &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EXchainPayloadMismatch)]
fun transport_payload_for_another_intent_rejected() {
    let (s, clock, mut a) = setup(0);
    mock_bridge::deliver(&mut a, f::src_pay(), f::src_pay_sigs()[0], f::dest_pay(), balance::create_for_testing<USD>(10_000000), f::intent_return(), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EXchainBelowMinimum)]
fun short_arrival_rejected() {
    let (s, clock, mut a) = setup(0);
    mock_bridge::deliver(&mut a, f::src_pay(), f::src_pay_sigs()[0], f::dest_pay(), balance::create_for_testing<USD>(9_999999), f::intent_pay(), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionAdapterNotAllowed)]
fun arrival_through_an_unlisted_transport_rejected() {
    let (s, clock, mut a) = setup(0);
    mock_bridge::deliver_unlisted(&mut a, f::src_pay(), f::src_pay_sigs()[0], f::dest_pay(), balance::create_for_testing<USD>(10_000000), f::intent_pay(), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EXchainExpired)]
fun arrival_after_its_deadline_rejected() {
    let (s, mut clock, mut a) = setup(0);
    clock.set_for_testing((f::t0() + 601) * 1000);
    arrive(&mut a, &clock);
    finish(s, clock, a);
}

// ---------------------------------------------------------------- reserved execution

#[test, expected_failure(abort_code = account::EXchainReservationMismatch)]
fun reserved_pay_over_the_reservation_rejected() {
    let (mut s, clock, mut a) = setup(100_000000);
    arrive(&mut a, &clock);
    a.pay_reserved<USD>(f::intent_pay(), f::pay_reserved_too_much(), f::pay_reserved_too_much_sigs()[0], &clock, s.ctx());
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EXchainReservationMismatch)]
fun reserved_pay_not_bound_to_the_intent_rejected() {
    let (mut s, clock, mut a) = setup(100_000000);
    arrive(&mut a, &clock);
    a.pay_reserved<USD>(f::intent_pay(), f::pay_reserved_unbound(), f::pay_reserved_unbound_sigs()[0], &clock, s.ctx());
    finish(s, clock, a);
}

#[test]
fun partial_reserved_pay_leaves_the_rest_reserved() {
    let (mut s, clock, mut a) = setup(0);
    arrive(&mut a, &clock);
    a.pay_reserved<USD>(f::intent_pay(), f::pay_reserved_partial(), f::pay_reserved_partial_sigs()[0], &clock, s.ctx());
    let (exists, remaining, _) = a.reservation(f::intent_pay());
    assert!(exists && remaining == 6_000000 && a.reserved_of<USD>() == 6_000000);
    finish(s, clock, a);
}

#[test]
fun round_trip_return_leg_bridges_the_reserved_arrival_back() {
    let (s, clock, mut a) = setup(0);
    mock_bridge::deliver(&mut a, f::src_return(), f::src_return_sigs()[0], f::dest_return(), balance::create_for_testing<USD>(10_000000), f::intent_return(), &clock);
    let t = account::authorize_bridge_reserved<MockBridgeV1, USD>(&mut a, f::intent_return(), f::bridge_back_reserved(), f::bridge_back_reserved_sigs()[0], &clock);
    let (sent, _) = mock_bridge::send(t);
    assert!(sent.value() == 10_000000 && a.reserved_of<USD>() == 0 && a.vault_balance<USD>() == 0);
    balance::destroy_for_testing(sent);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EXchainReservationMismatch)]
fun round_trip_return_leg_to_another_recipient_rejected() {
    let (s, clock, mut a) = setup(0);
    mock_bridge::deliver(&mut a, f::src_return(), f::src_return_sigs()[0], f::dest_return(), balance::create_for_testing<USD>(10_000000), f::intent_return(), &clock);
    let t = account::authorize_bridge_reserved<MockBridgeV1, USD>(&mut a, f::intent_return(), f::bridge_back_elsewhere(), f::bridge_back_elsewhere_sigs()[0], &clock);
    mock_bridge::settle_untaken(t);
    finish(s, clock, a);
}

// ---------------------------------------------------------------- failure, quarantine, recovery

#[test, expected_failure(abort_code = account::EXchainNoReservation)]
fun recovery_path_refused_while_destination_is_deliverable() {
    let (s, clock, mut a) = setup(0);
    mock_bridge::recover(&mut a, f::src_pay(), f::src_pay_sigs()[0], f::dest_pay(), balance::create_for_testing<USD>(10_000000), f::intent_pay(), &clock);
    finish(s, clock, a);
}

#[test]
fun timed_out_arrival_quarantined_and_only_root_recovery_moves_it() {
    let (mut s, mut clock, mut a) = setup(0);
    clock.set_for_testing((f::t0() + 601) * 1000);
    mock_bridge::recover(&mut a, f::src_pay(), f::src_pay_sigs()[0], f::dest_pay(), balance::create_for_testing<USD>(10_000000), f::intent_pay(), &clock);
    assert!(a.quarantined_of<USD>() == 10_000000 && a.reserved_of<USD>() == 10_000000);
    a.withdraw<USD>(f::withdraw_ten(), f::withdraw_ten_sigs(), &clock, s.ctx());
    assert!(a.quarantined_of<USD>() == 0 && a.reserved_of<USD>() == 0 && a.vault_balance<USD>() == 0);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EXchainReservedFunds)]
fun quarantined_funds_not_spendable_by_the_lease() {
    let (mut s, mut clock, mut a) = setup(0);
    clock.set_for_testing((f::t0() + 601) * 1000);
    mock_bridge::recover(&mut a, f::src_pay(), f::src_pay_sigs()[0], f::dest_pay(), balance::create_for_testing<USD>(10_000000), f::intent_pay(), &clock);
    a.pay<USD>(f::pay_late_xchain(), f::pay_late_xchain_sigs()[0], &clock, s.ctx());
    finish(s, clock, a);
}

#[test]
fun expired_reservation_released_into_quarantine() {
    let (s, mut clock, mut a) = setup(0);
    arrive(&mut a, &clock);
    clock.set_for_testing((f::t0() + 601) * 1000);
    a.release_reservation(f::intent_pay(), &clock);
    assert!(a.reserved_of<USD>() == 10_000000 && a.quarantined_of<USD>() == 10_000000);
    let (exists, _, _) = a.reservation(f::intent_pay());
    assert!(!exists);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EXchainNoReservation)]
fun reservation_cannot_be_released_before_its_deadline() {
    let (s, clock, mut a) = setup(0);
    arrive(&mut a, &clock);
    a.release_reservation(f::intent_pay(), &clock);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EXchainReservedFunds)]
fun root_recovery_cannot_take_a_live_reservation() {
    let (mut s, clock, mut a) = setup(0);
    arrive(&mut a, &clock);
    a.withdraw<USD>(f::withdraw_ten(), f::withdraw_ten_sigs(), &clock, s.ctx());
    finish(s, clock, a);
}

// ---------------------------------------------------------------- cross-VM parity

#[test]
fun dest_spec_hash_matches_evm_and_typescript_vector() {
    let d = account::dest_spec(
        2,
        x"1111111111111111111111111111111111111111111111111111111111111111",
        x"2222222222222222222222222222222222222222222222222222222222222222",
        b"owner position",
        x"3333333333333333333333333333333333333333333333333333333333333333",
        99_000000,
        1_800_003_600,
    );
    assert!(account::hash_dest_spec(&d) == x"b00f7df4a08766849859c3597c0968709501383280002db39d66ad734075e5af");
}
