import { z } from "zod";
import { RuntimeTokenVerifier, RuntimeTokenError, type RuntimeTokenClaims, type VerificationContext } from "./identity.js";
import { fenceWriteByChain } from "@contextlock/studio-network";

/**
 * The trusted side of the four gateways.
 *
 * Each one holds a credential the runtime is not allowed to have and applies a policy the runtime
 * cannot bypass. This file is where "the runtime has no secrets" stops being an aspiration and
 * becomes an arrangement: the secret is here, the requester is authenticated but not trusted, and
 * what comes back is an answer rather than access.
 */

export const MODEL_GATEWAY_REASONS = {
  MODEL_NOT_SELECTABLE: "MODEL-GATEWAY-MODEL-NOT-SELECTABLE",
  QUOTA_EXCEEDED: "MODEL-GATEWAY-QUOTA-EXCEEDED",
  TURN_LIMIT: "MODEL-GATEWAY-MAX-TURNS-EXCEEDED",
  TOOL_NOT_ALLOWED: "MODEL-GATEWAY-TOOL-NOT-ALLOWED",
  RATE_LIMITED: "MODEL-GATEWAY-RATE-LIMITED",
} as const;

export class ModelGatewayError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ModelGatewayError";
  }
}

/**
 * The only model the gateway will call.
 *
 * Pinned server-side and not a parameter. A runtime that could name its model could name a cheaper
 * one, a less aligned one, or one billed to another account — and for a financial agent, choosing
 * its own model means choosing its own judgement.
 */
export const PINNED_MODEL = "gpt-5.6-luna" as const;

export interface ModelQuota {
  requestsPerAgentPerDay: number;
  inputTokensPerAgentPerDay: number;
  outputTokensPerAgentPerDay: number;
  maxTurnsPerRun: number;
  maxOutputTokensPerRequest: number;
  requestsPerMinute: number;
}

export const DEFAULT_MODEL_QUOTA: ModelQuota = {
  requestsPerAgentPerDay: 500,
  inputTokensPerAgentPerDay: 5_000_000,
  outputTokensPerAgentPerDay: 500_000,
  maxTurnsPerRun: 24,
  maxOutputTokensPerRequest: 8_000,
  requestsPerMinute: 20,
};

export interface ModelUsageRecord {
  agentId: string;
  deploymentId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The Model Gateway.
 *
 * Holds `OPENAI_API_KEY`. The runtime never sees it, never learns the endpoint's credentials, and
 * cannot choose the model. Usage is accounted to the agent named in the TOKEN, not to an agent id
 * in the request body — otherwise an agent could spend another agent's quota by claiming to be it.
 */
export class ModelGateway {
  private readonly usage = new Map<string, ModelUsageRecord>();
  private readonly recentRequests = new Map<string, number[]>();

  constructor(
    private readonly verifier: RuntimeTokenVerifier,
    private readonly quota: ModelQuota = DEFAULT_MODEL_QUOTA,
    /** Resolves the tools an agent is permitted. Never taken from the request. */
    private readonly allowedTools: (agentId: string) => readonly string[] = () => [],
  ) {}

  usageFor(agentId: string): ModelUsageRecord {
    return this.usage.get(agentId) ?? { agentId, deploymentId: "", requests: 0, inputTokens: 0, outputTokens: 0 };
  }

