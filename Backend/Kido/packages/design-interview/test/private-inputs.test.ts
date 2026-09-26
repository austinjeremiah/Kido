import { describe, expect, it } from "vitest";
import { DesignInterview, RuleBasedInterviewModel, compileBlueprint, type InterviewModel } from "../src/index.js";

/** Rule-based model that records every text it is shown (stands in for a live model). */
class RecordingModel extends RuleBasedInterviewModel implements InterviewModel {
  seen: string[] = [];
  override async readAnswer(...a: Parameters<RuleBasedInterviewModel["readAnswer"]>) {
    this.seen.push(a[2]);
    return super.readAnswer(...a);
  }
  override async extract(objective: string) {
    this.seen.push(objective);
    return super.extract(objective);
  }
}

async function run(objective: string, answers: Record<string, string>) {
  const m = new RecordingModel();
  const iv = await DesignInterview.start("p", "s", objective, m);
  let q = iv.next();
  while (q) q = (await iv.answer(answers[q.key] ?? "no")).next;
  iv.finalizeResolutions();
  return { iv, m, bp: compileBlueprint(iv.resolutionsBlueprint()) };
}

const PRIVATE = { "authority.mode": "only watch and alert me", "identity.public": "no", "privacy.required": "yes", "privacy.values": "the risk threshold", "privacy.hidden_from": "the public and the AI agent", "privacy.plaintext": "a verified secure enclave", "privacy.disclosure": "only the decision" };

describe("private inputs never enter Kido or the model", () => {
  it("a private threshold typed into the interview is not stored or shown to the model", async () => {
    const { iv, m, bp } = await run("Watch my Aave health factor and alert me", { ...PRIVATE, "monitor.condition": "health factor below 1.37" });
    expect(JSON.stringify(bp)).not.toContain("1.37");
    expect(JSON.stringify(iv.state)).not.toContain("1.37");
    expect(m.seen.join("\n")).not.toContain("1.37");
    expect(bp.monitors[0]).toMatchObject({ metric: "HEALTH_FACTOR", op: "LT", threshold: null, thresholdPrivateRef: "risk-threshold" });
    expect(iv.state.warnings.join(" ")).toMatch(/not stored/);
  });

  it("the condition question asks for metric and direction only once the level is private", async () => {
    const m = new RecordingModel();
    const iv = await DesignInterview.start("p", "s", "Watch my Aave health factor and alert me", m);
    let q = iv.next();
    let text = "";
    while (q) {
      if (q.key === "monitor.condition") text = q.text;
      q = (await iv.answer((PRIVATE as Record<string, string>)[q.key] ?? (q.key === "monitor.condition" ? "health factor falling below my level" : "no"))).next;
    }
    expect(text).toMatch(/Do not type your private level/);
  });

  it("a level given before privacy is declared is removed retroactively", async () => {
    const m = new RecordingModel();
    const iv = await DesignInterview.start("p", "s", "Watch my Aave health factor and alert me", m);
    // Answer the condition first by editing it in, then declare the threshold private.
    await iv.edit("monitor.condition", "health factor below 1.29");
    let q = iv.next();
    while (q) q = (await iv.answer((PRIVATE as Record<string, string>)[q.key] ?? "no")).next;
    iv.finalizeResolutions();
    expect(JSON.stringify(iv.state.resolutions)).not.toContain("1.29");
    expect(JSON.stringify(iv.state.transcript)).not.toContain("1.29");
  });

  it("an edit of a private level after declaration is parsed locally and not stored", async () => {
    const { iv, m } = await run("Watch my Aave health factor and alert me", { ...PRIVATE, "monitor.condition": "health factor below my level" });
    const seenBefore = m.seen.length;
    expect((await iv.edit("monitor.condition", "health factor below 1.44")).accepted).toBe(true);
    expect(m.seen.slice(seenBefore).join()).not.toContain("1.44");
    expect(JSON.stringify(iv.state)).not.toContain("1.44");
  });

  it("a pasted API key is discarded, never stored or forwarded", async () => {
    const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUv0123456789";
    const { iv, m } = await run("Watch my Aave health factor and alert me", { ...PRIVATE, "privacy.values": `the API key, it is ${key}`, "monitor.condition": "health factor below 1.5" });
    expect(JSON.stringify(iv.state)).not.toContain(key);
    expect(m.seen.join("\n")).not.toContain(key);
    expect(iv.state.warnings.join(" ")).toMatch(/credential-like value was typed and discarded/);
  });

  it("a request that asks for privacy is read deterministically, never by the model", async () => {
    const objective = "Keep my 1.37 threshold private and alert me when my Aave health factor drops";
    const { m, iv, bp } = await run(objective, { ...PRIVATE, "monitor.condition": "health factor below it" });
    expect(m.seen).not.toContain(objective); // extract went to the deterministic reader, not the model
    expect(m.seen.join("\n")).not.toContain("1.37");
    expect(JSON.stringify(iv.state)).not.toContain("1.37");
    expect(JSON.stringify(bp)).not.toContain("1.37");
  });
});
