/// Amane SWAP adapter bound to one Cetus CLMM pool. Identical to the general Cetus adapter except
/// that the pool object is compiled into the code: routing a swap through any other pool, even one
/// for the same coin pair, aborts. Because the package is frozen, the pinned pool can never change
/// under the adapter id.
module amane_cetus_pinned::pinned_swap;

use amane::account::{Self, Account, ActionTicket};
use cetus_clmm::config::GlobalConfig;
use cetus_clmm::pool::{Self, Pool};
use cetus_clmm::tick_math;
use sui::balance;
use sui::clock::Clock;

const EPayExceedsInput: u64 = 1;
const EWrongPool: u64 = 2;

/// The only pool this adapter will ever touch: the project Pool<AMUSD, AMSUI> on Sui testnet.
const PINNED_POOL: address = @0x3f0397909cce1ded2d1502dbc2ae9e2b37170026083f42bd5a85bccf55947eac;

public struct CetusPinnedSwapV1 has drop {}

public fun pinned_pool(): address { PINNED_POOL }

public fun swap_a2b<A, B>(acct: &mut Account, mut ticket: ActionTicket<CetusPinnedSwapV1, A>, config: &GlobalConfig, pool: &mut Pool<A, B>, clock: &Clock) {
    assert!(object::id_address(pool) == PINNED_POOL, EWrongPool);
    let mut input = account::take_input(&mut ticket, CetusPinnedSwapV1 {});
    let amount = input.value();
    let (zero_a, out_b, receipt) = pool::flash_swap<A, B>(config, pool, true, true, amount, tick_math::min_sqrt_price(), clock);
    let pay = pool::swap_pay_amount(&receipt);
    assert!(pay <= amount, EPayExceedsInput);
    pool::repay_flash_swap<A, B>(config, pool, input.split(pay), balance::zero<B>(), receipt);
    zero_a.destroy_zero();
    account::settle<CetusPinnedSwapV1, A, B>(acct, ticket, CetusPinnedSwapV1 {}, out_b, input);
}

public fun swap_b2a<A, B>(acct: &mut Account, mut ticket: ActionTicket<CetusPinnedSwapV1, B>, config: &GlobalConfig, pool: &mut Pool<A, B>, clock: &Clock) {
    assert!(object::id_address(pool) == PINNED_POOL, EWrongPool);
    let mut input = account::take_input(&mut ticket, CetusPinnedSwapV1 {});
    let amount = input.value();
    let (out_a, zero_b, receipt) = pool::flash_swap<A, B>(config, pool, false, true, amount, tick_math::max_sqrt_price(), clock);
    let pay = pool::swap_pay_amount(&receipt);
    assert!(pay <= amount, EPayExceedsInput);
    pool::repay_flash_swap<A, B>(config, pool, balance::zero<A>(), input.split(pay), receipt);
    zero_b.destroy_zero();
    account::settle<CetusPinnedSwapV1, B, A>(acct, ticket, CetusPinnedSwapV1 {}, out_a, input);
}
