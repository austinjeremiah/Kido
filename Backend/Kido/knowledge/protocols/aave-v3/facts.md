# Aave v3 — runtime facts (verified 2026-09-26)

Only facts TRACE verified are here. Knowing these facts never authorizes using this provider.

## Core concepts

- **Pool** is the single entry point: supply, borrow, repay, withdraw.
- **Debt is tokenised.** The `variableDebtToken.balanceOf(user)` of a reserve is the user's current variable debt, including accrued interest (scaled balance × normalized variable debt index).
- **aToken** balance is the supplied amount plus interest.
- Reserve configuration is a packed bitmap: bit 56 active, bit 57 frozen, bit 58 borrowing, bit 59 stable borrowing, bit 60 paused.
- Debt accrues every second, so the repay amount is a moving target. Use `type(uint256).max` only when repaying your **own** debt.

## Supported operations Kido would use

| Op | Signature | Selector | L |
|---|---|---|---|
| repay | `repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)` | `0x573ade81` | V-live (selector in impl) + V-docs |
| repayWithATokens | `repayWithATokens(address,uint256,uint256) returns (uint256)` | `0x2dad97d4` | V-live |
| repayWithPermit | `repayWithPermit(address,uint256,uint256,address,uint256,uint8,bytes32,bytes32)` | `0xee3e210b` | V-live |
| supply | `supply(address,uint256,address,uint16)` | `0x617ba037` | V-live |
| borrow | `borrow(address,uint256,uint256,uint16,address)` | `0xa415bcad` | V-live |
| account health | `getUserAccountData(address) → (totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor)` | `0xbf92857c` | V-live |
| reserve data | `getReserveData(address)` → legacy `ReserveData` struct (15 fields; the aToken, stableDebt and variableDebt addresses are fields 9–11) | `0x35ea6a75` | V-live |
| per-reserve tokens | `PoolDataProvider(0x3e97…).getReserveTokensAddresses(asset) → (aToken, stableDebt, variableDebt)` | – | V-live |

**Measuring debt reduction on-chain:**

1. Read `pre = variableDebtToken(0x36B5…).balanceOf(user)` at block N−1.
2. Execute `repay`.
3. Read `post` at the receipt block.
4. Compute `reduction = pre + accrued(Δt) − post`. Also confirm that `repay`'s return value equals the `Repay` event amount.
5. The most robust approach is to compare `balanceOf` at block (receipt−1) with the value at block receipt, using `cast call --block`. Also cross-check `getUserAccountData.totalDebtBase` (USD, 8 dp).

**Faucet** (`0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D`, V-live):

- `mint(address token, address to, uint256 amount)` is permissionless (`isPermissioned() == false`).
- Simulating 10,000 USDC (`1e10` units) succeeds. `1e10 + 1` reverts `"Error: Mint limit transaction exceeded"`, so the per-transaction cap for USDC is 10,000 USDC.

## Required fields

- `chainId`, `pool`, `poolAddressesProvider`, `dataProvider`
- `asset` (must be in `getReservesList()`), `variableDebtToken` of that asset, `interestRateMode = 2`, `onBehalfOf`
- `amount` (explicit, when repaying on behalf of another account)
- For evidence: `preDebt`, `postDebt`, `blockNumber`, `txHash`

## Upgrade / version behaviour

- The Pool is an upgradeable proxy governed by PoolConfigurator/ACL. A testnet upgrade to v3.2+ would add `getReserveAToken` etc. and deprecate stable debt. Do not hard-code the `ReserveData` struct shape. Prefer `PoolDataProvider.getReserveTokensAddresses`, which is stable across versions (I).
- Reserve config (frozen/paused/borrowCap) can change at any time on testnet. Re-read it before each action.

## Failure modes (V-live: simulated with `cast call --from`)

| Revert | Meaning | How triggered |
|---|---|---|
| `"26"` INVALID_AMOUNT | `amount == 0` | |
| `"40"` NO_EXPLICIT_AMOUNT_TO_REPAY_ON_BEHALF | `amount == type(uint256).max` while `onBehalfOf != msg.sender` | V-live |
| `"39"` NO_DEBT_OF_SELECTED_TYPE | user has no debt in that mode | V-live, both mode 2 and mode 1 |

Other failure modes:

- ERC20 allowance or balance insufficient: the ERC20 reverts.
- Reserve paused or inactive: revert.
- On-behalf over-repay: when repaying for another account with an explicit amount, the pool caps the pull at the actual debt (`paybackAmount = min(amount, debt)`). The caller keeps the excess allowance, not the tokens (I, core source).
- Interest accrual between quote and execution: an exact `amount == debt` from a stale read leaves dust.

## Limitations

- The testnet market is old (revision 1). Its behaviour differs from v3.3 docs: stable debt still exists, and there is no virtual accounting getter.
- The faucet has a per-transaction cap (10k USDC).
- Test-token prices come from Aave's testnet oracles and do not match Uniswap Sepolia pool prices.

## Common mistakes

1. Using Circle USDC `0x1c7D…` or ENSv2 MockUSDC for REPAY (F-0304).
2. Using `type(uint256).max` for an on-behalf repay (reverts `40`).
3. Using mode 1 (stable).
4. Reading debt from `scaledBalanceOf` instead of `balanceOf`.
5. Assuming Aave WETH `0xC558…` equals Uniswap WETH9 `0xfFf9…`.
6. Hard-coding the v3.3 `getReserveData` struct.
7. Forgetting the approve to the **Pool** (not to the aToken).

## Kido adapter mapping

`AaveV3RepayAdapter` (EVM, Amane-gated).

**Manifest:**

- `{chainId: 11155111, pool: 0x6Ae4…8951, dataProvider: 0x3e97…1F31}`
- `asset: 0x94a9…E4C8`, `debtToken: 0x36B5…2ECc`, `rateMode: 2`
- `maxRepayPerAction`

**Preflight:**

- `asset ∈ getReservesList()`
- config bits active=1, paused=0
- `debtToken.balanceOf(onBehalfOf) > 0`
- `amount ≤ min(policyCap, debt × (1 + slippageBps))`
- If `onBehalfOf != executor`, then `amount != MAX`.

**Execute:** `approve(pool, amount)` → `repay(asset, amount, 2, onBehalfOf)`.

**Evidence:** `debtBefore@N-1`, `debtAfter@N`, the `Repay` event, and the return value.

**Error mapping:**

| Revert | Kido error |
|---|---|
| `"39"` | `NOTHING_TO_REPAY` (not a policy failure) |
| `"40"` | `ADAPTER_BUG` |
| `"26"` | `INVALID_AMOUNT` |

**Monitor:** `getUserAccountData.healthFactor` (1e18 scale).
