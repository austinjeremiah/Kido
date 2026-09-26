import type { SpecialistName } from "@kido/agents";
import type { MonitorEvent } from "./monitor.js";
import type { SemanticStep } from "./plan.js";

/** Bible §24. Reasoning is woken only for these, never because a number merely changed. */
export const WAKE_CONDITIONS = [
  "EXPECTED_STATE_DIVERGED",
  "RESOURCE_SHORTFALL",
  "MULTIPLE_COMPLIANT_PATHS",
  "CONSTRAINT_CONFLICT",
  "PARTIAL_EXECUTION",
  "PROTOCOL_UNAVAILABLE",
  "STATE_DRIFT",
  "UNKNOWN_ADAPTER_STATE",
  "CROSS_ACTION_REQUIRED",
  "NO_DETERMINISTIC_PLAN",
] as const;
export type WakeCondition = (typeof WAKE_CONDITIONS)[number];

export type ResponderResult =
  | { kind: "ACTIONS"; steps: SemanticStep[] }
  | { kind: "WAKE"; condition: WakeCondition; specialist: SpecialistName; reason: string }
  | { kind: "NO_ACTION"; reason: string };

export interface DeterministicResponder<W> {
  id: string;
  handles: string;
  respond(event: MonitorEvent, world: W): ResponderResult;
}

export type GateDecision =
  | { path: "DETERMINISTIC"; responder: string; steps: SemanticStep[] }
  | { path: "REASONING_REQUIRED"; condition: WakeCondition; specialist: SpecialistName; reason: string }
  | { path: "NO_ACTION"; reason: string };

export class ReasoningGate<W> {
  constructor(private readonly responders: DeterministicResponder<W>[]) {}

  decide(event: MonitorEvent, world: W): GateDecision {
    const r = this.responders.find((x) => x.handles === event.kind);
    if (!r) return { path: "REASONING_REQUIRED", condition: "NO_DETERMINISTIC_PLAN", specialist: "RecoveryAgent", reason: `no responder for ${event.kind}` };
    const res = r.respond(event, world);
    if (res.kind === "ACTIONS") return { path: "DETERMINISTIC", responder: r.id, steps: res.steps };
    if (res.kind === "WAKE") return { path: "REASONING_REQUIRED", condition: res.condition, specialist: res.specialist, reason: res.reason };
    return { path: "NO_ACTION", reason: res.reason };
  }
}
