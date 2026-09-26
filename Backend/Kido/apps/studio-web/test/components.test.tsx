// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { LabStatusHeader } from "../src/views/LabStatus";
import { RealitySelector, NetworkBadges } from "../src/views/Reality";
import { CreStatusView } from "../src/views/CreStatus";
import { AttackLabView, AttackRunCard } from "../src/views/AttackLab";
import { SafetyReportPanel, PrivacyTable } from "../src/views/SafetyReport";
import { SimulationLayerCard, SimulationCenterView_ } from "../src/views/SimulationCenter";
import { ConnectFlowSteps, ParityTable, CreConnectPanel } from "../src/views/CreConnect";
import { ActivateView, TokenRequirementsTable } from "../src/views/Activate";
import { ShadowRunPanel, ForkActionPanel } from "../src/views/Shadow";
import { PresetList, ComparisonTable, MarketShockPanel } from "../src/views/MarketShock";
import { DecisionDetailPanel } from "../src/views/Decision";
import { SummaryView } from "../src/views/Summary";
import { runtimeNodeStates } from "../src/runtime-overlay";
import { DeployView } from "../src/views/Deploy";
import type {
  LabStateView, RealityView, CreView, AttackRun, AttackCatalogue, SafetyReportView, PublicSafetyView,
  DeployView as DeployData, PrivacyClaim,
  SimulationCenterView, SimulationLayerView, CreConnectView, ParityView,
  ActivationView, TokenRequirementsView, ShadowView, ScenarioView, DecisionDetailView, LabSummaryView,
} from "../src/lab-api";

afterEach(cleanup);

/**
 * Component tests.
 *
 * The product-quality gate asks for these, and the reason is specific: the LAB and PRODUCT suites
 * drive the functions, and a function that returns the right object proves nothing about a screen
 * that renders a different one.
 *
 * Every assertion below is about a claim a user reads. The recurring question is the same one the
 * PRODUCT suite asks of the backend — **can this screen say something the backend did not?**
 */

/* ═════════════════════════ the lifecycle header ═════════════════════════ */

const labState = (over: Partial<LabStateView> = {}): LabStateView => ({
  projectId: "proj-treasury-guardian",
  state: "READY_TO_ACTIVATE",
  because: "the deployment is verified and the ContextLock policy is disabled",
  hasFinancialAuthority: false,
  nextAction: "Activate the testnet agent",
  degradedDependencies: [],
  label: { headline: "READY TO ACTIVATE", detail: "Deployed and verified. The policy is DISABLED" },
  headlineClaim: "PRODUCTION-CHAIN EXECUTION: DISABLED",
  mode: {
    mode: "CONTEXTLOCK_TESTNET_LAB",
    execution: { networks: [{ chainId: 11155111, name: "Ethereum Sepolia", role: "TESTNET_EXECUTION" }], summary: "Approved testnets and local forks only" },
    mainnet: { access: "READ_ONLY", summary: "Mainnet is a data source: Ethereum Mainnet. It is never an execution network." },
    cre: { default: "SIMULATED_USER", summary: "The official Chainlink CRE CLI simulator, under your own login" },
    financialPolicy: { owner: "CONTEXTLOCK", summary: "Enforced by ContextLock" },
    runtime: { isolation: "CONTAINER", summary: "Isolated container" },
    monitoring: { owner: "CONTEXTLOCK_CONTROL_PLANE", summary: "Read fresh" },
    productionChainExecution: "DISABLED",
  },
  computedFrom: { policy: { enabled: false } },
  ...over,
});

describe("COMP-001 the lifecycle header", () => {
  it("COMP-001 renders the headline claim verbatim from the backend", () => {
    render(<LabStatusHeader view={labState()} />);
    expect(screen.getByText("PRODUCTION-CHAIN EXECUTION: DISABLED")).toBeTruthy();
    expect(screen.getByText("READY TO ACTIVATE")).toBeTruthy();
  });

  it("COMP-001b a PAUSED runtime shows the financial-authority badge", () => {
    /*
     * The single most important thing this header does. A paused container with an enabled policy
     * is one unpause away from acting, and a header that omitted the badge would teach the exact
     * misunderstanding the control panel exists to prevent.
     */
    render(<LabStatusHeader view={labState({
      state: "PAUSED",
      hasFinancialAuthority: true,
      label: { headline: "RUNTIME PAUSED", detail: "The container is stopped. The ContextLock policy is still ENABLED — pausing a runtime is an operational stop, not a financial one" },
    })} />);
    expect(screen.getByText(/FINANCIAL AUTHORITY: ACTIVE/)).toBeTruthy();
    expect(screen.getByText(/operational stop, not a financial one/)).toBeTruthy();
  });

  it("COMP-001c a state without authority shows no badge", () => {
    render(<LabStatusHeader view={labState()} />);
    expect(screen.queryByText(/FINANCIAL AUTHORITY: ACTIVE/)).toBeNull();
  });

  it("COMP-001d the reason the state was reached is shown, not just the state", () => {
    render(<LabStatusHeader view={labState()} />);
    expect(screen.getByText(/the deployment is verified and the ContextLock policy is disabled/)).toBeTruthy();
  });

  it("COMP-001e degraded dependencies are named", () => {
    render(<LabStatusHeader view={labState({ state: "DEGRADED", hasFinancialAuthority: true, degradedDependencies: ["chainlink-feed-eth-usd-mainnet"] })} />);
    expect(screen.getByText(/chainlink-feed-eth-usd-mainnet/)).toBeTruthy();
  });
});

/* ═════════════════════════ reality ═════════════════════════ */

const realityView = (): RealityView => ({
  modes: [
    { mode: "LIVE_MAINNET_MIRROR", label: "Live Mainnet Mirror", availability: "AVAILABLE", reason: "Indexed history from The Graph is not included", blocker: "BLK-V2-GRAPH-KEY", remedy: "Configure a The Graph API key", effect: "nothing was substituted for it" },
    { mode: "HISTORICAL_REPLAY", label: "Historical Replay", availability: "LIMITED", reason: "The configured endpoint is RECENT_STATE_ONLY", blocker: "BLK-V2-ARCHIVE-RPC", remedy: "Configure an archive RPC", effect: "not run and labelled replay" },
    { mode: "LOCAL_MAINNET_FORK", label: "Local Mainnet Fork", availability: "AVAILABLE", reason: null, blocker: null, remedy: null, effect: null },
    { mode: "SYNTHETIC", label: "Synthetic", availability: "AVAILABLE", reason: null, blocker: null, remedy: null, effect: "carry USER_UNTRUSTED" },
  ],
  sources: [{ sourceId: "thegraph", displayName: "The Graph", status: "UNAVAILABLE", reason: "API authentication required", effect: "Historical indexed context not included", securityImpact: "No fallback substitution occurred", blocker: "BLK-V2-GRAPH-KEY", tone: "AMBER" }],
  networks: {
    marketSource: { chainId: 1, name: "Ethereum Mainnet", role: "READ_ONLY_SOURCE", roleLabel: "MAINNET DATA — READ ONLY", purpose: "MARKET_SOURCE" },
    executionTarget: { chainId: 11155111, name: "Ethereum Sepolia", role: "TESTNET_EXECUTION", roleLabel: "TESTNET", purpose: "EXECUTION_TARGET" },
  },
});

