/// Creates the demo Uniswap v3 pool Wormhole-wrapped AMUSD / Aave test USDC on Sepolia and records
/// it in deployments/testnet.json. Liquidity is one-sided (Aave faucet USDC only, in a narrow range
/// just below 1:1), so swapping wrapped AMUSD in returns USDC and no wrapped AMUSD is needed to seed
/// it. The USDC address is read from the Aave pool's reserves, not pinned.
///
///   AMANE_EVM_RELAYER_KEY=<funded gas key>  SEPOLIA_RPC_URL=<rpc>  npx tsx scripts/deploy-rescue-pool.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestPath = resolve(root, 'deployments/testnet.json');
const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
const fail = (msg: string): never => {
  throw new Error(msg);
};
const rpc = process.env.SEPOLIA_RPC_URL ?? fail('SEPOLIA_RPC_URL is required');
const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
const wallet = createWalletClient({ chain: sepolia, transport: http(rpc), account: privateKeyToAccount((process.env.AMANE_EVM_RELAYER_KEY ?? fail('AMANE_EVM_RELAYER_KEY is required')) as Hex) });
const wait = async (hash: Hex) => {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') fail(`tx failed ${hash}`);
  return hash;
};
if (m.evm.pools?.uniswapV3WamusdUsdc) {
  console.log(JSON.stringify(m.evm.pools.uniswapV3WamusdUsdc, null, 2));
  process.exit(0);
}

const uni = m.evm.protocols.uniswapV3;
const aave = m.evm.protocols.aaveV3;
const FEE = (m.evm.adapters.find((a: { name: string }) => a.name === 'Uniswap V3 Swap') ?? fail('Uniswap adapter missing')).upstream.fee as number;
const SPACING: Record<number, number> = { 500: 10, 3000: 60, 10000: 200 };
const LIQ = BigInt(process.env.AMANE_RESCUE_POOL_USDC ?? 200) * 1_000000n;
const erc20 = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function approve(address,uint256) returns (bool)']);
const poolAbi = parseAbi(['function getReservesList() view returns (address[])']);
const reserves = (await pub.readContract({ address: aave.pool, abi: poolAbi, functionName: 'getReservesList' })) as Address[];
let usdc: Address | undefined;
for (const r of reserves) if ((await pub.readContract({ address: r, abi: erc20, functionName: 'symbol' })) === 'USDC') usdc = r;
usdc ??= fail('Aave pool lists no USDC reserve');
const wamusd = (m.evm.assets.wAMUSD ?? fail('wAMUSD missing from manifest')).address as Address;
const [d0, d1] = await Promise.all([wamusd, usdc].map((t) => pub.readContract({ address: t, abi: erc20, functionName: 'decimals' })));
if (d0 !== d1) fail('the one-sided 1:1 range below assumes equal decimals');

// USDC from the Aave faucet.
await wait(await wallet.writeContract({ address: aave.faucet, abi: parseAbi(['function mint(address,address,uint256) returns (uint256)']), functionName: 'mint', args: [usdc, wallet.account.address, LIQ] }));
await wait(await wallet.writeContract({ address: usdc, abi: erc20, functionName: 'approve', args: [uni.positionManager, LIQ] }));

const usdcIsToken1 = BigInt(wamusd) < BigInt(usdc);
const [token0, token1] = usdcIsToken1 ? [wamusd, usdc] : [usdc, wamusd];
const npm = parseAbi([
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)',
  'struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }',
  'function mint(MintParams) payable returns (uint256,uint128,uint256,uint256)',
]);
const Q96 = 1n << 96n; // 1:1 at equal decimals
const create = await wallet.writeContract({ address: uni.positionManager, abi: npm, functionName: 'createAndInitializePoolIfNecessary', args: [token0, token1, FEE, Q96] });
await wait(create);
const factory = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const pool = (await pub.readContract({ address: uni.factory, abi: factory, functionName: 'getPool', args: [token0, token1, FEE] })) as Address;
// USDC-only range adjacent to the current tick on the side a wAMUSD → USDC swap moves into.
const width = 2 * SPACING[FEE]!;
const [tickLower, tickUpper] = usdcIsToken1 ? [-width, 0] : [0, width];
const mintTx = await wallet.writeContract({
  address: uni.positionManager, abi: npm, functionName: 'mint',
  args: [{ token0, token1, fee: FEE, tickLower, tickUpper, amount0Desired: usdcIsToken1 ? 0n : LIQ, amount1Desired: usdcIsToken1 ? LIQ : 0n, amount0Min: 0n, amount1Min: 0n, recipient: wallet.account.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 900) }],
});
await wait(mintTx);
m.evm.assets.aaveUSDC ??= { address: usdc, decimals: Number(d1), note: 'Aave v3 Sepolia listed test USDC (faucet); read from the pool reserves' };
m.evm.pools = { ...(m.evm.pools ?? {}), uniswapV3WamusdUsdc: { pool, fee: FEE, token0, token1, createTx: create, liquidityTx: mintTx, tickLower, tickUpper, note: 'demo pool: one-sided Aave faucet USDC just below 1:1; wAMUSD → USDC only' } };
writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
console.log(JSON.stringify(m.evm.pools.uniswapV3WamusdUsdc, null, 2));
