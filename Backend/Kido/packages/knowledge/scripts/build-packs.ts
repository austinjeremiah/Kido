/// Regenerates provider knowledge packs from the registry manifests and TRACE's verified research.
///   TRACE_DIR=<.gauntlet/research/providers> npx tsx scripts/build-packs.ts
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "@kido/registry";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const traceDir = process.env.TRACE_DIR ?? resolve(root, "../.gauntlet/research/providers");
const KEEP = ["Core concepts", "Supported operations", "Required fields", "Upgrade", "Failure modes", "Limitations", "Common mistakes", "Kido adapter mapping"];
const SECRETISH = /(alchemy\.com\/v2\/|infura\.io\/v3\/|PRIVATE_KEY|MNEMONIC|sk-[A-Za-z0-9]{12,}|--private-key)/i;

function sections(md: string): string {
  const parts = md.split(/^## /m).slice(1);
  const out: string[] = [];
  for (const p of parts) {
    const title = p.split("\n")[0]!.replace(/^\d+\.\s*/, "");
    if (!KEEP.some((k) => title.toLowerCase().startsWith(k.toLowerCase()))) continue;
    const body = p
      .split("\n")
      .slice(1)
      .filter((l) => !SECRETISH.test(l) && !/^\s*(cast|curl|sui client|export |source )/.test(l))
      .join("\n")
      .replace(/```(?:bash|sh|shell)[\s\S]*?```/g, "")
      .trim();
    out.push(`## ${title}\n\n${body}`);
  }
  return out.join("\n\n");
}

for (const p of PROVIDERS) {
  if (p.knowledgePack.startsWith("platform/")) continue;
  const dir = resolve(root, "knowledge", p.knowledgePack);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schemaVersion: "kido.knowledge-pack/v1",
    pack: p.knowledgePack,
    providerId: p.providerId,
    displayName: p.displayName,
    version: p.version,
    researchDate: p.sources[0]?.retrieved ?? "2026-09-26",
    status: p.status,
    statusNote: p.statusNote,
    chains: p.chains,
    sdk: p.sdk,
    capabilities: p.capabilities,
    deployments: p.deployments,
    trust: p.trust,
    failureModes: p.failureModes,
    limitations: p.limitations,
    sources: p.sources,
    execution: p.execution ?? [],
  };
  writeFileSync(resolve(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const trace = resolve(traceDir, `${p.providerId}.md`);
  const facts = existsSync(trace) ? sections(readFileSync(trace, "utf8")) : "No verified runtime facts beyond the manifest.";
  writeFileSync(resolve(dir, "facts.md"), `# ${p.displayName} — runtime facts (verified ${manifest.researchDate})\n\nOnly facts TRACE verified are here. Knowing these facts never authorizes using this provider.\n\n${facts}\n`);
  console.log(`pack ${p.knowledgePack}`);
}
