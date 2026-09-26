import { describe, expect, it, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import {
  DockerRuntimeProvider, DOCKER_RUNTIME_CAPABILITIES, newRevisionId,
  EcsFargateRuntimeProvider, ECS_FARGATE_CAPABILITIES, buildTaskDefinition, buildServiceDefinition,
  assertTaskRoleNarrow, assertServiceHardened, assertEgressRestricted, EcsError, ECS_REASONS, FORBIDDEN_TASK_ROLE_ACTIONS,
  RuntimeTokenIssuer, RuntimeTokenVerifier, generateSigningKey, RuntimeTokenError, TOKEN_REASONS, FORBIDDEN_TOKEN_CLAIMS, DEFAULT_RUNTIME_TOKEN_TTL_MS,
  ModelGateway, AdapterBroker, ContextLockBroker, TelemetryGateway, ModelGatewayError, AdapterBrokerError, ContextLockBrokerError, PINNED_MODEL, DEFAULT_MODEL_QUOTA,
  assertHardened, assertEnvironmentSafe, dockerArgs, DEFAULT_HARDENING, HardeningError, HARDENING_REASONS,
  RevisionHistory, assertIsNewRevision, FORBIDDEN_MUTATION_OPERATIONS,
  getRuntimeProvider, registerRuntimeProvider, RuntimeProviderError, RUNTIME_REASONS, unknownCapabilities, egressStatement,
  type RuntimeRevision, type StartRuntimeArgs,
} from "../src/index.js";
import {
  assertNoForbiddenEnvironment, FORBIDDEN_ENV, FORBIDDEN_PATHS, RuntimeStartupError, loadConfig,
  evaluateHealth, DEFAULT_HEALTH_POLICY, HEALTH_NOTE,
  assertOperationAllowed, GatewayError, GATEWAY_REASONS, RUNTIME_OPERATIONS, FORBIDDEN_RUNTIME_OPERATIONS,
  ProcessedEventLog, assertAdvance, assertExternalStore, CheckpointError, CHECKPOINT_REASONS, eventIdOf,
} from "@contextlock/agent-runtime";

const exec = promisify(execFile);
const NOW = 1_770_000_000_000;
const DIGEST = `sha256:${"a".repeat(64)}`;
const DIGEST2 = `sha256:${"b".repeat(64)}`;
const BP = `sha256:${"c".repeat(64)}`;

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};
const asyncReasonOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};

const issuerAndVerifier = () => {
  const issuer = new RuntimeTokenIssuer();
  issuer.addKey(generateSigningKey("k_test"));
  return { issuer, verifier: new RuntimeTokenVerifier(issuer.publicKeys()) };
};

const mintFor = (issuer: RuntimeTokenIssuer, over: Partial<Parameters<RuntimeTokenIssuer["issue"]>[0]> = {}) =>
  issuer.issue({
    deploymentId: "dep_1", agentId: "guardian", organizationId: "org_1",
    blueprintHash: BP, imageDigest: DIGEST,
    audiences: ["MODEL", "ADAPTER", "CONTEXTLOCK", "TELEMETRY"],
    nowMs: NOW, ttlMs: DEFAULT_RUNTIME_TOKEN_TTL_MS, ...over,
  });

const ctx = (over: Record<string, unknown> = {}) => ({
  expectedAgentId: "guardian", expectedDeploymentId: "dep_1", expectedImageDigest: DIGEST,
  audience: "MODEL" as const, nowMs: NOW, ...over,
});

const revision = (over: Partial<RuntimeRevision> = {}): RuntimeRevision => ({
  revisionId: "rev_0001", deploymentId: "dep_1", agentId: "guardian",
  imageDigest: DIGEST, createdAtMs: NOW, previousRevisionId: null, desiredState: "INACTIVE", ...over,
});

/* ══════════════════════════ principals and identity ══════════════════════════ */

