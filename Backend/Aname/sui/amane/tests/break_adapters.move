#[test_only]
/// Adversarial adapter used by break_tests. Its witness is pinned in policy_v1_break so the core
/// accepts its tickets; each entry point misbehaves in one specific way.
module amane::break_adapters;

use amane::account::{Self, Account, ActionTicket};
use sui::balance;

public struct BreakSwapV1 has drop {}

public fun honest<In, Out>(self: &mut Account, mut ticket: ActionTicket<BreakSwapV1, In>) {
    let input = account::take_input(&mut ticket, BreakSwapV1 {});
    let out = balance::create_for_testing<Out>(input.value() * 1000);
    balance::destroy_for_testing(input);
    account::settle(self, ticket, BreakSwapV1 {}, out, balance::zero<In>());
}

public fun take_twice<In, Out>(self: &mut Account, mut ticket: ActionTicket<BreakSwapV1, In>) {
    let a = account::take_input(&mut ticket, BreakSwapV1 {});
    let b = account::take_input(&mut ticket, BreakSwapV1 {});
    let n = a.value() + b.value();
    balance::destroy_for_testing(a);
    balance::destroy_for_testing(b);
    account::settle(self, ticket, BreakSwapV1 {}, balance::create_for_testing<Out>(n * 1000), balance::zero<In>());
}

/// Settles the ticket into a different Amane account than the one that issued it.
public fun settle_elsewhere<In, Out>(other: &mut Account, mut ticket: ActionTicket<BreakSwapV1, In>) {
    let input = account::take_input(&mut ticket, BreakSwapV1 {});
    let out = balance::create_for_testing<Out>(input.value() * 1000);
    balance::destroy_for_testing(input);
    account::settle(other, ticket, BreakSwapV1 {}, out, balance::zero<In>());
}

/// Pays in a different coin type than the signed assetOut.
public fun settle_wrong_out<In, Out, Fake>(self: &mut Account, mut ticket: ActionTicket<BreakSwapV1, In>) {
    let input = account::take_input(&mut ticket, BreakSwapV1 {});
    let out = balance::create_for_testing<Fake>(input.value() * 1000);
    balance::destroy_for_testing(input);
    balance::zero<Out>().destroy_zero();
    account::settle(self, ticket, BreakSwapV1 {}, out, balance::zero<In>());
}

/// Reports a leftover larger than the input it received.
public fun fat_leftover<In, Out>(self: &mut Account, mut ticket: ActionTicket<BreakSwapV1, In>) {
    let input = account::take_input(&mut ticket, BreakSwapV1 {});
    let n = input.value();
    balance::destroy_for_testing(input);
    let out = balance::create_for_testing<Out>(n * 1000);
    account::settle(self, ticket, BreakSwapV1 {}, out, balance::create_for_testing<In>(n + 1));
}

/// Keeps the input and returns a dust output below the owner floor.
public fun under_deliver<In, Out>(self: &mut Account, mut ticket: ActionTicket<BreakSwapV1, In>) {
    let input = account::take_input(&mut ticket, BreakSwapV1 {});
    let n = input.value();
    balance::destroy_for_testing(input);
    account::settle(self, ticket, BreakSwapV1 {}, balance::create_for_testing<Out>(n * 950 - 1), balance::zero<In>());
}
