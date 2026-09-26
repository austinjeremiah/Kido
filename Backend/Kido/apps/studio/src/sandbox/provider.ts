import { DockerSandboxClient } from "@openai/agents/sandbox/local";
import { createRequire } from "node:module";
import { SANDBOX } from "../config.js";

/**
 * The sandbox boundary.
 *
 * This is the single most important control in the Studio. Generated code is written by a language
 * model from a prompt that may itself be attacker-influenced, and it is DeFi code — it will hold
 * addresses, amounts and, eventually, keys. It must never execute in the Studio's own process,
 * where it would inherit the Studio's environment, its filesystem and its network position.
 *
 * Three properties are enforced here rather than left to callers:
 *
 *  1. Only this module imports `@openai/agents/sandbox/local`. That subpath is the host-privileged
 *     surface — it can start containers — so it has exactly one entry point in the codebase.
 *  2. `networkMode: 'none'` is hard-coded and cannot be overridden. See FND-V2-003: the Docker
 *     client offers no middle setting, so the choice is "no network" or "unrestricted outbound",
 *     and unrestricted outbound during `npm test` is precisely what must not happen.
 *  3. An unknown provider fails closed with a named error. It never falls back to Docker, and it
 *     certainly never falls back to the host.
 */

export interface SandboxFile {
  path: string;
  type: "file" | "dir" | "other";
}

export interface SandboxExec {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  wallTimeSeconds: number;
}

export interface StudioSandbox {
  readonly id: string;
  readonly provider: string;
  exec(cmd: string, opts?: { workdir?: string }): Promise<SandboxExec>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  listFiles(dir: string): Promise<SandboxFile[]>;
  destroy(): Promise<void>;
}

export interface StudioSandboxProvider {
  readonly id: string;
  create(): Promise<StudioSandbox>;
  resume(id: string): Promise<StudioSandbox>;
  snapshot(sandbox: StudioSandbox): Promise<string>;
  destroy(sandbox: StudioSandbox): Promise<void>;
}

export class SandboxProviderUnavailableError extends Error {
  constructor(id: string, detail: string) {
    super(`sandbox provider "${id}" is not available: ${detail}`);
    this.name = "SandboxProviderUnavailableError";
  }
}

export class SandboxUnavailableError extends Error {
  constructor(detail: string) {
    super(`sandbox unavailable: ${detail}`);
    this.name = "SandboxUnavailableError";
  }
}

/* ────────────────────────────── Docker provider ───────────────────────────── */

class DockerStudioSandbox implements StudioSandbox {
  readonly provider = "docker";
  constructor(
    readonly id: string,
    private readonly session: any,
  ) {}

  async exec(cmd: string, opts: { workdir?: string } = {}): Promise<SandboxExec> {
    const r = await this.session.exec({
      cmd,
      ...(opts.workdir ? { workdir: opts.workdir } : {}),
    });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.exitCode ?? null,
      wallTimeSeconds: r.wallTimeSeconds ?? 0,
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    const abs = path.startsWith("/") ? path : `${SANDBOX.workspaceRoot}/${path}`;
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    // Base64 rather than a heredoc: generated content contains quotes, backticks, `$` and newlines,
    // and a shell-quoting bug here would be a command injection into the sandbox shell.
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const cmd = `mkdir -p ${JSON.stringify(dir)} && printf %s ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(abs)}`;
    /*
     * Retried, because the write is idempotent and the failure is not ours.
     *
     * Under Docker load the sandbox exec occasionally comes back with no exit code and no stderr —
     * seen when two dozen unrelated containers were starting on the same daemon. One such blip
     * used to fail the whole build at "sandbox write failed for DEPLOYMENT.md: ", which told the
     * user nothing and cost them the build. Three attempts, and the error names the exit code.
     */
    let last: SandboxExec | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      last = await this.exec(cmd);
      if (last.exitCode === 0) return;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    throw new Error(`sandbox write failed for ${path} after 3 attempts (exit ${last?.exitCode ?? "none"}): ${last?.stderr || "no stderr"}`);
  }

  async readFile(path: string): Promise<string> {
    const abs = path.startsWith("/") ? path : `${SANDBOX.workspaceRoot}/${path}`;
    const content = await this.session.readFile({ path: abs });
    return typeof content === "string" ? content : new TextDecoder().decode(content);
  }

