import type { OverviewData } from "./views/Overview";
import type { ActivityEvent, ActivityFilters } from "./views/Activity";
import type { Operation, OperationInfo } from "./views/Controls";

/**
 * The control-plane client.
 *
 * A thin transport. It holds no state, caches nothing and interprets nothing — every value it
 * returns came from the backend with its own freshness attached, and a client-side cache here would
 * be exactly the stale-value-shown-as-current problem the whole phase is about.
 *
 * Operator capabilities travel as a header. P26 replaces this with a real session; until then it is
 * explicit rather than implicit, so a viewer is a viewer by default.
 */

const capabilities = (): string => {
  try {
    return localStorage.getItem("contextlock.capabilities") ?? "VIEW";
  } catch {
    return "VIEW";
  }
};

/**
 * Every operator capability, for the person running a fork on their own machine.
 *
 * Granted explicitly when a fork deployment is started — the fork is local, its keys are ephemeral
 * and the only person who can reach it is the one at this keyboard. Nothing here changes what a
 * viewer of a real deployment can do: the header is still what the backend checks.
 */
export const LOCAL_OPERATOR_CAPABILITIES = "VIEW,RUNTIME_CONTROL,CRE_CONTROL,POLICY_CONTROL,IDENTITY_CONTROL,EMERGENCY_CONTROL";
export function grantLocalOperator(): void {
  try {
    localStorage.setItem("contextlock.capabilities", LOCAL_OPERATOR_CAPABILITIES);
  } catch {
    /* a browser without storage is a viewer; the fork's screens say so */
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-contextlock-capabilities": capabilities(),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
    // The reason code matters more than the status: an operator needs to know whether they were
    // refused for lack of authority or because their screen was out of date.
    throw new Error(body.reason ? `${body.reason}: ${body.error ?? ""}` : (body.error ?? `HTTP ${res.status}`));
  }
  return (await res.json()) as T;
}

const qs = (f: ActivityFilters): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  return p.toString() ? `?${p.toString()}` : "";
};

export const controlApi = {
  overview: (deploymentId: string): Promise<OverviewData> =>
    call(`/api/control/deployments/${deploymentId}/overview`),

  activity: async (deploymentId: string, filters: ActivityFilters): Promise<ActivityEvent[]> =>
    (await call<{ events: ActivityEvent[] }>(`/api/control/deployments/${deploymentId}/activity${qs(filters)}`)).events,

  trace: (deploymentId: string, correlationId: string) =>
    call<never>(`/api/control/deployments/${deploymentId}/traces/${correlationId}`),

  operations: async (): Promise<OperationInfo[]> =>
    (await call<{ operations: OperationInfo[] }>("/api/control/operations")).operations,

  /**
   * Issue a command.
   *
   * `expectedRevision` is what the screen was showing. The backend rejects it if the deployment has
   * moved since — so a button clicked against a stale page cannot act on something else.
   */
  issueCommand: (deploymentId: string, operation: Operation, expectedRevision: string, confirmation?: Record<string, unknown>, projectId?: string) =>
    call<{ ok: boolean; detail: string; claim?: { warning: string | null } }>(`/api/control/deployments/${deploymentId}/commands${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, {
      method: "POST",
      body: JSON.stringify({ operation, expectedRevision, confirmation: confirmation ?? null }),
    }),

  emergencyLock: (deploymentId: string, includeIdentity: boolean, expectedRevision: string) =>
    call<{ headline: string; lines: string[] }>(`/api/control/deployments/${deploymentId}/commands`, {
      method: "POST",
      body: JSON.stringify({ operation: "EMERGENCY_LOCK", expectedRevision, confirmation: { includeIdentityRevocation: includeIdentity } }),
    }),
};
