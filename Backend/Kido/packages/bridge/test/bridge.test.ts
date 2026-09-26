import { describe, expect, it } from "vitest";
import {
  LocalBridge, DENY_ALL, BRIDGE_REASONS, BRIDGE_PROTOCOL_VERSION, BRIDGE_OPERATIONS,
  FORBIDDEN_OPERATIONS, payloadHash, sign, newNonce, newId,
  type BridgePermissions, type SignedBridgeRequest, type BridgeSession,
} from "../src/index.js";
import type { EgressPolicy } from "@contextlock/studio-openapi";

const NOW = 1_700_000_000_000;
const HOST = "risk.acme-fixture.test";
const BEARER = "sk-live-NOT-A-REAL-KEY-never-leaves-this-machine";

const APPROVED_WASM = "a".repeat(64);
/** What `hashFile` reports. Overridden per test to simulate a swapped artifact. */
let ON_DISK_WASM = APPROVED_WASM;

const egress: EgressPolicy = {
  allowedHosts: [HOST],
  allowedPorts: [443],
  maxRedirects: 2,
  resolve: async (h) => (h === HOST ? ["203.0.113.10"] : h === "internal.test" ? ["10.0.0.5"] : (() => { throw new Error("NXDOMAIN"); })()),
};

const permissions = (over: Partial<BridgePermissions> = {}): BridgePermissions => ({
  ...DENY_ALL,
  allowedProjects: ["prj_1"],
  allowedOperations: ["credential.performApiRequest", "cre.simulateWorkflow", "cre.status", "cre.buildWorkflow", "cre.deployWorkflow", "cre.workflowLifecycle", "ledger.approveContextLockAction"],
  allowedCredentialRefs: ["local://acme-risk-api"],
  allowedHosts: [HOST],
  allowedApiOperationIds: ["getRisk"],
  allowedCreWorkflows: ["contextlock-policy"],
  allowedLedgerActionTypes: ["APPROVE_TRANSFER"],
  humanApprovalAboveUsdCents: 50_000,
  ...over,
});

/** A bridge with everything wired, so a refusal is never merely a missing dependency. */
const make = (over: Record<string, unknown> = {}) => {
  const calls: Array<Record<string, unknown>> = [];
  const bridge = new LocalBridge({
    now: () => NOW,
    egress,
    performApiCall: async (a) => {
      calls.push(a);
      // The credential is attached HERE. It never appears in what is returned.
      return { status: 200, body: { riskScore: 37, timestamp: "2026-09-08T00:00:00Z" } };
    },
    runCreWorkflow: async (w) => ({ status: "OK", result: { workflow: w, verdict: "ALLOW" } }),
    creDeploy: {
      status: async () => ({
        connected: true, organizationId: "org_1", organizationName: "My Org",
        accountLabel: "user@example.test", deployAccess: true,
        registryIds: ["private", "onchain:ethereum-mainnet"],
        supportedChains: [{ chainName: "ethereum-testnet-sepolia", chainSelector: "16015286601757825753", forwarder: "0x6481F59038b2925AF0Ec22643E6e675c4Aec04a7" }],
        cliVersion: "v1.32.0",
      }),
      build: async () => ({ wasmPath: "/tmp/w/binary.wasm", wasmBytes: 2_400_000, wasmSha256: APPROVED_WASM, binaryHash: "b".repeat(64), configHash: "c".repeat(64), workflowHash: "d".repeat(64), cliVersion: "v1.32.0" }),
      deploy: async (a) => ({ workflowId: "wf_1", registry: a.registry, status: "PAUSED", binaryHash: "b".repeat(64) }),
      lifecycle: async (a) => ({ status: a.action === "pause" ? "PAUSED" : "ACTIVE", detail: { workflow: a.workflow } }),
      hashFile: async () => ON_DISK_WASM,
    },
    askHuman: async () => true,
    ...over,
  });
  const code = bridge.createPairingCode("u1", "prj_1");
  const paired = bridge.pair(code.code, permissions());
  if (!paired.ok) throw new Error(`pairing failed: ${paired.reason}`);
  return { bridge, session: paired.value, calls, code };
};

const request = (
  session: BridgeSession,
  operationType: string,
  payload: Record<string, unknown>,
  over: Partial<Record<string, unknown>> = {},
): SignedBridgeRequest => {
  const req = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId: newId("req"),
    bridgeId: session.bridgeId,
    userId: session.userId,
    projectId: session.projectId,
    operationType,
    payloadHash: payloadHash(payload),
    issuedAtMs: NOW,
    expiresAtMs: NOW + 60_000,
    nonce: newNonce(),
    ...over,
  } as never;
  return { request: req, payload, signature: sign(req, session.key) };
};