describe("COMP-002 the reality selector", () => {
  it("COMP-002 renders every mode, including the unavailable ones", async () => {
    render(<RealitySelector fetchReality={async () => realityView()} />);
    await waitFor(() => expect(screen.getByText("Live Mainnet Mirror")).toBeTruthy());
    // §P28.8: do not hide disabled options.
    expect(screen.getByText("Historical Replay")).toBeTruthy();
    expect(screen.getByText("Local Mainnet Fork")).toBeTruthy();
    expect(screen.getByText("Synthetic")).toBeTruthy();
  });

  it("COMP-002b an unavailable mode shows its reason, blocker and remedy", async () => {
    render(<RealitySelector fetchReality={async () => realityView()} />);
    await waitFor(() => expect(screen.getByText(/RECENT_STATE_ONLY/)).toBeTruthy());
    expect(screen.getByText("BLK-V2-ARCHIVE-RPC")).toBeTruthy();
    expect(screen.getByText(/Configure an archive RPC/)).toBeTruthy();
  });

  it("COMP-002c The Graph's card states that nothing replaced it", async () => {
    render(<RealitySelector fetchReality={async () => realityView()} />);
    await waitFor(() => expect(screen.getByText("No fallback substitution occurred")).toBeTruthy());
  });

  it("COMP-002d the two networks render as separate labelled blocks, never one list", () => {
    render(<NetworkBadges networks={realityView().networks} />);
    expect(screen.getByText("MARKET SOURCE")).toBeTruthy();
    expect(screen.getByText("EXECUTION TARGET")).toBeTruthy();
    // The role travels with each. §P28.9 forbids a network shown without one.
    expect(screen.getByText("MAINNET DATA — READ ONLY")).toBeTruthy();
    expect(screen.getByText("TESTNET")).toBeTruthy();
  });

  it("COMP-002e a blocked source is not rendered as selectable", async () => {
    const blocked = { ...realityView(), modes: realityView().modes.map((m) => m.mode === "LOCAL_MAINNET_FORK" ? { ...m, availability: "BLOCKED" as const, reason: "Anvil is not available" } : m) };
    const { container } = render(<RealitySelector fetchReality={async () => blocked} />);
    await waitFor(() => expect(screen.getByText(/Anvil is not available/)).toBeTruthy());
    const disabled = container.querySelectorAll('input[type="radio"]:disabled');
    expect(disabled.length).toBe(1);
  });
});

/* ═════════════════════════ CRE ═════════════════════════ */

const creView = (over: Partial<CreView["status"]> = {}): CreView => ({
  status: {
    mode: "OFFICIAL CLI SIMULATION", executionMode: "SIMULATED_USER", account: "Local user session",
    organizationId: "org_test", workflowBinary: "800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0",
    productionLimits: "ENABLED", donDeployment: "NO", hardwareTee: "NO", teeAttestation: "NO",
    deployAccess: "NOT_ENABLED", registries: ["private"], ...over,
  },
  connection: { connected: true, organizationId: "org_test", organizationName: "ContextLock", deployAccess: false, registries: ["private"], cliVersion: "1.32.0", credentialLocation: "local user CRE directory" },
  promotion: { available: false, reason: "CRE_PROMOTION_REQUIRES_DEPLOY_ACCESS", message: "Your agent is running with the official CRE simulator. Real DON deployment is optional and requires Chainlink CRE Deploy Access.", blocker: "BLK-V2-CRE-DEPLOY" },
});

describe("COMP-003 the CRE card", () => {
  it("COMP-003 renders six fields, never a single tick", async () => {
    render(<CreStatusView projectId="p" fetchCre={async () => creView()} />);
    await waitFor(() => expect(screen.getByText("OFFICIAL CLI SIMULATION")).toBeTruthy());
    for (const label of ["Mode", "Account", "Workflow binary", "Production limits", "DON deployment", "Hardware TEE"]) {
      expect(screen.getByText(label), label).toBeTruthy();
    }
    // §P28.14: no collapsed badge.
    expect(screen.queryByText(/CRE Connected ✓/)).toBeNull();
  });

  it("COMP-003b absent deploy access renders as a complete state, not an error", async () => {
    render(<CreStatusView projectId="p" fetchCre={async () => creView()} />);
    await waitFor(() => expect(screen.getByText(/optional and requires Chainlink CRE Deploy Access/)).toBeTruthy());
    expect(screen.queryByText(/error/i)).toBeNull();
    const promote = screen.getByRole("button", { name: /Promote to Chainlink CRE/ });
    expect(promote.hasAttribute("disabled")).toBe(true);
  });

  it("COMP-003c it states where the credential stayed", async () => {
    render(<CreStatusView projectId="p" fetchCre={async () => creView()} />);
    await waitFor(() => expect(screen.getByText(/never receives it/)).toBeTruthy());
  });

  it("COMP-003d promotion becomes available only with deploy access", async () => {
    const withAccess: CreView = { ...creView(), promotion: { available: true, reason: "DEPLOY_ACCESS_ENABLED", message: "Real DON deployment is available for this account.", blocker: null } };
    render(<CreStatusView projectId="p" fetchCre={async () => withAccess} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Promote to Chainlink CRE/ })).toBeTruthy());
    expect(screen.getByRole("button", { name: /Promote to Chainlink CRE/ }).hasAttribute("disabled")).toBe(false);
  });
});

/* ═════════════════════════ the Attack Lab ═════════════════════════ */

const run = (over: Partial<AttackRun> = {}): AttackRun => ({
  scenario: "AMOUNT_MUTATION", title: "Amount mutation", result: "DENIED",
  stoppedBy: "CONTEXTLOCK_POLICY", reasonCode: "DENY_AMOUNT_TOO_HIGH", stoppedWhereExpected: true,
  diffs: [{ field: "amount", original: "$500", mutated: "$10,000" }],
  path: [
    { layer: "CRE_SIMULATION", outcome: "PASS", reasonCode: null, detail: null },
    { layer: "CONTEXTLOCK_POLICY", outcome: "DENY", reasonCode: "DENY_AMOUNT_TOO_HIGH", detail: null },
    { layer: "CAPABILITY_ISSUER", outcome: "NOT_REACHED", reasonCode: null, detail: null },
    { layer: "EXECUTOR", outcome: "NOT_REACHED", reasonCode: null, detail: null },
  ],
  capabilityIssued: false, transactionSubmitted: false, additionalDefenses: [],
  ...over,
});

const catalogue = (): AttackCatalogue => ({
  applicable: [{ scenario: "AMOUNT_MUTATION", title: "Amount mutation", description: "The agent declares one amount and encodes another.", mutatedField: "amount", expectedStoppedBy: "CONTEXTLOCK_POLICY", expectedReasonCode: "DENY_AMOUNT_TOO_HIGH" }],
  notApplicable: [{ scenario: "CCIP_WRONG_DESTINATION", title: "Wrong cross-chain destination", requires: "HAS_CCIP" }],
});

