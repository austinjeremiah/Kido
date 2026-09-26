# Aave — current developer path, verified 2026-09-08

Everything below was read from current official documentation and then **verified on-chain against
Sepolia**. Where the documentation is silent — and on two security-critical points it is — the
contract was called directly and the real answer recorded.

## Developer direction

Current Aave docs present **AaveKit SDKs** as the primary path:

| Package | Published version |
|---|---|
| `@aave/react` | 6.5.0 |
| `@aave/client` | 6.5.0 |
| `@aave-dao/aave-address-book` | 4.66.4 |
| `@aave/core-v3` | 1.19.3 |

Both **v3 and v4** are current; v3 is the mature path and the one with a live Sepolia deployment.

**ContextLock uses direct contract reads and calldata construction, not the SDK.** The reasoning is
specific rather than stylistic: this adapter's job is to *independently decode and validate* what a
provider produced. An SDK that both builds a transaction and describes it is the same trust problem
as the Uniswap Trading API — and here we hold the ABI ourselves, so there is no reason to introduce
a party between us and the bytes. `@aave-dao/aave-address-book` is a legitimate address source and
is recorded as such, but addresses are pinned in our own registry after on-chain verification.

## Verified Sepolia deployment

| Contract | Address | Verified how |
|---|---|---|
| PoolAddressesProvider | `0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A` | `Pool.ADDRESSES_PROVIDER()` |
| Pool | `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` | `provider.getPool()`, codesize 2333, `POOL_REVISION()` = 1 |
| PoolDataProvider | `0x3e9708d80f7B3e43118013075F7e95CE3AB31F31` | `provider.getPoolDataProvider()` |
| AaveOracle | `0x2da88497588bf89281816106C7259e31AF45a663` | `provider.getPriceOracle()` |

The chain of verification matters: only the Pool address was taken from documentation, and every
other address was then derived **from the Pool itself** through the addresses provider. A wrong Pool
address would have produced a failed call rather than a plausible-looking set of siblings.

## Function signatures

From the official Pool documentation, unchanged from what the deployed contract accepts:

```solidity
function getUserAccountData(address user) external view returns (
    uint256 totalCollateralBase,
    uint256 totalDebtBase,
    uint256 availableBorrowsBase,
    uint256 currentLiquidationThreshold,
    uint256 ltv,
    uint256 healthFactor
);

function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);
function withdraw(address asset, uint256 amount, address to) external returns (uint256);
function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
function setUserUseReserveAsCollateral(address asset, bool useAsCollateral) external;
```

Note the asymmetry that matters for validation: `supply` and `repay` take **`onBehalfOf`** — the
account credited — while `withdraw` takes **`to`**, the address that *receives funds*. They occupy
different argument positions and mean different things, and conflating them is how a "supply on
behalf of the treasury" becomes a withdrawal to somewhere else.

## Units — the part the docs do not state

Two security-critical facts are **absent** from the Pool documentation and were read from the chain:

### 1. `healthFactor` is WAD (1e18)

The doc says only *"The current health factor of the user"* with no decimals. Health factor 1.6 is
therefore `1600000000000000000`, not `1.6` and not `16000` basis points.

### 2. Zero debt returns `type(uint256).max`, not zero and not "infinity"

Verified directly:

```
getUserAccountData(0x…0001)
  totalCollateralBase      0
  totalDebtBase            0
  availableBorrowsBase     0
  currentLiquidationThreshold 0
  ltv                      0
  healthFactor             115792089237316195423570985008687907853269984665640564039457584007913129639935
```

That is `2**256 - 1`. It is the protocol's "no debt, therefore no liquidation risk" sentinel.

This is the single most dangerous number in the adapter. Handled naively it goes wrong in both
directions:

- **Converted to a JS number** it becomes `1.157e77` — still large, so a `>` comparison happens to
  work, which is worse than failing because the bug survives testing. Any arithmetic on it is
  nonsense.
- **Treated as an ordinary value** it makes a position with no debt look like the healthiest possible
  position, which is true, but a guardian that then tries to "repay" has nothing to repay.

The adapter normalizes it to an explicit `NO_DEBT` state rather than a number.

### 3. Base currency is USD with 8 decimals

```
AaveOracle.BASE_CURRENCY()      0x0000000000000000000000000000000000000000   (USD, not a token)
AaveOracle.BASE_CURRENCY_UNIT() 100000000                                    (1e8)
```

So `totalCollateralBase` and `totalDebtBase` are USD at **8 decimals**, while `healthFactor` is WAD
at **18 decimals**, in the same return tuple. Mixing them is a 10-order-of-magnitude error that
produces a well-formed number.

| Value | Unit | Decimals |
|---|---|---|
| `totalCollateralBase`, `totalDebtBase`, `availableBorrowsBase` | USD | **8** |
| `currentLiquidationThreshold`, `ltv` | basis points | 4 (0–10000) |
| `healthFactor` | WAD | **18** |
| token amounts (`supply`/`repay` amount) | the token's own | per-asset |

Four different unit systems in one adapter. This is why P17's typed-unit compiler exists.

## `interestRateMode`

`repay` and `borrow` take `interestRateMode`. In Aave v3: `1` = stable, `2` = variable. Stable-rate
borrowing has been deprecated across v3 markets, so **2 (variable)** is the only mode this adapter
constructs, and mode `1` is rejected rather than passed through.

## Documentation drift filed

**FND-V2-009** — the Pool documentation specifies neither the health-factor decimals nor the
zero-debt sentinel, both of which are required to compare a health factor correctly.