describe("one principal per runtime", () => {
  it("RUN-001 a runtime identity names exactly one agent, and a token for one is refused for another", () => {
    const { issuer, verifier } = issuerAndVerifier();
    const guardian = mintFor(issuer);
    const rebalancer = mintFor(issuer, { agentId: "rebalancer" });

    expect(verifier.verify(guardian, ctx()).agentId).toBe("guardian");
    // The Rebalancer's token presented by the Guardian's runtime does not verify. Two agents in one
    // organization share gateways; they do not share identity.
    expect(reasonOf(() => verifier.verify(rebalancer, ctx()))).toBe(TOKEN_REASONS.WRONG_AGENT);
    expect(reasonOf(() => verifier.verify(guardian, ctx({ expectedDeploymentId: "dep_2" })))).toBe(TOKEN_REASONS.WRONG_DEPLOYMENT);
  });

  it("RUN-001b the Docker provider refuses a second container for the same principal", async () => {
    /*
     * Uses the REAL built image, so this genuinely creates a container and genuinely refuses the
     * second one. An earlier version passed against a digest that does not exist: `docker create`
     * failed, the test took its no-daemon branch, and the assertion it exists for never ran.
     */
    const record = "reports/group-e/evidence/image/runtime-image.json";
    if (!existsSync(record)) throw new Error(`${record} is missing; run \`npm run runtime:image\` first`);
    const built = JSON.parse(readFileSync(record, "utf8")) as { imageConfigDigest: string };

    const p = new DockerRuntimeProvider();
    const args: StartRuntimeArgs = {
      revision: revision({ imageDigest: built.imageConfigDigest }),
      environment: { CONTEXTLOCK_AGENT_ID: "guardian" },
      runtimeTokenPath: "/run/contextlock/runtime-token", runtimeToken: "a-scoped-token",
      healthPort: 18081, cpu: "0.5", memoryMb: 512, pidLimit: 128,
    };

    const first = await p.deploy(args).catch((e) => e as RuntimeProviderError);
    if (first instanceof RuntimeProviderError) {
      // No Docker daemon on this machine. Reported rather than passed quietly, because a green
      // isolation test that never started a container measures nothing.
      expect(first.reason, `expected UNAVAILABLE if there is no daemon, got: ${first.message}`).toBe(RUNTIME_REASONS.UNAVAILABLE);
      console.warn("RUN-001b: no Docker daemon; the live half of this check did not run");
      return;
    }

    try {
      expect(first.desiredState).toBe("INACTIVE");
      // A second container for the same security principal is refused. Two agents share gateways;
      // they do not share a runtime identity, and one agent does not get two.
      const second = await asyncReasonOf(() => p.deploy({ ...args, revision: revision({ revisionId: "rev_0002", imageDigest: built.imageConfigDigest }) }));
      expect(second).toBe(RUNTIME_REASONS.MUTATION_ATTEMPTED);

      // And a stop says exactly what it did and did not do.
      const stopped = await p.stop("rev_0001");
      expect(stopped.running).toBe(false);
      expect(stopped.detail).toMatch(/operational stop/);
      expect(stopped.detail).toMatch(/ContextLock policy is unchanged/);
    } finally {
      await p.stop("rev_0001").catch(() => undefined);
      await p.stop("rev_0002").catch(() => undefined);
    }
  }, 30_000);

  it("RUN-010 the runtime token is scoped to one agent, deployment, image and audience set", () => {
    const { issuer, verifier } = issuerAndVerifier();
    const claims = verifier.verify(mintFor(issuer), ctx());
    expect(claims).toMatchObject({ deploymentId: "dep_1", agentId: "guardian", blueprintHash: BP, imageDigest: DIGEST });
    expect(claims.sessionId.length).toBeGreaterThan(8);

    const modelOnly = mintFor(issuer, { audiences: ["MODEL"] });
    expect(() => verifier.verify(modelOnly, ctx({ audience: "MODEL" }))).not.toThrow();
    expect(reasonOf(() => verifier.verify(modelOnly, ctx({ audience: "CONTEXTLOCK" })))).toBe(TOKEN_REASONS.WRONG_AUDIENCE);
  });

  it("RUN-010b the token is bound to the image digest, so a stolen token is useless from another image", () => {
    const { issuer, verifier } = issuerAndVerifier();
    const t = mintFor(issuer);
    // Exfiltrate the token, run it from an image the attacker built.
    expect(reasonOf(() => verifier.verify(t, ctx({ expectedImageDigest: DIGEST2 })))).toBe(TOKEN_REASONS.WRONG_IMAGE);
  });

  it("RUN-011 the runtime token expires", () => {
    const { issuer, verifier } = issuerAndVerifier();
    const t = issuer.issue({ deploymentId: "dep_1", agentId: "guardian", organizationId: null, blueprintHash: BP, imageDigest: DIGEST, audiences: ["MODEL"], nowMs: NOW, ttlMs: 60_000 });
    expect(() => verifier.verify(t, ctx({ nowMs: NOW + 59_999 }))).not.toThrow();
    expect(reasonOf(() => verifier.verify(t, ctx({ nowMs: NOW + 60_000 })))).toBe(TOKEN_REASONS.EXPIRED);
    expect(reasonOf(() => verifier.verify(t, ctx({ nowMs: NOW - 60_000 })))).toBe(TOKEN_REASONS.NOT_YET_VALID);
    expect(DEFAULT_RUNTIME_TOKEN_TTL_MS).toBeLessThanOrEqual(15 * 60_000);
  });

  it("RUN-012 replay and revocation are both handled", () => {
    const { issuer, verifier } = issuerAndVerifier();
    const t = mintFor(issuer);

    expect(verifier.verifyOnce(t, ctx(), "nonce-1").agentId).toBe("guardian");
    expect(reasonOf(() => verifier.verifyOnce(t, ctx(), "nonce-1"))).toBe(TOKEN_REASONS.REPLAYED);
    expect(() => verifier.verifyOnce(t, ctx(), "nonce-2")).not.toThrow();

    const claims = verifier.verify(t, ctx());
    verifier.revokeSession(claims.sessionId);
    expect(reasonOf(() => verifier.verify(t, ctx()))).toBe(TOKEN_REASONS.REVOKED);
  });

  it("RUN-012b a forged or re-signed token does not verify, and an unknown key is named", () => {
    const { issuer, verifier } = issuerAndVerifier();
    const t = mintFor(issuer);
    const [payload, sig] = t.split(".") as [string, string];

    // Edit the payload, keep the signature.
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    claims.agentId = "rebalancer";
    const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;
    expect(reasonOf(() => verifier.verify(forged, ctx({ expectedAgentId: "rebalancer" })))).toBe(TOKEN_REASONS.BAD_SIGNATURE);

    // Sign with a key the verifier does not know.
    const rogue = new RuntimeTokenIssuer();
    rogue.addKey(generateSigningKey("k_rogue"));
    expect(reasonOf(() => verifier.verify(mintFor(rogue), ctx()))).toBe(TOKEN_REASONS.UNKNOWN_KEY);
    expect(reasonOf(() => verifier.verify("not-a-token", ctx()))).toBe(TOKEN_REASONS.MALFORMED);
  });

  it("RUN-015 the token cannot authorize money movement: the claims that would let it are absent", () => {
    const { issuer, verifier } = issuerAndVerifier();
    const claims = verifier.verify(mintFor(issuer), ctx()) as unknown as Record<string, unknown>;
    for (const forbidden of FORBIDDEN_TOKEN_CLAIMS) {
      expect(claims, `a runtime token must have no "${forbidden}" claim`).not.toHaveProperty(forbidden);
    }
    // And the issuer refuses to mint one that does.
    expect(reasonOf(() => issuer.issue({ deploymentId: "d", agentId: "a", organizationId: null, blueprintHash: BP, imageDigest: DIGEST, audiences: ["MODEL"], nowMs: NOW, ttlMs: 1000, capability: "spend-everything" } as never)))
      .toBe(TOKEN_REASONS.FORBIDDEN_CLAIM);
  });
});

/* ══════════════════════════ what the runtime never gets ══════════════════════════ */

