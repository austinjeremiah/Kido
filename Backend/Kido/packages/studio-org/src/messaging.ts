import type { Organization } from "./schema.js";

/**
 * Inter-agent communication.
 *
 * A message from one agent to another is untrusted input. It is not a signal from a colleague; it
 * is a string that arrived from a principal that may be compromised. The only safe way to model it
 * is the way we model a web page: data, never instruction.
 *
 * This module deliberately offers no way to attach authority to a message. There is no approval
 * field, no capability field, no signature-of-permission. A recipient that wants to act must pass
 * its OWN policy with its OWN limits, exactly as if the message had never arrived.
 */

export const ORG_MESSAGE_REASONS = {
  NO_RULE: "ORG-MSG-NO-RULE",
  UNKNOWN_SENDER: "ORG-MSG-UNKNOWN-SENDER",
  UNKNOWN_RECIPIENT: "ORG-MSG-UNKNOWN-RECIPIENT",
  KIND_NOT_PERMITTED: "ORG-MSG-KIND-NOT-PERMITTED",
  SENDER_REVOKED: "ORG-MSG-SENDER-REVOKED",
} as const;
export type OrgMessageReason = (typeof ORG_MESSAGE_REASONS)[keyof typeof ORG_MESSAGE_REASONS];

export interface InterAgentMessage {
  from: string;
  to: string;
  kind: "observation" | "request" | "status";
  body: string;
}

/**
 * A message as the recipient must treat it.
 *
 * `conveysAuthority` is a literal false rather than an omitted field. Someone reading this type
 * later should have to delete a line that says so to change the answer.
 */
export interface DeliveredMessage {
  from: string;
  kind: InterAgentMessage["kind"];
  /** Untrusted. Quote it to a human; never let it select an action. */
  body: string;
  conveysAuthority: false;
  trustClass: "USER_UNTRUSTED";
}

export type MessageOutcome =
  | { delivered: true; message: DeliveredMessage }
  | { delivered: false; reason: OrgMessageReason };

export function deliverMessage(
  org: Organization,
  msg: InterAgentMessage,
  isRevoked: (agentId: string) => boolean = () => false,
): MessageOutcome {
  if (!org.agents.some((a) => a.id === msg.from)) {
    return { delivered: false, reason: ORG_MESSAGE_REASONS.UNKNOWN_SENDER };
  }
  if (!org.agents.some((a) => a.id === msg.to)) {
    return { delivered: false, reason: ORG_MESSAGE_REASONS.UNKNOWN_RECIPIENT };
  }
  if (isRevoked(msg.from)) {
    return { delivered: false, reason: ORG_MESSAGE_REASONS.SENDER_REVOKED };
  }
  const rule = org.communicationRules.find((r) => r.from === msg.from && r.to === msg.to);
  if (!rule) return { delivered: false, reason: ORG_MESSAGE_REASONS.NO_RULE };
  if (!rule.messageKinds.includes(msg.kind)) {
    return { delivered: false, reason: ORG_MESSAGE_REASONS.KIND_NOT_PERMITTED };
  }
  return {
    delivered: true,
    message: { from: msg.from, kind: msg.kind, body: msg.body, conveysAuthority: false, trustClass: "USER_UNTRUSTED" },
  };
}
