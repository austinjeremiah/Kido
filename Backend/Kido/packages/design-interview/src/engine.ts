import { applyResolutions, emptyBlueprint, nextRevision, type KidoAgentBlueprint, type RequirementResolution } from "@kido/blueprint";
import { CATALOG, byKey, type Choice, type Ctx, type RequirementDef } from "./catalog.js";
import { RuleBasedInterviewModel, ruleBasedCandidates, type InterviewModel } from "./model.js";
import { parseByType, parseThreshold } from "./parse.js";
import type { InterviewTemplate, TemplateAsk } from "./templates.js";
import { privateThresholdDeclared, redactNumbers, redactSecrets } from "./sensitive.js";

export interface Question {
  key: string;
  topic: string;
  text: string;
  choices?: Choice[] | undefined;
  reask: boolean;
}

export interface TranscriptEntry {
  role: "user" | "kido";
  text: string;
  key?: string;
}

export interface InterviewState {
  projectId: string;
  salt: string;
  objective: string;
  resolutions: Record<string, RequirementResolution>;
  asked: Record<string, number>;
  questionsAsked: number;
  pending: string | null;
  transcript: TranscriptEntry[];
  warnings: string[];
  finalized: boolean;
  /** The resolutions revision an explicit edit replaced; the next revision commits to it. */
  prior?: KidoAgentBlueprint | null;
  /** Keys the user explicitly edited since `prior`. */
  edited?: string[];
  /** The interview template the user chose: only its questions are asked. */
  template?: { id: string; name: string; asks: TemplateAsk[] };
}

export interface InterviewOptions {
  maxQuestions: number;
}

const DEFAULTS: InterviewOptions = { maxQuestions: 14 };
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/**
 * Progressive design interview (bible §9). The authoritative state is `InterviewState`, persisted
 * as JSON; the model only reads text. Question order is a pure function of the catalog priority
 * buckets and what is already resolved, applicable and non-inferable.
 */
export class DesignInterview {
  private constructor(readonly state: InterviewState, private readonly model: InterviewModel, private readonly opts: InterviewOptions) {}

  static async start(projectId: string, salt: string, objective: string, model: InterviewModel, opts: Partial<InterviewOptions> & { template?: InterviewTemplate } = {}): Promise<DesignInterview> {
    const sec = redactSecrets(objective);
    objective = sec.text;
    const s: InterviewState = { projectId, salt, objective, resolutions: {}, asked: {}, questionsAsked: 0, pending: null, transcript: [{ role: "user", text: objective }], warnings: sec.found ? ["a credential-like value in the request was discarded; it was never stored or sent to a model"] : [], finalized: false };
    const iv = new DesignInterview(s, model, { ...DEFAULTS, ...opts });
    // A request that itself asks for privacy is read deterministically only: its details may be private.
    const privateRequest = ruleBasedCandidates(objective).some((c) => c.key === "privacy.required" && c.value === true);
    const extractor = privateRequest ? new RuleBasedInterviewModel() : model;
    for (const c of await extractor.extract(objective)) {
      const def = byKey(c.key);
      if (!def) continue;
      // An unclassifiable request is not a purpose: leave it for the objective question.
      if (c.key === "objective.kind" && c.value === "OTHER") continue;
      if (c.key !== "objective.kind" && !objective.toLowerCase().includes(c.quote.toLowerCase().trim())) {
        s.warnings.push(`dropped unquoted model candidate for ${c.key}`);
        continue;
      }
      iv.resolve(def, c.value, c.key === "objective.kind" ? { kind: "INFERRED", from: ["objective"], rule: "objective classification" } : { kind: "USER_ANSWER", quote: c.quote, turn: 0 });
    }
    iv.runInference();
    if (opts.template) iv.applyTemplate(opts.template);
    return iv;
  }

