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

/** The spend assets chosen earlier; a single asset may be stored as a plain symbol. */
export const spendAssets = (ctx: Ctx): string[] => {
  const v = ctx["assets.spend"];
  return Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : [];
};

/** An amount per spend asset in base units: a plain string for one asset, a symbol → units map for several. */
export type AmountValue = string | Record<string, string>;
export const amountFor = (v: AmountValue | undefined, asset: string): string | undefined => (typeof v === "string" ? v : v?.[asset]);

/**
 * Human amount → base units of each spend asset (the same nominal amount of each), with exact
 * integer arithmetic only.
 */
export function parseAmount(s: string, ctx: Ctx): Parsed {
  const t = s.replace(/\$/g, " ").trim();
  if (/(^|[\s(])-\s*\d/.test(t)) return bad("amount must be positive");
  if (/\d[eE][+-]?\d/.test(t) || /0x[0-9a-f]/i.test(t)) return bad("write the amount as a plain number");
  const m = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\d,.]*\d)\s*(k|thousand|m|million)?\b/i.exec(t);
  if (!m) return bad("expected an amount");
  if (/\d,\d{1,2}(?!\d)/.test(t)) return bad("ambiguous decimal comma");
  const symbols = spendAssets(ctx);
  if (!symbols.length) return bad("choose the token before setting amounts");
  const frac = m[2] ?? "";
  const scale = /^(k|thousand)$/i.test(m[3] ?? "") ? 3 : /^(m|million)$/i.test(m[3] ?? "") ? 6 : 0;
  const digits = BigInt(m[1]!.replace(/,/g, "") + frac);
  const out: Record<string, string> = {};
  for (const symbol of symbols) {
    const dec = interviewRegistry().decimalsOf(symbol);
    if (dec === undefined) return bad(`unknown decimals for ${symbol}`);
    if (frac.length > dec + scale) return bad(`too many decimals for ${symbol}`);
    const units = (digits * 10n ** BigInt(dec + scale)) / 10n ** BigInt(frac.length);
    if (units <= 0n) return bad("amount must be positive");
    if (units > MAX_UNITS) return bad("amount is implausibly large");
    out[symbol] = units.toString();
  }
  return ok(symbols.length === 1 ? out[symbols[0]!] : out);
}

/** One or more offered assets, from affirmed mentions only; "all"/"both" picks every offered one. */
export function parseAssets(s: string, choices: { value: string; label: string }[]): Parsed {
  const all = hasAffirmed(s, /\b(both|all( of them)?|either)\b/i) && !hasNegator(s);
  const hits = all ? choices.map((c) => c.value) : choices.filter((c) => hasAffirmed(s, aliasRe([c.value]))).map((c) => c.value);
  if (!hits.length) return parseChoice(s, choices);
  return ok(hits.length === 1 ? hits[0] : hits);
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
  const metric = /health|\bhf\b/.test(t) || kind === "LENDING_PROTECTION" ? "HEALTH_FACTOR" : /drift|allocation|%|percent/.test(t) || kind === "REBALANCE" || kind === "TRADING" ? "ALLOCATION_DRIFT" : "VALUE";
  if (metric === "HEALTH_FACTOR") return ok({ metric, op: "LT", threshold: n[1] });
  if (metric === "ALLOCATION_DRIFT") return ok({ metric, op: "DRIFT_GT", threshold: n[1] });
  const keepAbove = /\b(keep|stay|maintain|remain)\b[^.]*\b(above|over)\b/.test(t);
  const op = !keepAbove && /\b(above|over|exceeds|greater|more than)\b|>/.test(t) ? "GT" : "LT";
  return ok({ metric, op, threshold: n[1] });
}

