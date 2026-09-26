import { encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { AAVE_BASE_DECIMALS, AAVE_POOL_ABI, CHAINLINK_FEED_ABI, ERC20_ABI, MAINNET, VARIABLE_RATE, WETH_ABI } from "./chain.js";
import { ACTION_KINDS } from "./deployer.js";
import type { ForkPolicy } from "./record.js";

/**
 * Scenario drivers: one per protocol action the fork lab can exercise.
 *
 * A driver knows four things about its protocol on the mainnet fork: how to open a position worth
 * guarding, how to observe it, when the agent should propose an action and what exact calldata
 * that action is, and how an operator can stress it. Everything else — the policy verdict, the
 * capability, the authorization, the executor call — is the same ContextLock path for every driver
 * and lives in the runtime. A driver never signs and never submits.
 *
 * Every address below is mainnet's, verified today by reading the contract (see the adapters'
 * deployment registries), because the fork IS mainnet's state.
 */

export const FORK_ADDR = {
  wsteth: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" as Address,
  steth: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" as Address,
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address,
  comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3" as Address,
  /** Uniswap V3 SwapRouter02. */
  router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as Address,
} as const;

/** The mainnet wstETH/USDC 86% market, resolved by idToMarketParams on 2026-09-11. */
export const MORPHO_MARKET = {
  id: "0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc" as Hex,
  params: {
    loanToken: MAINNET.usdc,
    collateralToken: FORK_ADDR.wsteth,
    oracle: "0x48F7E36EB6B826B2dF4B2E630B62Cd25e89E40e2" as Address,
    irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC" as Address,
    lltv: 860_000_000_000_000_000n,
  },
} as const;

const WSTETH_ABI = parseAbi([
  "function wrap(uint256 _stETHAmount) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function stEthPerToken() view returns (uint256)",
]);
const STETH_ABI = parseAbi(["function submit(address _referral) payable returns (uint256)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const COMET_ABI = parseAbi([
  "function supplyTo(address dst, address asset, uint256 amount)",
  "function withdrawTo(address to, address asset, uint256 amount)",
  "function borrowBalanceOf(address account) view returns (uint256)",
  "function collateralBalanceOf(address account, address asset) view returns (uint128)",
  "function getAssetInfoByAddress(address asset) view returns (uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap)",
  "function getPrice(address priceFeed) view returns (uint256)",
  "function baseTokenPriceFeed() view returns (address)",
]);
const MORPHO_ABI = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function supplyCollateral(MarketParams marketParams, uint256 assets, address onBehalf, bytes data)",
  "function repay(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
  "function borrow(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
]);
const ORACLE_ABI = parseAbi(["function price() view returns (uint256)"]);
const ROUTER_ABI = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);

/* ───────────────────────────── the contract ───────────────────────────── */

export interface DriverContext {
  pub: PublicClient;
  /** The executor: the vault the agent's tokens sit in and the caller of every action. */
  vault: Address;
  /**
   * The submitting account. It holds the treasury's NATIVE ETH: the executor has no receive()
   * and cannot custody ETH, so a payable action's value travels with the submission — the executor
   * forwards exactly `cap.value` and nothing else. What it mints (stETH) still lands in the vault.
   */
  relayer: Address;
  /** The relayer's balance when the deployment opened, so idle ETH is what arrived since. */
  ethBaseline: { wei: bigint };
  /** The position owner; also the agent's identity. */
  user: Address;
  userWallet: WalletClient;
  policy: ForkPolicy;
  /** ETH/USD from the Chainlink feed on the fork, 8 decimals. */
  ethUsd: () => Promise<bigint>;
}

export interface DriverObservation {
  driverId: string;
  protocol: string;
  label: string;
  /** For a lending driver, the position's health in bps; null for the others. */
  healthBps: number | null;
  metrics: Record<string, number>;
  detail: string;
}

export interface ProposalStep {
  kind: string;
  target: Address;
  calldata: Hex;
  value: bigint;
  label: string;
}

export interface Proposal {
  driverId: string;
  kind: string;
  label: string;
  /** The action's value in USD, 6 decimals — what the policy engine rules on. */
  amountUsd6: bigint;
  steps: ProposalStep[];
  detail: Record<string, number | string>;
}

export interface StressOption {
  id: string;
  label: string;
  /** For a health-factor target the UI offers presets; for a top-up it offers an amount. */
  kind: "health-target" | "amount";
}

export interface ScenarioDriver {
  id: string;
  protocol: string;
  /** The Blueprint action kind this driver exercises. */
  actionKind: string;
  /** Contracts the executor may call for this driver, including tokens for approvals. */
  targets: Address[];
  setup(ctx: DriverContext, send: (label: string, tx: () => Promise<Hex>) => Promise<void>): Promise<string>;
  observe(ctx: DriverContext): Promise<DriverObservation>;
  propose(ctx: DriverContext, obs: DriverObservation): Promise<Proposal | null>;
  stress(ctx: DriverContext, option: string, value: number, send: (label: string, tx: () => Promise<Hex>) => Promise<void>): Promise<{ before: DriverObservation; after: DriverObservation; detail: string }>;
  stressOptions: StressOption[];
}

