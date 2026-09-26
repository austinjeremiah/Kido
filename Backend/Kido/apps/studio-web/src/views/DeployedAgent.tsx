import { useCallback, useEffect, useState } from "react";
import { OverviewView, type OverviewData } from "./Overview";
import { ActivityView, TraceView, type ActivityEvent, type ActivityFilters } from "./Activity";
import { ControlsView, EmergencyModal, type Operation, type OperationInfo } from "./Controls";
import { AttackLabView } from "./AttackLab";
import { SafetyReportPanel } from "./SafetyReport";
import { CreStatusView } from "./CreStatus";
import { CreConnectPanel } from "./CreConnect";
import { SimulationCenterView_ } from "./SimulationCenter";
import { ShadowPanel } from "./Shadow";
import { MarketShockPanel } from "./MarketShock";
import { DecisionView } from "./Decision";
import { PerformancePanel } from "./Performance";
import { forkApi } from "../lab-api";
import { ArchitectureView } from "./Architecture";
import { runtimeNodeStates } from "../runtime-overlay";
import { labApi } from "../lab-api";
import type { BlueprintGraph } from "../api";

/**
 * The deployed-agent console.
 *
 * Mounted once a deployment exists. Everything it shows is fetched from the control plane on an
 * interval and on demand; nothing is kept as component state except what the user is looking at.
 *
 * That is the §25 architecture rule made concrete: closing this tab, reloading, or losing the
 * network cannot pause, resume or lose anything, because none of the state lives here. A reconnect
 * re-fetches and the screen rebuilds — LIVE-022.
 */

/**
 * §P28.3 adds "attack-lab" to the deployed navigation. Same project and same revisions underlie
 * both navigations — this is one application with two phases, not two applications.
 */
export type DeployedTab = "overview" | "performance" | "architecture" | "activity" | "attack-lab" | "policies" | "simulation" | "code" | "deployments" | "runtime";

/** How often to re-read. Short enough that a stale panel is unusual, long enough not to hammer RPC. */
const REFRESH_MS = 15_000;

export interface DeployedAgentProps {
  /** The Lab project this deployment belongs to, so both navigations read one project. */
  labProjectId?: string;
  /**
   * The canonical Blueprint graph. §P28.7 — the deployed console overlays runtime status on the
   * same graph the design phase drew, and does not author a second one.
   */
  graph?: BlueprintGraph | null;
  deploymentId: string;
  tab: DeployedTab;
  /** Supplied by the host so this component does no transport of its own. */
  fetchOverview: (deploymentId: string) => Promise<OverviewData>;
  fetchActivity: (deploymentId: string, filters: ActivityFilters) => Promise<ActivityEvent[]>;
  fetchTrace: (deploymentId: string, correlationId: string) => Promise<Parameters<typeof TraceView>[0]["trace"]>;
  fetchOperations: () => Promise<OperationInfo[]>;
  issueCommand: (deploymentId: string, operation: Operation, expectedRevision: string, confirmation?: Record<string, unknown>) => Promise<{ ok: boolean; detail: string; claim?: { warning: string | null } }>;
  emergencyLock: (deploymentId: string, includeIdentity: boolean, expectedRevision: string) => Promise<{ headline: string; lines: string[] }>;
}