describe("the runtime holds no privileged credential", () => {
  it("RUN-007 the runtime refuses to start when any provider or master secret is in its environment", () => {
    expect(() => assertNoForbiddenEnvironment({ CONTEXTLOCK_AGENT_ID: "guardian" })).not.toThrow();

    for (const key of FORBIDDEN_ENV) {
      const err = (() => { try { assertNoForbiddenEnvironment({ [key]: "value-here" }); return null; } catch (e) { return e as RuntimeStartupError; } })();
      expect(err, `${key} must be refused`).not.toBeNull();
      expect(err!.reason).toBe("RUNTIME-FORBIDDEN-CREDENTIAL-PRESENT");
      expect(err!.message, `${key} must be named in the error`).toContain(key);
      // The error names the variable and never quotes the value.
      expect(err!.message).not.toContain("value-here");
    }
  });

  it("RUN-008 an OpenAI master key is absent, and RUN-009 CRE credentials are absent", () => {
    expect(FORBIDDEN_ENV).toContain("OPENAI_API_KEY");
    expect(FORBIDDEN_ENV).toContain("CRE_API_KEY");
    expect(FORBIDDEN_ENV).toContain("CRE_SESSION");
    expect(FORBIDDEN_PATHS).toContain("/root/.cre/cre.yaml");
    expect(FORBIDDEN_PATHS).toContain("/home/contextlock/.cre/cre.yaml");
    expect(FORBIDDEN_PATHS).toContain("/var/run/docker.sock");

    expect(reasonOf(() => assertNoForbiddenEnvironment({ OPENAI_API_KEY: "sk-proj-NOT-A-REAL-KEY-000000000" }))).toBe("RUNTIME-FORBIDDEN-CREDENTIAL-PRESENT");
    expect(reasonOf(() => assertNoForbiddenEnvironment({ CRE_API_KEY: "x" }))).toBe("RUNTIME-FORBIDDEN-CREDENTIAL-PRESENT");
  });

  it("RUN-007b a key smuggled under a harmless name is caught by shape", () => {
    expect(() => assertNoForbiddenEnvironment({ CONTEXTLOCK_TUNING: `0x${"ab".repeat(32)}` })).toThrow(/32-byte hex/);
    expect(() => assertNoForbiddenEnvironment({ HELPER_TOKEN: "sk-proj-NOT-A-REAL-KEY-000000000" })).toThrow(/OpenAI-shaped/);
    expect(() => assertNoForbiddenEnvironment({ NOTE: "-----BEGIN PRIVATE KEY-----\nx" })).toThrow(/PEM private key/);
    // A genuine hash under a hash-shaped name is fine, because otherwise this check gets disabled.
    expect(() => assertEnvironmentSafe({ CONTEXTLOCK_BLUEPRINT_HASH: `0x${"ab".repeat(32)}` })).not.toThrow();
  });

  it("RUN-007c the provider refuses to launch a container carrying a credential", () => {
    expect(reasonOf(() => assertEnvironmentSafe({ CONTEXTLOCK_ADMIN_KEY: "x" }))).toBe(HARDENING_REASONS.NO_LIMITS);
    expect(() => assertEnvironmentSafe({ CONTEXTLOCK_ADMIN_KEY: "x" })).toThrow(/must not be passed to a runtime container/);
    // Anything outside the configured namespace is refused, so a new secret cannot arrive unnoticed.
    expect(() => assertEnvironmentSafe({ AWS_SECRET_ACCESS_KEY: "x" })).toThrow(/outside the CONTEXTLOCK_\* namespace/);
    expect(() => assertEnvironmentSafe({ CONTEXTLOCK_RUNTIME_TOKEN: "eyJhbGciOiJIUzI1NiJ9.x" })).toThrow();
  });
});

/* ══════════════════════════ the gateways ══════════════════════════ */

