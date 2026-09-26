# Cetus CLMM — runtime facts (verified 2026-09-26)

Only facts TRACE verified are here. Knowing these facts never authorizes using this provider.

## Core concepts

- **Pool<A, B>** is a shared object keyed by `(A, B, tick_spacing)`. Coin order is enforced by comparing type-name bytes: **A must sort "greater" than B**, otherwise the call aborts `EInvalidCoinTypeSequence (6)` in `factory::new_pool_key` (V-src).
- **Ticks** are `u32` carrying an `i32` two's-complement value.
- **initialize_price** is `sqrt_price` in Q64.64. It must lie strictly between the sqrt prices of `tick_lower` and `tick_upper` (V-src `create_pool_v3`).
- **Positions** are owned `Position` objects.
- **Hot potatoes:** `AddLiquidityReceipt` and `FlashSwapReceipt` have no `drop` and must be repaid in the same PTB.
- **Version gate:** `config::checked_package_version` asserts `VERSION(14) >= GlobalConfig.package_version(1)`.
- **Fee tier table** (`tick_spacing → fee_rate` in ppm), from live `GlobalConfig.fee_tiers` (baseline):

  | tick_spacing | fee_rate (ppm) | tick_spacing | fee_rate (ppm) |
  |---|---|---|---|
  | 2 | 100 | 60 | 2500 |
  | 4 | 200 | 80 | 3000 |
  | 6 | 300 | 100 | 4000 |
  | 8 | 400 | 120 | 6000 |
  | 10 | 500 | 160 | 8000 |
  | 20 | 1000 | 200 | 10000 |
  | 30 | 1500 | 220 | 20000 |
  | 40 | 2000 | 260 | 40000 |

## Supported operations and on-chain signatures

All signatures below are V-live from GraphQL `package(0x6bbdf…){module{function{parameters return}}}` on 2026-09-26. `CLMM` = `0x5372…2db8`. All are `public` and **not `entry`**, so they are called from a PTB.

**Pool creation**

- `pool_creator::create_pool_v2<A,B>(...)` **ABORTS with code 6 (`EMethodDeprecated`)**.
  - On-chain disassembly of the body is `LdConst[5](u64: 6); Abort`.
  - The same holds for `create_pool_v2_with_creation_cap` and `create_pool_v2_by_creation_cap`.
  - V-live (GraphQL `module{disassembly}`) + V-src. See **F-0401**.
- `pool_creator::create_pool_v3<A,B>(&GlobalConfig, &mut Pools, tick_spacing: u32, initialize_price: u128, url: String, tick_lower_idx: u32, tick_upper_idx: u32, Coin<A>, Coin<B>, fix_amount_a: bool, &Clock, &mut TxContext) -> (Position, Coin<A>, Coin<B>)`
  - This is the **working permissionless path**.
  - It does **not** take `CoinMetadata`.
  - Checks, in order:
    1. `lower_sqrt < initialize_price < upper_sqrt`.
    2. `!is_permission_pair<A,B>(tick_spacing)` (`EPoolIsPermission`).
    3. `is_allowed_coin_v2` for A and B (deny list).
    4. The fee tier exists for `tick_spacing`.
    5. The pool does not already exist (`EPoolAlreadyExist 1`).
    6. `A != B` (`ESameCoinType 3`).
    7. Coin order is correct (6).
  - It then adds the initial liquidity. Both needed amounts must be > 0 and `liquidity > 0` (`ELiquidityCheckFailed`).
  - It returns the leftover coins and shares the pool.
- `factory::create_pool<A,B>(&mut Pools, &GlobalConfig, u32, u128, String, &Clock, &mut TxContext)` requires the **pool manager role** (`config::check_pool_manager_role`), so it is not usable by Kido (V-src).
- `pool_creator::full_range_tick_range(tick_spacing: u32) -> (u32, u32)` is a helper for full-range ticks.

**Liquidity on an existing or fresh pool**

- `pool::open_position<A,B>(&GlobalConfig, &mut Pool<A,B>, tick_lower: u32, tick_upper: u32, &mut TxContext) -> Position`
- `pool::add_liquidity_fix_coin<A,B>(&GlobalConfig, &mut Pool<A,B>, &mut Position, amount: u64, fix_amount_a: bool, &Clock) -> AddLiquidityReceipt<A,B>`
- `pool::add_liquidity<A,B>(&GlobalConfig, &mut Pool<A,B>, &mut Position, delta_liquidity: u128, &Clock) -> AddLiquidityReceipt<A,B>`
- `pool::repay_add_liquidity<A,B>(&GlobalConfig, &mut Pool<A,B>, Balance<A>, Balance<B>, AddLiquidityReceipt<A,B>)`
  - Use `pool::add_liquidity_pay_amount(&receipt)` (V-src) to size the balances.
  - Convert coins with `0x2::coin::into_balance`.
- `pool::remove_liquidity<A,B>(&GlobalConfig, &mut Pool<A,B>, &mut Position, u128, &Clock) -> (Balance<A>, Balance<B>)`
- `pool::close_position<A,B>(&GlobalConfig, &mut Pool<A,B>, Position)`

