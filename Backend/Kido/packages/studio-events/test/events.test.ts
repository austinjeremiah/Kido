import { describe, expect, it } from "vitest";
import {
  RUNTIME_EVENT_VERSION, RuntimeEventSchema, deriveEventId, canonicalize, newCorrelationId, newRunId,
  EVENT_SOURCES, EVENT_TYPES, EVENT_SEVERITIES,
  InMemoryEventStore, EventStoreError, APPEND_REASONS, correctionOf,
  scanForSecrets, assertPublicSafe, redact, RedactionError, CANARIES, FORBIDDEN_FIELD_NAMES, REDACTED_SURFACES,
  buildTrace, correlationIdFor, stageOf, TRACE_STAGES, SafeTraceContextSchema, FORBIDDEN_BAGGAGE_KEYS,
  type EventDraft, type RuntimeEvent,
} from "../src/index.js";

const NOW = 1_780_000_000_000;
const TX = `0x${"ab".repeat(32)}`;

const draft = (over: Partial<EventDraft> = {}): EventDraft => ({
  organizationId: "org_1",
  projectId: "prj_guardian",
  deploymentId: "dep_group_e_live_0001",
  agentId: "guardian",
  source: "CHAIN",
  type: "POLICY_STATE_OBSERVED",
  severity: "INFO",
  timestamp: NOW,
  correlationId: "corr_fixed",
  agentRunId: null, modelRunId: null, strategyEvaluationId: null,
  creExecutionId: null, authorizationId: null, capabilityId: null,
  chainId: 11155111, blockNumber: "11674284", txHash: null,
  creWorkflowId: null, adapterId: null, runtimeRevision: null,
  buildRevision: 2, deploymentRevision: "rev_1",
  correctsEventId: null,
  publicMetadata: { enabled: false },
  ...over,
});

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};

/* ════════════════════════════ schema ════════════════════════════ */

describe("the RuntimeEvent schema", () => {
  it("LIVE-001 the schema is stable, versioned, and its vocabularies are closed", () => {
    const store = new InMemoryEventStore();
    const e = store.append(draft(), NOW).event;
    expect(RuntimeEventSchema.safeParse(e).success).toBe(true);
    expect(e.schemaVersion).toBe(RUNTIME_EVENT_VERSION);
    expect(RUNTIME_EVENT_VERSION).toBe("contextlock.runtime-event/v1");

    // Every source §25.2 names is present, and nothing may be added ad hoc.
    for (const s of ["AGENT", "MODEL_GATEWAY", "ADAPTER", "CRE", "CONTEXTLOCK", "CHAIN", "RUNTIME", "OPERATOR", "SYSTEM"]) {
      expect(EVENT_SOURCES as readonly string[]).toContain(s);
    }
    expect(RuntimeEventSchema.safeParse({ ...e, source: "SOMETHING_NEW" }).success).toBe(false);
    expect(RuntimeEventSchema.safeParse({ ...e, type: "SOMETHING_NEW" }).success).toBe(false);
    expect(RuntimeEventSchema.safeParse({ ...e, severity: "URGENT" }).success).toBe(false);

    // The correlation identifiers are SEPARATE fields, not one overloaded id (P25.6).
    for (const k of ["correlationId", "agentRunId", "modelRunId", "strategyEvaluationId", "creExecutionId", "authorizationId", "capabilityId", "txHash"]) {
      expect(Object.keys(e), `${k} must be its own field`).toContain(k);
    }
    expect(EVENT_SEVERITIES).toContain("CRITICAL");
    expect(EVENT_TYPES.length).toBeGreaterThan(40);
  });

  it("LIVE-001b identity is derived from content, and excludes when we noticed", () => {
    const d = draft();
    const a = deriveEventId({ ...d, schemaVersion: RUNTIME_EVENT_VERSION });
    const b = deriveEventId({ ...d, schemaVersion: RUNTIME_EVENT_VERSION });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Two observers seeing the same thing at different moments must agree, or a resumed cursor
    // with reorg overlap would duplicate everything it re-read.
    const store = new InMemoryEventStore();
    const first = store.append(d, NOW);
    const second = store.append(d, NOW + 60_000);
    expect(second.event.eventId).toBe(first.event.eventId);

    // A genuinely different observation is a different event.
    expect(deriveEventId({ ...d, schemaVersion: RUNTIME_EVENT_VERSION, timestamp: NOW + 1 })).not.toBe(a);
    expect(deriveEventId({ ...d, schemaVersion: RUNTIME_EVENT_VERSION, publicMetadata: { enabled: true } })).not.toBe(a);
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });
});

