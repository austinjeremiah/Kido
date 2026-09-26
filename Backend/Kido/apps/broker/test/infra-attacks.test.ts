import { beforeEach, describe, expect, it } from "vitest";
import { OperationalError, PolicyDenial, ReasonCode, assertSepolia } from "@contextlock/protocol";
import { LiveEnsIdentityProvider } from "../src/providers/ens-live.js";
import { buildApi } from "../src/api.js";
import { makeHarness, TEST_AGENT_NAME, TEST_POLICY_ID, type Harness } from "../src/testkit.js";
import type { Address } from "viem";

/**
 * P8.13 RPC/provider faults · P8.14 database & idempotency · P8.7 ENS failure modes.
 *
 * The unifying property: infrastructure failure must reduce authority, never grant it. Every case
 * here checks the *direction* of the failure, not merely that something threw.
 */
let h: Harness;
beforeEach(() => {
  h = makeHarness({
    executor: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
    target: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
    agent: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    issuerPrivateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  });
});

const AGENT = "0xA263b2cA150B5A1cA7bf08adF966B847c487F50f" as Address;
const GOOD = "0x00000000000000000000000000000000c0FFEE00";
const ok = (over: Record<string, unknown> = {}) => ({
  agentEnsName: TEST_AGENT_NAME, actionKind: "MOCK_TRANSFER",
  adapterParams: { recipient: GOOD, amount: "500" },
  policyId: TEST_POLICY_ID, idempotencyKey: `i-${Math.random()}`, ...over,
});

describe("P8.13 RPC / provider faults", () => {
  it("RPC-ATK-001: an unreachable RPC fails closed, never returns an identity", async () => {
    const p = new LiveEnsIdentityProvider("http://127.0.0.1:1/dead", { [TEST_AGENT_NAME.toLowerCase()]: AGENT });
    await expect(p.resolve(TEST_AGENT_NAME)).rejects.toBeInstanceOf(OperationalError);
  });

  it("RPC-ATK-002: an endpoint returning HTML instead of JSON-RPC fails closed", async () => {
    const p = new LiveEnsIdentityProvider("https://example.com/", { [TEST_AGENT_NAME.toLowerCase()]: AGENT });
    await expect(p.resolve(TEST_AGENT_NAME)).rejects.toBeInstanceOf(OperationalError);
  }, 30_000);

  it("RPC-ATK-003: the wrong chain is refused before any read is trusted", () => {
    // assertSepolia guards every network path. Mainnet, Base Sepolia and a plausible typo all fail.
    for (const wrong of [1, 84532, 11155110, 0]) {
      expect(() => assertSepolia(wrong)).toThrow(OperationalError);
    }
    expect(() => assertSepolia(11155111)).not.toThrow();
  });

  it("RPC-ATK-004: an operational failure is a 503, never a policy denial", async () => {
    const app = buildApi(h.broker, h.db);
    h.ens.resolutionBroken = true;
    const res = await app.inject({ method: "POST", url: "/v1/capability-requests", payload: ok() });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; reasonCode: string };
    expect(body.status).toBe("FAILED");
    // Critically NOT "DENIED" — an outage must never be recorded as a considered decision.
    expect(body.status).not.toBe("DENIED");
    expect(body.reasonCode).toContain("CTX_IDENTITY");
    await app.close();
  });

  it("RPC-ATK-005: no capability survives an RPC outage", async () => {
    const app = buildApi(h.broker, h.db);
    h.ens.resolutionBroken = true;
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "POST", url: "/v1/capability-requests", payload: ok() });
    }
    const caps = h.db.prepare("SELECT COUNT(*) AS n FROM capabilities").get() as { n: number };
    expect(caps.n).toBe(0);
    await app.close();
  });

  it("RPC-ATK-006: recovery after an outage is clean — the outage did not corrupt state", async () => {
    const app = buildApi(h.broker, h.db);
    h.ens.resolutionBroken = true;
    await app.inject({ method: "POST", url: "/v1/capability-requests", payload: ok() });
    h.ens.resolutionBroken = false;
    const good = await app.inject({ method: "POST", url: "/v1/capability-requests", payload: ok() });
    expect(good.statusCode).toBe(201);
    await app.close();
  });
});

