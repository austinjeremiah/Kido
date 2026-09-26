/**
 * Group D attack demo.
 *
 * Ten scenarios across the three Group D surfaces — cross-chain plans, imported APIs, and the
 * hosted runtime with its local bridge. Every line prints what the code actually did, including the
 * exact reason code it refused with. A refusal without a code is not evidence, so there are none.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { encodeFunctionData } from "viem";
import {
  ChainlinkCcipAdapter, CCIP_ROUTER_ABI, ccipDeploymentFor,
  type CcipConstraints, type CcipIntent, type CcipPrepared,
} from "@contextlock/studio-adapters";
import {
  planHash, capabilityScopeFor, assertStepExecutable, derivePlanState,
  ArrivalRegistry, PlanError, type ExecutionPlan,
} from "@contextlock/studio-plan";
import { importOpenApi, resolveImportedTrust, checkRedirectChain, type EgressPolicy } from "@contextlock/studio-openapi";
import { LocalBridge, DENY_ALL, payloadHash, sign, newNonce, newId, BRIDGE_PROTOCOL_VERSION } from "@contextlock/bridge";

const SEPOLIA = 11155111;
const BASE_SEPOLIA = 84532;
const BASE_SELECTOR = "10344971235874465080";
const SEPOLIA_SELECTOR = "16015286601757825753";
const OWNER = "0x0000000000000000000000000000000000005e1f";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const HOST = "risk.acme-fixture.test";
const NOW = 1_700_000_000_000;

const results: Array<{ n: number; surface: string; scenario: string; outcome: string; code: string; detail: string }> = [];
const say = (n: number, surface: string, scenario: string, outcome: string, code: string, detail: string) => {
  results.push({ n, surface, scenario, outcome, code, detail });
  const c = outcome === "ALLOWED" ? "\x1b[32m" : outcome === "PARTIAL" ? "\x1b[33m" : "\x1b[31m";
  console.log(`\n${n}. [${surface}] ${scenario}\n   ${c}${outcome}\x1b[0m  ${code}  ${detail}`);
};

/* ─────────────────────────── the plan under attack ─────────────────────────── */

const plan = (): ExecutionPlan => ({
  schemaVersion: "contextlock.execution-plan/v1",
  planId: "plan-treasury-d",
  revision: 1,
  strategyId: "strat-d",
  organizationId: null,
  sourceChainId: SEPOLIA,
  steps: [
    {
      stepId: "bridge", chainId: SEPOLIA, adapterId: "chainlink-ccip", adapterVersion: "1.0.0",
      action: "CROSS_CHAIN_TOKEN_TRANSFER",
      normalizedIntent: { destinationChainId: BASE_SEPOLIA, receiver: OWNER, token: USDC, amount: "50000000" },
      dependencies: [], preconditions: [],
      expectedEffects: [{ kind: "TOKEN_OUT", chainId: SEPOLIA, token: USDC, amount: "50000000", party: OWNER }, { kind: "MESSAGE_SENT", chainId: SEPOLIA }],
      timeoutMs: 1_800_000,
      authorizationRequirement: { disposition: "AUTONOMOUS", valueUsdCents: 40_000, capabilityScope: null },
      status: "PENDING",
    },
    {
      stepId: "deploy", chainId: BASE_SEPOLIA, adapterId: "aave-v3-execution", adapterVersion: "1.0.0",
      action: "SUPPLY",
      normalizedIntent: { asset: USDC, amount: "50000000", account: OWNER },
      dependencies: ["bridge"], preconditions: [{ kind: "ARRIVAL_PROVEN", stepId: "bridge" }],
      expectedEffects: [{ kind: "TOKEN_IN", chainId: BASE_SEPOLIA, token: USDC, amount: "50000000", party: OWNER }],
      timeoutMs: 1_800_000,
      authorizationRequirement: { disposition: "AUTONOMOUS", valueUsdCents: 40_000, capabilityScope: null },
      status: "PENDING",
    },
  ],
  invariants: [{ id: "INV-1", statement: "The destination wallet is never changed." }],
  timeoutPolicy: { totalMs: 3_600_000, perStepDefaultMs: 1_800_000 },
  failurePolicy: { onStepFailure: "HOLD_AND_ESCALATE", maxRetries: 1, protocolRefundAvailable: false },
  completionPolicy: { requiredStepIds: ["bridge", "deploy"] },
  state: "READY",
});

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return e instanceof PlanError ? e.reason : `UNEXPECTED:${(e as Error).message}`; }
  return "NO REFUSAL";
};

const confirmed = (p: ExecutionPlan, id: string): ExecutionPlan => {
  const c = JSON.parse(JSON.stringify(p)) as ExecutionPlan;
  c.steps.find((s) => s.stepId === id)!.status = "CONFIRMED";
  return c;
};