/**
 * The most an agent proposes in one action: the Blueprint's escalation ceiling.
 *
 * Public in the Blueprint (it is the user's own "$1,000–$5,000 needs a signature"), so the agent
 * may size to it. It never sizes to the autonomous limit: that would be decomposing a refused
 * action into permitted ones, which the generated runtime forbids by design.
 */
const ceilingUsd6 = (policy: ForkPolicy): bigint => BigInt(policy.escalationLimit);

const approveStep = (token: Address, spender: Address, amount: bigint, label: string): ProposalStep => ({
  kind: ACTION_KINDS.approve, target: token, calldata: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amount] }), value: 0n, label,
});

const hfBps = (wad: bigint): number => Number((wad > 10n ** 24n ? 10n ** 24n : wad) / 10n ** 14n);
const bigMin = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const usd6FromEth = (wei: bigint, ethUsd8: bigint): bigint => (wei * ethUsd8) / 10n ** 20n;
/** Anvil forks lazily fetch state; a first call on a cold contract can take a while. */
const TX_TIMEOUT = 180_000;

/* ─────────────────────────────── Aave v3 ─────────────────────────────── */

export const AAVE_REPAY_DRIVER: ScenarioDriver = {
  id: "aave-repay",
  protocol: "aave",
  actionKind: "AAVE_REPAY",
  targets: [MAINNET.aavePool, MAINNET.usdc],
  stressOptions: [{ id: "borrow-more", label: "borrow more USDC until the health factor is", kind: "health-target" }],

  async setup(ctx, send) {
    const supply = 5n * 10n ** 18n;
    const w = ctx.userWallet;
    await send("aave: wrap 5 ETH", () => w.writeContract({ address: MAINNET.weth, abi: WETH_ABI, functionName: "deposit", value: supply, account: w.account!, chain: w.chain }));
    await send("aave: approve WETH to the pool", () => w.writeContract({ address: MAINNET.weth, abi: ERC20_ABI, functionName: "approve", args: [MAINNET.aavePool, supply], account: w.account!, chain: w.chain }));
    await send("aave: supply 5 WETH", () => w.writeContract({ address: MAINNET.aavePool, abi: AAVE_POOL_ABI, functionName: "supply", args: [MAINNET.weth, supply, ctx.user, 0], account: w.account!, chain: w.chain }));
    const d = await ctx.pub.readContract({ address: MAINNET.aavePool, abi: AAVE_POOL_ABI, functionName: "getUserAccountData", args: [ctx.user] });
    const debtBase = (d[0] * d[3]) / 18_000n;
    const borrow = debtBase / 10n ** BigInt(AAVE_BASE_DECIMALS - 6);
    await send("aave: borrow USDC to health factor 1.80", () => w.writeContract({ address: MAINNET.aavePool, abi: AAVE_POOL_ABI, functionName: "borrow", args: [MAINNET.usdc, borrow, VARIABLE_RATE, 0, ctx.user], account: w.account!, chain: w.chain }));
    await send("aave: park the borrowed USDC in the vault", () => w.writeContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "transfer", args: [ctx.vault, borrow], account: w.account!, chain: w.chain }));
    return `5 WETH supplied, ${(Number(borrow) / 1e6).toFixed(2)} USDC borrowed at health factor 1.80`;
  },

  async observe(ctx) {
    const d = await ctx.pub.readContract({ address: MAINNET.aavePool, abi: AAVE_POOL_ABI, functionName: "getUserAccountData", args: [ctx.user] });
    const h = hfBps(d[5]);
    return { driverId: "aave-repay", protocol: "aave", label: "Aave v3", healthBps: h, metrics: { healthFactorBps: h, debtUsd: Number(d[1]) / 1e8, collateralUsd: Number(d[0]) / 1e8, liquidationThresholdBps: Number(d[3]) }, detail: `health factor ${(h / 1e4).toFixed(3)}, debt $${(Number(d[1]) / 1e8).toFixed(2)}` };
  },

  async propose(ctx, obs) {
    if (obs.healthBps === null || obs.healthBps >= ctx.policy.targetHealthFactorBps) return null;
    const d = await ctx.pub.readContract({ address: MAINNET.aavePool, abi: AAVE_POOL_ABI, functionName: "getUserAccountData", args: [ctx.user] });
    const targetDebt = (d[0] * d[3]) / BigInt(ctx.policy.restoreHealthFactorBps);
    if (d[1] <= targetDebt) return null;
    const vault = await ctx.pub.readContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [ctx.vault] });
    let repay = bigMin((d[1] - targetDebt) / 100n, ceilingUsd6(ctx.policy));
    if (repay > vault) repay = vault;
    if (repay <= 0n) return null;
    return {
      driverId: "aave-repay", kind: "AAVE_REPAY", label: `repay ${(Number(repay) / 1e6).toFixed(2)} USDC of Aave debt`, amountUsd6: repay,
      steps: [
        approveStep(MAINNET.usdc, MAINNET.aavePool, repay, "approve USDC to the Aave pool (exact amount)"),
        { kind: "AAVE_REPAY", target: MAINNET.aavePool, calldata: encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "repay", args: [MAINNET.usdc, repay, VARIABLE_RATE, ctx.user] }), value: 0n, label: "repay Aave v3 debt" },
      ],
      detail: { healthFactorBps: obs.healthBps, restoreTo: ctx.policy.restoreHealthFactorBps },
    };
  },

  async stress(ctx, _option, targetBps, send) {
    const before = await this.observe(ctx);
    const d = await ctx.pub.readContract({ address: MAINNET.aavePool, abi: AAVE_POOL_ABI, functionName: "getUserAccountData", args: [ctx.user] });
    const targetDebt = (d[0] * d[3]) / BigInt(targetBps);
    const extra = (targetDebt - d[1]) / 100n;
    if (extra <= 0n) throw new Error(`Aave health factor is already ${(before.healthBps! / 1e4).toFixed(3)}, at or below ${(targetBps / 1e4).toFixed(3)}`);
    const w = ctx.userWallet;
    await send("operator stress: borrow more USDC from Aave", () => w.writeContract({ address: MAINNET.aavePool, abi: AAVE_POOL_ABI, functionName: "borrow", args: [MAINNET.usdc, extra, VARIABLE_RATE, 0, ctx.user], account: w.account!, chain: w.chain }));
    await send("operator stress: park the USDC in the vault", () => w.writeContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "transfer", args: [ctx.vault, extra], account: w.account!, chain: w.chain }));
    const after = await this.observe(ctx);
    return { before, after, detail: `the position owner borrowed ${(Number(extra) / 1e6).toFixed(2)} USDC more` };
  },
};