  /**
   * Applies a template's answers with the deterministic parsers, in catalog order (an answer can make
   * another requirement applicable), and limits the interview to the template's own questions.
   */
  private applyTemplate(t: InterviewTemplate) {
    const rule = new RuleBasedInterviewModel();
    const pending = new Set(Object.keys(t.presets));
    const reasons: Record<string, string> = {};
    // Passes until nothing more applies: a later answer can make an earlier one readable (a private
    // threshold is only read as private once the privacy answers are in).
    let progress = true;
    while (progress && pending.size) {
      progress = false;
      for (const d of CATALOG) {
        if (!pending.has(d.key) || !d.appliesWhen(this.ctx)) continue;
        const text = t.presets[d.key]!;
        const privateLevel = d.key === "monitor.condition" && privateThresholdDeclared(this.ctx);
        const parsed = privateLevel ? parseThreshold(`${text} 0`, this.ctx["objective.kind"] as never) : parseByType(d.answerType, text, this.ctx, d.question(this.ctx).choices);
        if (!parsed.ok) {
          reasons[d.key] = parsed.reason;
          continue;
        }
        pending.delete(d.key);
        progress = true;
        const value = privateLevel ? { ...(parsed.value as object), threshold: "PRIVATE" } : parsed.value;
        this.resolve(d, value, { kind: "TEMPLATE", template: t.id, answer: text.slice(0, 2000) });
        this.runInference();
      }
    }
    for (const k of pending) this.state.warnings.push(`template ${t.id}: ${k} ${reasons[k] ? `could not be applied (${reasons[k]})` : "does not apply to this agent"}`);
    this.state.template = { id: t.id, name: t.name, asks: t.asks };
    this.state.transcript.push({ role: "kido", text: `Using the "${t.name}" template: its answers are filled in for you to review before anything is built.` });
  }

  static restore(state: InterviewState, model: InterviewModel, opts: Partial<InterviewOptions> = {}): DesignInterview {
    return new DesignInterview(structuredClone(state), model, { ...DEFAULTS, ...opts });
  }

  get ctx(): Ctx {
    return Object.fromEntries(Object.values(this.state.resolutions).filter((r) => r.status === "RESOLVED").map((r) => [r.key, r.value]));
  }

  /** The next highest-value unresolved question, or null when nothing (askable) remains. */
  next(): Question | null {
    if (this.state.finalized) return null;
    if (this.state.template) {
      const ctx = this.ctx;
      const ask = this.state.template.asks.find((a) => this.state.resolutions[a.key]?.status !== "RESOLVED" && (this.state.asked[a.key] ?? 0) < 2 && byKey(a.key)?.appliesWhen(ctx));
      if (!ask) return null;
      const d = byKey(ask.key)!;
      const reask = (this.state.asked[d.key] ?? 0) > 0;
      this.state.pending = d.key;
      return { key: d.key, topic: d.topic, text: ask.text, choices: ask.amounts ? undefined : d.question(ctx).choices, reask };
    }
    if (this.state.questionsAsked >= this.opts.maxQuestions) return null;
    const ctx = this.ctx;
    const candidates = CATALOG.filter(
      (d) => d.class === "USER_REQUIRED" && d.appliesWhen(ctx) && !this.state.resolutions[d.key] && (this.state.asked[d.key] ?? 0) < 2,
    ).sort((a, b) => a.bucket - b.bucket || Number(b.critical) - Number(a.critical) || CATALOG.indexOf(a) - CATALOG.indexOf(b));
    const d = candidates[0];
    if (!d) return null;
    const q = d.question(ctx);
    const reask = (this.state.asked[d.key] ?? 0) > 0;
    this.state.pending = d.key;
    return { key: d.key, topic: d.topic, text: reask && q.choices ? `${q.text} (please pick one of the options)` : q.text, choices: q.choices, reask };
  }