describe("COMP-004 the Attack Lab", () => {
  it("COMP-004 names the layer that stopped the attack, not just DENIED", () => {
    render(<AttackRunCard run={run()} />);
    expect(screen.getByText("DENIED")).toBeTruthy();
    // The point of the whole screen.
    expect(screen.getByText("Stopped by")).toBeTruthy();
    // Twice: once as the summary answer, once on the row of the path where it happened.
    expect(screen.getAllByText("CONTEXTLOCK POLICY").length).toBe(2);
    expect(screen.getAllByText("DENY_AMOUNT_TOO_HIGH").length).toBe(2);
  });

  it("COMP-004b layers after the denial render NOT REACHED, never PASS", () => {
    /*
     * §P28.37. A layer that was never consulted did not approve anything, and rendering it green
     * would credit a control that did no work.
     */
    render(<AttackRunCard run={run()} />);
    expect(screen.getAllByText("NOT REACHED").length).toBe(2);
  });

  it("COMP-004c the exact changed field is shown, original beside mutated", () => {
    render(<AttackRunCard run={run()} />);
    expect(screen.getByText("amount")).toBeTruthy();
    expect(screen.getByText("$500")).toBeTruthy();
    expect(screen.getByText("$10,000")).toBeTruthy();
  });

  it("COMP-004d an attack nothing stopped is shown as loudly as a denial", () => {
    render(<AttackRunCard run={run({ result: "ALLOWED", stoppedBy: null, reasonCode: null })} />);
    expect(screen.getByText(/No layer refused this/)).toBeTruthy();
  });

  it("COMP-004e a denial from an unexpected layer is called out", () => {
    render(<AttackRunCard run={run({ stoppedBy: "EXECUTOR", stoppedWhereExpected: false })} />);
    expect(screen.getByText(/different layer than expected/)).toBeTruthy();
  });

  it("COMP-004f only defences that were exercised appear", () => {
    render(<AttackRunCard run={run({ additionalDefenses: [{ layer: "RPC_TRANSPORT", reasonCode: "RPC_WRITE_METHOD_PROHIBITED" }] })} />);
    expect(screen.getByText(/exercised in this run/)).toBeTruthy();
    expect(screen.getByText("RPC_WRITE_METHOD_PROHIBITED")).toBeTruthy();
  });

  it("COMP-004g inapplicable scenarios are listed with the reason, not hidden", async () => {
    render(<AttackLabView projectId="p" fetchCatalogue={async () => catalogue()} runAttack={async () => run()} />);
    await waitFor(() => expect(screen.getByText("Amount mutation")).toBeTruthy());
    expect(screen.getByText(/Not applicable to this agent/)).toBeTruthy();
    expect(screen.getByText(/requires has ccip/i)).toBeTruthy();
  });

  it("COMP-004h running an attack renders the result the backend returned", async () => {
    render(<AttackLabView projectId="p" fetchCatalogue={async () => catalogue()} runAttack={async () => run()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Run attack/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Run attack/ }));
    await waitFor(() => expect(screen.getAllByText("DENY_AMOUNT_TOO_HIGH").length).toBeGreaterThan(0));
  });
});

/* ═════════════════════════ the safety report ═════════════════════════ */

const privacy = (): PrivacyClaim[] => [
  { claim: "Agent cannot access CRE credential", answer: "VERIFIED", evidence: "RUN-014: the container refuses to start carrying credentials", blocker: null },
  { claim: "Private policy absent from agent prompt", answer: "VERIFIED", evidence: "P4: the policy lives in the CRE workflow", blocker: null },
  { claim: "CRE official simulation", answer: "VERIFIED", evidence: "CRELAB-003: the official CLI ran", blocker: null },
  { claim: "CRE DON execution", answer: "NO", evidence: null, blocker: "BLK-V2-CRE-DEPLOY" },
  { claim: "CRE hardware TEE", answer: "NO", evidence: null, blocker: "BLK-V2-CRE-DEPLOY" },
  { claim: "Physical Ledger", answer: "NO", evidence: null, blocker: "BLK-002" },
];

describe("COMP-005 the safety report", () => {
  it("COMP-005 renders six privacy claims on six lines", () => {
    /*
     * §P28.51: not bundled into a single "Private ✓". Six claims, six rows, six answers — three of
     * which are NO, and a table that collapsed them would be claiming the three it has not got.
     */
    const { container } = render(<PrivacyTable privacy={privacy()} />);
    expect(container.querySelectorAll("tbody tr").length).toBe(6);
    expect(screen.getAllByText("VERIFIED").length).toBe(3);
    expect(screen.getAllByText("NO").length).toBe(3);
    for (const claim of privacy()) expect(screen.getByText(claim.claim), claim.claim).toBeTruthy();
  });

  it("COMP-005b a NO claim shows its blocker rather than an empty cell", () => {
    render(<PrivacyTable privacy={privacy()} />);
    expect(screen.getAllByText("BLK-V2-CRE-DEPLOY").length).toBe(2);
    expect(screen.getByText("BLK-002")).toBeTruthy();
  });
});

/* ═════════════════════════ deploy ═════════════════════════ */

const deployData = (over: Partial<DeployData["readiness"]> = {}): { readiness: DeployData["readiness"]; phases: DeployData["phases"] } => ({
  readiness: {
    gates: [
      { label: "Architecture", status: "PASS", detail: "The Blueprint compiled", blocker: null },
      { label: "CRE simulation", status: "FAIL", detail: "not run", blocker: null },
    ],
    canDeploy: false, blockedBy: ["CRE simulation"],
    executionNetwork: { chainId: 11155111, name: "Ethereum Sepolia", role: "TESTNET_EXECUTION" },
    mainnetWrites: "PROHIBITED", policyInitialState: "DISABLED", ...over,
  },
  phases: [
    { key: "PREPARING_RELEASE", label: "Preparing release" },
    { key: "CONFIGURING_POLICY_DISABLED", label: "Configuring policy DISABLED" },
    { key: "READY_TO_ACTIVATE", label: "READY TO ACTIVATE" },
  ],
});

describe("COMP-006 the deploy screen", () => {
  it("COMP-006 shows every gate, and the CTA is disabled while one fails", async () => {
    render(<DeployView projectId="p" fetchReadiness={async () => deployData()} fetchCost={async () => null} onDeploy={async () => undefined} />);
    await waitFor(() => expect(screen.getByText("Architecture")).toBeTruthy());
    expect(screen.getByText("CRE simulation")).toBeTruthy();
    expect(screen.getByRole("button", { name: /DEPLOY TO TESTNET LAB/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Blocked by: CRE simulation/)).toBeTruthy();
  });

  it("COMP-006b the policy-disabled phase is visible, not summarised away", async () => {
    /*
     * §P28.29. The most reassuring step in a deployment is the policy being configured OFF, and it
     * is invisible if the phases collapse into a spinner.
     */
    render(<DeployView projectId="p" fetchReadiness={async () => deployData()} fetchCost={async () => null} onDeploy={async () => undefined} />);
    await waitFor(() => expect(screen.getByText("Configuring policy DISABLED")).toBeTruthy());
    expect(screen.getByText(/activation is a separate decision/)).toBeTruthy();
  });

  it("COMP-006c the boundary is stated before the button", async () => {
    render(<DeployView projectId="p" fetchReadiness={async () => deployData()} fetchCost={async () => null} onDeploy={async () => undefined} />);
    await waitFor(() => expect(screen.getByText("PROHIBITED")).toBeTruthy());
    expect(screen.getByText(/WILL START DISABLED/)).toBeTruthy();
  });

  it("COMP-006d a passing gate set enables the CTA", async () => {
    const ok = deployData({ gates: [{ label: "Architecture", status: "PASS", detail: "ok", blocker: null }], canDeploy: true, blockedBy: [] });
    render(<DeployView projectId="p" fetchReadiness={async () => ok} fetchCost={async () => null} onDeploy={async () => undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /DEPLOY TO TESTNET LAB/ })).toBeTruthy());
    expect(screen.getByRole("button", { name: /DEPLOY TO TESTNET LAB/ }).hasAttribute("disabled")).toBe(false);
  });
});

