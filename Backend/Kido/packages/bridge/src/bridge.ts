import { randomBytes, createHash } from "node:crypto";
import {
  BRIDGE_OPERATIONS, BRIDGE_REASONS, BRIDGE_PROTOCOL_VERSION, FORBIDDEN_OPERATIONS,
  BridgeRequestSchema, payloadHash, verifySignature, newId,
  type BridgeOperation, type BridgeReason, type SignedBridgeRequest,
} from "./protocol.js";
import { checkUrl, type EgressPolicy } from "@contextlock/studio-openapi";

/**
 * The local bridge daemon.
 *
 * Runs on the user's machine. Holds nothing of the hosted service's, and gives it nothing of the
 * user's — it performs bounded operations and returns bounded results.
 */

export interface BridgePermissions {
  /** Default deny, at every level. An empty list permits nothing; it does not permit everything. */
  allowedProjects: string[];
  allowedOperations: BridgeOperation[];
  allowedCredentialRefs: string[];
  allowedHosts: string[];
  allowedApiOperationIds: string[];
  allowedCreWorkflows: string[];
  allowedLedgerActionTypes: string[];
  /** Operations above this value require a person at the keyboard, whatever the policy said. */
  humanApprovalAboveUsdCents: number;
}

export const DENY_ALL: BridgePermissions = {
  allowedProjects: [],
  allowedOperations: [],
  allowedCredentialRefs: [],
  allowedHosts: [],
  allowedApiOperationIds: [],
  allowedCreWorkflows: [],
  allowedLedgerActionTypes: [],
  humanApprovalAboveUsdCents: 0,
};

export interface BridgeSession {
  bridgeId: string;
  userId: string;
  projectId: string;
  key: Buffer;
  createdAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
  permissions: BridgePermissions;
}

export interface PairingCode {
  code: string;
  userId: string;
  projectId: string;
  expiresAtMs: number;
  usedAtMs: number | null;
}

export type BridgeOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: BridgeReason; detail: string };

const fail = (reason: BridgeReason, detail: string): BridgeOutcome<never> => ({ ok: false, reason, detail });

/** What a human sees before approving. Deliberately the facts that decide, not a summary. */
export interface ApprovalPrompt {
  projectId: string;
  operation: string;
  what: string;
  amountUsdCents: number | null;
  destination: string | null;
  policyReason: string;
  expiresAtMs: number;
}

export interface BridgeDeps {
  now: () => number;
  egress: EgressPolicy;
  /** Performs an approved outbound call. The credential is attached HERE and never leaves. */
  performApiCall?: (args: { url: string; credentialRef: string; operationId: string }) => Promise<{ status: number; body: unknown }>;
  /** Invokes the user's own `cre` session. Returns status and sanitized result only. */
  runCreWorkflow?: (workflow: string, args: Record<string, unknown>) => Promise<{ status: string; result: unknown }>;
  /**
   * The CRE deployment surface, backed by the user's own logged-in `cre` CLI.
   *
   * Four bounded tasks, not a command runner. `deploy` receives the sha256 of the binary that was
   * approved and the bridge re-hashes the file before invoking `cre workflow deploy --wasm`: if the
   * file on disk is not the file that was reviewed, nothing is deployed. Build-once/deploy-exactly
   * is enforced HERE, on the machine that holds the artifact, rather than trusted upstream.
   */
  creDeploy?: {
    status(): Promise<{ connected: boolean; organizationId: string | null; organizationName: string | null; accountLabel: string | null; deployAccess: boolean; registryIds: string[]; supportedChains: Array<{ chainName: string; chainSelector: string; forwarder: string }>; cliVersion: string }>;
    build(workflow: string): Promise<{ wasmPath: string; wasmBytes: number; wasmSha256: string; binaryHash: string; configHash: string; workflowHash: string; cliVersion: string }>;
    deploy(args: { workflow: string; wasmPath: string; registry: string }): Promise<{ workflowId: string; registry: string; status: string; binaryHash: string }>;
    lifecycle(args: { workflow: string; action: "get" | "pause" | "activate" | "list" }): Promise<{ status: string; detail: unknown }>;
    /** sha256 of a file on this machine. Used to prove the artifact has not been swapped. */
    hashFile(path: string): Promise<string>;
  };
  /** Present when a physical Ledger is attached. Absent is the normal case; see BLK-002. */
  ledger?: { approve: (actionType: string, digest: string) => Promise<{ approved: boolean; signature: string }> };
  /** Shows the prompt and waits. Absent means no human is available, so approval cannot be given. */
  askHuman?: (p: ApprovalPrompt) => Promise<boolean>;
}