/* ─────────────────────────────── Compound v3 ─────────────────────────────── */

async function cometHealth(ctx: DriverContext): Promise<{ borrow: bigint; collateralUsd8: bigint; lcfBps: number; hf: number | null; wethBalance: bigint }> {
  const [borrow, wethBalance, info] = await Promise.all([
    ctx.pub.readContract({ address: FORK_ADDR.comet, abi: COMET_ABI, functionName: "borrowBalanceOf", args: [ctx.user] }),
    ctx.pub.readContract({ address: FORK_ADDR.comet, abi: COMET_ABI, functionName: "collateralBalanceOf", args: [ctx.user, MAINNET.weth] }),
    ctx.pub.readContract({ address: FORK_ADDR.comet, abi: COMET_ABI, functionName: "getAssetInfoByAddress", args: [MAINNET.weth] }),
  ]);
  const price = await ctx.pub.readContract({ address: FORK_ADDR.comet, abi: COMET_ABI, functionName: "getPrice", args: [info[2]] });
  // collateral (18dp) × price (8dp) / scale (18dp) → USD 8dp
  const collateralUsd8 = (wethBalance * price) / info[3];
  const lcfBps = Number(info[5] / 10n ** 14n);
  const hf = borrow === 0n ? null : Number(((collateralUsd8 * BigInt(lcfBps)) / 10_000n * 10_000n) / (borrow * 100n));
  return { borrow, collateralUsd8, lcfBps, hf, wethBalance };
}

