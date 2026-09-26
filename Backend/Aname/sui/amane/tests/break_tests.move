#[test_only]
/// BREAK adversarial suite for the Sui core. break_* tests assert the secure behaviour and fail
/// while their finding is open; holds_* pin defences that hold today.
module amane::break_tests;

use amane::account::{Self, Account};
use amane::break_adapters::{Self, BreakSwapV1};
use amane::mock_swap::MockSwapV1;
use amane::scenario_fixtures as f;
use amane::test_coins::{USD, SUI2};
use sui::clock::{Self, Clock};
use sui::coin;
use sui::test_scenario::{Self as ts, Scenario};

const ADMIN: address = @0xA11CE;
const EXECUTOR: address = @0xE0E0;

public struct FAKE has drop {}

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

fun ready_break(): (Scenario, Clock, Account) {
    let (s, clock) = setup();
    let mut a = s.take_shared<Account>();
    a.install_policy(f::policy_v1_break(), f::policy_v1_break_sigs(), &clock);
    a.activate_lease(f::lease_break(), f::lease_break_sigs()[0], &clock);
    (s, clock, a)
}

fun ready_ctrl(): (Scenario, Clock, Account) {
    let (s, clock) = setup();
    let mut a = s.take_shared<Account>();
    a.install_policy(f::policy_v1(), f::policy_v1_sigs(), &clock);
    a.activate_lease(f::lease_ctrl(), f::lease_ctrl_sigs()[0], &clock);
    (s, clock, a)
}

fun finish(s: Scenario, clock: Clock, a: Account) {
    ts::return_shared(a);
    clock.destroy_for_testing();
    s.end();
}

// ================================================================== BREAK

/// F-0200 (Sui parity): pause signatures are replayable within a pause epoch, so a relayer
/// re-submits the incident-1 pause after incident-2, restoring last_pause_id, and the withheld
/// incident-1 unpause then lifts the incident-2 pause. Once fixed, the replayed pause should
/// abort; convert this test to expected_failure on that call.
#[test]
fun break_f0200_pause_replay_restores_last_pause_id() {
    let (s, clock, mut a) = ready_ctrl();
    a.pause(f::pause_b(), f::pause_b_sigs()[0], &clock); // incident-1
    // owners sign unpause_0 (incident-1); the relayer withholds it
    a.pause(f::pause_a_incident2(), f::pause_a_incident2_sigs()[0], &clock); // incident-2
    a.pause(f::pause_b(), f::pause_b_sigs()[0], &clock); // relayer replays incident-1
    a.unpause(f::unpause_0(), f::unpause_0_sigs(), &clock);
    assert!(a.is_paused(), 0xB200);
    finish(s, clock, a);
}

/// F-0211 (Sui parity): bucket refill multiplies per_epoch by elapsed seconds before dividing,
/// so a very large per_epoch aborts every debit after the first.
#[test]
fun break_f0211_refill_overflow_bricks_large_cap() {
    let (mut s, mut clock) = setup();
    let mut a = s.take_shared<Account>();
    a.install_policy(f::policy_v1_huge_epoch(), f::policy_v1_huge_epoch_sigs(), &clock);
    a.activate_lease(f::lease_ctrl(), f::lease_ctrl_sigs()[0], &clock);
    a.pay<USD>(f::pay_25_a(), f::pay_25_a_sigs()[0], &clock, s.ctx());
    clock.set_for_testing((f::t0() + 2) * 1000);
    // within lease and root caps; must not abort
    a.pay<USD>(f::pay_25_b(), f::pay_25_b_sigs()[0], &clock, s.ctx());
    finish(s, clock, a);
}

// ================================================================== HOLDS

#[test]
fun holds_break_adapter_honest_path() {
    let (s, clock, mut a) = ready_break();
    let t = a.authorize<BreakSwapV1, USD>(f::swap_break(), f::swap_break_sigs()[0], &clock);
    break_adapters::honest<USD, SUI2>(&mut a, t);
    assert!(a.vault_balance<SUI2>() == 1_000_000000);
    assert!(a.vault_balance<USD>() == 999_000000);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ETicketInputAlreadyTaken)]
