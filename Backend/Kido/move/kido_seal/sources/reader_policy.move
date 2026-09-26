/// Seal access policy for Kido private values. A value is encrypted under an identity that starts
/// with a policy object's id; key servers release shares only to addresses the policy lists.
module kido_seal::reader_policy;

const ENoAccess: u64 = 1;
const ENotOwner: u64 = 2;

public struct Policy has key {
    id: UID,
    owner: address,
    readers: vector<address>,
}

/// Creates and shares a policy owned by the sender.
public fun create(readers: vector<address>, ctx: &mut TxContext) {
    transfer::share_object(Policy { id: object::new(ctx), owner: ctx.sender(), readers });
}

public fun add_reader(policy: &mut Policy, reader: address, ctx: &TxContext) {
    assert!(ctx.sender() == policy.owner, ENotOwner);
    if (!policy.readers.contains(&reader)) policy.readers.push_back(reader);
}

public fun remove_reader(policy: &mut Policy, reader: address, ctx: &TxContext) {
    assert!(ctx.sender() == policy.owner, ENotOwner);
    let (found, i) = policy.readers.index_of(&reader);
    if (found) { policy.readers.remove(i); };
}

public fun readers(policy: &Policy): &vector<address> { &policy.readers }

fun is_prefix(prefix: vector<u8>, word: &vector<u8>): bool {
    if (prefix.length() > word.length()) return false;
    let mut i = 0;
    while (i < prefix.length()) {
        if (prefix[i] != word[i]) return false;
        i = i + 1;
    };
    true
}

/// Called (dry-run) by Seal key servers. Aborts unless `id` is namespaced by this policy and the
/// caller is a listed reader.
entry fun seal_approve(id: vector<u8>, policy: &Policy, ctx: &TxContext) {
    assert!(is_prefix(object::id(policy).to_bytes(), &id) && policy.readers.contains(&ctx.sender()), ENoAccess);
}

#[test_only]
public fun approve_for_testing(id: vector<u8>, policy: &Policy, ctx: &TxContext) { seal_approve(id, policy, ctx) }
