import { applyResolutions, emptyBlueprint, type KidoAgentBlueprint, type RequirementResolution } from "@kido/blueprint";
import { CATALOG, byKey, type Choice, type Ctx, type RequirementDef } from "./catalog.js";
import type { InterviewModel } from "./model.js";

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
}

export interface InterviewOptions {
  maxQuestions: number;
}

const DEFAULTS: InterviewOptions = { maxQuestions: 14 };

/**
 * Progressive design interview (bible §9). The authoritative state is `InterviewState`, persisted
 * as JSON; the model only reads text. Question order is a pure function of the catalog priority
 * buckets and what is already resolved, applicable and non-inferable.
 */
export class DesignInterview {
  private constructor(readonly state: InterviewState, private readonly model: InterviewModel, private readonly opts: InterviewOptions) {}

  static async start(projectId: string, salt: string, objective: string, model: InterviewModel, opts: Partial<InterviewOptions> = {}): Promise<DesignInterview> {
    const s: InterviewState = { projectId, salt, objective, resolutions: {}, asked: {}, questionsAsked: 0, pending: null, transcript: [{ role: "user", text: objective }], warnings: [], finalized: false };
    const iv = new DesignInterview(s, model, { ...DEFAULTS, ...opts });
    for (const c of await model.extract(objective)) {
      const def = byKey(c.key);
      if (!def) continue;
      if (c.key !== "objective.kind" && !objective.toLowerCase().includes(c.quote.toLowerCase().trim())) {
        s.warnings.push(`dropped unquoted model candidate for ${c.key}`);
        continue;
      }
      iv.resolve(def, c.value, c.key === "objective.kind" ? { kind: "INFERRED", from: ["objective"], rule: "objective classification" } : { kind: "USER_ANSWER", quote: c.quote, turn: 0 });
    }
    iv.runInference();
    return iv;
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
    this.state.transcript.push({ role: "kido", text: q.text, key }, { role: "user", text, key });
    this.state.asked[key] = (this.state.asked[key] ?? 0) + 1;
    if (this.state.asked[key] === 1) this.state.questionsAsked++;
    this.state.pending = null;
    const reading = await this.model.readAnswer(def, q, text, this.ctx);
    if (reading.kind === "UNCLEAR") {
      if (this.state.asked[key]! >= 2) this.markUnknown(def, `unclear after re-ask: ${reading.reason}`);
      return { accepted: false, note: reading.reason, next: this.next() };
    }
    const note = this.resolve(def, reading.value, { kind: "USER_ANSWER", quote: reading.quote, turn: this.state.questionsAsked });
    this.runInference();
    return { accepted: true, note, next: this.next() };
  }

  /** Explicit user edit of an already-resolved requirement (the only way to change a confirmed one). */
  async edit(key: string, text: string): Promise<{ accepted: boolean; note?: string | undefined }> {
    const def = byKey(key);
    if (!def) throw new Error(`unknown requirement ${key}`);
    const reading = await this.model.readAnswer(def, def.question(this.ctx), text, this.ctx);
    if (reading.kind === "UNCLEAR") return { accepted: false, note: reading.reason };
    delete this.state.resolutions[key];
    const note = this.resolve(def, reading.value, { kind: "USER_ANSWER", quote: reading.quote, turn: this.state.questionsAsked });
    this.state.transcript.push({ role: "user", text: `edit ${key}: ${text}`, key });
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
    const bp = emptyBlueprint(this.state.projectId, this.state.salt, this.state.objective);
    return applyResolutions(bp, Object.values(this.state.resolutions).map((resolution) => ({ resolution })));
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
      class: def.class,
      critical: def.critical,
      status: why ? "UNSATISFIABLE" : "RESOLVED",
      value: value as never,
      provenance,
      confirmed: confirmed && provenance?.kind === "USER_ANSWER",
    };
    if (why) this.state.warnings.push(`${def.key}: ${why}`);
    return why;
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
