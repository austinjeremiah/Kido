import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { keccak256, toHex } from "viem";
import {
  simulationCenter, assertLayerMeaningsDistinct, assertNoUnrunPass, SimulationCenterError,
  connectFlow, creAccountView, assertNotCredentialIntake,
  PARITY_FIXTURES, PARITY_COMPARED_FIELDS, PARITY_IGNORED_FIELDS, parityRun, assertParityBeforeAuthoritative, ParityError,
  tokenRequirements, TESTNET_ASSET_NOTE, activationReadiness,
  SHOCK_PRESETS, shockPresets, presetById, runShock, compareScenarios, assertSyntheticLabelled, decideOnSnapshot, ScenarioLabError,
  shadowRunView, forkActionDetail, ShadowUxError,
  decisionDetail, assertDecisionPrivate, DecisionDetailError, REASON_PLAIN,
  policyFromBlueprint,
  type SimulationLayerView, type ParityOutcome,
} from "../src/index.js";
import { MarketSnapshotSchema, ShadowDecisionSchema, ForkDescriptorSchema, ForkTransactionSchema, LOCAL_FORK_TX_LABEL } from "@contextlock/studio-reality";
import { CreConnectionInfoSchema } from "../src/cre-lab.js";
import { canonicalGuardian, repoRoot } from "./fixtures.js";

/**
 * The P28 product surfaces the first pass left as routes without screens.
 *
 * Every describe below is one section of §P28, and each test drives the real projection rather than
 * asserting a shape. The recurring question is the one the whole phase turns on: **can this surface
 * say something that is not true?** A row of four ticks that means more than it should, a parity
 * table that certifies a workflow nobody deployed, an explorer link for a transaction that exists
 * on one machine.
 */

/* ══════════════════════════ §P28.12 simulation center ══════════════════════════ */

const simInputs = () => ({
  deterministic: { passed: 31, total: 31 },
  cre: { ran: true, passed: true, productionLimits: true, binaryHash: "800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0" },
  reality: { ran: true, passed: true, mode: "LIVE_MIRROR", anchorBlock: "25948178" },
  fork: { available: true, ran: true, passed: true, forkBlock: "25948255", blocker: null },
});

describe("SIM-001 the four layers keep their meanings apart", () => {
  it("SIM-001 every layer states what it does NOT prove", () => {
    /*
     * The reason this is a required field rather than a nicety. Four green ticks read as
     * "everything was simulated" — and the CRE simulator never saw mainnet liquidity while the
     * reality test never ran a workflow. The second line is what stops the row over-claiming.
     */
    const view = simulationCenter(simInputs());
    expect(view.layers).toHaveLength(4);
    for (const l of view.layers) {
      expect(l.doesNotProve.length, l.title).toBeGreaterThan(20);
      expect(l.proves).not.toBe(l.doesNotProve);
    }
  });

  it("SIM-001b no two layers give the same explanation", () => {
    const view = simulationCenter(simInputs());
    const proves = view.layers.map((l) => l.proves.toLowerCase());
    expect(new Set(proves).size).toBe(4);
    const engines = view.layers.map((l) => l.engine.toLowerCase());
    expect(new Set(engines).size).toBe(4);
  });

  it("SIM-001c collapsing two layers' meanings is refused", () => {
    const view = simulationCenter(simInputs());
    const collapsed = view.layers.map((l) => ({ ...l, proves: "the agent was simulated and it passed" }));
    expect(() => assertLayerMeaningsDistinct(collapsed)).toThrow(SimulationCenterError);
    expect(() => assertLayerMeaningsDistinct(collapsed)).toThrow(/SIMULATION_LAYER_MEANINGS_COLLAPSED/);
  });
});

