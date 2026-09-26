import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  loadConfig, assertNoForbiddenEnvironment, FORBIDDEN_ENV, FORBIDDEN_PATHS, RuntimeStartupError, RuntimeConfigSchema,
  evaluateHealth, HEALTH_NOTE, RUNTIME_HEALTH_STATES,
  RUNTIME_OPERATIONS, FORBIDDEN_RUNTIME_OPERATIONS, OPERATION_GATEWAY, ModelRequestSchema,
  ProcessedEventLog, EventCursorSchema,
} from "../src/index.js";

const NOW = 1_770_000_000_000;

/** The minimum a runtime needs to start. Notably: not one credential. */
const goodEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  CONTEXTLOCK_DEPLOYMENT_ID: "dep_1",
  CONTEXTLOCK_AGENT_ID: "guardian",
  CONTEXTLOCK_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
  CONTEXTLOCK_BLUEPRINT_HASH: `sha256:${"b".repeat(64)}`,
  CONTEXTLOCK_STRATEGY_HASH: `sha256:${"c".repeat(64)}`,
  CONTEXTLOCK_MODEL_GATEWAY_URL: "https://gw.test/model",
  CONTEXTLOCK_ADAPTER_BROKER_URL: "https://gw.test/adapter",
  CONTEXTLOCK_BROKER_URL: "https://gw.test/contextlock",
  CONTEXTLOCK_TELEMETRY_URL: "https://gw.test/telemetry",
  ...over,
});

