import { randomUUID } from "node:crypto";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CAPABILITY_TYPES,
  capabilityDigest,
  domain,
  requestHash as computeRequestHash,
  OperationalError,
  PolicyDenial,
  ReasonCode,
  SEPOLIA_CHAIN_ID,
  type Capability,
} from "@contextlock/protocol";
import { getAdapter, UnknownActionKindError, type CandidateTransaction } from "@contextlock/adapters";
import { audit, AuditType, type DB } from "./db.js";
import type {
  EnsIdentityProvider,
  HumanApprovalProvider,
  PolicyEvaluator,
  SecretProvider,
} from "./providers/interfaces.js";
import { fenceWriteByChain } from "@contextlock/studio-network";

export type PublicPolicy = {
  policyId: string;
  policyHash: Hex;
  enabled: boolean;
  allowedActionKinds: string[];
  allowedTargets: Address[];
  /** Integer base units. */
  maxValueHardCap: bigint;
  /** Where the adapter should send the call for this policy. */
  target: Address;
};

export type BrokerConfig = {
  chainId: number;
  executor: Address;
  /** Broker's EIP-712 signing key. NEVER leaves this process; never returned by any endpoint. */
  capabilityIssuerPrivateKey: Hex;
  capabilityTtlSeconds: number;
  policies: Record<string, PublicPolicy>;
};

export type CreateRequestInput = {
  agentEnsName: string;
  actionKind: string;
  adapterParams: unknown;
  policyId: string;
  idempotencyKey: string;
};

export type RequestRecord = {
  requestId: string;
  status: "ALLOWED" | "ESCALATED" | "DENIED" | "FAILED";
  reasonCode: string;
  capability?: Capability;
  signature?: Hex;
  calldata?: Hex;
  actionKindHash?: Hex;
  capabilityDigest?: Hex;
  authorizationId?: Hex;
  approvedUntil?: string;
  identitySource?: string;
  evaluationSource?: string;
};

/**
 * The broker.
 *
 * It is an orchestrator and an audit surface, not the security boundary. Every check it performs
 * is advisory — the executor re-checks identity, policy, authorization freshness, nonce and the
 * exact call on-chain. That redundancy is deliberate: a fully compromised broker still cannot
 * make the executor accept an unauthorized transaction, because it cannot forge live ENS state
 * or a CRE authorization for a different request hash.
 */
export class Broker {
  private readonly issuer;
  private nonceCounter = 0n;

  constructor(
    private readonly db: DB,
    private readonly cfg: BrokerConfig,
    private readonly ens: EnsIdentityProvider,
    private readonly evaluator: PolicyEvaluator,
    public readonly secrets: SecretProvider,
    public readonly approvals: HumanApprovalProvider,
  ) {
    this.issuer = privateKeyToAccount(cfg.capabilityIssuerPrivateKey);
  }

  /** The issuer ADDRESS is public; the key is not exposed anywhere, by design. */
  get issuerAddress(): Address {
    return this.issuer.address;
  }

  getPolicy(policyId: string): PublicPolicy | undefined {
    return this.cfg.policies[policyId];
  }