/* ═════════════════════════ loading, error and blocked states ═════════════════════════ */

describe("COMP-007 loading, error and degraded states", () => {
  it("COMP-007 a pending fetch renders a loading state rather than an empty screen", () => {
    render(<RealitySelector fetchReality={() => new Promise(() => undefined)} />);
    expect(screen.getByText(/Reading capabilities/)).toBeTruthy();
  });

  it("COMP-007b a failed fetch renders the error rather than a blank panel", async () => {
    render(<CreStatusView projectId="p" fetchCre={async () => { throw new Error("upstream unavailable"); }} />);
    await waitFor(() => expect(screen.getByText("upstream unavailable")).toBeTruthy());
  });

  it("COMP-007c an attack that fails to run surfaces the failure", async () => {
    render(<AttackLabView projectId="p" fetchCatalogue={async () => catalogue()} runAttack={async () => { throw new Error("scenario does not apply"); }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Run attack/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Run attack/ }));
    await waitFor(() => expect(screen.getByText("scenario does not apply")).toBeTruthy());
  });
});

/* ═════════════════════════ keyboard access to critical controls ═════════════════════════ */

describe("COMP-008 critical controls are reachable by keyboard", () => {
  it("COMP-008 the deploy CTA and attack triggers are real buttons", async () => {
    /*
     * Not a styled div. A control that governs a financial action has to be focusable and operable
     * from the keyboard, and `getByRole("button")` is the assertion that it is one.
     */
    render(<DeployView projectId="p" fetchReadiness={async () => deployData()} fetchCost={async () => null} onDeploy={async () => undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /DEPLOY TO TESTNET LAB/ })).toBeTruthy());
  });

  it("COMP-008b a disabled control announces itself as disabled", async () => {
    render(<CreStatusView projectId="p" fetchCre={async () => creView()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Promote to Chainlink CRE/ })).toBeTruthy());
    const btn = screen.getByRole("button", { name: /Promote to Chainlink CRE/ });
    expect(btn.getAttribute("aria-disabled")).toBe("true");
  });

  it("COMP-008c the reality modes are radio inputs with labels", async () => {
    render(<RealitySelector fetchReality={async () => realityView()} />);
    await waitFor(() => expect(screen.getAllByRole("radio").length).toBe(4));
  });
});

/* ═════════════════════════ the simulation center ═════════════════════════ */

const layer = (over: Partial<SimulationLayerView> = {}): SimulationLayerView => ({
  key: "CRE_WORKFLOW_SIMULATION",
  title: "CRE workflow simulation",
  engine: "Official Chainlink CRE CLI",
  status: "PASS",
  passed: null,
  total: null,
  detail: "binary 800d0d561132… under production limits ENABLED",
  proves: "The real workflow binary evaluates the policy the way it will when deployed.",
  doesNotProve: "That it ran on a DON, in a TEE, or against live mainnet liquidity.",
  blocker: null,
  optional: false,
  ...over,
});

const simCenter = (): SimulationCenterView => ({
  layers: [
    layer({ key: "SECURITY_SIMULATION", title: "Security simulation", engine: "ContextLock deterministic tests", passed: 31, total: 31, detail: "31 / 31 scenarios", proves: "The agent refuses what the permissions forbid.", doesNotProve: "Nothing about real market conditions — these are fixtures." }),
    layer(),
    layer({ key: "REALITY_TEST", title: "Reality test", engine: "Reality Engine — LIVE_MIRROR", detail: "sealed snapshot at mainnet block 25948178", proves: "Evaluated against real sealed mainnet state.", doesNotProve: "That any transaction happened — mainnet is read-only here." }),
    layer({ key: "FORK_EXECUTION", title: "Fork execution", engine: "Anvil — pinned mainnet fork", status: "BLOCKED", detail: "No local fork provider is available on this machine", proves: "The action executes against real mainnet protocol state.", doesNotProve: "That anything happened on a public chain.", blocker: "no anvil", optional: true }),
  ],
  requiredPassed: true,
  outstanding: [],
});

describe("COMP-009 the simulation center", () => {
  it("COMP-009 every layer renders what it does not prove, beside what it does", () => {
    render(<SimulationCenterView_ projectId="p" fetchCenter={async () => simCenter()} />);
    return waitFor(() => {
      expect(screen.getAllByText("Proves").length).toBe(4);
      expect(screen.getAllByText("Does not prove").length).toBe(4);
    });
  });

  it("COMP-009b the four engines are named separately, never one label four times", async () => {
    render(<SimulationCenterView_ projectId="p" fetchCenter={async () => simCenter()} />);
    await waitFor(() => expect(screen.getByText("ContextLock deterministic tests")).toBeTruthy());
    expect(screen.getByText("Official Chainlink CRE CLI")).toBeTruthy();
    expect(screen.getByText("Reality Engine — LIVE_MIRROR")).toBeTruthy();
    expect(screen.getByText("Anvil — pinned mainnet fork")).toBeTruthy();
  });

  it("COMP-009c a NOT_RUN layer says NOT RUN, never FAIL", () => {
    render(<SimulationLayerCard layer={layer({ status: "NOT_RUN", detail: "The official CRE simulator has not been run" })} />);
    expect(screen.getByText("NOT RUN")).toBeTruthy();
    expect(screen.queryByText("FAIL")).toBeNull();
  });

  it("COMP-009d a blocked optional layer shows its blocker and says it is not a gate", () => {
    render(<SimulationLayerCard layer={layer({ status: "BLOCKED", blocker: "no anvil", optional: true })} />);
    expect(screen.getByText("no anvil")).toBeTruthy();
    expect(screen.getByText(/never a gate/)).toBeTruthy();
  });

  it("COMP-009e the count renders only where there is one", () => {
    const { container } = render(<SimulationLayerCard layer={layer({ passed: 31, total: 31 })} />);
    expect(container.textContent).toMatch(/31 \/ 31/);
    cleanup();
    const bare = render(<SimulationLayerCard layer={layer()} />);
    expect(bare.container.querySelector(".sim-count")).toBeNull();
  });
});

/* ═════════════════════════ connect CRE ═════════════════════════ */

const connectView = (over: Partial<CreConnectView["account"]> = {}): CreConnectView => ({
  flow: {
    steps: [
      { kind: "CONTEXTLOCK", label: "ContextLock asks for CRE status", detail: "One named request.", carries: "a request id and the operation name", bridgeOperation: "cre.status" },
      { kind: "LOCAL_BRIDGE", label: "The Local Bridge runs it on your machine", detail: "Closed operation list.", carries: "nothing inbound", bridgeOperation: "cre.status" },
      { kind: "CRE_CLI", label: "cre whoami", detail: "Answers from the local session file.", carries: "status fields, never the session", bridgeOperation: null },
    ],
    neverRequested: ["email password", "OTP", "CRE session token", "cre.yaml"],
    credentialLocation: "local user CRE directory",
    claim: "ContextLock learns whether you have a CRE account. It never learns how to be you.",
  },
  account: {
    connected: "YES", organization: "ContextLock", deployAccess: "NOT ENABLED",
    registries: ["private"], simulation: "AVAILABLE", cliVersion: "1.32.0",
    credentialLocation: "local user CRE directory",
    note: "Your agent is running with the official CRE simulator. Real DON deployment is optional and requires Chainlink CRE Deploy Access.",
    ...over,
  },
});

