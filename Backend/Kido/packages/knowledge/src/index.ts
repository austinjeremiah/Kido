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
  source: "registry" | "adapter" | "deployment" | "missing";
  securityRelevant: boolean;
}

export const DEFAULT_KNOWLEDGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../knowledge");

/**
 * Platform Knowledge System (bible §12): verified, versioned packs, loaded per role. Knowledge is
 * context for reasoning only; nothing here grants or implies authority.
 */
/** Credential shapes that must never reach a model context. A pack containing one is quarantined. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  /\bsuiprivkey1[0-9a-z]{20,}/,
  /\b(?:private|deployer|secret|signing)[ _-]?key\b\W{0,5}(?:0x)?[0-9a-fA-F]{64}\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export class KnowledgeBase {
  private constructor(readonly packs: Map<string, KnowledgePack>, readonly quarantined: string[] = []) {}

  static load(dir: string = DEFAULT_KNOWLEDGE_DIR): KnowledgeBase {
    const packs = new Map<string, KnowledgePack>();
    const quarantined: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name === "manifest.json") {
          const raw = readFileSync(p, "utf8");
          const manifest = JSON.parse(raw) as PackManifest;
          const factsPath = join(d, "facts.md");
          const facts = existsSync(factsPath) ? readFileSync(factsPath, "utf8") : "";
          // Knowledge packs hold public information only; a credential-bearing pack is never served. (BREAK F-0532)
          if (containsSecret(raw) || containsSecret(facts)) quarantined.push(manifest.pack);
          else packs.set(manifest.pack, { id: manifest.pack, manifest, facts });
        }
      }
    };
    walk(dir);
    return new KnowledgeBase(packs, quarantined);
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
    const q = missing.filter((id) => this.quarantined.includes(id));
    if (q.length) text += `\n=== QUARANTINED (secret-like content): ${q.join(", ")} ===`;
    return { text: text.trim(), included, missing, truncated };
  }

  /** Bible §12.3: pack ↔ registry ↔ adapter versions. A security-relevant mismatch must fail closed. */
  drift(registry: ProviderRegistry, adapterVersions: Record<string, string> = {}): DriftIssue[] {
    const out: DriftIssue[] = [];
    for (const p of registry.providers) {
      const securityRelevant = p.kind !== "identity";
      const a = adapterVersions[p.providerId];
      if (a !== undefined && a !== p.version) out.push({ pack: p.knowledgePack, expected: p.version, found: a, source: "adapter", securityRelevant: true });
      const pack = this.packs.get(p.knowledgePack);
      if (!pack) {
        out.push({ pack: p.knowledgePack, expected: p.version, found: this.quarantined.includes(p.knowledgePack) ? "quarantined" : "missing", source: "missing", securityRelevant: false });
        continue;
      }
      // Packs shared by several providers (platform packs) carry no provider id; a pack naming another provider is drift.
      if (pack.manifest.providerId !== null && pack.manifest.providerId !== p.providerId) {
        if (registry.get(pack.manifest.providerId)?.knowledgePack === pack.id) continue;
        out.push({ pack: pack.id, expected: p.providerId, found: pack.manifest.providerId, source: "registry", securityRelevant });
        continue;
      }
      if (pack.manifest.providerId === null && registry.providers.filter((x) => x.knowledgePack === pack.id).length > 1) continue;
      if (pack.manifest.version !== p.version) out.push({ pack: pack.id, expected: p.version, found: pack.manifest.version, source: "registry", securityRelevant });
      for (const [chain, entries] of Object.entries(pack.manifest.deployments ?? {})) {
        const reg = (p.deployments as Record<string, Record<string, string>>)[chain] ?? {};
        for (const [k, v] of Object.entries(entries)) {
          if (reg[k]?.toLowerCase() !== v.toLowerCase()) out.push({ pack: pack.id, expected: `${chain}.${k}=${reg[k] ?? "absent"}`, found: v, source: "deployment", securityRelevant: true });
        }
      }
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
