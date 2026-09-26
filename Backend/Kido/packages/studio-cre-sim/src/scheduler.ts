import { z } from "zod";
import type { CreRuntimeProvider, SimulationEvent, TriggerKind } from "./provider.js";

/**
 * The ContextLock test scheduler, and the HTTP trigger gateway.
 *
 * Two things §P26.8 and §P26.9 insist on, both of which are about not overstating what happened.
 *
 * CRON IS NOT A DON SCHEDULE. The CRE simulator executes a cron handler immediately when invoked;
 * it does not sit there ticking on the workflow's schedule. So ContextLock runs its own interval and
 * invokes the simulator, and every label says **"Cron trigger simulated by ContextLock scheduler"**
 * rather than "CRE DON cron running". The behaviour is a reasonable approximation; the claim would
 * not be.
 *
 * THE SIMULATOR'S PORT IS NOT A PUBLIC ENDPOINT. `--http-trigger-port` opens a local listener with
 * no authentication, no rate limit and no schema validation, because it is a development tool.
 * Exposing it would hand anyone on the network the ability to trigger an agent. Traffic goes
 * through a gateway that validates first.
 */

export const CRON_SIMULATION_LABEL = "Cron trigger simulated by ContextLock scheduler" as const;
/** The label that must never appear for a simulated schedule. */
export const FORBIDDEN_CRON_LABEL = "CRE DON cron running" as const;

export const ScheduledTriggerSchema = z.object({
  simulationId: z.string(),
  deploymentId: z.string(),
  /** Milliseconds between invocations, floored at CRE's own fastest cron interval. */
  intervalMs: z.number().int().min(30_000),
  triggerIndex: z.number().int().nonnegative(),
  enabled: z.boolean(),
  lastRunAtMs: z.number().int().positive().nullable(),
  runs: z.number().int().nonnegative(),
});
export type ScheduledTrigger = z.infer<typeof ScheduledTriggerSchema>;

/**
 * CRE's documented fastest cron interval, from `cre workflow limits export`:
 * `CRONTrigger.FastestScheduleInterval = 30s`.
 *
 * Enforced here so a test schedule cannot be faster than production would allow — a simulation that
 * fires every second tells you nothing about a workflow that can only fire every thirty.
 */
export const FASTEST_CRON_INTERVAL_MS = 30_000;

export const SCHEDULER_REASONS = {
  TOO_FAST: "CRON_INTERVAL_BELOW_CRE_MINIMUM",
  NOT_FOUND: "SCHEDULED_TRIGGER_NOT_FOUND",
} as const;

export class SchedulerError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "SchedulerError";
  }
}

export class CreSimulationScheduler {
  private readonly triggers = new Map<string, ScheduledTrigger>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly provider: CreRuntimeProvider,
    private readonly nowMs: () => number = Date.now,
    private readonly onEvent?: (e: SimulationEvent) => void,
  ) {}

  schedule(t: Omit<ScheduledTrigger, "lastRunAtMs" | "runs">): ScheduledTrigger {
    if (t.intervalMs < FASTEST_CRON_INTERVAL_MS) {
      throw new SchedulerError(
        SCHEDULER_REASONS.TOO_FAST,
        `${t.intervalMs}ms is faster than CRE's documented minimum cron interval of ${FASTEST_CRON_INTERVAL_MS}ms. A simulation that fires faster than production allows does not test production.`,
      );
    }
    const trigger: ScheduledTrigger = { ...t, lastRunAtMs: null, runs: 0 };
    this.triggers.set(t.simulationId, trigger);
    return trigger;
  }

  /** Fire once, now. What the interval calls, and what a test calls directly. */
  async tick(simulationId: string): Promise<{ exitCode: number; events: SimulationEvent[]; label: string }> {
    const t = this.triggers.get(simulationId);
    if (!t) throw new SchedulerError(SCHEDULER_REASONS.NOT_FOUND, simulationId);
    const out = await this.provider.invoke(simulationId, { kind: "CRON_SCHEDULED_BY_CONTEXTLOCK" });
    t.lastRunAtMs = this.nowMs();
    t.runs += 1;
    for (const e of out.events) this.onEvent?.(e);
    // The label travels with the result, so whatever renders it cannot substitute a better-sounding
    // sentence without deleting this one.
    return { ...out, label: CRON_SIMULATION_LABEL };
  }

  start(simulationId: string): void {
    const t = this.triggers.get(simulationId);
    if (!t || this.timers.has(simulationId)) return;
    const timer = setInterval(() => void this.tick(simulationId).catch(() => undefined), t.intervalMs);
    timer.unref?.();
    this.timers.set(simulationId, timer);
  }

  stop(simulationId: string): void {
    const timer = this.timers.get(simulationId);
    if (timer) clearInterval(timer);
    this.timers.delete(simulationId);
  }

  get(simulationId: string): ScheduledTrigger | null {
    return this.triggers.get(simulationId) ?? null;
  }
}

/* ─────────────────────── the HTTP trigger gateway ─────────────────────── */

