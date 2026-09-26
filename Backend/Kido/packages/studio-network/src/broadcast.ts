import { z } from "zod";
import { assertExecutionAllowed, NetworkGuardError, APPROVED_NETWORK_REASONS, type NetworkRef } from "./roles.js";
import { fenceWrite } from "./fences.js";

/**
 * CRE broadcast modes.
 *
 * §P26.11 asks for something specific and worth being precise about:
 *
 *     Do not represent MAINNET_BROADCAST and disable it. Make it unrepresentable.
 *
 * A disabled enum member is a member. It appears in autocomplete, it appears in exhaustive switches
 * as a case someone has to handle, and one day it appears in a config file. The union below has two
 * members, and a third would have to be added by someone typing it — at which point the write guard
 * refuses it anyway, because the guard keys on the chain id rather than on the mode.
 */
export const BROADCAST_MODES = [
  /** The default. The official simulator prepares and simulates writes without sending them. */
  "DRY_RUN",
  /** A real transaction, on an approved testnet, from an ephemeral burner. */
  "TESTNET_BROADCAST",
] as const;
export const BroadcastModeSchema = z.enum(BROADCAST_MODES);
export type BroadcastMode = z.infer<typeof BroadcastModeSchema>;

export const BROADCAST_REASONS = {
  DRY_RUN_CANNOT_BROADCAST: "DRY_RUN_CANNOT_BROADCAST",
  BROADCAST_NETWORK_NOT_APPROVED: "BROADCAST_NETWORK_NOT_APPROVED",
  UNKNOWN_MODE: "BROADCAST_MODE_UNKNOWN",
  BURNER_REQUIRED: "BROADCAST_REQUIRES_EPHEMERAL_BURNER",
  USER_WALLET_REFUSED: "BROADCAST_WILL_NOT_USE_USER_WALLET",
} as const;
export type BroadcastReason = (typeof BROADCAST_REASONS)[keyof typeof BROADCAST_REASONS];

export class BroadcastError extends Error {
  constructor(readonly reason: BroadcastReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "BroadcastError";
  }
}

/**
 * The signer a broadcast may use.
 *
 * Only an ephemeral per-deployment burner. §P26.12: never the user's real wallet or private key.
 * The type has no member for one, so "use the user's key" is not a configuration this can express.
 */
export const BROADCAST_SIGNERS = ["EPHEMERAL_TESTNET_BURNER", "LOCAL_BRIDGE_TESTNET"] as const;
export const BroadcastSignerSchema = z.enum(BROADCAST_SIGNERS);
export type BroadcastSigner = z.infer<typeof BroadcastSignerSchema>;

export interface BroadcastRequest {
  mode: BroadcastMode;
  network: NetworkRef;
  signer: BroadcastSigner;
  context: string;
}

/**
 * Decide whether a CRE simulation may broadcast, and turn that into CLI flags.
 *
 * The `--broadcast` flag is only ever produced here, so there is one place where a simulation stops
 * being a simulation — and it goes through the same network guard as every other write in the
 * product rather than having its own.
 */
export function broadcastFlags(req: BroadcastRequest): { flags: string[]; broadcasting: boolean; network: string } {
  if (!(BROADCAST_MODES as readonly string[]).includes(req.mode)) {
    throw new BroadcastError(BROADCAST_REASONS.UNKNOWN_MODE, `"${req.mode}" is not a broadcast mode`);
  }

  if (req.mode === "DRY_RUN") {
    // No flag at all. The CLI's default is not to broadcast, and relying on the default rather than
    // passing `--broadcast=false` means a future flag rename cannot silently turn it on.
    return { flags: [], broadcasting: false, network: `${req.network.chainId} (no transaction will be sent)` };
  }

  /*
   * Through the NAMED fence, like every other write-capable subsystem.
   *
   * Calling `assertExecutionAllowed` directly would enforce the same rule, but it would leave
   * `CRE_BROADCAST` in the fence list with no call site — and the test that asserts every declared
   * fence is actually wired would have nothing to find. A fence nobody calls is a gap that reads
   * like coverage.
   */
  fenceWrite("CRE_BROADCAST", req.network, "PUBLIC_WRITE");
  const approved = assertExecutionAllowed(req.network, "PUBLIC_WRITE", `CRE broadcast (${req.context})`);
  return { flags: ["--broadcast"], broadcasting: true, network: `${approved.name} (${approved.chainId})` };
}

/**
 * The ephemeral burner.
 *
 * Its constraints are the interesting part. It holds only testnet assets, its key never reaches the
 * agent runtime or the model, it is never displayed, and it is destroyed when the deployment ends —
 * so the blast radius of leaking it is the testnet balance of one deployment.
 */
