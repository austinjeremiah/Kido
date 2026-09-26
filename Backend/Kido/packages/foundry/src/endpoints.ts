import { keccak256, toHex } from "viem";
import type { ChainId, KidoAgentBlueprint } from "@kido/blueprint";
import { ActionKind, evmAssetId, suiAdapterId, suiAssetId, type AmaneDeploymentManifest, type Bytes32 } from "@kido/amane-bridge";
import type { ProviderRegistry } from "@kido/registry";
import type { AuthorityEndpoint } from "@kido/runtime";

/**
 * Amane endpoint facts for compiling and simulating authority. With `accounts` it describes real
 * deployed endpoints; without, symbolic accounts derived from the KidoAgentId (simulation only).
 * Adapters come from the Amane deployment manifest: an action without a shipped adapter is absent.
 */
export function authorityEndpoints(bp: KidoAgentBlueprint, manifest: AmaneDeploymentManifest, reg: ProviderRegistry, accounts: Partial<Record<ChainId, Bytes32>> = {}): AuthorityEndpoint[] {
  return bp.chains.map((chain) => {
    const account = accounts[chain] ?? (chain === "ethereum-sepolia" ? (`0x${"00".repeat(12)}${keccak256(toHex(`sim:${bp.kidoAgentId}:${chain}`)).slice(26)}` as Bytes32) : keccak256(toHex(`sim:${bp.kidoAgentId}:${chain}`)));
    const assets = Object.fromEntries(
      reg.assetsOn(chain).map((a) => [a.symbol, { assetId: chain === "ethereum-sepolia" ? evmAssetId(a.ref as `0x${string}`) : suiAssetId(a.ref), decimals: a.decimals }]),
    );
    const adapters: AuthorityEndpoint["adapters"] = {};
    if (chain === "ethereum-sepolia") {
      const pay = manifest.evm.adapters.find((x) => x.actionKind === "PAY");
      if (pay) adapters.PAY = { adapterId: pay.adapterId, adapterName: pay.name, adapterVersion: pay.version };
    } else {
      const pay = manifest.sui.adapters.find((x) => x.actionKind === "PAY");
      if (pay) adapters.PAY = { adapterId: suiAdapterId({ chainRef: manifest.sui.chainRef, actionKind: ActionKind.PAY, adapterVersion: pay.version, adapterName: pay.name, witnessType: pay.witnessType }), adapterName: pay.name, adapterVersion: pay.version };
    }
    return {
      chain,
      chainRef: chain === "ethereum-sepolia" ? manifest.evm.chainRef : manifest.sui.chainRef,
      account,
      assets,
      adapters,
      recovery: { recipientId: account, label: "owner recovery" },
    };
  });
}