  async listFiles(dir: string): Promise<SandboxFile[]> {
    const abs = dir.startsWith("/") ? dir : `${SANDBOX.workspaceRoot}/${dir}`;
    const entries = (await this.session.listDir({ path: abs })) as Array<{
      name: string;
      path: string;
      type: "file" | "dir" | "other";
    }>;
    return entries.map((e) => ({ path: e.path, type: e.type }));
  }

  async destroy(): Promise<void> {
    await this.session.close?.();
  }
}

export class DockerStudioSandboxProvider implements StudioSandboxProvider {
  readonly id = "docker";
  private readonly client: DockerSandboxClient;
  private readonly live = new Map<string, DockerStudioSandbox>();

  constructor(image = SANDBOX.image) {
    this.client = new DockerSandboxClient({
      image,
      // Not a parameter. See the class comment and FND-V2-003.
      networkMode: SANDBOX.networkMode,
    });
  }

  async create(): Promise<StudioSandbox> {
    let session: any;
    try {
      session = await this.client.create();
    } catch (err) {
      // A missing Docker daemon must be a loud, named failure. The dangerous version of this error
      // is one that gets caught somewhere upstream and quietly turned into host execution.
      throw new SandboxUnavailableError(
        `could not start a Docker sandbox (is the daemon running, and does image "${SANDBOX.image}" exist?): ${(err as Error).message}`,
      );
    }
    const id = `sbx_${Math.random().toString(36).slice(2, 10)}`;
    const sb = new DockerStudioSandbox(id, session);
    this.live.set(id, sb);
    return sb;
  }

  async resume(id: string): Promise<StudioSandbox> {
    const existing = this.live.get(id);
    if (existing) return existing;
    // Cross-process resume is deliberately not claimed. The SDK requires trusted serialized state
    // to reconnect safely, and inventing a resume that silently creates a *fresh* sandbox would let
    // a caller believe it recovered a workspace that is actually empty.
    throw new SandboxUnavailableError(
      `sandbox ${id} is not live in this process; a build resumed after a restart must be rebuilt from persisted artifacts`,
    );
  }

  async snapshot(sandbox: StudioSandbox): Promise<string> {
    return `snapshot:${sandbox.id}`;
  }

  async destroy(sandbox: StudioSandbox): Promise<void> {
    this.live.delete(sandbox.id);
    await sandbox.destroy();
  }
}

/* ──────────────────────────────── registry ────────────────────────────────── */

const providers = new Map<string, () => StudioSandboxProvider>();
providers.set("docker", () => new DockerStudioSandboxProvider());
/*
 * The hosted provider is registered lazily.
 *
 * `import()` rather than a top-level import so that a deployment without E2B installed or
 * configured does not fail to start — and, more importantly, so the hosted client is never loaded
 * in a local run that has no business talking to a vendor.
 */
providers.set("e2b", () => {
  // createRequire, not require: this module is ESM, and a bare require() here would be undefined at
  // runtime while still type-checking. The laziness matters -- a local run has no business loading a
  // hosted vendor's client -- so the cost is one synchronous resolve at first use.
  const load = createRequire(import.meta.url);
  const { E2BStudioSandboxProvider } = load("./e2b.ts") as typeof import("./e2b.js");
  return new E2BStudioSandboxProvider();
});

/**
 * E2B is deliberately absent. `@openai/agents` 0.17.0 ships no `E2BSandboxClient` (FND-V2-002), and
 * registering a provider that has never started a container would be worse than having none: it
 * would appear in this map as a selectable option.
 */
export function getSandboxProvider(id: string = SANDBOX.provider): StudioSandboxProvider {
  const factory = providers.get(id);
  if (!factory) {
    throw new SandboxProviderUnavailableError(
      id,
      `no such provider is registered. Available: ${[...providers.keys()].join(", ")}.`,
    );
  }
  return factory();
}

export function registeredSandboxProviders(): string[] {
  return [...providers.keys()];
}

/**
 * Register an additional provider.
 *
 * This exists so tests can substitute a recording provider for cases that are about pipeline
 * behaviour rather than isolation. It is deliberately explicit rather than implicit: nothing is
 * registered by default, `SANDBOX.provider` still resolves to `docker`, and the tests that assert
 * isolation (STUDIO-012, STUDIO-032) use the real Docker provider — a fake sandbox proves nothing
 * about sandboxing, and a test suite that only ever used one would be measuring itself.
 */
export function registerSandboxProvider(id: string, factory: () => StudioSandboxProvider): void {
  if (id === "docker") throw new Error("the docker provider cannot be replaced");
  providers.set(id, factory);
}