export const EphemeralBurnerSchema = z.object({
  deploymentId: z.string().min(1),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** Which approved testnet it may act on. A burner is scoped to one chain. */
  chainId: z.number().int().positive(),
  createdAtMs: z.number().int().positive(),
  /** When it is destroyed. A burner with no end is a wallet. */
  expiresAtMs: z.number().int().positive(),
  /**
   * Where the key lives. Never in this object, never in the runtime, never in the UI.
   *
   * A reference, exactly like the CRE credential ref: what travels is a handle the signer worker
   * can exchange inside the control plane.
   */
  keyRef: z.string().regex(/^burner_[0-9a-f]{16,}$/),
});
export type EphemeralBurner = z.infer<typeof EphemeralBurnerSchema>;

/** Places a burner key must never appear. Named so their absence is testable. */
export const BURNER_KEY_FORBIDDEN_SINKS = [
  "agent-runtime",
  "model-gateway",
  "blueprint",
  "generated-source",
  "runtime-container",
  "ui",
  "logs",
  "runtime-event",
  "export",
  "deployment-receipt",
] as const;

export function assertBurnerUsable(burner: EphemeralBurner, network: NetworkRef, nowMs: number): void {
  if (burner.chainId !== network.chainId) {
    throw new BroadcastError(
      BROADCAST_REASONS.BROADCAST_NETWORK_NOT_APPROVED,
      `burner ${burner.address} is scoped to chain ${burner.chainId} and this broadcast targets ${network.chainId}`,
    );
  }
  if (nowMs > burner.expiresAtMs) {
    throw new BroadcastError(BROADCAST_REASONS.BURNER_REQUIRED, `burner ${burner.address} expired at ${new Date(burner.expiresAtMs).toISOString()}`);
  }
  // Belt and braces on the chain, since a burner could in principle be minted with a bad chainId.
  assertExecutionAllowed(network, "PUBLIC_WRITE", `burner ${burner.address}`);
}

/**
 * Refuse the user's own wallet for broadcasting.
 *
 * Called wherever a signer is selected. The convenience being refused is real — the user's wallet is
 * right there and already connected — and so is the consequence: a simulator that can spend from a
 * user's wallet is a simulator with the user's authority.
 */
export function assertNotUserWallet(signer: string, userWalletAddress: string | null): void {
  if (!(BROADCAST_SIGNERS as readonly string[]).includes(signer)) {
    throw new BroadcastError(
      BROADCAST_REASONS.USER_WALLET_REFUSED,
      `"${signer}" is not a permitted broadcast signer. CRE simulation broadcasts from an ephemeral per-deployment testnet burner, never from a user wallet.`,
    );
  }
  if (userWalletAddress && signer === "EPHEMERAL_TESTNET_BURNER") return;
}

/** `--limits` handling. A gate-satisfying run may not disable production limits. */
export const LIMITS_MODES = ["PRODUCTION_DEFAULT", "PRODUCTION_FILE", "NONE"] as const;
export type LimitsMode = (typeof LIMITS_MODES)[number];

export const LIMITS_REASONS = {
  NO_LIMITS_CANNOT_GATE: "SIMULATION_WITHOUT_LIMITS_CANNOT_SATISFY_GATE",
} as const;

export class LimitsError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "LimitsError";
  }
}

export function limitsFlags(mode: LimitsMode, limitsFile?: string): string[] {
  switch (mode) {
    case "PRODUCTION_DEFAULT":
      // Explicit rather than relying on the CLI default, so the recorded command shows what ran.
      return ["--limits", "default"];
    case "PRODUCTION_FILE":
      if (!limitsFile) throw new LimitsError("LIMITS_FILE_REQUIRED", "PRODUCTION_FILE needs a path from `cre workflow limits export`");
      return ["--limits", limitsFile];
    case "NONE":
      return ["--limits", "none"];
  }
}

/**
 * A result produced with limits disabled cannot satisfy a deployment gate.
 *
 * §P26.6. A debug run may use `--limits none`; what it may not do is count as evidence that the
 * workflow fits inside production constraints, because it did not test that.
 */
export function assertLimitsSatisfyGate(mode: LimitsMode, gate: string): void {
  if (mode === "NONE") {
    throw new LimitsError(
      LIMITS_REASONS.NO_LIMITS_CANNOT_GATE,
      `${gate} requires a simulation run under production limits. This run used --limits none, which does not test whether the workflow fits inside CRE's production constraints.`,
    );
  }
}