  complete(
    token: string,
    ctx: VerificationContext,
    request: { messages: Array<{ role: string; content: string }>; maxOutputTokens: number; toolNames: string[]; turn: number; correlationId: string },
    call: (args: { model: string; messages: Array<{ role: string; content: string }>; maxOutputTokens: number; tools: readonly string[] }) => { inputTokens: number; outputTokens: number; content: string },
  ): { model: string; content: string; usage: ModelUsageRecord; correlationId: string } {
    const claims = this.verifier.verify(token, { ...ctx, audience: "MODEL" });

    // Anything a caller could name that would let it choose its own model is refused here rather
    // than ignored, so an attempt is visible rather than silently downgraded.
    if ("model" in (request as Record<string, unknown>)) {
      throw new ModelGatewayError(
        MODEL_GATEWAY_REASONS.MODEL_NOT_SELECTABLE,
        `the model is pinned to ${PINNED_MODEL} server-side and is not a request parameter`,
      );
    }
    if (request.turn > this.quota.maxTurnsPerRun) {
      throw new ModelGatewayError(MODEL_GATEWAY_REASONS.TURN_LIMIT, `turn ${request.turn} exceeds the ${this.quota.maxTurnsPerRun}-turn ceiling`);
    }
    if (request.maxOutputTokens > this.quota.maxOutputTokensPerRequest) {
      throw new ModelGatewayError(MODEL_GATEWAY_REASONS.QUOTA_EXCEEDED, `maxOutputTokens ${request.maxOutputTokens} exceeds ${this.quota.maxOutputTokensPerRequest}`);
    }

    const permitted = this.allowedTools(claims.agentId);
    const unknownTools = request.toolNames.filter((t) => !permitted.includes(t));
    if (unknownTools.length > 0) {
      throw new ModelGatewayError(MODEL_GATEWAY_REASONS.TOOL_NOT_ALLOWED, `agent "${claims.agentId}" may not use [${unknownTools.join(", ")}]`);
    }

    const window = this.recentRequests.get(claims.agentId) ?? [];
    const fresh = window.filter((t) => ctx.nowMs - t < 60_000);
    if (fresh.length >= this.quota.requestsPerMinute) {
      throw new ModelGatewayError(MODEL_GATEWAY_REASONS.RATE_LIMITED, `${fresh.length} requests in the last minute`);
    }

    // Accounting is keyed on the TOKEN's agent, so a request body claiming another agent charges
    // nothing to that agent.
    const rec = this.usage.get(claims.agentId) ?? { agentId: claims.agentId, deploymentId: claims.deploymentId, requests: 0, inputTokens: 0, outputTokens: 0 };
    if (rec.requests + 1 > this.quota.requestsPerAgentPerDay) {
      throw new ModelGatewayError(MODEL_GATEWAY_REASONS.QUOTA_EXCEEDED, `agent "${claims.agentId}" has used its ${this.quota.requestsPerAgentPerDay} requests`);
    }

    const result = call({ model: PINNED_MODEL, messages: request.messages, maxOutputTokens: request.maxOutputTokens, tools: permitted });

    rec.requests += 1;
    rec.inputTokens += result.inputTokens;
    rec.outputTokens += result.outputTokens;
    this.usage.set(claims.agentId, rec);
    fresh.push(ctx.nowMs);
    this.recentRequests.set(claims.agentId, fresh);

    return { model: PINNED_MODEL, content: result.content, usage: { ...rec }, correlationId: request.correlationId };
  }
}

/* ────────────────────────────── Adapter Broker ────────────────────────────── */

export const ADAPTER_BROKER_REASONS = {
  ADAPTER_NOT_ALLOWED: "ADAPTER-BROKER-ADAPTER-NOT-ALLOWED",
  ACTION_NOT_ALLOWED: "ADAPTER-BROKER-ACTION-NOT-ALLOWED",
  HOST_NOT_ALLOWED: "ADAPTER-BROKER-HOST-NOT-ALLOWED",
  VERSION_MISMATCH: "ADAPTER-BROKER-VERSION-MISMATCH",
  RAW_URL_REFUSED: "ADAPTER-BROKER-RAW-URL-REFUSED",
} as const;

export class AdapterBrokerError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "AdapterBrokerError";
  }
}

export interface AdapterGrant {
  adapterId: string;
  version: string;
  actions: readonly string[];
  hosts: readonly string[];
}

/**
 * The Adapter Broker.
 *
 * Holds every provider credential. The runtime names an adapter, a version and an action; the
 * broker checks that this agent is granted them, performs the call with the credential attached,
 * and returns the response.
 *
 * There is no way to pass a URL. `adapter.callArbitraryUrl` does not exist, and a request carrying
 * one is refused by name — an agent that could name its own host has a general-purpose HTTP client
 * with the product's credentials attached, which is the thing this whole layer exists to prevent.
 */
