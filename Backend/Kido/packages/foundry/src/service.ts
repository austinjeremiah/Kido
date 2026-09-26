import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { bindTo, blueprintHash, buildBlockers, isStale, nextRevision, type KidoAgentBlueprint, type RevisionBound } from "@kido/blueprint";
import { DesignInterview, compileBlueprint, type InterviewModel, type InterviewState, type Question } from "@kido/design-interview";
import { buildPublicManifest, compileIdentityPlan, type PlannedBinding } from "@kido/identity";
import { KnowledgeBase } from "@kido/knowledge";
import { applyPrivacyPlan, compilePrivacy, type PrivacyPlan } from "@kido/privacy";
import { IMPLEMENTATION_STATUS_MEANING, ProviderRegistry } from "@kido/registry";
import { buildAgentContext, buildSelfModel, compileAmaneAuthority, introspect, type AgentRuntimeState, type AuthorityResult, type ExecutionFact, type ProviderState, type RuntimeSnapshot } from "@kido/runtime";
import type { AmaneDeploymentManifest } from "@kido/amane-bridge";
import { authorityEndpoints } from "./endpoints.js";
import { securityReview, type SecurityReport } from "./review.js";
import { evaluateWhatIf, injectionTest, type WhatIf } from "./attack-lab.js";
import { OpenAIAgentChat } from "@kido/agents";
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
  /** Display name chosen by the user; defaults to a shortened objective. */
  name?: string;
  createdAt: number;
  interview: InterviewState;
  revisions: KidoAgentBlueprint[];
  privacyPlan: PrivacyPlan | null;
  identityPlan: PlannedBinding[];
  security: SecurityReport | null;
  simulation: SimulationReport | null;
  build: BuildArtifact | null;
  /** Wallet-driven deployment state (JSON-safe: bigints stored as { $big }). */
  deployment?: unknown;
  /** Earlier deployments, kept for the record after the owner retired them to redeploy. */
  retiredDeployments?: unknown[];
  /** Lifecycle and on-chain events, newest last. */
  events?: ProjectEvent[];
}

export interface ProjectEvent {
  at: number;
  type: string;
  chain?: string;
  detail: string;
  tx?: string;
}

export class FileProjectStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  save(p: ProjectRecord) {
    writeFileSync(join(this.dir, `${p.projectId}.json`), JSON.stringify(p, null, 2));
  }
  list(): ProjectRecord[] {
    return readdirSync(this.dir)
      .filter((f) => /^proj_[\w-]+\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as ProjectRecord)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  load(projectId: string): ProjectRecord {
    const f = join(this.dir, `${projectId}.json`);
    if (!existsSync(f)) throw new Error(`unknown project ${projectId}`);
    return JSON.parse(readFileSync(f, "utf8")) as ProjectRecord;
  }
}

export type ProjectStage = "INTERVIEW" | "BLUEPRINT" | "REVIEWED" | "SIMULATED" | "BUILT";

export interface ProjectRow {
  projectId: string;
  name: string;
  objective: string;
  createdAt: number;
  stage: ProjectStage;
  revision: number | null;
  kidoAgentId: string | null;
  chains: string[];
  agents: string[];
}

type Freshness = { freshness: "CURRENT" | "STALE" | "NONE" };

export interface ProjectSummary extends ProjectRow {
  interview: {
    question: Question | null;
    transcript: InterviewState["transcript"];
    warnings: string[];
    questionsAsked: number;
    requirements: { key: string; topic: string; critical: boolean; status: string; value: unknown; confirmed: boolean }[];
    unresolved: unknown;
  };
  blueprint: KidoAgentBlueprint | null;
  blueprintHash: string | null;
  blockers: ReturnType<typeof buildBlockers>;
  privacyPlan: PrivacyPlan | null;
  identityPlan: PlannedBinding[];
  security: (SecurityReport & Freshness) | null;
  simulation: (SimulationReport & Freshness) | null;
  build: (BuildArtifact & Freshness) | null;
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

  async create(objective: string, name?: string): Promise<{ projectId: string; question: Question | null }> {
    const projectId = `proj_${randomUUID().slice(0, 12)}`;
    const iv = await DesignInterview.start(projectId, randomUUID(), objective, this.d.model);
    const question = iv.next();
    this.d.store.save({ projectId, ...(name?.trim() ? { name: name.trim() } : {}), createdAt: Date.now(), interview: iv.state, revisions: [], privacyPlan: null, identityPlan: [], security: null, simulation: null, build: null });
    return { projectId, question };
  }

