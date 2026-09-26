import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * Opens the evidence the registry cites ("Kido packages/privacy/test/nautilus.test.ts",
 * ".gauntlet/evidence/bridge-roundtrip-*.json", …) as read-only files. Only the configured roots
 * are readable, never key material or environment files, and anything secret-shaped is redacted
 * before it leaves. A citation that names no file is returned as a statement.
 */
export interface EvidenceRoots {
  /** Root of the Kido backend ("Kido …" citations). */
  kido: string;
  /** Root of the Amane repository ("Amane …" citations). */
  amane: string;
  /** The testnet evidence directory (".gauntlet/…" citations); absent ⇒ those citations are unavailable. */
  gauntlet?: string | undefined;
}

export interface EvidenceFile {
  id: string;
  root: keyof EvidenceRoots;
  path: string;
  size: number;
  modifiedAt: number;
}

const FORBIDDEN = [/(^|\/)keys(\/|$)/, /(^|\/)\.env(\.|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.git(\/|$)/, /(^|\/)dist(\/|$)/, /(^|\/)build(\/|$)/, /\.(pem|key)$/];
const MAX_FILES = 40;
const MAX_BYTES = 512 * 1024;

/** Secret-shaped values are masked; a count of masks is reported alongside the content. */
const SECRETS: RegExp[] = [
  /suiprivkey1[0-9a-z]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /(bearer\s+)[A-Za-z0-9._-]{20,}/gi,
  /((?:private[_-]?key|secret|mnemonic|api[_-]?key|access[_-]?token|password)["']?\s*[:=]\s*["']?)[^"'\s,}]{8,}/gi,
];

function redact(text: string): { text: string; redactions: number } {
  let n = 0;
  let out = text;
  for (const re of SECRETS) out = out.replace(re, (m, lead?: string) => (n++, typeof lead === "string" && m.startsWith(lead) ? `${lead}[redacted]` : "[redacted]"));
  return { text: out, redactions: n };
}

const encodeId = (root: string, path: string) => Buffer.from(`${root}:${path}`).toString("base64url");

export class EvidenceStore {
  constructor(private readonly roots: EvidenceRoots) {}

  /** The files a citation names (a file, a directory, or a glob), newest first; or none for a statement. */
  resolve(ref: string): { ref: string; files: EvidenceFile[]; note: string | null } {
    const target = this.parse(ref);
    if (!target) return { ref, files: [], note: "This evidence is a statement, not a file." };
    const base = this.roots[target.root];
    if (!base) return { ref, files: [], note: `The ${target.root} evidence directory is not available on this backend.` };
    const files = this.expand(target.root, base, target.path);
    return { ref, files, note: files.length ? null : `No file matches ${target.path} under the ${target.root} root.` };
  }

  read(id: string): { id: string; path: string; root: string; content: string; truncated: boolean; redactions: number; language: "json" | "md" | "text" } {
    const [root, ...rest] = Buffer.from(id, "base64url").toString("utf8").split(":");
    const path = rest.join(":");
    const abs = this.inside(root as keyof EvidenceRoots, path);
    const buf = readFileSync(abs);
    const truncated = buf.length > MAX_BYTES;
    const { text, redactions } = redact(buf.subarray(0, MAX_BYTES).toString("utf8"));
    const language = /\.json$/.test(path) ? "json" : /\.md$/.test(path) ? "md" : "text";
    return { id, path, root: root!, content: text, truncated, redactions, language };
  }

  private parse(ref: string): { root: keyof EvidenceRoots; path: string } | null {
    const g = /(^|\s)\.gauntlet\/([\w@./*-]+)/.exec(ref);
    if (g) return { root: "gauntlet", path: g[2]! };
    const r = /(^|\s)(Kido|Amane)\s+([\w@.*-]+(?:\/[\w@.*-]+)+|[\w@.-]+\.(?:ts|move|json|md|toml|log))/.exec(ref);
    if (r) return { root: r[2] === "Kido" ? "kido" : "amane", path: r[3]! };
    return null;
  }

  /** An absolute path under a root, refusing escapes, links out of the root and forbidden files. */
  private inside(root: keyof EvidenceRoots, path: string): string {
    const base = this.roots[root];
    if (!base || !existsSync(base)) throw new Error(`unknown evidence root ${String(root)}`);
    const realBase = realpathSync(base);
    const abs = realpathSync(resolve(realBase, path));
    const rel = relative(realBase, abs);
    if (rel.startsWith("..") || rel.split(sep).includes("..") || FORBIDDEN.some((f) => f.test(rel.split(sep).join("/")))) throw new Error("that file is not readable evidence");
    return abs;
  }

  private expand(root: keyof EvidenceRoots, base: string, path: string): EvidenceFile[] {
    const out: EvidenceFile[] = [];
    const add = (abs: string) => {
      const rel = relative(realpathSync(base), abs).split(sep).join("/");
      if (FORBIDDEN.some((f) => f.test(rel)) || out.length >= MAX_FILES) return;
      const st = statSync(abs);
      if (st.isDirectory()) {
        for (const e of readdirSync(abs)) add(join(abs, e));
      } else out.push({ id: encodeId(root, rel), root, path: rel, size: st.size, modifiedAt: st.mtimeMs });
    };
    try {
      if (path.includes("*")) {
        const dir = resolve(base, dirname(path));
        const pattern = new RegExp(`^${basename(path).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
        // A glob like "run-*.json" also matches the run's directory ("run-1790…/").
        const loose = new RegExp(`^${basename(path).split("*")[0]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}`);
        const entries = existsSync(dir) ? readdirSync(dir).filter((e) => pattern.test(e) || (loose.test(e) && statSync(join(dir, e)).isDirectory())) : [];
        entries.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs).forEach((e) => add(realpathSync(join(dir, e))));
      } else {
        add(this.inside(root, path));
      }
    } catch {
      /* unreadable or outside the root: reported as no match */
    }
    return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }
}