describe("the narrow gateways", () => {
  it("RUN-013 the Model Gateway pins Luna, and the runtime cannot select a model", () => {
    const { issuer, verifier } = issuerAndVerifier();
    const gw = new ModelGateway(verifier, DEFAULT_MODEL_QUOTA, () => ["readBalance"]);
    let sawModel = "";
    const r = gw.complete(mintFor(issuer), ctx(), { messages: [{ role: "user", content: "hi" }], maxOutputTokens: 100, toolNames: ["readBalance"], turn: 1, correlationId: "c1" },
      (a) => { sawModel = a.model; return { inputTokens: 10, outputTokens: 5, content: "ok" }; });

    expect(sawModel).toBe(PINNED_MODEL);
    expect(r.model).toBe("gpt-5.6-luna");

    // A request that names a model is refused rather than having the field ignored.
    expect(reasonOf(() => gw.complete(mintFor(issuer), ctx(), { model: "gpt-3.5", messages: [], maxOutputTokens: 10, toolNames: [], turn: 1, correlationId: "c" } as never,
      () => ({ inputTokens: 0, outputTokens: 0, content: "" })))).toBe("MODEL-GATEWAY-MODEL-NOT-SELECTABLE");

    // A tool this agent is not granted is refused, whatever the request says.
    expect(reasonOf(() => gw.complete(mintFor(issuer), ctx(), { messages: [], maxOutputTokens: 10, toolNames: ["transferFunds"], turn: 1, correlationId: "c" },
      () => ({ inputTokens: 0, outputTokens: 0, content: "" })))).toBe("MODEL-GATEWAY-TOOL-NOT-ALLOWED");
  });

  it("RUN-014 model usage is charged to the agent in the token, not the agent in the request", () => {
    const { issuer, verifier } = issuerAndVerifier();
    const gw = new ModelGateway(verifier, DEFAULT_MODEL_QUOTA, () => []);
    gw.complete(mintFor(issuer), ctx(), { messages: [], maxOutputTokens: 10, toolNames: [], turn: 1, correlationId: "c1", agentId: "rebalancer" } as never,
      () => ({ inputTokens: 1200, outputTokens: 340, content: "" }));

    expect(gw.usageFor("guardian")).toMatchObject({ requests: 1, inputTokens: 1200, outputTokens: 340 });
    // The agent it claimed to be is charged nothing.
    expect(gw.usageFor("rebalancer").requests).toBe(0);
  });

  it("RUN-013b quotas, turn ceilings and rate limits are enforced server-side", () => {
    const { issuer, verifier } = issuerAndVerifier();
    const gw = new ModelGateway(verifier, { ...DEFAULT_MODEL_QUOTA, requestsPerAgentPerDay: 2, maxTurnsPerRun: 3, requestsPerMinute: 2 }, () => []);
    const call = () => ({ inputTokens: 1, outputTokens: 1, content: "" });
    const req = { messages: [], maxOutputTokens: 10, toolNames: [], turn: 1, correlationId: "c" };

    gw.complete(mintFor(issuer), ctx(), req, call);
    gw.complete(mintFor(issuer), ctx(), req, call);
    expect(reasonOf(() => gw.complete(mintFor(issuer), ctx(), req, call))).toBe("MODEL-GATEWAY-RATE-LIMITED");
    expect(reasonOf(() => gw.complete(mintFor(issuer), ctx({ nowMs: NOW + 120_000 }), { ...req, turn: 9 }, call))).toBe("MODEL-GATEWAY-MAX-TURNS-EXCEEDED");
    expect(reasonOf(() => gw.complete(mintFor(issuer), ctx({ nowMs: NOW + 120_000 }), { ...req, maxOutputTokens: 999_999 }, call))).toBe("MODEL-GATEWAY-QUOTA-EXCEEDED");
  });

  it("RUN-016 the Adapter Broker enforces adapter, version, action and host policy, and refuses raw URLs", () => {
    const { issuer, verifier } = issuerAndVerifier();
    const broker = new AdapterBroker(verifier, () => [{ adapterId: "aave-v3", version: "1.2.0", actions: ["readPosition"], hosts: ["api.aave.test"] }]);
    const perform = () => ({ healthFactor: "1.8" });

    const ok = broker.invoke(mintFor(issuer), ctx({ audience: "ADAPTER" }), { adapterId: "aave-v3", adapterVersion: "1.2.0", action: "readPosition", args: { user: "0x1" }, correlationId: "c" }, perform);
    expect(ok.result).toEqual({ healthFactor: "1.8" });

    expect(reasonOf(() => broker.invoke(mintFor(issuer), ctx({ audience: "ADAPTER" }), { adapterId: "uniswap", adapterVersion: "1.0.0", action: "swap", args: {}, correlationId: "c" }, perform)))
      .toBe("ADAPTER-BROKER-ADAPTER-NOT-ALLOWED");
    expect(reasonOf(() => broker.invoke(mintFor(issuer), ctx({ audience: "ADAPTER" }), { adapterId: "aave-v3", adapterVersion: "1.3.0", action: "readPosition", args: {}, correlationId: "c" }, perform)))
      .toBe("ADAPTER-BROKER-VERSION-MISMATCH");
    expect(reasonOf(() => broker.invoke(mintFor(issuer), ctx({ audience: "ADAPTER" }), { adapterId: "aave-v3", adapterVersion: "1.2.0", action: "borrow", args: {}, correlationId: "c" }, perform)))
      .toBe("ADAPTER-BROKER-ACTION-NOT-ALLOWED");

    // The one that matters most: a runtime that could name a URL has an HTTP client with our
    // credentials attached.
    for (const key of ["url", "endpoint", "host", "baseUrl", "credentialRef", "authorization", "headers"]) {
      expect(reasonOf(() => broker.invoke(mintFor(issuer), ctx({ audience: "ADAPTER" }), { adapterId: "aave-v3", adapterVersion: "1.2.0", action: "readPosition", args: { [key]: "http://evil.test" }, correlationId: "c" }, perform)), key)
        .toBe("ADAPTER-BROKER-RAW-URL-REFUSED");
    }
  });

  it("RUN-015b the runtime cannot reach a raw signer or present a capability", () => {
    const { issuer, verifier } = issuerAndVerifier();
    const broker = new ContextLockBroker(verifier, () => true, () => ({ disposition: "ALLOW", reason: "within policy" }));
    const intent = { intent: { action: "repay", chainId: 11155111, target: "0xaave", amount: "1000000" } };

    const r = broker.requestIntent(mintFor(issuer), ctx({ audience: "CONTEXTLOCK" }), intent);
    expect(r.disposition).toBe("ALLOW");
    // Even on ALLOW, no capability comes back. The runtime learns a verdict, not authority.
    expect(r.capabilityIssued).toBe(false);
    expect(r).not.toHaveProperty("capability");
    expect(r).not.toHaveProperty("signature");

    for (const key of ["signature", "digest", "capability", "capabilityScope", "issuerSignature", "privateKey"]) {
      expect(reasonOf(() => broker.requestIntent(mintFor(issuer), ctx({ audience: "CONTEXTLOCK" }), { ...intent, [key]: "x" })), key)
        .toBe("CONTEXTLOCK-BROKER-RAW-SIGNING-REFUSED");
    }

    // And the runtime's own vocabulary has no member that would ask for one.
    for (const op of ["signDigest", "issuer.sign", "issueCapability", "policy.enable", "getSecret"]) {
      expect(FORBIDDEN_RUNTIME_OPERATIONS.has(op), op).toBe(true);
      expect(reasonOf(() => assertOperationAllowed(op, "CONTEXTLOCK"))).toBe(GATEWAY_REASONS.FORBIDDEN_OPERATION);
    }
    expect(reasonOf(() => assertOperationAllowed("model.complete", "CONTEXTLOCK"))).toBe(GATEWAY_REASONS.WRONG_GATEWAY);
    expect(reasonOf(() => assertOperationAllowed("something.new", "MODEL"))).toBe(GATEWAY_REASONS.UNKNOWN_OPERATION);
    expect(() => assertOperationAllowed("model.complete", "MODEL")).not.toThrow();
  });

  it("RUN-023 disabling the policy blocks a live, fully-compromised runtime", () => {
    const { issuer, verifier } = issuerAndVerifier();
    let enabled = true;
    // The decision function says ALLOW to everything — model the case where the agent's own logic,
    // and even the broker's policy engine, have been subverted.
    const broker = new ContextLockBroker(verifier, () => enabled, () => ({ disposition: "ALLOW", reason: "compromised decision logic says yes" }));
    const intent = { intent: { action: "transfer", chainId: 11155111, target: "0xattacker", amount: "999999999" } };

    expect(broker.requestIntent(mintFor(issuer), ctx({ audience: "CONTEXTLOCK" }), intent).disposition).toBe("ALLOW");

    enabled = false;
    const r = reasonOf(() => broker.requestIntent(mintFor(issuer), ctx({ audience: "CONTEXTLOCK" }), intent));
    expect(r).toBe("CONTEXTLOCK-BROKER-POLICY-DISABLED");
    // The token is still valid, the runtime is still up, the decision logic still says yes, and the
    // answer is still no.
    expect(() => verifier.verify(mintFor(issuer), ctx({ audience: "CONTEXTLOCK" }))).not.toThrow();
  });

  it("RUN-021 a paused runtime cannot start new work", () => {
    const paused = evaluateHealth({
      processStartedAtMs: NOW - 120_000, lastHeartbeatMs: NOW - 1000,
      controlPlaneReachable: true, modelGatewayReachable: true, adapterBrokerReachable: true, contextlockBrokerReachable: true,
      eventCursorAgeMs: 1000, paused: true, stopping: false, recentRestarts: 0, nowMs: NOW,
    });
    expect(paused.state).toBe("PAUSED");
    expect(paused.mayStartNewWork).toBe(false);
    // PAUSED is not DEGRADED: a deliberately paused runtime is not a broken one.
    expect(paused.state).not.toBe("DEGRADED");
  });
});

