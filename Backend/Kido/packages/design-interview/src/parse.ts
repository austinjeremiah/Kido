import type { ChainId } from "@kido/blueprint";
import type { AnswerType, Ctx, ObjectiveKind } from "./catalog.js";
import { hasAffirmed, hasNegator, negatedAt } from "./negation.js";
import { isChainAddress } from "@kido/registry";
import { interviewChains, interviewRegistry } from "./registry.js";

const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const aliasRe = (aliases: string[]) => new RegExp(`\\b(${aliases.map(escape).join("|")})\\b`, "i");

export type Parsed = { ok: true; value: unknown } | { ok: false; reason: string };

const ok = (value: unknown): Parsed => ({ ok: true, value });
const bad = (reason: string): Parsed => ({ ok: false, reason });

const MAX_UNITS = 10n ** 30n;

/**
 * Three-valued: yes, no, or unclear. A refusal marker anywhere makes the answer "no" unless a yes
 * marker is also present, in which case it is unclear and gets re-asked. Consent is never inferred
 * from a sentence that also refuses.
 */
export function parseYesNo(s: string): Parsed {
  const t = s.trim().toLowerCase();
  const yes = /^(yes|yeah|yep|sure|ok|okay|correct|y|absolutely|of course|please do|that'?s right|right)(?=[\s,.!]*$|[,.!])/.test(t) || /\b(yes|allowed to|it may|it can|that'?s fine)\b/.test(t.replace(/\bnot allowed to\b/g, ""));
  const no = /\b(no|nope|never|not|n't|no way|disallow|forbid|refuse|must not|should not)\b/.test(t) || /^n$/.test(t);
  if (yes && no) return bad("the answer both agrees and refuses");
  if (no) return ok(false);
  if (yes) return ok(true);
  return bad("expected yes or no");
}

export function parseChains(s: string): Parsed {
  const all = interviewChains();
  if (hasAffirmed(s, /\b(both|all( of them)?)\b/i) && !hasNegator(s)) return ok(all.map((c) => c.chainId) satisfies ChainId[]);
  const hit = all.filter((c) => hasAffirmed(s, aliasRe(c.aliases))).map((c) => c.chainId);
  return hit.length ? ok(hit) : bad(`expected ${all.map((c) => c.label).join(", ")} or all`);
}

/** Human amount → token base units, with the asset chosen earlier. Exact integer arithmetic only. */
export function parseAmount(s: string, ctx: Ctx): Parsed {
  const t = s.replace(/\$/g, " ").trim();
  if (/(^|[\s(])-\s*\d/.test(t)) return bad("amount must be positive");
  if (/\d[eE][+-]?\d/.test(t) || /0x[0-9a-f]/i.test(t)) return bad("write the amount as a plain number");
  const m = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\d,.]*\d)\s*(k|thousand|m|million)?\b/i.exec(t);
  if (!m) return bad("expected an amount");
  if (/\d,\d{1,2}(?!\d)/.test(t)) return bad("ambiguous decimal comma");
  const symbol = ctx["assets.spend"] as string | undefined;
  if (!symbol) return bad("choose the token before setting amounts");
  const dec = interviewRegistry().decimalsOf(symbol);
  if (dec === undefined) return bad(`unknown decimals for ${symbol}`);
  const frac = m[2] ?? "";
  const scale = /^(k|thousand)$/i.test(m[3] ?? "") ? 3 : /^(m|million)$/i.test(m[3] ?? "") ? 6 : 0;
  if (frac.length > dec + scale) return bad("too many decimals for this token");
  const digits = BigInt(m[1]!.replace(/,/g, "") + frac);
  let units = digits * 10n ** BigInt(dec + scale);
  units /= 10n ** BigInt(frac.length);
  if (units <= 0n) return bad("amount must be positive");
  if (units > MAX_UNITS) return bad("amount is implausibly large");
  return ok(units.toString());
}

