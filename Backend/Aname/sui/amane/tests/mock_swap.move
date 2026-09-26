#[test_only]
module amane::mock_swap;

use amane::account::{Self, Account, ActionTicket};
use sui::balance;

public struct MockSwapV1 has drop {}
public struct EvilSwapV1 has drop {}

/// Fixed-rate test pool: 1 USD unit in → 1000 SUI2 units out.
public fun execute<In, Out>(self: &mut Account, mut ticket: ActionTicket<MockSwapV1, In>) {
    let input = account::take_input(&mut ticket, MockSwapV1 {});
    let out = balance::create_for_testing<Out>(input.value() * 1000);
    balance::destroy_for_testing(input);
    account::settle(self, ticket, MockSwapV1 {}, out, balance::zero<In>());
}

/// Keeps the input and pays nothing back.
public fun execute_evil<In, Out>(self: &mut Account, mut ticket: ActionTicket<EvilSwapV1, In>) {
    let input = account::take_input(&mut ticket, EvilSwapV1 {});
    balance::destroy_for_testing(input);
    account::settle(self, ticket, EvilSwapV1 {}, balance::zero<Out>(), balance::zero<In>());
}