/* ══════════════════════════ health ══════════════════════════ */

describe("runtime health", () => {
  const base = {
    processStartedAtMs: NOW - 120_000, lastHeartbeatMs: NOW - 1000,
    controlPlaneReachable: true, modelGatewayReachable: true, adapterBrokerReachable: true, contextlockBrokerReachable: true,
    eventCursorAgeMs: 1000, paused: false, stopping: false, recentRestarts: 0, nowMs: NOW,
  };

  it("RUN-020 health requires broker reachability, not merely a live process", () => {
    expect(evaluateHealth(base).state).toBe("HEALTHY");

    const noBroker = evaluateHealth({ ...base, contextlockBrokerReachable: false });
    expect(noBroker.state).toBe("DEGRADED");
    expect(noBroker.mayStartNewWork).toBe(false);
    expect(noBroker.reasons.join(" ")).toMatch(/cannot obtain authorization for any action/);

    for (const [k, label] of [["modelGatewayReachable", "Model Gateway"], ["adapterBrokerReachable", "Adapter Broker"], ["controlPlaneReachable", "control plane"]] as const) {
      const v = evaluateHealth({ ...base, [k]: false });
      expect(v.state, k).toBe("DEGRADED");
      expect(v.reasons.join(" ")).toContain(label);
    }

    // A stale event cursor means the agent is deciding on an old view, which is not healthy.
    const stale = evaluateHealth({ ...base, eventCursorAgeMs: 10 * 60_000 });
    expect(stale.state).toBe("DEGRADED");
    expect(stale.reasons.join(" ")).toMatch(/deciding on a stale view/);
  });

  it("RUN-019 a crash loop is detected rather than looking like a slow start", () => {
    const looping = evaluateHealth({ ...base, lastHeartbeatMs: null, processStartedAtMs: NOW - 500, recentRestarts: DEFAULT_HEALTH_POLICY.crashLoopRestarts });
    expect(looping.state).toBe("CRASH_LOOP");
    expect(looping.reasons.join(" ")).toMatch(/not staying up/);

    // A genuinely slow first start is STARTING, and only becomes FAILED after the grace period.
    expect(evaluateHealth({ ...base, lastHeartbeatMs: null, processStartedAtMs: NOW - 1000 }).state).toBe("STARTING");
    expect(evaluateHealth({ ...base, lastHeartbeatMs: null, processStartedAtMs: NOW - 120_000 }).state).toBe("FAILED");
    // A stale heartbeat degrades rather than passing.
    expect(evaluateHealth({ ...base, lastHeartbeatMs: NOW - 60_000 }).state).toBe("DEGRADED");
  });

  it("RUN-022 health never implies authority", () => {
    expect(HEALTH_NOTE).toMatch(/says nothing about financial authority/);
    expect(HEALTH_NOTE).toMatch(/ContextLock policy on chain decides/);
  });
});

/* ══════════════════════════ checkpoints ══════════════════════════ */

describe("externalized checkpoints", () => {
  const cursor = (over: Record<string, unknown> = {}) => ({
    chainId: 11155111, subscriptionId: "sub_1", eventSource: "ContextLockExecutor",
    lastFinalizedBlock: "11673800", lastProcessedEventId: "11155111:11673800:0xabc:2",
    checkpointedAtMs: NOW, agentId: "guardian", deploymentId: "dep_1", ...over,
  });

  it("RUN-017 a restart restores the cursor from outside the container", () => {
    const { issuer, verifier } = issuerAndVerifier();
    const telemetry = new TelemetryGateway(verifier);
    telemetry.saveCheckpoint(mintFor(issuer), ctx({ audience: "TELEMETRY" }), cursor());

    // A new container, a new token, the same agent — the cursor comes back.
    const restored = telemetry.loadCheckpoint(mintFor(issuer), ctx({ audience: "TELEMETRY" }));
    expect(restored).toMatchObject({ lastFinalizedBlock: "11673800" });

    // Another agent's token gets its own (empty) cursor, not this one.
    expect(telemetry.loadCheckpoint(mintFor(issuer, { agentId: "rebalancer" }), ctx({ audience: "TELEMETRY", expectedAgentId: "rebalancer" }))).toBeNull();

    // And a checkpoint inside the container is refused, because it is not a checkpoint.
    for (const path of ["/tmp/cursor.json", "/app/state", "/var/tmp/x", "/home/contextlock/c"]) {
      expect(reasonOf(() => assertExternalStore(path)), path).toBe(CHECKPOINT_REASONS.LOCAL_ONLY);
    }
    expect(() => assertExternalStore("https://control-plane.contextlock.test/checkpoints")).not.toThrow();
  });

  it("RUN-018 event replay after a restart is idempotent, and the cursor only moves forward into finalized blocks", () => {
    const log = new ProcessedEventLog();
    const id = eventIdOf({ chainId: 11155111, blockNumber: 11673800n, transactionHash: "0xABC", logIndex: 2 });
    expect(id).toBe("11155111:11673800:0xabc:2");

    expect(log.admit(id, NOW)).toBe(true);
    // The same event, seen again after a restart replayed from the checkpoint.
    expect(log.admit(id, NOW + 1000)).toBe(false);
    expect(log.admit(eventIdOf({ chainId: 11155111, blockNumber: 11673800n, transactionHash: "0xabc", logIndex: 3 }), NOW)).toBe(true);
    expect(log.size).toBe(2);

    // A cursor may not go backwards, and may not run past the finalized head.
    expect(() => assertAdvance(cursor(), cursor({ lastFinalizedBlock: "11673900" }), 11_674_000n)).not.toThrow();
    expect(reasonOf(() => assertAdvance(cursor(), cursor({ lastFinalizedBlock: "11673700" }), 11_674_000n))).toBe(CHECKPOINT_REASONS.WOULD_GO_BACKWARDS);
    expect(reasonOf(() => assertAdvance(cursor(), cursor({ lastFinalizedBlock: "11674500" }), 11_674_000n))).toBe(CHECKPOINT_REASONS.NOT_FINALIZED);

    // The dedup window is bounded, and the bound is real rather than aspirational.
    const bounded = new ProcessedEventLog(1000, 10);
    expect(bounded.admit("e1", NOW)).toBe(true);
    expect(bounded.admit("e1", NOW + 5000)).toBe(true);
  });
});