/** Picks one option from affirmed (non-negated) mentions only; ambiguous or negated-only answers are unclear. */
export function parseChoice(s: string, choices: { value: string; label: string }[], synonyms: Record<string, RegExp> = {}): Parsed {
  const t = s.toLowerCase();
  const hits = new Set<string>();
  for (const c of choices) {
    if (hasAffirmed(t, new RegExp(`\\b${c.value.toLowerCase().replace(/_/g, "[_ ]")}\\b`))) hits.add(c.value);
    if (hasAffirmed(t, new RegExp(c.label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))) hits.add(c.value);
  }
  if (hits.size === 0) for (const [v, re] of Object.entries(synonyms)) if (hasAffirmed(t, re)) hits.add(v);
  if (hits.size === 0) {
    const letter = /^\s*\(?([a-e])\)?(?=[\s.)]|$)/i.exec(s);
    if (letter) {
      const idx = letter[1]!.toLowerCase().charCodeAt(0) - 97;
      if (choices[idx]) hits.add(choices[idx]!.value);
    }
  }
  if (hits.size === 1) return ok([...hits][0]);
  if (hits.size > 1) return bad("more than one option matched");
  return bad("did not match any option");
}

export const MODE_SYNONYMS: Record<string, RegExp> = {
  READ_ONLY: /\b(watch|monitor|alert|notify|read[- ]only)\b/,
  PROPOSE_ONLY: /\b(suggest|propose|recommend)\b/,
  APPROVAL_REQUIRED: /\b(approve|approval|ask me|confirm (each|every))\b/,
  BOUNDED_AUTONOMOUS_FINANCE: /\b(on its own|autonomous(ly)?|automatically|by itself|within (the |my )?limits)\b/,
};

const ACTION_WORDS: [string, RegExp][] = [
  ["REPAY", /\b(repay\w*|pay (down|back|off))\b/i],
  ["SUPPLY", /\b(supply|add collateral|deposit collateral)\b/i],
  ["SWAP", /\b(swap\w*|trade\w*|exchange|rebalanc\w*)\b/i],
  ["PAY", /\b(?<!re)(pay|payment|payments|invoice|invoices)\b/i],
  ["BRIDGE", /\b(bridg\w*|move funds (across|between))\b/i],
  ["BORROW", /\bborrow\w*\b/i],
  ["WITHDRAW", /\bwithdraw\w*\b/i],
];

/** Affirmed actions only; when options were offered, anything outside them is dropped. */
export function parseActions(s: string, offered?: string[]): Parsed {
  const out = ACTION_WORDS.filter(([, re]) => hasAffirmed(s, re)).map(([a]) => a);
  const allowed = offered ? out.filter((a) => offered.includes(a)) : out;
  return allowed.length ? ok([...new Set(allowed)]) : bad(out.length ? "none of the offered actions was chosen" : "no recognizable action");
}

export function parseProtocols(s: string): Parsed {
  const protos = interviewRegistry().providers.filter((p) => p.kind === "protocol");
  const out = protos.filter((p) => hasAffirmed(s, aliasRe([p.providerId, ...p.aliases]))).map((p) => p.providerId);
  return out.length ? ok(out) : bad(`no supported protocol named (${protos.map((p) => p.displayName).join(", ")})`);
}

/** For a health factor the agent always acts when it falls below the stated level ("keep it above 1.6"). */
export function parseThreshold(s: string, kind?: ObjectiveKind): Parsed {
  const t = s.toLowerCase();
  const n = /(\d+(?:\.\d+)?)\s*(%|percent|bps)?/.exec(t);
  if (!n) return bad("expected a number");
  const metric = /health|\bhf\b/.test(t) || kind === "LENDING_PROTECTION" ? "HEALTH_FACTOR" : /drift|allocation|%|percent/.test(t) || kind === "REBALANCE" ? "ALLOCATION_DRIFT" : "VALUE";
  if (metric === "HEALTH_FACTOR") return ok({ metric, op: "LT", threshold: n[1] });
  if (metric === "ALLOCATION_DRIFT") return ok({ metric, op: "DRIFT_GT", threshold: n[1] });
  const keepAbove = /\b(keep|stay|maintain|remain)\b[^.]*\b(above|over)\b/.test(t);
  const op = !keepAbove && /\b(above|over|exceeds|greater|more than)\b|>/.test(t) ? "GT" : "LT";
  return ok({ metric, op, threshold: n[1] });
}

