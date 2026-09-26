import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribe, type BuildView, type NodeState, type OrgView } from "./api";
import { ArchitectureView } from "./views/Architecture";
import { SimulationView_ } from "./views/Simulation";
import { CodeView } from "./views/Code";
import { OrganizationView } from "./views/Organization";
import { DeployedAgentView, type DeployedTab } from "./views/DeployedAgent";
import { controlApi, grantLocalOperator } from "./control-api";
import { forkApi, labApi } from "./lab-api";
import { ForkDeployPanel } from "./views/ForkDeploy";
import { DeployView } from "./views/Deploy";
import { RealitySelector } from "./views/Reality";
import { CreStatusView } from "./views/CreStatus";
import { LabStatusHeader, LabStateEvidence } from "./views/LabStatus";
import { SimulationCenterView_ } from "./views/SimulationCenter";
import { ActivateView } from "./views/Activate";
import { SummaryView } from "./views/Summary";
import { MarketShockPanel } from "./views/MarketShock";
import { ShadowPanel } from "./views/Shadow";
import type { LabStateView, RealityMode } from "./lab-api";

/**
 * The pre-deployment navigation, §P28.3.
 *
 * "deploy" joins the existing three so a user reaches the deploy gate from the same navigation they
 * designed in, rather than from a separate screen that has to re-establish which project it means.
 */
type Tab = "summary" | "architecture" | "simulation" | "code" | "deploy" | "activate";

/**
 * The canonical P28 demo project.
 *
 * Its lifecycle inputs, Blueprint, CRE status, snapshot and shadow run are all backed by committed
 * evidence a reader can check — `reports/phase-28/evidence/` and `reports/phase-27/evidence/`. It is
 * reachable at `?project=proj-treasury-guardian` and is the only project whose deployed-side state
 * is observable without a real deployment.
 */
const DEMO_PROJECT_ID = "proj-treasury-guardian";

/**
 * The deployed-agent navigation (§25.1).
 *
 * Appears only once a deployment exists. The pre-deployment views stay exactly where they were and
 * stay version-aware — a user has to be able to tell which revision they are looking at.
 */
const DEPLOYED_TABS: DeployedTab[] = ["overview", "performance", "architecture", "activity", "attack-lab", "policies", "simulation", "code", "deployments", "runtime"];

const CANONICAL_ORG_PROMPT =
  "Build my treasury department. A guardian agent that repays Aave debt to keep my health factor " +
  "above 1.6, up to $500 per action and $750 a day. A rebalancer that swaps to hold 40% ETH, up to " +
  "$250 per action and $750 a day. A reporter that reads positions and writes summaries and can " +
  "never move money. The whole department may not spend more than $1,250 in 24 hours.";

const CANONICAL_PROMPT =
  "I want an Aave agent that protects me from liquidation. Keep my health factor above 1.6. " +
  "Repay up to $1,000 automatically. $1,000–$5,000 requires Ledger. Never withdraw collateral.";

/**
 * The Studio workspace.
 *
 * The build does not live here. It lives in the backend, and this component is a view of it —
 * which is why switching tabs, reloading, or closing the browser cannot pause, restart or cancel
 * anything. The tab is React state; everything else is re-fetched.
 *
 * The build id is kept in the URL so a refresh lands back on the same build.
 */
