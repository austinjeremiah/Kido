/// Kido private decisions from a Nautilus enclave. The enclave evaluates private inputs (for example
/// a private threshold against private API data) and signs only the decision. This module accepts a
/// decision when the signing enclave is registered for the current enclave configuration (PCRs),
/// the timestamp is fresh, and the decision is newer than the last one accepted for its key; the
/// official `enclave::verify_signature` does not check freshness or replay itself.
module kido_nautilus::decision;

use enclave::enclave::{Self, Enclave, EnclaveConfig};
use sui::clock::Clock;
use sui::event;
use sui::table::{Self, Table};

const INTENT_DECISION: u8 = 0;

const EWrongConfigVersion: u64 = 1;
const EFromTheFuture: u64 = 2;
const EStale: u64 = 3;
const EReplay: u64 = 4;
const EBadSignature: u64 = 5;

/// One-time witness; also the enclave type parameter binding configs and enclaves to this app.
public struct DECISION has drop {}

/// Exactly what the enclave signs (inside enclave::IntentMessage).
public struct DecisionPayload has copy, drop {
    decision_key: vector<u8>,
    act: bool,
    blueprint_hash: vector<u8>,
}

public struct Registry has key {
    id: UID,
    max_age_ms: u64,
    last_accepted: Table<vector<u8>, u64>,
}

public struct DecisionAccepted has copy, drop {
    decision_key: vector<u8>,
    act: bool,
    blueprint_hash: vector<u8>,
    timestamp_ms: u64,
}

fun init(otw: DECISION, ctx: &mut TxContext) {
    let cap = enclave::new_cap(otw, ctx);
    // Real PCRs are set with update_pcrs from the reproducible enclave build before any registration.
    enclave::create_enclave_config(&cap, b"kido-decision".to_string(), x"", x"", x"", ctx);
    transfer::public_transfer(cap, ctx.sender());
    transfer::share_object(Registry { id: object::new(ctx), max_age_ms: 300_000, last_accepted: table::new(ctx) });
}

/// Returns the decision if and only if it was signed by an enclave registered under the current
/// configuration, is fresh, and is newer than the last accepted decision for the same key.
public fun accept(
    reg: &mut Registry,
    config: &EnclaveConfig<DECISION>,
    enclave: &Enclave<DECISION>,
    decision_key: vector<u8>,
    act: bool,
    blueprint_hash: vector<u8>,
    timestamp_ms: u64,
    signature: vector<u8>,
    clock: &Clock,
): bool {
    assert!(enclave::config_version(enclave) == enclave::version(config), EWrongConfigVersion);
    let now = clock.timestamp_ms();
    assert!(timestamp_ms <= now, EFromTheFuture);
    assert!(now - timestamp_ms <= reg.max_age_ms, EStale);
    let payload = DecisionPayload { decision_key, act, blueprint_hash };
    assert!(enclave::verify_signature(enclave, INTENT_DECISION, timestamp_ms, payload, &signature), EBadSignature);
    if (reg.last_accepted.contains(decision_key)) {
        let last = reg.last_accepted.borrow_mut(decision_key);
        assert!(timestamp_ms > *last, EReplay);
        *last = timestamp_ms;
    } else reg.last_accepted.add(decision_key, timestamp_ms);
    event::emit(DecisionAccepted { decision_key, act, blueprint_hash, timestamp_ms });
    act
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(DECISION {}, ctx) }