describe("SIM-002 a layer that did not run says so", () => {
  it("SIM-002 an unrun CRE simulation is NOT_RUN, not FAIL", () => {
    /*
     * The two lead somewhere different. FAIL sends someone to debug a strategy; NOT_RUN sends them
     * to run the thing. Collapsing them wastes the reader's afternoon.
     */
    const view = simulationCenter({ ...simInputs(), cre: { ran: false, passed: false, productionLimits: false, binaryHash: null } });
    const cre = view.layers.find((l) => l.key === "CRE_WORKFLOW_SIMULATION");
    expect(cre?.status).toBe("NOT_RUN");
    expect(view.requiredPassed).toBe(false);
    expect(view.outstanding).toContain("CRE workflow simulation");
  });

  it("SIM-002b an unavailable fork is BLOCKED and does not block the required set", () => {
    const view = simulationCenter({ ...simInputs(), fork: { available: false, ran: false, passed: false, forkBlock: null, blocker: "no anvil" } });
    const fork = view.layers.find((l) => l.key === "FORK_EXECUTION");
    expect(fork?.status).toBe("BLOCKED");
    expect(fork?.optional).toBe(true);
    expect(fork?.blocker).toBe("no anvil");
    // §P28: an optional blocked path does not fail the phase.
    expect(view.requiredPassed).toBe(true);
  });

  it("SIM-002c an absent deterministic result is NOT_RUN with no invented count", () => {
    const view = simulationCenter({ ...simInputs(), deterministic: null });
    const det = view.layers.find((l) => l.key === "SECURITY_SIMULATION");
    expect(det?.status).toBe("NOT_RUN");
    expect(det?.passed).toBeNull();
    expect(det?.total).toBeNull();
  });

  it("SIM-002d a PASS whose own detail says it never ran is refused", () => {
    const view = simulationCenter({ ...simInputs(), cre: { ran: false, passed: false, productionLimits: false, binaryHash: null } });
    const cre = view.layers.find((l) => l.key === "CRE_WORKFLOW_SIMULATION") as SimulationLayerView;
    expect(() => assertNoUnrunPass({ ...cre, status: "PASS" }, "test")).toThrow(/NOT_RUN_REPORTED_AS_PASS/);
  });
});

/* ══════════════════════════ §P28.15 connect CRE ══════════════════════════ */

const connection = (over: Record<string, unknown> = {}) => CreConnectionInfoSchema.parse({
  connected: true, organizationId: "org_test", organizationName: "ContextLock", userEmail: null,
  deployAccess: false, registries: ["private"], cliVersion: "1.32.0",
  credentialLocation: "local user CRE directory", ...over,
});

describe("CONNECT-001 the flow shows what crosses each boundary", () => {
  it("CONNECT-001 an authenticated account connects in three steps and none carries a credential", () => {
    const flow = connectFlow(true);
    expect(flow.steps).toHaveLength(3);
    for (const s of flow.steps) {
      expect(s.carries.length).toBeGreaterThan(10);
      expect(s.carries.toLowerCase()).not.toMatch(/password|otp|session token/);
    }
  });

  it("CONNECT-001b an unauthenticated account gains the two steps that happen elsewhere", () => {
    const flow = connectFlow(false);
    expect(flow.steps).toHaveLength(5);
    const login = flow.steps.find((s) => s.label === "cre login");
    expect(login).toBeDefined();
    // The CLI's browser login, on the user's machine. ContextLock is not in the exchange.
    expect(login?.detail).toMatch(/ContextLock is not in this exchange/);
  });

  it("CONNECT-001c the never-requested list is rendered data, not a claim in prose", () => {
    const flow = connectFlow(true);
    expect(flow.neverRequested).toContain("CRE session token");
    expect(flow.neverRequested).toContain("cre.yaml");
    expect(flow.credentialLocation).toBe("local user CRE directory");
  });

  it("CONNECT-001d only bridge operations that exist are named", () => {
    const flow = connectFlow(true);
    const ops = flow.steps.map((s) => s.bridgeOperation).filter((o): o is string => o !== null);
    expect(ops.length).toBeGreaterThan(0);
    const protocol = readFileSync(`${repoRoot()}packages/bridge/src/protocol.ts`, "utf8");
    for (const op of ops) expect(protocol, op).toContain(`"${op}"`);
  });
});

describe("CONNECT-002 a credential intake form is refused", () => {
  /*
   * One fixture per guard: each case below differs from a valid field list in exactly one way, so a
   * pass cannot come from a different check firing.
   */
  it.each([
    ["password"],
    ["otp"],
    ["sessionToken"],
    ["creYaml"],
    ["apiKey"],
    ["seedPhrase"],
  ])("CONNECT-002 a form field named %s is refused", (field) => {
    expect(() => assertNotCredentialIntake([field], "connect form")).toThrow(/SESSION/);
  });

  it("CONNECT-002g a legitimate field list passes", () => {
    expect(() => assertNotCredentialIntake(["organizationId", "registry"], "connect form")).not.toThrow();
  });
});

