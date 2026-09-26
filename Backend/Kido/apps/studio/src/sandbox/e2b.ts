import { E2BSandboxClient } from "@openai/agents-extensions/sandbox/e2b";
import { Sandbox } from "@e2b/code-interpreter";
import { SANDBOX } from "../config.js";
import {
  SandboxUnavailableError,
  type SandboxExec,
  type SandboxFile,
  type StudioSandbox,
  type StudioSandboxProvider,
} from "./provider.js";
import { E2B_CAPABILITIES, secretsMayEnter } from "./capabilities.js";

/**
 * The hosted sandbox provider.
 *
 * P11 filed FND-V2-002 saying `E2BSandboxClient` did not exist. It does — in
 * `@openai/agents-extensions`, a sibling package that finding never inspected. This is the real
 * implementation behind the same `StudioSandboxProvider` interface Docker uses.
 *
 * What is deliberately NOT carried across from the Docker provider is its security claim. Docker
 * gets `networkMode: 'none'`; this provider has no equivalent, so it declares its isolation as
 * UNKNOWN and the Studio compensates architecturally — see `capabilities.ts` and the assertion in
 * `create()` below.
 */

class E2BStudioSandbox implements StudioSandbox {
  readonly provider = "e2b";
  constructor(
    readonly id: string,
    private readonly session: {
      exec: (args: Record<string, unknown>) => Promise<{ stdout?: string; stderr?: string; exitCode?: number | null }>;
      writeFile?: (p: string, c: string) => Promise<unknown>;
      readFile?: (p: string) => Promise<string>;
      listFiles?: (p: string) => Promise<unknown>;
      close?: () => Promise<unknown>;
    },
  ) {}

  async exec(cmd: string, opts: { workdir?: string } = {}): Promise<SandboxExec> {
    const started = Date.now();
    const r = await this.session.exec({ cmd, ...(opts.workdir ? { workdir: opts.workdir } : {}) });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.exitCode ?? null,
      wallTimeSeconds: (Date.now() - started) / 1000,
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!this.session.writeFile) throw new SandboxUnavailableError("hosted session exposes no writeFile");
    await this.session.writeFile(path, content);
  }

  async readFile(path: string): Promise<string> {
    if (!this.session.readFile) throw new SandboxUnavailableError("hosted session exposes no readFile");
    return this.session.readFile(path);
  }

  async listFiles(dir: string): Promise<SandboxFile[]> {
    if (!this.session.listFiles) return [];
    const entries = (await this.session.listFiles(dir)) as Array<{ path: string; type: SandboxFile["type"] }>;
    return entries.map((e) => ({ path: e.path, type: e.type }));
  }

  async destroy(): Promise<void> {
    await this.session.close?.();
  }
}

export class E2BStudioSandboxProvider implements StudioSandboxProvider {
  readonly id = "e2b";
  private readonly client: E2BSandboxClient;
  private readonly live = new Map<string, E2BStudioSandbox>();

  constructor(template = SANDBOX.image, apiKey = process.env.E2B_API_KEY) {
    if (!apiKey) {
      // A missing key must be a named failure at construction, not a silent fallback to Docker or,
      // far worse, to the host.
      throw new SandboxUnavailableError("E2B_API_KEY is not set; the hosted provider cannot be constructed");
    }
    this.client = new E2BSandboxClient({ Sandbox, template, apiKey } as never);
  }

  /**
   * Environment a hosted sandbox may receive.
   *
   * Empty, and enforced rather than intended. Because `E2B_CAPABILITIES.networkIsolation` is not
   * `NONE`, `secretsMayEnter` is false, and anything placed here would be one outbound request away
   * from leaving — in code a model wrote from a prompt we do not control.
   */
  hostedEnvironment(): Record<string, string> {
    if (!secretsMayEnter(E2B_CAPABILITIES)) return {};
    throw new Error("E2B-CAPABILITIES-CHANGED: revisit this function before placing anything in a hosted sandbox");
  }

  async create(): Promise<StudioSandbox> {
    let session: unknown;
    try {
      session = await (this.client as unknown as { create: (o: unknown) => Promise<unknown> }).create({
        // No secrets, by construction. See hostedEnvironment().
        env: this.hostedEnvironment(),
      });
    } catch (err) {
      throw new SandboxUnavailableError(`could not start a hosted sandbox: ${(err as Error).message}`);
    }
    const id = `e2b_${Math.random().toString(36).slice(2, 10)}`;
    const sb = new E2BStudioSandbox(id, session as never);
    this.live.set(id, sb);
    return sb;
  }

  /**
   * Resume.
   *
   * Claimed here, unlike Docker, because the provider genuinely supports reconnecting to a session
   * by id. It is still bounded by what the provider retains, which the capability matrix records.
   */
  async resume(id: string): Promise<StudioSandbox> {
    const existing = this.live.get(id);
    if (existing) return existing;
    const resumeFn = (this.client as unknown as { resume?: (o: unknown) => Promise<unknown> }).resume;
    if (typeof resumeFn !== "function") {
      throw new SandboxUnavailableError(`hosted client exposes no resume; sandbox ${id} cannot be reconnected`);
    }
    const session = await resumeFn.call(this.client, { sandboxId: id });
    const sb = new E2BStudioSandbox(id, session as never);
    this.live.set(id, sb);
    return sb;
  }

  async snapshot(sandbox: StudioSandbox): Promise<string> {
    const fn = (this.client as unknown as { serializeSessionState?: (s: unknown) => Promise<string> }).serializeSessionState;
    if (typeof fn !== "function") return `snapshot:${sandbox.id}`;
    return fn.call(this.client, sandbox);
  }

  async destroy(sandbox: StudioSandbox): Promise<void> {
    this.live.delete(sandbox.id);
    await sandbox.destroy();
  }
}
