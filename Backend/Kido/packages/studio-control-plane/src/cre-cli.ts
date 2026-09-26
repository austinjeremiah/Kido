import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assertDestructiveConfirmation, CreMonitorError, CRE_REASONS,
  type CreConnection, type CreExecution, type CreExecutionEvent, type CreOperationsProvider,
  type CreWorkflow, type DestructiveConfirmation,
} from "./cre.js";

const exec = promisify(execFile);

/**
 * The CRE provider backed by the user's own authenticated CLI.
 *
 * §25.8's Local Session path. The control plane never holds a CRE credential; it names an
 * operation, the CLI runs on the machine that has the session, and structured JSON comes back.
 *
 * Two things are deliberate.
 *
 * STRUCTURED JSON ONLY, NEVER THE DECORATIVE TABLE. §25.8 and §25.12 both say it. Where a command
 * offers `--output json` this uses it. `cre whoami` does NOT — it prints a box-drawn table — so
 * that one is parsed by labelled field, narrowly, and the parser is honest about being a parser.
 *
 * SELECTORS ARE LIFTED AS TEXT. `cre workflow supported-chains --output json` emits uint64 chain
 * selectors as bare JSON numbers, and `JSON.parse` corrupts every one of them
 * (FND-V2-E-002). Anything reading selectors from CLI output extracts the digits before a parser
 * sees them.
 */

/** Exactly the commands this provider may run. There is no passthrough and no shell. */
export const CRE_CLI_COMMANDS = [
  "whoami",
  "registry list",
  "workflow list",
  "workflow get",
  "execution list",
  "execution status",
  "execution events",
  "execution logs",
  "workflow activate",
  "workflow pause",
  "workflow delete",
] as const;