export const TRIGGER_GATEWAY_REASONS = {
  UNKNOWN_DEPLOYMENT: "TRIGGER_UNKNOWN_DEPLOYMENT",
  PAYLOAD_TOO_LARGE: "TRIGGER_PAYLOAD_TOO_LARGE",
  SCHEMA_INVALID: "TRIGGER_PAYLOAD_SCHEMA_INVALID",
  RATE_LIMITED: "TRIGGER_RATE_LIMITED",
  UNAUTHENTICATED: "TRIGGER_UNAUTHENTICATED",
  REPLAY: "TRIGGER_IDEMPOTENCY_REPLAY",
} as const;
export type TriggerGatewayReason = (typeof TRIGGER_GATEWAY_REASONS)[keyof typeof TRIGGER_GATEWAY_REASONS];

export class TriggerGatewayError extends Error {
  constructor(readonly reason: TriggerGatewayReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "TriggerGatewayError";
  }
}

/**
 * From `cre workflow limits export`: `HTTPTrigger.RateLimit = every30s:1`.
 *
 * Mirrored rather than invented, so the gateway does not let through traffic the real thing would
 * reject — which would make a passing simulation misleading.
 */
export const HTTP_TRIGGER_RATE_LIMIT = { windowMs: 30_000, max: 1 } as const;
export const MAX_TRIGGER_PAYLOAD_BYTES = 100 * 1024;

export interface TriggerRequest {
  projectId: string;
  deploymentId: string;
  simulationId: string;
  payload: unknown;
  idempotencyKey: string;
  actorId: string | null;
}

/**
 * The gateway in front of the simulator's local port.
 *
 * Validates project, deployment, size, schema, rate and idempotency before anything reaches the
 * CLI. The simulator's own listener stays bound to localhost and is never the public surface.
 */
export class TriggerGateway {
  private readonly recent = new Map<string, number[]>();
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly provider: CreRuntimeProvider,
    private readonly knownDeployments: () => ReadonlySet<string>,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async submit(req: TriggerRequest, schema?: z.ZodType): Promise<{ accepted: true; exitCode: number; events: SimulationEvent[] }> {
    if (!req.actorId) throw new TriggerGatewayError(TRIGGER_GATEWAY_REASONS.UNAUTHENTICATED, "a trigger must name an authenticated caller");
    if (!this.knownDeployments().has(req.deploymentId)) {
      throw new TriggerGatewayError(TRIGGER_GATEWAY_REASONS.UNKNOWN_DEPLOYMENT, req.deploymentId);
    }

    const size = Buffer.byteLength(JSON.stringify(req.payload ?? null), "utf8");
    if (size > MAX_TRIGGER_PAYLOAD_BYTES) {
      throw new TriggerGatewayError(TRIGGER_GATEWAY_REASONS.PAYLOAD_TOO_LARGE, `${size} bytes exceeds ${MAX_TRIGGER_PAYLOAD_BYTES}`);
    }
    if (schema) {
      const parsed = schema.safeParse(req.payload);
      if (!parsed.success) throw new TriggerGatewayError(TRIGGER_GATEWAY_REASONS.SCHEMA_INVALID, parsed.error.issues.map((i) => i.message).join("; "));
    }

    const now = this.nowMs();
    const key = `${req.deploymentId}:${req.simulationId}`;
    const window = (this.recent.get(key) ?? []).filter((t) => now - t < HTTP_TRIGGER_RATE_LIMIT.windowMs);
    if (window.length >= HTTP_TRIGGER_RATE_LIMIT.max) {
      throw new TriggerGatewayError(
        TRIGGER_GATEWAY_REASONS.RATE_LIMITED,
        `CRE's own HTTP trigger limit is ${HTTP_TRIGGER_RATE_LIMIT.max} per ${HTTP_TRIGGER_RATE_LIMIT.windowMs / 1000}s; letting more through would make this simulation unrepresentative`,
      );
    }

    const idemKey = `${key}:${req.idempotencyKey}`;
    const before = this.seen.get(idemKey);
    if (before !== undefined) {
      throw new TriggerGatewayError(TRIGGER_GATEWAY_REASONS.REPLAY, `idempotency key already used at ${new Date(before).toISOString()}`);
    }
    this.seen.set(idemKey, now);
    window.push(now);
    this.recent.set(key, window);

    const out = await this.provider.invoke(req.simulationId, { kind: "HTTP", payload: req.payload });
    return { accepted: true, ...out };
  }
}

/* ─────────────────────── EVM log triggers ─────────────────────── */

/**
 * Which chains a log trigger may watch.
 *
 * §P26.10: a mainnet log MAY trigger a simulation. It may not create mainnet execution authority.
 * Those are different permissions, which is exactly why `NetworkRole` exists — the trigger source
 * is a `READ_ONLY_SOURCE` and the execution target is a `TESTNET_EXECUTION`, and nothing converts
 * one into the other.
 */
export function assertLogTriggerSourceAllowed(source: { chainId: number; role: string }, blueprintAllowsMainnetObservation: boolean): void {
  if (source.role === "READ_ONLY_SOURCE" && !blueprintAllowsMainnetObservation) {
    throw new TriggerGatewayError(
      TRIGGER_GATEWAY_REASONS.UNKNOWN_DEPLOYMENT,
      `chain ${source.chainId} is a read-only source and this Blueprint does not declare a mainnet observation trigger. Watching it would make the agent react to data it was not designed around.`,
    );
  }
}
