import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { bindTo, blueprintHash, buildBlockers, isStale, nextRevision, type KidoAgentBlueprint, type RevisionBound } from "@kido/blueprint";
import { DesignInterview, compileBlueprint, type InterviewModel, type InterviewState, type Question } from "@kido/design-interview";
import { buildPublicManifest, compileIdentityPlan, type PlannedBinding } from "@kido/identity";
import { KnowledgeBase } from "@kido/knowledge";
import { applyPrivacyPlan, compilePrivacy, type PrivacyPlan } from "@kido/privacy";
import { ProviderRegistry } from "@kido/registry";
import { buildAgentContext, buildSelfModel, compileAmaneAuthority, introspect, type AgentRuntimeState, type AuthorityResult, type RuntimeSnapshot } from "@kido/runtime";
import type { AmaneDeploymentManifest } from "@kido/amane-bridge";
import { authorityEndpoints } from "./endpoints.js";
import { securityReview, type SecurityReport } from "./review.js";
import { simulate, type SimulationReport } from "./simulate.js";

export interface BuildArtifact extends RevisionBound {
  kind: "build";
  buildRevision: number;
  agents: { role: string; knowledgePacks: string[]; contextChars: number; missingPacks: string[] }[];
  monitors: string[];
  authority: { mode: string | null; provider: string | null; crossChainTotal: Record<string, string>; excludedActions: string[] };
  identity: PlannedBinding[];
  privacy: PrivacyPlan;
  generatedAt: number;
}

export interface ProjectRecord {
  projectId: string;
  createdAt: number;
  interview: InterviewState;
  revisions: KidoAgentBlueprint[];
  privacyPlan: PrivacyPlan | null;
  identityPlan: PlannedBinding[];
  security: SecurityReport | null;
  simulation: SimulationReport | null;
  build: BuildArtifact | null;
}

export class FileProjectStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  save(p: ProjectRecord) {
    writeFileSync(join(this.dir, `${p.projectId}.json`), JSON.stringify(p, null, 2));
  }
  load(projectId: string): ProjectRecord {
    const f = join(this.dir, `${projectId}.json`);
    if (!existsSync(f)) throw new Error(`unknown project ${projectId}`);
    return JSON.parse(readFileSync(f, "utf8")) as ProjectRecord;
  }
}

export class LifecycleError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "LifecycleError";
  }
}

export interface FoundryDeps {
  store: FileProjectStore;
  model: InterviewModel;
  registry?: ProviderRegistry;
  knowledge?: KnowledgeBase;
  amaneManifest: AmaneDeploymentManifest;
  /** Kido's lease issuer and the agent signer used for compiling (simulation-only keys are fine). */
  signers: { controllers: `0x${string}`[]; issuer: `0x${string}`; agent: `0x${string}` };
}

/**
 * The application state machine that owns the agent lifecycle (bible §3). The model reads text
 * inside the interview; every transition here is a deterministic gate.
 */
export class Foundry {
  readonly registry: ProviderRegistry;
  readonly knowledge: KnowledgeBase;

  constructor(private readonly d: FoundryDeps) {
    this.registry = d.registry ?? new ProviderRegistry();
    this.knowledge = d.knowledge ?? KnowledgeBase.load();
  }

  async create(objective: string): Promise<{ projectId: string; question: Question | null }> {
    const projectId = `proj_${randomUUID().slice(0, 12)}`;
    const iv = await DesignInterview.start(projectId, randomUUID(), objective, this.d.model);
    const question = iv.next();
    this.d.store.save({ projectId, createdAt: Date.now(), interview: iv.state, revisions: [], privacyPlan: null, identityPlan: [], security: null, simulation: null, build: null });
    return { projectId, question };
  }

  next(projectId: string): Question | null {
    const p = this.d.store.load(projectId);
    const iv = DesignInterview.restore(p.interview, this.d.model);
    const q = iv.next();
    p.interview = iv.state;
    this.d.store.save(p);
    return q;
  }

