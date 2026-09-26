import { describe, expect, it } from "vitest";
import {
  RequestState, assertTransition, canTransition, isTerminal, mayExecute, InvalidTransitionError,
} from "../src/state-machine.js";

describe("request state machine", () => {
  it("walks the canonical happy path", () => {
    const path = [
      RequestState.RECEIVED, RequestState.IDENTITY_VALIDATED, RequestState.POLICY_EVALUATING,
      RequestState.AUTHORIZED, RequestState.CAPABILITY_ISSUED, RequestState.SUBMITTED,
      RequestState.EXECUTED,
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it("rejects skipping identity validation", () => {
    expect(canTransition(RequestState.RECEIVED, RequestState.AUTHORIZED)).toBe(false);
    expect(() => assertTransition(RequestState.RECEIVED, RequestState.AUTHORIZED))
      .toThrow(InvalidTransitionError);
  });

  it("rejects skipping policy evaluation", () => {
    expect(canTransition(RequestState.IDENTITY_VALIDATED, RequestState.CAPABILITY_ISSUED)).toBe(false);
  });

  it("DENIED is terminal and has no path to anything executable", () => {
    expect(isTerminal(RequestState.DENIED)).toBe(true);
    for (const s of Object.values(RequestState)) {
      expect(canTransition(RequestState.DENIED, s), `DENIED -> ${s} must be impossible`).toBe(false);
    }
  });

  it("a DENY cannot be walked forward into a capability by ANY multi-step path", () => {
    // Breadth-first from DENIED: nothing must be reachable at all.
    const seen = new Set<string>([RequestState.DENIED]);
    const queue: RequestState[] = [RequestState.DENIED];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const s of Object.values(RequestState)) {
        if (canTransition(cur, s) && !seen.has(s)) { seen.add(s); queue.push(s); }
      }
    }
    expect([...seen]).toEqual([RequestState.DENIED]);
  });

  it("ESCALATION_REQUIRED cannot reach CAPABILITY_ISSUED before Phase 7", () => {
    expect(canTransition(RequestState.ESCALATION_REQUIRED, RequestState.CAPABILITY_ISSUED)).toBe(false);
    expect(canTransition(RequestState.ESCALATION_REQUIRED, RequestState.AUTHORIZED)).toBe(false);
  });

  it("only capability-bearing states may execute", () => {
    expect(mayExecute(RequestState.CAPABILITY_ISSUED)).toBe(true);
    expect(mayExecute(RequestState.SUBMITTED)).toBe(true);
    for (const s of [RequestState.RECEIVED, RequestState.DENIED, RequestState.ESCALATION_REQUIRED,
                     RequestState.POLICY_EVALUATING, RequestState.AUTHORIZED]) {
      expect(mayExecute(s), `${s} must not be executable`).toBe(false);
    }
  });

  it("terminal states are genuinely terminal", () => {
    for (const s of [RequestState.EXECUTED, RequestState.REVERTED, RequestState.EXPIRED,
                     RequestState.FAILED, RequestState.DENIED]) {
      expect(isTerminal(s)).toBe(true);
    }
  });
});
