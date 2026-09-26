import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * The ContextLock Bridge protocol.
 *
 * The architecture this exists to make possible: a hosted Studio that never holds the user's
 * high-value credentials. The hosted side asks for an OPERATION; the user's own machine decides
 * whether to perform it and returns a result. Ledger seeds, CRE sessions and API keys stay local
 * and are never transmitted, not even encrypted, because the safest way to protect a secret from a
 * hosted service is for the hosted service never to receive it.
 *
 * Two properties carry the design:
 *
 *   The bridge exposes OPERATIONS, not access. There is no `getSecret`, no `runShell`, no
 *   `readEnv` — not disabled, absent. A compromised hosted agent can ask for
 *   `credential.performApiRequest` against an allow-listed operation, and the worst it obtains is
 *   the answer that operation returns.
 *
 *   Every request is bound to what it does. The signature covers the payload hash, the operation,
 *   the project, the bridge and a nonce, so a captured request cannot be edited, re-aimed at
 *   another project, or replayed.
 */

export const BRIDGE_PROTOCOL_VERSION = "contextlock.bridge/v1" as const;

export const BRIDGE_REASONS = {
  UNKNOWN_OPERATION: "BRIDGE-UNKNOWN-OPERATION",
  OPERATION_NOT_AVAILABLE: "BRIDGE-OPERATION-NOT-AVAILABLE",
  NOT_PERMITTED: "BRIDGE-OPERATION-NOT-PERMITTED",
  BAD_SIGNATURE: "BRIDGE-BAD-SIGNATURE",
  PAYLOAD_MUTATED: "BRIDGE-PAYLOAD-MUTATED",
  REPLAY: "BRIDGE-REPLAY",
  EXPIRED: "BRIDGE-EXPIRED",
  NOT_YET_VALID: "BRIDGE-NOT-YET-VALID",
  WRONG_PROJECT: "BRIDGE-WRONG-PROJECT",
  WRONG_BRIDGE: "BRIDGE-WRONG-BRIDGE",
  WRONG_USER: "BRIDGE-WRONG-USER",
  NO_SESSION: "BRIDGE-NO-SESSION",
  SESSION_REVOKED: "BRIDGE-SESSION-REVOKED",
  PAIRING_USED: "BRIDGE-PAIRING-CODE-ALREADY-USED",
  PAIRING_EXPIRED: "BRIDGE-PAIRING-CODE-EXPIRED",
  PAIRING_UNKNOWN: "BRIDGE-PAIRING-CODE-UNKNOWN",
  CREDENTIAL_NOT_ALLOWED: "BRIDGE-CREDENTIAL-NOT-ALLOWED",
  HOST_NOT_ALLOWED: "BRIDGE-HOST-NOT-ALLOWED",
  APPROVAL_REQUIRED: "BRIDGE-HUMAN-APPROVAL-REQUIRED",
  HARDWARE_UNAVAILABLE: "BRIDGE-HARDWARE-UNAVAILABLE",
} as const;
export type BridgeReason = (typeof BRIDGE_REASONS)[keyof typeof BRIDGE_REASONS];

/**
 * The complete operation vocabulary.
 *
 * Closed, and short. Every entry names a task with a bounded result rather than a capability with
 * an open one — which is why `credential.performApiRequest` exists and `credential.get` does not.
 */
export const BRIDGE_OPERATIONS = [
  "cre.simulateWorkflow",
  /*
   * P22/P23 deployment operations.
   *
   * Each is a named task with a bounded result, following the same rule as everything above it:
   * the hosted side asks for an operation and receives an answer. `cre.status` returns status
   * FIELDS — never the session — and `cre.deployWorkflow` takes the sha256 of the exact approved
   * binary, so the bridge deploys the artifact that was reviewed or nothing at all.
   *
   * There is deliberately no `cre.runCommand`. Luna never executes arbitrary CRE lifecycle
   * commands with the user's credentials (§23.6), and the way to guarantee that is for the
   * vocabulary to contain no member that could.
   */
  "cre.status",
  "cre.buildWorkflow",
  "cre.deployWorkflow",
  "cre.workflowLifecycle",
  "ledger.approveContextLockAction",
  "ledger.performProtectedBrokerAction",
  "credential.performApiRequest",
] as const;
export type BridgeOperation = (typeof BRIDGE_OPERATIONS)[number];

/**
 * Operations that do not exist, named so their absence is testable.
 *
 * A request for one of these returns OPERATION_NOT_AVAILABLE rather than UNKNOWN_OPERATION: the
 * distinction tells an operator that something asked for raw access, which is worth seeing in a log.
 */
export const FORBIDDEN_OPERATIONS = new Set([
  "getSecret",
  "credential.get",
  "credential.reveal",
  "runShell",
  "shell.exec",
  "readEnv",
  "env.read",
  "dumpCRESession",
  "cre.exportSession",
  "getLedgerSeed",
  "ledger.exportSeed",
  "ledger.getPin",
  "fs.read",
  // Added with the deployment operations: the tempting shortcuts a deployment path invites, named
  // so that asking for one is a reported event rather than an unknown operation.
  "cre.runCommand",
  "cre.getApiKey",
  "cre.readConfig",
  "wallet.getPrivateKey",
  "wallet.exportKeystore",
  "docker.runCommand",
  "docker.socket",
]);

export const BridgeRequestSchema = z.object({
  protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
  requestId: z.string().min(8),
  bridgeId: z.string().min(8),
  userId: z.string().min(1),
  projectId: z.string().min(1),
  operationType: z.string().min(1),
  /** sha256 of the canonical payload. The payload itself travels beside it and must match. */
  payloadHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  issuedAtMs: z.number().int().positive(),
  expiresAtMs: z.number().int().positive(),
  nonce: z.string().min(16),
});
export type BridgeRequest = z.infer<typeof BridgeRequestSchema>;

export interface SignedBridgeRequest {
  request: BridgeRequest;
  payload: Record<string, unknown>;
  signature: string;
}

/** Deterministic serialization — keys sorted, so a re-ordered payload hashes identically. */
export function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v === undefined ? null : v;
    if (Array.isArray(v)) return v.map(walk);
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, walk(o[k])]));
  };
  return JSON.stringify(walk(value));
}

export const payloadHash = (payload: unknown): string =>
  `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}`;

/**
 * The signing input.
 *
 * Every field that determines what happens is in it. Leaving any one out would let that field be
 * edited in flight: without `projectId` a request could be re-aimed at another project, without
 * `payloadHash` its arguments could be rewritten, without `nonce` it could be replayed.
 */
export const signingInput = (r: BridgeRequest): string =>
  canonical({
    protocolVersion: r.protocolVersion,
    requestId: r.requestId,
    bridgeId: r.bridgeId,
    userId: r.userId,
    projectId: r.projectId,
    operationType: r.operationType,
    payloadHash: r.payloadHash,
    issuedAtMs: r.issuedAtMs,
    expiresAtMs: r.expiresAtMs,
    nonce: r.nonce,
  });

export const sign = (r: BridgeRequest, key: Buffer): string =>
  createHmac("sha256", key).update(signingInput(r)).digest("hex");

/** Constant-time, and length-checked first because timingSafeEqual throws on a length mismatch. */
export function verifySignature(r: BridgeRequest, key: Buffer, signature: string): boolean {
  const expected = Buffer.from(sign(r, key), "hex");
  let given: Buffer;
  try {
    given = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return timingSafeEqual(expected, given);
}

export const newNonce = () => randomBytes(16).toString("hex");
export const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;