  /** Raw record access for services layered on the lifecycle (deployment, activity). */
  loadRecord(projectId: string): ProjectRecord {
    return this.d.store.load(projectId);
  }
  saveRecord(p: ProjectRecord) {
    this.d.store.save(p);
  }
  get manifest(): AmaneDeploymentManifest {
    return this.d.amaneManifest;
  }

  rename(projectId: string, name: string) {
    const p = this.d.store.load(projectId);
    p.name = name.trim();
    this.d.store.save(p);
    return { projectId, name: p.name };
  }

  /** Every project, newest first, as list rows. */
  projects(): ProjectRow[] {
    return this.d.store.list().map((p) => this.row(p));
  }

  /**
   * One project's full lifecycle state for a client: interview (pending question, transcript,
   * resolved requirements), the current blueprint revision, and the review, simulation and build
   * artifacts with whether each is current for that revision. Private values never appear: the
   * interview state stores only references to them.
   */
  summary(projectId: string): ProjectSummary {
    const p = this.d.store.load(projectId);
    const iv = DesignInterview.restore(p.interview, this.d.model);
    const question = iv.state.finalized ? null : iv.next();
    if (!iv.state.finalized) {
      p.interview = iv.state;
      this.d.store.save(p);
    }
    const bp = p.revisions.at(-1) ?? null;
    const fresh = (a: RevisionBound | null) => (a && bp ? (isStale(a, bp) ? "STALE" : "CURRENT") : "NONE");
    return {
      ...this.row(p),
      interview: {
        question,
        transcript: iv.state.transcript,
        warnings: iv.state.warnings,
        questionsAsked: iv.state.questionsAsked,
        requirements: Object.values(iv.state.resolutions).map((r) => ({ key: r.key, topic: r.topic, critical: r.critical, status: r.status, value: r.value ?? null, confirmed: r.confirmed })),
        unresolved: iv.unresolved(),
      },
      blueprint: bp,
      blueprintHash: bp ? blueprintHash(bp) : null,
      blockers: bp ? buildBlockers(bp, this.registry.gateFacts()) : [],
      privacyPlan: p.privacyPlan,
      identityPlan: p.identityPlan,
      security: p.security ? { ...p.security, freshness: fresh(p.security) } : null,
      simulation: p.simulation ? { ...p.simulation, freshness: fresh(p.simulation) } : null,
      build: p.build ? { ...p.build, freshness: fresh(p.build) } : null,
    };
  }