  /** Records an answer to the pending question. Returns the next question (or null). */
  async answer(text: string): Promise<{ accepted: boolean; note?: string | undefined; next: Question | null }> {
    const key = this.state.pending;
    if (!key) throw new Error("no pending question");
    const def = byKey(key)!;
    const q = def.question(this.ctx);
    // Pasted credentials are dropped before anything is stored or sent to a model.
    const sec = redactSecrets(text);
    if (sec.found) this.state.warnings.push(`${key}: a credential-like value was typed and discarded; provide it to the secret provider directly`);
    text = sec.text;
    // A private threshold is read locally and never kept: only the metric and direction survive.
    const privateLevel = key === "monitor.condition" && privateThresholdDeclared(this.ctx);
    this.state.transcript.push({ role: "kido", text: q.text, key }, { role: "user", text: privateLevel ? redactNumbers(text) : text, key });
    this.state.asked[key] = (this.state.asked[key] ?? 0) + 1;
    if (this.state.asked[key] === 1) this.state.questionsAsked++;
    this.state.pending = null;
    if (privateLevel) {
      const p = parseThreshold(/\d/.test(text) ? text : `${text} 0`, this.ctx["objective.kind"] as never);
      if (!p.ok) return { accepted: false, note: p.reason, next: this.next() };
      if (/\d/.test(text)) this.state.warnings.push("monitor.condition: the private level was typed into the interview; it was not stored — enter it into the private provider");
      this.resolve(def, { ...(p.value as object), threshold: "PRIVATE" }, { kind: "USER_ANSWER", quote: redactNumbers(text), turn: this.state.questionsAsked });
      this.redactPrivateLevel();
      this.runInference();
      return { accepted: true, next: this.next() };
    }
    // A template question that fills several amounts at once ("100 per hour, 1000 total").
    const multi = this.state.template?.asks.find((a) => a.key === key && a.amounts);
    if (multi?.amounts) {
      const nums = text.match(NUMBER) ?? [];
      if (nums.length < multi.amounts.length) return { accepted: false, note: `give ${multi.amounts.length} amounts, for example: 100 per hour, 1000 total`, next: this.next() };
      const rule = new RuleBasedInterviewModel();
      for (const [i, k] of multi.amounts.entries()) {
        const d = byKey(k)!;
        const r = await rule.readAnswer(d, d.question(this.ctx), nums[i]!.replace(/,/g, ""), this.ctx);
        if (r.kind === "UNCLEAR") return { accepted: false, note: `${k}: ${r.reason}`, next: this.next() };
        this.resolve(d, r.value, { kind: "USER_ANSWER", quote: text.slice(0, 500), turn: this.state.questionsAsked });
        this.runInference();
      }
      return { accepted: true, next: this.next() };
    }
    const reading = await this.model.readAnswer(def, q, text, this.ctx);
    if (reading.kind === "UNCLEAR") {
      if (this.state.asked[key]! >= 2) this.markUnknown(def, `unclear after re-ask: ${reading.reason}`);
      return { accepted: false, note: reading.reason, next: this.next() };
    }
    const note = this.resolve(def, reading.value, { kind: "USER_ANSWER", quote: reading.quote, turn: this.state.questionsAsked });
    this.redactPrivateLevel();
    this.runInference();
    return { accepted: true, note, next: this.next() };
  }

  /** Explicit user edit of an already-resolved requirement (the only way to change a confirmed one). */
  async edit(key: string, text: string): Promise<{ accepted: boolean; note?: string | undefined }> {
    const def = byKey(key);
    if (!def) throw new Error(`unknown requirement ${key}`);
    const sec = redactSecrets(text);
    if (sec.found) this.state.warnings.push(`${key}: a credential-like value was typed and discarded; provide it to the secret provider directly`);
    text = sec.text;
    // Same rule as answers: a private level is parsed locally and never kept or shown to the model.
    const privateLevel = key === "monitor.condition" && privateThresholdDeclared(this.ctx);
    const parsed = privateLevel ? parseThreshold(/\d/.test(text) ? text : `${text} 0`, this.ctx["objective.kind"] as never) : null;
    const reading = parsed
      ? parsed.ok
        ? ({ kind: "ANSWERED", value: { ...(parsed.value as object), threshold: "PRIVATE" }, quote: redactNumbers(text) } as const)
        : ({ kind: "UNCLEAR", reason: parsed.reason } as const)
      : await this.model.readAnswer(def, def.question(this.ctx), text, this.ctx);
    if (reading.kind === "UNCLEAR") return { accepted: false, note: reading.reason };
    this.state.prior = this.resolutionsBlueprint();
    this.state.edited = [key];
    delete this.state.resolutions[key];
    // Anything derived from earlier answers is re-derived from the edited ones. (BREAK F-0525)
    for (const [k, r] of Object.entries(this.state.resolutions)) {
      const kind = r.provenance?.kind;
      if (kind === "SAFE_DEFAULT" || (kind === "INFERRED" && k !== "objective.kind")) delete this.state.resolutions[k];
    }
    this.state.finalized = false;
    const note = this.resolve(def, reading.value, { kind: "USER_ANSWER", quote: reading.quote, turn: this.state.questionsAsked });
    this.state.transcript.push({ role: "user", text: `edit ${key}: ${privateLevel ? redactNumbers(text) : text}`, key });
    this.redactPrivateLevel();
    this.runInference();
    return { accepted: true, note };
  }

