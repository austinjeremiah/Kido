# Uniswap v3 — runtime facts (verified 2026-09-26)

Only facts TRACE verified are here. Knowing these facts never authorizes using this provider.

## Core concepts

- A **pool** is identified by `(token0 < token1, fee)`.
- The factory maps `fee → tickSpacing`. V-live values:

| fee | tickSpacing |
|---|---|
| 100 | 1 |
| 500 | 10 |
| 3000 | 60 |
| 10000 | 200 |

- Price is `sqrtPriceX96 = sqrt(token1/token0 in raw units) · 2^96`.
- Liquidity positions are NFTs issued by NonfungiblePositionManager (NPM).
- Liquidity is concentrated. Ticks must be multiples of `tickSpacing`.
- Anyone can create a pool: `factory.createPool` or `NPM.createAndInitializePoolIfNecessary`.

## Supported operations Kido would use

| Op | Signature | Selector | L |
|---|---|---|---|
| swap (single hop) | `SwapRouter02.exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)`. **No `deadline` field.** | `0x04e45aaf` | V-live (selector in bytecode) |
| deadline wrapper | `SwapRouter02.multicall(uint256 deadline, bytes[] data)` | `0x5ae401dc` | V-live |
| deadline wrapper (by block hash) | `multicall(bytes32 previousBlockhash, bytes[])` | `0x1f0464d1` | V-live |
| multi-hop | `exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum))` | `0xb858183f` | V-live |
| exact out | `exactOutputSingle((address,address,uint24,address,uint256 amountOut,uint256 amountInMaximum,uint160))` | `0x5023b4df` | V-live |
| quote | `QuoterV2.quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) → (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)`. Not a view; use `eth_call`. | `0xc6a5026a` | V-live (quoted, see §7) |
| create pool | `UniswapV3Factory.createPool(address tokenA, address tokenB, uint24 fee) returns (address pool)`, then `pool.initialize(uint160 sqrtPriceX96)` | `0xa1671295` | V-live |
| create + init | `NPM.createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)` | `0x13ead562` | V-live |
| add liquidity | `NPM.mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) returns (tokenId, liquidity, amount0, amount1)` | `0x88316456` | V-live |
| increase | `NPM.increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline))` | `0x219f5d17` | V-live |
| collect | `NPM.collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max))` | `0xfc6f7865` | V-live |
| decrease | `NPM.decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline))` | `0x0c49ccbe` | V-live |

**Pool path for project tokens (recommended).** Deploy two ERC20 test tokens (for example AMUSD and AMETH), then:

1. Sort them so that `token0 < token1`.
2. Call `NPM.createAndInitializePoolIfNecessary(t0, t1, 3000, sqrtPriceX96)`, where `sqrtPriceX96 = encodeSqrtRatioX96(amount1Raw, amount0Raw)`.
3. Call `approve(NPM, …)` for both tokens.
4. Call `NPM.mint` with a wide range. For fee 3000 the full range is `tickLower = -887220`, `tickUpper = 887220` (multiples of 60).
5. Swap through `SwapRouter02.exactInputSingle` inside `multicall(deadline, [...])`.

This gives Kido a pool whose price it controls. Existing test pools have arbitrary prices (see §7).

## Required fields

- `chainId`, `router`, `quoter`, `factory`, `positionManager`
- `tokenIn`, `tokenOut`, `fee ∈ {100, 500, 3000, 10000}`
- `recipient` (the Amane vault or executor)
- `amountIn`, `amountOutMinimum` (from a fresh quote minus slippage bps)
- `sqrtPriceLimitX96` (0 = none)
- `deadline` (enforced by Amane, or via `multicall(deadline, …)`)
- `expectedPool` (`factory.getPool(t0, t1, fee)`, checked before the swap)

## Upgrade / version behaviour

- Core and periphery are immutable (no proxies). The docs say "These addresses are final" (V-docs).
- Pools are immutable. Only the factory owner can enable new fee tiers.
- There is no version drift risk beyond the router choice (SwapRouter02 vs UniversalRouter).

## Failure modes

| Revert | Meaning |
|---|---|
| `Too little received` | `amountOutMinimum` not met |
| `SPL` | bad `sqrtPriceLimitX96` |
| `STF` | `safeTransferFrom` failed: no approval or no balance |
| `Transaction too old` | multicall deadline passed |
| `LOK` | pool not initialized, or reentrancy |

Other failure modes:
- `getPool` returns 0: no pool exists.
- NPM `mint` reverts `Price slippage check` when the min amounts are not met.
- `TLU` / `TLM` / `TUM`: ticks are not multiples of the spacing, or out of order.
- A quote goes stale when there are thin-liquidity jumps.
- `exactInputSingle` has no deadline, so a transaction held in the mempool executes later unless it is wrapped (I, V-live selector).

## Limitations

Testnet pool prices are meaningless. There is no v1 SwapRouter on Sepolia. UniversalRouter is preferred by Uniswap but harder to policy-inspect.

## Common mistakes

1. Using the v1 `exactInputSingle` struct with a `deadline` (selector `0x414bf389`). It is absent on SwapRouter02.
2. Confusing Aave WETH `0xC558…` with WETH9 `0xfFf9…`.
3. Not sorting token0 and token1 when creating a pool or computing sqrtPrice.
4. Using ticks that are not multiples of the spacing.
5. Calling QuoterV2 as a transaction. It must go through `eth_call`.
6. Setting `amountOutMinimum = 0`.

## Kido adapter mapping

`UniswapV3SwapAdapter` (EVM, Amane-gated).

**Manifest**
```
{router: 0x3bFA…E48E, quoter: 0xEd1f…2FB3, factory: 0x0227…aC1c, npm: 0x1238…cDA52, allowedPools: [...]}
```

**Preflight**
- `getPool(tokenIn, tokenOut, fee) ∈ allowedPools`
- Quote through QuoterV2 with `eth_call`
- `amountOutMinimum = quote × (1 − maxSlippageBps)`
- `recipient == policy recipient`

**Execute**
```
multicall(deadline, [exactInputSingle(...)])
```

**Evidence**
- Balance deltas of `tokenOut` at the recipient
- `Swap` event
- Pool `slot0` before and after

**Setup ops (studio only, not agent-callable)**
- `createProjectPool`: deploy tokens, then `createAndInitializePoolIfNecessary`, then `mint`

**Errors**
- `Too little received` → `SLIPPAGE`
- `STF` → `INSUFFICIENT_FUNDS_OR_ALLOWANCE`
- `Transaction too old` → `EXPIRED`
