import { z } from "zod";
import {
  CreSimulationIdSchema, CRE_SIMULATION_ID_PREFIX,
  type BroadcastMode, type CreExecutionMode, type LimitsMode, type NetworkRef,
} from "@contextlock/studio-network";

/**
 * The CRE runtime provider.
 *
 * One interface, and the primary implementation drives the **official** `cre workflow simulate`.
 * §P26.3 is explicit that we do not write our own CRE engine as the primary provider, and the
 * reason is the same one that made P22 build the WASM once: a reimplementation agrees with the real
 * thing until the day it matters.
 */

export const SIM_STATES = [
  "PREPARING",
  "STARTING",
  "RUNNING",
  /** Alive, but not producing the heartbeats or events we expect. */
  "STALE",
  /** The CLI wants a login. Distinct from crashed — the fix is different. */
  "AUTH_REQUIRED",
  "CRASHED",
  "RESTARTING",
  "STOPPED",
] as const;
export const SimStateSchema = z.enum(SIM_STATES);
export type SimState = z.infer<typeof SimStateSchema>;

/** How a simulation run is triggered. Each maps onto real CLI flags. */
export const TRIGGER_KINDS = ["MANUAL", "CRON_SCHEDULED_BY_CONTEXTLOCK", "HTTP", "EVM_LOG_ONESHOT", "EVM_LOG_LISTEN"] as const;
export const TriggerKindSchema = z.enum(TRIGGER_KINDS);
export type TriggerKind = z.infer<typeof TriggerKindSchema>;

export const SimulationConfigSchema = z.object({
  deploymentId: z.string().min(1),
  projectId: z.string().min(1),
  mode: z.enum(["SIMULATED_PLATFORM", "SIMULATED_USER"]),
  /** The workflow project directory. `cre workflow simulate` takes a folder, not an id. */
  projectDir: z.string().min(1),
  target: z.string().nullable(),

  /* ── the exact artifact, pinned (§P26.5) ─────────────────────────────────── */
  workflowSourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  wasmSha256: z.string().regex(/^[0-9a-f]{64}$/),
  workflowConfigHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  blueprintRevision: z.number().int().nonnegative(),
  strategyRevision: z.number().int().nonnegative(),
  adapterVersions: z.record(z.string(), z.string()),
  creCliVersion: z.string().min(1),

  limitsMode: z.enum(["PRODUCTION_DEFAULT", "PRODUCTION_FILE", "NONE"]),
  limitsFile: z.string().nullable(),
  broadcastMode: z.enum(["DRY_RUN", "TESTNET_BROADCAST"]),
  /** Null in DRY_RUN. Required, and validated, for a broadcast. */
  broadcastNetwork: z.object({ chainId: z.number().int().positive(), role: z.literal("TESTNET_EXECUTION") }).nullable(),
  triggerKind: TriggerKindSchema,
  triggerIndex: z.number().int().nonnegative().nullable(),
  httpTriggerPort: z.number().int().positive().nullable(),
});
export type SimulationConfig = z.infer<typeof SimulationConfigSchema>;

export interface SimulationSession {
  simulationId: string;
  config: SimulationConfig;
  state: SimState;
  startedAtMs: number | null;
  lastEventAtMs: number | null;
  restarts: number;
  /** The exact argv that was executed. Recorded so a claim about how it ran is checkable. */
  commandLine: string[];
  exitCode: number | null;
  detail: string | null;
}

export const SimulationEventSchema = z.object({
  simulationId: z.string(),
  type: z.enum([
    "CRE_SIM_STARTED",
    "CRE_SIM_TRIGGER_RECEIVED",
    "CRE_SIM_EXECUTION_STARTED",
    "CRE_SIM_RESULT",
    "CRE_SIM_WRITE_DRY_RUN",
    "CRE_SIM_TESTNET_BROADCAST",
    "CRE_SIM_ERROR",
    "CRE_SIM_RESTARTED",
    "CRE_SIM_STOPPED",
  ]),
  atMs: z.number().int().positive(),
  /** Bounded and sanitized. Provider output is not stored raw. */
  message: z.string().max(2000),
  detail: z.record(z.string(), z.unknown()),
});
export type SimulationEvent = z.infer<typeof SimulationEventSchema>;

/**
 * Event types a simulation may emit.
 *
 * `CRE_DEPLOYED` is deliberately absent, and named here so its absence is testable. A simulation
 * that emitted a deployment event would put a false claim into the audit log, where it would be
 * indistinguishable from a true one.
 */
export const FORBIDDEN_SIM_EVENT_TYPES = ["CRE_DEPLOYED", "CRE_WORKFLOW_DEPLOYED", "CRE_DON_EXECUTION", "CRE_TEE_ATTESTED"] as const;

export interface CreRuntimeProvider {
  readonly id: string;
  readonly mode: CreExecutionMode;
  prepare(config: SimulationConfig): Promise<SimulationSession>;
  start(simulationId: string): Promise<SimulationSession>;
  stop(simulationId: string): Promise<SimulationSession>;
  restart(simulationId: string): Promise<SimulationSession>;
  getStatus(simulationId: string): Promise<SimulationSession>;
  /** One-shot invocation. Returns when the CLI exits. */
  invoke(simulationId: string, trigger: { kind: TriggerKind; payload?: unknown; txHash?: string; eventIndex?: number }): Promise<{ exitCode: number; events: SimulationEvent[] }>;
  getEvents(simulationId: string, sinceMs?: number): Promise<SimulationEvent[]>;
  destroy(simulationId: string): Promise<void>;
}

export const newSimulationId = (projectId: string, uuid: string): string =>
  `${CRE_SIMULATION_ID_PREFIX}${projectId}/session/${uuid}`;

export const SIM_REASONS = {
  ARTIFACT_DRIFT: "CRE_SIM_ARTIFACT_DRIFT",
  NOT_PREPARED: "CRE_SIM_NOT_PREPARED",
  ALREADY_RUNNING: "CRE_SIM_ALREADY_RUNNING",
  CLI_MISSING: "CRE_SIM_CLI_UNAVAILABLE",
  AUTH_REQUIRED: "CRE_SIM_AUTH_REQUIRED",
  WRONG_MODE: "CRE_SIM_OPERATION_WRONG_FOR_MODE",
} as const;
export type SimReason = (typeof SIM_REASONS)[keyof typeof SIM_REASONS];

export class SimulationError extends Error {
  constructor(readonly reason: SimReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "SimulationError";
  }
}

/**
 * The artifact must be the one that was approved.
 *
 * §P26.5: simulation must not silently compile an unrelated revision. Same discipline as P23's CRE
 * deployment — the point of simulating is to learn about the thing you are going to run.
 */
export function assertArtifactMatches(config: SimulationConfig, approved: { wasmSha256: string; workflowSourceHash: string; workflowConfigHash: string }): void {
  const drift: string[] = [];
  if (config.wasmSha256 !== approved.wasmSha256) drift.push(`WASM sha256: approved ${approved.wasmSha256}, configured ${config.wasmSha256}`);
  if (config.workflowSourceHash !== approved.workflowSourceHash) drift.push(`source tree: approved ${approved.workflowSourceHash}, configured ${config.workflowSourceHash}`);
  if (config.workflowConfigHash !== approved.workflowConfigHash) drift.push(`config: approved ${approved.workflowConfigHash}, configured ${config.workflowConfigHash}`);
  if (drift.length > 0) {
    throw new SimulationError(SIM_REASONS.ARTIFACT_DRIFT, `the simulation would run a different artifact than the one reviewed:\n  ${drift.join("\n  ")}`);
  }
}