describe("P8.7 ENS failure modes at the broker layer", () => {
  it("ENS-ATK-001: an unbound name fails closed", async () => {
    await expect(h.broker.createRequest(ok({ agentEnsName: "not-bound.eth" }) as never))
      .rejects.toBeInstanceOf(OperationalError);
  });

  it("ENS-ATK-002: revoking a binding mid-flight stops subsequent issuance immediately", async () => {
    const first = await h.broker.createRequest(ok() as never);
    expect(first.status).toBe("ALLOWED");
    h.ens.revoke(TEST_AGENT_NAME);
    await expect(h.broker.createRequest(ok() as never)).rejects.toBeInstanceOf(OperationalError);
  });

  it("ENS-ATK-003: rebinding to a different agent changes the identity hash", async () => {
    const a = await h.broker.createRequest(ok() as never);
    h.ens.bind(TEST_AGENT_NAME, "0x000000000000000000000000000000000000bEEF" as Address);
    const b = await h.broker.createRequest(ok() as never);
    expect(b.status).toBe("ALLOWED");
    // Different identity ⇒ different authority. The executor's ENS check is what enforces this
    // on-chain; here we assert the broker at least recomputes rather than caching.
    const rowA = h.db.prepare("SELECT agent_identity_hash FROM capability_requests WHERE id=?").get(a.requestId) as { agent_identity_hash: string };
    const rowB = h.db.prepare("SELECT agent_identity_hash FROM capability_requests WHERE id=?").get(b.requestId) as { agent_identity_hash: string };
    expect(rowB.agent_identity_hash).not.toBe(rowA.agent_identity_hash);
  });

  it("ENS-ATK-004: there is no cache that could outlive a revocation", () => {
    const keys = Object.keys(h.ens as object);
    expect(keys.some((k) => /cache|memo|ttl/i.test(k))).toBe(false);
  });
});

describe("P8.14 database & idempotency attacks", () => {
  it("DB-ATK-001: the same key with a DIFFERENT body returns the original, never a second authorization", async () => {
    const key = "same-key-different-body";
    const a = await h.broker.createRequest(ok({ idempotencyKey: key }) as never);
    const b = await h.broker.createRequest(
      ok({ idempotencyKey: key, adapterParams: { recipient: "0x000000000000000000000000000000000000dEaD", amount: "999999" } }) as never,
    );
    expect(b.requestId).toBe(a.requestId);
    const auths = h.db.prepare("SELECT COUNT(*) AS n FROM cre_authorizations").get() as { n: number };
    expect(auths.n, "the second body did NOT create a second authorization").toBe(1);
    // And the stored request still describes the ORIGINAL action, not the attacker's.
    const row = h.db.prepare("SELECT amount FROM capability_requests WHERE id=?").get(a.requestId) as { amount: string };
    expect(row.amount).toBe("500");
  });

  it("DB-ATK-002: a unique constraint, not application logic, backstops idempotency", () => {
    const sql = h.db.prepare("SELECT sql FROM sqlite_master WHERE name='capability_requests'").get() as { sql: string };
    expect(sql.sql).toMatch(/idempotency_key\s+TEXT\s+NOT NULL\s+UNIQUE/i);
  });

  it("DB-ATK-003: 20 concurrent identical requests yield exactly one request row", async () => {
    const key = "burst-key";
    await Promise.allSettled(Array.from({ length: 20 }, () => h.broker.createRequest(ok({ idempotencyKey: key }) as never)));
    const n = h.db.prepare("SELECT COUNT(*) AS n FROM capability_requests").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("DB-ATK-004: an unavailable database fails closed rather than issuing untracked authority", async () => {
    await h.broker.createRequest(ok() as never);
    h.db.close(); // simulate the database going away mid-flight
    await expect(h.broker.createRequest(ok() as never)).rejects.toBeTruthy();
  });

  it("DB-ATK-005: the database holds no key material and is not a source of authority", () => {
    const tables = (h.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((t) => t.name);
    for (const t of tables) {
      const rows = JSON.stringify(h.db.prepare(`SELECT * FROM ${t}`).all());
      expect(rows).not.toMatch(/59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d/);
      expect(rows).not.toContain("WALLET_PASS");
    }
    // No table stores a signature or a private key column.
    const schema = JSON.stringify(h.db.prepare("SELECT sql FROM sqlite_master").all());
    expect(schema).not.toMatch(/private_key|signature|secret/i);
  });
});