export const COMPOUND_REPAY_DRIVER: ScenarioDriver = {
  id: "compound-repay",
  protocol: "compound",
  actionKind: "COMPOUND_REPAY",
  targets: [FORK_ADDR.comet, MAINNET.usdc],
  stressOptions: [{ id: "borrow-more", label: "borrow more USDC until the health factor is", kind: "health-target" }],

  async setup(ctx, send) {
    const supply = 5n * 10n ** 18n;
    const w = ctx.userWallet;
    await send("compound: wrap 5 ETH", () => w.writeContract({ address: MAINNET.weth, abi: WETH_ABI, functionName: "deposit", value: supply, account: w.account!, chain: w.chain }));
    await send("compound: approve WETH to Comet", () => w.writeContract({ address: MAINNET.weth, abi: ERC20_ABI, functionName: "approve", args: [FORK_ADDR.comet, supply], account: w.account!, chain: w.chain }));
    await send("compound: supply 5 WETH as collateral", () => w.writeContract({ address: FORK_ADDR.comet, abi: COMET_ABI, functionName: "supplyTo", args: [ctx.user, MAINNET.weth, supply], account: w.account!, chain: w.chain }));
    const h = await cometHealth(ctx);
    // borrow so that HF = 1.80: borrow = collateral × LCF / 1.8, USD 8dp → USDC 6dp
    const borrow = ((h.collateralUsd8 * BigInt(h.lcfBps)) / 10_000n * 10_000n / 18_000n) / 100n;
    await send("compound: borrow USDC to health factor 1.80", () => w.writeContract({ address: FORK_ADDR.comet, abi: COMET_ABI, functionName: "withdrawTo", args: [ctx.user, MAINNET.usdc, borrow], account: w.account!, chain: w.chain }));
    await send("compound: park the borrowed USDC in the vault", () => w.writeContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "transfer", args: [ctx.vault, borrow], account: w.account!, chain: w.chain }));
    return `5 WETH supplied to Comet, ${(Number(borrow) / 1e6).toFixed(2)} USDC borrowed at health factor 1.80`;
  },

  async observe(ctx) {
    const h = await cometHealth(ctx);
    const hf = h.hf ?? 100_000;
    return { driverId: "compound-repay", protocol: "compound", label: "Compound v3", healthBps: hf, metrics: { healthFactorBps: hf, debtUsd: Number(h.borrow) / 1e6, collateralUsd: Number(h.collateralUsd8) / 1e8, liquidateCollateralFactorBps: h.lcfBps }, detail: `health factor ${(hf / 1e4).toFixed(3)}, debt $${(Number(h.borrow) / 1e6).toFixed(2)}` };
  },

  async propose(ctx, obs) {
    if (obs.healthBps === null || obs.healthBps >= ctx.policy.targetHealthFactorBps) return null;
    const h = await cometHealth(ctx);
    const targetBorrow = ((h.collateralUsd8 * BigInt(h.lcfBps)) / 10_000n * 10_000n / BigInt(ctx.policy.restoreHealthFactorBps)) / 100n;
    if (h.borrow <= targetBorrow) return null;
    const vault = await ctx.pub.readContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [ctx.vault] });
    let repay = bigMin(h.borrow - targetBorrow, ceilingUsd6(ctx.policy));
    if (repay > vault) repay = vault;
    if (repay <= 0n) return null;
    return {
      driverId: "compound-repay", kind: "COMPOUND_REPAY", label: `repay ${(Number(repay) / 1e6).toFixed(2)} USDC of Compound v3 debt`, amountUsd6: repay,
      steps: [
        approveStep(MAINNET.usdc, FORK_ADDR.comet, repay, "approve USDC to Comet (exact amount)"),
        { kind: "COMPOUND_REPAY", target: FORK_ADDR.comet, calldata: encodeFunctionData({ abi: COMET_ABI, functionName: "supplyTo", args: [ctx.user, MAINNET.usdc, repay] }), value: 0n, label: "repay Compound v3 debt (supplyTo base asset)" },
      ],
      detail: { healthFactorBps: obs.healthBps, restoreTo: ctx.policy.restoreHealthFactorBps },
    };
  },

  async stress(ctx, _option, targetBps, send) {
    const before = await this.observe(ctx);
    const h = await cometHealth(ctx);
    const targetBorrow = ((h.collateralUsd8 * BigInt(h.lcfBps)) / 10_000n * 10_000n / BigInt(targetBps)) / 100n;
    const extra = targetBorrow - h.borrow;
    if (extra <= 0n) throw new Error(`Compound health factor is already ${((before.healthBps ?? 0) / 1e4).toFixed(3)}, at or below ${(targetBps / 1e4).toFixed(3)}`);
    const w = ctx.userWallet;
    await send("operator stress: borrow more USDC from Comet", () => w.writeContract({ address: FORK_ADDR.comet, abi: COMET_ABI, functionName: "withdrawTo", args: [ctx.user, MAINNET.usdc, extra], account: w.account!, chain: w.chain }));
    await send("operator stress: park the USDC in the vault", () => w.writeContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "transfer", args: [ctx.vault, extra], account: w.account!, chain: w.chain }));
    const after = await this.observe(ctx);
    return { before, after, detail: `the position owner borrowed ${(Number(extra) / 1e6).toFixed(2)} USDC more` };
  },
};

/* ─────────────────────────────── Morpho Blue ─────────────────────────────── */

const mp = MORPHO_MARKET.params;

async function morphoHealth(ctx: DriverContext): Promise<{ borrow: bigint; collateral: bigint; collateralUsdc: bigint; hf: number | null; price: bigint }> {
  const [pos, mkt, price] = await Promise.all([
    ctx.pub.readContract({ address: FORK_ADDR.morpho, abi: MORPHO_ABI, functionName: "position", args: [MORPHO_MARKET.id, ctx.user] }),
    ctx.pub.readContract({ address: FORK_ADDR.morpho, abi: MORPHO_ABI, functionName: "market", args: [MORPHO_MARKET.id] }),
    ctx.pub.readContract({ address: mp.oracle, abi: ORACLE_ABI, functionName: "price" }),
  ]);
  const shares = pos[1];
  const borrow = shares === 0n ? 0n : (shares * (mkt[2] + 1n) + (mkt[3] + 10n ** 6n) - 1n) / (mkt[3] + 10n ** 6n);
  const collateralUsdc = (pos[2] * price) / 10n ** 36n;
  const hf = borrow === 0n ? null : Number((collateralUsdc * mp.lltv) / borrow / 10n ** 14n);
  return { borrow, collateral: pos[2], collateralUsdc, hf, price };
}