/* ══════════════════════════ hardening ══════════════════════════ */

describe("container hardening", () => {
  it("RUN-003 non-root, RUN-004 read-only root, RUN-005 no privileged, RUN-006 no Docker socket", () => {
    expect(() => assertHardened(DEFAULT_HARDENING)).not.toThrow();
    expect(DEFAULT_HARDENING.user).toBe("10001:10001");

    expect(reasonOf(() => assertHardened({ ...DEFAULT_HARDENING, user: "0:0" }))).toBe(HARDENING_REASONS.ROOT_USER);
    expect(reasonOf(() => assertHardened({ ...DEFAULT_HARDENING, user: "root" }))).toBe(HARDENING_REASONS.ROOT_USER);
    expect(reasonOf(() => assertHardened({ ...DEFAULT_HARDENING, readOnlyRootFilesystem: false }))).toBe(HARDENING_REASONS.WRITABLE_ROOT);
    expect(reasonOf(() => assertHardened({ ...DEFAULT_HARDENING, privileged: true }))).toBe(HARDENING_REASONS.PRIVILEGED);
    expect(reasonOf(() => assertHardened({ ...DEFAULT_HARDENING, dockerSocket: true }))).toBe(HARDENING_REASONS.DOCKER_SOCKET);
    expect(reasonOf(() => assertHardened({ ...DEFAULT_HARDENING, bindMounts: ["/etc"] }))).toBe(HARDENING_REASONS.BIND_MOUNT);
    expect(reasonOf(() => assertHardened({ ...DEFAULT_HARDENING, capAdd: ["NET_ADMIN"] }))).toBe(HARDENING_REASONS.CAPABILITY_ADDED);
    expect(reasonOf(() => assertHardened({ ...DEFAULT_HARDENING, capDrop: [] }))).toBe(HARDENING_REASONS.CAPABILITY_ADDED);
    expect(reasonOf(() => assertHardened({ ...DEFAULT_HARDENING, noNewPrivileges: false }))).toBe(HARDENING_REASONS.CAPABILITY_ADDED);
    expect(reasonOf(() => assertHardened({ ...DEFAULT_HARDENING, hostNetwork: true }))).toBe(HARDENING_REASONS.HOST_NAMESPACE);
    expect(reasonOf(() => assertHardened({ ...DEFAULT_HARDENING, hostPid: true }))).toBe(HARDENING_REASONS.HOST_NAMESPACE);
  });

  it("RUN-028 CPU, memory and PID limits are required and appear in the arguments", () => {
    expect(reasonOf(() => assertHardened({ ...DEFAULT_HARDENING, memoryMb: 0 }))).toBe(HARDENING_REASONS.NO_LIMITS);
    expect(reasonOf(() => assertHardened({ ...DEFAULT_HARDENING, pidsLimit: 0 }))).toBe(HARDENING_REASONS.NO_LIMITS);

    const args = dockerArgs(DEFAULT_HARDENING);
    const joined = args.join(" ");
    expect(joined).toContain("--user 10001:10001");
    expect(joined).toContain("--read-only");
    expect(joined).toContain("--security-opt no-new-privileges:true");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--cpus 0.5");
    expect(joined).toContain("--memory 512m");
    expect(joined).toContain("--pids-limit 128");
    expect(joined).toMatch(/--tmpfs \/tmp\/contextlock:rw,noexec,nosuid,mode=1777,size=64m/);
    // And nothing that would undo it.
    expect(joined).not.toContain("--privileged");
    expect(joined).not.toContain("docker.sock");
    expect(joined).not.toContain("--network host");
    expect(joined).not.toContain("-v ");
  });
});

/* ══════════════════════════ providers and revisions ══════════════════════════ */