/* ════════════════════════════ ingestion ════════════════════════════ */

describe("ingestion", () => {
  it("LIVE-023 duplicate ingestion is idempotent, and the first observation is kept", () => {
    const store = new InMemoryEventStore();
    const first = store.append(draft(), NOW);
    expect(first.created).toBe(true);

    for (let i = 0; i < 5; i++) {
      const again = store.append(draft(), NOW + i * 1000);
      expect(again.created).toBe(false);
      expect(again.event.eventId).toBe(first.event.eventId);
      // When we noticed it a second time is not new information.
      expect(again.event.observedAtMs).toBe(NOW);
    }
    expect(store.count()).toBe(1);
  });

  it("LIVE-023b events are not mutated; a correction is a new record naming the old one", () => {
    const store = new InMemoryEventStore();
    const mined = store.append(draft({ type: "EXECUTION_MINED", source: "CHAIN", txHash: TX, publicMetadata: { block: "11674284" } }), NOW).event;

    const reorg = store.append(
      correctionOf(mined, { type: "EXECUTION_REORGED", severity: "WARNING", source: "CHAIN", timestamp: NOW + 60_000, publicMetadata: { reason: "block replaced" } }),
      NOW + 60_000,
    ).event;

    // Both survive. The history shows what was believed and when it stopped being true.
    expect(store.count()).toBe(2);
    expect(store.get(mined.eventId)).toMatchObject({ type: "EXECUTION_MINED" });
    expect(reorg.correctsEventId).toBe(mined.eventId);
    expect(reorg.correlationId).toBe(mined.correlationId);
    expect(reorg.txHash).toBe(mined.txHash);
    // The correction carries the original's identity so a reader can find it.
    expect(reorg.publicMetadata.corrects).toBe(mined.eventId);
  });

  it("LIVE-023c a malformed event is refused rather than stored partially", () => {
    const store = new InMemoryEventStore();
    expect(reasonOf(() => store.append(draft({ projectId: "" }), NOW))).toBe(APPEND_REASONS.MALFORMED);
    expect(reasonOf(() => store.append(draft({ txHash: "not-a-hash" }), NOW))).toBe(APPEND_REASONS.MALFORMED);
    expect(store.count()).toBe(0);
  });

  it("LIVE-028 the timeline is queryable by every axis an operator filters on", () => {
    const store = new InMemoryEventStore();
    store.append(draft({ type: "DECISION_DENY", source: "CONTEXTLOCK", severity: "WARNING", timestamp: NOW + 1 }), NOW);
    store.append(draft({ type: "DECISION_ALLOW", source: "CONTEXTLOCK", timestamp: NOW + 2, correlationId: "corr_2" }), NOW);
    store.append(draft({ type: "ADAPTER_READ", source: "ADAPTER", adapterId: "aave-v3", timestamp: NOW + 3, correlationId: "corr_2" }), NOW);
    store.append(draft({ type: "EXECUTION_MINED", source: "CHAIN", txHash: TX, timestamp: NOW + 4, correlationId: "corr_2" }), NOW);

    expect(store.query({ source: "CONTEXTLOCK" })).toHaveLength(2);
    expect(store.query({ adapterId: "aave-v3" })).toHaveLength(1);
    expect(store.query({ txHash: TX })).toHaveLength(1);
    expect(store.query({ minSeverity: "WARNING" })).toHaveLength(1);
    expect(store.query({ correlationId: "corr_2" })).toHaveLength(3);
    expect(store.query({ deploymentId: "dep_group_e_live_0001" })).toHaveLength(4);
    expect(store.query({ sinceMs: NOW + 3 })).toHaveLength(2);

    // Ordering is total and stable, so two reads of the same timeline agree.
    const asc = store.query({}).map((e) => e.timestamp);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    expect(store.query({ order: "desc" })[0]!.timestamp).toBe(NOW + 4);
    expect(store.query({ limit: 2 })).toHaveLength(2);
  });

  it("LIVE-029 a reporting agent's events show it never executes", () => {
    const store = new InMemoryEventStore();
    // A reporter observes and decides NO_ACTION. It never reaches an execution stage.
    store.append(draft({ agentId: "reporter", type: "ADAPTER_READ", source: "ADAPTER", adapterId: "the-graph", correlationId: "corr_rep", timestamp: NOW }), NOW);
    store.append(draft({ agentId: "reporter", type: "DECISION_NO_ACTION", source: "CONTEXTLOCK", correlationId: "corr_rep", timestamp: NOW + 1 }), NOW);

    const trace = buildTrace("corr_rep", store.query({}));
    expect(trace.reached).toBe("CONTEXTLOCK_DECISION");
    expect(trace.identifiers.txHashes).toEqual([]);
    expect(trace.identifiers.capabilityIds).toEqual([]);
    // Independent agents in one organization keep separate event streams.
    expect(store.query({ agentId: "reporter" })).toHaveLength(2);
    expect(store.query({ agentId: "guardian" })).toHaveLength(0);
  });
});