  async answer(projectId: string, text: string) {
    const p = this.d.store.load(projectId);
    const iv = DesignInterview.restore(p.interview, this.d.model);
    if (!iv.state.pending) iv.next();
    const r = await iv.answer(text);
    p.interview = iv.state;
    this.d.store.save(p);
    return r;
  }

  async edit(projectId: string, key: string, text: string) {
    const p = this.d.store.load(projectId);
    const iv = DesignInterview.restore({ ...p.interview, finalized: false }, this.d.model);
    const r = await iv.edit(key, text);
    p.interview = iv.state;
    this.d.store.save(p);
    return r;
  }

  unresolved(projectId: string) {
    const p = this.d.store.load(projectId);
    return DesignInterview.restore(p.interview, this.d.model).unresolved();
  }

  blueprint(projectId: string): KidoAgentBlueprint | null {
    const p = this.d.store.load(projectId);
    return p.revisions.at(-1) ?? null;
  }

  /** REVIEW gate input: resolutions → blueprint → privacy plan → identity plan, as one new revision. */
  finalize(projectId: string): { blueprint: KidoAgentBlueprint; blockers: ReturnType<typeof buildBlockers>; privacyPlan: PrivacyPlan; identityPlan: PlannedBinding[] } {
    const p = this.d.store.load(projectId);
    const iv = DesignInterview.restore(p.interview, this.d.model);
    iv.finalizeResolutions();
    let bp = compileBlueprint(iv.resolutionsBlueprint(), this.registry);
    const prev = p.revisions.at(-1);
    if (prev) bp = { ...bp, revision: prev.revision + 1, parentRevisionHash: blueprintHash(prev) };
    const privacyPlan = compilePrivacy(bp, this.registry);
    bp = applyPrivacyPlan(bp, privacyPlan);
    const identityPlan = compileIdentityPlan(bp, this.registry, buildPublicManifest(bp, blueprintHash(bp)));
    if (identityPlan.length) bp = nextRevision(bp, { identity: { ...bp.identity, bindings: identityPlan.map((b) => ({ provider: b.providerId as "ens" | "suins", chain: b.chain, name: b.name, status: "PLANNED" as const })) } });
    p.interview = iv.state;
    p.revisions.push(bp);
    p.privacyPlan = privacyPlan;
    p.identityPlan = identityPlan;
    this.d.store.save(p);
    return { blueprint: bp, blockers: buildBlockers(bp, this.registry.gateFacts()), privacyPlan, identityPlan };
  }

  private authority(bp: KidoAgentBlueprint): AuthorityResult | null {
    if (bp.authority.mode !== "BOUNDED_AUTONOMOUS_FINANCE") return null;
    try {
      return compileAmaneAuthority(bp, authorityEndpoints(bp, this.d.amaneManifest, this.registry), { ...this.d.signers, now: BigInt(Math.floor(Date.now() / 1000)) });
    } catch (err) {
      return { ok: false, blockers: [(err as Error).message] };
    }
  }

  securityReview(projectId: string): SecurityReport {
    const p = this.d.store.load(projectId);
    const bp = this.requireBlueprint(p);
    const report = securityReview(bp, { authority: this.authority(bp), identityPlan: p.identityPlan, privacyPlan: p.privacyPlan ?? compilePrivacy(bp, this.registry), drift: this.knowledge.drift(this.registry), registry: this.registry });
    p.security = report;
    this.d.store.save(p);
    return report;
  }

  async simulate(projectId: string): Promise<SimulationReport> {
    const p = this.d.store.load(projectId);
    const bp = this.requireBlueprint(p);
    const report = await simulate(bp, this.authority(bp));
    p.simulation = report;
    this.d.store.save(p);
    return report;
  }