describe("CONNECT-003 the account panel distinguishes unknown from no", () => {
  it("CONNECT-003 deploy access absent reads NOT ENABLED with a complete-state note", () => {
    const view = creAccountView(connection());
    expect(view.deployAccess).toBe("NOT ENABLED");
    expect(view.note).toMatch(/optional and requires Chainlink CRE Deploy Access/);
    expect(view.simulation).toBe("AVAILABLE");
  });

  it("CONNECT-003b an unread deploy-access field reads UNKNOWN, not NOT ENABLED", () => {
    // An unread field and a read field that said no are different facts.
    expect(creAccountView(connection({ deployAccess: null })).deployAccess).toBe("UNKNOWN");
  });

  it("CONNECT-003c deploy access present drops the note", () => {
    const view = creAccountView(connection({ deployAccess: true }));
    expect(view.deployAccess).toBe("ENABLED");
    expect(view.note).toBeNull();
  });
});

/* ══════════════════════════ §P28.24 promotion parity ══════════════════════════ */

const outcome = (verdict: ParityOutcome["verdict"], reasonCode: string, riskClass: string): ParityOutcome =>
  ({ verdict, reasonCode, riskClass, publicOutput: reasonCode });

const simulatorSide = (): Record<string, ParityOutcome> =>
  Object.fromEntries(PARITY_FIXTURES.map((f) => [f.id, outcome(f.expectedVerdict, f.expectedReason, f.expectedRisk)]));

describe("PARITY-001 the five P26 fixtures", () => {
  it("PARITY-001 all five are present and each names its expected verdict", () => {
    expect(PARITY_FIXTURES.map((f) => f.id)).toEqual([
      "ALLOW_POLICY_MATCH", "ESCALATE_AMOUNT", "DENY_AMOUNT_TOO_HIGH", "ESCALATE_RISK", "DENY_SLIPPAGE",
    ]);
  });

  it("PARITY-001b timestamps and internal metadata are excluded by name", () => {
    // §P28.24 — semantic decision parity, not a byte comparison.
    expect(PARITY_COMPARED_FIELDS).toEqual(["verdict", "reasonCode", "riskClass", "publicOutput"]);
    expect(PARITY_IGNORED_FIELDS).toContain("providerTimestamp");
    expect(PARITY_IGNORED_FIELDS).toContain("donId");
    for (const f of PARITY_IGNORED_FIELDS) expect(PARITY_COMPARED_FIELDS).not.toContain(f);
  });
});

describe("PARITY-002 a fixture that ran on one side is not agreement", () => {
  it("PARITY-002 an empty deployed side reports NOT RUN per fixture, never a match", () => {
    /*
     * The failure this prevents is the whole reason the gate exists: with BLK-V2-CRE-DEPLOY open,
     * the deployed column is empty, and a parity screen that showed five green rows would certify
     * a workflow that was never invoked.
     */
    const result = parityRun(simulatorSide(), {});
    expect(result.matched).toBe(0);
    expect(result.semanticParity).toBe(false);
    for (const row of result.rows) {
      expect(row.notRun).toBe("DEPLOYED");
      expect(row.match).toBe(false);
    }
  });

  it("PARITY-002b an identical deployed side is full semantic parity", () => {
    const result = parityRun(simulatorSide(), simulatorSide());
    expect(result.semanticParity).toBe(true);
    expect(result.matched).toBe(result.total);
    expect(() => assertParityBeforeAuthoritative(result, "promotion")).not.toThrow();
  });

  it("PARITY-002c a differing verdict names the field and both values", () => {
    const deployed = { ...simulatorSide(), DENY_AMOUNT_TOO_HIGH: outcome("ALLOW", "ALLOW_POLICY_MATCH", "LOW") };
    const result = parityRun(simulatorSide(), deployed);
    const row = result.rows.find((r) => r.fixture === "DENY_AMOUNT_TOO_HIGH");
    expect(row?.match).toBe(false);
    expect(row?.differences.join(" ")).toMatch(/verdict.*DENY.*ALLOW/);
    expect(row?.differences.join(" ")).toMatch(/reasonCode/);
  });

  it("PARITY-002d every difference is reported, not only the first", () => {
    const deployed = { ...simulatorSide(), ESCALATE_RISK: outcome("ALLOW", "ALLOW_POLICY_MATCH", "LOW") };
    const row = parityRun(simulatorSide(), deployed).rows.find((r) => r.fixture === "ESCALATE_RISK");
    expect(row?.differences.length).toBe(4);
  });

  it("PARITY-002e the gate refuses an incomplete run separately from a mismatched one", () => {
    expect(() => assertParityBeforeAuthoritative(parityRun(simulatorSide(), {}), "promotion")).toThrow(/PARITY_INCOMPLETE/);
    const deployed = { ...simulatorSide(), ESCALATE_AMOUNT: outcome("ALLOW", "ALLOW_POLICY_MATCH", "LOW") };
    expect(() => assertParityBeforeAuthoritative(parityRun(simulatorSide(), deployed), "promotion")).toThrow(ParityError);
    expect(() => assertParityBeforeAuthoritative(parityRun(simulatorSide(), deployed), "promotion")).toThrow(/PARITY_MISMATCH/);
  });

  it("PARITY-002f a differing timestamp is not a differing decision", () => {
    // Not comparable through `parityRun` at all: the field is absent from the compared set.
    const withMeta = Object.fromEntries(
      Object.entries(simulatorSide()).map(([k, v]) => [k, { ...v, providerTimestamp: 12345 } as ParityOutcome]),
    );
    expect(parityRun(simulatorSide(), withMeta).semanticParity).toBe(true);
  });
});