/* ════════════════════════════ redaction ════════════════════════════ */

describe("the event model is public-safe", () => {
  it("LIVE-003 secrets and private values are absent, at every depth, on every surface", () => {
    // The obvious half.
    expect(scanForSecrets({ OPENAI_API_KEY: CANARIES.openaiKey }).length).toBeGreaterThan(0);
    expect(scanForSecrets({ deep: { deeper: [{ token: CANARIES.jwt }] } }).map((h) => h.kind)).toContain("jwt");
    expect(scanForSecrets({ path: CANARIES.cresession }).map((h) => h.kind)).toContain("cre-session-path");
    expect(scanForSecrets({ signerKey: CANARIES.privateKey }).length).toBeGreaterThan(0);

    // The half that actually gets leaked by monitoring code.
    for (const field of ["privateThreshold", "rawConfidentialResponse", "chainOfThought", "systemPrompt", "reasoningTrace"]) {
      expect(FORBIDDEN_FIELD_NAMES.has(field), `${field} must be forbidden`).toBe(true);
      expect(scanForSecrets({ publicMetadata: { [field]: "anything" } }).map((h) => h.kind)).toContain("forbidden-field-name");
    }

    // Nested inside arrays inside objects — §25.4 says do not check only top-level fields.
    expect(scanForSecrets({ a: [{ b: { c: [{ apiKey: "x" }] } }] }).length).toBeGreaterThan(0);

    // And it must NOT fire on the hashes a monitoring payload legitimately carries.
    expect(scanForSecrets({ txHash: TX, codeHash: TX, blueprintHash: TX, eventId: TX })).toEqual([]);

    // A finding never quotes the value it found.
    const hit = scanForSecrets({ k: CANARIES.openaiKey })[0]!;
    expect(hit.excerpt).not.toContain("NOT-A-REAL-KEY-CANARY");
  });

  it("LIVE-003b the store refuses to persist an event carrying a secret", () => {
    const store = new InMemoryEventStore();
    expect(() => store.append(draft({ publicMetadata: { apiKey: CANARIES.openaiKey } }), NOW)).toThrow(RedactionError);
    expect(() => store.append(draft({ publicMetadata: { nested: { chainOfThought: "the agent reasoned that..." } } }), NOW)).toThrow(RedactionError);
    // Refused BEFORE it gets an id, so nothing downstream can reference something that was rejected.
    expect(store.count()).toBe(0);
  });

  it("LIVE-048 the same scanner covers all five surfaces, including OTel attributes", () => {
    expect(REDACTED_SURFACES).toContain("otel-attributes");
    expect(REDACTED_SURFACES).toContain("alert-payload");
    expect(REDACTED_SURFACES).toContain("api-response");
    expect(REDACTED_SURFACES).toContain("structured-log");
    for (const surface of REDACTED_SURFACES) {
      expect(() => assertPublicSafe({ nested: { apiKey: CANARIES.openaiKey } }, surface), surface).toThrow(RedactionError);
      expect(() => assertPublicSafe({ deploymentId: "dep_1", enabled: false }, surface), surface).not.toThrow();
    }
  });

  it("LIVE-003c redaction replaces rather than hides, and survives a cyclic payload", () => {
    const out = redact({ ok: "fine", key: CANARIES.openaiKey, nested: { apiKey: "x" } });
    expect(out.ok).toBe("fine");
    expect(JSON.stringify(out)).toContain("[redacted");
    expect(JSON.stringify(out)).not.toContain("NOT-A-REAL-KEY-CANARY");

    // A cycle must not hang the scanner: a payload that hangs it is a payload that ships unscanned
    // the moment someone adds a timeout.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => scanForSecrets(cyclic)).not.toThrow();
  });
});

