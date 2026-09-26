#[test_only]
/// Transport stand-in: owns the MockBridgeV1 witness. `send` returns what a real transport would
/// carry; `deliver` / `recover` hand redeemed funds to the core with the payload's intent.
module amane::mock_bridge;

use amane::account::{Self, Account, BridgeTicket, DestSpec};
use amane::eip712::ActionIntent;
use sui::balance::Balance;
use sui::clock::Clock;

public struct MockBridgeV1 has drop {}
public struct UnlistedBridgeV1 has drop {}

public fun send<In>(mut t: BridgeTicket<MockBridgeV1, In>): (Balance<In>, vector<u8>) {
    let b = account::take_bridge_input(&mut t, MockBridgeV1 {});
    let p = account::bridge_payload(&t);
    account::settle_bridge(t, MockBridgeV1 {});
    (b, p)
}

/// A transport that tries to settle without taking (and sending) the input.
public fun settle_untaken<In>(t: BridgeTicket<MockBridgeV1, In>) {
    account::settle_bridge(t, MockBridgeV1 {});
}

public fun deliver<T>(acct: &mut Account, src: ActionIntent, sig: vector<u8>, dest: DestSpec, arrived: Balance<T>, intent: vector<u8>, clock: &Clock) {
    account::receive_cross_chain<MockBridgeV1, T>(acct, src, sig, dest, b"Fixture Bridge", 1, arrived, intent, MockBridgeV1 {}, clock);
}

public fun deliver_unlisted<T>(acct: &mut Account, src: ActionIntent, sig: vector<u8>, dest: DestSpec, arrived: Balance<T>, intent: vector<u8>, clock: &Clock) {
    account::receive_cross_chain<UnlistedBridgeV1, T>(acct, src, sig, dest, b"Fixture Bridge", 1, arrived, intent, UnlistedBridgeV1 {}, clock);
}

public fun recover<T>(acct: &mut Account, src: ActionIntent, sig: vector<u8>, dest: DestSpec, arrived: Balance<T>, intent: vector<u8>, clock: &Clock) {
    account::recover_arrival<MockBridgeV1, T>(acct, src, sig, dest, b"Fixture Bridge", 1, arrived, intent, MockBridgeV1 {}, clock);
}