  private row(p: ProjectRecord): ProjectRow {
    const bp = p.revisions.at(-1) ?? null;
    const current = (a: RevisionBound | null) => Boolean(a && bp && !isStale(a, bp));
    const stage: ProjectStage = !bp
      ? "INTERVIEW"
      : current(p.build)
        ? "BUILT"
        : current(p.simulation) && p.simulation!.passed
          ? "SIMULATED"
          : current(p.security)
            ? "REVIEWED"
            : "BLUEPRINT";
    return {
      projectId: p.projectId,
      name: p.name ?? (bp?.objective.summary ?? p.interview.objective).slice(0, 60),
      objective: p.interview.objective,
      createdAt: p.createdAt,
      stage,
      revision: bp?.revision ?? null,
      kidoAgentId: bp?.kidoAgentId ?? null,
      chains: bp?.chains ?? [],
      agents: bp?.agents.map((a) => a.role) ?? [],
    };
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
    // The blueprint records the agent's own names; specialists' subnames live in the identity plan.
    if (identityPlan.length) bp = nextRevision(bp, { identity: { ...bp.identity, bindings: identityPlan.filter((b) => !b.role).map((b) => ({ provider: b.providerId as "ens" | "suins", chain: b.chain, name: b.name, status: "PLANNED" as const })) } });
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

  /** Attack Lab: a hand-built action judged by the compiler and the Amane rules for this revision. */
  whatIf(projectId: string, w: WhatIf) {
    const bp = this.requireBlueprint(this.d.store.load(projectId));
    return evaluateWhatIf(bp, this.authority(bp), w);
  }

  /** Attack Lab: an injected instruction as a compromised specialist's plan, through every layer. */
  injection(projectId: string, t: { instruction: string; target: string; amount: string; chain?: string }) {
    const bp = this.requireBlueprint(this.d.store.load(projectId));
    return injectionTest(bp, this.authority(bp), t);
  }

  /**
   * The agent answering in its own words through the live model, grounded only in its self-model
   * (the model's one tool is introspection). Without a model configured this is BLOCKED_ENV and
   * callers fall back to the deterministic introspection.
   */
  async chat(projectId: string, question: string) {
    if (!process.env.OPENAI_API_KEY || !(process.env.KIDO_MODEL ?? process.env.OPENAI_MODEL)) throw new LifecycleError("BLOCKED_ENV", "no live model configured (OPENAI_API_KEY and OPENAI_MODEL)");
    this.requireBlueprint(this.d.store.load(projectId));
    const r = await new OpenAIAgentChat((q: string) => this.introspect(projectId, q) as never).ask(question);
    return { answer: r.answer, toolCalls: r.toolCalls, model: process.env.KIDO_MODEL ?? process.env.OPENAI_MODEL };
  }

  /** Deterministic answers about the agent from its self-model (bible §13.2). */
  introspect(projectId: string, question: string, runtime: RuntimeSnapshot = {}) {
    return introspect(this.selfModel(projectId, runtime), question);
  }

  selfModel(projectId: string, runtime: RuntimeSnapshot = {}) {
    const bp = this.requireBlueprint(this.d.store.load(projectId));
    return buildSelfModel(bp, runtime, this.providerStates(bp), this.executionFacts(bp));
  }

  /** Adapter, pinned upstream and on-chain enforcement for every allowed action, from the Amane manifest and registry. */
  private executionFacts(bp: KidoAgentBlueprint): ExecutionFact[] {
    type Fam = { adapters: { name: string; version: number; actionKind: string; upstream?: Record<string, unknown> }[]; pools?: Record<string, Record<string, unknown>> };
    const m = this.d.amaneManifest as unknown as { evm: Fam; sui: Fam };
    return bp.actions.map((a) => {
      const fam = a.chain === "ethereum-sepolia" ? m.evm : m.sui;
      const exec = this.registry.get(a.providerId)?.execution?.find((e) => e.action === a.action);
      const ad = fam.adapters.find((x) => x.actionKind === a.action && (!exec || x.name === exec.amaneAdapter));
      const pools = Object.values(fam.pools ?? {});
      const enforcement: string[] = ["action, adapter id, name and version must be in the owner-signed Root Policy and the active lease", "per-action, per-window and total budgets are debited on-chain"];
      if (a.action === "SWAP") enforcement.push(...bp.authority.swapFloors.filter((f) => f.chain === a.chain).map((f) => `output must be at least ${f.minOutPerIn} ${f.assetOut} per ${f.assetIn}; Amane measures the output it received and reverts below the floor`), "swap output can only return to the account", ...(ad?.upstream?.poolPinnedOnChain ? [`only pool ${String(ad.upstream.pool)}: the adapter aborts on any other pool, enforced on-chain`] : a.action === "SWAP" ? ["pool choice is made by Kido's executor; the owner floor bounds any pool's price"] : []));
      if (a.action === "REPAY") enforcement.push("only the pinned beneficiary's debt can be repaid", "Amane measures the beneficiary's variable-debt-token balance before and after and requires the fall to match the amount spent (minimum ratio pinned in the policy)");
      if (a.action === "PAY") enforcement.push("payments only to payees pinned in the policy; delivery measured on-chain");
      return {
        action: a.action,
        chain: a.chain,
        providerId: a.providerId,
        providerVersion: this.registry.get(a.providerId)?.version ?? "unknown",
        adapter: ad ? { name: ad.name, version: ad.version } : null,
        upstream: { ...(ad?.upstream ?? {}), ...(a.action === "SWAP" && pools.length ? { permittedPools: pools.map((p) => p.pool) } : {}) },
        enforcement,
      };
    });
  }

  /** Implementation state of every provider the blueprint relies on, straight from the registry. */
  private providerStates(bp: KidoAgentBlueprint): ProviderState[] {
    const uses: [string, string][] = [
      ...bp.protocols.map((p) => [p.providerId, "protocol"] as [string, string]),
      ...bp.privacy.providers.map((p) => [p.providerId, "privacy"] as [string, string]),
      ...bp.identity.bindings.map((b) => [b.provider, "identity"] as [string, string]),
      ...(bp.authority.provider === "AMANE" ? [["amane", "authority"] as [string, string]] : []),
      ...(bp.crossChain?.transports ?? []).map((t) => [t, "transport"] as [string, string]),
    ];
    const seen = new Set<string>();
    return uses.filter(([id, role]) => !seen.has(`${id}:${role}`) && (seen.add(`${id}:${role}`), true)).map(([id, role]) => {
      const m = this.registry.get(id);
      const b = m?.implementation.blocker;
      return {
        providerId: id,
        role,
        status: this.registry.implementationStatus(id),
        statusMeaning: IMPLEMENTATION_STATUS_MEANING[this.registry.implementationStatus(id)],
        live: this.registry.implementationLive(id),
        proven: m?.implementation.proven ?? [],
        notProven: m?.implementation.notProven ?? [],
        doesNotProvide: m?.implementation.doesNotProvide ?? [],
        blocker: b ? `${b.type}: ${b.actionRequired}` : null,
      };
    });
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
