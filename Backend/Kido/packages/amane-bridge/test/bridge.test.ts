import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("KIDO-INT-002 single Amane boundary", () => {
  const root = resolve(__dirname, "../../..");
  const skip = new Set(["node_modules", "dist", ".next", ".git", "out", "cache", "broadcast"]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(name)) files.push(p);
    }
  };
  for (const top of ["apps", "packages", "scripts"]) walk(join(root, top));

  it("only packages/amane-bridge imports the Amane SDK or core", () => {
    const offenders = files.filter((f) => !f.includes(`${join("packages", "amane-bridge")}`) && /from\s+["']@amane\/(sdk|core)["']/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