export const MORPHO_REPAY_DRIVER: ScenarioDriver = {
  id: "morpho-repay",
  protocol: "morpho",
  actionKind: "MORPHO_REPAY",
  targets: [FORK_ADDR.morpho, MAINNET.usdc],
  stressOptions: [{ id: "borrow-more", label: "borrow more USDC until the health factor is", kind: "health-target" }],

  async setup(ctx, send) {
    const stake = 5n * 10n ** 18n;
    const w = ctx.userWallet;
    // The collateral is wstETH: staked with Lido, then wrapped. Real protocol calls, on the fork.
    await send("morpho: stake 5 ETH with Lido for the collateral", () => w.writeContract({ address: FORK_ADDR.steth, abi: STETH_ABI, functionName: "submit", args: ["0x0000000000000000000000000000000000000000"], value: stake, account: w.account!, chain: w.chain }));
    const steth = await ctx.pub.readContract({ address: FORK_ADDR.steth, abi: STETH_ABI, functionName: "balanceOf", args: [ctx.user] });
    await send("morpho: approve stETH to wstETH", () => w.writeContract({ address: FORK_ADDR.steth, abi: STETH_ABI, functionName: "approve", args: [FORK_ADDR.wsteth, steth], account: w.account!, chain: w.chain }));
    await send("morpho: wrap stETH into wstETH", () => w.writeContract({ address: FORK_ADDR.wsteth, abi: WSTETH_ABI, functionName: "wrap", args: [steth - 1n], account: w.account!, chain: w.chain }));
    const wsteth = await ctx.pub.readContract({ address: FORK_ADDR.wsteth, abi: WSTETH_ABI, functionName: "balanceOf", args: [ctx.user] });
    await send("morpho: approve wstETH to Morpho Blue", () => w.writeContract({ address: FORK_ADDR.wsteth, abi: ERC20_ABI, functionName: "approve", args: [FORK_ADDR.morpho, wsteth], account: w.account!, chain: w.chain }));
    await send("morpho: supply wstETH collateral to the wstETH/USDC market", () => w.writeContract({ address: FORK_ADDR.morpho, abi: MORPHO_ABI, functionName: "supplyCollateral", args: [mp, wsteth, ctx.user, "0x"], account: w.account!, chain: w.chain }));
    const h = await morphoHealth(ctx);
    const borrow = (h.collateralUsdc * mp.lltv) / 10n ** 18n * 10_000n / 18_000n;
    await send("morpho: borrow USDC to health factor 1.80", () => w.writeContract({ address: FORK_ADDR.morpho, abi: MORPHO_ABI, functionName: "borrow", args: [mp, borrow, 0n, ctx.user, ctx.user], account: w.account!, chain: w.chain }));
    await send("morpho: park the borrowed USDC in the vault", () => w.writeContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "transfer", args: [ctx.vault, borrow], account: w.account!, chain: w.chain }));
    return `${(Number(wsteth) / 1e18).toFixed(4)} wstETH supplied to Morpho Blue, ${(Number(borrow) / 1e6).toFixed(2)} USDC borrowed at health factor 1.80`;
  },

  async observe(ctx) {
    const h = await morphoHealth(ctx);
    const hf = h.hf ?? 100_000;
    return { driverId: "morpho-repay", protocol: "morpho", label: "Morpho Blue", healthBps: hf, metrics: { healthFactorBps: hf, debtUsd: Number(h.borrow) / 1e6, collateralUsd: Number(h.collateralUsdc) / 1e6, lltvBps: Number(mp.lltv / 10n ** 14n) }, detail: `health factor ${(hf / 1e4).toFixed(3)}, debt $${(Number(h.borrow) / 1e6).toFixed(2)}` };
  },

  async propose(ctx, obs) {
    if (obs.healthBps === null || obs.healthBps >= ctx.policy.targetHealthFactorBps) return null;
    const h = await morphoHealth(ctx);
    const targetBorrow = (h.collateralUsdc * mp.lltv) / 10n ** 18n * 10_000n / BigInt(ctx.policy.restoreHealthFactorBps);
    if (h.borrow <= targetBorrow) return null;
    const vault = await ctx.pub.readContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [ctx.vault] });
    let repay = bigMin(h.borrow - targetBorrow, ceilingUsd6(ctx.policy));
    if (repay > vault) repay = vault;
    if (repay <= 0n) return null;
    return {
      driverId: "morpho-repay", kind: "MORPHO_REPAY", label: `repay ${(Number(repay) / 1e6).toFixed(2)} USDC of Morpho Blue debt`, amountUsd6: repay,
      steps: [
        approveStep(MAINNET.usdc, FORK_ADDR.morpho, repay, "approve USDC to Morpho Blue (exact amount)"),
        { kind: "MORPHO_REPAY", target: FORK_ADDR.morpho, calldata: encodeFunctionData({ abi: MORPHO_ABI, functionName: "repay", args: [mp, repay, 0n, ctx.user, "0x"] }), value: 0n, label: "repay Morpho Blue debt" },
      ],
      detail: { healthFactorBps: obs.healthBps, restoreTo: ctx.policy.restoreHealthFactorBps },
    };
  },

  async stress(ctx, _option, targetBps, send) {
    const before = await this.observe(ctx);
    const h = await morphoHealth(ctx);
    const targetBorrow = (h.collateralUsdc * mp.lltv) / 10n ** 18n * 10_000n / BigInt(targetBps);
    const extra = targetBorrow - h.borrow;
    if (extra <= 0n) throw new Error(`Morpho health factor is already ${((before.healthBps ?? 0) / 1e4).toFixed(3)}, at or below ${(targetBps / 1e4).toFixed(3)}`);
    const w = ctx.userWallet;
    await send("operator stress: borrow more USDC from Morpho Blue", () => w.writeContract({ address: FORK_ADDR.morpho, abi: MORPHO_ABI, functionName: "borrow", args: [mp, extra, 0n, ctx.user, ctx.user], account: w.account!, chain: w.chain }));
    await send("operator stress: park the USDC in the vault", () => w.writeContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "transfer", args: [ctx.vault, extra], account: w.account!, chain: w.chain }));
    const after = await this.observe(ctx);
    return { before, after, detail: `the position owner borrowed ${(Number(extra) / 1e6).toFixed(2)} USDC more` };
  },
};