/* ══════════════════════════ §P28.28 testnet assets ══════════════════════════ */

describe("TOKEN-001 test assets carry no value and are never auto-requested", () => {
  it("TOKEN-001 every requirement states NONE and false, structurally", () => {
    const rows = tokenRequirements({ executionChainId: 11155111, spendsAssets: ["WETH", "USDC"], needsNativeGas: true });
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.realWorldValue).toBe("NONE");
      expect(r.automaticallyRequested).toBe(false);
    }
  });

  it("TOKEN-001b no row carries a price, a dollar figure or a value field", () => {
    /*
     * §P28.28's rule, checked against the serialized row rather than the type: the failure mode is
     * someone adding `usdValue` later, and a type assertion would not see it in a JSON response.
     */
    const blob = JSON.stringify(tokenRequirements({ executionChainId: 11155111, spendsAssets: ["USDC"], needsNativeGas: true }));
    expect(blob).not.toMatch(/usdValue|usdEquivalent|dollarValue|marketValue|"price"/i);
    expect(blob).not.toMatch(/\$\d/);
  });

  it("TOKEN-001c the native asset is not duplicated by a spend of the same symbol", () => {
    const rows = tokenRequirements({ executionChainId: 11155111, spendsAssets: ["ETH", "eth", "USDC"], needsNativeGas: true });
    expect(rows.filter((r) => r.symbol.toUpperCase() === "ETH")).toHaveLength(1);
  });

  it("TOKEN-001d the accompanying note says the assets are worth nothing", () => {
    expect(TESTNET_ASSET_NOTE).toMatch(/worth nothing/);
    expect(TESTNET_ASSET_NOTE).toMatch(/No figure on this screen is denominated in money/i);
  });

  it("TOKEN-001e the source tells the user to request it themselves", () => {
    for (const r of tokenRequirements({ executionChainId: 11155111, spendsAssets: ["USDC"], needsNativeGas: true })) {
      expect(r.source).toMatch(/yourself/i);
    }
  });
});

/* ══════════════════════════ §P28.30 ready to activate ══════════════════════════ */

const activationInput = (over: Record<string, unknown> = {}) => ({
  contractsVerified: true, runtimeHealthy: true, creSimulatorHealthy: true,
  realityDataHealthy: true, policyEnabled: false, executionChainId: 11155111, ...over,
} as Parameters<typeof activationReadiness>[0]);

