import { parseAbi, type Address, type PublicClient } from "viem";
import type { MonitorSpec } from "../monitor.js";
import type { DataObservation } from "../observation.js";

export interface AavePosition {
  healthFactor: number;
  collateralBase: bigint;
  debtBase: bigint;
  /** basis points */
  liquidationThreshold: bigint;
  /** price of the repay asset in the pool's base currency */
  assetPriceBase: bigint;
  assetDecimals: number;
}

const POOL = parseAbi(["function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"]);
const ORACLE = parseAbi(["function getAssetPrice(address) view returns (uint256)"]);
const ERC20 = parseAbi(["function decimals() view returns (uint8)"]);
const MAX_UINT = (1n << 256n) - 1n;

export interface AaveHealthMonitorConfig {
  id: string;
  client: PublicClient;
  pool: Address;
  oracle: Address;
  user: Address;
  /** Asset REPAY would spend; its oracle price sizes the repayment. */
  asset: Address;
  op: "LT" | "GT";
  threshold: number;
  maxAgeMs: number;
  chain: string;
}

/** Reads the position straight from the Aave pool; the observation's time is the block's. */
export async function readAavePosition(c: Pick<AaveHealthMonitorConfig, "client" | "pool" | "oracle" | "user" | "asset">): Promise<{ position: AavePosition; blockNumber: bigint; blockTime: number }> {
  const block = await c.client.getBlock();
  const [data, price, dec] = await Promise.all([
    c.client.readContract({ address: c.pool, abi: POOL, functionName: "getUserAccountData", args: [c.user], blockNumber: block.number }),
    c.client.readContract({ address: c.oracle, abi: ORACLE, functionName: "getAssetPrice", args: [c.asset], blockNumber: block.number }),
    c.client.readContract({ address: c.asset, abi: ERC20, functionName: "decimals" }),
  ]);
  const [collateralBase, debtBase, , liquidationThreshold, , hf] = data;
  return {
    position: { healthFactor: hf === MAX_UINT ? Number.POSITIVE_INFINITY : Number(hf) / 1e18, collateralBase, debtBase, liquidationThreshold, assetPriceBase: price, assetDecimals: Number(dec) },
    blockNumber: block.number,
    blockTime: Number(block.timestamp) * 1000,
  };
}

/** Health-factor monitor: TRIGGER when the condition holds, CLEAR (re-arm) when it no longer does. */
export function aaveHealthMonitor(c: AaveHealthMonitorConfig): MonitorSpec {
  return {
    id: c.id,
    requiredTrust: "RPC_DIRECT",
    async observe() {
      const { position, blockNumber, blockTime } = await readAavePosition(c);
      const o: DataObservation<AavePosition> = { id: `${c.id}:${blockNumber}`, adapterId: "aave-v3", chain: c.chain, subject: c.user, kind: "HEALTH_FACTOR", value: position, observedAt: blockTime, blockRef: blockNumber.toString(), freshnessMs: c.maxAgeMs, trust: "RPC_DIRECT" };
      return [o];
    },
    evaluate(obs) {
      const p = obs[0]!.value as AavePosition;
      const holds = p.debtBase > 0n && (c.op === "LT" ? p.healthFactor < c.threshold : p.healthFactor > c.threshold);
      const key = `${c.id}:${c.op}:${c.threshold}`;
      return [holds ? { kind: "HEALTH_FACTOR_BREACH", key, data: { healthFactor: p.healthFactor, threshold: c.threshold } } : { kind: "CLEAR", key, data: {} }];
    },
  };
}