export function parsePayees(s: string): Parsed {
  const out: { label: string; chain: ChainId; address: string }[] = [];
  const re = /([A-Za-z][\w .-]{0,40}?)\s*[:=-]?\s*(0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40})\b/g;
  for (const m of s.matchAll(re)) {
    if (negatedAt(s, m.index ?? 0) || negatedAt(s, (m.index ?? 0) + m[0].length - m[2]!.length)) continue;
    const addr = m[2]!;
    const label = m[1]!.trim().replace(/\s+(on|at)$/i, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    const chain = interviewChains().find((c) => isChainAddress(c.chainId, addr, interviewChains()))?.chainId;
    if (!chain) continue;
    out.push({ label: label || `payee-${out.length + 1}`, chain, address: addr });
  }
  return out.length ? ok(out) : bad("expected name + address pairs");
}

export function parsePrivacyValues(s: string): Parsed {
  const m: [RegExp, string, string][] = [
    [/api key|credential|token secret|password/i, "PRIVATE_API_CREDENTIAL", "api-credential"],
    [/threshold|limit|trigger level/i, "PRIVATE_POLICY", "risk-threshold"],
    [/strategy|parameter/i, "PRIVATE_STRATEGY", "strategy-parameters"],
    [/api (response|result|data)|external data|risk (api|score)/i, "PRIVATE_API_RESPONSE", "api-response"],
    [/customer|personal|dataset|private data/i, "PRIVATE_INPUT", "private-input"],
    [/model (input|context|prompt)|what the (ai|model) sees/i, "PRIVATE_MODEL_CONTEXT", "model-context"],
    [/state|memory|stored/i, "ENCRYPTED_STATE", "persistent-state"],
  ];
  const out = m.filter(([re]) => hasAffirmed(s, re)).map(([, kind, id]) => ({ id, kind, description: id.replace(/-/g, " ") }));
  return out.length ? ok(out) : bad("no recognizable sensitive item");
}

export function parseHiddenFrom(s: string): Parsed {
  const out = new Set<string>();
  const exceptEnclave = /(everyone|all) except|only (the )?(enclave|tee)/i.test(s);
  if (exceptEnclave) out.add("EVERYONE_EXCEPT_APPROVED_ENCLAVE");
  const a = (re: RegExp) => exceptEnclave ? re.test(s) : hasAffirmed(s, re);
  if (a(/public|everyone|chain|world/i)) out.add("PUBLIC_CHAIN");
  if (a(/other users|other customers/i)) out.add("OTHER_USERS");
  if (a(/\b(ai|agent|model|llm)\b/i)) out.add("AI_AGENT");
  if (a(/kido|backend|server|platform|operator/i)) out.add("NORMAL_KIDO_BACKEND");
  if (a(/cloud|host|aws/i)) out.add("CLOUD_HOST");
  if (a(/adapter|protocol/i)) out.add("PROTOCOL_ADAPTER");
  return out.size ? ok([...out]) : bad("no recognizable audience");
}

export function parsePlaintext(s: string): Parsed {
  const opts: [string, RegExp][] = [
    ["APPROVED_ENCLAVE", /enclave|\btee\b|secure hardware|attested/i],
    ["DON", /\bdon\b|chainlink/i],
    ["USER_DEVICE", /my (device|machine|laptop|computer)|only me|locally/i],
    ["KIDO_SECRET_STORE", /kido|secret store|server|backend/i],
    ["NONE", /nowhere|nobody/i],
  ];
  const hits = opts.filter(([, re]) => hasAffirmed(s, re)).map(([v]) => v);
  if (hits.length === 1) return ok(hits[0]);
  if (hits.length > 1) return bad("more than one location named");
  return bad("expected device, secret store, enclave or nowhere");
}

