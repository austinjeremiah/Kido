import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Control operations, as typed commands.
 *
 * §25.31: do not call controls directly from React components. The reason is not architectural
 * tidiness. A control invoked from a component is a control whose authorization, idempotency and
 * expected-revision checks live in the browser, which is to say nowhere.
 *
 * So every operation is a `ControlCommand`: a value the frontend constructs and the backend
 * validates. Three fields do the security work.
 *
 *   `expectedRevision` — the revision the operator was LOOKING AT. If the deployment has moved
 *   since the page rendered, the command is stale and is rejected. Without it, an operator clicks
 *   "pause" on a screen showing revision 3 and pauses revision 4, which someone else just started.
 *
 *   `idempotencyKey` — the same intent submitted twice is one operation. Two operators hitting
 *   Emergency Lock simultaneously must not produce contradictory state.
 *
 *   `authorization` — a capability the ACTOR holds, checked server-side. §25.30 is explicit that
 *   P25 must enforce this now, before P26's richer team model exists.
 */

export const CONTROL_COMMAND_VERSION = "contextlock.control-command/v1" as const;

/**
 * Operator capabilities.
 *
 * Split by what they can destroy, not by convenience. `RUNTIME_CONTROL` and `POLICY_CONTROL` are
 * separate because pausing a container and withdrawing financial authority are different powers,
 * and an on-call engineer who should have the first does not automatically need the second.
 */
export const OPERATOR_CAPABILITIES = [
  "VIEW",
  "RUNTIME_CONTROL",
  "CRE_CONTROL",
  "POLICY_CONTROL",
  "IDENTITY_CONTROL",
  "EMERGENCY_CONTROL",
] as const;
export const OperatorCapabilitySchema = z.enum(OPERATOR_CAPABILITIES);
export type OperatorCapability = z.infer<typeof OperatorCapabilitySchema>;

export const CONTROL_OPERATIONS = [
  "PAUSE_RUNTIME",
  "RESUME_RUNTIME",
  "ROLLBACK_RUNTIME",
  "ROTATE_RUNTIME_REVISION",
  "PAUSE_CRE",
  "ACTIVATE_CRE",
  "DELETE_CRE",
  "DISABLE_POLICY",
  "ENABLE_POLICY",
  "REVOKE_IDENTITY",
  "EMERGENCY_LOCK",
] as const;
export const ControlOperationSchema = z.enum(CONTROL_OPERATIONS);
export type ControlOperation = z.infer<typeof ControlOperationSchema>;

/**
 * Which capability each operation needs, and which layer it affects.
 *
 * `affects` is not decoration — §25.32 requires the UI to state which layer a control touches, and
 * a table is the only way that stays true when someone adds an operation.
 */
export const OPERATION_REQUIREMENTS: Record<ControlOperation, { capability: OperatorCapability; affects: string; destructive: boolean; isFinancialStop: boolean }> = {
  PAUSE_RUNTIME:           { capability: "RUNTIME_CONTROL",   affects: "the agent process only", destructive: false, isFinancialStop: false },
  RESUME_RUNTIME:          { capability: "RUNTIME_CONTROL",   affects: "the agent process only", destructive: false, isFinancialStop: false },
  ROLLBACK_RUNTIME:        { capability: "RUNTIME_CONTROL",   affects: "which image revision runs", destructive: false, isFinancialStop: false },
  ROTATE_RUNTIME_REVISION: { capability: "RUNTIME_CONTROL",   affects: "which image revision runs", destructive: false, isFinancialStop: false },
  PAUSE_CRE:               { capability: "CRE_CONTROL",       affects: "the workflow's response to triggers", destructive: false, isFinancialStop: false },
  ACTIVATE_CRE:            { capability: "CRE_CONTROL",       affects: "the workflow's response to triggers", destructive: false, isFinancialStop: false },
  DELETE_CRE:              { capability: "CRE_CONTROL",       affects: "the workflow registration, permanently", destructive: true, isFinancialStop: false },
  DISABLE_POLICY:          { capability: "POLICY_CONTROL",    affects: "this agent's authority to move value", destructive: false, isFinancialStop: true },
  ENABLE_POLICY:           { capability: "POLICY_CONTROL",    affects: "this agent's authority to move value", destructive: false, isFinancialStop: false },
  REVOKE_IDENTITY:         { capability: "IDENTITY_CONTROL",  affects: "the agent's onchain identity binding", destructive: true, isFinancialStop: false },
  EMERGENCY_LOCK:          { capability: "EMERGENCY_CONTROL", affects: "policy, capabilities, CRE and runtime, in that order", destructive: false, isFinancialStop: true },
};