fun holds_ticket_input_taken_twice() {
    let (s, clock, mut a) = ready_break();
    let t = a.authorize<BreakSwapV1, USD>(f::swap_break(), f::swap_break_sigs()[0], &clock);
    break_adapters::take_twice<USD, SUI2>(&mut a, t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::ETicketWrongAccount)]
fun holds_ticket_settled_into_other_account() {
    let (mut s, clock, mut a) = ready_break();
    let other_id = account::create(f::account_id(), f::chain_ref(), f::controllers(), 2, s.ctx());
    ts::return_shared(a);
    s.next_tx(EXECUTOR);
    let mut a = s.take_shared_by_id<Account>(object::id_from_bytes(f::account_object()));
    let mut other = s.take_shared_by_id<Account>(other_id);
    let t = a.authorize<BreakSwapV1, USD>(f::swap_break(), f::swap_break_sigs()[0], &clock);
    break_adapters::settle_elsewhere<USD, SUI2>(&mut other, t);
    ts::return_shared(other);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionAssetNotAllowed)]
fun holds_ticket_settled_with_wrong_output_type() {
    let (s, clock, mut a) = ready_break();
    let t = a.authorize<BreakSwapV1, USD>(f::swap_break(), f::swap_break_sigs()[0], &clock);
    break_adapters::settle_wrong_out<USD, SUI2, FAKE>(&mut a, t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionOverspent)]
fun holds_ticket_leftover_over_reported() {
    let (s, clock, mut a) = ready_break();
    let t = a.authorize<BreakSwapV1, USD>(f::swap_break(), f::swap_break_sigs()[0], &clock);
    break_adapters::fat_leftover<USD, SUI2>(&mut a, t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionBelowMinOut)]
fun holds_adapter_under_delivery_below_owner_floor() {
    let (s, clock, mut a) = ready_break();
    let t = a.authorize<BreakSwapV1, USD>(f::swap_break(), f::swap_break_sigs()[0], &clock);
    break_adapters::under_deliver<USD, SUI2>(&mut a, t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionAdapterWitnessMismatch)]
fun holds_wrong_witness_type_for_adapter_id() {
    let (s, clock, mut a) = ready_break();
    let t = a.authorize<MockSwapV1, USD>(f::swap_break(), f::swap_break_sigs()[0], &clock);
    amane::mock_swap::execute<USD, SUI2>(&mut a, t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionAssetNotAllowed)]
fun holds_input_type_confusion() {
    let (s, clock, mut a) = ready_break();
    let t = a.authorize<BreakSwapV1, SUI2>(f::swap_break(), f::swap_break_sigs()[0], &clock);
    break_adapters::honest<SUI2, USD>(&mut a, t);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionNonceReplay)]
fun holds_ticket_action_replay() {
    let (s, clock, mut a) = ready_break();
    let t = a.authorize<BreakSwapV1, USD>(f::swap_break(), f::swap_break_sigs()[0], &clock);
    break_adapters::honest<USD, SUI2>(&mut a, t);
    let t2 = a.authorize<BreakSwapV1, USD>(f::swap_break(), f::swap_break_sigs()[0], &clock);
    break_adapters::honest<USD, SUI2>(&mut a, t2);
    finish(s, clock, a);
}

#[test, expected_failure(abort_code = account::EActionPaused)]
fun holds_pause_blocks_ticket_authorize() {
    let (s, clock, mut a) = ready_break();
    a.pause(f::pause_b(), f::pause_b_sigs()[0], &clock);
    let t = a.authorize<BreakSwapV1, USD>(f::swap_break(), f::swap_break_sigs()[0], &clock);
    break_adapters::honest<USD, SUI2>(&mut a, t);
    finish(s, clock, a);
}
