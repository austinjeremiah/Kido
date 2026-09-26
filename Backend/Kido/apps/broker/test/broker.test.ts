import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { CAPABILITY_TYPES, domain, PolicyDenial, OperationalError } from "@contextlock/protocol";
import { makeHarness, TEST_AGENT_NAME, TEST_POLICY_ID, type Harness } from "../src/testkit.js";
import { buildApi } from "../src/api.js";
import { benignProposal, maliciousCorpus } from "../../demo-agent/src/index.js";

const ISSUER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const EXECUTOR = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9" as Address;
const TARGET = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" as Address;
const AGENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;

let h: Harness;
beforeEach(() => {
  h = makeHarness({ executor: EXECUTOR, target: TARGET, agent: AGENT, issuerPrivateKey: ISSUER_PK });
});

const req = (over: Record<string, unknown> = {}) => ({
  agentEnsName: TEST_AGENT_NAME,
  actionKind: "MOCK_TRANSFER",
  adapterParams: { recipient: "0x00000000000000000000000000000000c0FFEE00", amount: "500" },
  policyId: TEST_POLICY_ID,
  idempotencyKey: `k-${Math.random()}`,
  ...over,
});

describe("broker vertical slice", () => {
  it("mints a capability for a benign in-policy request", async () => {
    const r = await h.broker.createRequest(req());
    expect(r.status).toBe("ALLOWED");
    expect(r.capability).toBeDefined();
    expect(r.signature).toBeDefined();
    expect(r.capability!.target).toBe(TARGET);
    expect(r.capability!.executor).toBe(EXECUTOR);
    expect(r.identitySource).toBe("stub");
    expect(r.evaluationSource).toBe("stub");
  });

  it("signs with the configured issuer, and the signature recovers to it", async () => {
    const r = await h.broker.createRequest(req());
    const recovered = await recoverTypedDataAddress({
      domain: domain(r.capability!.chainId, r.capability!.executor),
      types: CAPABILITY_TYPES,
      primaryType: "Capability",
      message: r.capability!,
      signature: r.signature!,
    });
    expect(recovered).toBe(privateKeyToAccount(ISSUER_PK).address);
    expect(recovered).toBe(h.broker.issuerAddress);
  });

  it("never exposes the capability-issuer private key anywhere in a response", async () => {
    const r = await h.broker.createRequest(req());
    const blob = JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(blob).not.toContain(ISSUER_PK);
    expect(blob).not.toContain(ISSUER_PK.slice(2));
    // The issuer ADDRESS is public and fine; the key is not.
    expect(blob.toLowerCase()).not.toContain("privatekey");
  });

  // API-001
  it("is idempotent: a duplicate key returns the same request and does not re-evaluate", async () => {
    const key = "stable-idempotency-key-001";
    const a = await h.broker.createRequest(req({ idempotencyKey: key }));
    const b = await h.broker.createRequest(req({ idempotencyKey: key }));

    expect(b.requestId).toBe(a.requestId);
    const rows = h.db.prepare("SELECT COUNT(*) AS n FROM cre_authorizations WHERE request_id=?").get(a.requestId) as { n: number };
    expect(rows.n).toBe(1);
    const reqs = h.db.prepare("SELECT COUNT(*) AS n FROM capability_requests").get() as { n: number };
    expect(reqs.n).toBe(1);
  });

  it("concurrent duplicate idempotency keys yield at most one authorization", async () => {
    const key = "concurrent-key-001";
    const results = await Promise.allSettled([
      h.broker.createRequest(req({ idempotencyKey: key })),
      h.broker.createRequest(req({ idempotencyKey: key })),
      h.broker.createRequest(req({ idempotencyKey: key })),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const n = h.db.prepare("SELECT COUNT(*) AS n FROM capability_requests").get() as { n: number };
    expect(n.n).toBe(1);
  });

  // CRE-003 / CRE-004 at the broker layer
  it("ESCALATE mints no capability", async () => {
    const r = await h.broker.createRequest(req({ adapterParams: { recipient: "0x00000000000000000000000000000000c0FFEE00", amount: "5000" } }));
    expect(r.status).toBe("ESCALATED");
    expect(r.capability).toBeUndefined();
    expect(r.signature).toBeUndefined();
  });

  it("DENY mints no capability", async () => {
    const r = await h.broker.createRequest(req({ adapterParams: { recipient: "0x00000000000000000000000000000000c0FFEE00", amount: "50000" } }));
    expect(r.status).toBe("DENIED");
    expect(r.capability).toBeUndefined();
  });

  // ID-006 at the broker layer
  it("fails closed when identity resolution is unavailable", async () => {
    h.ens.resolutionBroken = true;
    await expect(h.broker.createRequest(req())).rejects.toBeInstanceOf(OperationalError);
    const caps = h.db.prepare("SELECT COUNT(*) AS n FROM capabilities").get() as { n: number };
    expect(caps.n).toBe(0);
  });

  it("fails closed when the agent name is not bound", async () => {
    await expect(h.broker.createRequest(req({ agentEnsName: "not.registered.eth" }))).rejects.toBeInstanceOf(OperationalError);
  });

  it("rejects an unknown action kind", async () => {
    await expect(h.broker.createRequest(req({ actionKind: "TRANSFER_ALL_FUNDS" }))).rejects.toBeInstanceOf(PolicyDenial);
  });

  it("rejects an unknown policy", async () => {
    await expect(h.broker.createRequest(req({ policyId: "god-mode" }))).rejects.toBeInstanceOf(PolicyDenial);
  });

  it("rejects malformed amounts and addresses before any chain interaction", async () => {
    for (const bad of [{ recipient: "0x00000000000000000000000000000000c0FFEE00", amount: "-1" },
                       { recipient: "0x00000000000000000000000000000000c0FFEE00", amount: "1.5" },
                       { recipient: "0x00000000000000000000000000000000c0FFEE00", amount: "0" },
                       { recipient: "not-an-address", amount: "1" }]) {
      await expect(h.broker.createRequest(req({ adapterParams: bad }))).rejects.toBeInstanceOf(PolicyDenial);
    }
  });

  it("SecretProvider never returns the raw secret to the caller (LED-002 shape)", async () => {
    const token = "test-token-NOT-a-real-credential-8f3a1c";
    const scoped = await h.broker.secrets.withSecret("risk-api-token", async (secret) => {
      expect(secret).toBe(token);
      return { riskScore: 12, usedToken: false };
    });
    expect(JSON.stringify(scoped)).not.toContain(token);
  });

  it("audit trail reconstructs what happened", async () => {
    const r = await h.broker.createRequest(req());
    const events = h.broker.getAudit(r.requestId) as Array<{ type: string }>;
    const types = events.map((e) => e.type);
    expect(types).toContain("REQUEST_RECEIVED");
    expect(types).toContain("ENS_IDENTITY_VALIDATED");
    expect(types).toContain("EVALUATION_REQUESTED");
    expect(types).toContain("AUTHORIZATION_OBSERVED");
    expect(types).toContain("CAPABILITY_MINTED");
  });

  it("audit never contains the issuer key or the test secret", async () => {
    await h.broker.createRequest(req());
    const blob = JSON.stringify(h.broker.getAudit());
    expect(blob).not.toContain(ISSUER_PK.slice(2));
    expect(blob).not.toContain("test-token-NOT-a-real-credential-8f3a1c");
  });
});

describe("HTTP API", () => {
  it("rejects raw calldata/target on the typed endpoint (API-003)", async () => {
    const app = buildApi(h.broker, h.db);
    const res = await app.inject({
      method: "POST",
      url: "/v1/capability-requests",
      payload: {
        agentEnsName: TEST_AGENT_NAME,
        actionKind: "MOCK_TRANSFER",
        adapterParams: { recipient: "0x00000000000000000000000000000000c0FFEE00", amount: "1" },
        target: "0x000000000000000000000000000000000000dEaD",
        calldata: "0xdeadbeef",
        policyId: TEST_POLICY_ID,
        idempotencyKey: "raw-calldata-attempt",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().reasonCode).toBe("CTX_API_VALIDATION");
    const caps = h.db.prepare("SELECT COUNT(*) AS n FROM capabilities").get() as { n: number };
    expect(caps.n).toBe(0);
    await app.close();
  });

  it("distinguishes an operational failure (503) from a policy denial (200 DENIED)", async () => {
    const app = buildApi(h.broker, h.db);

    const denied = await app.inject({
      method: "POST", url: "/v1/capability-requests",
      payload: req({ policyId: "god-mode" }),
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json().status).toBe("DENIED");

    h.ens.resolutionBroken = true;
    const failed = await app.inject({
      method: "POST", url: "/v1/capability-requests", payload: req(),
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().status).toBe("FAILED");
    await app.close();
  });

  it("serves health, policy and audit without leaking private thresholds", async () => {
    const app = buildApi(h.broker, h.db);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);

    const pol = await app.inject({ method: "GET", url: `/v1/policies/${TEST_POLICY_ID}` });
    expect(pol.statusCode).toBe(200);
    const body = pol.json();
    // Public constraints only. The evaluator's autonomous/escalate limits are not public policy.
    expect(body).not.toHaveProperty("autonomousLimit");
    expect(body).not.toHaveProperty("escalateLimit");

    const agent = await app.inject({ method: "GET", url: `/v1/agents/${TEST_AGENT_NAME}` });
    expect(agent.statusCode).toBe(200);
    expect(agent.json().source).toBe("stub");
    await app.close();
  });
});

describe("untrusted demo agent corpus", () => {
  it("the agent can PROPOSE every malicious action, and none of them mint a capability", async () => {
    const app = buildApi(h.broker, h.db);
    const corpus = maliciousCorpus(TEST_AGENT_NAME, "adv");

    for (const p of corpus) {
      const res = await app.inject({ method: "POST", url: "/v1/capability-requests", payload: p.body });
      // The agent is never blocked from asking. It is blocked from succeeding.
      expect([200, 400, 503]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(201);
      const body = res.json();
      expect(body.capability).toBeUndefined();
      expect(body.signature).toBeUndefined();
    }

    const caps = h.db.prepare("SELECT COUNT(*) AS n FROM capabilities").get() as { n: number };
    expect(caps.n, "no malicious proposal produced a capability").toBe(0);

    // ...while the benign one still works. The boundary is authority, not refusal.
    const good = await app.inject({
      method: "POST", url: "/v1/capability-requests",
      payload: benignProposal(TEST_AGENT_NAME, "benign-1").body,
    });
    expect(good.statusCode).toBe(201);
    await app.close();
  });
});