const parityView = (): ParityView => ({
  result: {
    rows: [
      { fixture: "ALLOW_POLICY_MATCH", description: "Inside the autonomous limit", simulator: { verdict: "ALLOW", reasonCode: "ALLOW_POLICY_MATCH", riskClass: "LOW", publicOutput: "ALLOW_POLICY_MATCH" }, deployed: null, differences: [], match: false, notRun: "DEPLOYED" },
      { fixture: "DENY_AMOUNT_TOO_HIGH", description: "Above the hard cap", simulator: { verdict: "DENY", reasonCode: "DENY_AMOUNT_TOO_HIGH", riskClass: "HIGH", publicOutput: "DENY_AMOUNT_TOO_HIGH" }, deployed: null, differences: [], match: false, notRun: "DEPLOYED" },
    ],
    matched: 0, total: 2, semanticParity: false,
    comparedFields: ["verdict", "reasonCode", "riskClass", "publicOutput"],
    ignoredFields: ["providerTimestamp", "donId"],
  },
  deployedAvailable: false,
  blocker: "BLK-V2-CRE-DEPLOY",
  note: "Deploy Access is not enabled for this account, so the deployed column has no results.",
});

describe("COMP-010 connecting a CRE account", () => {
  it("COMP-010 the panel renders no credential input of any kind", async () => {
    /*
     * Not a disabled field — none at all. The flow has no step at which ContextLock could accept a
     * credential, and a rendered input would contradict the claim the screen is making.
     */
    const { container } = render(<CreConnectPanel projectId="p" fetchConnect={async () => connectView()} fetchParity={async () => parityView()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Connect My Chainlink CRE/ })).toBeTruthy());
    expect(container.querySelectorAll("input, textarea").length).toBe(0);
  });

  it("COMP-010b the flow lists what crosses at each step, and what is never asked for", () => {
    render(<ConnectFlowSteps flow={connectView().flow} />);
    expect(screen.getAllByText(/carries/).length).toBe(3);
    expect(screen.getByText("ContextLock never asks you for")).toBeTruthy();
    expect(screen.getByText("CRE session token")).toBeTruthy();
  });

  it("COMP-010c the bridge operation is named where there is one", () => {
    render(<ConnectFlowSteps flow={connectView().flow} />);
    expect(screen.getAllByText("cre.status").length).toBe(2);
  });

  it("COMP-010d absent deploy access renders the note with no error styling", async () => {
    const { container } = render(<CreConnectPanel projectId="p" fetchConnect={async () => connectView()} fetchParity={async () => parityView()} />);
    await waitFor(() => expect(screen.getByText("NOT ENABLED")).toBeTruthy());
    expect(screen.getByText(/optional and requires Chainlink CRE Deploy Access/)).toBeTruthy();
    expect(container.querySelector(".error")).toBeNull();
  });

  it("COMP-010e an unread deploy-access field renders UNKNOWN, not NOT ENABLED", async () => {
    render(<CreConnectPanel projectId="p" fetchConnect={async () => connectView({ deployAccess: "UNKNOWN" })} fetchParity={async () => parityView()} />);
    await waitFor(() => expect(screen.getByText("UNKNOWN")).toBeTruthy());
    expect(screen.queryByText("NOT ENABLED")).toBeNull();
  });
});

describe("COMP-011 the parity table", () => {
  it("COMP-011 a fixture with no deployed result reads NOT RUN, never MATCH", () => {
    render(<ParityTable view={parityView()} />);
    expect(screen.getAllByText(/NOT RUN — deployed side/).length).toBe(2);
    expect(screen.queryByText("MATCH")).toBeNull();
  });

  it("COMP-011b the verdict line says parity is not established", () => {
    render(<ParityTable view={parityView()} />);
    expect(screen.getByText(/Parity not established: 0 of 2/)).toBeTruthy();
    expect(screen.getByText("BLK-V2-CRE-DEPLOY")).toBeTruthy();
  });

  it("COMP-011c the ignored fields are stated, so a timestamp difference is not read as disagreement", () => {
    render(<ParityTable view={parityView()} />);
    expect(screen.getByText(/Not compared: providerTimestamp, donId/)).toBeTruthy();
  });
});

/* ═════════════════════════ ready to activate ═════════════════════════ */

const activation = (over: Partial<ActivationView["readiness"]> = {}): ActivationView => ({
  readiness: {
    rows: [
      { label: "Contracts", value: "VERIFIED", status: "READY", detail: "Source verified against the deployed bytecode" },
      { label: "Runtime", value: "HEALTHY", status: "READY", detail: "The agent container is running" },
      { label: "CRE", value: "SIMULATOR HEALTHY", status: "READY", detail: "The simulator responds" },
      { label: "Reality data", value: "HEALTHY", status: "READY", detail: "Verified market data is fresh" },
      { label: "Policy", value: "DISABLED", status: "READY", detail: "The agent holds no financial authority. Activation is what grants it." },
      { label: "Mainnet execution", value: "IMPOSSIBLE", status: "STATEMENT", detail: "No production chain is write-capable." },
    ],
    canActivate: true,
    blockedBy: [],
    consequence: "This enables the ContextLock policy on chain, last, after every check above is re-run.",
    buttonLabel: "ACTIVATE TESTNET AGENT",
    ...over,
  },
  state: "READY_TO_ACTIVATE",
});

const tokens = (): TokenRequirementsView => ({
  requirements: [
    { symbol: "ETH", purpose: "Gas for deployment and every action", network: "Ethereum Sepolia — TESTNET EXECUTION", source: "A public Sepolia faucet. Request it yourself.", realWorldValue: "NONE", automaticallyRequested: false },
    { symbol: "USDC", purpose: "The strategy spends USDC", network: "Ethereum Sepolia — TESTNET EXECUTION", source: "A test USDC faucet. Request it yourself.", realWorldValue: "NONE", automaticallyRequested: false },
  ],
  note: "These are test assets on a test network. They are worth nothing.",
});

