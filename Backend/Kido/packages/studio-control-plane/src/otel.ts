import { z } from "zod";
import { assertPublicSafe, scanForSecrets, type RedactionHit } from "@contextlock/studio-events";

/**
 * OpenTelemetry.
 *
 * Traces and metrics, exported over OTLP, behind configuration. Two constraints from §25.22–25.24
 * shape everything here, and neither is about instrumentation.
 *
 * TELEMETRY IS NOT THE AUDIT LEDGER (§25.23). `RuntimeEvent` is the canonical financial and
 * operational record. Traces and metrics are infrastructure observability: sampled, dropped when a
 * collector is down, exported to somewhere we do not control. Nothing in `studio-events` imports
 * this file, so a broken exporter cannot lose an audit event — LIVE-047 proves it by wiring an
 * exporter that throws on every call and asserting the event store is unaffected.
 *
 * CARDINALITY IS BOUNDED (§25.24). `txHash`, `walletAddress` and `correlationId` are forbidden as
 * metric labels, and the guard is a function rather than a comment. Each of them is unbounded: one
 * label value per transaction means one time series per transaction, which takes down the metrics
 * backend rather than the application, some hours later, for reasons nobody connects back.
 */

/**
 * Versions, pinned after checking what is current.
 *
 * The OTel JS project ships stable packages at 1.x/2.x and experimental ones at 0.x. Traces and
 * metrics are stable; the exporters carry the experimental version number because the OTLP protocol
 * packages have not declared stability. Logs are NOT used here — §25.8 says to treat them
 * separately because their JS maturity differs, and `RuntimeEvent` is the audit surface anyway.
 */
export const OTEL_VERSIONS = {
  "@opentelemetry/api": "1.9.1",
  "@opentelemetry/resources": "2.11.0",
  "@opentelemetry/sdk-trace-node": "2.11.0",
  "@opentelemetry/sdk-metrics": "2.11.0",
  "@opentelemetry/semantic-conventions": "1.43.0",
  "@opentelemetry/exporter-trace-otlp-http": "0.222.0",
  "@opentelemetry/exporter-metrics-otlp-http": "0.222.0",
} as const;

/* ────────────────────────────── metric names ────────────────────────────── */

export const METRICS = [
  "agent_runs_total",
  "agent_decisions_total",
  "agent_actions_total",
  "agent_action_failures_total",
  "capabilities_issued_total",
  "capabilities_rejected_total",
  "runtime_health",
  "runtime_restarts_total",
  "adapter_requests_total",
  "adapter_errors_total",
  "adapter_latency",
  "cre_sync_age",
  "chain_sync_age",
  "policy_state",
  "model_requests_total",
  "model_input_tokens",
  "model_output_tokens",
  "model_errors_total",
] as const;
export type MetricName = (typeof METRICS)[number];

/**
 * Labels a metric may carry.
 *
 * A closed allow-list, not a deny-list. A deny-list would have to anticipate every unbounded field
 * anyone ever adds; an allow-list means a new label is a decision someone makes on purpose.
 */
export const ALLOWED_METRIC_LABELS = [
  "deployment_id",
  "agent_id",
  "project_id",
  "adapter_id",
  "chain_id",
  "verdict",
  "state",
  "source",
  "outcome",
  "model",
  "rule",
  "severity",
] as const;
export type MetricLabel = (typeof ALLOWED_METRIC_LABELS)[number];

/**
 * Labels that are forbidden, named explicitly.
 *
 * The allow-list already excludes them. They are enumerated anyway so the refusal can say WHY —
 * "high cardinality" rather than "unknown label" — and so LIVE-045 can assert each by name.
 */
export const FORBIDDEN_METRIC_LABELS = [
  "tx_hash", "txHash", "transaction_hash",
  "wallet_address", "walletAddress", "address", "from", "to",
  "correlation_id", "correlationId",
  "capability_id", "capabilityId",
  "execution_id", "executionId",
  "event_id", "eventId",
  "block_number", "blockNumber",
  "user_id", "session_id", "request_id", "trace_id", "span_id",
] as const;

export const OTEL_REASONS = {
  HIGH_CARDINALITY: "OTEL-HIGH-CARDINALITY-LABEL",
  UNKNOWN_LABEL: "OTEL-UNKNOWN-LABEL",
  UNKNOWN_METRIC: "OTEL-UNKNOWN-METRIC",
  UNSAFE_ATTRIBUTE: "OTEL-UNSAFE-ATTRIBUTE",
} as const;
export type OtelReason = (typeof OTEL_REASONS)[keyof typeof OTEL_REASONS];

export class OtelError extends Error {
  constructor(readonly reason: OtelReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "OtelError";
  }
}

/**
 * The cardinality guard.
 *
 * Runs on every metric emission. Cheap, and the alternative is discovering the problem when the
 * metrics backend falls over.
 */