export const ActorSchema = z.object({
  actorId: z.string().min(1),
  displayName: z.string().min(1),
  capabilities: z.array(OperatorCapabilitySchema),
});
export type Actor = z.infer<typeof ActorSchema>;

export const ControlCommandSchema = z.object({
  schemaVersion: z.literal(CONTROL_COMMAND_VERSION),
  commandId: z.string().min(1),
  projectId: z.string().min(1),
  deploymentId: z.string().min(1),
  actor: ActorSchema,
  operation: ControlOperationSchema,
  /** What the operation acts on: a runtime revision, a workflow name, a policy hash. */
  target: z.object({
    agentId: z.string().nullable(),
    runtimeRevision: z.string().nullable(),
    creWorkflowName: z.string().nullable(),
    policyHash: z.string().nullable(),
    identityNode: z.string().nullable(),
  }),
  /** The deployment revision the operator was looking at. Stale means reject. */
  expectedRevision: z.string().min(1),
  issuedAtMs: z.number().int().positive(),
  expiresAtMs: z.number().int().positive(),
  idempotencyKey: z.string().min(8),
  /** Free-form confirmation payload for destructive operations. Validated per-operation. */
  confirmation: z.record(z.string(), z.unknown()).nullable(),
  /** Public-safe. Never a signature, never a key — see the redaction scanner. */
  reason: z.string().max(500).nullable(),
});
export type ControlCommand = z.infer<typeof ControlCommandSchema>;

export const COMMAND_REASONS = {
  NOT_AUTHORIZED: "CONTROL-NOT-AUTHORIZED",
  STALE_REVISION: "CONTROL-STALE-REVISION",
  EXPIRED: "CONTROL-COMMAND-EXPIRED",
  MALFORMED: "CONTROL-COMMAND-MALFORMED",
  CONFIRMATION_REQUIRED: "CONTROL-DESTRUCTIVE-CONFIRMATION-REQUIRED",
  PRECONDITION_FAILED: "CONTROL-PRECONDITION-FAILED",
  CRE_REQUIRED_NOT_DEPLOYED: "CRE_REQUIRED_NOT_DEPLOYED",
  EMERGENCY_LOCK_ACTIVE: "CONTROL-EMERGENCY-LOCK-ACTIVE",
} as const;
export type CommandReason = (typeof COMMAND_REASONS)[keyof typeof COMMAND_REASONS];

export class ControlCommandError extends Error {
  constructor(readonly reason: CommandReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ControlCommandError";
  }
}

export function newCommand(args: Omit<ControlCommand, "schemaVersion" | "commandId" | "idempotencyKey"> & { idempotencyKey?: string }): ControlCommand {
  const commandId = `cmd_${randomUUID()}`;
  return {
    schemaVersion: CONTROL_COMMAND_VERSION,
    commandId,
    ...args,
    // Derived from the INTENT, not from the command id — so the same intent submitted twice
    // collides deliberately, which is what makes a double-click a single operation.
    idempotencyKey:
      args.idempotencyKey ??
      `idem_${createHash("sha256").update(JSON.stringify([args.deploymentId, args.operation, args.target, args.expectedRevision])).digest("hex").slice(0, 32)}`,
  };
}

/**
 * Validate a command before anything happens.
 *
 * Order matters. Authorization first, because an unauthorized actor should learn nothing about the
 * deployment's current revision from the error they get back.
 */