describe("the runtime's configuration", () => {
  it("RT-001 a runtime starts with identifiers, endpoints and hashes — and no credential", () => {
    const c = loadConfig(goodEnv());
    expect(c.agentId).toBe("guardian");
    expect(c.runtimeTokenPath).toBe("/run/contextlock/runtime-token");

    // The test for whether a field belongs in this process: would an attacker who read it learn
    // anything useful? Every field here fails that test, which is why it is here.
    const serialized = JSON.stringify(c);
    expect(serialized).not.toMatch(/sk-|eyJ|BEGIN PRIVATE KEY|0x[0-9a-f]{64}(?!")/);
    // `runtimeTokenPath` is excluded deliberately: a PATH is configuration, and the token itself is
    // read from that path at startup and never becomes a config field.
    const fields = Object.keys(c).filter((k) => k !== "runtimeTokenPath").map((k) => k.toLowerCase());
    for (const forbidden of ["apikey", "privatekey", "secret", "token", "password", "credential"]) {
      expect(fields.join(" "), `no config field may be named like a ${forbidden}`).not.toContain(forbidden);
    }
    expect(Object.keys(c)).toContain("runtimeTokenPath");
    expect(Object.keys(c)).not.toContain("runtimeToken");
  });

  it("RT-002 the credential check runs BEFORE the configuration is even parsed", () => {
    // An environment that is both invalid AND carrying a key must fail on the key. Otherwise a
    // misconfigured runtime would report a schema error and give no sign that a wallet key was
    // sitting in its environment.
    const err = (() => { try { loadConfig({ AGENT_PRIVATE_KEY: `0x${"1".repeat(64)}` }); return null; } catch (e) { return e as RuntimeStartupError; } })();
    expect(err).not.toBeNull();
    expect(err!.reason).toBe("RUNTIME-FORBIDDEN-CREDENTIAL-PRESENT");
    expect(err!.reason).not.toBe("RUNTIME-CONFIG-INVALID");
  });

  it("RT-003 an incomplete configuration is refused by name, not defaulted", () => {
    const err = (() => { try { loadConfig({ CONTEXTLOCK_AGENT_ID: "guardian" }); return null; } catch (e) { return e as RuntimeStartupError; } })();
    expect(err!.reason).toBe("RUNTIME-CONFIG-INVALID");
    expect(err!.message).toContain("modelGatewayUrl");
    // A gateway URL that is not a URL is refused rather than becoming a relative fetch.
    expect(() => loadConfig(goodEnv({ CONTEXTLOCK_MODEL_GATEWAY_URL: "gw.test" }))).toThrow(/modelGatewayUrl/);
    // An image digest that is not a digest is refused; the token is bound to it.
    expect(() => loadConfig(goodEnv({ CONTEXTLOCK_IMAGE_DIGEST: "latest" }))).toThrow(/imageDigest/);
  });

  it("RT-004 the forbidden lists cover every credential class this product handles", () => {
    for (const key of [
      "AGENT_PRIVATE_KEY", "CAPABILITY_ISSUER_PRIVATE_KEY", "CONTEXTLOCK_ADMIN_KEY",
      "CRE_API_KEY", "CRE_SESSION", "OPENAI_API_KEY", "THEGRAPH_API_KEY", "E2B_API_KEY",
      "AWS_SECRET_ACCESS_KEY", "LEDGER_SEED", "LEDGER_PIN",
    ]) {
      expect(FORBIDDEN_ENV, `${key} must be denied`).toContain(key);
    }
    expect(FORBIDDEN_PATHS).toContain("/var/run/docker.sock");
    expect(FORBIDDEN_PATHS).toContain("/app/.env");
    expect(() => assertNoForbiddenEnvironment(goodEnv())).not.toThrow();
    // An empty value is not a credential; refusing it would make an unset variable a startup failure.
    expect(() => assertNoForbiddenEnvironment({ OPENAI_API_KEY: "" })).not.toThrow();
  });

  it("RT-005 the runtime's operation vocabulary is closed and routes to exactly one gateway each", () => {
    for (const op of RUNTIME_OPERATIONS) {
      expect(OPERATION_GATEWAY[op], `${op} must name a gateway`).toBeTruthy();
      expect(FORBIDDEN_RUNTIME_OPERATIONS.has(op), `${op} cannot be both allowed and forbidden`).toBe(false);
    }
    // A model request has no `model` field to fill in.
    expect(Object.keys(ModelRequestSchema.shape)).not.toContain("model");
    expect(ModelRequestSchema.safeParse({ operation: "model.complete", messages: [], maxOutputTokens: 100_000, toolNames: [], correlationId: "c" }).success).toBe(false);
  });

  it("RT-006 the Dockerfile pins its base by digest, runs non-root, and carries no shell entrypoint", () => {
    const df = readFileSync("apps/agent-runtime/Dockerfile", "utf8");
    // A tag would make this file describe a different image tomorrow.
    expect(df).toMatch(/ARG BASE_DIGEST=sha256:[0-9a-f]{64}/);
    expect(df).toMatch(/FROM node@\$\{BASE_DIGEST\}/);
    expect(df).not.toMatch(/^FROM node:\d/m);
    expect(df).toMatch(/USER 10001:10001/);
    // Exec form, so a signal reaches the runtime rather than a shell that ignores it.
    expect(df).toMatch(/ENTRYPOINT \["node", "dist\/main\.js"\]/);
    expect(df).not.toMatch(/ENTRYPOINT\s+node/);
    // Multi-stage: the toolchain that builds the runtime is not in the image that runs it.
    expect((df.match(/^FROM /gm) ?? []).length).toBeGreaterThanOrEqual(2);

    const ignore = readFileSync("apps/agent-runtime/.dockerignore", "utf8");
    for (const p of [".env", ".cre", ".aws", "**/*.key"]) expect(ignore).toContain(p);
  });

  it("RT-007 health has a state for every situation, and none of them implies authority", () => {
    expect(RUNTIME_HEALTH_STATES).toContain("CRASH_LOOP");
    expect(RUNTIME_HEALTH_STATES).toContain("DEGRADED");
    expect(HEALTH_NOTE).toMatch(/ContextLock policy on chain decides/);
    const v = evaluateHealth({
      processStartedAtMs: NOW - 120_000, lastHeartbeatMs: NOW - 1000,
      controlPlaneReachable: true, modelGatewayReachable: true, adapterBrokerReachable: true,
      contextlockBrokerReachable: true, eventCursorAgeMs: null, paused: false, stopping: false,
      recentRestarts: 0, nowMs: NOW,
    });
    expect(v.state).toBe("HEALTHY");
    // An agent that is not event-driven has no cursor, and that is not a health problem.
    expect(v.reasons).toEqual([]);
  });

  it("RT-008 an event cursor names the agent it belongs to and the finalized block it reached", () => {
    const ok = EventCursorSchema.safeParse({
      chainId: 11155111, subscriptionId: "sub_1", eventSource: "ContextLockExecutor",
      lastFinalizedBlock: "11673800", lastProcessedEventId: "11155111:11673800:0xabc:2",
      checkpointedAtMs: NOW, agentId: "guardian", deploymentId: "dep_1",
    });
    expect(ok.success).toBe(true);
    // A block number as a JS number would lose precision on a long-lived chain and is refused.
    expect(EventCursorSchema.safeParse({ chainId: 1, subscriptionId: "s", eventSource: "e", lastFinalizedBlock: 11673800, lastProcessedEventId: "x", checkpointedAtMs: NOW, agentId: "a", deploymentId: "d" }).success).toBe(false);

    const log = new ProcessedEventLog();
    expect(log.admit("e1", NOW)).toBe(true);
    expect(log.admit("e1", NOW)).toBe(false);
  });
});