  /** Applies visible safe defaults, records remaining unknowns, and returns the resolution list. */
  finalizeResolutions(): RequirementResolution[] {
    const ctx = this.ctx;
    for (const d of CATALOG) {
      if (this.state.resolutions[d.key] || !d.appliesWhen(ctx)) continue;
      const dv = d.safeDefault?.(ctx);
      if (dv !== undefined) {
        this.resolve(d, dv, { kind: "SAFE_DEFAULT", reason: "restrictive default, shown to the user for review" }, false);
      } else if (d.class === "USER_REQUIRED") {
        this.markUnknown(d, "not answered within the interview budget");
      }
    }
    this.state.finalized = true;
    return Object.values(this.state.resolutions).sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Produces the blueprint revision carrying every resolution (compilation into fields happens in `compile`). */
  resolutionsBlueprint(): KidoAgentBlueprint {
    const all = Object.values(this.state.resolutions);
    if (this.state.prior) {
      // An edit is a new revision of the one it replaces (BREAK F-0523); only the edited keys may change confirmed values.
      return nextRevision(this.state.prior, { requirements: [...all].sort((a, b) => a.key.localeCompare(b.key)) }, { allowConfirmedChange: this.state.edited ?? [] });
    }
    return applyResolutions(emptyBlueprint(this.state.projectId, this.state.salt, this.state.objective), all.map((resolution) => ({ resolution })));
  }

  unresolved(): { key: string; topic: string; critical: boolean }[] {
    const ctx = this.ctx;
    return CATALOG.filter((d) => d.class === "USER_REQUIRED" && d.appliesWhen(ctx) && this.state.resolutions[d.key]?.status !== "RESOLVED").map((d) => ({ key: d.key, topic: d.topic, critical: d.critical }));
  }

  private resolve(def: RequirementDef, value: unknown, provenance: RequirementResolution["provenance"], confirmed = true): string | undefined {
    const why = def.unsatisfiable?.(value);
    this.state.resolutions[def.key] = {
      key: def.key,
      topic: def.topic,
      // The class records how the value was reached, so the gate can tell a user decision from a derived one.
      class: provenance?.kind === "INFERRED" ? "INFERABLE" : provenance?.kind === "SAFE_DEFAULT" ? "SAFE_DEFAULT" : def.class,
      critical: def.critical,
      status: why ? "UNSATISFIABLE" : "RESOLVED",
      value: value as never,
      provenance,
      confirmed: confirmed && (provenance?.kind === "USER_ANSWER" || provenance?.kind === "TEMPLATE"),
    };
    if (why) this.state.warnings.push(`${def.key}: ${why}`);
    return why;
  }

  /** Declaring a private threshold after the condition was answered removes the level retroactively. */
  private redactPrivateLevel() {
    if (!privateThresholdDeclared(this.ctx)) return;
    const r = this.state.resolutions["monitor.condition"];
    if (r?.status === "RESOLVED" && (r.value as { threshold?: string }).threshold !== "PRIVATE") {
      this.state.resolutions["monitor.condition"] = { ...r, value: { ...(r.value as object), threshold: "PRIVATE" } as never, provenance: r.provenance?.kind === "USER_ANSWER" ? { ...r.provenance, quote: redactNumbers(r.provenance.quote) } : r.provenance };
      this.state.warnings.push("monitor.condition: the level became private after it was given; it was removed from the interview record");
    }
    // The request itself may state the level ("keep my 1.37 threshold private"): numbers leave it too.
    if (/\d/.test(this.state.objective)) {
      this.state.objective = redactNumbers(this.state.objective);
      this.state.warnings.push("objective: numbers were removed from the request because a private level is declared");
    }
    for (const t of this.state.transcript) if (t.key === "monitor.condition" || t.key === undefined) t.text = redactNumbers(t.text);
  }

  private markUnknown(def: RequirementDef, reason: string) {
    const dv = def.safeDefault?.(this.ctx);
    if (dv !== undefined) {
      this.resolve(def, dv, { kind: "SAFE_DEFAULT", reason: `restrictive default after: ${reason}` }, false);
      return;
    }
    this.state.resolutions[def.key] = { key: def.key, topic: def.topic, class: def.class, critical: def.critical, status: "UNKNOWN", confirmed: false };
    this.state.warnings.push(`${def.key}: ${reason}`);
  }

  private runInference() {
    for (let changed = true; changed; ) {
      changed = false;
      const ctx = this.ctx;
      for (const d of CATALOG) {
        if (this.state.resolutions[d.key] || !d.infer || !d.appliesWhen(ctx)) continue;
        const inf = d.infer(ctx);
        if (!inf) continue;
        this.resolve(d, inf.value, { kind: "INFERRED", from: inf.from, rule: inf.rule }, false);
        changed = true;
      }
    }
  }
}