export class LocalBridge {
  private readonly pairings = new Map<string, PairingCode>();
  private readonly sessions = new Map<string, BridgeSession>();
  /** Seen nonces, per session. Presence is what makes a replay detectable. */
  private readonly nonces = new Map<string, Set<string>>();

  constructor(private readonly deps: BridgeDeps) {}

  /* ── pairing ──────────────────────────────────────────────────────────────
   * A pairing code proves the user was present once. It is not a credential, it is not reusable,
   * and it carries no password — a code that could be replayed would be a password with a short
   * name. */

  createPairingCode(userId: string, projectId: string, ttlMs = 5 * 60_000): PairingCode {
    const code = randomBytes(4).toString("hex").toUpperCase();
    const p: PairingCode = { code, userId, projectId, expiresAtMs: this.deps.now() + ttlMs, usedAtMs: null };
    this.pairings.set(code, p);
    return p;
  }

  pair(code: string, permissions: BridgePermissions, sessionTtlMs = 8 * 60 * 60_000): BridgeOutcome<BridgeSession> {
    const p = this.pairings.get(code);
    if (!p) return fail(BRIDGE_REASONS.PAIRING_UNKNOWN, "no such pairing code");
    if (p.usedAtMs !== null) return fail(BRIDGE_REASONS.PAIRING_USED, `code was used at ${new Date(p.usedAtMs).toISOString()}`);
    if (this.deps.now() > p.expiresAtMs) return fail(BRIDGE_REASONS.PAIRING_EXPIRED, "code has expired");

    p.usedAtMs = this.deps.now();
    const session: BridgeSession = {
      bridgeId: newId("bridge"),
      userId: p.userId,
      projectId: p.projectId,
      // Ephemeral, generated locally, never derived from the pairing code — a code short enough to
      // read aloud is not enough entropy to be a key.
      key: randomBytes(32),
      createdAtMs: this.deps.now(),
      expiresAtMs: this.deps.now() + sessionTtlMs,
      revokedAtMs: null,
      permissions,
    };
    this.sessions.set(session.bridgeId, session);
    this.nonces.set(session.bridgeId, new Set());
    return { ok: true, value: session };
  }

  revoke(bridgeId: string): void {
    const s = this.sessions.get(bridgeId);
    if (s) s.revokedAtMs = this.deps.now();
  }

  session(bridgeId: string): BridgeSession | undefined {
    return this.sessions.get(bridgeId);
  }

  /* ── request authentication ─────────────────────────────────────────────── */

  private authenticate(signed: SignedBridgeRequest): BridgeOutcome<BridgeSession> {
    const parsed = BridgeRequestSchema.safeParse(signed.request);
    if (!parsed.success) return fail(BRIDGE_REASONS.BAD_SIGNATURE, parsed.error.issues.map((i) => i.message).join("; "));
    const r = parsed.data;

    const session = this.sessions.get(r.bridgeId);
    if (!session) return fail(BRIDGE_REASONS.WRONG_BRIDGE, `no session for ${r.bridgeId}`);
    if (session.revokedAtMs !== null) return fail(BRIDGE_REASONS.SESSION_REVOKED, `revoked at ${new Date(session.revokedAtMs).toISOString()}`);

    const now = this.deps.now();
    if (now > session.expiresAtMs) return fail(BRIDGE_REASONS.NO_SESSION, "session has expired");

    // Signature BEFORE anything else about the content is trusted: until it verifies, every field
    // in the request is attacker-controlled, including the ones a nicer error would quote.
    if (!verifySignature(r, session.key, signed.signature)) {
      return fail(BRIDGE_REASONS.BAD_SIGNATURE, "signature does not verify against this session's key");
    }

    if (r.userId !== session.userId) return fail(BRIDGE_REASONS.WRONG_USER, `request is for ${r.userId}, session belongs to ${session.userId}`);
    if (r.projectId !== session.projectId) return fail(BRIDGE_REASONS.WRONG_PROJECT, `request is for ${r.projectId}, session is paired to ${session.projectId}`);

    if (now > r.expiresAtMs) return fail(BRIDGE_REASONS.EXPIRED, `expired ${now - r.expiresAtMs}ms ago`);
    if (r.issuedAtMs > now + 30_000) return fail(BRIDGE_REASONS.NOT_YET_VALID, "issued in the future");

    // The payload must be the payload that was signed. Without this the signature covers a hash of
    // something nobody checked against the arguments actually used.
    if (payloadHash(signed.payload) !== r.payloadHash) {
      return fail(BRIDGE_REASONS.PAYLOAD_MUTATED, "payload does not match the signed payloadHash");
    }

    const seen = this.nonces.get(r.bridgeId)!;
    if (seen.has(r.nonce)) return fail(BRIDGE_REASONS.REPLAY, `nonce ${r.nonce} has already been used`);
    seen.add(r.nonce);

    return { ok: true, value: session };
  }