export function parsePayees(s: string): Parsed {
  // Anything that looks like an address but is valid on no chain is a typo to re-ask, never silently dropped.
  for (const tok of s.match(/0x[0-9a-fA-F]{38,}/g) ?? []) {
    if (!interviewChains().some((c) => isChainAddress(c.chainId, tok, interviewChains()))) return bad(`${tok.slice(0, 10)}… (${tok.length - 2} hex digits) is not a valid address on ${interviewChains().map((c) => c.label).join(" or ")}`);
  }
  const chainWords = new Set(interviewChains().flatMap((c) => [c.label.toLowerCase(), ...c.aliases]));
  const named = [...s.matchAll(/\b([A-Z][A-Za-z0-9&]{1,30})\b/g)].map((m) => m[1]!).find((w) => !chainWords.has(w.toLowerCase()) && !/^(only|pay|the|it|and|or|may|be|my|our|on|at|to)$/i.test(w));
  const out: { label: string; chain: ChainId; address: string }[] = [];
  const re = /(?:([A-Za-z][\w .-]{0,40}?)\s*[:=-]?\s*[`'"]?)?(0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40})\b/g;
  for (const m of s.matchAll(re)) {
    if (negatedAt(s, m.index ?? 0) || negatedAt(s, (m.index ?? 0) + m[0].length - m[2]!.length)) continue;
    const addr = m[2]!;
    let label = (m[1] ?? "").trim().replace(/\s+(on|at)$/i, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    if (!label || chainWords.has(label)) label = named ? named.toLowerCase().replace(/[^a-z0-9-]+/g, "-") : "";
    const chain = interviewChains().find((c) => isChainAddress(c.chainId, addr, interviewChains()))?.chainId;
    if (!chain) continue;
    out.push({ label: label || `payee-${out.length + 1}`, chain, address: addr });
  }
  return out.length ? ok(out) : bad("expected name + address pairs");
}

/** The one wallet whose debt REPAY may reduce; an address the user refuses is never taken. */
export function parseBeneficiary(s: string): Parsed {
  const p = parsePayees(s);
  if (!p.ok) return bad("expected the wallet address that holds the loan");
  const all = p.value as { label: string; chain: ChainId; address: string }[];
  if (all.length !== 1) return bad("name exactly one wallet");
  return ok({ label: "owner position", chain: all[0]!.chain, address: all[0]!.address });
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
  if (/\btrad(e|es|er|ing)\b|\bswap|\bexchange\b/.test(t)) return "TRADING";
  if (/pay|invoice|payroll|vendor/.test(t)) return "PAYMENTS";
  if (/liquidity/.test(t)) return "LIQUIDITY";
  if (/treasury/.test(t)) return "TREASURY";
  if (/monitor|watch|alert|notify/.test(t)) return "MONITORING";
  if (/research|summar|report|analy/.test(t)) return "RESEARCH";
  return "OTHER";
}

/** Whether payments may go to anyone or only to recipients approved in advance; a refusal of "anyone" means approved only. */
export function parseRecipientsScope(s: string): Parsed {
  const anyone = hasAffirmed(s, /\b(anyone|anybody|whoever|any recipient|anywhere|everyone|whomever)\b/i) || /^\s*(yes|yeah|yep|sure)\b/i.test(s);
  const approved = hasAffirmed(s, /\b(only|approved?|in advance|specific|listed|named|just|pre-?approved|allow ?list)\b/i) || /\b(not|never|no)\b[^.]{0,20}\b(anyone|anybody)\b/i.test(s) || /^\s*(no|nope)\b/i.test(s);
  if (anyone && !approved) return ok("ANYONE");
  if (approved && !anyone) return ok("APPROVED_ONLY");
  return bad("say whether it may pay anyone, or only recipients you approve");
}

/** "keep 60% in AMUSD" / "half" → { asset, share: "0.6" } (asset defaults to the spend asset). */
export function parseAllocation(s: string, ctx: Ctx): Parsed {
  const pct = /(\d{1,3}(?:\.\d+)?)\s*(%|percent)/i.exec(s);
  const share = pct ? Number(pct[1]) / 100 : /\bhalf\b/i.test(s) ? 0.5 : /\ba third\b/i.test(s) ? 1 / 3 : /\ba quarter\b/i.test(s) ? 0.25 : NaN;
  if (!Number.isFinite(share) || share <= 0 || share >= 1) return bad("give a share between 0% and 100%, e.g. 50%");
  const known = interviewRegistry().assets.map((a) => a.symbol);
  const named = known.find((sym) => hasAffirmed(s, new RegExp(`\\b${sym}\\b`, "i")));
  const asset = named ?? spendAssets(ctx)[0];
  if (!asset) return bad("which token should that share be held in?");
  return ok({ asset, share: share.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") });
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
    case "beneficiary": return parseBeneficiary(text);
    case "privacy_values": return parsePrivacyValues(text);
    case "hidden_from": return parseHiddenFrom(text);
    case "plaintext": return parsePlaintext(text);
    case "objective_kind": {
      const k = parseObjectiveKind(text);
      return k === "OTHER" ? bad("could not tell what the agent should do") : ok(k);
    }
    case "recipients_scope": return parseRecipientsScope(text);
    case "allocation": return parseAllocation(text, ctx);
    case "identity_name": {
      const name = text.trim().toLowerCase().replace(/[^a-z0-9. -]/g, "").replace(/\s+/g, "-");
      return name.length >= 3 ? ok(name.slice(0, 63)) : bad("name too short");
    }
    case "asset": return parseAssets(text, choices ?? []);
    case "authority_mode": return parseChoice(text, choices ?? [], MODE_SYNONYMS);
    case "autonomy": return parseChoice(text, choices ?? [], { OWNER_APPROVAL: /approv|ask me/, VERIFIABLE_CONDITION: /condition|verif|prove|only when/, AUTOMATIC: /automatic|always|whenever/ });
    case "recovery": return parseChoice(text, choices ?? [{ value: "FAIL_CLOSED", label: "keep" }], { WAKE_RECOVERY_AGENT: /\brecover\w*|try again|within (my )?limits/, HALT_AND_NOTIFY: /\b(stop|halt|notify|tell me)\b/, FAIL_CLOSED: /\b(keep|yes|fine|ok)\b/ });
    case "disclosure": return parseChoice(text, choices ?? [], { DECISION_ONLY: /decision|act or not|whether to act/, BOOLEAN_RESULT: /yes\/no|boolean|true|false/, BUCKETED_RESULT: /range|bucket|rough/, REDACTED_RESULT: /redact/, FULL_RESULT: /\bfull\b|everything|all of it/, COMMITMENT_ONLY: /commit\w*|hash/ });
  }
}