export interface CreCliOptions {
  /** Path to the `cre` binary. */
  binary?: string;
  /** The workflow project directory. `workflow get` resolves by folder + target, not by id. */
  projectDir: string;
  target?: string;
  timeoutMs?: number;
  /** Injected so tests can drive the parser without a CLI. */
  run?: (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

/**
 * Extract the JSON payload from CLI output.
 *
 * The CLI prints progress lines ("Initializing...") and an update banner around the JSON, so the
 * payload has to be located rather than assumed to be the whole of stdout.
 */
export function extractJson(raw: string): string | null {
  const firstArray = raw.indexOf("[");
  const firstObject = raw.indexOf("{");
  const start = firstArray === -1 ? firstObject : firstObject === -1 ? firstArray : Math.min(firstArray, firstObject);
  if (start === -1) return null;
  const end = raw.lastIndexOf(raw[start] === "[" ? "]" : "}");
  return end > start ? raw.slice(start, end + 1) : null;
}

/**
 * Parse `cre whoami`.
 *
 * The one command with no JSON output. Fields are read by label from the box-drawn table, and
 * anything not found is null rather than guessed — a whoami that failed to parse must not silently
 * become "not connected", because that would show a working session as broken.
 */
export function parseWhoami(raw: string): Omit<CreConnection, "availableRegistryIds" | "cliVersion"> & { parsed: boolean } {
  const field = (label: string): string | null => {
    const m = new RegExp(`${label}:\\s*([^\\n│]+)`).exec(raw);
    return m ? m[1]!.trim() : null;
  };
  const org = field("Organization ID");
  const deployAccessRaw = field("Deploy Access");
  return {
    connected: org !== null,
    organizationId: org,
    organizationName: field("Organization Name"),
    accountLabel: field("Email"),
    // "Enabled" / "Not enabled". Anything else is treated as NOT enabled — the safe direction,
    // since claiming access we do not have would produce a deploy attempt that fails.
    deployAccess: /^enabled$/i.test(deployAccessRaw ?? ""),
    parsed: org !== null && deployAccessRaw !== null,
  };
}

export class CreCliProvider implements CreOperationsProvider {
  readonly id = "local-cre-cli";
  readonly invocations: Array<{ args: string[]; ok: boolean }> = [];

  constructor(private readonly opts: CreCliOptions) {}

  private async run(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    if (this.opts.run) {
      const r = await this.opts.run(args);
      this.invocations.push({ args, ok: r.ok });
      return r;
    }
    const binary = this.opts.binary ?? `${process.env.HOME}/.cre/bin/cre`;
    try {
      const { stdout, stderr } = await exec(binary, [...args, "--non-interactive"], {
        cwd: this.opts.projectDir,
        timeout: this.opts.timeoutMs ?? 60_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      this.invocations.push({ args, ok: true });
      return { ok: true, stdout, stderr };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      this.invocations.push({ args, ok: false });
      return { ok: false, stdout: err.stdout ?? "", stderr: (err.stderr ?? "") + err.message };
    }
  }

  private targetArgs(): string[] {
    return this.opts.target ? ["--target", this.opts.target] : [];
  }

  async getConnectionStatus(): Promise<CreConnection> {
    const who = await this.run(["whoami"]);
    if (!who.ok && !who.stdout.includes("Organization ID")) {
      throw new CreMonitorError(CRE_REASONS.NOT_CONNECTED, `cre whoami failed: ${who.stderr.split("\n")[0]}`);
    }
    const parsed = parseWhoami(who.stdout + who.stderr);
    const registries = await this.run(["registry", "list"]);
    const registryIds = [...registries.stdout.matchAll(/ID:\s+(\S+)/g)].map((m) => m[1]!);
    const version = await this.run(["version"]);
    const cliVersion = /CRE CLI version (\S+)/.exec(version.stdout + version.stderr)?.[1] ?? null;

    return {
      connected: parsed.connected,
      organizationId: parsed.organizationId,
      organizationName: parsed.organizationName,
      accountLabel: parsed.accountLabel,
      deployAccess: parsed.deployAccess,
      availableRegistryIds: registryIds,
      cliVersion,
    };
  }

  async listWorkflows(): Promise<CreWorkflow[]> {
    const r = await this.run(["workflow", "list", "--output", "json"]);
    const json = extractJson(r.stdout);
    if (!json) return [];
    const rows = JSON.parse(json) as Array<Record<string, unknown>>;
    return rows.map((w) => this.toWorkflow(w));
  }

  /**
   * `cre workflow get` takes a PROJECT FOLDER and a target, not a workflow id.
   *
   * Worth stating because the addendum's sketch implies an id. The installed CLI resolves the
   * workflow named in `workflow.yaml` for the selected target, which means this provider needs a
   * project directory and cannot look up an arbitrary workflow by identifier.
   */
  async getWorkflow(name: string): Promise<CreWorkflow | null> {
    const r = await this.run(["workflow", "get", ".", ...this.targetArgs(), "--output", "json"]);
    const json = extractJson(r.stdout);
    if (!json) return null;
    try {
      const w = JSON.parse(json) as Record<string, unknown>;
      const parsed = this.toWorkflow(w);
      return parsed.workflowName === name || name === "" ? parsed : null;
    } catch {
      return null;
    }
  }

  async listExecutions(workflowIdOrName: string, opts: { limit?: number; status?: string } = {}): Promise<CreExecution[]> {
    const args = ["execution", "list", workflowIdOrName, "--output", "json"];
    if (opts.limit) args.push("--limit", String(opts.limit));
    if (opts.status) args.push("--status", opts.status);
    const r = await this.run(args);
    const json = extractJson(r.stdout);
    if (!json) return [];
    return (JSON.parse(json) as Array<Record<string, unknown>>).map((e) => this.toExecution(e, workflowIdOrName));
  }

  async getExecutionStatus(executionId: string): Promise<CreExecution | null> {
    const r = await this.run(["execution", "status", executionId, "--output", "json"]);
    const json = extractJson(r.stdout);
    if (!json) return null;
    return this.toExecution(JSON.parse(json) as Record<string, unknown>, "");
  }

  async getExecutionEvents(executionId: string): Promise<CreExecutionEvent[]> {
    const r = await this.run(["execution", "events", executionId, "--output", "json"]);
    const json = extractJson(r.stdout);
    if (!json) return [];
    return (JSON.parse(json) as Array<Record<string, unknown>>).map((e) => ({
      executionId,
      capabilityId: (e.capabilityId as string) ?? (e.capability as string) ?? null,
      nodeId: (e.nodeId as string) ?? (e.node as string) ?? null,
      status: String(e.status ?? "UNKNOWN"),
      timestampMs: this.toMs(e.timestamp ?? e.time),
      message: String(e.message ?? e.msg ?? ""),
    }));
  }

  async getExecutionLogs(executionId: string): Promise<Array<{ nodeId: string | null; timestampMs: number; message: string }>> {
    const r = await this.run(["execution", "logs", executionId, "--output", "json"]);
    const json = extractJson(r.stdout);
    if (!json) return [];
    return (JSON.parse(json) as Array<Record<string, unknown>>).map((l) => ({
      nodeId: (l.nodeId as string) ?? (l.node as string) ?? null,
      timestampMs: this.toMs(l.timestamp ?? l.time),
      message: String(l.message ?? l.msg ?? ""),
    }));
  }

  async activateWorkflow(_name: string): Promise<{ status: string }> {
    const r = await this.run(["workflow", "activate", ".", ...this.targetArgs()]);
    if (!r.ok) throw new CreMonitorError(CRE_REASONS.NOT_CONNECTED, `activate failed: ${r.stderr.split("\n")[0]}`);
    return { status: "ACTIVE" };
  }

  async pauseWorkflow(_name: string): Promise<{ status: string }> {
    const r = await this.run(["workflow", "pause", ".", ...this.targetArgs()]);
    if (!r.ok) throw new CreMonitorError(CRE_REASONS.NOT_CONNECTED, `pause failed: ${r.stderr.split("\n")[0]}`);
    return { status: "PAUSED" };
  }

  /**
   * Destructive, and gated twice.
   *
   * The confirmation is checked before the CLI is invoked, and `--yes` is passed only after that
   * check passes — so there is no arrangement in which the skip-confirmation flag is sent without
   * an operator having typed the workflow's name.
   */
  async deleteWorkflow(name: string, confirmation: DestructiveConfirmation): Promise<{ deleted: true }> {
    assertDestructiveConfirmation(name, confirmation);
    const r = await this.run(["workflow", "delete", ".", ...this.targetArgs(), "--yes"]);
    if (!r.ok) throw new CreMonitorError(CRE_REASONS.NOT_CONNECTED, `delete failed: ${r.stderr.split("\n")[0]}`);
    return { deleted: true };
  }

  private toWorkflow(w: Record<string, unknown>): CreWorkflow {
    return {
      workflowId: String(w.workflowId ?? w.id ?? w.workflow_id ?? ""),
      workflowName: String(w.name ?? w.workflowName ?? ""),
      registry: String(w.registry ?? w.deploymentRegistry ?? "private"),
      status: String(w.status ?? "UNKNOWN"),
      binaryHash: (w.binaryHash as string) ?? (w.workflowHash as string) ?? null,
      lastExecutionAtMs: w.lastExecution ? this.toMs(w.lastExecution) : null,
      totalRuns: typeof w.totalRuns === "number" ? w.totalRuns : null,
      successCount: typeof w.successCount === "number" ? w.successCount : null,
      failureCount: typeof w.failureCount === "number" ? w.failureCount : null,
      // Came from the user's authenticated CLI, so it is LIVE by definition.
      provenance: "LIVE",
    };
  }

  private toExecution(e: Record<string, unknown>, workflowId: string): CreExecution {
    const status = String(e.status ?? "TRIGGERED").toUpperCase();
    return {
      executionId: String(e.executionId ?? e.id ?? ""),
      workflowId: String(e.workflowId ?? workflowId),
      status: (["TRIGGERED", "IN_PROGRESS", "SUCCESS", "FAILURE"] as const).includes(status as never) ? (status as CreExecution["status"]) : "TRIGGERED",
      startedAtMs: this.toMs(e.startedAt ?? e.start ?? e.timestamp),
      endedAtMs: e.endedAt || e.end ? this.toMs(e.endedAt ?? e.end) : null,
      provenance: "LIVE",
    };
  }

  private toMs(v: unknown): number {
    if (typeof v === "number") return v > 1e12 ? v : v * 1000;
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
    return Date.now();
  }
}

/**
 * Lift uint64 chain selectors out of CLI JSON as strings.
 *
 * `JSON.parse` corrupts every one of them — see FND-V2-E-002. Exported here so anything reading
 * supported-chains from this provider uses the same safe path.
 */
export function parseSupportedChains(raw: string): Array<{ chainName: string; chainSelector: string; forwarder: string }> {
  const out: Array<{ chainName: string; chainSelector: string; forwarder: string }> = [];
  const re = /"chainName"\s*:\s*"([^"]+)"\s*,\s*"chainSelector"\s*:\s*(\d+)\s*,\s*"address"\s*:\s*"([^"]+)"/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) out.push({ chainName: m[1]!, chainSelector: m[2]!, forwarder: m[3]! });
  return out;
}