export default function App() {
  /*
   * The summary is the first thing to read. §P28.5–6: what this agent is, and what it can and
   * cannot do, before anything about how it is built.
   */
  const [tab, setTab] = useState<Tab>("summary");

  /* A deployment id in the URL switches the workspace into the deployed-agent console. */
  const [deploymentId] = useState<string | null>(() => new URLSearchParams(location.search).get("deployment"));
  const [deployedTab, setDeployedTab] = useState<DeployedTab>("overview");


  /*
   * A project id in the URL opens the Lab screens for a project that has no build in this browser.
   *
   * Without it the workspace can only ever show the project the current build belongs to, which
   * means the demo project — the one every report describes and every route serves — was reachable
   * from the API and from nothing a user could click.
   */
  const [projectParam] = useState<string | null>(() => new URLSearchParams(location.search).get("project"));

  const [buildId, setBuildId] = useState<string | null>(() => new URLSearchParams(location.search).get("build"));
  const [orgId, setOrgId] = useState<string | null>(() => new URLSearchParams(location.search).get("org"));
  const [orgView, setOrgView] = useState<OrgView | null>(null);
  const [orgPrompt, setOrgPrompt] = useState(CANONICAL_ORG_PROMPT);
  const [orgRoot, setOrgRoot] = useState("");
  const [view, setView] = useState<BuildView | null>(null);
  const [prompt, setPrompt] = useState(CANONICAL_PROMPT);
  /** The single agent's ENS name. Optional; when given, it is the name and the model does not guess one. */
  const [agentEns, setAgentEns] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nodeStates, setNodeStates] = useState<Record<string, NodeState>>({});
  const [log, setLog] = useState<Array<{ type: string; text: string }>>([]);
  const unsub = useRef<(() => void) | null>(null);

  /*
   * The Lab projection for this project.
   *
   * Refetched rather than derived in the browser: the lifecycle is computed by the backend from the
   * underlying states, and a component that inferred it from `view` would be a second source of
   * truth about whether the agent holds financial authority.
   */
  const [labState, setLabState] = useState<LabStateView | null>(null);
  /** Bumped by screens that changed something the lifecycle reads (a CRE run, a fork deployment). */
  const [labRefresh, setLabRefresh] = useState(0);
  const bumpLab = useCallback(() => setLabRefresh((n) => n + 1), []);
  /*
   * Which reality the Deploy tab targets. The fork is the one a locally-built project can actually
   * be deployed to from this machine; the testnet path runs through the P23 orchestrator.
   */
  const [realityMode, setRealityMode] = useState<RealityMode["mode"]>("LOCAL_MAINNET_FORK");
  /*
   * The URL wins over the build's project.
   *
   * A user who navigated to `?project=…` asked to look at that project, and silently showing them a
   * different one because a build id is also present would be the screen deciding what they meant.
   */
  const labProjectId = projectParam ?? view?.build.projectId ?? DEMO_PROJECT_ID;
  useEffect(() => {
    let live = true;
    labApi.state(labProjectId)
      .then((s) => { if (live) setLabState(s); })
      .catch(() => { if (live) setLabState(null); });
    return () => { live = false; };
  }, [labProjectId, view?.build.stage, view?.build.status, deploymentId, labRefresh]);

  const refresh = useCallback(async (id: string) => {
    try {
      setView(await api.get(id));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  /* An organization is a document, not a running job: re-fetching it is the whole reconnect. */
  useEffect(() => {
    if (!orgId) return;
    api
      .organization(orgId)
      .then(setOrgView)
      .catch((e: unknown) => setError(String(e)));
  }, [orgId]);

  /* Reconnect to an in-flight build on mount — including after a browser refresh. */
  useEffect(() => {
    if (!buildId) return;
    void refresh(buildId);
    unsub.current?.();
    unsub.current = subscribe(buildId, (type, payload) => {
      setLog((l) => [...l.slice(-200), { type, text: summarize(type, payload) }]);
      // Node runtime states are derived from real build events, not animated for effect.
      setNodeStates((s) => ({ ...s, ...nodeStateFor(type, payload) }));
      if (
        type === "blueprint.completed" || type === "blueprint.updated" || type === "build.completed" ||
        type === "build.failed" || type === "simulation.completed" || type === "approval.requested" ||
        type === "code.file.created" || type === "test.passed" || type === "test.failed"
      ) {
        void refresh(buildId);
      }
    });
    return () => unsub.current?.();
  }, [buildId, refresh]);

  const start = async () => {
    setError(null);
    setBusy("Creating build");
    try {
      const b = await api.createBuild(prompt, `ui-${Date.now()}`, agentEns.trim() || undefined);
      setBuildId(b.id);
      history.replaceState(null, "", `?build=${b.id}`);
      setBusy("Understanding the request, designing permissions, reviewing security…");
      await api.design(b.id);
      await refresh(b.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const startOrg = async () => {
    setError(null);
    setBusy("Splitting this into separate principals…");
    try {
      const o = await api.createOrganization(orgPrompt, orgRoot);
      setOrgView(o);
      setOrgId(o.id);
      history.replaceState(null, "", `?org=${o.id}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const abandonBuild = async () => {
    if (!buildId) return;
    setError(null);
    setBusy("Letting this one go");
    try {
      await api.abandon(buildId, "declined at the approval boundary");
      setBuildId(null);
      setView(null);
      history.replaceState(null, "", location.pathname);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const approveAndBuild = async () => {
    if (!buildId || !view) return;
    setError(null);
    const modelCriticals = view.findings
      .filter((f) => f.severity === "CRITICAL" && f.source === "security-architect")
      .map((f) => f.code);
    try {
      setBusy("Approving");
      await api.approve(buildId, modelCriticals);
      setBusy("Generating code in an isolated sandbox…");
      await api.build(buildId);
      await refresh(buildId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const u = view?.usage;
  const pct = u ? Math.round(u.peakFraction * 100) : 0;

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="lock">◆</span>
          <div>
            <h1>ContextLock Studio</h1>
            <p className="tag">Describe the agent. Prove what it cannot do, before it holds money.</p>
          </div>
        </div>
        {u && (
          <div className={`usage ${u.warned ? "warn" : ""}`}>
            <span>{u.requests}/{u.limits.modelRequestsPerBuild} calls</span>
            <span>{(u.inputTokens + u.outputTokens).toLocaleString()} tokens</span>
            <span title="security simulations are not charged to your allowance">
              {u.userSimulations}/{u.limits.userRequestedSimulationsPerBuild} sims
              {u.mandatorySimulations > 0 && <em className="free"> +{u.mandatorySimulations} security</em>}
            </span>
            <span className="cost">~${u.estimatedCostUsd?.toFixed(3)} est.</span>
            <div className="bar"><div style={{ width: `${Math.min(pct, 100)}%` }} /></div>
            {u.warned && <span className="warnpill">{pct}% of budget</span>}
          </div>
        )}
      </header>

      {labState && (
        <>
          <LabStatusHeader view={labState} />
          <LabStateEvidence view={labState} />
        </>
      )}

      {orgId ? (
        <main>
          <nav className="tabs">
            <button className="active">Organization</button>
            <span className="live">
              {orgView ? (orgView.buildable ? "buildable" : "blocked") : "loading"}
            </span>
          </nav>
          <section className="view">
            <OrganizationView
              view={orgView}
              onBuildMember={async (agentId) => {
                if (!orgId) return;
                setError(null);
                setBusy("Starting this member's build…");
                try {
                  const r = await api.buildMember(orgId, agentId);
                  // The member's build is a project of its own; the workspace moves to it.
                  location.search = `?build=${r.build.id}`;
                } catch (e) {
                  setError(String(e));
                } finally {
                  setBusy(null);
                }
              }}
            />
          </section>
        </main>
      ) : !buildId && !projectParam ? (
        <main className="intake">
          <h2>What should your agent do?</h2>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} />
          <label className="field">
            <span>ENS name for this agent (optional)</span>
            <input
              value={agentEns}
              onChange={(e) => setAgentEns(e.target.value)}
              placeholder="guardian.acme.eth"
              spellCheck={false}
            />
          </label>
          <button className="primary" onClick={start} disabled={!!busy || (agentEns.trim() !== "" && !/^([a-z0-9-]+\.)+eth$/.test(agentEns.trim()))}>
            {busy ?? "Design this agent"}
          </button>
          <p className="note">
            Nothing is generated yet. The Studio produces requirements, an architecture and a
            security review first, and stops for you to approve it.
          </p>

          <h2>…or a whole team?</h2>
          <textarea value={orgPrompt} onChange={(e) => setOrgPrompt(e.target.value)} rows={4} />
          <label className="field">
            <span>ENS root you control</span>
            <input
              value={orgRoot}
              onChange={(e) => setOrgRoot(e.target.value)}
              placeholder="acme.eth"
              spellCheck={false}
            />
          </label>
          <button onClick={startOrg} disabled={!!busy || orgRoot.trim() === ""}>
            {busy ?? "Design this organization"}
          </button>
          <p className="note">
            Each agent becomes a separate security principal with its own identity, policy and
            limits. Nothing here lets one agent hand its authority to another.
          </p>
          <p className="note">
            The ENS root is the one thing the Studio will not guess. Agents are named beneath it, so
            a guessed name would put your department in a stranger's namespace.
          </p>

          {/*
            * The way into the recorded project.
            *
            * Everything it shows is backed by committed evidence — a sealed mainnet snapshot, a
            * real Anvil fork run, an official CRE simulation, a Sepolia policy read. Designing a
            * new agent here produces a project with none of that, and its Lab screens correctly
            * report the absences, which is honest and is not what someone wants to look at first.
            */}
          <h2>…or open the recorded one</h2>
          <p className="note">
            The Treasury Guardian from §P28.57 — the agent every report in
            <code> reports/phase-28/ </code> describes. Its market snapshot, fork run, CRE simulation
            and policy state are committed evidence rather than live state, so the Lab screens have
            something real to show without a deployment.
          </p>
          <a className="button-link" href={`?project=${DEMO_PROJECT_ID}`}>
            Open the Treasury Guardian
          </a>
        </main>
      ) : (
        <main>
          {/* The build pipeline's own progress. Absent when this workspace is looking at a
              project rather than following a build. */}
          {buildId && <Timeline view={view} busy={busy} />}

          {view?.build.stage === "AWAITING_APPROVAL" && (
            <ApprovalPanel view={view} onApprove={approveAndBuild} onAbandon={abandonBuild} busy={busy} />
          )}

          {deploymentId && (
            <nav className="tabs tabs-deployed">
              {DEPLOYED_TABS.map((t) => (
                <button key={t} className={deployedTab === t ? "active" : ""} onClick={() => setDeployedTab(t)}>
                  {t[0]!.toUpperCase() + t.slice(1)}
                </button>
              ))}
            </nav>
          )}

          {deploymentId && (
            <section className="view">
              <DeployedAgentView
                deploymentId={deploymentId}
                tab={deployedTab}
                labProjectId={labProjectId}
                graph={view?.graph ?? null}
                fetchOverview={controlApi.overview}
                fetchActivity={controlApi.activity}
                fetchTrace={controlApi.trace}
                fetchOperations={controlApi.operations}
                issueCommand={controlApi.issueCommand}
                emergencyLock={controlApi.emergencyLock}
              />
            </section>
          )}

          <nav className="tabs">
            {(["summary", "architecture", "simulation", "code", "deploy", "activate"] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {t[0]!.toUpperCase() + t.slice(1)}
                {t === "code" && view?.files.length ? <span className="count">{view.files.length}</span> : null}
                {t === "simulation" && view?.simulations.length ? (
                  <span className="count">{view.simulations.length}</span>
                ) : null}
              </button>
            ))}
            <span className="live">
              {busy ? <b className="running">{busy}</b> : buildId ? `stage ${view?.build.stage ?? "—"}` : labProjectId}
            </span>
          </nav>

          <section className="view">
            {tab === "summary" && <SummaryView projectId={labProjectId} fetchSummary={labApi.summary} />}

            {tab === "architecture" && (
              view?.graph
                ? <ArchitectureView graph={view.graph} nodeStates={nodeStates} />
                /*
                  * The graph is a projection of a compiled Blueprint, produced by the build
                  * pipeline. A project opened without one has no graph, and drawing an empty canvas
                  * would suggest an agent with no components rather than a view with no data.
                  */
                : <p className="empty">
                    The architecture graph is produced by the build pipeline. This project was
                    opened from its recorded state, which carries the Blueprint but not the
                    projection — run a build to draw it.
                  </p>
            )}
            {tab === "simulation" && (
              <>
                {/* §P28.12: the four layers together, above the per-scenario detail. */}
                <SimulationCenterView_ projectId={labProjectId} fetchCenter={labApi.simulationCenter} />
                <SimulationView_ sims={view?.simulations ?? []} />
                <ShadowPanel projectId={labProjectId} fetchShadow={labApi.shadow} />
                <MarketShockPanel projectId={labProjectId} fetchScenarios={labApi.scenarios} />
              </>
            )}
            {tab === "code" && (
              buildId
                ? <CodeView buildId={buildId} files={view?.files ?? []} stale={view?.codeStale ?? false} />
                : <p className="empty">Generated code belongs to a build. This project was opened from its recorded state.</p>
            )}
            {tab === "activate" && (
              <ActivateView
                projectId={labProjectId}
                fetchActivation={labApi.activation}
                fetchTokens={labApi.tokenRequirements}
                /*
                 * Activation runs through the P25 control plane against a real deployment, and
                 * there is deliberately no path from this screen to an enabled policy — the button
                 * reports that rather than pretending to act.
                 */
                onActivate={async (projectId) => {
                  /*
                   * Activation is a control-plane command against a deployment. For a project
                   * deployed to a local fork, that is the fork deployment this project currently
                   * has; the backend enables the policy on the fork and reads it back before
                   * answering. A project with no fork deployment has nothing to activate, and the
                   * testnet path still runs through the P23 orchestrator.
                   */
                  const current = (await forkApi.list(projectId)).find((d) => d.state === "READY_TO_ACTIVATE");
                  if (!current) throw new Error("No live fork deployment for this project. Deploy to the local mainnet fork first; testnet activation runs through the control plane against a testnet deployment.");
                  grantLocalOperator();
                  const r = await controlApi.issueCommand(current.deploymentId, "ENABLE_POLICY", current.revision, undefined, projectId);
                  if (!r.ok) throw new Error(r.detail);
                  bumpLab();
                  // Activated. The next thing to look at is the agent itself, so the workspace moves there.
                  const q = new URLSearchParams(location.search);
                  q.set("deployment", current.deploymentId);
                  q.set("project", projectId);
                  location.search = q.toString();
                }}
              />
            )}

            {tab === "deploy" && (
              <>
                <RealitySelector fetchReality={labApi.reality} initial={realityMode} onSelect={setRealityMode} />
                <CreStatusView
                  projectId={labProjectId}
                  fetchCre={labApi.cre}
                  /* The demo project's run is committed evidence; every other project runs its own. */
                  {...(labProjectId === DEMO_PROJECT_ID ? {} : { runSimulation: labApi.creSimulate, fetchSimulations: labApi.creSimulations, onSimulated: bumpLab })}
                />
                {realityMode === "LOCAL_MAINNET_FORK" ? (
                  <ForkDeployPanel
                    projectId={labProjectId}
                    buildId={buildId}
                    fetchReadiness={forkApi.readiness}
                    deploy={async (id, b) => {
                      // The person at this keyboard operates the fork they just started.
                      grantLocalOperator();
                      return forkApi.deploy(id, b);
                    }}
                    fetchDeployment={forkApi.get}
                    stop={forkApi.stop}
                    onStateChange={bumpLab}
                    onOpenDeployment={(id) => {
                      const q = new URLSearchParams(location.search);
                      q.set("deployment", id);
                      q.set("project", labProjectId);
                      location.search = q.toString();
                    }}
                  />
                ) : (
                  <DeployView
                    projectId={labProjectId}
                    fetchReadiness={async (id) => {
                      const d = await labApi.deploy(id, { gas: "400810", balance: "92000000000000000", required: "1049000000000000" });
                      return { readiness: d.readiness, phases: d.phases };
                    }}
                    fetchCost={async () => null}
                    onDeploy={async () => { throw new Error("Testnet deployment runs through the P23 orchestrator, not from this screen. Select Local Mainnet Fork to deploy from here."); }}
                  />
                )}
              </>
            )}
          </section>

          {view?.score && <ScorePanel score={view.score} />}
          {view && view.findings.length > 0 && <FindingsPanel findings={view.findings} />}

          <details className="eventlog">
            <summary>Build events ({log.length})</summary>
            {log.map((l, i) => (
              <div key={i} className="ev">
                <span className="t">{l.type}</span> {l.text}
              </div>
            ))}
          </details>
        </main>
      )}

      {error && <div className="error">{error}</div>}

      <footer>
        <span>
          ContextLock Studio · Sepolia testnet only · not audited · Chainlink runs in the official CLI
          simulator, not a live DON and not a TEE · no physical Ledger evidence (BLK-002)
        </span>
      </footer>
    </div>
  );
}

function Timeline({ view, busy }: { view: BuildView | null; busy: string | null }) {
  const stages = [
    ["REQUIREMENTS", "Understanding request"],
    ["BLUEPRINT", "Designing permissions"],
    ["SECURITY_REVIEW", "Security review"],
    ["AWAITING_APPROVAL", "Waiting for approval"],
    ["BUILD", "Generating code"],
    ["TEST", "Compiling and testing"],
    ["SIMULATE", "Simulating attacks"],
    ["FINAL_VERIFY", "Final verification"],
    ["EXPORT_READY", "Ready to export"],
  ] as const;
  const order = stages.map((s) => s[0]) as string[];
  const idx = view ? order.indexOf(view.build.stage) : -1;
  return (
    <ol className="timeline">
      {stages.map(([id, label], i) => (
        <li key={id} className={i < idx ? "done" : i === idx ? (busy ? "running" : "current") : "pending"}>
          <span className="dot" />
          {label}
        </li>
      ))}
    </ol>
  );
}

function ApprovalPanel({
  view,
  onApprove,
  onAbandon,
  busy,
}: {
  view: BuildView;
  onApprove: () => void;
  onAbandon: () => void;
  busy: string | null;
}) {
  const criticals = view.findings.filter((f) => f.severity === "CRITICAL" && f.source === "security-architect");
  const bp = view.blueprint as Record<string, any> | null;
  const auto = bp?.autonomousPolicy?.maxValueUsdCents;
  const esc = bp?.escalationPolicy;
  return (
    <div className="approval">
      <h3>Review before building</h3>
      <div className="limits">
        <div>
          <span className="k">Autonomous</span>
          <span className="v">
            {auto?.known ? `up to $${(auto.value / 100).toLocaleString()}` : "UNRESOLVED"}
          </span>
          {auto?.known && <span className="quote">from your words: “{auto.sourceQuote}”</span>}
        </div>
        <div>
          <span className="k">Human approval</span>
          <span className="v">
            {esc?.minValueUsdCents?.known && esc?.maxValueUsdCents?.known
              ? `$${(esc.minValueUsdCents.value / 100).toLocaleString()}–$${(esc.maxValueUsdCents.value / 100).toLocaleString()}`
              : "UNRESOLVED"}
          </span>
          <span className="quote">mechanism: {esc?.mechanism} — no physical device evidence</span>
        </div>
        <div>
          <span className="k">Above that</span>
          <span className="v">DENY — no path to execution</span>
        </div>
      </div>
      <div className="denied">
        <span className="k">Never permitted</span>
        <ul>
          {(bp?.permissions?.denied ?? []).map((d: { id: string; statement: string }) => (
            <li key={d.id} className={d.statement.startsWith("UNRESOLVED") ? "unresolved" : ""}>
              {d.statement}
            </li>
          ))}
        </ul>
      </div>
      {criticals.length > 0 && (
        <div className="ack">
          <b>{criticals.length} CRITICAL finding(s) from the security review.</b> These were raised by
          the reviewing model, not by the deterministic validator. Approving acknowledges them.
          <ul>
            {criticals.map((c) => (
              <li key={c.code}>
                <span className="mono">{c.code}</span> {c.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="decide">
        <button className="primary" onClick={onApprove} disabled={!!busy}>
          {busy ?? "Build this agent"}
        </button>
        {/* The other answer. A review you can only agree with is not a review. */}
        <button onClick={onAbandon} disabled={!!busy}>
          Don't build this
        </button>
      </div>
      <p className="note">
        No sandbox has been created and no code generated yet. Declining keeps the design and the
        review, and frees the slot for another agent.
      </p>
    </div>
  );
}

function ScorePanel({ score }: { score: NonNullable<BuildView["score"]> }) {
  return (
    <div className="score">
      <h3>
        Security score <b className={`band ${score.band.toLowerCase()}`}>{score.band}</b>{" "}
        <span className="total">
          {score.total}/{score.max}
        </span>
      </h3>
      <p className="note">
        Computed by deterministic code, not by a model. Every point requires evidence that exists —
        a passing test or a passing simulation.
      </p>
      <table>
        <tbody>
          {score.categories.map((c) => (
            <tr key={c.id}>
              <td className="lab">{c.label}</td>
              <td className="pts">
                {c.points}/{c.max}
              </td>
              <td className="why">
                {c.reasons.join("; ")}
                {c.missing.length > 0 && <span className="missing"> missing: {c.missing.join("; ")}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FindingsPanel({ findings }: { findings: BuildView["findings"] }) {
  return (
    <details className="findings" open>
      <summary>Security findings ({findings.length})</summary>
      <table>
        <tbody>
          {findings.map((f, i) => (
            <tr key={i} className={f.severity.toLowerCase()}>
              <td className="sev">{f.severity}</td>
              <td className="mono">{f.code}</td>
              <td className="src">{f.source}</td>
              <td>{f.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function summarize(type: string, p: unknown): string {
  const o = (p ?? {}) as Record<string, any>;
  switch (type) {
    case "code.file.created":
      return `${o.path} (${o.bytes}b)`;
    case "simulation.step":
      return `${o.scenarioId} → ${o.verdict} / ${o.outcome} (stop ${o.stoppedAt})`;
    case "security.finding":
      return `${o.severity} ${o.code} ${o.message ?? ""}`.slice(0, 160);
    case "test.passed":
    case "test.failed":
      return `${o.suite}${o.passed != null ? ` (${o.passed} passed)` : ""}`;
    case "usage.updated":
      return `${o.requests} calls, ${o.inputTokens}+${o.outputTokens} tokens`;
    case "build.completed":
      return `${o.files} files, score ${o.score?.total}/${o.score?.max}`;
    case "build.failed":
      return String(o.reason ?? "");
    default:
      return "";
  }
}

/** Node states come from real events. Nothing animates for decoration. */
function nodeStateFor(type: string, p: unknown): Record<string, NodeState> {
  const o = (p ?? {}) as Record<string, any>;
  switch (type) {
    case "requirements.started":
      return { user: "PASS", agent: "GENERATING" };
    case "blueprint.completed":
      return { agent: "READY", broker: "READY", ens: "READY", cre: "READY", capability: "READY", executor: "READY" };
    case "security.completed":
      return { "private-policy": o.critical > 0 ? "FAIL" : "READY" };
    case "code.started":
      return { broker: "GENERATING", cre: "GENERATING", keyring: "GENERATING" };
    case "test.passed":
      return { broker: "PASS", cre: "PASS", keyring: "PASS" };
    case "test.failed":
      return { broker: "FAIL" };
    case "simulation.step":
      return o.passed
        ? { executor: "PASS", capability: "PASS", ens: "PASS", authreg: "PASS" }
        : { executor: "FAIL" };
    case "build.completed":
      return { executor: "PASS", capability: "PASS", approval: "BLOCKED" };
    default:
      return {};
  }
}
