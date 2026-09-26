/**
 * Amane v2 EVM release on Sepolia: deploys and registers the Aave v3 repay and Uniswap v3 swap
 * adapters in the existing append-only AdapterRegistry, deploys the AMDAI demo token, creates a
 * project AMUSD/AMDAI Uniswap v3 pool with full-range liquidity, and records everything in
 * deployments/testnet.json. Protocol addresses are read from the manifest. v1 entries are untouched.
 * Needs SEPOLIA_RPC_URL and FUNDER_PRIVATE_KEY (gas only; it gains no authority over any account).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { aaveV3RepayAdapterAbi, aaveV3RepayAdapterBytecode, adapterRegistryAbi, amaneTestTokenAbi, amaneTestTokenBytecode, uniswapV3SwapAdapterAbi, uniswapV3SwapAdapterBytecode } from '../src/evm-artifacts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestPath = resolve(root, 'deployments/testnet.json');
const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
const rpc = process.env.SEPOLIA_RPC_URL;
const pk = process.env.FUNDER_PRIVATE_KEY as Hex | undefined;
if (!rpc || !pk) throw new Error('BLOCKED_ENV: SEPOLIA_RPC_URL and FUNDER_PRIVATE_KEY are required');
const FEE = Number(process.env.AMANE_UNISWAP_FEE ?? 3000);
const TICK_SPACING: Record<number, number> = { 500: 10, 3000: 60, 10000: 200 };
const LIQ_UNITS = BigInt(process.env.AMANE_POOL_LIQUIDITY ?? 100_000); // whole tokens per side

const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
const wallet = createWalletClient({ chain: sepolia, transport: http(rpc), account });
const wait = async (hash: Hex) => {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`tx failed ${hash}`);
  return r;
};
const deploy = async (abi: readonly unknown[], bytecode: Hex, args: unknown[]) => (await wait(await wallet.deployContract({ abi: abi as never, bytecode, args: args as never }))).contractAddress!;

async function register(adapter: Address): Promise<Hex> {
  const r = await wait(await wallet.writeContract({ address: m.evm.adapterRegistry, abi: adapterRegistryAbi, functionName: 'register', args: [adapter] }));
  for (const log of r.logs) {
    try {
      const ev = decodeEventLog({ abi: adapterRegistryAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'AdapterRegistered') return (ev.args as { adapterId: Hex }).adapterId;
    } catch {}
  }
  throw new Error('AdapterRegistered event not found');
}

const has = (name: string) => m.evm.adapters.some((a: { name: string }) => a.name === name);
const out: Record<string, unknown> = {};

if (!has('Aave V3 Repay')) {
  const addr = await deploy(aaveV3RepayAdapterAbi, aaveV3RepayAdapterBytecode, [m.evm.protocols.aaveV3.pool]);
  m.evm.adapters.push({ name: 'Aave V3 Repay', version: 1, actionKind: 'REPAY', address: addr, adapterId: await register(addr), requiresCoreVersion: 2, upstream: { protocol: 'aaveV3', pool: m.evm.protocols.aaveV3.pool, interestRateMode: 2 } });
}
if (!has('Uniswap V3 Swap')) {
  const addr = await deploy(uniswapV3SwapAdapterAbi, uniswapV3SwapAdapterBytecode, [m.evm.protocols.uniswapV3.swapRouter02, FEE]);
  m.evm.adapters.push({ name: 'Uniswap V3 Swap', version: 1, actionKind: 'SWAP', address: addr, adapterId: await register(addr), upstream: { protocol: 'uniswapV3', router: m.evm.protocols.uniswapV3.swapRouter02, fee: FEE } });
}

if (!m.evm.assets.AMDAI) {
  const addr = await deploy(amaneTestTokenAbi, amaneTestTokenBytecode, ['Amane Test DAI', 'AMDAI', 18]);
  m.evm.assets.AMDAI = { address: addr, decimals: 18, testnetOnly: true, mint: 'open' };
}

// Project pool AMUSD/AMDAI at 1:1 nominal value, full range.
if (!m.evm.pools?.uniswapV3AmusdAmdai) {
  const usd = m.evm.assets.AMUSD, dai = m.evm.assets.AMDAI;
  const [t0, t1] = BigInt(usd.address) < BigInt(dai.address) ? [usd, dai] : [dai, usd];
  const factoryAbi = parseAbi(['function createPool(address,address,uint24) returns (address)', 'function getPool(address,address,uint24) view returns (address)']);
  const poolAbi = parseAbi(['function initialize(uint160)', 'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)']);
  const npmAbi = parseAbi(['struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }', 'function mint(MintParams) payable returns (uint256,uint128,uint256,uint256)']);
  const tokAbi = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256) returns (bool)']);
  let pool = (await pub.readContract({ address: m.evm.protocols.uniswapV3.factory, abi: factoryAbi, functionName: 'getPool', args: [t0.address, t1.address, FEE] })) as Address;
  if (pool === '0x0000000000000000000000000000000000000000') {
    await wait(await wallet.writeContract({ address: m.evm.protocols.uniswapV3.factory, abi: factoryAbi, functionName: 'createPool', args: [t0.address, t1.address, FEE] }));
    pool = (await pub.readContract({ address: m.evm.protocols.uniswapV3.factory, abi: factoryAbi, functionName: 'getPool', args: [t0.address, t1.address, FEE] })) as Address;
  }
  const [sqrt] = (await pub.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' })) as readonly [bigint];
  if (sqrt === 0n) {
    // price = raw token1 per raw token0 at equal nominal value = 10^(d1 - d0); sqrtPriceX96 = sqrt(price) * 2^96
    const d = t1.decimals - t0.decimals;
    const Q192 = 1n << 192n;
    const sqrtPriceX96 = d >= 0 ? sqrtBig(10n ** BigInt(d) * Q192) : sqrtBig(Q192 / 10n ** BigInt(-d));
    await wait(await wallet.writeContract({ address: pool, abi: poolAbi, functionName: 'initialize', args: [sqrtPriceX96] }));
  }
  const a0 = LIQ_UNITS * 10n ** BigInt(t0.decimals), a1 = LIQ_UNITS * 10n ** BigInt(t1.decimals);
  for (const [t, amt] of [[t0, a0], [t1, a1]] as const) {
    await wait(await wallet.writeContract({ address: t.address, abi: tokAbi, functionName: 'mint', args: [account.address, amt] }));
    await wait(await wallet.writeContract({ address: t.address, abi: tokAbi, functionName: 'approve', args: [m.evm.protocols.uniswapV3.positionManager, amt] }));
  }
  const spacing = TICK_SPACING[FEE]!;
  const maxTick = Math.floor(887272 / spacing) * spacing;
  const mintTx = await wallet.writeContract({
    address: m.evm.protocols.uniswapV3.positionManager, abi: npmAbi, functionName: 'mint',
    args: [{ token0: t0.address, token1: t1.address, fee: FEE, tickLower: -maxTick, tickUpper: maxTick, amount0Desired: a0, amount1Desired: a1, amount0Min: 0n, amount1Min: 0n, recipient: account.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) }],
  });
  await wait(mintTx);
  m.evm.pools = { ...(m.evm.pools ?? {}), uniswapV3AmusdAmdai: { pool, fee: FEE, token0: t0.address, token1: t1.address, liquidityTx: mintTx, note: 'project pool, 1:1 nominal, full range; demo liquidity only' } };
}

m.evm.accountCoreVersion = 2;
m.evm.releases = { v1: { sourceCommit: m.sourceCommit, actions: ['SWAP', 'PAY'], status: 'frozen; deployed accounts unchanged' }, v2: { actions: ['SWAP', 'PAY', 'REPAY'], note: 'new accounts deploy CORE_VERSION 2 bytecode from the SDK' } };
writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
out.adapters = m.evm.adapters.map((a: { name: string; address: string; adapterId: string }) => `${a.name} ${a.address} ${a.adapterId}`);
out.AMDAI = m.evm.assets.AMDAI.address;
out.pool = m.evm.pools.uniswapV3AmusdAmdai;
console.log(JSON.stringify(out, null, 2));

function sqrtBig(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) [x, y] = [y, (y + n / y) / 2n];
  return x;
}