describe("ACT-001 the screen before financial authority", () => {
  it("ACT-001 six rows, ending with the policy and the mainnet boundary", () => {
    const r = activationReadiness(activationInput());
    expect(r.rows.map((x) => x.label)).toEqual([
      "Contracts", "Runtime", "CRE", "Reality data", "Policy", "Mainnet execution",
    ]);
    expect(r.canActivate).toBe(true);
    expect(r.buttonLabel).toBe("ACTIVATE TESTNET AGENT");
  });

  it("ACT-001b a DISABLED policy is READY — the inversion is the point", () => {
    const r = activationReadiness(activationInput());
    const policy = r.rows.find((x) => x.label === "Policy");
    expect(policy?.value).toBe("DISABLED");
    expect(policy?.status).toBe("READY");
    expect(policy?.detail).toMatch(/holds no financial authority/);
  });

  it("ACT-001c arriving with the policy already enabled blocks activation", () => {
    /*
     * Activation enables the policy last. If it is already on, something else did it, and that is
     * a reason to stop rather than a head start.
     */
    const r = activationReadiness(activationInput({ policyEnabled: true }));
    const policy = r.rows.find((x) => x.label === "Policy");
    expect(policy?.status).toBe("NOT_READY");
    expect(policy?.detail).toMatch(/find out what before continuing/);
    expect(r.canActivate).toBe(false);
  });

  it("ACT-001d the mainnet row is a statement, not a gate that could pass", () => {
    const row = activationReadiness(activationInput()).rows.find((x) => x.label === "Mainnet execution");
    expect(row?.value).toBe("IMPOSSIBLE");
    expect(row?.status).toBe("STATEMENT");
  });

  it("ACT-001e a production execution chain blocks activation loudly", () => {
    const r = activationReadiness(activationInput({ executionChainId: 1 }));
    const row = r.rows.find((x) => x.label === "Mainnet execution");
    expect(row?.value).toBe("POSSIBLE — STOP");
    expect(r.canActivate).toBe(false);
    expect(r.blockedBy).toContain("Mainnet execution");
  });

  it.each([
    ["contractsVerified", "Contracts"],
    ["runtimeHealthy", "Runtime"],
    ["creSimulatorHealthy", "CRE"],
    ["realityDataHealthy", "Reality data"],
  ])("ACT-002 %s failing blocks activation on its own", (field, label) => {
    // One fixture per guard: exactly one field differs from the passing input.
    const r = activationReadiness(activationInput({ [field]: false }));
    expect(r.canActivate).toBe(false);
    expect(r.blockedBy).toEqual([label]);
  });

  it("ACT-003 the consequence is stated, and it is not 'are you sure'", () => {
    const r = activationReadiness(activationInput());
    expect(r.consequence).toMatch(/enables the ContextLock policy on chain/);
    expect(r.consequence).not.toMatch(/are you sure/i);
  });
});

/* ══════════════════════════ §P28.40–43 shadow, fork, shocks ══════════════════════════ */

const realSnapshot = () =>
  MarketSnapshotSchema.parse(JSON.parse(readFileSync(`${repoRoot()}reports/phase-27/evidence/p27-market-snapshot.json`, "utf8")));

const p27demo = () =>
  JSON.parse(readFileSync(`${repoRoot()}reports/phase-27/evidence/p27-demo.json`, "utf8")) as {
    shadowDecision: unknown; forkBlock: string; forkBlockHash: string; anvilVersion: string; swapHash: string; usdcOut: number;
  };

const realFork = () => {
  const demo = p27demo();
  const decision = ShadowDecisionSchema.parse(demo.shadowDecision);
  return {
    decision,
    fork: ForkDescriptorSchema.parse({
      forkId: decision.environmentId, sourceChainId: 1, chainId: 31337,
      forkBlock: demo.forkBlock, forkBlockHash: demo.forkBlockHash,
      sourceProviderId: "mainnet-read-only-rpc", anvilVersion: demo.anvilVersion,
      endpoint: "http://127.0.0.1:8749", createdAtMs: decision.decidedAtMs,
      expiresAtMs: decision.decidedAtMs + 1_800_000, state: "DESTROYED",
    }),
    tx: ForkTransactionSchema.parse({
      hash: demo.swapHash, forkId: decision.environmentId, chainId: 31337, forkedFrom: 1,
      forkBlock: demo.forkBlock, blockNumber: String(Number(demo.forkBlock) + 3),
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      to: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      status: "success", gasUsed: "145593", label: LOCAL_FORK_TX_LABEL, impersonated: false,
    }),
    usdcOut: demo.usdcOut,
  };
};

describe("SHADOWUX-001 a shadow run cannot be read as a mainnet trade", () => {
  it("SHADOWUX-001 the watched chain carries READ ONLY and the execution is named separately", () => {
    const { decision, fork } = realFork();
    const view = shadowRunView({ decision, watchingChainId: 1, fork });
    expect(view.watching.roleLabel).toBe("ETHEREUM MAINNET — READ ONLY");
    expect(view.actualExecution.environment).toBe("LOCAL_FORK");
    expect(view.actualExecution.label).toMatch(/LOCAL MAINNET FORK at block 25948255/);
  });

  it("SHADOWUX-001b the public mainnet transaction row exists and has one possible value", () => {
    const { decision, fork } = realFork();
    expect(shadowRunView({ decision, watchingChainId: 1, fork }).publicMainnetTransaction).toBe("NONE");
  });

  it("SHADOWUX-001c watching a chain that is not a read-only source is refused", () => {
    const { decision, fork } = realFork();
    expect(() => shadowRunView({ decision, watchingChainId: 11155111, fork })).toThrow(ShadowUxError);
  });

  it("SHADOWUX-001d the proposed action is semantic — no calldata, no address, no chain id", () => {
    const { decision, fork } = realFork();
    const blob = JSON.stringify(shadowRunView({ decision, watchingChainId: 1, fork }).proposedAction);
    expect(blob).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(blob).not.toMatch(/calldata|"data"|"to"/i);
  });
});