  /* ── operations ─────────────────────────────────────────────────────────── */

  async handle(signed: SignedBridgeRequest): Promise<BridgeOutcome<unknown>> {
    const op = signed.request.operationType;

    // Checked before authentication so that an attempt to reach raw access is reported as such
    // even from an unauthenticated caller — that is the event an operator wants to see.
    if (FORBIDDEN_OPERATIONS.has(op)) {
      return fail(
        BRIDGE_REASONS.OPERATION_NOT_AVAILABLE,
        `"${op}" is not an operation this bridge has. The bridge performs bounded tasks and returns bounded results; it does not hand out access.`,
      );
    }
    if (!BRIDGE_OPERATIONS.includes(op as BridgeOperation)) {
      return fail(BRIDGE_REASONS.UNKNOWN_OPERATION, `"${op}" is not in the operation vocabulary`);
    }

    const auth = this.authenticate(signed);
    if (!auth.ok) return auth;
    const session = auth.value;

    if (!session.permissions.allowedOperations.includes(op as BridgeOperation)) {
      return fail(BRIDGE_REASONS.NOT_PERMITTED, `"${op}" is not permitted for this bridge session`);
    }
    if (!session.permissions.allowedProjects.includes(session.projectId)) {
      return fail(BRIDGE_REASONS.WRONG_PROJECT, `project ${session.projectId} is not in this bridge's allow-list`);
    }

    switch (op as BridgeOperation) {
      case "credential.performApiRequest":
        return this.performApiRequest(session, signed.payload);
      case "cre.simulateWorkflow":
        return this.simulateWorkflow(session, signed.payload);
      case "cre.status":
        return this.creStatus(session);
      case "cre.buildWorkflow":
        return this.creBuild(session, signed.payload);
      case "cre.deployWorkflow":
        return this.creDeployWorkflow(session, signed.payload);
      case "cre.workflowLifecycle":
        return this.creLifecycle(session, signed.payload);
      case "ledger.approveContextLockAction":
      case "ledger.performProtectedBrokerAction":
        return this.ledgerAction(session, op as BridgeOperation, signed.payload);
    }
  }

  /**
   * Perform an approved outbound call with a local credential.
   *
   * The credential is named, never carried. The hosted side sends a reference and validated
   * parameters; the bridge resolves the reference locally, attaches it, and returns the normalized
   * response. What comes back is an answer, not access.
   */
  private async performApiRequest(session: BridgeSession, payload: Record<string, unknown>): Promise<BridgeOutcome<unknown>> {
    const credentialRef = String(payload.credentialRef ?? "");
    const operationId = String(payload.operationId ?? "");
    const url = String(payload.url ?? "");

    if (!session.permissions.allowedCredentialRefs.includes(credentialRef)) {
      return fail(BRIDGE_REASONS.CREDENTIAL_NOT_ALLOWED, `credential "${credentialRef}" is not permitted for this bridge session`);
    }
    if (!session.permissions.allowedApiOperationIds.includes(operationId)) {
      return fail(BRIDGE_REASONS.NOT_PERMITTED, `operation "${operationId}" is not permitted for this bridge session`);
    }

    // The bridge runs on the user's machine, which is exactly where an SSRF would be most useful to
    // an attacker: it is inside the network the hosted service cannot reach.
    const verdict = await checkUrl(url, { ...this.deps.egress, allowedHosts: session.permissions.allowedHosts });
    if (!verdict.ok) return fail(BRIDGE_REASONS.HOST_NOT_ALLOWED, `${verdict.reason}: ${verdict.detail}`);

    if (!this.deps.performApiCall) return fail(BRIDGE_REASONS.OPERATION_NOT_AVAILABLE, "no API transport configured on this bridge");
    const r = await this.deps.performApiCall({ url: verdict.url.toString(), credentialRef, operationId });
    return { ok: true, value: { status: r.status, body: r.body, credentialRef, executedLocally: true } };
  }