export function parseObjectiveKind(s: string): ObjectiveKind {
  const t = s.toLowerCase();
  if (/protect|health factor|liquidat|lending position|loan/.test(t)) return "LENDING_PROTECTION";
  if (/drift|rebalanc|allocation/.test(t)) return "REBALANCE";
  if (/pay|invoice|payroll|vendor/.test(t)) return "PAYMENTS";
  if (/liquidity/.test(t)) return "LIQUIDITY";
  if (/treasury/.test(t)) return "TREASURY";
  if (/monitor|watch|alert|notify/.test(t)) return "MONITORING";
  if (/research|summar|report|analy/.test(t)) return "RESEARCH";
  return "OTHER";
}

/** "at least 0.95 AMSUI for each AMUSD" → { minOutPerIn: "0.95", assetOut: "AMSUI", assetIn: "AMUSD" }. */
export function parseSwapFloor(s: string): Parsed {
  const m = /(\d+(?:\.\d+)?)\s*([A-Za-z]{2,10})\s*(?:for|per)\s*(?:each|every|one|1|a)?\s*([A-Za-z]{2,10})/i.exec(s);
  if (!m) return bad("expected a rate like '0.95 AMSUI per AMUSD'");
  if (Number(m[1]) <= 0) return bad("rate must be positive");
  return ok({ minOutPerIn: m[1], assetOut: m[2]!.toUpperCase(), assetIn: m[3]!.toUpperCase() });
}

/** Seconds from "7200", "2 hours", "90 minutes". */
export function parseDuration(s: string): Parsed {
  const m = /(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?)?\b/i.exec(s);
  if (!m) return bad("expected a duration");
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const secs = Math.round(unit.startsWith("h") ? n * 3600 : unit.startsWith("m") ? n * 60 : n);
  if (secs < 60 || secs > 86_400) return bad("lease lifetime must be between 1 minute and 24 hours");
  return ok(secs);
}

export function parseByType(type: AnswerType, text: string, ctx: Ctx, choices?: { value: string; label: string }[]): Parsed {
  switch (type) {
    case "yesno": return parseYesNo(text);
    case "swap_floor": return parseSwapFloor(text);
    case "duration": return parseDuration(text);
    case "chains": return parseChains(text);
    case "amount": return parseAmount(text, ctx);
    case "actions": return parseActions(text, choices?.map((c) => c.value));
    case "protocols": return parseProtocols(text);
    case "threshold": return parseThreshold(text, ctx["objective.kind"] as ObjectiveKind | undefined);
    case "payees": return parsePayees(text);
    case "privacy_values": return parsePrivacyValues(text);
    case "hidden_from": return parseHiddenFrom(text);
    case "plaintext": return parsePlaintext(text);
    case "objective_kind": return ok(parseObjectiveKind(text));
    case "identity_name": {
      const name = text.trim().toLowerCase().replace(/[^a-z0-9. -]/g, "").replace(/\s+/g, "-");
      return name.length >= 3 ? ok(name.slice(0, 63)) : bad("name too short");
    }
    case "asset": return parseChoice(text, choices ?? []);
    case "authority_mode": return parseChoice(text, choices ?? [], MODE_SYNONYMS);
    case "autonomy": return parseChoice(text, choices ?? [], { OWNER_APPROVAL: /approv|ask me/, VERIFIABLE_CONDITION: /condition|verif|prove|only when/, AUTOMATIC: /automatic|always|whenever/ });
    case "recovery": return parseChoice(text, choices ?? [{ value: "FAIL_CLOSED", label: "keep" }], { WAKE_RECOVERY_AGENT: /\brecover\w*|try again|within (my )?limits/, HALT_AND_NOTIFY: /\b(stop|halt|notify|tell me)\b/, FAIL_CLOSED: /\b(keep|yes|fine|ok)\b/ });
    case "disclosure": return parseChoice(text, choices ?? [], { DECISION_ONLY: /decision|act or not|whether to act/, BOOLEAN_RESULT: /yes\/no|boolean|true|false/, BUCKETED_RESULT: /range|bucket|rough/, REDACTED_RESULT: /redact/, FULL_RESULT: /\bfull\b|everything|all of it/, COMMITMENT_ONLY: /commit\w*|hash/ });
  }
}

