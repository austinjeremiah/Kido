import type { ChainId, GateFacts } from "@kido/blueprint";
import { isChainAddress } from "./chains.js";
import { ASSETS } from "./assets.js";
import { PROVIDERS } from "./providers/index.js";
import type { AssetEntry, ProviderKind, ProviderManifest, ProviderStatus } from "./types.js";

export interface SelectionRequest {
  kind: ProviderKind;
  chain: ChainId;
  capabilities: string[];
  /** Statuses acceptable for this use. A live claim needs VERIFIED_LIVE; planning may accept more. */
  acceptStatus: ProviderStatus[];
  /** Audiences the protected value must stay hidden from; providers exposing plaintext to any of them are rejected. */
  hiddenFrom?: string[];
}

export interface Rejection {
  providerId: string;
  reason: string;
}

export interface Selection {
  selected: ProviderManifest[];
  uncovered: string[];
  rejected: Rejection[];
}

const LIVE: ProviderStatus[] = ["VERIFIED_LIVE"];
export const PLANNING: ProviderStatus[] = ["VERIFIED_LIVE", "VERIFIED_DOCS", "UNVERIFIED", "MOCK_ONLY", "BLOCKED_ENV", "NOT_SHIPPED"];
/** Statuses `find` accepts by default: real providers, never mocks or blocked ones. */
export const USABLE: ProviderStatus[] = ["VERIFIED_LIVE", "VERIFIED_DOCS", "UNVERIFIED"];

/**
 * Effective status of one capability: an explicit per-capability status, else NOT_SHIPPED when the
 * capability needs an execution adapter that does not exist yet, else the provider's own status.
 */
export function capabilityStatus(p: ProviderManifest, capability: string): ProviderStatus {
  const explicit = p.capabilityStatus?.[capability]?.status;
  if (explicit) return explicit;
  const exec = (p.execution ?? []).filter((e) => e.capability === capability);
  if (exec.length && !exec.some((e) => e.shipped)) return "NOT_SHIPPED";
  return p.status;
}

function capabilityNote(p: ProviderManifest, capability: string): string {
  const explicit = p.capabilityStatus?.[capability];
  if (explicit) return explicit.note;
  const exec = (p.execution ?? []).find((e) => e.capability === capability && !e.shipped);
  return exec ? `execution adapter ${exec.amaneAdapter ?? exec.adapter} is not shipped` : p.statusNote;
}

/** Plaintext of a protected value reaches one of the audiences it must be hidden from. */
function trustConflict(p: ProviderManifest, hiddenFrom: string[] | undefined): string | undefined {
  if (!hiddenFrom?.length || p.kind !== "privacy") return undefined;
  const visible = p.plaintextVisibleTo;
  if (!visible) return "trust: provider does not declare who can see plaintext";
  if (hiddenFrom.includes("EVERYONE_EXCEPT_APPROVED_ENCLAVE") && visible.length) return `trust: plaintext is visible to ${visible.join(", ")}`;
  const hit = visible.filter((a) => hiddenFrom.includes(a));
  return hit.length ? `trust: plaintext is visible to ${hit.join(", ")}, which the value must be hidden from` : undefined;
}

/**
 * Chain → category → provider → capabilities registry (bible §11). Selection is a pure function of
 * required capabilities; no planner or interview code branches on provider names.
 */
/** Capabilities of `p` whose own (per-capability) status is acceptable for this request. */
function usable(p: ProviderManifest, req: SelectionRequest): string[] {
  return p.capabilities.filter((c) => req.acceptStatus.includes(capabilityStatus(p, c)));
}

function blockedReason(p: ProviderManifest, req: SelectionRequest): string | undefined {
  const hit = req.capabilities.find((c) => p.capabilities.includes(c) && !req.acceptStatus.includes(capabilityStatus(p, c)));
  return hit ? `${hit} is ${capabilityStatus(p, hit)}: ${capabilityNote(p, hit)}` : undefined;
}

export class ProviderRegistry {
  constructor(readonly providers: ProviderManifest[] = PROVIDERS, readonly assets: AssetEntry[] = ASSETS) {
    const ids = new Set<string>();
    for (const p of providers) {
      if (ids.has(p.providerId)) throw new Error(`duplicate provider ${p.providerId}`);
      ids.add(p.providerId);
    }
  }