  /**
   * Run a CRE workflow through the user's own logged-in session.
   *
   * The hosted service never sees a CRE email, password, 2FA code or session token. It names a
   * workflow; the local `cre` session does the rest.
   */
  private async simulateWorkflow(session: BridgeSession, payload: Record<string, unknown>): Promise<BridgeOutcome<unknown>> {
    const workflow = String(payload.workflow ?? "");
    if (!session.permissions.allowedCreWorkflows.includes(workflow)) {
      return fail(BRIDGE_REASONS.NOT_PERMITTED, `workflow "${workflow}" is not permitted for this bridge session`);
    }
    if (!this.deps.runCreWorkflow) return fail(BRIDGE_REASONS.OPERATION_NOT_AVAILABLE, "no CRE session available on this bridge");
    const r = await this.deps.runCreWorkflow(workflow, (payload.args as Record<string, unknown>) ?? {});
    // Status and result only. Nothing about how the local session authenticated crosses back.
    return { ok: true, value: { status: r.status, result: r.result } };
  }

  /* ── CRE deployment ──────────────────────────────────────────────────────
   *
   * Everything below runs against the user's own `cre login` session. The hosted side never learns
   * how that session authenticated: it receives the same status FIELDS the web app is allowed to
   * show, and never a token, a config path or a key. */

  /** Sanitized connection status. There is nowhere in the returned shape to put a credential. */
  private async creStatus(_session: BridgeSession): Promise<BridgeOutcome<unknown>> {
    if (!this.deps.creDeploy) return fail(BRIDGE_REASONS.OPERATION_NOT_AVAILABLE, "no CRE session available on this bridge");
    const s = await this.deps.creDeploy.status();
    return {
      ok: true,
      value: {
        connected: s.connected,
        organizationId: s.organizationId,
        organizationName: s.organizationName,
        accountLabel: s.accountLabel,
        deployAccess: s.deployAccess,
        availableRegistryIds: s.registryIds,
        supportedChains: s.supportedChains,
        cliVersion: s.cliVersion,
      },
    };
  }

  /** Build once. The hashes come back; the binary stays on the machine that built it. */
  private async creBuild(session: BridgeSession, payload: Record<string, unknown>): Promise<BridgeOutcome<unknown>> {
    const workflow = String(payload.workflow ?? "");
    if (!session.permissions.allowedCreWorkflows.includes(workflow)) {
      return fail(BRIDGE_REASONS.NOT_PERMITTED, `workflow "${workflow}" is not permitted for this bridge session`);
    }
    if (!this.deps.creDeploy) return fail(BRIDGE_REASONS.OPERATION_NOT_AVAILABLE, "no CRE session available on this bridge");
    const b = await this.deps.creDeploy.build(workflow);
    return { ok: true, value: b };
  }