export class AdapterBroker {
  constructor(
    private readonly verifier: RuntimeTokenVerifier,
    private readonly grants: (agentId: string) => readonly AdapterGrant[],
  ) {}

  invoke(
    token: string,
    ctx: VerificationContext,
    request: { adapterId: string; adapterVersion: string; action: string; args: Record<string, unknown>; correlationId: string },
    perform: (grant: AdapterGrant, action: string, args: Record<string, unknown>) => unknown,
  ): { adapterId: string; action: string; result: unknown; correlationId: string } {
    const claims = this.verifier.verify(token, { ...ctx, audience: "ADAPTER" });

    for (const key of ["url", "endpoint", "host", "baseUrl", "credentialRef", "authorization", "headers"]) {
      if (key in request.args) {
        throw new AdapterBrokerError(
          ADAPTER_BROKER_REASONS.RAW_URL_REFUSED,
          `"${key}" is not an adapter argument. The broker resolves hosts and attaches credentials; a runtime that could supply either would have a general-purpose HTTP client with our credentials on it.`,
        );
      }
    }

    const grants = this.grants(claims.agentId);
    const grant = grants.find((g) => g.adapterId === request.adapterId);
    if (!grant) {
      throw new AdapterBrokerError(ADAPTER_BROKER_REASONS.ADAPTER_NOT_ALLOWED, `agent "${claims.agentId}" has no grant for adapter "${request.adapterId}"`);
    }
    if (grant.version !== request.adapterVersion) {
      throw new AdapterBrokerError(ADAPTER_BROKER_REASONS.VERSION_MISMATCH, `agent "${claims.agentId}" is granted ${request.adapterId}@${grant.version}, not @${request.adapterVersion}`);
    }
    if (!grant.actions.includes(request.action)) {
      throw new AdapterBrokerError(ADAPTER_BROKER_REASONS.ACTION_NOT_ALLOWED, `"${request.action}" is not among [${grant.actions.join(", ")}] for ${request.adapterId}`);
    }

    return { adapterId: request.adapterId, action: request.action, result: perform(grant, request.action, request.args), correlationId: request.correlationId };
  }
}

/* ───────────────────────────── ContextLock Broker ───────────────────────────── */

export const CONTEXTLOCK_BROKER_REASONS = {
  RAW_SIGNING_REFUSED: "CONTEXTLOCK-BROKER-RAW-SIGNING-REFUSED",
  CAPABILITY_NOT_REQUESTABLE: "CONTEXTLOCK-BROKER-CAPABILITY-NOT-REQUESTABLE",
  POLICY_DISABLED: "CONTEXTLOCK-BROKER-POLICY-DISABLED",
  NOT_AUTHORIZED: "CONTEXTLOCK-BROKER-NOT-AUTHORIZED",
} as const;

export class ContextLockBrokerError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ContextLockBrokerError";
  }
}

export const IntentSchema = z.object({
  action: z.string().min(1),
  chainId: z.number().int().positive(),
  target: z.string().min(1),
  /** Integer base units, as a decimal string. */
  amount: z.string().regex(/^\d+$/).optional(),
  token: z.string().optional(),
  rationale: z.string().optional(),
});

/**
 * The ContextLock Broker.
 *
 * The runtime states an INTENT. The broker decides, using the existing security path, and the
 * chain decides again. Two things are absent by construction:
 *
 *   The runtime cannot ask the issuer to sign a digest. `issuer.sign` is not an operation.
 *
 *   The runtime cannot present a capability. There is no field for one, because a capability the
 *   runtime holds is a capability an attacker who owns the runtime holds.
 *
 * And the answer to every request while the policy is disabled is no — which is what makes the
 * onchain policy the kill switch rather than the container's power state.
 */
export class ContextLockBroker {
  constructor(
    private readonly verifier: RuntimeTokenVerifier,
    private readonly policyEnabled: (agentId: string) => boolean,
    private readonly decide: (agentId: string, intent: z.infer<typeof IntentSchema>) => { disposition: "ALLOW" | "DENY" | "ESCALATE"; reason: string },
  ) {}