/* ─────────────────────────────── Lido ─────────────────────────────── */

/** ETH kept unstaked for gas and small repayments. */
const ETH_RESERVE = 5n * 10n ** 17n;

async function idleEth(ctx: DriverContext): Promise<{ arrived: bigint; idle: bigint }> {
  const bal = await ctx.pub.getBalance({ address: ctx.relayer });
  const arrived = bal > ctx.ethBaseline.wei ? bal - ctx.ethBaseline.wei : 0n;
  return { arrived, idle: arrived > ETH_RESERVE ? arrived - ETH_RESERVE : 0n };
}

export const LIDO_STAKE_DRIVER: ScenarioDriver = {
  id: "lido-stake",
  protocol: "lido",
  actionKind: "LIDO_STAKE",
  targets: [FORK_ADDR.steth],
  stressOptions: [{ id: "eth-arrives", label: "ETH arrives for the treasury (amount in ETH)", kind: "amount" }],

  async setup(ctx, send) {
    // Nothing to open: ETH arrives for the treasury, and some of it is idle. The submitting
    // account holds it (the executor cannot); what Lido mints goes to the vault.
    const w = ctx.userWallet;
    ctx.ethBaseline.wei = await ctx.pub.getBalance({ address: ctx.relayer });
    await send("lido: 0.8 ETH arrives for the treasury", () => w.sendTransaction({ to: ctx.relayer, value: 8n * 10n ** 17n, account: w.account!, chain: w.chain }));
    return "0.8 ETH arrived for the treasury; anything above the 0.5 ETH reserve is idle and may be staked, and the stETH is minted to the vault";
  },

  async observe(ctx) {
    const [{ arrived, idle }, steth, ethUsd] = await Promise.all([idleEth(ctx), ctx.pub.readContract({ address: FORK_ADDR.steth, abi: STETH_ABI, functionName: "balanceOf", args: [ctx.vault] }), ctx.ethUsd()]);
    return { driverId: "lido-stake", protocol: "lido", label: "Lido", healthBps: null, metrics: { treasuryEth: Number(arrived) / 1e18, idleEth: Number(idle) / 1e18, stEth: Number(steth) / 1e18, idleUsd: Number(usd6FromEth(idle, ethUsd)) / 1e6 }, detail: `${(Number(arrived) / 1e18).toFixed(4)} ETH held, ${(Number(idle) / 1e18).toFixed(4)} idle, ${(Number(steth) / 1e18).toFixed(4)} stETH in the vault` };
  },

  async propose(ctx, obs) {
    const { idle: allIdle } = await idleEth(ctx);
    if (allIdle < 10n ** 16n) return null;
    const ethUsd = await ctx.ethUsd();
    // One action's ceiling, in ETH at the feed price.
    const capWei = (ceilingUsd6(ctx.policy) * 10n ** 20n) / ethUsd;
    const idle = bigMin(allIdle, capWei);
    return {
      driverId: "lido-stake", kind: "LIDO_STAKE", label: `stake ${(Number(idle) / 1e18).toFixed(4)} idle ETH with Lido`, amountUsd6: usd6FromEth(idle, ethUsd),
      steps: [{ kind: "LIDO_STAKE", target: FORK_ADDR.steth, calldata: encodeFunctionData({ abi: STETH_ABI, functionName: "submit", args: ["0x0000000000000000000000000000000000000000"] }), value: idle, label: "stake ETH with Lido (submit)" }],
      detail: { idleEth: obs.metrics.idleEth!, ethUsd: Number(ethUsd) / 1e8 },
    };
  },

  async stress(ctx, _option, amountEth, send) {
    const before = await this.observe(ctx);
    const wei = BigInt(Math.round(amountEth * 1e6)) * 10n ** 12n;
    if (wei <= 0n) throw new Error("amount must be positive");
    const w = ctx.userWallet;
    await send(`operator stress: ${amountEth} ETH arrives for the treasury`, () => w.sendTransaction({ to: ctx.relayer, value: wei, account: w.account!, chain: w.chain }));
    const after = await this.observe(ctx);
    return { before, after, detail: `${amountEth} ETH arrived for the treasury` };
  },
};