  /** BUILD gate: no blockers, a current non-blocking security review and a current passing simulation. */
  build(projectId: string): BuildArtifact {
    const p = this.d.store.load(projectId);
    const bp = this.requireBlueprint(p);
    const blockers = buildBlockers(bp, this.registry.gateFacts());
    if (blockers.length) throw new LifecycleError("KIDO_LIFECYCLE_NOT_BUILDABLE", blockers.map((b) => `${b.code}:${b.detail}`).join(", "));
    if (!p.security || isStale(p.security, bp)) throw new LifecycleError("KIDO_LIFECYCLE_STALE_REVIEW", "run the security review for this revision");
    if (p.security.blocking) throw new LifecycleError("KIDO_LIFECYCLE_BLOCKING_FINDINGS", p.security.findings.filter((f) => f.blocking).map((f) => f.id).join(", "));
    if (!p.simulation || isStale(p.simulation, bp)) throw new LifecycleError("KIDO_LIFECYCLE_STALE_SIMULATION", "run the simulation for this revision");
    if (!p.simulation.passed) throw new LifecycleError("KIDO_LIFECYCLE_SIMULATION_FAILED", p.simulation.results.filter((r) => !r.passed).map((r) => r.id).join(", "));
    const auth = this.authority(bp);
    const artifact: BuildArtifact = {
      ...bindTo(bp),
      kind: "build",
      buildRevision: (p.build?.buildRevision ?? 0) + 1,
      agents: bp.agents.map((a) => {
        const c = this.knowledge.contextFor(a.knowledgePacks);
        return { role: a.role, knowledgePacks: c.included, contextChars: c.text.length, missingPacks: c.missing };
      }),
      monitors: bp.monitors.map((m) => m.id),
      authority: {
        mode: bp.authority.mode,
        provider: bp.authority.provider,
        crossChainTotal: auth?.ok ? Object.fromEntries(Object.entries(auth.crossChainTotal).map(([k, v]) => [k, v.toString()])) : {},
        excludedActions: auth?.ok ? auth.excludedActions.map((x) => `${x.chain}:${x.action}`) : [],
      },
      identity: p.identityPlan,
      privacy: p.privacyPlan ?? compilePrivacy(bp, this.registry),
      generatedAt: Date.now(),
    };
    p.build = artifact;
    this.d.store.save(p);
    return artifact;
  }

  /** Deterministic answers about the agent from its self-model (bible §13.2). */
  introspect(projectId: string, question: string, runtime: RuntimeSnapshot = {}) {
    const bp = this.requireBlueprint(this.d.store.load(projectId));
    return introspect(buildSelfModel(bp, runtime), question);
  }

  selfModel(projectId: string, runtime: RuntimeSnapshot = {}) {
    return buildSelfModel(this.requireBlueprint(this.d.store.load(projectId)), runtime);
  }

  /** The exact context a specialist would receive (bible §13.1). */
  agentContext(projectId: string, role: string, state: AgentRuntimeState = {}) {
    return buildAgentContext(role, this.requireBlueprint(this.d.store.load(projectId)), state, this.knowledge);
  }

  status(projectId: string) {
    const p = this.d.store.load(projectId);
    const bp = p.revisions.at(-1);
    const fresh = (a: RevisionBound | null) => (a && bp ? (isStale(a, bp) ? "STALE" : "CURRENT") : "NONE");
    return {
      projectId,
      revision: bp?.revision ?? null,
      blockers: bp ? buildBlockers(bp, this.registry.gateFacts()) : [],
      unresolved: this.unresolved(projectId),
      security: fresh(p.security),
      simulation: fresh(p.simulation),
      build: fresh(p.build),
    };
  }

  private requireBlueprint(p: ProjectRecord): KidoAgentBlueprint {
    const bp = p.revisions.at(-1);
    if (!bp) throw new LifecycleError("KIDO_LIFECYCLE_NOT_FINALIZED", "finalize the interview first");
    return bp;
  }
}