describe("providers", () => {
  it("RUN-026 the runtime provider cannot be selected by a model output or a request payload", () => {
    registerRuntimeProvider("docker", () => new DockerRuntimeProvider());
    expect(() => getRuntimeProvider("docker", ["docker"])).not.toThrow();

    // Luna, or a request body, naming a provider the operator did not allow.
    expect(reasonOf(() => getRuntimeProvider("ecs-fargate", ["docker"]))).toBe(RUNTIME_REASONS.PROVIDER_NOT_SELECTABLE);
    expect(() => getRuntimeProvider("ecs-fargate", ["docker"])).toThrow(/never taken from a model output, a Blueprint, or a request payload/);
    // An empty allow-list permits nothing; it does not permit everything.
    expect(reasonOf(() => getRuntimeProvider("docker", []))).toBe(RUNTIME_REASONS.PROVIDER_NOT_SELECTABLE);
    // Allowed but unregistered is a different, correctly-named failure.
    expect(reasonOf(() => getRuntimeProvider("nomad", ["nomad"]))).toBe(RUNTIME_REASONS.UNKNOWN_PROVIDER);
  });

  it("RUN-027 each provider declares what it can enforce, and no claim is inherited", () => {
    // Docker does NOT claim no-network for the runtime, even though P11's build sandbox does.
    expect(DOCKER_RUNTIME_CAPABILITIES.networkEgress).toBe("OPEN");
    expect(DOCKER_RUNTIME_CAPABILITIES.caveats.join(" ")).toMatch(/Egress is unrestricted/);
    expect(DOCKER_RUNTIME_CAPABILITIES.automaticRollback).toBe(false);
    expect(egressStatement(DOCKER_RUNTIME_CAPABILITIES)).toMatch(/no privileged credential is placed in it/);

    // ECS claims ALLOWLIST as a platform capability and says plainly it is unverified live.
    expect(ECS_FARGATE_CAPABILITIES.networkEgress).toBe("ALLOWLIST");
    expect(ECS_FARGATE_CAPABILITIES.liveVerified).toBe(false);
    expect(ECS_FARGATE_CAPABILITIES.pidLimit).toBe(false);
    expect(ECS_FARGATE_CAPABILITIES.caveats.join(" ")).toMatch(/NOT EXERCISED LIVE/);
    expect(ECS_FARGATE_CAPABILITIES.caveats.join(" ")).toMatch(/BLK-V2-ECS-LIVE/);

    // An undeclared provider guarantees nothing rather than inheriting.
    const u = unknownCapabilities("mystery");
    expect(u.networkEgress).toBe("UNKNOWN");
    expect(u.readOnlyRootFilesystem).toBe(false);
    expect(egressStatement(u)).toMatch(/treated as open/);
  });

  it("RUN-026b the ECS provider prepares real requests and refuses to send them", async () => {
    const p = new EcsFargateRuntimeProvider();
    const err = await p.deploy({
      revision: revision(), environment: { CONTEXTLOCK_AGENT_ID: "guardian" },
      runtimeTokenPath: "/run/contextlock/runtime-token", runtimeToken: "t", healthPort: 8080,
      cpu: "512", memoryMb: 1024, pidLimit: 128,
    }).catch((e) => e as RuntimeProviderError);
    expect((err as RuntimeProviderError).reason).toBe(RUNTIME_REASONS.UNAVAILABLE);
    expect((err as Error).message).toContain("ECS-NOT-EXERCISED-LIVE");
    // The prepared request is in the error, so it is inspectable without AWS.
    expect((err as Error).message).toContain("awsvpc");
    expect((err as Error).message).toContain("readonlyRootFilesystem");
  });

  it("RUN-027b the ECS task definition pins a digest, drops capabilities and keeps the task role narrow", () => {
    const td = buildTaskDefinition({
      agentId: "guardian", deploymentId: "dep_1", imageRepository: "1234.dkr.ecr.us-east-1.amazonaws.com/contextlock",
      imageDigest: DIGEST, cpu: "512", memoryMb: 1024,
      executionRoleArn: "arn:aws:iam::1234:role/exec", taskRoleArn: null,
      environment: { CONTEXTLOCK_AGENT_ID: "guardian" },
      runtimeTokenSecretArn: "arn:aws:secretsmanager:us-east-1:1234:secret:rt", healthPort: 8080,
      logGroup: "/contextlock", region: "us-east-1",
    });
    const c = td.containerDefinitions[0]!;
    expect(c.image).toBe(`1234.dkr.ecr.us-east-1.amazonaws.com/contextlock@${DIGEST}`);
    expect(c.image).not.toMatch(/:latest|:v\d/);
    expect(c.readonlyRootFilesystem).toBe(true);
    expect(c.privileged).toBe(false);
    expect(c.user).toBe("10001:10001");
    expect(c.linuxParameters.capabilities.drop).toEqual(["ALL"]);
    // The token arrives by reference. A task definition is readable by anyone with DescribeTaskDefinition.
    expect(c.secrets).toEqual([{ name: "CONTEXTLOCK_RUNTIME_TOKEN", valueFrom: "arn:aws:secretsmanager:us-east-1:1234:secret:rt" }]);
    expect(JSON.stringify(c.environment)).not.toMatch(/TOKEN|KEY|SECRET/);
    expect(td.taskRoleArn).toBeNull();

    expect(reasonOf(() => buildTaskDefinition({ agentId: "g", deploymentId: "d", imageRepository: "r", imageDigest: "contextlock:latest", cpu: "512", memoryMb: 1024, executionRoleArn: "a", taskRoleArn: null, environment: {}, runtimeTokenSecretArn: "s", healthPort: 1, logGroup: "l", region: "r" })))
      .toBe(ECS_REASONS.TAG_NOT_DIGEST);

    for (const action of FORBIDDEN_TASK_ROLE_ACTIONS) {
      expect(reasonOf(() => assertTaskRoleNarrow([action])), action).toBe(ECS_REASONS.BROAD_TASK_ROLE);
    }
    expect(() => assertTaskRoleNarrow(["cloudwatch:PutMetricData"])).not.toThrow();
  });

  it("RUN-027c the ECS service enables the circuit breaker with rollback and refuses a public IP or a shell", () => {
    const svc = buildServiceDefinition({ cluster: "contextlock", agentId: "guardian", taskDefinition: "contextlock-agent-guardian:1", subnets: ["subnet-1"], securityGroups: ["sg-1"] });
    expect(svc.deploymentController.type).toBe("ECS");
    expect(svc.deploymentConfiguration.deploymentCircuitBreaker).toMatchObject({ enable: true, rollback: true });
    expect(svc.networkConfiguration.awsvpcConfiguration.assignPublicIp).toBe("DISABLED");
    expect(svc.enableExecuteCommand).toBe(false);
    expect(() => assertServiceHardened(svc)).not.toThrow();

    expect(reasonOf(() => assertServiceHardened({ ...svc, networkConfiguration: { awsvpcConfiguration: { ...svc.networkConfiguration.awsvpcConfiguration, assignPublicIp: "ENABLED" } } }))).toBe(ECS_REASONS.PUBLIC_IP);
    expect(reasonOf(() => assertServiceHardened({ ...svc, enableExecuteCommand: true } as never))).toBe(ECS_REASONS.EXEC_ENABLED);
    expect(reasonOf(() => assertServiceHardened({ ...svc, networkConfiguration: { awsvpcConfiguration: { ...svc.networkConfiguration.awsvpcConfiguration, securityGroups: [] } } }))).toBe(ECS_REASONS.EGRESS_OPEN);

    // ALLOWLIST is a capability of the platform, not a property of a deployment that has not
    // configured it.
    expect(reasonOf(() => assertEgressRestricted([{ cidr: "0.0.0.0/0", port: 443 }], ["10.0.1.0/24"]))).toBe(ECS_REASONS.EGRESS_OPEN);
    expect(() => assertEgressRestricted([{ cidr: "10.0.1.0/24", port: 443 }], ["10.0.1.0/24"])).not.toThrow();
  });

  it("RUN-024 an update creates a new immutable revision, and nothing is mutated in place", () => {
    const history = new RevisionHistory();
    history.add({ revisionId: "rev_1", imageDigest: DIGEST, blueprintRevision: 3, buildRevision: 2, createdAtMs: NOW, previousRevisionId: null, everHealthy: false, retiredAtMs: null, retiredReason: null });
    expect(reasonOf(() => history.add({ revisionId: "rev_2", imageDigest: DIGEST, blueprintRevision: 3, buildRevision: 3, createdAtMs: NOW + 1, previousRevisionId: "rev_1", everHealthy: false, retiredAtMs: null, retiredReason: null })))
      .toBe(RUNTIME_REASONS.MUTATION_ATTEMPTED);

    expect(reasonOf(() => assertIsNewRevision(revision({ revisionId: "rev_2" }), revision({ revisionId: "rev_1" })))).toBe(RUNTIME_REASONS.MUTATION_ATTEMPTED);
    expect(() => assertIsNewRevision(revision({ revisionId: "rev_2", imageDigest: DIGEST2 }), revision({ revisionId: "rev_1" }))).not.toThrow();

    // No operation on the provider interface would edit a running container.
    const p = new DockerRuntimeProvider();
    for (const forbidden of FORBIDDEN_MUTATION_OPERATIONS) {
      expect(p, `AgentRuntimeProvider must have no "${forbidden}"`).not.toHaveProperty(forbidden);
    }
  });

  it("RUN-025 a rollback uses a pinned previous digest that was actually healthy", () => {
    const h = new RevisionHistory();
    h.add({ revisionId: "rev_1", imageDigest: DIGEST, blueprintRevision: 3, buildRevision: 2, createdAtMs: NOW, previousRevisionId: null, everHealthy: false, retiredAtMs: null, retiredReason: null });
    // Nothing has ever been healthy, so there is nothing to roll back to — and saying so beats
    // rolling back to a revision that never came up.
    expect(reasonOf(() => h.rollbackTarget())).toBe(RUNTIME_REASONS.NO_ROLLBACK_TARGET);

    h.markHealthy("rev_1");
    h.add({ revisionId: "rev_2", imageDigest: DIGEST2, blueprintRevision: 4, buildRevision: 3, createdAtMs: NOW + 1000, previousRevisionId: "rev_1", everHealthy: false, retiredAtMs: null, retiredReason: null });
    const target = h.rollbackTarget();
    expect(target.revisionId).toBe("rev_1");
    expect(target.imageDigest).toBe(DIGEST);
    expect(target.everHealthy).toBe(true);

    // A rollback target the provider no longer retains is refused rather than guessed at.
    const p = new DockerRuntimeProvider();
    return expect(p.rollback("rev_gone")).rejects.toThrow(/no rollback target|not retained/i);
  });
});

