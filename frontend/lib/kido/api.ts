/**
 * HTTP client for the Kido API. Requests go to /api/* on this origin; next.config.mjs proxies them
 * to the Kido backend, so the browser needs no CORS. Nothing here holds state or keys.
 */
import type { Portfolio, ChatAnswer, InjectionResult, LabVerdict, Reality, WhatIf, ControlMessage, DeploymentStatus, DeploymentWire, ProjectEvent, Runtime, TxRequest, TypedDataWire, Health, Introspection, ProjectRow, ProjectSummary, ProviderRow, Question, SelfModel, SecurityReport, SimulationReport, BuildArtifact, Blueprint, Blocker } from './types';

export class KidoApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = 'KidoApiError';
  }
  /** Lifecycle gate refusals (409) are expected states with a reason, not faults. */
  get isGate(): boolean {
    return this.status === 409;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new KidoApiError(typeof json.message === 'string' ? json.message : `${res.status} ${res.statusText}`, res.status, typeof json.error === 'string' ? json.error : null);
  return json as T;
}

export const kido = {
  health: () => call<Health>('GET', '/health'),
  projects: () => call<{ projects: ProjectRow[] }>('GET', '/projects').then((r) => r.projects),
  project: (id: string) => call<ProjectSummary>('GET', `/projects/${id}`),
  create: (objective: string, name?: string) => call<{ projectId: string; question: Question | null }>('POST', '/projects', { objective, ...(name ? { name } : {}) }),
  rename: (id: string, name: string) => call<{ projectId: string; name: string }>('PATCH', `/projects/${id}`, { name }),
  answer: (id: string, text: string) => call<{ accepted: boolean; note?: string; next: Question | null }>('POST', `/projects/${id}/answer`, { text }),
  edit: (id: string, key: string, text: string) => call<{ accepted: boolean; note?: string; next: Question | null }>('POST', `/projects/${id}/edit`, { key, text }),
  finalize: (id: string) => call<{ blueprint: Blueprint; blockers: Blocker[] }>('POST', `/projects/${id}/finalize`),
  securityReview: (id: string) => call<SecurityReport>('POST', `/projects/${id}/security-review`),
  simulate: (id: string) => call<SimulationReport>('POST', `/projects/${id}/simulate`),
  build: (id: string) => call<BuildArtifact>('POST', `/projects/${id}/build`),
  selfModel: (id: string) => call<SelfModel>('GET', `/projects/${id}/self-model`),
  introspect: (id: string, question: string) => call<Introspection>('POST', `/projects/${id}/introspect`, { question }),
  context: (id: string, role: string) => call<Record<string, unknown>>('GET', `/projects/${id}/context/${encodeURIComponent(role)}`),
  registry: () => call<{ providers: ProviderRow[] }>('GET', '/registry').then((r) => r.providers),
  drift: () => call<{ drift: unknown[]; quarantined: unknown[] }>('GET', '/knowledge/drift'),
  whatIf: (id: string, w: WhatIf) => call<LabVerdict>('POST', `/projects/${id}/attack/what-if`, w),
  injection: (id: string, t: { instruction: string; target: string; amount: string; chain?: string }) => call<InjectionResult>('POST', `/projects/${id}/attack/injection`, t),
  chat: (id: string, question: string) => call<ChatAnswer>('POST', `/projects/${id}/chat`, { question }),
  reality: (id?: string) => call<Reality>('GET', id ? `/projects/${id}/reality` : '/reality'),
  deployment: (id: string) => call<DeploymentStatus>('GET', `/projects/${id}/deployment`),
  deployStart: (id: string, owner: string, recoverySui?: string) => call<{ deployment: DeploymentWire; transactions: TxRequest[] }>('POST', `/projects/${id}/deploy/start`, { owner, ...(recoverySui ? { recoverySui } : {}) }),
  deployEvmAccount: (id: string, txHash: string) => call<{ deployment: DeploymentWire }>('POST', `/projects/${id}/deploy/evm-account`, { txHash }),
  deployPolicy: (id: string) => call<{ typedData: TypedDataWire; summary: { endpoints: number; allowedActions: number; crossChainTotal: Record<string, string> } }>('GET', `/projects/${id}/deploy/policy`),
  deploySubmitPolicy: (id: string, signature: string) => call<{ deployment: DeploymentWire; transactions: TxRequest[] }>('POST', `/projects/${id}/deploy/policy`, { signature }),
  deployConfirm: (id: string) => call<{ active: boolean; runtime: Runtime }>('POST', `/projects/${id}/deploy/confirm`),
  recordTx: (id: string, chain: string, label: string, tx: string) => call<{ ok: true }>('POST', `/projects/${id}/deploy/tx`, { chain, label, tx }),
  runtime: (id: string) => call<Runtime>('GET', `/projects/${id}/runtime`),
  portfolio: (id: string) => call<Portfolio>('GET', `/projects/${id}/portfolio`),
  activity: (id: string) => call<{ events: ProjectEvent[] }>('GET', `/projects/${id}/activity`).then((r) => r.events),
  controlPrepare: (id: string, op: 'pause' | 'revoke') => call<{ messages: ControlMessage[] }>('POST', `/projects/${id}/control/${op}/prepare`),
  controlSubmit: (id: string, op: 'pause' | 'revoke', signed: { chain: string; message: Record<string, unknown>; signature: string }[]) => call<{ transactions: TxRequest[]; results: unknown[] }>('POST', `/projects/${id}/control/${op}`, { signed }),
};