describe("SHADOWUX-002 a fork transaction never gets an explorer", () => {
  it("SHADOWUX-002 the detail carries NONE and an explanation of why", () => {
    const { fork, tx, usdcOut } = realFork();
    const detail = forkActionDetail({ fork, tx, protocol: "Uniswap V3", input: "1 WETH", output: `${usdcOut} USDC` });
    expect(detail.publicExplorer).toBe("NONE");
    expect(detail.transaction).toBe(LOCAL_FORK_TX_LABEL);
    expect(detail.explorerNote).toMatch(/does not exist/);
  });

  it("SHADOWUX-002b the resolver is asked, so teaching it about 31337 would fail here", () => {
    /*
     * Deliberately not a hard-coded NONE with an assertion beside it. If someone later adds chain
     * 31337 to `explorerUrlFor`, this throws instead of quietly rendering a link to a page that
     * says the transaction was not found — which reads as "not indexed yet".
     */
    const { fork, tx } = realFork();
    const sepoliaish = { ...tx, chainId: 11155111 as unknown as 31337 };
    expect(() => forkActionDetail({ fork, tx: sepoliaish, protocol: "Uniswap V3", input: "1 WETH", output: "x" }))
      .toThrow(/GIVEN_PUBLIC_EXPLORER_URL/);
  });

  it("SHADOWUX-002c the recorded run's real numbers survive into the panel", () => {
    const { fork, tx, usdcOut } = realFork();
    const detail = forkActionDetail({ fork, tx, protocol: "Uniswap V3", input: "1 WETH", output: `${usdcOut} USDC` });
    expect(detail.sourceBlock).toBe("25948255");
    expect(detail.output).toBe("2426.996777 USDC");
    expect(detail.gasUsed).toBe("145593");
  });
});

describe("SHOCK-001 presets reflect what the snapshot can answer", () => {
  it("SHOCK-001 six presets exist and each is labelled synthetic", () => {
    expect(SHOCK_PRESETS).toHaveLength(6);
    for (const p of shockPresets(realSnapshot())) {
      expect(p.label).toBe("SYNTHETIC OVERLAY");
      expect(p.trustClass).toBe("USER_UNTRUSTED");
    }
  });

  it("SHOCK-001b a preset needing a metric the snapshot lacks is unavailable with the reason", () => {
    /*
     * The real P27 snapshot carries a price, an Aave rate and a base fee — and no liquidity or
     * volatility. Offering "Flash crash" anyway would be a button that always errors.
     */
    const views = shockPresets(realSnapshot());
    const flash = views.find((p) => p.overlayId === "flash-crash-20");
    expect(flash?.applicable).toBe(false);
    expect(flash?.unavailableReason).toMatch(/market:volatilityBps/);
    expect(views.filter((p) => p.applicable).map((p) => p.overlayId)).toEqual(["eth-minus-10", "eth-minus-30", "stale-oracle-120s"]);
  });

  it("SHOCK-001c an unknown preset id resolves to null rather than a default", () => {
    expect(presetById("no-such-overlay")).toBeNull();
    expect(presetById("eth-minus-30")).not.toBeNull();
  });
});

describe("SHOCK-002 a shock never rewrites the base", () => {
  it("SHOCK-002 the base hash is identical before and after", () => {
    const base = realSnapshot();
    const before = base.snapshotHash;
    const result = runShock(base, presetById("eth-minus-30")!, { snapshotId: "scn-test" });
    expect(base.snapshotHash).toBe(before);
    expect(result.snapshot.snapshotHash).not.toBe(before);
    expect(result.baseSnapshotHash).toBe(before);
  });

  it("SHOCK-002c a base whose content no longer matches its own hash is refused", () => {
    /*
     * The check with teeth. `assertBaseUnchanged` compares the declared hash before and after and
     * is redundant — `applyOverlay` copies — so this drives the recomputation instead: a snapshot
     * whose observations were edited in place still *claims* its original hash, and shocking it
     * would compare against a record nobody sealed.
     */
    const tampered = structuredClone(realSnapshot());
    const price = tampered.observations.find((o) => o.metric === "weth/usd:price");
    price!.value = "100000000000";
    expect(() => runShock(tampered, presetById("eth-minus-10")!, { snapshotId: "scn-tampered" })).toThrow(/hash/i);
  });

  it("SHOCK-002b the shocked observation is marked synthetic and points at its origin", () => {
    const result = runShock(realSnapshot(), presetById("eth-minus-30")!, { snapshotId: "scn-test" });
    const price = result.snapshot.observations.find((o) => o.metric === "weth/usd:price");
    expect(price?.trustClass).toBe("USER_UNTRUSTED");
    expect(price?.derivedFrom).toMatch(/SIMULATED_FROM_VERIFIED_ORACLE/);
  });
});