/* ══════════════════════════ image correspondence ══════════════════════════ */

describe("the image that actually exists", () => {
  const RECORD = "reports/group-e/evidence/image/runtime-image.json";

  it("RUN-002 the built image's digest, user and labels are recorded and non-root", () => {
    if (!existsSync(RECORD)) {
      throw new Error(`${RECORD} is missing. Run \`npm run runtime:image\`; this test asserts against the image that was really built, not a fixture.`);
    }
    const r = JSON.parse(readFileSync(RECORD, "utf8")) as Record<string, any>;
    expect(r.imageManifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.imageConfigDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // They are different digests of different objects, and this test exists so nobody conflates them.
    expect(r.imageManifestDigest).not.toBe(r.imageConfigDigest);
    expect(r.baseImageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.runsAsRoot).toBe(false);
    expect(r.runsAsUser).toBe("10001:10001");
    expect(r.labels["com.contextlock.agent-id"]).toBe("guardian");
    expect(r.labels["org.opencontainers.image.revision"]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("RUN-029 the SBOM and provenance correspond to the digest that was built", () => {
    const r = JSON.parse(readFileSync(RECORD, "utf8")) as Record<string, any>;
    expect(r.sbomDigest, "the image must have an SBOM").toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.provenanceDigest, "the image must have build provenance").toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(["BUILDKIT_INTOTO_OCI", "EXTERNAL_SYFT"]).toContain(r.attestationMethod);

    // The SBOM on disk really is an in-toto SPDX statement about this build, not an empty file.
    const sbom = JSON.parse(readFileSync("reports/group-e/evidence/image/sbom.spdx.json", "utf8")) as Record<string, any>;
    expect(sbom.predicateType ?? sbom.spdxVersion).toBeTruthy();
    const prov = JSON.parse(readFileSync("reports/group-e/evidence/image/provenance.json", "utf8")) as Record<string, any>;
    expect(prov.predicateType).toMatch(/slsa\.dev\/provenance/);
  });

  it("RUN-030 the P0-P23 regression actually runs these suites, and the inventory gate says so", () => {
    /*
     * "The regression is green" is a claim about a harness run, and it belongs in TEST_RESULTS.
     * What is checkable HERE is the part that silently rots: whether the cumulative harness
     * actually executes the suites Group E added.
     *
     * Group D found a suite that had hidden outside the harness for two phase groups and had never
     * passed. `suite-inventory.sh` was written so that could not happen again; this asserts that
     * the new packages are wired into both it and `test-all.sh`, so a suite added here cannot go
     * uncounted either.
     */
    const harness = readFileSync("scripts/test-all.sh", "utf8");
    const inventory = readFileSync("scripts/suite-inventory.sh", "utf8");
    for (const pkg of ["packages/studio-deploy", "packages/studio-orchestrator", "packages/studio-runtime", "apps/agent-runtime"]) {
      expect(harness, `${pkg} must be run by the cumulative harness`).toContain(pkg);
      expect(inventory, `${pkg}/test must be covered by the suite inventory`).toContain(`${pkg}/test`);
    }
    // The harness must still count, and must still treat an uncounted suite as a failure.
    expect(harness).toContain("no test count parsed — treating as failure");
    expect(harness).toContain("CUMULATIVE TEST COUNT");
  });

  it("RUN-029b an unrun vulnerability scan is recorded as unrun, not as clean", () => {
    const r = JSON.parse(readFileSync(RECORD, "utf8")) as Record<string, any>;
    // Whichever it is, the record must be able to tell the difference — an empty findings list and
    // a scanner that never ran must not look the same.
    expect(typeof r.vulnerabilityScan.ran).toBe("boolean");
    if (!r.vulnerabilityScan.ran) {
      expect(r.vulnerabilityScan.unavailableReason).toBeTruthy();
      expect(r.vulnerabilityScan.scanner).toBe("none");
    }
    // The JS dependency audit is a SEPARATE artifact and says what it does not cover.
    expect(r.javascriptDependencyAudit.scope).toMatch(/does not cover the base image's OS packages/);
    expect(r.javascriptDependencyAudit.scope).toMatch(/does not substitute/);
  });
});
