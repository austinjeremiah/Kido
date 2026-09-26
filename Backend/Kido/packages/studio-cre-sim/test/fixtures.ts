import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import type { SimulationConfig } from "../src/provider.js";

/**
 * The approved artifact.
 *
 * `wasmSha256` is the REAL binary hash the official CRE CLI printed for this workflow — on
 * 2026-09-07 during Phase 4 and again on 2026-09-10 during Phase 26, unchanged across three days
 * and five different configs. Using the genuine value means the pinning tests are calibrated
 * against the tool's actual output.
 */
export const APPROVED_ARTIFACT = {
  wasmSha256: "800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0",
  workflowSourceHash: `sha256:${"1".repeat(64)}`,
  workflowConfigHash: `sha256:${"2".repeat(64)}`,
} as const;

export const baseConfig = (over: Partial<SimulationConfig> = {}): SimulationConfig => ({
  deploymentId: "dep_contextlock_001",
  projectId: "contextlock",
  mode: "SIMULATED_USER",
  projectDir: "./policy",
  target: "staging-settings",
  workflowSourceHash: APPROVED_ARTIFACT.workflowSourceHash,
  wasmSha256: APPROVED_ARTIFACT.wasmSha256,
  workflowConfigHash: APPROVED_ARTIFACT.workflowConfigHash,
  blueprintRevision: 3,
  strategyRevision: 7,
  adapterVersions: { "aave-v3": "1.4.0", "uniswap-v3": "2.0.1" },
  creCliVersion: "1.32.0",
  limitsMode: "PRODUCTION_DEFAULT",
  limitsFile: null,
  broadcastMode: "DRY_RUN",
  broadcastNetwork: null,
  triggerKind: "EVM_LOG_ONESHOT",
  triggerIndex: 0,
  httpTriggerPort: null,
  ...over,
});

/**
 * A stand-in child process.
 *
 * The CLI itself is exercised for real in `crelab-live.test.ts`. What this fake covers is the part
 * a live run cannot make happen on demand: a crash, a hang, an auth prompt, a restart storm.
 */
export class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];

  kill(signal?: string): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
  say(line: string): void {
    this.stdout.emit("data", Buffer.from(`${line}\n`));
  }
  err(line: string): void {
    this.stderr.emit("data", Buffer.from(`${line}\n`));
  }
  finish(code: number): void {
    this.emit("exit", code);
  }
}

export interface SpawnRecorder {
  spawnFn: typeof spawn;
  calls: Array<{ bin: string; args: string[]; env: Record<string, string>; cwd?: string }>;
  last: () => FakeChild;
  children: FakeChild[];
}

export const recorder = (): SpawnRecorder => {
  const calls: SpawnRecorder["calls"] = [];
  const children: FakeChild[] = [];
  const spawnFn = ((bin: string, args: string[], opts: { env?: Record<string, string>; cwd?: string }) => {
    const child = new FakeChild();
    children.push(child);
    calls.push({ bin, args, env: opts?.env ?? {}, cwd: opts?.cwd });
    return child;
  }) as unknown as typeof spawn;
  return {
    spawnFn, calls, children,
    last: () => {
      const c = children[children.length - 1];
      if (!c) throw new Error("nothing was spawned — the provider did not reach the CLI");
      return c;
    },
  };
};

/* ─────────────────────── searching the real source tree ─────────────────────── */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The repository root, derived from this file rather than from `process.cwd()`.
 *
 * `process.cwd()` is the repo root when vitest runs from the root and the package directory when it
 * runs per-package, so a source-scanning assertion keyed on it searches a directory that does not
 * exist and finds nothing — passing for the reason it was written to catch. Resolved from
 * `import.meta.url` it is the same either way, and `assertExists` makes a wrong answer loud.
 */
export const repoRoot = (): string => {
  const root = new URL("../../../", import.meta.url).pathname;
  if (!existsSync(`${root}packages`) || !existsSync(`${root}apps`)) {
    throw new Error(`source scan resolved ${root}, which is not the repository root`);
  }
  return root;
};

export interface SourceLine { file: string; line: number; text: string }

/** Every non-test source line matching a pattern. Throws rather than returning [] if it cannot look. */
export const sourceLines = (pattern: RegExp): SourceLine[] => {
  const root = repoRoot();
  const out = execSync(
    `grep -rn --exclude-dir=node_modules --exclude-dir=dist ${JSON.stringify(pattern.source)} packages apps 2>/dev/null || true`,
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const m = /^([^:]+):(\d+):(.*)$/.exec(l);
      return m ? { file: m[1] as string, line: Number(m[2]), text: m[3] as string } : null;
    })
    .filter((x): x is SourceLine => x !== null)
    .filter((x) => !x.file.includes("node_modules") && !x.file.includes("/test/") && !x.file.endsWith(".test.ts"));
};

/** Whether a source line is commentary rather than code. */
export const isComment = (text: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(text);