  requestIntent(
    token: string,
    ctx: VerificationContext,
    request: Record<string, unknown>,
  ): { disposition: string; reason: string; capabilityIssued: false } {
    const claims = this.verifier.verify(token, { ...ctx, audience: "CONTEXTLOCK" });

    for (const key of ["signature", "digest", "capability", "capabilityScope", "issuerSignature", "privateKey"]) {
      if (key in request) {
        throw new ContextLockBrokerError(
          CONTEXTLOCK_BROKER_REASONS.RAW_SIGNING_REFUSED,
          `"${key}" is not part of an intent request. The runtime describes what it wants to do; it does not present authority, and it cannot ask the issuer to sign anything.`,
        );
      }
    }

    const intent = IntentSchema.parse(request.intent);

    /*
     * ── The agent-runtime write fence ──────────────────────────────────────
     *
     * The runtime is the data plane and the part most likely to be compromised. It states an intent
     * naming a chain; the chain is checked here, before the policy, before the decision.
     *
     * A compromised runtime asking to act on mainnet is refused by the registry, not by the policy —
     * because the policy governs how much a testnet agent may move, and the registry governs which
     * universe it may move it in. Those are different questions and a compromise of one must not
     * answer the other.
     */
    fenceWriteByChain("AGENT_RUNTIME", intent.chainId);

    /*
     * The broker write fence.
     *
     * Before the policy check, and before the decision. A production-chain intent is refused
     * whatever the policy says and whatever the agent decided — the policy governs how much a
     * testnet agent may move, not which universe it may move it in.
     */
    fenceWriteByChain("CONTEXTLOCK_BROKER", intent.chainId);

    // Checked BEFORE the policy decision, so a disabled policy is a refusal that does not depend on
    // the decision logic being correct.
    if (!this.policyEnabled(claims.agentId)) {
      throw new ContextLockBrokerError(
        CONTEXTLOCK_BROKER_REASONS.POLICY_DISABLED,
        `the ContextLock policy for agent "${claims.agentId}" is disabled. No financial action is authorized, whatever this runtime, the model or the DON decided.`,
      );
    }

    const verdict = this.decide(claims.agentId, intent);
    // The broker never returns a capability to the runtime. The runtime learns the disposition;
    // execution happens on the trusted side.
    return { disposition: verdict.disposition, reason: verdict.reason, capabilityIssued: false };
  }
}

/* ─────────────────────────── Telemetry / Event Gateway ─────────────────────── */

export class TelemetryGateway {
  private readonly checkpoints = new Map<string, unknown>();
  private readonly events: Array<{ agentId: string; type: string; atMs: number }> = [];

  constructor(private readonly verifier: RuntimeTokenVerifier) {}

  emit(token: string, ctx: VerificationContext, event: { type: string; payload: Record<string, unknown> }): { accepted: true } {
    const claims = this.verifier.verify(token, { ...ctx, audience: "TELEMETRY" });
    this.events.push({ agentId: claims.agentId, type: event.type, atMs: ctx.nowMs });
    return { accepted: true };
  }

  /** Checkpoints live HERE, outside the container, keyed by the token's agent. */
  saveCheckpoint(token: string, ctx: VerificationContext, cursor: unknown): { saved: true } {
    const claims = this.verifier.verify(token, { ...ctx, audience: "TELEMETRY" });
    this.checkpoints.set(`${claims.deploymentId}:${claims.agentId}`, cursor);
    return { saved: true };
  }

  loadCheckpoint(token: string, ctx: VerificationContext): unknown {
    const claims = this.verifier.verify(token, { ...ctx, audience: "TELEMETRY" });
    return this.checkpoints.get(`${claims.deploymentId}:${claims.agentId}`) ?? null;
  }

  eventsFor(agentId: string): Array<{ agentId: string; type: string; atMs: number }> {
    return this.events.filter((e) => e.agentId === agentId);
  }
}

export { RuntimeTokenError, type RuntimeTokenClaims };
