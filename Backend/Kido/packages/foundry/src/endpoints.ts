import { keccak256, toHex } from "viem";
import type { Action, ChainId, KidoAgentBlueprint } from "@kido/blueprint";
import { ActionKind, evmAssetId, suiAdapterId, suiAssetId, type AmaneDeploymentManifest, type Bytes32 } from "@kido/amane-bridge";
import { CHAINS, type ChainFamily, type ChainProfile, type ProviderRegistry } from "@kido/registry";
import type { AuthorityEndpoint } from "@kido/runtime";
import { KIDO_DEFAULTS } from "@kido/design-interview";

/** "0.9999" → 9999/10000, exactly. */
function ratio(s: string): { num: bigint; den: bigint } {
  const [i, f = ""] = s.split(".");
  return { num: BigInt(i! + f), den: 10n ** BigInt(f.length) };
}

/** Per chain family: how Amane identifies assets, adapters and simulation accounts. The manifest is keyed by family too. */
const FAMILY: Record<ChainFamily, {
  assetId: (ref: string) => Bytes32;
  adapters: (m: AmaneDeploymentManifest) => { name: string; version: number; actionKind: string; adapterId: Bytes32 }[];
  simAccount: (seed: Bytes32) => Bytes32;
}> = {
  evm: {
    assetId: (ref) => evmAssetId(ref as `0x${string}`),
    adapters: (m) => m.evm.adapters.map((a) => ({ name: a.name, version: a.version, actionKind: a.actionKind, adapterId: a.adapterId as Bytes32 })),
    // An EVM account id is a left-padded 20-byte address.
    simAccount: (seed) => `0x${"00".repeat(12)}${seed.slice(26)}` as Bytes32,
  },
  sui: {
    assetId: (ref) => suiAssetId(ref),
    adapters: (m) => m.sui.adapters.map((a) => ({
      name: a.name,
      version: a.version,
      actionKind: a.actionKind,
      adapterId: suiAdapterId({ chainRef: m.sui.chainRef, actionKind: ActionKind[a.actionKind as keyof typeof ActionKind], adapterVersion: a.version, adapterName: a.name, witnessType: a.witnessType }),
    })),
    simAccount: (seed) => seed,
  },
};

/**
 * Amane endpoint facts for compiling and simulating authority. With `accounts` it describes real
 * deployed endpoints; without, symbolic accounts derived from the KidoAgentId (simulation only).
 * Every adapter the Amane manifest lists is offered; an action without a shipped adapter is absent.
 */
export function authorityEndpoints(bp: KidoAgentBlueprint, manifest: AmaneDeploymentManifest, reg: ProviderRegistry, accounts: Partial<Record<ChainId, Bytes32>> = {}, chains: ChainProfile[] = CHAINS): AuthorityEndpoint[] {
  return bp.chains.map((chain) => {
    const profile = chains.find((c) => c.chainId === chain);
    if (!profile) throw new Error(`no chain profile for ${chain}`);
    const fam = FAMILY[profile.family];
    const account = accounts[chain] ?? fam.simAccount(keccak256(toHex(`sim:${bp.kidoAgentId}:${chain}`)));
    const assets = Object.fromEntries(reg.assetsOn(chain).map((a) => [a.symbol, { assetId: fam.assetId(a.ref), decimals: a.decimals }]));
    const adapters: AuthorityEndpoint["adapters"] = {};
    for (const a of fam.adapters(manifest)) adapters[a.actionKind as Action] = { adapterId: a.adapterId, adapterName: a.name, adapterVersion: a.version };
    // REPAY needs a core that enforces it (EVM account core v2 per the Amane manifest).
    const coreVersion = Number((manifest[profile.family] as { accountCoreVersion?: number }).accountCoreVersion ?? 1);
    const repayProviders = reg.executors("REPAY", chain).map((p) => p.providerId);
    const debtTokens = Object.fromEntries(
      reg.assetsOn(chain).flatMap((a) => repayProviders.map((p) => a.debtTokens?.[p]).filter(Boolean).slice(0, 1).map((ref) => [a.symbol, fam.assetId(ref!)])),
    );
    return {
      chain,
      family: profile.family,
      chainRef: manifest[profile.family].chainRef as Bytes32,
      account,
      assets,
      adapters,
      recovery: { recipientId: account, label: "owner recovery" },
      debtTokens,
      repay: profile.family === "evm" && coreVersion >= 2 && Boolean(adapters.REPAY),
      repayFloor: ratio(KIDO_DEFAULTS.repayMinReductionPerSpent),
    };
  });
}