describe("COMP-012 the ready-to-activate screen", () => {
  const props = (over: Partial<ActivationView["readiness"]> = {}) => ({
    projectId: "p",
    fetchActivation: async () => activation(over),
    fetchTokens: async () => tokens(),
    onActivate: async () => undefined,
  });

  it("COMP-012 the policy row shows DISABLED as ready, not as a problem", async () => {
    render(<ActivateView {...props()} />);
    await waitFor(() => expect(screen.getByText("DISABLED")).toBeTruthy());
    expect(screen.getByText(/holds no financial authority/)).toBeTruthy();
  });

  it("COMP-012b the mainnet boundary is stated on the screen that grants authority", async () => {
    render(<ActivateView {...props()} />);
    await waitFor(() => expect(screen.getByText("IMPOSSIBLE")).toBeTruthy());
  });

  it("COMP-012c the consequence is shown before the control, and it is not 'are you sure'", async () => {
    render(<ActivateView {...props()} />);
    await waitFor(() => expect(screen.getByText(/enables the ContextLock policy on chain/)).toBeTruthy());
    expect(screen.queryByText(/are you sure/i)).toBeNull();
  });

  it("COMP-012d activation takes a confirmation step that restates what happens", async () => {
    render(<ActivateView {...props()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "ACTIVATE TESTNET AGENT" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "ACTIVATE TESTNET AGENT" }));
    await waitFor(() => expect(screen.getByText(/read back from the chain/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Yes — ACTIVATE TESTNET AGENT/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("COMP-012e a blocked readiness disables the control and names what blocks it", async () => {
    render(<ActivateView {...props({ canActivate: false, blockedBy: ["Runtime"] })} />);
    await waitFor(() => expect(screen.getByText(/Blocked by: Runtime/)).toBeTruthy());
    const btn = screen.getByRole("button", { name: "ACTIVATE TESTNET AGENT" });
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
  });

  it("COMP-012f a failing activation surfaces the reason rather than appearing to succeed", async () => {
    render(<ActivateView {...props()} onActivate={async () => { throw new Error("Activation runs through the control plane."); }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "ACTIVATE TESTNET AGENT" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "ACTIVATE TESTNET AGENT" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Yes — ACTIVATE/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Yes — ACTIVATE/ }));
    await waitFor(() => expect(screen.getByText(/Activation runs through the control plane/)).toBeTruthy());
  });
});

describe("COMP-013 testnet assets", () => {
  it("COMP-013 every row states NONE and no row shows a price", () => {
    const { container } = render(<TokenRequirementsTable view={tokens()} />);
    expect(screen.getAllByText("NONE").length).toBe(2);
    expect(container.textContent).not.toMatch(/\$\d/);
  });

  it("COMP-013b the note saying they are worthless is rendered, not implied", () => {
    render(<TokenRequirementsTable view={tokens()} />);
    expect(screen.getByText(/worth nothing/)).toBeTruthy();
  });

  it("COMP-013c there is no faucet button — the user is told to request it", () => {
    render(<TokenRequirementsTable view={tokens()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getAllByText(/Request it yourself/).length).toBe(2);
  });
});

/* ═════════════════════════ shadow and fork ═════════════════════════ */

const shadow = (): ShadowView => ({
  run: {
    watching: { chainId: 1, name: "Ethereum Mainnet", role: "READ_ONLY_SOURCE", roleLabel: "ETHEREUM MAINNET — READ ONLY" },
    decision: "ALLOW",
    reasonCode: "ALLOW_POLICY_MATCH",
    proposedAction: { kind: "SUPPLY", asset: "usdc", amount: "1000000000", protocol: "aave-v3" },
    actualExecution: { environment: "LOCAL_FORK", label: "LOCAL MAINNET FORK at block 25948255 — SIMULATION EXECUTION", chainId: 31337 },
    publicMainnetTransaction: "NONE",
    marketSnapshotHash: "sha256:5b392cffacbac05207c09ccac81d169b8f022ed7c34597391448bd5a48437244",
    scenarioHash: null,
  },
  fork: {
    heading: "LOCAL MAINNET FORK",
    sourceChain: "Ethereum Mainnet — state copied, read only",
    sourceBlock: "25948255",
    sourceBlockHash: "0x7eadead02128edaaa09211f74f0572ee8eebac0b578fa31e4df86b0c7548563e",
    protocol: "Uniswap V3",
    input: "1 WETH",
    output: "2426.996777 USDC",
    transactionHash: "0xad82425e025dc006244a487f052c75b6567694c29506c1a4e87692134e4c0828",
    transaction: "LOCAL FORK TRANSACTION",
    publicExplorer: "NONE",
    explorerNote: "This transaction exists only in the local fork. There is no public explorer for it.",
    status: "success",
    gasUsed: "145593",
    impersonated: false,
  },
});

describe("COMP-014 shadow mode", () => {
  it("COMP-014 the watched chain and the execution target are separate blocks", () => {
    render(<ShadowRunPanel run={shadow().run} />);
    expect(screen.getByText("ETHEREUM MAINNET — READ ONLY")).toBeTruthy();
    expect(screen.getByText(/LOCAL MAINNET FORK at block 25948255/)).toBeTruthy();
  });

  it("COMP-014b the public mainnet transaction is a row reading NONE, not an omission", () => {
    render(<ShadowRunPanel run={shadow().run} />);
    expect(screen.getByText("Public mainnet transaction")).toBeTruthy();
    expect(screen.getByText("NONE")).toBeTruthy();
  });

  it("COMP-014c no rendered address, calldata or chain id appears in the proposed action", () => {
    const { container } = render(<ShadowRunPanel run={shadow().run} />);
    const proposed = container.querySelector(".shadow-proposed");
    expect(proposed?.textContent).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});

describe("COMP-015 the fork action detail", () => {
  it("COMP-015 the transaction is labelled and the explorer says NONE", () => {
    render(<ForkActionPanel fork={shadow().fork} />);
    expect(screen.getByText("LOCAL FORK TRANSACTION")).toBeTruthy();
    expect(screen.getByText("Public explorer")).toBeTruthy();
    expect(screen.getByText("NONE")).toBeTruthy();
  });

  it("COMP-015b nothing on the panel is a link to an explorer", () => {
    /*
     * §P28.41 / §P27.30. A local hash pasted into Etherscan produces "unable to locate this
     * TxnHash", which reads as "not indexed yet" rather than "this never happened".
     */
    const { container } = render(<ForkActionPanel fork={shadow().fork} />);
    expect(container.querySelectorAll("a").length).toBe(0);
    expect(container.textContent).not.toMatch(/etherscan|basescan|blockscout/i);
  });

  it("COMP-015c the real recorded numbers are shown", () => {
    render(<ForkActionPanel fork={shadow().fork} />);
    expect(screen.getByText("25948255")).toBeTruthy();
    expect(screen.getByText("2426.996777 USDC")).toBeTruthy();
  });
});

/* ═════════════════════════ market shocks ═════════════════════════ */

const scenarios = (): ScenarioView => ({
  presets: [
    { overlayId: "eth-minus-10", name: "ETH −10%", description: "A 10% drawdown.", mutates: ["weth/usd:price"], applicable: true, unavailableReason: null, label: "SYNTHETIC OVERLAY", trustClass: "USER_UNTRUSTED" },
    { overlayId: "flash-crash-20", name: "Flash crash", description: "A 20% drawdown with volatility spiking.", mutates: ["weth/usd:price", "market:volatilityBps"], applicable: false, unavailableReason: "this snapshot carries no market:volatilityBps observation", label: "SYNTHETIC OVERLAY", trustClass: "USER_UNTRUSTED" },
  ],
  rows: [
    { label: "Base market", scenario: "BASE", synthetic: false, verdict: "ESCALATE", reasonCode: "ESCALATE_AMOUNT", snapshotHash: "sha256:aa", scenarioHash: null, changedFromBase: null },
    { label: "ETH −30%", scenario: "eth-minus-30", synthetic: true, verdict: "ALLOW", reasonCode: "ALLOW_POLICY_MATCH", snapshotHash: "sha256:bb", scenarioHash: "sha256:cc", changedFromBase: "ESCALATE → ALLOW (ALLOW_POLICY_MATCH)" },
  ],
  action: "repay 0.5 WETH of Aave debt",
  basis: {
    fromSnapshot: ["weth/usd:price (verified oracle observation)"],
    neutralised: ["slippageBps = 0 — not observed here; 0 cannot trip the bound"],
    action: "repay 0.5 WETH of Aave debt",
  },
  baseValuedAt: "$1,219.31",
  anchorBlock: "25948178",
});

describe("COMP-016 market shocks", () => {
  it("COMP-016 an unavailable preset is listed with its reason, not hidden", () => {
    render(<PresetList presets={scenarios().presets} />);
    expect(screen.getByText("Flash crash")).toBeTruthy();
    expect(screen.getByText(/no market:volatilityBps observation/)).toBeTruthy();
  });

  it("COMP-016b every preset carries the SYNTHETIC OVERLAY badge", () => {
    render(<PresetList presets={scenarios().presets} />);
    expect(screen.getAllByText("SYNTHETIC OVERLAY").length).toBe(2);
  });

  it("COMP-016c the base row is first and is the only unlabelled one", () => {
    const { container } = render(<ComparisonTable rows={scenarios().rows} action="repay 0.5 WETH" />);
    const rows = container.querySelectorAll("tbody tr");
    expect(rows[0]?.className).toBe("row-base");
    expect(rows[1]?.className).toBe("row-synthetic");
    expect(screen.getAllByText("SYNTHETIC OVERLAY").length).toBe(1);
  });

  it("COMP-016d the change from the base is shown, not just the verdict", () => {
    render(<ComparisonTable rows={scenarios().rows} action="repay 0.5 WETH" />);
    expect(screen.getByText("ESCALATE → ALLOW (ALLOW_POLICY_MATCH)")).toBeTruthy();
  });

  it("COMP-016e the neutralised context fields are reachable from the screen", async () => {
    render(<MarketShockPanel projectId="p" fetchScenarios={async () => scenarios()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /How were these decided/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /How were these decided/ }));
    await waitFor(() => expect(screen.getByText(/cannot trip the bound/)).toBeTruthy());
    expect(screen.getByText("Set so they cannot influence the verdict")).toBeTruthy();
  });
});

/* ═════════════════════════ why did it act ═════════════════════════ */

const decision = (over: Partial<DecisionDetailView> = {}): DecisionDetailView => ({
  correlationId: "demo-25948265",
  verdict: "ALLOW",
  reasonCode: "ALLOW_POLICY_MATCH",
  reasonPlain: "The action matched the policy and stayed inside the autonomous limit.",
  fields: [
    { label: "Amount", value: "1000 USDC", source: "the action record" },
    { label: "Policy", value: "contextlock-lab-policy v1", source: "the policy binding" },
    { label: "Verified price", value: "weth/usd:price $2,438.62", source: "chainlink-feed-eth-usd-mainnet (VERIFIED_ORACLE)" },
    { label: "Execution network", value: "Ethereum Sepolia — TESTNET EXECUTION", source: "the capability itself" },
  ],
  withheld: [{ what: "The confidential policy's parameter values", why: "They live in the CRE workflow and are never sent to the agent." }],
  synthetic: false,
  ...over,
});

describe("COMP-017 the decision detail", () => {
  it("COMP-017 every field shows where its value came from", () => {
    const { container } = render(<DecisionDetailPanel detail={decision()} />);
    expect(container.querySelectorAll(".decision-source").length).toBe(4);
  });

  it("COMP-017b the reason code and its plain reading are both shown", () => {
    render(<DecisionDetailPanel detail={decision()} />);
    expect(screen.getByText("ALLOW_POLICY_MATCH")).toBeTruthy();
    expect(screen.getByText(/stayed inside the autonomous limit/)).toBeTruthy();
  });

  it("COMP-017c what is withheld is named rather than omitted", () => {
    render(<DecisionDetailPanel detail={decision()} />);
    expect(screen.getByText("Not shown")).toBeTruthy();
    expect(screen.getByText(/The confidential policy's parameter values/)).toBeTruthy();
  });

  it("COMP-017d no threshold or limit value appears anywhere on the panel", () => {
    const { container } = render(<DecisionDetailPanel detail={decision()} />);
    expect(container.textContent).not.toMatch(/autoLimit|escalationLimit|proprietaryRiskThreshold/);
  });

  it("COMP-017e a scenario decision is labelled synthetic", () => {
    render(<DecisionDetailPanel detail={decision({ synthetic: true })} />);
    expect(screen.getByText(/SYNTHETIC OVERLAY/)).toBeTruthy();
  });
});

/* ═════════════════════════ the runtime overlay ═════════════════════════ */

const graph = () => ({
  nodes: [
    { id: "agent", kind: "Agent", label: "Agent", position: { x: 0, y: 0 }, state: "PENDING" as const, detail: [] },
    { id: "policy", kind: "PrivatePolicy", label: "ContextLock policy", position: { x: 0, y: 1 }, state: "PENDING" as const, detail: [] },
    { id: "cre", kind: "CreWorkflow", label: "CRE workflow", position: { x: 0, y: 2 }, state: "PENDING" as const, detail: [] },
    { id: "executor", kind: "Executor", label: "Executor", position: { x: 0, y: 3 }, state: "PENDING" as const, detail: [] },
  ],
  edges: [],
});

const overview = (over: Record<string, unknown> = {}) => ({
  deploymentId: "dep-1",
  badge: "LIVE" as const,
  notLiveBecause: [],
  currentRevision: "rev-1",
  panels: {
    policy: { observedAtMs: 1, ageMs: 1000, isCurrent: true, source: "sepolia rpc", state: "READ", reason: null, value: { enabled: true, bindingVersion: "1", policyAdmin: "0x0" } },
    runtime: { state: "HEALTHY", reasons: [], note: "" },
    cre: { state: "NOT_DEPLOYED", headline: "simulator", blockedBy: null },
    identity: null,
    adapters: [],
  },
  drift: [],
  alerts: { open: 0, critical: 0, rows: [] },
  note: "",
  ...over,
});

describe("COMP-018 runtime status overlays the canonical graph", () => {
  it("COMP-018 an enabled policy reads RUNNING and a healthy runtime reads RUNNING", () => {
    // @ts-expect-error the fixtures are structurally the shape the overlay reads
    const states = runtimeNodeStates(graph(), overview());
    expect(states["policy"]).toBe("RUNNING");
    expect(states["agent"]).toBe("RUNNING");
  });

  it("COMP-018b a disabled policy is READY — deployed and inert, which is not a problem", () => {
    const o = overview();
    o.panels.policy.value.enabled = false;
    // @ts-expect-error see above
    expect(runtimeNodeStates(graph(), o)["policy"]).toBe("READY");
  });

  it("COMP-018c a stale reading is WARN whatever it said", () => {
    /*
     * The rule the Overview panels already follow: colour comes from `isCurrent`, not from the
     * value. A dashboard that painted a system it stopped watching as fine is the failure.
     */
    const o = overview();
    o.panels.policy.isCurrent = false;
    // @ts-expect-error see above
    expect(runtimeNodeStates(graph(), o)["policy"]).toBe("WARN");
  });

  it("COMP-018d a node nothing observed is PENDING, never PASS", () => {
    // @ts-expect-error see above
    const states = runtimeNodeStates(graph(), overview());
    expect(states["executor"]).toBe("PENDING");
    expect(Object.values(states)).not.toContain("PASS");
  });

  it("COMP-018e critical drift on a node turns it FAIL", () => {
    const o = overview({ drift: [{ kind: "POLICY", severity: "CRITICAL", subject: "policy", expected: "a", observed: "b", detail: "" }] });
    // @ts-expect-error see above
    expect(runtimeNodeStates(graph(), o)["policy"]).toBe("FAIL");
  });

  it("COMP-018f no graph and no overview produces no states rather than a green default", () => {
    expect(runtimeNodeStates(null, null)).toEqual({});
  });
});

/* ═════════════════════════ the build summary and security review ═════════════════════════ */

const summary = (over: Partial<LabSummaryView["summary"]> = {}): LabSummaryView => ({
  summary: {
    name: "guardian.test.eth",
    goal: "Prevent liquidation of the Aave position and keep the treasury balanced",
    execution: { chainId: 11155111, name: "Ethereum Sepolia", role: "TESTNET_EXECUTION", label: "TESTNET" },
    realityData: { chainId: 1, name: "Ethereum Mainnet", role: "READ_ONLY_SOURCE", label: "MAINNET DATA — READ ONLY" },
    protocols: ["Aave-style lending pool", "Uniswap V3"],
    verifiedMarketData: ["reference-oracle@1.0.0"],
    cre: { required: true, mode: "Official Simulator" },
    autonomous: "≤ $1,000",
    humanApproval: "$1,000 – $5,000",
    hardDeny: "> $5,000",
    forbidden: ["withdraw collateral", "borrow", "send funds outside the treasury"],
    blueprintRevision: 1,
    perActionLimits: [{
      action: "Rebalance treasury via Uniswap",
      autonomous: "≤ $500",
      humanApproval: "$500 – $2,000",
      hardDeny: "> $2,000",
      sourceQuote: "For treasury rebalancing: up to $500 automatic. $500 to $2,000 requires approval. above $2,000 deny.",
    }],
    ...over,
  },
  capabilities: [
    { kind: "CAN", statement: "repay outstanding debt", derivedFrom: "permissions.allowed[p-repay]" },
    { kind: "CAN", statement: "read the Aave position", derivedFrom: "dataRequirements[aave-position]" },
    { kind: "CANNOT", statement: "withdraw collateral", derivedFrom: "permissions.denied[d-withdraw]" },
    { kind: "CANNOT", statement: "execute on Ethereum Mainnet", derivedFrom: "the product boundary" },
  ],
  unestablishedBoundaries: [],
  networks: realityView().networks,
});

describe("COMP-019 the build summary", () => {
  it("COMP-019 both limit rows render, and the per-action row is marked as the tighter one", async () => {
    /*
     * §P28.57's two halves on one screen. A summary showing only the global pair would describe an
     * agent whose rebalancing cap is twice what its owner set.
     */
    render(<SummaryView projectId="p" fetchSummary={async () => summary()} />);
    await waitFor(() => expect(screen.getByText("≤ $1,000")).toBeTruthy());
    expect(screen.getByText("≤ $500")).toBeTruthy();
    expect(screen.getByText("> $2,000")).toBeTruthy();
    expect(screen.getByText(/tighter than the global limit/)).toBeTruthy();
  });

  it("COMP-019b the quote the per-action limit came from is shown", async () => {
    render(<SummaryView projectId="p" fetchSummary={async () => summary()} />);
    await waitFor(() => expect(screen.getByText(/up to \$500 automatic/)).toBeTruthy());
  });

  it("COMP-019c the two networks appear with their roles, never as one list", async () => {
    render(<SummaryView projectId="p" fetchSummary={async () => summary()} />);
    await waitFor(() => expect(screen.getByText("MARKET SOURCE")).toBeTruthy());
    expect(screen.getByText("EXECUTION TARGET")).toBeTruthy();
  });

  it("COMP-019d an unestablished boundary is shown as unestablished, never defaulted", async () => {
    render(<SummaryView projectId="p" fetchSummary={async () => ({ ...summary(), unestablishedBoundaries: ["no autonomous limit was established"] })} />);
    await waitFor(() => expect(screen.getByText("no autonomous limit was established")).toBeTruthy());
    expect(screen.getByText(/cannot be deployed with a financial boundary nobody set/)).toBeTruthy();
  });
});

describe("COMP-020 the security review", () => {
  it("COMP-020 CAN and CANNOT are separate lists, both rendered", async () => {
    render(<SummaryView projectId="p" fetchSummary={async () => summary()} />);
    await waitFor(() => expect(screen.getByText("What this agent can do")).toBeTruthy());
    expect(screen.getByText("What this agent cannot do")).toBeTruthy();
  });

  it("COMP-020b every line names the Blueprint field it was derived from", async () => {
    /*
     * §P28.6 — generated deterministically from permissions. A claim about what an agent cannot do
     * is worth exactly as much as the field it came from, and rendering the field is what lets a
     * reader check it rather than trust it.
     */
    const { container } = render(<SummaryView projectId="p" fetchSummary={async () => summary()} />);
    await waitFor(() => expect(container.querySelectorAll(".derived").length).toBe(4));
    expect(screen.getByText("permissions.denied[d-withdraw]")).toBeTruthy();
  });

  it("COMP-020c the mainnet prohibition appears as a CANNOT line", async () => {
    render(<SummaryView projectId="p" fetchSummary={async () => summary()} />);
    await waitFor(() => expect(screen.getByText("execute on Ethereum Mainnet")).toBeTruthy());
  });

  it("COMP-020d the screen says the model did not write this list", async () => {
    render(<SummaryView projectId="p" fetchSummary={async () => summary()} />);
    await waitFor(() => expect(screen.getByText(/it did not write this list/)).toBeTruthy());
  });
});

/* ═════════════════════════ absence is not an error ═════════════════════════ */

import { LabApiError } from "../src/lab-api";
import { PanelProblem } from "../src/views/Absent";

describe("COMP-021 a project that has nothing of a kind is not shown a fault", () => {
  it("COMP-021 a 404 renders the explanation, not a red error", () => {
    /*
     * Every Lab panel fetches something a project might not have. A project built in this browser
     * has no market snapshot, no shadow run and — until design finishes — no Blueprint. All three
     * are normal and all three arrive as 404. Five red boxes on a working screen teaches a reader
     * that red boxes on this product are noise.
     */
    const { container } = render(
      <PanelProblem error={new LabApiError("no blueprint", 404)} absent="This project has no compiled Blueprint yet." />,
    );
    expect(container.querySelector(".empty")).toBeTruthy();
    expect(container.querySelector(".error")).toBeNull();
    expect(screen.getByText(/no compiled Blueprint yet/)).toBeTruthy();
  });

  it("COMP-021b the underlying reason is still shown, quietly", () => {
    // Not hidden. A reader debugging this needs the API's own words.
    render(<PanelProblem error={new LabApiError("no blueprint", 404)} absent="Nothing yet." />);
    expect(screen.getByText(/no blueprint/)).toBeTruthy();
  });

  it("COMP-021c a 500 is still a red error", () => {
    const { container } = render(
      <PanelProblem error={new LabApiError("upstream exploded", 500)} absent="Nothing yet." />,
    );
    expect(container.querySelector(".error")).toBeTruthy();
    expect(container.querySelector(".empty")).toBeNull();
  });

  it("COMP-021d a plain Error — a transport failure with no status — is a red error", () => {
    const { container } = render(<PanelProblem error={new Error("Failed to fetch")} absent="Nothing yet." />);
    expect(container.querySelector(".error")).toBeTruthy();
  });

  it("COMP-021e the summary screen renders the absence rather than the raw API string", async () => {
    render(<SummaryView projectId="p" fetchSummary={async () => { throw new LabApiError("no blueprint", 404); }} />);
    await waitFor(() => expect(screen.getByText(/The design step produces one/)).toBeTruthy());
  });
});