const apiPayload = { credentialRef: "local://acme-risk-api", operationId: "getRisk", url: `https://${HOST}/v1/risk/0x5e1f` };

describe("pairing", () => {
  it("BRIDGE-001 pairing establishes a session with its own ephemeral key", () => {
    const { session, code } = make();
    expect(session.bridgeId).toMatch(/^bridge_/);
    expect(session.userId).toBe("u1");
    expect(session.projectId).toBe("prj_1");
    expect(session.key.length).toBe(32);
    // The key is generated locally, not derived from a code short enough to read aloud.
    expect(session.key.toString("hex")).not.toContain(code.code.toLowerCase());
  });

  it("BRIDGE-002 a pairing code is single-use", () => {
    const bridge = new LocalBridge({ now: () => NOW, egress });
    const code = bridge.createPairingCode("u1", "prj_1");
    expect(bridge.pair(code.code, permissions()).ok).toBe(true);
    expect(bridge.pair(code.code, permissions())).toMatchObject({ ok: false, reason: BRIDGE_REASONS.PAIRING_USED });
  });

  it("BRIDGE-002b an expired pairing code is refused", () => {
    let t = NOW;
    const bridge = new LocalBridge({ now: () => t, egress });
    const code = bridge.createPairingCode("u1", "prj_1", 1000);
    t += 1001;
    expect(bridge.pair(code.code, permissions())).toMatchObject({ ok: false, reason: BRIDGE_REASONS.PAIRING_EXPIRED });
  });

  it("BRIDGE-002c an unknown code is refused", () => {
    const bridge = new LocalBridge({ now: () => NOW, egress });
    expect(bridge.pair("DEADBEEF", permissions())).toMatchObject({ ok: false, reason: BRIDGE_REASONS.PAIRING_UNKNOWN });
  });
});

