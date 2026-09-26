/**
 * Creates the project Cetus CLMM pool Pool<AMUSD, AMSUI> on Sui testnet (1:1 nominal, full range)
 * with pool_creator::create_pool_v3 and records it in deployments/testnet.json. Protocol objects are
 * read from the manifest. Needs AMANE_SUI_KEY (a funded testnet suiprivkey; gas only).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestPath = resolve(root, 'deployments/testnet.json');
const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
const key = process.env.AMANE_SUI_KEY;
if (!key) throw new Error('BLOCKED_ENV: AMANE_SUI_KEY is required');
const signer = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(key).secretKey);
const client = new SuiGrpcClient({ network: 'testnet', baseUrl: process.env.SUI_GRPC_URL ?? 'https://fullnode.testnet.sui.io:443' });
const cetus = m.sui.protocols.cetusClmm;
const TICK_SPACING = Number(process.env.AMANE_CETUS_TICK_SPACING ?? 60);
const LIQ = BigInt(process.env.AMANE_POOL_LIQUIDITY ?? 100_000);
const MAX_TICK = 443636; // Cetus tick_math bound

if (m.sui.pools?.cetusAmusdAmsui) {
  console.log(JSON.stringify(m.sui.pools.cetusAmusdAmsui, null, 2));
  process.exit(0);
}
const tokens = m.sui.tokens;
// Cetus requires the first coin type to sort after the second by type-name bytes.
const [A, B] = [tokens.AMUSD, tokens.AMSUI].sort((x: { coinType: string }, y: { coinType: string }) => (x.coinType.split('::').slice(1).join('::') > y.coinType.split('::').slice(1).join('::') ? -1 : 1));
const modOf = (t: { coinType: string }) => t.coinType.split('::')[1]!;

// sqrt(price) in Q64.64, price = raw B per raw A at equal nominal value = 10^(decB - decA).
const d = B.decimals - A.decimals;
const Q128 = 1n << 128n;
const sqrtPrice = d >= 0 ? isqrt(10n ** BigInt(d) * Q128) : isqrt(Q128 / 10n ** BigInt(-d));
const hi = Math.floor(MAX_TICK / TICK_SPACING) * TICK_SPACING;
const u32 = (i: number) => (i < 0 ? 2 ** 32 + i : i);

const tx = new Transaction();
const coinA = tx.moveCall({ target: `${tokens.packageId}::${modOf(A)}::mint`, arguments: [tx.object(A.faucet), tx.pure.u64(LIQ * 10n ** BigInt(A.decimals))] });
// A's amount is fixed; B is supplied with a buffer because rounding at the initial price can ask for
// slightly more than the nominal equivalent. Unused B comes back as `restB`.
const coinB = tx.moveCall({ target: `${tokens.packageId}::${modOf(B)}::mint`, arguments: [tx.object(B.faucet), tx.pure.u64(2n * LIQ * 10n ** BigInt(B.decimals))] });
const [position, restA, restB] = tx.moveCall({
  target: `${cetus.package}::pool_creator::create_pool_v3`,
  typeArguments: [A.coinType, B.coinType],
  arguments: [tx.object(cetus.globalConfig), tx.object(cetus.pools), tx.pure.u32(TICK_SPACING), tx.pure.u128(sqrtPrice), tx.pure.string(''), tx.pure.u32(u32(-hi)), tx.pure.u32(u32(hi)), coinA, coinB, tx.pure.bool(true), tx.object('0x6')],
});
tx.transferObjects([position!, restA!, restB!], signer.toSuiAddress());
const res = await client.signAndExecuteTransaction({ transaction: tx, signer, include: { effects: true, objectTypes: true } });
const done = res.Transaction ?? res.FailedTransaction;
if (!res.Transaction) throw new Error(`pool creation failed: ${JSON.stringify(done?.status)} ${done?.digest}`);
await client.waitForTransaction({ digest: done!.digest });
const pool = done!.effects!.changedObjects.find((o) => o.idOperation === 'Created' && /::pool::Pool</.test(done!.objectTypes?.[o.objectId] ?? ''));
if (!pool) throw new Error('pool object not found in effects');
m.sui.pools = { ...(m.sui.pools ?? {}), cetusAmusdAmsui: { pool: pool.objectId, coinA: A.coinType, coinB: B.coinType, tickSpacing: TICK_SPACING, createTx: done!.digest, note: 'project pool, 1:1 nominal, full range; demo liquidity only' } };
writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
console.log(JSON.stringify(m.sui.pools.cetusAmusdAmsui, null, 2));

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) [x, y] = [y, (y + n / y) / 2n];
  return x;
}
