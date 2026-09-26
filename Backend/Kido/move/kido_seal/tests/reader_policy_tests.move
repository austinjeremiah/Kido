#[test_only]
module kido_seal::reader_policy_tests;

use sui::test_scenario as ts;
use kido_seal::reader_policy::{Self, Policy};

const OWNER: address = @0xA;
const READER: address = @0xB;
const STRANGER: address = @0xC;

fun setup(): ts::Scenario {
    let mut s = ts::begin(OWNER);
    reader_policy::create(vector[READER], s.ctx());
    s
}

fun id_for(p: &Policy, suffix: vector<u8>): vector<u8> {
    let mut id = object::id(p).to_bytes();
    id.append(suffix);
    id
}

#[test]
fun reader_is_approved() {
    let mut s = setup();
    s.next_tx(READER);
    let p = s.take_shared<Policy>();
    reader_policy::approve_for_testing(id_for(&p, b"risk-threshold"), &p, s.ctx());
    ts::return_shared(p);
    s.end();
}

#[test, expected_failure(abort_code = reader_policy::ENoAccess)]
fun stranger_is_refused() {
    let mut s = setup();
    s.next_tx(STRANGER);
    let p = s.take_shared<Policy>();
    reader_policy::approve_for_testing(id_for(&p, b"x"), &p, s.ctx());
    ts::return_shared(p);
    s.end();
}

#[test, expected_failure(abort_code = reader_policy::ENoAccess)]
fun id_outside_namespace_is_refused() {
    let mut s = setup();
    s.next_tx(READER);
    let p = s.take_shared<Policy>();
    reader_policy::approve_for_testing(b"another-namespace-entirely-000000000", &p, s.ctx());
    ts::return_shared(p);
    s.end();
}

#[test, expected_failure(abort_code = reader_policy::ENoAccess)]
fun removed_reader_is_refused() {
    let mut s = setup();
    s.next_tx(OWNER);
    let mut p = s.take_shared<Policy>();
    reader_policy::remove_reader(&mut p, READER, s.ctx());
    ts::return_shared(p);
    s.next_tx(READER);
    let p = s.take_shared<Policy>();
    reader_policy::approve_for_testing(id_for(&p, b"x"), &p, s.ctx());
    ts::return_shared(p);
    s.end();
}

#[test, expected_failure(abort_code = reader_policy::ENotOwner)]
fun only_owner_edits_readers() {
    let mut s = setup();
    s.next_tx(READER);
    let mut p = s.take_shared<Policy>();
    reader_policy::add_reader(&mut p, STRANGER, s.ctx());
    ts::return_shared(p);
    s.end();
}
