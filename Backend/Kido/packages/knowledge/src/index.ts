import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderRegistry } from "@kido/registry";

export interface PackManifest {
  schemaVersion: "kido.knowledge-pack/v1";
  pack: string;
  providerId: string | null;
  displayName: string;
  version: string;
  researchDate: string;
  status: string;
  statusNote: string;
  chains: string[];
  sdk: { package: string; version: string }[];
  capabilities: string[];
  deployments: Record<string, Record<string, string>>;
  limitations: string[];
  failureModes: string[];
  sources: { url: string; retrieved: string }[];
  execution: { action: string; adapter: string; amaneAdapter: string | null; shipped: boolean }[];
}

export interface KnowledgePack {
  id: string;
  manifest: PackManifest;
  facts: string;
}

export interface DriftIssue {
  pack: string;
  expected: string;
  found: string;
  source: "registry" | "adapter";
  securityRelevant: boolean;
}

export const DEFAULT_KNOWLEDGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../knowledge");

/**
 * Platform Knowledge System (bible §12): verified, versioned packs, loaded per role. Knowledge is
 * context for reasoning only; nothing here grants or implies authority.
 */
export class KnowledgeBase {
  private constructor(readonly packs: Map<string, KnowledgePack>) {}

  static load(dir: string = DEFAULT_KNOWLEDGE_DIR): KnowledgeBase {
    const packs = new Map<string, KnowledgePack>();
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name === "manifest.json") {
          const manifest = JSON.parse(readFileSync(p, "utf8")) as PackManifest;
          const factsPath = join(d, "facts.md");
          packs.set(manifest.pack, { id: manifest.pack, manifest, facts: existsSync(factsPath) ? readFileSync(factsPath, "utf8") : "" });
        }
      }
    };
    walk(dir);
    return new KnowledgeBase(packs);
  }

  get(id: string): KnowledgePack | undefined {
    return this.packs.get(id);
  }

  /** Role-scoped context: only the requested packs, in order, bounded in size. Missing packs are named, not invented. */
  contextFor(ids: string[], maxChars = 24_000): { text: string; included: string[]; missing: string[]; truncated: boolean } {
    const included: string[] = [], missing: string[] = [];
    let text = "", truncated = false;
    for (const id of [...new Set(ids)]) {
      const p = this.packs.get(id);
      if (!p) {
        missing.push(id);
        continue;
      }
      const header = `\n\n=== KNOWLEDGE PACK ${id} (version ${p.manifest.version}, verified ${p.manifest.researchDate}, status ${p.manifest.status}) ===\n`;
      const chunk = header + p.facts;
      if (text.length + chunk.length > maxChars) {
        text += `${header}[truncated: pack exceeds the context budget; ask for it specifically]`;
        truncated = true;
      } else text += chunk;
      included.push(id);
    }
    if (missing.length) text += `\n\n=== MISSING KNOWLEDGE: ${missing.join(", ")} — treat as unknown ===`;
    return { text: text.trim(), included, missing, truncated };
  }

  /** Bible §12.3: pack ↔ registry ↔ adapter versions. A security-relevant mismatch must fail closed. */
  drift(registry: ProviderRegistry, adapterVersions: Record<string, string> = {}): DriftIssue[] {
    const out: DriftIssue[] = [];
    for (const p of registry.providers) {
      const pack = this.packs.get(p.knowledgePack);
      if (!pack || pack.manifest.providerId !== p.providerId) continue;
      if (pack.manifest.version !== p.version) out.push({ pack: pack.id, expected: p.version, found: pack.manifest.version, source: "registry", securityRelevant: p.kind !== "identity" });
      const a = adapterVersions[p.providerId];
      if (a !== undefined && a !== p.version) out.push({ pack: pack.id, expected: p.version, found: a, source: "adapter", securityRelevant: true });
    }
    return out;
  }
}

export class KnowledgeDriftError extends Error {
  constructor(readonly issues: DriftIssue[]) {
    super(`KNOWLEDGE_DRIFT: ${issues.map((i) => `${i.pack} expected ${i.expected} found ${i.found} (${i.source})`).join("; ")}`);
    this.name = "KnowledgeDriftError";
  }
}

/** Fail closed on security-relevant drift (adapters refuse to execute; the agent reports KNOWLEDGE_DRIFT). */
export function assertNoSecurityDrift(issues: DriftIssue[]): void {
  const bad = issues.filter((i) => i.securityRelevant);
  if (bad.length) throw new KnowledgeDriftError(bad);
}
