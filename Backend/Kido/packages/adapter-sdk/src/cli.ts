#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { scaffoldAdapter, KIND_TO_ADAPTER_TYPE, type ScaffoldKind } from "./scaffold.js";
import { runConformance } from "./testkit.js";
import { artifactHash } from "./artifact.js";

/**
 * `contextlock adapter` — scaffold and verify third-party adapters.
 *
 * Two commands, both offline. Neither reaches the network, and neither loads code from the target
 * directory except to hash and read it: verifying an adapter by executing it would make `verify`
 * itself the attack surface.
 */

const KINDS: ScaffoldKind[] = ["execution", "state-data", "verified-market-data", "external-api", "trigger", "cross-chain"];

const usage = () => `contextlock adapter <command>

  init --id <kebab-id> --kind <kind> [--provider <name>] [--chains 11155111] [--dir <path>]
      Scaffold a new adapter. Every security decision is left as a throw, not a default.
      kinds: ${KINDS.join(", ")}

  verify [--dir <path>]
      Run the ContextLock conformance kit against an adapter directory and print its artifact hash.
`;

const arg = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

function collectFiles(dir: string, base = dir): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full, base));
    else if (/\.(ts|json|md)$/.test(entry)) {
      out.push({ path: relative(base, full).split("\\").join("/"), content: readFileSync(full, "utf8") });
    }
  }
  return out;
}

export function main(argv: string[]): number {
  const cmd = argv[0];

  if (cmd === "init") {
    const id = arg(argv, "id");
    const kind = arg(argv, "kind") as ScaffoldKind | undefined;
    if (!id || !kind) { process.stderr.write(usage()); return 2; }
    if (!KINDS.includes(kind)) {
      process.stderr.write(`unknown kind "${kind}". One of: ${KINDS.join(", ")}\n`);
      return 2;
    }
    const dir = arg(argv, "dir") ?? `./contextlock-adapter-${id}`;
    const chains = (arg(argv, "chains") ?? "11155111").split(",").map(Number);
    const provider = arg(argv, "provider") ?? id;

    if (existsSync(dir)) {
      // Never overwrite: a scaffold that clobbers an author's work is a destructive default.
      process.stderr.write(`refusing to write into an existing directory: ${dir}\n`);
      return 1;
    }
    for (const f of scaffoldAdapter({ id, kind, provider, chains })) {
      const target = join(dir, f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content);
      process.stdout.write(`  created ${relative(process.cwd(), target)}\n`);
    }
    process.stdout.write(
      `\n${id} scaffolded as ${KIND_TO_ADAPTER_TYPE[kind]}.\n` +
        `Everything in src/ throws on purpose — each throw is a security decision only you can make.\n` +
        `Run \`npm test\` in ${dir} to see where the conformance kit stands.\n`,
    );
    return 0;
  }

  if (cmd === "verify") {
    const dir = arg(argv, "dir") ?? ".";
    const manifestPath = join(dir, "src", "manifest.ts");
    if (!existsSync(manifestPath)) {
      process.stderr.write(`no src/manifest.ts under ${dir}\n`);
      return 1;
    }
    const files = collectFiles(dir);
    process.stdout.write(`artifact ${artifactHash(files)}\n`);
    process.stdout.write(
      `\nThe conformance kit needs the adapter INSTANCE, which means importing your code.\n` +
        `This command deliberately does not do that: loading a third-party adapter to verify it\n` +
        `would make verification the attack surface. Run \`npm test\` in ${dir} instead — the\n` +
        `scaffolded test calls runConformance() inside your own test runner.\n`,
    );
    return 0;
  }

  process.stdout.write(usage());
  return cmd ? 2 : 0;
}

/** Only run when invoked directly, so tests can import `main` without side effects. */
if (process.argv[1] && /adapter-sdk[\\/]src[\\/]cli\.ts$/.test(process.argv[1])) {
  process.exit(main(process.argv.slice(2).filter((a) => a !== "adapter")));
}

export { runConformance };
