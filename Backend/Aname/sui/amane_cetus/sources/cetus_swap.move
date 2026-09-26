/// Amane SWAP adapter for Cetus CLMM pools. The Amane core authorizes the intent, debits budgets and
/// hands the exact input over in a ticket that only this module's witness can open; this module
/// swaps the input through one Cetus pool with a flash swap and settles the ticket. The core then
/// measures the output it received and enforces the owner's floor, so a thin pool can only make the
/// transaction abort, never deliver less than the floor.
module amane_cetus::cetus_swap;

use amane::account::{Self, Account, ActionTicket};
use cetus_clmm::config::GlobalConfig;
use cetus_clmm::pool::{Self, Pool};
use cetus_clmm::tick_math;
use sui::balance;
use sui::clock::Clock;

const EPayExceedsInput: u64 = 1;

/// Adapter witness. Its type name (which embeds this package id) is part of the Amane adapter id.
public struct CetusSwapV1 has drop {}

/// Swap coin A for coin B through `pool` (A is the pool's first coin type).
public fun swap_a2b<A, B>(acct: &mut Account, mut ticket: ActionTicket<CetusSwapV1, A>, config: &GlobalConfig, pool: &mut Pool<A, B>, clock: &Clock) {
    let mut input = account::take_input(&mut ticket, CetusSwapV1 {});
    let amount = input.value();
    let (zero_a, out_b, receipt) = pool::flash_swap<A, B>(config, pool, true, true, amount, tick_math::min_sqrt_price(), clock);
    let pay = pool::swap_pay_amount(&receipt);
    assert!(pay <= amount, EPayExceedsInput);
    pool::repay_flash_swap<A, B>(config, pool, input.split(pay), balance::zero<B>(), receipt);
    zero_a.destroy_zero();
    account::settle<CetusSwapV1, A, B>(acct, ticket, CetusSwapV1 {}, out_b, input);
}

/// Swap coin B for coin A through `pool` (B is the pool's second coin type).
public fun swap_b2a<A, B>(acct: &mut Account, mut ticket: ActionTicket<CetusSwapV1, B>, config: &GlobalConfig, pool: &mut Pool<A, B>, clock: &Clock) {
    let mut input = account::take_input(&mut ticket, CetusSwapV1 {});
    let amount = input.value();
    let (out_a, zero_b, receipt) = pool::flash_swap<A, B>(config, pool, false, true, amount, tick_math::max_sqrt_price(), clock);
    let pay = pool::swap_pay_amount(&receipt);
    assert!(pay <= amount, EPayExceedsInput);
    pool::repay_flash_swap<A, B>(config, pool, balance::zero<A>(), input.split(pay), receipt);
    zero_b.destroy_zero();
    account::settle<CetusSwapV1, B, A>(acct, ticket, CetusSwapV1 {}, out_a, input);
}
