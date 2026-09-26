import { DesignInterview, RuleBasedInterviewModel, compileBlueprint, type InterviewModel, type Question } from "../src/index.js";

export const model = new RuleBasedInterviewModel();
export const EVM_A = `0x${"11".repeat(20)}`;
export const EVM_B = `0x${"22".repeat(20)}`;
export const SUI_A = `0x${"ab".repeat(32)}`;

/** Conservative answers for any question a test does not care about. */
const DEFAULTS: Record<string, string> = {
  "authority.mode": "act on its own within limits I set",
  "authority.withdraw": "no",
  "authority.arbitrary_recipients": "no, only approved ones",
  "authority.bridge": "no",
  "authority.autonomy": "automatically",
  "actions.allowed": "swap tokens",
  protocols: "Uniswap",
  chains: "Ethereum",
  payees: `acme: ${EVM_A}`,
  beneficiary: `my wallet ${EVM_B}`,
  "assets.spend": "AMUSD",
  "limits.window": "100",
  "limits.total": "400",
  "limits.swap_floor": "at least 0.95 AMSUI for each AMUSD",
  "identity.public": "no",
  "identity.name": "acme agent",
  "privacy.required": "no",
  "privacy.values": "an api key",
  "privacy.hidden_from": "the public",
  "privacy.plaintext": "only my device",
  "privacy.disclosure": "only the decision",
  "monitor.condition": "drift above 5%",
  "rebalance.target": "keep 50%",
  "recovery.partial": "stop and notify me",
};

/** Drives an interview with a scripted user who answers by requirement key. */
export async function drive(objective: string, answers: Record<string, string>, m: InterviewModel = model) {
  const iv = await DesignInterview.start("proj", "salt", objective, m);
  const asked: Question[] = [];
  let q = iv.next();
  while (q) {
    asked.push(q);
    const a = answers[q.key] ?? DEFAULTS[q.key];
    if (a === undefined) throw new Error(`unexpected question ${q.key}: ${q.text}`);
    q = (await iv.answer(a)).next;
  }
  iv.finalizeResolutions();
  return { iv, asked, bp: compileBlueprint(iv.resolutionsBlueprint()) };
}