/* ════════════════════════════ correlation ════════════════════════════ */

describe("end-to-end correlation", () => {
  const fullAction = () => {
    const store = new InMemoryEventStore();
    const corr = "corr_action_1";
    const runId = "run_abc";
    const steps: Array<[EventDraft["type"], EventDraft["source"], number, Partial<EventDraft>]> = [
      ["AGENT_TRIGGERED", "AGENT", 0, { agentRunId: runId }],
      ["ADAPTER_READ", "ADAPTER", 1, { agentRunId: runId, adapterId: "aave-v3" }],
      ["STRATEGY_EVALUATED", "AGENT", 2, { agentRunId: runId, strategyEvaluationId: "seval_1" }],
      ["MODEL_REQUESTED", "MODEL_GATEWAY", 3, { agentRunId: runId, modelRunId: "mrun_1" }],
      ["MODEL_COMPLETED", "MODEL_GATEWAY", 4, { agentRunId: runId, modelRunId: "mrun_1" }],
      ["CRE_EXECUTION_STARTED", "CRE", 5, { creExecutionId: "cexec_1", creWorkflowId: "wf_1" }],
      ["CRE_EXECUTION_COMPLETED", "CRE", 6, { creExecutionId: "cexec_1", creWorkflowId: "wf_1" }],
      ["DECISION_ALLOW", "CONTEXTLOCK", 7, { strategyEvaluationId: "seval_1" }],
      ["AUTHORIZATION_RECORDED", "CONTEXTLOCK", 8, { authorizationId: "auth_1" }],
      ["CAPABILITY_ISSUED", "CONTEXTLOCK", 9, { capabilityId: "cap_1", authorizationId: "auth_1" }],
      ["EXECUTION_SUBMITTED", "CHAIN", 10, { txHash: TX, capabilityId: "cap_1" }],
      ["EXECUTION_MINED", "CHAIN", 11, { txHash: TX }],
      ["EXECUTION_FINALIZED", "CHAIN", 12, { txHash: TX }],
    ];
    for (const [type, source, dt, extra] of steps) {
      store.append(draft({ type, source, timestamp: NOW + dt, correlationId: corr, chainId: 11155111, ...extra }), NOW + dt);
    }
    return { store, corr };
  };

  it("LIVE-002 one correlation id spans trigger to finalized transaction", () => {
    const { store, corr } = fullAction();
    const trace = buildTrace(corr, store.query({}));

    // Every stage §25.5 names, in order.
    expect(trace.stages.map((s) => s.stage)).toEqual([
      "TRIGGER", "DATA_READ", "STRATEGY_EVALUATION", "MODEL_INVOCATION",
      "CRE_EVALUATION", "CONTEXTLOCK_DECISION", "AUTHORIZATION", "CAPABILITY",
      "SUBMISSION", "TRANSACTION", "FINALIZED",
    ]);
    expect(trace.reached).toBe("FINALIZED");
    expect(trace.identifiers).toMatchObject({
      agentRunIds: ["run_abc"], modelRunIds: ["mrun_1"], strategyEvaluationIds: ["seval_1"],
      creExecutionIds: ["cexec_1"], authorizationIds: ["auth_1"], capabilityIds: ["cap_1"], txHashes: [TX],
    });
  });

  it("LIVE-002b a transaction hash navigates back to the trigger that caused it", () => {
    const { store, corr } = fullAction();
    // A block explorer gives a user a tx hash and nothing else. That is the entry point.
    expect(correlationIdFor(store.query({}), { txHash: TX })).toBe(corr);
    expect(correlationIdFor(store.query({}), { txHash: TX.toUpperCase() })).toBe(corr);
    expect(correlationIdFor(store.query({}), { capabilityId: "cap_1" })).toBe(corr);
    expect(correlationIdFor(store.query({}), { creExecutionId: "cexec_1" })).toBe(corr);
    expect(correlationIdFor(store.query({}), { agentRunId: "run_abc" })).toBe(corr);
    expect(correlationIdFor(store.query({}), { txHash: `0x${"99".repeat(32)}` })).toBeNull();

    const trace = buildTrace(corr, store.query({}));
    expect(trace.stages[0]!.events[0]!.type).toBe("AGENT_TRIGGERED");
  });

  it("LIVE-002c stages are ordered by the action's sequence, not by observation time", () => {
    const store = new InMemoryEventStore();
    const corr = "corr_lag";
    // A chain observer polling every 12s reports a receipt AFTER a runtime reported a submission
    // it saw instantly — so the receipt's timestamp can precede the submission's observation.
    store.append(draft({ type: "EXECUTION_MINED", source: "CHAIN", correlationId: corr, timestamp: NOW + 5, txHash: TX }), NOW + 100);
    store.append(draft({ type: "EXECUTION_SUBMITTED", source: "CHAIN", correlationId: corr, timestamp: NOW + 1, txHash: TX }), NOW + 200);
    const trace = buildTrace(corr, store.query({}));
    expect(trace.stages.map((s) => s.stage)).toEqual(["SUBMISSION", "TRANSACTION"]);
  });

  it("LIVE-002d chain-of-thought is not tracing data, and baggage carries identifiers only", () => {
    expect(SafeTraceContextSchema.safeParse({ correlationId: "c", agentRunId: null, deploymentId: "d", agentId: null }).success).toBe(true);
    // The context type has nowhere to put a verdict, an amount or a threshold.
    const keys = Object.keys(SafeTraceContextSchema.shape);
    for (const forbidden of FORBIDDEN_BAGGAGE_KEYS) expect(keys).not.toContain(forbidden);
    expect(keys.sort()).toEqual(["agentId", "agentRunId", "correlationId", "deploymentId"]);

    expect(stageOf("MODEL_COMPLETED")).toBe("MODEL_INVOCATION");
    expect(stageOf("ALERT_RAISED")).toBeNull();
    expect(TRACE_STAGES[TRACE_STAGES.length - 1]).toBe("FINALIZED");
  });

  it("LIVE-024b a corrected trace says so", () => {
    const store = new InMemoryEventStore();
    const mined = store.append(draft({ type: "EXECUTION_MINED", source: "CHAIN", correlationId: "corr_r", txHash: TX, timestamp: NOW }), NOW).event;
    store.append(correctionOf(mined, { type: "EXECUTION_REORGED", severity: "WARNING", source: "CHAIN", timestamp: NOW + 10, publicMetadata: {} }), NOW + 10);
    expect(buildTrace("corr_r", store.query({})).corrected).toBe(true);
  });
});

describe("identifiers", () => {
  it("LIVE-002e generated identifiers are distinguishable and unique", () => {
    expect(newCorrelationId()).toMatch(/^corr_[0-9a-f-]{36}$/);
    expect(newRunId("run")).toMatch(/^run_[0-9a-f-]{12}$/);
    expect(new Set(Array.from({ length: 50 }, () => newCorrelationId())).size).toBe(50);
  });
});