  async createRequest(input: CreateRequestInput): Promise<RequestRecord> {
    // --- idempotency ------------------------------------------------------
    const existing = this.db
      .prepare("SELECT id, status, reason_code FROM capability_requests WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as { id: string; status: string; reason_code: string } | undefined;

    if (existing) {
      audit(this.db, existing.id, AuditType.IDEMPOTENT_REPLAY, { idempotencyKey: input.idempotencyKey });
      return this.getRequest(existing.id)!;
    }

    const requestId = randomUUID();
    const now = new Date().toISOString();

    // --- policy lookup ----------------------------------------------------
    const policy = this.cfg.policies[input.policyId];
    if (!policy) {
      throw new PolicyDenial(ReasonCode.POLICY_DISABLED, `Unknown policy: ${input.policyId}`);
    }
    if (!policy.enabled) {
      throw new PolicyDenial(ReasonCode.POLICY_DISABLED, "Policy is disabled");
    }

    // --- typed adapter: the agent supplies params, never calldata ---------
    if (!policy.allowedActionKinds.includes(input.actionKind)) {
      throw new PolicyDenial(
        ReasonCode.POLICY_ACTION_DENIED,
        `Action kind not permitted by policy: ${input.actionKind}`,
      );
    }
    let adapter;
    try {
      adapter = getAdapter(input.actionKind);
    } catch (e: unknown) {
      if (e instanceof UnknownActionKindError) {
        throw new PolicyDenial(ReasonCode.POLICY_ACTION_DENIED, e.message);
      }
      throw e;
    }

    const parsed = adapter.schema.safeParse(input.adapterParams);
    if (!parsed.success) {
      throw new PolicyDenial(
        ReasonCode.API_VALIDATION,
        `Invalid adapter parameters: ${parsed.error.issues.map((i: { message: string }) => i.message).join("; ")}`,
      );
    }

    /*
     * ── The relayer write fence ────────────────────────────────────────────
     *
     * Before the transaction is built, not after. A CandidateTransaction that exists is one that
     * something downstream can be persuaded to submit, so the chain is checked while the
     * transaction is still hypothetical.
     *
     * The broker fence (in `assertBrokerNetwork`, above) already refused a production chain for the
     * INTENT. This one covers the submission path independently, because they are different
     * subsystems and a mutation that removes either must leave the other.
     */
    fenceWriteByChain("RELAYER", this.cfg.chainId);

    const tx: CandidateTransaction = adapter.build(parsed.data as never, {
      chainId: this.cfg.chainId,
      target: policy.target,
    });

    if (!policy.allowedTargets.includes(tx.target)) {
      throw new PolicyDenial(ReasonCode.POLICY_TARGET_DENIED, `Target not allowlisted: ${tx.target}`);
    }

    const amount = BigInt((parsed.data as { amount: string }).amount ?? "0");
    if (tx.value > policy.maxValueHardCap) {
      throw new PolicyDenial(ReasonCode.POLICY_VALUE_EXCEEDS_CAP, "Value exceeds policy hard cap");
    }

    const intentHash = keccak256(
      toHex(`${input.actionKind}:${JSON.stringify(tx.semanticSummary)}`),
    );

    this.db
      .prepare(
        `INSERT INTO capability_requests
         (id, idempotency_key, agent_ens_name, agent_address, agent_identity_hash, policy_hash,
          action_kind, intent_hash, target, value, calldata, calldata_hash, amount, status,
          reason_code, identity_source, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        requestId, input.idempotencyKey, input.agentEnsName, "", null, policy.policyHash,
        input.actionKind, intentHash, tx.target, tx.value.toString(), tx.calldata,
        tx.calldataHash, amount.toString(), "PENDING", null, null, now, now,
      );

    audit(this.db, requestId, AuditType.REQUEST_RECEIVED, {
      agentEnsName: input.agentEnsName,
      actionKind: input.actionKind,
      summary: tx.semanticSummary,
    });

    // --- live identity (fail closed) --------------------------------------
    let identity;
    try {
      identity = await this.ens.resolve(input.agentEnsName);
    } catch (e: unknown) {
      const code = e instanceof OperationalError ? e.code : ReasonCode.IDENTITY_NOT_FOUND;
      audit(this.db, requestId, AuditType.ENS_IDENTITY_FAILED, { code });
      this.setStatus(requestId, "FAILED", code);
      throw e;
    }
    audit(this.db, requestId, AuditType.ENS_IDENTITY_VALIDATED, {
      ensName: identity.ensName,
      node: identity.node,
      agent: identity.agent,
      bindingVersion: identity.bindingVersion.toString(),
      source: identity.source,
    });
    this.db
      .prepare(
        "UPDATE capability_requests SET agent_address=?, agent_identity_hash=?, identity_source=?, updated_at=? WHERE id=?",
      )
      .run(identity.agent, identity.agentIdentityHash, identity.source, new Date().toISOString(), requestId);

    // --- policy evaluation (CRE in Phase 4) -------------------------------
    audit(this.db, requestId, AuditType.EVALUATION_REQUESTED, { amount: amount.toString() });
    // The canonical request hash the executor will independently recompute from the capability.
    const evaluationRequestHash = computeRequestHash({
      version: 1, agentIdentityHash: identity.agentIdentityHash, agent: identity.agent,
      chainId: BigInt(this.cfg.chainId), executor: this.cfg.executor, target: tx.target,
      value: tx.value, calldataHash: tx.calldataHash, intentHash, policyHash: policy.policyHash,
      authorizationId: "0x0000000000000000000000000000000000000000000000000000000000000000",
      contextCommitment: "0x0000000000000000000000000000000000000000000000000000000000000000",
      issuedAt: 0n, expiresAt: 0n, nonce: 0n,
    });

    const evaluation = await this.evaluator.evaluate({
      requestId,
      requestHash: evaluationRequestHash,
      calldata: tx.calldata,
      identity,
      policyHash: policy.policyHash,
      target: tx.target,
      value: tx.value,
      calldataHash: tx.calldataHash,
      intentHash,
      actionKind: input.actionKind,
      amount,
    });

    this.db
      .prepare(
        `INSERT INTO cre_authorizations
         (authorization_id, request_id, request_hash, verdict, reason_code, context_commitment,
          evaluated_at, approved_until, source)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        evaluation.authorizationId, requestId, evaluation.requestHash, evaluation.verdict,
        evaluation.reasonCode, evaluation.contextCommitment, Number(evaluation.evaluatedAt),
        Number(evaluation.approvedUntil), evaluation.source,
      );
    audit(this.db, requestId, AuditType.AUTHORIZATION_OBSERVED, {
      authorizationId: evaluation.authorizationId,
      verdict: evaluation.verdict,
      source: evaluation.source,
    });

    if (evaluation.verdict === "DENY") {
      audit(this.db, requestId, AuditType.DENIED, { reasonCode: evaluation.reasonCode });
      this.setStatus(requestId, "DENIED", evaluation.reasonCode);
      return this.getRequest(requestId)!;
    }

    if (evaluation.verdict === "ESCALATE") {
      audit(this.db, requestId, AuditType.ESCALATION_CREATED, { reasonCode: evaluation.reasonCode });
      this.setStatus(requestId, "ESCALATED", evaluation.reasonCode);
      // No capability is minted. ESCALATE is not authority; Phase 7 adds the human approval path.
      return this.getRequest(requestId)!;
    }

    // --- mint the capability ----------------------------------------------
    const issuedAt = BigInt(Math.floor(Date.now() / 1000));
    const cap: Capability = {
      version: 1,
      agentIdentityHash: identity.agentIdentityHash,
      agent: identity.agent,
      chainId: BigInt(this.cfg.chainId),
      executor: this.cfg.executor,
      target: tx.target,
      value: tx.value,
      calldataHash: tx.calldataHash,
      intentHash,
      policyHash: policy.policyHash,
      authorizationId: evaluation.authorizationId,
      contextCommitment: evaluation.contextCommitment,
      issuedAt,
      expiresAt: issuedAt + BigInt(this.cfg.capabilityTtlSeconds),
      nonce: this.nextNonce(),
    };

    const signature = (await this.issuer.signTypedData({
      domain: domain(cap.chainId, cap.executor),
      types: CAPABILITY_TYPES,
      primaryType: "Capability",
      message: cap,
    })) as Hex;

    const digest = capabilityDigest(cap);

    this.db
      .prepare(
        "INSERT INTO capabilities (digest, request_id, nonce, issued_at, expires_at, status) VALUES (?,?,?,?,?,?)",
      )
      .run(digest, requestId, cap.nonce.toString(), Number(cap.issuedAt), Number(cap.expiresAt), "MINTED");

    audit(this.db, requestId, AuditType.CAPABILITY_MINTED, {
      digest,
      nonce: cap.nonce.toString(),
      expiresAt: cap.expiresAt.toString(),
      onChainRequestHash: computeRequestHash(cap),
    });
    this.setStatus(requestId, "ALLOWED", evaluation.reasonCode);

    return {
      requestId,
      status: "ALLOWED",
      reasonCode: evaluation.reasonCode,
      capability: cap,
      signature,
      calldata: tx.calldata,
      actionKindHash: tx.actionKindHash,
      capabilityDigest: digest,
      authorizationId: evaluation.authorizationId,
      approvedUntil: evaluation.approvedUntil.toString(),
      identitySource: identity.source,
      evaluationSource: evaluation.source,
    };
  }

  private nextNonce(): bigint {
    this.nonceCounter += 1n;
    return BigInt(Date.now()) * 1_000n + this.nonceCounter;
  }

  private setStatus(requestId: string, status: string, reasonCode: string): void {
    this.db
      .prepare("UPDATE capability_requests SET status=?, reason_code=?, updated_at=? WHERE id=?")
      .run(status, reasonCode, new Date().toISOString(), requestId);
  }

  getRequest(requestId: string): RequestRecord | undefined {
    const r = this.db
      .prepare("SELECT * FROM capability_requests WHERE id = ?")
      .get(requestId) as Record<string, string> | undefined;
    if (!r) return undefined;
    const a = this.db
      .prepare("SELECT * FROM cre_authorizations WHERE request_id = ?")
      .get(requestId) as Record<string, string> | undefined;
    return {
      requestId: r.id!,
      status: r.status as RequestRecord["status"],
      reasonCode: r.reason_code ?? "PENDING",
      ...(a ? { authorizationId: a.authorization_id as Hex, approvedUntil: String(a.approved_until) } : {}),
      ...(r.identity_source ? { identitySource: r.identity_source } : {}),
      ...(a?.source ? { evaluationSource: a.source } : {}),
    };
  }

  /** Read-only identity lookup for GET /v1/agents/:ensName. Same provider as issuance uses. */
  async resolveIdentityForApi(ensName: string) {
    const i = await this.ens.resolve(ensName);
    return {
      ensName: i.ensName,
      node: i.node,
      agent: i.agent,
      bindingVersion: i.bindingVersion.toString(),
      agentIdentityHash: i.agentIdentityHash,
      source: i.source,
    };
  }

  getAudit(requestId?: string): unknown[] {
    const rows = requestId
      ? this.db.prepare("SELECT * FROM audit_events WHERE request_id=? ORDER BY id").all(requestId)
      : this.db.prepare("SELECT * FROM audit_events ORDER BY id DESC LIMIT 200").all();
    return (rows as Array<Record<string, string>>).map((e) => ({
      id: e.id,
      requestId: e.request_id,
      type: e.type,
      detail: JSON.parse(e.detail!),
      createdAt: e.created_at,
    }));
  }
}

export { SEPOLIA_CHAIN_ID };