export function DeployedAgentView(props: DeployedAgentProps) {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [filters, setFilters] = useState<ActivityFilters>({});
  const [trace, setTrace] = useState<Parameters<typeof TraceView>[0]["trace"]>(null);
  const [operations, setOperations] = useState<OperationInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [emergency, setEmergency] = useState(false);
  /** The decision the user asked "why did it act?" about. */
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Refresh on an interval AND on tab focus.
   *
   * The interval alone is not enough: a laptop that slept for an hour wakes with a screen full of
   * values that were true before it slept, and the panels would show them as current until the next
   * tick. Re-reading on focus closes that window.
   */
  const refresh = useCallback(async () => {
    try {
      setOverview(await props.fetchOverview(props.deploymentId));
      setError(null);
    } catch (e) {
      // A failed refresh must not leave the last successful reading on screen looking current. The
      // panels carry their own age, so the stale state is visible; this only surfaces the reason.
      setError(`could not refresh: ${(e as Error).message}`);
    }
  }, [props.deploymentId, props.fetchOverview]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  useEffect(() => {
    if (props.tab !== "activity") return;
    void props.fetchActivity(props.deploymentId, filters).then(setEvents).catch(() => setEvents([]));
  }, [props.tab, props.deploymentId, filters, props.fetchActivity]);

  useEffect(() => {
    void props.fetchOperations().then(setOperations).catch(() => setOperations([]));
  }, [props.fetchOperations]);

  const issue = async (operation: Operation, consequence: string) => {
    if (!overview) return;
    // The confirmation states the consequence. Never "are you sure?" — the question a user needs
    // answered is what this will and will not stop.
    if (!window.confirm(`${operation.replace(/_/g, " ")}\n\n${consequence}\n\nProceed?`)) return;
    setBusy(operation);
    setOutcome(null);
    try {
      const r = await props.issueCommand(props.deploymentId, operation, overview.currentRevision);
      setOutcome(r.claim?.warning ? `${r.detail}\n\n${r.claim.warning}` : r.detail);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runEmergency = async (includeIdentity: boolean) => {
    if (!overview) return;
    setBusy("EMERGENCY_LOCK");
    try {
      const r = await props.emergencyLock(props.deploymentId, includeIdentity, overview.currentRevision);
      setOutcome([r.headline, ...r.lines].join("\n"));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      setEmergency(false);
    }
  };

  return (
    <div className="deployed-agent">
      {error && <div className="banner banner-error">{error}</div>}
      {outcome && <pre className="banner banner-outcome">{outcome}</pre>}

      {props.tab === "overview" && <OverviewView data={overview} />}

      {/*
        * §P28.7: the same graph, with runtime status overlaid. `runtimeNodeStates` never paints a
        * node green from absence — an unobserved component stays PENDING and a stale reading is
        * WARN whatever it said.
        */}
      {props.tab === "architecture" && (
        <div className="deployed-architecture">
          <ArchitectureView graph={props.graph ?? null} nodeStates={runtimeNodeStates(props.graph ?? null, overview)} />
          <p className="note">
            Live status, on the architecture this Blueprint produced. A component with no current
            reading is shown as unobserved rather than as healthy.
          </p>
        </div>
      )}

      {/*
        * §P28.3's Attack Lab, and the safety report beneath it.
        *
        * The same project underlies both navigations, so the lab surfaces read the project id the
        * deployment belongs to rather than a second identifier of their own.
        */}
      {props.tab === "attack-lab" && (
        <>
          <AttackLabView
            projectId={props.labProjectId ?? "proj-treasury-guardian"}
            fetchCatalogue={labApi.attacks}
            runAttack={labApi.runAttack}
          />
          <CreStatusView projectId={props.labProjectId ?? "proj-treasury-guardian"} fetchCre={labApi.cre} />
          <CreConnectPanel
            projectId={props.labProjectId ?? "proj-treasury-guardian"}
            fetchConnect={labApi.creConnect}
            fetchParity={labApi.creParity}
          />
          <SafetyReportPanel
            projectId={props.labProjectId ?? "proj-treasury-guardian"}
            fetchReport={labApi.safetyReport}
            fetchPublic={labApi.publicSafetyReport}
          />
        </>
      )}

      {props.tab === "activity" && (
        <>
          <ActivityView
            events={events}
            filters={filters}
            onFilter={setFilters}
            onSelectCorrelation={(id) => {
              setDecisionId(id);
              void props.fetchTrace(props.deploymentId, id).then(setTrace);
            }}
          />
          <TraceView trace={trace} onClose={() => setTrace(null)} />
          {/* §P28.34, beside the trace: the stages say what happened, this says why. */}
          {decisionId && (
            <DecisionView
              projectId={props.labProjectId ?? "proj-treasury-guardian"}
              correlationId={decisionId}
              fetchDecision={labApi.decision}
              onClose={() => setDecisionId(null)}
            />
          )}
        </>
      )}

      {/* The position the agent guards on the fork, and what it did about it. */}
      {props.tab === "performance" && (
        <>
          <PerformancePanel
            deploymentId={props.deploymentId}
            projectId={props.labProjectId ?? "proj-treasury-guardian"}
            fetchPosition={forkApi.position}
            stress={forkApi.stress}
            approve={forkApi.approve}
            decline={forkApi.decline}
            tick={forkApi.tick}
            onDecision={setDecisionId}
          />
          {decisionId && (
            <DecisionView
              projectId={props.labProjectId ?? "proj-treasury-guardian"}
              correlationId={decisionId}
              fetchDecision={labApi.decision}
              onClose={() => setDecisionId(null)}
            />
          )}
        </>
      )}

      {props.tab === "runtime" && overview && (
        <>
          <ControlsView
            operations={operations}
            currentRevision={overview.currentRevision}
            busy={busy}
            onIssue={issue}
            onEmergency={() => setEmergency(true)}
          />
          {emergency && <EmergencyModal busy={busy === "EMERGENCY_LOCK"} onCancel={() => setEmergency(false)} onConfirm={runEmergency} />}
        </>
      )}

      {/* §P28.12 — the four layers, on the deployed side too, reading the same projection. */}
      {props.tab === "simulation" && (
        <>
          <SimulationCenterView_ projectId={props.labProjectId ?? "proj-treasury-guardian"} fetchCenter={labApi.simulationCenter} />
          <ShadowPanel projectId={props.labProjectId ?? "proj-treasury-guardian"} fetchShadow={labApi.shadow} />
          <MarketShockPanel projectId={props.labProjectId ?? "proj-treasury-guardian"} fetchScenarios={labApi.scenarios} />
        </>
      )}

      {props.tab === "policies" && overview && (
        <div className="policies">
          <h3>ContextLock policy</h3>
          {/* The value AND its provenance. A policy screen that showed only the flag would be the
              database-backed indicator §25.17 forbids. */}
          <p className="policy-state">
            {overview.panels.policy?.value ? (overview.panels.policy.value.enabled ? "ENABLED" : "DISABLED") : "UNKNOWN"}
          </p>
          <p className="policy-provenance">
            {overview.panels.policy
              ? `read from ${overview.panels.policy.source} ${Math.round(overview.panels.policy.ageMs / 1000)}s ago${overview.panels.policy.isCurrent ? "" : " — NOT CURRENT"}`
              : "never read"}
          </p>
          {overview.panels.policy?.value && (
            <dl>
              <div><dt>binding version</dt><dd>{overview.panels.policy.value.bindingVersion}</dd></div>
              <div><dt>policy admin</dt><dd><code>{overview.panels.policy.value.policyAdmin}</code></dd></div>
            </dl>
          )}
        </div>
      )}

      {props.tab === "deployments" && overview && (
        <div className="deployments">
          <h3>Revisions</h3>
          <p>
            Current deployment revision <code>{overview.currentRevision}</code>. Commands are issued
            against it; if it changes while a screen is open, an in-flight command is rejected rather
            than applied to a different deployment.
          </p>
        </div>
      )}
    </div>
  );
}