export function assertCommandValid(
  cmd: ControlCommand,
  ctx: { currentRevision: string; nowMs: number; emergencyLockActive?: boolean },
): void {
  const parsed = ControlCommandSchema.safeParse(cmd);
  if (!parsed.success) {
    throw new ControlCommandError(COMMAND_REASONS.MALFORMED, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }

  const req = OPERATION_REQUIREMENTS[cmd.operation];
  if (!cmd.actor.capabilities.includes(req.capability)) {
    throw new ControlCommandError(
      COMMAND_REASONS.NOT_AUTHORIZED,
      `${cmd.operation} requires the ${req.capability} capability; ${cmd.actor.displayName} holds [${cmd.actor.capabilities.join(", ") || "none"}]`,
    );
  }

  if (ctx.nowMs > cmd.expiresAtMs) {
    throw new ControlCommandError(COMMAND_REASONS.EXPIRED, `issued ${new Date(cmd.issuedAtMs).toISOString()}, expired ${new Date(cmd.expiresAtMs).toISOString()}`);
  }

  if (cmd.expectedRevision !== ctx.currentRevision) {
    throw new ControlCommandError(
      COMMAND_REASONS.STALE_REVISION,
      `this command was issued against deployment revision ${cmd.expectedRevision}, which is no longer current (${ctx.currentRevision}). Reload and re-issue: the screen you acted on described a different deployment.`,
    );
  }

  if (req.destructive && cmd.confirmation === null) {
    throw new ControlCommandError(COMMAND_REASONS.CONFIRMATION_REQUIRED, `${cmd.operation} is destructive and requires explicit confirmation`);
  }

  /*
   * While an emergency lock is in force, everything that would restore capability is refused.
   * Deliberately narrow: pausing, stopping and re-disabling stay available, because an operator
   * responding to an incident must not be locked out of making things safer.
   */
  if (ctx.emergencyLockActive && (cmd.operation === "ENABLE_POLICY" || cmd.operation === "ACTIVATE_CRE" || cmd.operation === "RESUME_RUNTIME")) {
    throw new ControlCommandError(
      COMMAND_REASONS.EMERGENCY_LOCK_ACTIVE,
      `${cmd.operation} is refused while an emergency lock is in force. Clear the lock explicitly first.`,
    );
  }
}

/* ─────────────────────────── idempotent execution ─────────────────────────── */

export interface CommandRecord {
  commandId: string;
  idempotencyKey: string;
  operation: ControlOperation;
  actorId: string;
  issuedAtMs: number;
  completedAtMs: number | null;
  outcome: "PENDING" | "APPLIED" | "REJECTED" | "FAILED";
  detail: string | null;
  /** Whatever the operation produced, for a caller replaying the same key. */
  result: unknown;
}

/**
 * The command log.
 *
 * Idempotency keyed on intent. A replay of a completed command returns the ORIGINAL result rather
 * than performing it again — LIVE-036 — and a replay of one still in flight is refused rather than
 * racing it.
 */
export class CommandLog {
  private readonly byKey = new Map<string, CommandRecord>();
  private readonly byId = new Map<string, CommandRecord>();

  /** Returns an existing record when this intent has been seen, else null and reserves the key. */
  begin(cmd: ControlCommand, nowMs: number): CommandRecord | null {
    const existing = this.byKey.get(cmd.idempotencyKey);
    if (existing) return existing;
    const rec: CommandRecord = {
      commandId: cmd.commandId, idempotencyKey: cmd.idempotencyKey, operation: cmd.operation,
      actorId: cmd.actor.actorId, issuedAtMs: nowMs, completedAtMs: null, outcome: "PENDING", detail: null, result: null,
    };
    this.byKey.set(cmd.idempotencyKey, rec);
    this.byId.set(cmd.commandId, rec);
    return null;
  }

  complete(cmd: ControlCommand, outcome: CommandRecord["outcome"], detail: string, result: unknown, nowMs: number): CommandRecord {
    const rec = this.byKey.get(cmd.idempotencyKey);
    if (!rec) throw new ControlCommandError(COMMAND_REASONS.MALFORMED, `no in-flight record for ${cmd.commandId}`);
    rec.outcome = outcome;
    rec.detail = detail;
    rec.result = result;
    rec.completedAtMs = nowMs;
    return rec;
  }

  get(commandId: string): CommandRecord | null {
    return this.byId.get(commandId) ?? null;
  }

  byIdempotencyKey(key: string): CommandRecord | null {
    return this.byKey.get(key) ?? null;
  }

  all(): CommandRecord[] {
    return [...this.byId.values()].sort((a, b) => a.issuedAtMs - b.issuedAtMs);
  }
}

/**
 * What a runtime pause is entitled to claim.
 *
 * §25.32. The sentence a status screen wants to print after stopping a container is "treasury
 * secured", and it is false: the onchain policy is untouched and any capability already issued
 * remains valid. This returns the honest text and refuses to produce the dishonest one.
 */
export function runtimePauseClaim(policyEnabledOnChain: boolean | null): { runtimeStopped: true; financiallySecured: boolean; message: string; warning: string | null } {
  if (policyEnabledOnChain === null) {
    return {
      runtimeStopped: true, financiallySecured: false,
      message: "The runtime is paused.",
      warning: "The ContextLock policy state could not be read, so it is UNKNOWN whether this agent still has authority to move value. Pausing a runtime is an operational control, not a financial one.",
    };
  }
  return {
    runtimeStopped: true,
    financiallySecured: !policyEnabledOnChain,
    message: "The runtime is paused.",
    warning: policyEnabledOnChain
      ? "The ContextLock policy is still ENABLED. This agent's authority to move value has not been withdrawn, and any capability already issued remains valid. Pausing a runtime is an operational control; to stop financial execution, disable the policy."
      : null,
  };
}