export function assertMetricLabels(metric: string, labels: Record<string, unknown>): void {
  if (!(METRICS as readonly string[]).includes(metric)) {
    throw new OtelError(OTEL_REASONS.UNKNOWN_METRIC, `"${metric}" is not a declared metric`);
  }
  for (const key of Object.keys(labels)) {
    if ((FORBIDDEN_METRIC_LABELS as readonly string[]).includes(key)) {
      throw new OtelError(
        OTEL_REASONS.HIGH_CARDINALITY,
        `"${key}" is unbounded and must not be a metric label — one time series per value would be created. Put it on a span attribute or a RuntimeEvent instead.`,
      );
    }
    if (!(ALLOWED_METRIC_LABELS as readonly string[]).includes(key)) {
      throw new OtelError(OTEL_REASONS.UNKNOWN_LABEL, `"${key}" is not in the metric label allow-list [${ALLOWED_METRIC_LABELS.join(", ")}]`);
    }
  }
}

/**
 * Span attributes go through the SAME recursive scanner as everything else (§25.4, LIVE-048).
 *
 * Traces are the surface most likely to accumulate a secret, because instrumenting code tends to
 * attach "whatever might be useful for debugging" — which is how a prompt, a threshold or a raw
 * provider response ends up at a vendor.
 */
export function assertSpanAttributesSafe(attributes: Record<string, unknown>): void {
  assertPublicSafe(attributes, "otel-attributes");
}

export const scanSpanAttributes = (attributes: Record<string, unknown>): RedactionHit[] => scanForSecrets(attributes, "otel-attributes");

/* ────────────────────────── the telemetry interface ────────────────────────── */

export interface Telemetry {
  counter(metric: MetricName, value: number, labels?: Partial<Record<MetricLabel, string | number>>): void;
  gauge(metric: MetricName, value: number, labels?: Partial<Record<MetricLabel, string | number>>): void;
  histogram(metric: MetricName, value: number, labels?: Partial<Record<MetricLabel, string | number>>): void;
  startSpan(name: string, attributes?: Record<string, unknown>): { end(attributes?: Record<string, unknown>): void; setAttribute(k: string, v: unknown): void };
}

export const OtelConfigSchema = z.object({
  enabled: z.boolean(),
  serviceName: z.string().min(1),
  /** No default endpoint. An unset exporter means telemetry stays local, not that it goes somewhere. */
  otlpTracesEndpoint: z.string().url().nullable(),
  otlpMetricsEndpoint: z.string().url().nullable(),
  sampleRatio: z.number().min(0).max(1),
});
export type OtelConfig = z.infer<typeof OtelConfigSchema>;

export const OTEL_DISABLED: OtelConfig = {
  enabled: false,
  serviceName: "contextlock-control-plane",
  otlpTracesEndpoint: null,
  otlpMetricsEndpoint: null,
  sampleRatio: 1,
};

/**
 * Telemetry that records nothing.
 *
 * The default. §25.22: do not make an external vendor mandatory. With no configuration the product
 * is fully functional and exports nothing — and, importantly, still validates labels and
 * attributes, so a cardinality bug or a leaked attribute is caught in development rather than on
 * the day someone enables the exporter.
 */
export class NoopTelemetry implements Telemetry {
  readonly emitted: Array<{ metric: string; value: number; labels: Record<string, unknown> }> = [];
  readonly spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];

  counter(metric: MetricName, value: number, labels: Record<string, unknown> = {}): void {
    assertMetricLabels(metric, labels);
    this.emitted.push({ metric, value, labels });
  }
  gauge(metric: MetricName, value: number, labels: Record<string, unknown> = {}): void {
    assertMetricLabels(metric, labels);
    this.emitted.push({ metric, value, labels });
  }
  histogram(metric: MetricName, value: number, labels: Record<string, unknown> = {}): void {
    assertMetricLabels(metric, labels);
    this.emitted.push({ metric, value, labels });
  }
  startSpan(name: string, attributes: Record<string, unknown> = {}) {
    assertSpanAttributesSafe(attributes);
    const record = { name, attributes: { ...attributes } };
    this.spans.push(record);
    return {
      end: (extra: Record<string, unknown> = {}) => {
        assertSpanAttributesSafe(extra);
        Object.assign(record.attributes, extra);
      },
      setAttribute: (k: string, v: unknown) => {
        assertSpanAttributesSafe({ [k]: v });
        record.attributes[k] = v;
      },
    };
  }
}

/**
 * Numeric encodings for gauges.
 *
 * A gauge cannot carry a string, and putting the state in a LABEL would create a series per state
 * that never goes to zero when the state changes — the classic way a "current state" metric ends up
 * showing every state the system has ever been in, simultaneously.
 */
export const POLICY_STATE_GAUGE = { UNKNOWN: -1, DISABLED: 0, ENABLED: 1 } as const;
export const RUNTIME_HEALTH_GAUGE = {
  UNKNOWN: -1, STOPPED: 0, PAUSED: 1, CRASH_LOOP: 2, FAILED: 3, PROVISIONING: 4,
  STARTING: 5, DEGRADED: 6, STOPPING: 7, HEALTHY: 10,
} as const;
