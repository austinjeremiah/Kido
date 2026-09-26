/// Amane BRIDGE transport over the Wormhole Token Bridge (transfer with payload).
///
/// Outbound: the core's `BridgeTicket` is turned into a Token Bridge `TransferTicket` addressed to
/// the pinned peer adapter on the other chain, carrying exactly the core's payload
/// (`intent ‖ destination endpoint`). The `TransferTicket` has no abilities, so the PTB must hand
/// it to `token_bridge::transfer_tokens_with_payload` and publish the message; it cannot be
/// redirected or dropped.
///
/// Inbound: only this adapter's `EmitterCap` can redeem transfers addressed to it. The transfer
/// must come from the pinned peer on the pinned chain, and the destination endpoint in its payload
/// must be the account being credited. The core then re-checks the source intent and reserves.
///
/// The bridge object is created once, through a one-time `SetupCap`; its peer can never change.
/// The package is published and then made immutable, so the witness-derived adapter id is stable.
module amane_wormhole::wormhole_bridge;

use amane::account::{Self, Account, BridgeTicket, DestSpec};
use amane::eip712::ActionIntent;
use sui::clock::Clock;
use sui::coin;
use token_bridge::complete_transfer_with_payload::{Self, RedeemerReceipt};
use token_bridge::token_registry::VerifiedAsset;
use token_bridge::transfer_tokens_with_payload::{Self, TransferTicket};
use token_bridge::transfer_with_payload;
use wormhole::emitter::{Self, EmitterCap};
use wormhole::external_address;
use wormhole::state::State as WormholeState;

const EBadPeer: u64 = 1;
const EWrongPeer: u64 = 2;
const EBadPayload: u64 = 3;
const EWrongDestination: u64 = 4;
const EDust: u64 = 5;

const ADAPTER_NAME: vector<u8> = b"Wormhole Bridge";
const ADAPTER_VERSION: u32 = 1;

public struct WormholeBridgeV1 has drop {}

public struct SetupCap has key, store { id: UID }

public struct Bridge has key {
    id: UID,
    emitter_cap: EmitterCap,
    peer_chain: u16,
    /// The peer adapter's address on `peer_chain`: redeemer of outbound, sender of inbound.
    peer: vector<u8>,
}

fun init(ctx: &mut TxContext) {
    transfer::transfer(SetupCap { id: object::new(ctx) }, ctx.sender());
}

/// One-shot: consumes the SetupCap, so exactly one Bridge exists for this package.
public fun create(cap: SetupCap, wormhole_state: &WormholeState, peer_chain: u16, peer: vector<u8>, ctx: &mut TxContext) {
    let SetupCap { id } = cap;
    id.delete();
    assert!(peer.length() == 32 && peer != x"0000000000000000000000000000000000000000000000000000000000000000", EBadPeer);
    transfer::share_object(Bridge { id: object::new(ctx), emitter_cap: emitter::new(wormhole_state, ctx), peer_chain, peer });
}

public fun send<In>(bridge: &Bridge, mut ticket: BridgeTicket<WormholeBridgeV1, In>, asset_info: VerifiedAsset<In>, ctx: &mut TxContext): TransferTicket<In> {
    let input = account::take_bridge_input(&mut ticket, WormholeBridgeV1 {});
    let payload = account::bridge_payload(&ticket);
    let (transfer, dust) = transfer_tokens_with_payload::prepare_transfer(
        &bridge.emitter_cap,
        asset_info,
        coin::from_balance(input, ctx),
        bridge.peer_chain,
        bridge.peer,
        payload,
        0,
    );
    // Amounts must be exact in Wormhole's 8-decimal normalization; nothing may stay behind.
    assert!(dust.value() == 0, EDust);
    dust.destroy_zero();
    account::settle_bridge(ticket, WormholeBridgeV1 {});
    transfer
}

public fun redeem<T>(bridge: &Bridge, acct: &mut Account, receipt: RedeemerReceipt<T>, src: ActionIntent, src_sig: vector<u8>, dest: DestSpec, clock: &Clock) {
    let (arrived, intent) = open(bridge, acct, receipt);
    account::receive_cross_chain<WormholeBridgeV1, T>(acct, src, src_sig, dest, ADAPTER_NAME, ADAPTER_VERSION, arrived, intent, WormholeBridgeV1 {}, clock);
}

/// Destination-failure path: same transport checks, credited to quarantine by the core.
public fun redeem_to_recovery<T>(bridge: &Bridge, acct: &mut Account, receipt: RedeemerReceipt<T>, src: ActionIntent, src_sig: vector<u8>, dest: DestSpec, clock: &Clock) {
    let (arrived, intent) = open(bridge, acct, receipt);
    account::recover_arrival<WormholeBridgeV1, T>(acct, src, src_sig, dest, ADAPTER_NAME, ADAPTER_VERSION, arrived, intent, WormholeBridgeV1 {}, clock);
}

fun open<T>(bridge: &Bridge, acct: &Account, receipt: RedeemerReceipt<T>): (sui::balance::Balance<T>, vector<u8>) {
    let (coin, parsed, source_chain) = complete_transfer_with_payload::redeem_coin(&bridge.emitter_cap, receipt);
    assert!(source_chain == bridge.peer_chain, EWrongPeer);
    assert!(external_address::to_bytes(transfer_with_payload::sender(&parsed)) == bridge.peer, EWrongPeer);
    let payload = transfer_with_payload::take_payload(parsed);
    assert!(payload.length() == 64, EBadPayload);
    let mut intent = vector[];
    let mut destination = vector[];
    let mut i = 0;
    while (i < 64) {
        if (i < 32) intent.push_back(payload[i]) else destination.push_back(payload[i]);
        i = i + 1;
    };
    assert!(destination == account::object_bytes(acct), EWrongDestination);
    (coin.into_balance(), intent)
}

public fun emitter_id(bridge: &Bridge): ID { object::id(&bridge.emitter_cap) }
public fun peer_chain(bridge: &Bridge): u16 { bridge.peer_chain }
public fun peer(bridge: &Bridge): vector<u8> { bridge.peer }
public fun adapter_name(): vector<u8> { ADAPTER_NAME }
public fun adapter_version(): u32 { ADAPTER_VERSION }