describe("mutual authentication", () => {
  it("BRIDGE-003 a correctly signed request is performed", async () => {
    const { bridge, session, calls } = make();
    const r = await bridge.handle(request(session, "credential.performApiRequest", apiPayload));
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("BRIDGE-004 a wrong signature is refused", async () => {
    const { bridge, session } = make();
    const req = request(session, "credential.performApiRequest", apiPayload);
    const r = await bridge.handle({ ...req, signature: "00".repeat(32) });
    expect(r).toMatchObject({ ok: false, reason: BRIDGE_REASONS.BAD_SIGNATURE });
  });

  it("BRIDGE-005 mutating the payload after signing is refused", async () => {
    const { bridge, session } = make();
    const req = request(session, "credential.performApiRequest", apiPayload);
    // Same signature, same payloadHash field, different actual payload.
    const r = await bridge.handle({ ...req, payload: { ...apiPayload, url: `https://${HOST}/v1/risk/0xdead` } });
    expect(r).toMatchObject({ ok: false, reason: BRIDGE_REASONS.PAYLOAD_MUTATED });
  });

  it("BRIDGE-005b mutating a signed header field is refused", async () => {
    const { bridge, session } = make();
    const req = request(session, "credential.performApiRequest", apiPayload);
    const tampered = { ...req, request: { ...req.request, projectId: "prj_other" } };
    const r = await bridge.handle(tampered);
    // Caught by the signature, not by the project check — the field is inside the signing input.
    expect(r).toMatchObject({ ok: false, reason: BRIDGE_REASONS.BAD_SIGNATURE });
  });

  it("BRIDGE-006 a replayed request is refused", async () => {
    const { bridge, session } = make();
    const req = request(session, "credential.performApiRequest", apiPayload);
    expect((await bridge.handle(req)).ok).toBe(true);
    expect(await bridge.handle(req)).toMatchObject({ ok: false, reason: BRIDGE_REASONS.REPLAY });
  });

  it("BRIDGE-007 an expired request is refused", async () => {
    const { bridge, session } = make();
    const req = request(session, "credential.performApiRequest", apiPayload, { expiresAtMs: NOW - 1 });
    const signedAgain = { ...req, signature: sign(req.request, session.key) };
    expect(await bridge.handle(signedAgain)).toMatchObject({ ok: false, reason: BRIDGE_REASONS.EXPIRED });
  });

  it("BRIDGE-008 a request for another project is refused", async () => {
    const { bridge } = make();
    const other = make();
    // Correctly signed by ITS OWN session, but naming a bridge that is not its own.
    const req = request(other.session, "credential.performApiRequest", apiPayload);
    const crossed = { ...req, request: { ...req.request, bridgeId: "bridge_does_not_exist" } };
    // WRONG_BRIDGE rather than BAD_SIGNATURE: the session must be found before its key can verify
    // anything, so an unknown bridge is reported as unknown rather than as a bad signature.
    expect(await bridge.handle(crossed)).toMatchObject({ ok: false, reason: BRIDGE_REASONS.WRONG_BRIDGE });

    // A request signed by ANOTHER live session, re-aimed at this one, fails on the signature.
    const reaimed = { ...req, request: { ...req.request, bridgeId: bridge.session(other.session.bridgeId) ? other.session.bridgeId : req.request.bridgeId } };
    expect((await bridge.handle(reaimed)).ok).toBe(false);
  });

  it("BRIDGE-008b a session paired to one project cannot serve another", async () => {
    const bridge = new LocalBridge({ now: () => NOW, egress, performApiCall: async () => ({ status: 200, body: {} }) });
    const code = bridge.createPairingCode("u1", "prj_1");
    const paired = bridge.pair(code.code, permissions({ allowedProjects: ["prj_2"] }));
    if (!paired.ok) throw new Error("unreachable");
    const r = await bridge.handle(request(paired.value, "credential.performApiRequest", apiPayload));
    expect(r).toMatchObject({ ok: false, reason: BRIDGE_REASONS.WRONG_PROJECT });
  });

  it("BRIDGE-015 a revoked session refuses outstanding requests", async () => {
    const { bridge, session } = make();
    const req = request(session, "credential.performApiRequest", apiPayload);
    bridge.revoke(session.bridgeId);
    expect(await bridge.handle(req)).toMatchObject({ ok: false, reason: BRIDGE_REASONS.SESSION_REVOKED });
  });

  it("BRIDGE-015b an expired session refuses requests", async () => {
    let t = NOW;
    const bridge = new LocalBridge({ now: () => t, egress, performApiCall: async () => ({ status: 200, body: {} }) });
    const code = bridge.createPairingCode("u1", "prj_1");
    const paired = bridge.pair(code.code, permissions(), 1000);
    if (!paired.ok) throw new Error("unreachable");
    const req = request(paired.value, "credential.performApiRequest", apiPayload);
    t += 1001;
    expect(await bridge.handle(req)).toMatchObject({ ok: false, reason: BRIDGE_REASONS.NO_SESSION });
  });
});

describe("the operation vocabulary is closed", () => {
  it("BRIDGE-009 getSecret does not exist", async () => {
    const { bridge, session } = make();
    for (const op of ["getSecret", "credential.get", "credential.reveal", "readEnv", "dumpCRESession", "getLedgerSeed"]) {
      const r = await bridge.handle(request(session, op, {}));
      expect(r, op).toMatchObject({ ok: false, reason: BRIDGE_REASONS.OPERATION_NOT_AVAILABLE });
      if (r.ok) throw new Error("unreachable");
      expect(r.detail).toContain("does not hand out access");
    }
  });

  it("BRIDGE-010 shell execution does not exist", async () => {
    const { bridge, session } = make();
    for (const op of ["runShell", "shell.exec", "fs.read"]) {
      expect(await bridge.handle(request(session, op, {})), op).toMatchObject({
        ok: false, reason: BRIDGE_REASONS.OPERATION_NOT_AVAILABLE,
      });
    }
  });

  it("BRIDGE-010b the forbidden list and the operation list do not overlap", () => {
    for (const op of BRIDGE_OPERATIONS) expect(FORBIDDEN_OPERATIONS.has(op)).toBe(false);
  });

  it("an operation outside the vocabulary is unknown rather than not-available", async () => {
    const { bridge, session } = make();
    // The distinction is worth keeping: "not available" means something asked for raw access.
    expect(await bridge.handle(request(session, "some.new.thing", {}))).toMatchObject({
      ok: false, reason: BRIDGE_REASONS.UNKNOWN_OPERATION,
    });
  });

  it("BRIDGE-020 the bridge cannot create financial authority", () => {
    // There is no operation that mints a capability, signs an arbitrary digest, or grants a
    // permission. Every operation either performs a bounded task or asks a device to approve one.
    //
    // The list grew in Group E when deployment arrived, and this assertion is why that growth had
    // to be a decision: adding a bridge operation breaks this test until someone writes the new
    // name down here. Each of the four additions is a named task with a bounded result, and none
    // of them signs anything or returns a credential.
    expect([...BRIDGE_OPERATIONS].sort()).toEqual([
      "cre.buildWorkflow",
      "cre.deployWorkflow",
      "cre.simulateWorkflow",
      "cre.status",
      "cre.workflowLifecycle",
      "credential.performApiRequest",
      "ledger.approveContextLockAction",
      "ledger.performProtectedBrokerAction",
    ]);
  });

  it("BRIDGE-020b the deployment shortcuts a deployment path invites are named absent, not merely missing", async () => {
    const { bridge, session } = make();
    // Each of these is the obvious way to implement deployment badly. Asking for one is reported as
    // OPERATION_NOT_AVAILABLE — "something asked for raw access" — rather than as an unknown name.
    for (const op of ["cre.runCommand", "cre.getApiKey", "cre.readConfig", "wallet.getPrivateKey", "wallet.exportKeystore", "docker.runCommand", "docker.socket"]) {
      expect(FORBIDDEN_OPERATIONS.has(op), `${op} must be named forbidden`).toBe(true);
      expect(await bridge.handle(request(session, op, {})), op).toMatchObject({
        ok: false, reason: BRIDGE_REASONS.OPERATION_NOT_AVAILABLE,
      });
    }
  });
});

describe("credential operations", () => {
  it("BRIDGE-011 an allowed API call is performed with a locally-held credential", async () => {
    const { bridge, session, calls } = make();
    const r = await bridge.handle(request(session, "credential.performApiRequest", apiPayload));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect((r.value as { body: { riskScore: number } }).body.riskScore).toBe(37);
    expect(calls[0]!.credentialRef).toBe("local://acme-risk-api");
  });

  it("BRIDGE-012 the raw credential never appears in the response", async () => {
    const { bridge, session } = make({
      performApiCall: async () => ({ status: 200, body: { riskScore: 37 } }),
    });
    const r = await bridge.handle(request(session, "credential.performApiRequest", apiPayload));
    expect(JSON.stringify(r)).not.toContain(BEARER);
    expect(JSON.stringify(r)).not.toMatch(/authorization|bearer/i);
  });

  it("BRIDGE-013 an unapproved credential reference is refused", async () => {
    const { bridge, session } = make();
    const r = await bridge.handle(request(session, "credential.performApiRequest", { ...apiPayload, credentialRef: "local://something-else" }));
    expect(r).toMatchObject({ ok: false, reason: BRIDGE_REASONS.CREDENTIAL_NOT_ALLOWED });
  });

  it("BRIDGE-013b an unapproved operationId is refused even with an approved credential", async () => {
    const { bridge, session } = make();
    const r = await bridge.handle(request(session, "credential.performApiRequest", { ...apiPayload, operationId: "deleteEverything" }));
    expect(r).toMatchObject({ ok: false, reason: BRIDGE_REASONS.NOT_PERMITTED });
  });

  it("BRIDGE-014 the host allow-list is enforced on the bridge's own machine", async () => {
    const { bridge, session } = make();
    const r = await bridge.handle(request(session, "credential.performApiRequest", { ...apiPayload, url: "https://public.test/x" }));
    expect(r).toMatchObject({ ok: false, reason: BRIDGE_REASONS.HOST_NOT_ALLOWED });
  });

  it("BRIDGE-014b a redirect target inside the user's own network is refused", async () => {
    const { bridge, session } = make();
    // The bridge sits inside the network the hosted service cannot reach, which is exactly what
    // makes an SSRF here valuable.
    const r = await bridge.handle(request(session, "credential.performApiRequest", { ...apiPayload, url: "https://internal.test/admin" }));
    expect(r).toMatchObject({ ok: false, reason: BRIDGE_REASONS.HOST_NOT_ALLOWED });
  });
});

describe("CRE and Ledger operations", () => {
  it("BRIDGE-016 a CRE operation returns status and result, never the session", async () => {
    const { bridge, session } = make();
    const r = await bridge.handle(request(session, "cre.simulateWorkflow", { workflow: "contextlock-policy", args: {} }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value).toEqual({ status: "OK", result: { workflow: "contextlock-policy", verdict: "ALLOW" } });
    const s = JSON.stringify(r.value).toLowerCase();
    for (const forbidden of ["password", "session", "token", "cookie", "2fa", "email"]) {
      expect(s, forbidden).not.toContain(forbidden);
    }
  });

  it("BRIDGE-016b an unapproved workflow is refused", async () => {
    const { bridge, session } = make();
    expect(await bridge.handle(request(session, "cre.simulateWorkflow", { workflow: "something-else" })))
      .toMatchObject({ ok: false, reason: BRIDGE_REASONS.NOT_PERMITTED });
  });

  it("BRIDGE-017 a Ledger operation with no device attached fails, and is never simulated", async () => {
    const { bridge, session } = make();
    const r = await bridge.handle(request(session, "ledger.approveContextLockAction", { actionType: "APPROVE_TRANSFER", amountUsdCents: 10_000 }));
    expect(r).toMatchObject({ ok: false, reason: BRIDGE_REASONS.HARDWARE_UNAVAILABLE });
    if (r.ok) throw new Error("unreachable");
    expect(r.detail).toContain("BLK-002");
    expect(r.detail).toContain("never simulated");
  });

  it("BRIDGE-017b with a device attached it signs, and the digest covers the payload", async () => {
    const { bridge, session } = make({
      ledger: { approve: async (_t: string, d: string) => ({ approved: true, signature: `sig:${d.slice(0, 8)}` }) },
    });
    const r = await bridge.handle(request(session, "ledger.approveContextLockAction", { actionType: "APPROVE_TRANSFER", amountUsdCents: 10_000 }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect((r.value as { approved: boolean }).approved).toBe(true);
  });

  it("BRIDGE-017c an amount above the ceiling needs a person, and a decline is honoured", async () => {
    const declined = make({
      ledger: { approve: async () => ({ approved: true, signature: "sig" }) },
      askHuman: async () => false,
    });
    const r = await declined.bridge.handle(
      request(declined.session, "ledger.approveContextLockAction", { actionType: "APPROVE_TRANSFER", amountUsdCents: 90_000 }),
    );
    expect(r).toMatchObject({ ok: false, reason: BRIDGE_REASONS.APPROVAL_REQUIRED });
  });

  it("BRIDGE-017d with no approval channel, a large operation cannot proceed", async () => {
    const b = make({ ledger: { approve: async () => ({ approved: true, signature: "s" }) }, askHuman: undefined });
    const r = await b.bridge.handle(request(b.session, "ledger.approveContextLockAction", { actionType: "APPROVE_TRANSFER", amountUsdCents: 90_000 }));
    expect(r).toMatchObject({ ok: false, reason: BRIDGE_REASONS.APPROVAL_REQUIRED });
  });
});

describe("what a compromised hosted agent can obtain", () => {
  it("BRIDGE-019 nothing beyond the answers of allow-listed operations", async () => {
    const { bridge, session } = make();
    // The full attack surface of a hosted agent that has the signing key: it can ask for the
    // operations it is permitted, and it gets their bounded results.
    const attempts = [
      "getSecret", "credential.get", "runShell", "readEnv", "dumpCRESession", "getLedgerSeed",
      "ledger.exportSeed", "fs.read", "env.read",
    ];
    for (const op of attempts) {
      const r = await bridge.handle(request(session, op, {}));
      expect(r.ok, op).toBe(false);
    }
    // And a permitted call returns an ANSWER, with no credential in it.
    const good = await bridge.handle(request(session, "credential.performApiRequest", apiPayload));
    expect(good.ok).toBe(true);
    expect(JSON.stringify(good)).not.toContain(BEARER);
  });

  it("BRIDGE-018 a default-deny permission set permits nothing at all", async () => {
    const bridge = new LocalBridge({ now: () => NOW, egress, performApiCall: async () => ({ status: 200, body: {} }) });
    const code = bridge.createPairingCode("u1", "prj_1");
    const paired = bridge.pair(code.code, DENY_ALL);
    if (!paired.ok) throw new Error("unreachable");
    // An empty allow-list permits nothing; it does not permit everything.
    for (const op of BRIDGE_OPERATIONS) {
      const r = await bridge.handle(request(paired.value, op, apiPayload));
      expect(r, op).toMatchObject({ ok: false, reason: BRIDGE_REASONS.NOT_PERMITTED });
    }
  });
});

describe("CRE deployment through the bridge", () => {
  it("BRIDGE-021 the status that crosses back is fields, never a session", async () => {
    ON_DISK_WASM = APPROVED_WASM;
    const { bridge, session } = make();
    const r = await bridge.handle(request(session, "cre.status", {}));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value).toMatchObject({ connected: true, deployAccess: true, organizationId: "org_1" });
    const serialized = JSON.stringify(r.value);
    for (const forbidden of ["accessToken", "refreshToken", "apiKey", "session", "cre.yaml", "eyJ"]) {
      expect(serialized, `status must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("BRIDGE-022 a deploy of a binary that is not the approved one is refused on this side of the boundary", async () => {
    const { bridge, session } = make();
    // The control plane says it approved A; the file on disk hashes to B. The bridge holds the
    // file, so the bridge is where this has to be caught.
    ON_DISK_WASM = "f".repeat(64);
    const r = await bridge.handle(request(session, "cre.deployWorkflow", {
      workflow: "contextlock-policy", wasmPath: "/tmp/w/binary.wasm", registry: "private", approvedWasmSha256: APPROVED_WASM,
    }));
    expect(r).toMatchObject({ ok: false, reason: BRIDGE_REASONS.NOT_PERMITTED });
    if (r.ok) throw new Error("unreachable");
    expect(r.detail).toContain("DEPLOYMENT_ARTIFACT_DRIFT");

    ON_DISK_WASM = APPROVED_WASM;
    const ok = await bridge.handle(request(session, "cre.deployWorkflow", {
      workflow: "contextlock-policy", wasmPath: "/tmp/w/binary.wasm", registry: "private", approvedWasmSha256: APPROVED_WASM,
    }));
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("unreachable");
    // Deployed PAUSED. The workflow does not begin responding to triggers because it was deployed.
    expect(ok.value).toMatchObject({ workflowId: "wf_1", registry: "private", status: "PAUSED", deployedWasmSha256: APPROVED_WASM });
  });

  it("BRIDGE-023 a deploy that states no approved hash is refused, so 'deploy whatever is there' is unrepresentable", async () => {
    ON_DISK_WASM = APPROVED_WASM;
    const { bridge, session } = make();
    for (const bad of ["", "not-a-hash", "A".repeat(64)]) {
      const r = await bridge.handle(request(session, "cre.deployWorkflow", {
        workflow: "contextlock-policy", wasmPath: "/tmp/w/binary.wasm", registry: "private", approvedWasmSha256: bad,
      }));
      expect(r, `approvedWasmSha256=${JSON.stringify(bad)}`).toMatchObject({ ok: false, reason: BRIDGE_REASONS.NOT_PERMITTED });
    }
  });

  it("BRIDGE-024 the bridge refuses the onchain registry independently of whatever the control plane decided", async () => {
    ON_DISK_WASM = APPROVED_WASM;
    const { bridge, session } = make();
    const r = await bridge.handle(request(session, "cre.deployWorkflow", {
      workflow: "contextlock-policy", wasmPath: "/tmp/w/binary.wasm", registry: "onchain:ethereum-mainnet", approvedWasmSha256: APPROVED_WASM,
    }));
    expect(r).toMatchObject({ ok: false, reason: BRIDGE_REASONS.NOT_PERMITTED });
    if (r.ok) throw new Error("unreachable");
    expect(r.detail).toMatch(/Ethereum Mainnet lifecycle writes/);
  });

  it("BRIDGE-025 a workflow outside the session's allow-list cannot be built, deployed or paused", async () => {
    ON_DISK_WASM = APPROVED_WASM;
    const { bridge, session } = make();
    for (const [op, payload] of [
      ["cre.buildWorkflow", { workflow: "someone-elses-workflow" }],
      ["cre.deployWorkflow", { workflow: "someone-elses-workflow", wasmPath: "/tmp/w/binary.wasm", registry: "private", approvedWasmSha256: APPROVED_WASM }],
      ["cre.workflowLifecycle", { workflow: "someone-elses-workflow", action: "pause" }],
    ] as const) {
      expect(await bridge.handle(request(session, op, payload as Record<string, unknown>)), op).toMatchObject({
        ok: false, reason: BRIDGE_REASONS.NOT_PERMITTED,
      });
    }
  });

  it("BRIDGE-026 the lifecycle action set is closed", async () => {
    ON_DISK_WASM = APPROVED_WASM;
    const { bridge, session } = make();
    expect(await bridge.handle(request(session, "cre.workflowLifecycle", { workflow: "contextlock-policy", action: "pause" }))).toMatchObject({ ok: true });
    for (const action of ["delete", "exec", "anything", ""]) {
      expect(await bridge.handle(request(session, "cre.workflowLifecycle", { workflow: "contextlock-policy", action })), action)
        .toMatchObject({ ok: false, reason: BRIDGE_REASONS.UNKNOWN_OPERATION });
    }
  });
});