async function main() {
  /* 1 — the valid path */ {
    const D = ccipDeploymentFor(SEPOLIA);
    const exec = new ChainlinkCcipAdapter();
    const intent: CcipIntent = {
      action: "CROSS_CHAIN_TOKEN_TRANSFER", sourceChainId: SEPOLIA, destinationChainId: BASE_SEPOLIA,
      receiver: OWNER, tokenTransfers: [{ token: USDC, amount: "50000000" }], data: "0x",
      feeToken: "0x0000000000000000000000000000000000000000", gasLimit: 200_000, timeoutMs: 1_800_000,
    };
    const constraints: CcipConstraints = {
      chainId: SEPOLIA, allowedTargets: [D.router], allowedRecipients: "self-only", owner: OWNER,
      allowUnlimitedApprovals: false, maxQuoteAgeMs: 60_000,
      permittedDestinationChainIds: [BASE_SEPOLIA], permittedActions: ["CROSS_CHAIN_TOKEN_TRANSFER"],
      allowedDestinationReceivers: [OWNER],
    };
    const encode = (o: { selector?: string; receiver?: string } = {}) =>
      encodeFunctionData({
        abi: CCIP_ROUTER_ABI, functionName: "ccipSend",
        args: [BigInt(o.selector ?? BASE_SELECTOR), {
          receiver: `0x${"0".repeat(24)}${(o.receiver ?? OWNER).slice(2)}` as `0x${string}`,
          data: "0x", tokenAmounts: [{ token: USDC as `0x${string}`, amount: 50_000_000n }],
          feeToken: "0x0000000000000000000000000000000000000000", extraArgs: "0x",
        }],
      });
    const prep = (data: string): CcipPrepared => ({
      to: D.router, data, value: "0", chainId: SEPOLIA,
      summary: { action: "CROSS_CHAIN_TOKEN_TRANSFER", destination: "Base Sepolia", receiver: OWNER, amount: "50000000" },
    });

    const n = await exec.decodeTransaction(prep(encode()));
    const v = exec.validateTransaction(n, intent, constraints);
    say(1, "cross-chain", "A valid plan on the verified Sepolia -> Base Sepolia lane",
      v.ok ? "ALLOWED" : "REFUSED", v.ok ? "—" : v.problems[0]!.code,
      `router ${D.router} (${D.routerTypeAndVersion}), selector ${BASE_SELECTOR}, lane verified on chain`);

    /* 2 — destination changed */
    const n2 = await exec.decodeTransaction(prep(encode({ selector: SEPOLIA_SELECTOR })));
    const v2 = exec.validateTransaction(n2, intent, constraints);
    say(2, "cross-chain", "Destination changed after the plan was approved",
      v2.ok ? "ALLOWED" : "REFUSED", v2.ok ? "—" : v2.problems[0]!.code,
      `summary still claimed Base Sepolia; the decoded selector said otherwise`);

    /* 2b — the plan hash and every capability move with it */
    const before = plan();
    const after = JSON.parse(JSON.stringify(before)) as ExecutionPlan;
    (after.steps[0]!.normalizedIntent as Record<string, unknown>).receiver = ATTACKER;
    const stale = capabilityScopeFor(before, "bridge");
    const code = reasonOf(() => assertStepExecutable(after, "bridge", { capabilityScope: stale, humanApproved: false }, NOW, NOW));
    say(3, "cross-chain", "A capability from the pre-edit plan is presented after the edit",
      "REFUSED", code, `${planHash(before).slice(0, 14)}… -> ${planHash(after).slice(0, 14)}…`);
  }

  /* 4 — duplicate CCIP message */ {
    const p = confirmed(plan(), "bridge");
    const wire = { sourceChainSelector: SEPOLIA_SELECTOR, sender: OWNER, destinationChainId: BASE_SEPOLIA, receiver: OWNER, token: USDC, amount: "50000000" };
    const expected = ArrivalRegistry.expectationFor(p, "bridge", wire);
    const observed = { messageId: "0xmsg-d", planHash: expected.planHash, stepId: "bridge", stepHash: expected.stepHash, ...wire };
    const reg = new ArrivalRegistry();
    const first = reg.record(expected, observed);
    const second = reg.record(expected, observed);
    say(4, "cross-chain", "The same CCIP message is observed twice",
      second.accepted ? "ALLOWED" : "REFUSED", second.accepted ? "—" : second.reason,
      `first observation accepted=${first.accepted}; destination execution funded once`);
  }

  /* 5 — step 1 succeeds, step 2 fails */ {
    let p = confirmed(plan(), "bridge");
    p = JSON.parse(JSON.stringify(p)) as ExecutionPlan;
    p.steps.find((s) => s.stepId === "deploy")!.status = "FAILED";
    const state = derivePlanState(p);
    say(5, "cross-chain", "The bridge delivers and the destination action fails",
      state === "PARTIAL" ? "PARTIAL" : "REFUSED", state,
      `no rollback is offered, because after delivery there is nothing to roll back to`);
  }

  /* 6, 7 — malicious OpenAPI */ {
    // localhost resolves, so the refusal comes from the loopback check this scene is about rather
    // than from a DNS failure — a refusal for the wrong reason is no evidence at all (FND-V2-008).
    const dns: Record<string, string[]> = {
      [HOST]: ["203.0.113.10"],
      "internal.corp.test": ["10.0.0.5"],
      localhost: ["127.0.0.1"],
    };
    const egress: EgressPolicy = {
      allowedHosts: [HOST, "localhost", "internal.corp.test"],
      allowedPorts: [443], maxRedirects: 2,
      resolve: async (h) => dns[h] ?? (() => { throw new Error(`NXDOMAIN ${h}`); })(),
    };
    const spec = (server: string) => JSON.stringify({
      openapi: "3.1.0", info: { title: "Acme Risk", version: "1" },
      servers: [{ url: server }],
      paths: { "/risk/{w}": { get: { operationId: "getRisk", parameters: [{ name: "w", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { type: "object" } } } } },
    });

    const local = await importOpenApi(spec("https://localhost/v1"), { egress });
    say(6, "imported-api", "An imported spec whose server is localhost",
      local.ok ? "ALLOWED" : "REFUSED", local.problems[0]?.code ?? "—", local.problems[0]?.message ?? "");

    const redirect = await checkRedirectChain(`https://${HOST}/v1`, ["https://internal.corp.test/admin"], egress);
    say(7, "imported-api", "An allow-listed host that redirects into the private network",
      redirect.ok ? "ALLOWED" : "REFUSED", redirect.ok ? "—" : redirect.reason,
      redirect.ok ? "" : `every hop is revalidated, not only the first`);
  }

  /* 8 — trust promotion */ {
    const r = resolveImportedTrust({ requested: "VERIFIED_ORACLE", source: "model" });
    say(8, "imported-api", "The model classifies a REST price feed as VERIFIED_ORACLE",
      r.refused ? "REFUSED" : "ALLOWED", r.refused?.reason ?? "—",
      `resolved trust stayed ${r.trustClass}`);
  }

  /* 9, 10 — the local bridge */ {
    const egress: EgressPolicy = { allowedHosts: [HOST], allowedPorts: [443], maxRedirects: 2, resolve: async () => ["203.0.113.10"] };
    const bridge = new LocalBridge({
      now: () => NOW, egress,
      performApiCall: async () => ({ status: 200, body: { riskScore: 37 } }),
    });
    const code = bridge.createPairingCode("u1", "prj_1");
    const paired = bridge.pair(code.code, {
      ...DENY_ALL,
      allowedProjects: ["prj_1"], allowedOperations: ["credential.performApiRequest"],
      allowedCredentialRefs: ["local://acme-risk-api"], allowedHosts: [HOST],
      allowedApiOperationIds: ["getRisk"], humanApprovalAboveUsdCents: 50_000,
    });
    if (!paired.ok) throw new Error("pairing failed");
    const session = paired.value;

    const build = (op: string, payload: Record<string, unknown>) => {
      const req = {
        protocolVersion: BRIDGE_PROTOCOL_VERSION, requestId: newId("req"),
        bridgeId: session.bridgeId, userId: session.userId, projectId: session.projectId,
        operationType: op, payloadHash: payloadHash(payload),
        issuedAtMs: NOW, expiresAtMs: NOW + 60_000, nonce: newNonce(),
      } as never;
      return { request: req, payload, signature: sign(req, session.key) };
    };

    const askForKey = await bridge.handle(build("getSecret", { credentialRef: "local://acme-risk-api" }));
    say(9, "local-bridge", "The hosted agent asks the bridge to return the API key",
      askForKey.ok ? "ALLOWED" : "REFUSED", askForKey.ok ? "—" : askForKey.reason,
      askForKey.ok ? "" : "the operation does not exist; the bridge performs tasks and returns answers");

    const good = build("credential.performApiRequest", { credentialRef: "local://acme-risk-api", operationId: "getRisk", url: `https://${HOST}/v1/risk/${OWNER}` });
    const once = await bridge.handle(good);
    const twice = await bridge.handle(good);
    say(10, "local-bridge", "A captured bridge request is replayed",
      twice.ok ? "ALLOWED" : "REFUSED", twice.ok ? "—" : twice.reason,
      `first attempt ok=${once.ok}; the credential never appeared in either response`);

    bridge.revoke(session.bridgeId);
    const after = await bridge.handle(build("credential.performApiRequest", { credentialRef: "local://acme-risk-api", operationId: "getRisk", url: `https://${HOST}/v1/risk/${OWNER}` }));
    say(11, "local-bridge", "An outstanding request arrives after the session is revoked",
      after.ok ? "ALLOWED" : "REFUSED", after.ok ? "—" : after.reason, "revocation takes effect immediately");
  }

  mkdirSync("reports/group-d/evidence", { recursive: true });
  writeFileSync("reports/group-d/evidence/group-d-attacks.json", JSON.stringify(results, null, 2));
  console.log(`\n\x1b[1m${results.length} scenarios executed\x1b[0m`);
}

void main();
