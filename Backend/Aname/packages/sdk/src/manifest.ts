import { readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';

export interface AmaneDeploymentManifest {
  schemaVersion: 'amane.deployment/v1';
  environment: 'testnet';
  sourceCommit: string;
  evm: {
    chainId: number;
    chainRef: Hex;
    adapterRegistry: Address;
    assets: Record<string, { address: Address; decimals: number }>;
    adapters: { name: string; version: number; actionKind: string; address: Address; adapterId: Hex }[];
  };
  sui: {
    chainIdentifier: string;
    chainRef: Hex;
    packageId: string;
    upgradeAuthority: 'FROZEN' | string;
    tokens: { packageId: string } & Record<string, { coinType: string; decimals: number; faucet: string } | string>;
    adapters: { name: string; version: number; actionKind: string; witnessType: string; native?: boolean }[];
  };
}

export function loadManifest(path: string): AmaneDeploymentManifest {
  const m = JSON.parse(readFileSync(path, 'utf8')) as AmaneDeploymentManifest;
  if (m.schemaVersion !== 'amane.deployment/v1') throw new Error(`unsupported manifest ${m.schemaVersion}`);
  return m;
}
