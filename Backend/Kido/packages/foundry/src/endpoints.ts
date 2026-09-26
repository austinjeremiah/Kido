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

type SuiAdapterEntry = { name: string; version: number; actionKind: string; witnessType: string; core?: string; native?: boolean };

/**
 * The Amane Sui core release an account should be created on: the newest release in the manifest
 * whose actions cover what the agent needs (v5 adds BRIDGE), else the base package. Adapters are
 * bound to one core's Account type, so only that core's adapters are offered; a native adapter of
 * the base package (Transfer Pay) is the same module inside the newer core.
 */
export function suiCore(manifest: AmaneDeploymentManifest, actions: readonly string[] = []): { core: string | null; packageId: string } {
  const m = manifest as unknown as { sui: { packageId: string; releases?: Record<string, { packageId: string; actions?: string[] }> } };
  const releases = Object.entries(m.sui.releases ?? {}).sort(([a], [b]) => Number(b.replace(/\D/g, "")) - Number(a.replace(/\D/g, "")));
  const fit = releases.find(([, r]) => actions.every((x) => (r.actions ?? []).includes(x))) ?? (actions.length ? undefined : releases[0]);
  return fit ? { core: fit[0], packageId: fit[1].packageId } : { core: null, packageId: m.sui.packageId };
}

function suiAdapters(manifest: AmaneDeploymentManifest, core: string | null): SuiAdapterEntry[] {
  const m = manifest as unknown as { sui: { packageId: string; adapters: SuiAdapterEntry[] } };
  const own = m.sui.adapters.filter((a) => (a.core ?? null) === core);
  if (core === null) return own;
  const corePkg = (manifest as unknown as { sui: { releases: Record<string, { packageId: string }> } }).sui.releases[core]!.packageId;
  const natives = m.sui.adapters
    .filter((a) => !a.core && a.native && !own.some((o) => o.actionKind === a.actionKind))
    .map((a) => ({ ...a, core, witnessType: `${corePkg}${a.witnessType.slice(a.witnessType.indexOf("::"))}` }));
  return [...own, ...natives];
}

/** The actions routed on a Sui chain that some Amane Sui core can enforce; they pick the core release. */
export function suiActionsFor(bp: KidoAgentBlueprint, manifest: AmaneDeploymentManifest, chain: ChainId): string[] {
  const routed = bp.authority.allowedActions.filter((a) => bp.actions.some((r) => r.action === a && r.chain === chain));
  return routed.filter((a) => suiCore(manifest, [a]).core !== null || suiAdapters(manifest, null).some((x) => x.actionKind === a));
}

/** The Sui core package a blueprint's account on `chain` must be created on. */
export function suiCoreFor(bp: KidoAgentBlueprint, manifest: AmaneDeploymentManifest, chain: ChainId): string {
  return suiCore(manifest, suiActionsFor(bp, manifest, chain)).packageId;
}

/** Per chain family: how Amane identifies assets, adapters and simulation accounts. The manifest is keyed by family too. */
const FAMILY: Record<ChainFamily, {
  assetId: (ref: string) => Bytes32;
  adapters: (m: AmaneDeploymentManifest, actions: readonly string[]) => { name: string; version: number; actionKind: string; adapterId: Bytes32 }[];
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
    adapters: (m, actions) => suiAdapters(m, suiCore(m, actions).core).map((a) => ({
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
export function authorityEndpoints(bp: KidoAgentBlueprint, manifest: AmaneDeploymentManifest, reg: ProviderRegistry, accounts: Partial<Record<ChainId, Bytes32>> = {}, chains: ChainProfile[] = CHAINS, recovery: Partial<Record<ChainId, Bytes32>> = {}): AuthorityEndpoint[] {
  return bp.chains.map((chain) => {
    const profile = chains.find((c) => c.chainId === chain);
    if (!profile) throw new Error(`no chain profile for ${chain}`);
    const fam = FAMILY[profile.family];
    const account = accounts[chain] ?? fam.simAccount(keccak256(toHex(`sim:${bp.kidoAgentId}:${chain}`)));
    const assets = Object.fromEntries(reg.assetsOn(chain).map((a) => [a.symbol, { assetId: fam.assetId(a.ref), decimals: a.decimals }]));
    // Per action, the adapter the registry names for a provider executing it on this chain.
    const adapters: AuthorityEndpoint["adapters"] = {};
    const wanted = (action: string) => new Set(reg.executors(action, chain).flatMap((p) => (p.execution ?? []).filter((e) => e.action === action).map((e) => e.amaneAdapter)));
    for (const a of fam.adapters(manifest, profile.family === "sui" ? suiActionsFor(bp, manifest, chain) : [])) if (wanted(a.actionKind).has(a.name)) adapters[a.actionKind as Action] = { adapterId: a.adapterId, adapterName: a.name, adapterVersion: a.version };
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
      // Owner recovery goes to the owner's own address when given; simulation falls back to the account.
      recovery: { recipientId: recovery[chain] ?? account, label: "owner recovery" },
      debtTokens,
      repay: profile.family === "evm" && coreVersion >= 2 && Boolean(adapters.REPAY),
      repayFloor: ratio(KIDO_DEFAULTS.repayMinReductionPerSpent),
    };
  });
}