**Swap (flash pattern)**

- `pool::flash_swap<A,B>(&GlobalConfig, &mut Pool<A,B>, a2b: bool, by_amount_in: bool, amount: u64, sqrt_price_limit: u128, &Clock) -> (Balance<A>, Balance<B>, FlashSwapReceipt<A,B>)`
- `pool::swap_pay_amount<A,B>(&FlashSwapReceipt<A,B>) -> u64`
- `pool::repay_flash_swap<A,B>(&GlobalConfig, &mut Pool<A,B>, Balance<A>, Balance<B>, FlashSwapReceipt<A,B>)`
- `pool::calculate_swap_result<A,B>(&Pool<A,B>, a2b: bool, by_amount_in: bool, amount: u64) -> CalculatedSwapResult` (read-only quote)

**Registry and config**

- `config::checked_package_version(&GlobalConfig)`

## Required fields

- `packageId` (call target) = `0x6bbdf…edf7`
- `typeOriginPackage` = `0x5372…2db8`
- `globalConfig`, `pools`, `clock = 0x6`
- `coinTypeA > coinTypeB` (sorted)
- `tickSpacing` (a key of the fee table), `initializeSqrtPriceX64`, `tickLower`, `tickUpper` (u32 two's complement, multiples of `tick_spacing`)
- For swaps: `poolId`, `a2b`, `byAmountIn`, `amount`, `sqrtPriceLimit`
  - Use `MIN_SQRT_PRICE + 1` / `MAX_SQRT_PRICE − 1` for "no limit" (I).
  - The adapter's `minOut` check is enforced in Move after `flash_swap`.

## Upgrade and version behaviour

- The package is upgradeable by Cetus. A new version would appear in `packageVersionsAfter`.
- `GlobalConfig.package_version` can be raised by Cetus admins. If it exceeds the compiled `VERSION` (14), every call aborts `EPackageVersionDeprecate (10)`.
- Types keep the origin `0x5372…` across upgrades. Calls should target the latest package.
- Deprecations can happen **inside an unchanged signature**: `create_pool_v2` still has its full signature but aborts. Adapters must dry-run, not trust signatures alone.

## Failure modes

| Abort | Meaning |
|---|---|
| 6 `EMethodDeprecated` | `create_pool_v2*` |
| 6 `EInvalidCoinTypeSequence` | factory, wrong coin order. Same numeric code as above but a different module: disambiguate by abort location. |
| 1 `EPoolAlreadyExist` | pool already exists |
| 3 `ESameCoinType` | A and B are the same type |
| `ECoinTypeNotAllowed` | coin is on the deny list |
| `EPoolIsPermission` | pair is a permission pair |
| `EInitSqrtPriceNotBetweenLowerAndUpper` | initial price outside the tick range |
| `ELiquidityCheckFailed` | initial liquidity too small |
| 10 `EPackageVersionDeprecate` | package version gate |

Other failure modes:

- Unconsumed hot-potato receipt: the transaction fails to build or execute.
- Insufficient repay balance on `repay_flash_swap` / `repay_add_liquidity`.
- Missing fee tier for `tick_spacing`.
- A shared object version conflict under contention.

## Limitations

- There are no `entry` functions, so everything is a PTB.
- Legacy `CoinMetadata` is **not** needed for pool creation anymore (v3).
- The testnet lineage differs from mainnet, so mainnet SDK constants do not apply.

## Common mistakes

1. Calling `create_pool_v2`: it aborts 6 (F-0401; the bible still names it).
2. Using mainnet source (`main`, `clmm-v15`) or MVR `@cetuspackages/clmm` on testnet.
3. Targeting `0x5372…` for calls instead of `0x6bbdf…`.
4. Wrong coin order.
5. Encoding negative ticks as plain `u32` without two's complement.
6. Passing `initialize_price` as a plain price instead of sqrt Q64.64.
7. Building with sui 1.50.1.

## Kido adapter mapping

**`CetusSwapAdapter` (Sui Move, called by the Amane executor within a PTB).**

- Manifest:

  ```
  {package: 0x6bbdf…, typeOrigin: 0x5372…, globalConfig: 0xc627…, pools: 0x20a0…, poolId, coinA, coinB, tickSpacing}
  ```

- Flow:
  1. `flash_swap(config, pool, a2b, true, amountIn, limit, clock)`
  2. Assert `out ≥ minOut`
  3. `swap_pay_amount`
  4. Split the input from the Amane-leased funds
  5. `repay_flash_swap`
- Evidence: balance deltas and the `SwapEvent`.

**`CetusPoolSetup` (studio setup, not agent-callable).**

- Sort the types.
- Choose `tick_spacing = 60` (0.25%).
- `(lo, hi) = full_range_tick_range(60)`.
- `sqrt_price = sqrt(priceB_per_A × 10^(decB − decA)) × 2^64`.
- Call `create_pool_v3(config, pools, 60, sqrt_price, "", lo, hi, coinA, coinB, fix_amount_a, clock)`.
- Then transfer the `Position` and leftovers to the studio owner.
- Dry-run with `sui client ptb --dry-run` (1.80.1) before executing.
