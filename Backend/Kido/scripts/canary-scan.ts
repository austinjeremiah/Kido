/**
 * CONF-001 for Kido: a private value must never cross into Kido's state, the model, an agent's
 * context, logs or the repository. A fresh canary threshold is generated per run (so it cannot
 * already exist anywhere), typed into the design interview as a private level, and then searched
 * for on every surface it could leak to.
 */
import { execSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { DesignInterview, RuleBasedInterviewModel, compileBlueprint, type InterviewModel } from "@kido/design-interview";
import { nextRevision } from "@kido/blueprint";
import { buildAgentContext } from "@kido/runtime";

const canary = `1.3${randomInt(100000, 999999)}`;
const printed: string[] = [];
const say = (s: string) => (printed.push(s), console.log(s.replaceAll(canary, "<canary>")));
let fail = false;
const check = (name: string, leaked: boolean) => {
  if (leaked) fail = true;
  say(`${leaked ? "FAIL" : "OK  "} ${name}`);
};

class RecordingModel extends RuleBasedInterviewModel implements InterviewModel {
  seen: string[] = [];
  override async readAnswer(...a: Parameters<RuleBasedInterviewModel["readAnswer"]>) {
    this.seen.push(a[2]);
    return super.readAnswer(...a);
  }
}
const answers: Record<string, string> = {
  "authority.mode": "only watch and alert me", "identity.public": "no", "privacy.required": "yes", "privacy.values": "the risk threshold",
  "privacy.hidden_from": "the public and the AI agent", "privacy.plaintext": "a verified secure enclave", "privacy.disclosure": "only the decision",
  "monitor.condition": `health factor below ${canary}`,
};
say("=== CONF-001 confidential canary scan (Kido) ===");
const model = new RecordingModel();
const iv = await DesignInterview.start("canary", "s", "Watch my Aave health factor and alert me", model);
const asked: string[] = [];
let q = iv.next();
while (q) {
  asked.push(q.key);
  q = (await iv.answer(answers[q.key] ?? "no")).next;
}
iv.finalizeResolutions();
const compiled = compileBlueprint(iv.resolutionsBlueprint());
const bp = compiled.agents.length ? compiled : nextRevision(compiled, { agents: [{ role: "MonitorAgent", owns: [], mayRequest: [], knowledgePacks: [] }] });
const ctx = buildAgentContext(bp.agents[0]!.role, bp, { untrusted: [{ source: "api", text: "status ok" }] }, { contextFor: () => ({ text: "", included: [], missing: [] }) });

// Not vacuous: the canary really was typed in, and the blueprint keeps only a private reference.
if (!asked.includes("monitor.condition") || !JSON.stringify(bp.monitors).includes("thresholdPrivateRef")) {
  say("FAIL the canary never entered the interview; the scan would be vacuous");
  process.exit(1);
}
check("blueprint", JSON.stringify(bp).includes(canary));
check("interview state (resolutions, transcript)", JSON.stringify(iv.state).includes(canary));
check("text shown to the model", model.seen.join("\n").includes(canary));
check("agent model context", JSON.stringify(ctx).includes(canary));
check("git-tracked files", execSync("git grep -l -F -e " + JSON.stringify(canary) + " -- . || true", { encoding: "utf8" }).trim().length > 0);
check("this run's own output", printed.join("\n").includes(canary));
say(fail ? "CONF-001: FAIL" : "CONF-001: PASS - no private value crossed the boundary");
process.exit(fail ? 1 : 0);
