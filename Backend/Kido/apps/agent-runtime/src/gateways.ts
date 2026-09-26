import { z } from "zod";

/**
 * The four gateways, and nothing else.
 *
 * The runtime's entire outward surface. Each one is a narrow service that holds the credential the
 * runtime is not allowed to have, applies policy the runtime cannot bypass, and returns an answer.
 *
 * The shape of the win: a fully compromised runtime — arbitrary code execution inside the container
 * — obtains its own scoped identity and whatever these four gateways will do for it under policy.
 * It does not obtain `OPENAI_API_KEY`, the capability issuer's signing key, the user's CRE session,
 * or the ability to sign a transaction. Those are not "protected" inside the container; they are
 * not inside the container.
 */

export const GATEWAYS = ["MODEL", "ADAPTER", "CONTEXTLOCK", "TELEMETRY"] as const;
export type Gateway = (typeof GATEWAYS)[number];

/**
 * Requests the runtime may make. A closed vocabulary, like the bridge's.
 *
 * There is no `signDigest`, no `issueCapability`, no `getSecret` and no `callArbitraryUrl`. A
 * compromised runtime cannot ask for them because the protocol has no way to express them.
 */
export const RUNTIME_OPERATIONS = [
  "model.complete",
  "adapter.read",
  "adapter.prepare",
  "contextlock.requestIntent",
  "contextlock.checkPolicy",
  "telemetry.emit",
  "telemetry.heartbeat",
  "checkpoint.load",
  "checkpoint.save",
] as const;
export type RuntimeOperation = (typeof RUNTIME_OPERATIONS)[number];

/** Named absent, so their absence is testable rather than merely true. */
export const FORBIDDEN_RUNTIME_OPERATIONS = new Set([
  "signDigest",
  "signTransaction",
  "issuer.sign",
  "issueCapability",
  "capability.mint",
  "policy.enable",
  "policy.disable",
  "getSecret",
  "credential.get",
  "model.setModel",
  "adapter.callArbitraryUrl",
  "cre.deploy",
  "runtime.escalate",
]);

export const ModelRequestSchema = z.object({
  operation: z.literal("model.complete"),
  /**
   * There is no `model` field.
   *
   * The Model Gateway pins `gpt-5.6-luna`. If the runtime could name a model it could name a
   * cheaper one, a less aligned one, or one belonging to a different account — and a compromised
   * runtime choosing its own model is a compromised runtime choosing its own judge.
   */
  messages: z.array(z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.string() })),
  /** Bounded by the runtime and bounded again, authoritatively, by the gateway. */
  maxOutputTokens: z.number().int().positive().max(32_000),
  /** Tool schema names only. The gateway resolves them against what this agent is allowed. */
  toolNames: z.array(z.string()),
  correlationId: z.string().min(1),
});
export type ModelRequest = z.infer<typeof ModelRequestSchema>;

export const AdapterRequestSchema = z.object({
  operation: z.enum(["adapter.read", "adapter.prepare"]),
  adapterId: z.string().min(1),
  adapterVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  action: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  correlationId: z.string().min(1),
});

export const IntentRequestSchema = z.object({
  operation: z.literal("contextlock.requestIntent"),
  /** A normalized intent. The runtime asks; the broker and the chain decide. */
  intent: z.record(z.string(), z.unknown()),
  /**
   * There is no capability field, and no signature field.
   *
   * The runtime cannot present authority it minted, because it cannot mint any. It states what it
   * would like to do and the trusted side decides — which is the same relationship the whole
   * protocol has with every agent.
   */
  correlationId: z.string().min(1),
});

export const GATEWAY_REASONS = {
  FORBIDDEN_OPERATION: "GW-FORBIDDEN-OPERATION",
  UNKNOWN_OPERATION: "GW-UNKNOWN-OPERATION",
  WRONG_GATEWAY: "GW-WRONG-GATEWAY",
  TOKEN_EXPIRED: "GW-TOKEN-EXPIRED",
  TOKEN_WRONG_AGENT: "GW-TOKEN-WRONG-AGENT",
  TOKEN_WRONG_IMAGE: "GW-TOKEN-WRONG-IMAGE-DIGEST",
  TOKEN_REPLAYED: "GW-TOKEN-REPLAYED",
  TOKEN_REVOKED: "GW-TOKEN-REVOKED",
  QUOTA_EXCEEDED: "GW-QUOTA-EXCEEDED",
  MODEL_NOT_SELECTABLE: "GW-MODEL-NOT-SELECTABLE",
  ADAPTER_NOT_PERMITTED: "GW-ADAPTER-NOT-PERMITTED",
  HOST_NOT_PERMITTED: "GW-HOST-NOT-PERMITTED",
  PAUSED: "GW-RUNTIME-PAUSED",
} as const;
export type GatewayReason = (typeof GATEWAY_REASONS)[keyof typeof GATEWAY_REASONS];

/** Which gateway serves which operation. A request to the wrong one is refused, not routed. */
export const OPERATION_GATEWAY: Record<RuntimeOperation, Gateway> = {
  "model.complete": "MODEL",
  "adapter.read": "ADAPTER",
  "adapter.prepare": "ADAPTER",
  "contextlock.requestIntent": "CONTEXTLOCK",
  "contextlock.checkPolicy": "CONTEXTLOCK",
  "telemetry.emit": "TELEMETRY",
  "telemetry.heartbeat": "TELEMETRY",
  "checkpoint.load": "TELEMETRY",
  "checkpoint.save": "TELEMETRY",
};

export class GatewayError extends Error {
  constructor(readonly reason: GatewayReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "GatewayError";
  }
}

export function assertOperationAllowed(operation: string, gateway: Gateway): asserts operation is RuntimeOperation {
  if (FORBIDDEN_RUNTIME_OPERATIONS.has(operation)) {
    throw new GatewayError(
      GATEWAY_REASONS.FORBIDDEN_OPERATION,
      `"${operation}" is not something a runtime may ask for. Signing, capability issuance and policy changes happen on the trusted side; the runtime states intent and the trusted side decides.`,
    );
  }
  if (!(RUNTIME_OPERATIONS as readonly string[]).includes(operation)) {
    throw new GatewayError(GATEWAY_REASONS.UNKNOWN_OPERATION, `"${operation}" is not in the runtime operation vocabulary`);
  }
  const expected = OPERATION_GATEWAY[operation as RuntimeOperation];
  if (expected !== gateway) {
    throw new GatewayError(GATEWAY_REASONS.WRONG_GATEWAY, `"${operation}" is served by the ${expected} gateway, not ${gateway}`);
  }
}