  /** Registry facts for the blueprint buildability gate. */
  gateFacts(): GateFacts {
    return {
      provider: (id) => this.get(id),
      secretStoreId: this.providers.find((p) => p.kind === "privacy" && p.capabilities.includes("SECRET_STORAGE"))?.providerId,
      isAddress: (chain, address) => isChainAddress(chain, address),
    };
  }

  get(providerId: string): ProviderManifest | undefined {
    return this.providers.find((p) => p.providerId === providerId);
  }

  tree(): Record<string, Record<string, string[]>> {
    const t: Record<string, Record<string, string[]>> = {};
    for (const p of this.providers) for (const c of p.chains) ((t[c] ??= {})[p.category] ??= []).push(p.providerId);
    return t;
  }

  find(kind: ProviderKind, chain: ChainId, capability: string, acceptStatus: ProviderStatus[] = USABLE): ProviderManifest[] {
    return this.providers.filter((p) => p.kind === kind && p.chains.includes(chain) && p.capabilities.includes(capability) && acceptStatus.includes(p.status) && acceptStatus.includes(capabilityStatus(p, capability)));
  }

  /** Semantic actions a provider has an execution mapping for. */
  actionsOf(providerId: string): string[] {
    return [...new Set((this.get(providerId)?.execution ?? []).map((e) => e.action))];
  }

  /** Providers that can execute `action` on `chain`, in registry order. */
  executors(action: string, chain: ChainId): ProviderManifest[] {
    return this.providers.filter((p) => p.chains.includes(chain) && (p.execution ?? []).some((e) => e.action === action));
  }

  /** Assets a provider's actions can spend, optionally on one chain. */
  assetsFor(providerId: string, chain?: ChainId): AssetEntry[] {
    return this.assets.filter((a) => a.usableWith.includes(providerId) && (!chain || a.chain === chain));
  }

  /** Token decimals by symbol; undefined when the symbol is unknown or ambiguous across chains. */
  decimalsOf(symbol: string): number | undefined {
    const ds = new Set(this.assets.filter((a) => a.symbol === symbol).map((a) => a.decimals));
    return ds.size === 1 ? [...ds][0] : undefined;
  }

  chainsFor(providerId: string): ChainId[] {
    return this.get(providerId)?.chains ?? [];
  }

  assetsOn(chain: ChainId): AssetEntry[] {
    return this.assets.filter((a) => a.chain === chain);
  }

  /** Smallest provider set covering the requested capabilities (greedy set cover), with every rejection explained. */
  select(req: SelectionRequest): Selection {
    const rejected: Rejection[] = [];
    const candidates = this.providers.filter((p) => {
      if (p.kind !== req.kind) return false;
      if (!p.chains.includes(req.chain)) return (rejected.push({ providerId: p.providerId, reason: `not available on ${req.chain}` }), false);
      if (!req.acceptStatus.includes(p.status)) return (rejected.push({ providerId: p.providerId, reason: `status ${p.status}: ${p.statusNote}` }), false);
      const trust = trustConflict(p, req.hiddenFrom);
      if (trust) return (rejected.push({ providerId: p.providerId, reason: trust }), false);
      if (!usable(p, req).some((c) => req.capabilities.includes(c))) return (rejected.push({ providerId: p.providerId, reason: blockedReason(p, req) ?? "no required capability" }), false);
      return true;
    });
    const need = new Set(req.capabilities);
    const selected: ProviderManifest[] = [];
    while (need.size > 0) {
      let best: ProviderManifest | undefined;
      let bestCover = 0;
      for (const p of candidates) {
        if (selected.includes(p)) continue;
        const cover = usable(p, req).filter((c) => need.has(c)).length;
        if (cover > bestCover) [best, bestCover] = [p, cover];
      }
      if (!best) break;
      selected.push(best);
      for (const c of usable(best, req)) need.delete(c);
    }
    for (const p of candidates) if (!selected.includes(p)) rejected.push({ providerId: p.providerId, reason: "not needed: a smaller set already covers the requirement" });
    return { selected, uncovered: [...need], rejected };
  }

  /** Live for the provider as a whole, or for one capability when given. */
  isLive(providerId: string, capability?: string): boolean {
    const p = this.get(providerId);
    if (!p) return false;
    return LIVE.includes(p.status) && (!capability || (p.capabilities.includes(capability) && LIVE.includes(capabilityStatus(p, capability))));
  }
}