describe("SHOCK-003 the comparison is produced by the real policy engine", () => {
  const common = () => {
    const bp = canonicalGuardian();
    return {
      policy: policyFromBlueprint(bp),
      priceMetric: "weth/usd:price",
      amount: 500_000_000_000_000_000n,
      amountDecimals: 18,
      amountLabel: "repay 0.5 WETH of Aave debt",
      actionKind: bp.actions[0]?.kind ?? "AAVE_REPAY",
      agentIdentityHash: keccak256(toHex(bp.identity.agentId)),
      target: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
      recipient: "0x93e0FCb0F71e83F3340264339BC5983C474635c5",
      nowMs: realSnapshot().observedAtMs,
      maxSnapshotAgeMs: 5_400_000,
    };
  };

  it("SHOCK-003 a price fall moves a fixed-size action across the autonomous limit", () => {
    /*
     * The result worth reading. 0.5 WETH at $2,438 is $1,219 and needs approval; the same 0.5 WETH
     * after a 30% fall is $853 and does not. Nothing about the policy changed — the money did.
     */
    const snapshot = realSnapshot();
    const base = decideOnSnapshot({ snapshot, ...common() });
    expect(base.verdict).toBe("ESCALATE");
    expect(base.reasonCode).toBe("ESCALATE_AMOUNT");

    const crashed = runShock(snapshot, presetById("eth-minus-30")!, { snapshotId: "scn-30" });
    const after = decideOnSnapshot({ snapshot: crashed.snapshot, ...common() });
    expect(after.verdict).toBe("ALLOW");
    expect(after.reasonCode).toBe("ALLOW_POLICY_MATCH");
  });

  it("SHOCK-003b a stale oracle is refused, and the refusal names staleness", () => {
    const snapshot = realSnapshot();
    const stale = runShock(snapshot, presetById("stale-oracle-120s")!, { snapshotId: "scn-stale" });
    const decision = decideOnSnapshot({ snapshot: stale.snapshot, ...common() });
    expect(decision.verdict).toBe("DENY");
    expect(decision.reasonCode).toBe("DENY_CONTEXT_STALE");
  });

  it("SHOCK-003c the basis names every context field that was neutralised", () => {
    /*
     * The honest half. A price snapshot carries no slippage, volatility, liquidity or health
     * factor, and filling them with plausible numbers would let an invented value decide.
     */
    const decision = decideOnSnapshot({ snapshot: realSnapshot(), ...common() });
    expect(decision.basis.neutralised).toHaveLength(4);
    for (const n of decision.basis.neutralised) expect(n).toMatch(/cannot|not observed/i);
    expect(decision.basis.fromSnapshot.join(" ")).toMatch(/weth\/usd:price/);
  });

  it("SHOCK-003d a snapshot with no price for the action is NO_VALID_CONTEXT, not a guess", () => {
    const snapshot = realSnapshot();
    const decision = decideOnSnapshot({ snapshot, ...common(), priceMetric: "no-such:metric" });
    expect(decision.reasonCode).toBe("NO_VALID_CONTEXT");
    expect(decision.layer).toBe("REALITY");
    expect(decision.valuedAt).toBeNull();
  });

  it("SHOCK-004 the compare table keeps the base first and marks every other row synthetic", () => {
    const snapshot = realSnapshot();
    const base = decideOnSnapshot({ snapshot, ...common() });
    const overlay = presetById("eth-minus-10")!;
    const result = runShock(snapshot, overlay, { snapshotId: "scn-10" });
    const rows = compareScenarios(
      { decision: base, snapshotHash: snapshot.snapshotHash },
      [{ overlay, result, decision: decideOnSnapshot({ snapshot: result.snapshot, ...common() }) }],
    );
    expect(rows[0]?.scenario).toBe("BASE");
    expect(rows[0]?.synthetic).toBe(false);
    expect(rows[1]?.synthetic).toBe(true);
    expect(rows[1]?.scenarioHash).toBe(result.scenarioHash);
    expect(() => assertSyntheticLabelled(rows, "test")).not.toThrow();
  });

  it("SHOCK-004b an unlabelled synthetic row is refused", () => {
    const snapshot = realSnapshot();
    const base = decideOnSnapshot({ snapshot, ...common() });
    const overlay = presetById("eth-minus-10")!;
    const result = runShock(snapshot, overlay, { snapshotId: "scn-10" });
    const rows = compareScenarios({ decision: base, snapshotHash: snapshot.snapshotHash }, [
      { overlay, result, decision: base },
    ]).map((r) => (r.scenario === "BASE" ? r : { ...r, synthetic: false }));
    expect(() => assertSyntheticLabelled(rows, "test")).toThrow(ScenarioLabError);
  });
});

