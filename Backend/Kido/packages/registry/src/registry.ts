import type { ChainId } from "@kido/blueprint";
import { ASSETS } from "./assets.js";
import { PROVIDERS } from "./providers/index.js";
import type { AssetEntry, ProviderKind, ProviderManifest, ProviderStatus } from "./types.js";

export interface SelectionRequest {
  kind: ProviderKind;
  chain: ChainId;
  capabilities: string[];
  /** Statuses acceptable for this use. A live claim needs VERIFIED_LIVE; planning may accept more. */
  acceptStatus: ProviderStatus[];
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
export const PLANNING: ProviderStatus[] = ["VERIFIED_LIVE", "VERIFIED_DOCS", "UNVERIFIED", "MOCK_ONLY", "BLOCKED_ENV"];

/**
 * Chain → category → provider → capabilities registry (bible §11). Selection is a pure function of
 * required capabilities; no planner or interview code branches on provider names.
 */
export class ProviderRegistry {
  constructor(readonly providers: ProviderManifest[] = PROVIDERS, readonly assets: AssetEntry[] = ASSETS) {
    const ids = new Set<string>();
    for (const p of providers) {
      if (ids.has(p.providerId)) throw new Error(`duplicate provider ${p.providerId}`);
      ids.add(p.providerId);
    }
  }

  get(providerId: string): ProviderManifest | undefined {
    return this.providers.find((p) => p.providerId === providerId);
  }

  tree(): Record<string, Record<string, string[]>> {
    const t: Record<string, Record<string, string[]>> = {};
    for (const p of this.providers) for (const c of p.chains) ((t[c] ??= {})[p.category] ??= []).push(p.providerId);
    return t;
  }

  find(kind: ProviderKind, chain: ChainId, capability: string): ProviderManifest[] {
    return this.providers.filter((p) => p.kind === kind && p.chains.includes(chain) && p.capabilities.includes(capability));
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
      if (!p.capabilities.some((c) => req.capabilities.includes(c))) return (rejected.push({ providerId: p.providerId, reason: "no required capability" }), false);
      return true;
    });
    const need = new Set(req.capabilities);
    const selected: ProviderManifest[] = [];
    while (need.size > 0) {
      let best: ProviderManifest | undefined;
      let bestCover = 0;
      for (const p of candidates) {
        if (selected.includes(p)) continue;
        const cover = p.capabilities.filter((c) => need.has(c)).length;
        if (cover > bestCover) [best, bestCover] = [p, cover];
      }
      if (!best) break;
      selected.push(best);
      for (const c of best.capabilities) need.delete(c);
    }
    for (const p of candidates) if (!selected.includes(p)) rejected.push({ providerId: p.providerId, reason: "not needed: a smaller set already covers the requirement" });
    return { selected, uncovered: [...need], rejected };
  }

  isLive(providerId: string): boolean {
    return LIVE.includes(this.get(providerId)?.status ?? "UNVERIFIED");
  }
}