/* ─────────────────────────────── Uniswap ─────────────────────────────── */

/** USDC/WETH 0.05% pool. */
const POOL_FEE = 500;
const TARGET_ETH_BPS = 5_000n;
const DRIFT_BPS = 500n;

async function vaultAllocation(ctx: DriverContext): Promise<{ weth: bigint; usdc: bigint; wethUsd6: bigint; totalUsd6: bigint; ethBps: bigint; ethUsd: bigint }> {
  const [weth, usdc, ethUsd] = await Promise.all([
    ctx.pub.readContract({ address: MAINNET.weth, abi: ERC20_ABI, functionName: "balanceOf", args: [ctx.vault] }),
    ctx.pub.readContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [ctx.vault] }),
    ctx.ethUsd(),
  ]);
  const wethUsd6 = usd6FromEth(weth, ethUsd);
  const totalUsd6 = wethUsd6 + usdc;
  return { weth, usdc, wethUsd6, totalUsd6, ethBps: totalUsd6 === 0n ? 0n : (wethUsd6 * 10_000n) / totalUsd6, ethUsd };
}

export const SWAP_DRIVER: ScenarioDriver = {
  id: "uniswap-rebalance",
  protocol: "dex-router",
  actionKind: "TOKEN_SWAP",
  targets: [FORK_ADDR.router, MAINNET.usdc, MAINNET.weth],
  stressOptions: [{ id: "usdc-arrives", label: "USDC arrives in the vault (amount in USDC)", kind: "amount" }],

  async setup(ctx, send) {
    // The vault starts balanced: 1 WETH and its USD value in USDC (bought on the fork).
    const w = ctx.userWallet;
    const one = 10n ** 18n;
    await send("uniswap: wrap 2 ETH", () => w.writeContract({ address: MAINNET.weth, abi: WETH_ABI, functionName: "deposit", value: 2n * one, account: w.account!, chain: w.chain }));
    await send("uniswap: approve WETH to the router", () => w.writeContract({ address: MAINNET.weth, abi: ERC20_ABI, functionName: "approve", args: [FORK_ADDR.router, one], account: w.account!, chain: w.chain }));
    await send("uniswap: swap 1 WETH for USDC", () => w.writeContract({ address: FORK_ADDR.router, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [{ tokenIn: MAINNET.weth, tokenOut: MAINNET.usdc, fee: POOL_FEE, recipient: ctx.user, amountIn: one, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }], account: w.account!, chain: w.chain, gas: 500_000n }));
    const usdc = await ctx.pub.readContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [ctx.user] });
    await send("uniswap: move 1 WETH to the vault", () => w.writeContract({ address: MAINNET.weth, abi: ERC20_ABI, functionName: "transfer", args: [ctx.vault, one], account: w.account!, chain: w.chain }));
    await send("uniswap: move the USDC to the vault", () => w.writeContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "transfer", args: [ctx.vault, usdc], account: w.account!, chain: w.chain }));
    return `the vault holds 1 WETH and ${(Number(usdc) / 1e6).toFixed(2)} USDC — a 50/50 allocation by value`;
  },

  async observe(ctx) {
    const a = await vaultAllocation(ctx);
    return { driverId: "uniswap-rebalance", protocol: "dex-router", label: "Uniswap v3", healthBps: null, metrics: { ethBps: Number(a.ethBps), targetEthBps: Number(TARGET_ETH_BPS), driftBps: Number(a.ethBps > TARGET_ETH_BPS ? a.ethBps - TARGET_ETH_BPS : TARGET_ETH_BPS - a.ethBps), vaultWeth: Number(a.weth) / 1e18, vaultUsdc: Number(a.usdc) / 1e6, totalUsd: Number(a.totalUsd6) / 1e6 }, detail: `${(Number(a.ethBps) / 100).toFixed(1)}% ETH of $${(Number(a.totalUsd6) / 1e6).toFixed(2)}` };
  },

  async propose(ctx, obs) {
    const a = await vaultAllocation(ctx);
    const drift = a.ethBps > TARGET_ETH_BPS ? a.ethBps - TARGET_ETH_BPS : TARGET_ETH_BPS - a.ethBps;
    if (drift <= DRIFT_BPS || a.totalUsd6 === 0n) return null;
    const targetWethUsd6 = (a.totalUsd6 * TARGET_ETH_BPS) / 10_000n;
    const cap = ceilingUsd6(ctx.policy);
    if (a.ethBps > TARGET_ETH_BPS) {
      // Too much ETH: sell the excess WETH for USDC, at most one action's ceiling at a time.
      const excessUsd6 = bigMin(a.wethUsd6 - targetWethUsd6, cap);
      const amountIn = (excessUsd6 * 10n ** 20n) / a.ethUsd;
      return {
        driverId: "uniswap-rebalance", kind: "TOKEN_SWAP", label: `swap ${(Number(amountIn) / 1e18).toFixed(4)} WETH for USDC to return to 50/50`, amountUsd6: excessUsd6,
        steps: [
          approveStep(MAINNET.weth, FORK_ADDR.router, amountIn, "approve WETH to the router (exact amount)"),
          { kind: "TOKEN_SWAP", target: FORK_ADDR.router, calldata: encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [{ tokenIn: MAINNET.weth, tokenOut: MAINNET.usdc, fee: POOL_FEE, recipient: ctx.vault, amountIn, amountOutMinimum: (excessUsd6 * 99n) / 100n, sqrtPriceLimitX96: 0n }] }), value: 0n, label: "swap WETH → USDC on Uniswap v3" },
        ],
        detail: { ethBps: Number(a.ethBps), driftBps: Number(drift) },
      };
    }
    // Too much USDC: buy WETH with the excess, at most one action's ceiling at a time.
    const excessUsd6 = bigMin(targetWethUsd6 - a.wethUsd6, cap);
    return {
      driverId: "uniswap-rebalance", kind: "TOKEN_SWAP", label: `swap ${(Number(excessUsd6) / 1e6).toFixed(2)} USDC for WETH to return to 50/50`, amountUsd6: excessUsd6,
      steps: [
        approveStep(MAINNET.usdc, FORK_ADDR.router, excessUsd6, "approve USDC to the router (exact amount)"),
        { kind: "TOKEN_SWAP", target: FORK_ADDR.router, calldata: encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [{ tokenIn: MAINNET.usdc, tokenOut: MAINNET.weth, fee: POOL_FEE, recipient: ctx.vault, amountIn: excessUsd6, amountOutMinimum: (((excessUsd6 * 10n ** 20n) / a.ethUsd) * 99n) / 100n, sqrtPriceLimitX96: 0n }] }), value: 0n, label: "swap USDC → WETH on Uniswap v3" },
      ],
      detail: { ethBps: Number(a.ethBps), driftBps: Number(drift), ...{ void: obs.driverId } },
    };
  },

  async stress(ctx, _option, amountUsdc, send) {
    const before = await this.observe(ctx);
    const usdc = BigInt(Math.round(amountUsdc * 1e6));
    if (usdc <= 0n) throw new Error("amount must be positive");
    const w = ctx.userWallet;
    // The owner buys the USDC on the fork and sends it to the vault: real tokens, real pool.
    const ethUsd = await ctx.ethUsd();
    const ethIn = ((usdc * 10n ** 20n) / ethUsd * 102n) / 100n;
    await send("operator stress: wrap ETH", () => w.writeContract({ address: MAINNET.weth, abi: WETH_ABI, functionName: "deposit", value: ethIn, account: w.account!, chain: w.chain }));
    await send("operator stress: approve WETH to the router", () => w.writeContract({ address: MAINNET.weth, abi: ERC20_ABI, functionName: "approve", args: [FORK_ADDR.router, ethIn], account: w.account!, chain: w.chain }));
    const beforeUsdc = await ctx.pub.readContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [ctx.user] });
    await send("operator stress: buy USDC on Uniswap", () => w.writeContract({ address: FORK_ADDR.router, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [{ tokenIn: MAINNET.weth, tokenOut: MAINNET.usdc, fee: POOL_FEE, recipient: ctx.user, amountIn: ethIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }], account: w.account!, chain: w.chain, gas: 500_000n }));
    const got = (await ctx.pub.readContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [ctx.user] })) - beforeUsdc;
    await send(`operator stress: ${(Number(got) / 1e6).toFixed(2)} USDC arrives in the vault`, () => w.writeContract({ address: MAINNET.usdc, abi: ERC20_ABI, functionName: "transfer", args: [ctx.vault, got], account: w.account!, chain: w.chain }));
    const after = await this.observe(ctx);
    return { before, after, detail: `${(Number(got) / 1e6).toFixed(2)} USDC arrived in the vault` };
  },
};

/* ─────────────────────────────── the registry ─────────────────────────────── */

export const SCENARIO_DRIVERS: ReadonlyArray<ScenarioDriver> = [AAVE_REPAY_DRIVER, COMPOUND_REPAY_DRIVER, MORPHO_REPAY_DRIVER, LIDO_STAKE_DRIVER, SWAP_DRIVER];

/** The drivers for a Blueprint's action kinds, in catalogue order. Kinds with no driver are reported, not guessed. */
export function driversFor(actionKinds: string[]): { drivers: ScenarioDriver[]; unexercised: string[] } {
  const drivers = SCENARIO_DRIVERS.filter((d) => actionKinds.includes(d.actionKind));
  const covered = new Set(drivers.map((d) => d.actionKind));
  return { drivers, unexercised: actionKinds.filter((k) => !covered.has(k)) };
}

export async function readEthUsd(pub: PublicClient): Promise<bigint> {
  const r = await pub.readContract({ address: MAINNET.chainlinkEthUsd, abi: CHAINLINK_FEED_ABI, functionName: "latestRoundData" });
  return r[1];
}

export { TX_TIMEOUT };