/* ══════════════════════════ §P28.34 why did it act ══════════════════════════ */

const decisionInput = (over: Record<string, unknown> = {}) => ({
  correlationId: "demo-25948265",
  verdict: "ALLOW" as const,
  reasonCode: "ALLOW_POLICY_MATCH",
  amount: "1000 USDC",
  policyRef: "contextlock-lab-policy v1",
  marketSnapshotHash: "sha256:5b392cffacbac05207c09ccac81d169b8f022ed7c34597391448bd5a48437244",
  scenarioHash: null,
  verifiedPrice: { metric: "weth/usd:price", value: "$2,438.62", sourceId: "chainlink-feed-eth-usd-mainnet", trustClass: "VERIFIED_ORACLE" },
  executionChainId: 11155111,
  recipient: null,
  recipientPolicy: "self-only",
  creMode: "OFFICIAL CLI SIMULATION",
  ...over,
} as Parameters<typeof decisionDetail>[0]);

describe("DECISION-001 the answer comes from the record", () => {
  it("DECISION-001 every field names where its value came from", () => {
    const d = decisionDetail(decisionInput());
    expect(d.fields.length).toBeGreaterThan(4);
    for (const f of d.fields) expect(f.source.length, f.label).toBeGreaterThan(10);
  });

  it("DECISION-001b the plain reading is a lookup, and an unknown code renders as itself", () => {
    expect(decisionDetail(decisionInput()).reasonPlain).toBe(REASON_PLAIN["ALLOW_POLICY_MATCH"]);
    // Not a generated sentence. Being told the raw code beats being told a guess that is wrong.
    expect(decisionDetail(decisionInput({ reasonCode: "DENY_SOMETHING_NEW" })).reasonPlain).toBe("DENY_SOMETHING_NEW");
  });

  it("DECISION-001c the execution network is shown with its role", () => {
    const network = decisionDetail(decisionInput()).fields.find((f) => f.label === "Execution network");
    expect(network?.value).toMatch(/Ethereum Sepolia — TESTNET EXECUTION/);
  });

  it("DECISION-001d a scenario decision is marked synthetic", () => {
    const d = decisionDetail(decisionInput({ scenarioHash: "sha256:6d06bef29fb280208a7a0f32fb729820b1a9c72e95a9e15ccf7c5ed547230607" }));
    expect(d.synthetic).toBe(true);
    expect(d.fields.find((f) => f.label === "Scenario")?.value).toMatch(/SYNTHETIC OVERLAY/);
  });

  it("DECISION-001e a null field is omitted rather than rendered empty", () => {
    const d = decisionDetail(decisionInput({ amount: null, verifiedPrice: null }));
    expect(d.fields.map((f) => f.label)).not.toContain("Amount");
    expect(d.fields.map((f) => f.label)).not.toContain("Verified price");
  });
});

describe("DECISION-002 the private policy stays private", () => {
  it("DECISION-002 the withheld block names what is not shown and why", () => {
    const d = decisionDetail(decisionInput());
    expect(d.withheld).toHaveLength(1);
    expect(d.withheld[0]?.why).toMatch(/never sent to the agent/);
  });

  it("DECISION-002b no threshold, limit or parameter value appears anywhere in the view", () => {
    const blob = JSON.stringify(decisionDetail(decisionInput()));
    expect(blob).not.toMatch(/autoLimit|escalationLimit|maxSlippageBps|proprietaryRiskThreshold/);
    expect(() => assertDecisionPrivate(decisionDetail(decisionInput()), "test")).not.toThrow();
  });

  it("DECISION-002c a view that grew a thresholds field is refused", () => {
    const d = decisionDetail(decisionInput());
    const leaked = { ...d, thresholds: { autonomous: 100_000 } } as unknown as ReturnType<typeof decisionDetail>;
    expect(() => assertDecisionPrivate(leaked, "test")).toThrow(DecisionDetailError);
    expect(() => assertDecisionPrivate(leaked, "test")).toThrow(/EXPOSED_PRIVATE_POLICY/);
  });
});