  /**
   * Deploy the exact approved binary.
   *
   * The caller states the sha256 it approved. The bridge hashes the file it is about to deploy and
   * refuses if they differ — so a compromised or merely out-of-date control plane cannot cause a
   * different workflow to be registered under an approval given for another one. The check happens
   * on this side of the boundary because this is the side that holds the file.
   */
  private async creDeployWorkflow(session: BridgeSession, payload: Record<string, unknown>): Promise<BridgeOutcome<unknown>> {
    const workflow = String(payload.workflow ?? "");
    const wasmPath = String(payload.wasmPath ?? "");
    const registry = String(payload.registry ?? "");
    const approvedWasmSha256 = String(payload.approvedWasmSha256 ?? "");

    if (!session.permissions.allowedCreWorkflows.includes(workflow)) {
      return fail(BRIDGE_REASONS.NOT_PERMITTED, `workflow "${workflow}" is not permitted for this bridge session`);
    }
    // The onchain registry's lifecycle operations are Ethereum Mainnet transactions. The bridge
    // refuses them independently of whatever the control plane decided, because a second refusal on
    // the user's own machine is the one that survives a compromised first.
    if (registry.startsWith("onchain:")) {
      return fail(BRIDGE_REASONS.NOT_PERMITTED, `registry "${registry}" performs Ethereum Mainnet lifecycle writes; this bridge deploys to the private registry only`);
    }
    if (!/^[0-9a-f]{64}$/.test(approvedWasmSha256)) {
      return fail(BRIDGE_REASONS.NOT_PERMITTED, "a deploy request must state the sha256 of the approved binary");
    }
    if (!this.deps.creDeploy) return fail(BRIDGE_REASONS.OPERATION_NOT_AVAILABLE, "no CRE session available on this bridge");

    const actual = await this.deps.creDeploy.hashFile(wasmPath);
    if (actual !== approvedWasmSha256) {
      return fail(
        BRIDGE_REASONS.NOT_PERMITTED,
        `DEPLOYMENT_ARTIFACT_DRIFT: ${wasmPath} hashes to ${actual}, but ${approvedWasmSha256} was approved`,
      );
    }
    const r = await this.deps.creDeploy.deploy({ workflow, wasmPath, registry });
    return { ok: true, value: { ...r, deployedWasmSha256: actual } };
  }

  /** get / pause / activate / list. A closed set; there is no lifecycle action called "anything". */
  private async creLifecycle(session: BridgeSession, payload: Record<string, unknown>): Promise<BridgeOutcome<unknown>> {
    const workflow = String(payload.workflow ?? "");
    const action = String(payload.action ?? "");
    if (!session.permissions.allowedCreWorkflows.includes(workflow)) {
      return fail(BRIDGE_REASONS.NOT_PERMITTED, `workflow "${workflow}" is not permitted for this bridge session`);
    }
    if (!["get", "pause", "activate", "list"].includes(action)) {
      return fail(BRIDGE_REASONS.UNKNOWN_OPERATION, `"${action}" is not a CRE lifecycle action`);
    }
    if (!this.deps.creDeploy) return fail(BRIDGE_REASONS.OPERATION_NOT_AVAILABLE, "no CRE session available on this bridge");
    const r = await this.deps.creDeploy.lifecycle({ workflow, action: action as "get" | "pause" | "activate" | "list" });
    return { ok: true, value: r };
  }

  /**
   * A Ledger operation.
   *
   * Gated on real hardware. With no device attached this returns HARDWARE_UNAVAILABLE rather than a
   * simulated approval — BLK-002 stands, and a bridge that signed something in software while
   * reporting a hardware approval would be the single most dishonest thing in this system.
   */
  private async ledgerAction(session: BridgeSession, op: BridgeOperation, payload: Record<string, unknown>): Promise<BridgeOutcome<unknown>> {
    const actionType = String(payload.actionType ?? "");
    if (!session.permissions.allowedLedgerActionTypes.includes(actionType)) {
      return fail(BRIDGE_REASONS.NOT_PERMITTED, `ledger action "${actionType}" is not permitted for this bridge session`);
    }

    const amount = typeof payload.amountUsdCents === "number" ? payload.amountUsdCents : null;
    if (amount !== null && amount > session.permissions.humanApprovalAboveUsdCents) {
      if (!this.deps.askHuman) {
        return fail(BRIDGE_REASONS.APPROVAL_REQUIRED, "this operation needs a person and no approval channel is available");
      }
      const approved = await this.deps.askHuman({
        projectId: session.projectId,
        operation: op,
        what: actionType,
        amountUsdCents: amount,
        destination: typeof payload.destination === "string" ? payload.destination : null,
        policyReason: String(payload.policyReason ?? "above the bridge's autonomous ceiling"),
        expiresAtMs: this.deps.now() + 120_000,
      });
      if (!approved) return fail(BRIDGE_REASONS.APPROVAL_REQUIRED, "the person at the keyboard declined");
    }

    if (!this.deps.ledger) {
      return fail(BRIDGE_REASONS.HARDWARE_UNAVAILABLE, "no Ledger device is attached; BLK-002 — hardware approval is never simulated");
    }
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const r = await this.deps.ledger.approve(actionType, digest);
    return { ok: true, value: { approved: r.approved, signature: r.signature, digest } };
  }
}

export { BRIDGE_PROTOCOL_VERSION };
