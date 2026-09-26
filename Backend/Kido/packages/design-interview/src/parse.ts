import type { ChainId } from "@kido/blueprint";
import type { AnswerType, Ctx, ObjectiveKind } from "./catalog.js";

export type Parsed = { ok: true; value: unknown } | { ok: false; reason: string };

const ok = (value: unknown): Parsed => ({ ok: true, value });
const bad = (reason: string): Parsed => ({ ok: false, reason });
const has = (s: string, re: RegExp) => re.test(s.toLowerCase());

export const DECIMALS: Record<string, number> = { USDC: 6, AMUSD: 6, AMSUI: 9 };

export function parseYesNo(s: string): Parsed {
  const t = s.trim().toLowerCase();
  if (/^(no|nope|never|not|don'?t|do not|n)\b/.test(t) || /\b(never|no way|must not|should not|shouldn'?t)\b/.test(t)) return ok(false);
  if (/^(yes|yeah|yep|sure|ok|okay|correct|right|y|allowed|please do|absolutely)\b/.test(t) || /\b(yes|allowed|that'?s right)\b/.test(t)) return ok(true);
  return bad("expected yes or no");
}

export function parseChains(s: string): Parsed {
  const t = s.toLowerCase();
  const eth = /\b(ethereum|eth|sepolia|evm)\b/.test(t);
  const sui = /\bsui\b/.test(t);
  if (/\bboth\b/.test(t) || (eth && sui)) return ok(["ethereum-sepolia", "sui-testnet"] satisfies ChainId[]);
  if (eth) return ok(["ethereum-sepolia"]);
  if (sui) return ok(["sui-testnet"]);
  return bad("expected Ethereum, Sui or both");
}

/** Human amount → token base units, using the asset chosen earlier. Rejects zero and negatives. */
export function parseAmount(s: string, ctx: Ctx): Parsed {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(k|thousand)?/i.exec(s.replace(/\$/g, ""));
  if (!m) return bad("expected an amount");
  let whole = m[1]!.replace(/,/g, "");
  if (m[2]) whole = String(Number(whole) * 1000);
  const symbol = (ctx["assets.spend"] as string | undefined) ?? "AMUSD";
  const dec = DECIMALS[symbol] ?? 6;
  const [i, f = ""] = whole.split(".");
  if (f.length > dec) return bad("too many decimals");
  const units = BigInt(i!) * 10n ** BigInt(dec) + BigInt((f + "0".repeat(dec)).slice(0, dec) || "0");
  if (units <= 0n) return bad("amount must be positive");
  return ok(units.toString());
}

export function parseChoice(s: string, choices: { value: string; label: string }[], synonyms: Record<string, RegExp> = {}): Parsed {
  const t = s.toLowerCase();
  for (const c of choices) if (t.includes(c.value.toLowerCase())) return ok(c.value);
  for (const [v, re] of Object.entries(synonyms)) if (re.test(t)) return ok(v);
  const letter = /^\s*\(?([a-e])\)?[\s.)]/i.exec(s + " ");
  if (letter) {
    const idx = letter[1]!.toLowerCase().charCodeAt(0) - 97;
    if (choices[idx]) return ok(choices[idx]!.value);
  }
  for (const c of choices) if (t.includes(c.label.toLowerCase())) return ok(c.value);
  return bad("did not match any option");
}

export const MODE_SYNONYMS: Record<string, RegExp> = {
  READ_ONLY: /\b(only )?(watch|monitor|alert|notify|read[- ]only)\b(?!.*\b(repay|swap|pay|act on its own)\b)/,
  PROPOSE_ONLY: /\b(suggest|propose|recommend)\b/,
  APPROVAL_REQUIRED: /\b(approve|approval|ask me|confirm (each|every))\b/,
  BOUNDED_AUTONOMOUS_FINANCE: /\b(on its own|autonomous|automatically|by itself|within (the )?limits)\b/,
};

export function parseActions(s: string): Parsed {
  const t = s.toLowerCase();
  const out: string[] = [];
  if (/\brepay|pay (down|back|off)\b/.test(t)) out.push("REPAY");
  if (/\b(supply|add collateral|deposit collateral)\b/.test(t)) out.push("SUPPLY");
  if (/\bswap|trade|exchange|rebalanc/.test(t)) out.push("SWAP");
  if (/\b(pay|payment|invoice)s?\b/.test(t) && !/\brepay\b/.test(t)) out.push("PAY");
  if (/\bbridge|move funds (across|between)\b/.test(t)) out.push("BRIDGE");
  if (/\bborrow\b/.test(t) && !/\b(never|no|not|don'?t)\s+(\w+\s)?borrow/.test(t)) out.push("BORROW");
  return out.length ? ok([...new Set(out)]) : bad("no recognizable action");
}

export function parseProtocols(s: string): Parsed {
  const t = s.toLowerCase();
  const out: string[] = [];
  if (/\baave\b/.test(t)) out.push("aave-v3");
  if (/\buniswap\b/.test(t)) out.push("uniswap-v3");
  if (/\bcetus\b/.test(t)) out.push("cetus-clmm");
  return out.length ? ok(out) : bad("no supported protocol named (Aave, Uniswap, Cetus)");
}

export function parseThreshold(s: string, kind?: ObjectiveKind): Parsed {
  const t = s.toLowerCase();
  const n = /(\d+(?:\.\d+)?)\s*(%|percent|bps)?/.exec(t);
  if (!n) return bad("expected a number");
  const metric = /health|hf\b/.test(t) || kind === "LENDING_PROTECTION" ? "HEALTH_FACTOR" : /drift|allocation|%|percent/.test(t) || kind === "REBALANCE" ? "ALLOCATION_DRIFT" : "VALUE";
  const op = /\b(above|over|exceeds|greater|more than|>)\b|>/.test(t) ? "GT" : metric === "ALLOCATION_DRIFT" ? "DRIFT_GT" : "LT";
  return ok({ metric, op, threshold: n[1] });
}

export function parsePayees(s: string): Parsed {
  const out: { label: string; chain: ChainId; address: string }[] = [];
  const re = /([A-Za-z][\w .-]{0,40}?)\s*[:=-]?\s*(0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40})\b/g;
  for (const m of s.matchAll(re)) {
    const addr = m[2]!;
    const label = m[1]!.trim().replace(/\s+(on|at)$/i, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    out.push({ label: label || `payee-${out.length + 1}`, chain: addr.length === 42 ? "ethereum-sepolia" : "sui-testnet", address: addr });
  }
  return out.length ? ok(out) : bad("expected name + address pairs");
}

export function parsePrivacyValues(s: string): Parsed {
  const t = s.toLowerCase();
  const m: [RegExp, string, string][] = [
    [/api key|credential|token secret|password/, "PRIVATE_API_CREDENTIAL", "api-credential"],
    [/threshold|limit|trigger level/, "PRIVATE_POLICY", "risk-threshold"],
    [/strategy|parameter/, "PRIVATE_STRATEGY", "strategy-parameters"],
    [/api (response|result|data)|external data|risk (api|score)/, "PRIVATE_API_RESPONSE", "api-response"],
    [/customer|personal|dataset|private data/, "PRIVATE_INPUT", "private-input"],
    [/model (input|context|prompt)|what the (ai|model) sees/, "PRIVATE_MODEL_CONTEXT", "model-context"],
    [/state|memory|stored/, "ENCRYPTED_STATE", "persistent-state"],
  ];
  const out = m.filter(([re]) => re.test(t)).map(([, kind, id]) => ({ id, kind, description: id.replace(/-/g, " ") }));
  return out.length ? ok(out) : bad("no recognizable sensitive item");
}

export function parseHiddenFrom(s: string): Parsed {
  const t = s.toLowerCase();
  const out = new Set<string>();
  if (/public|everyone|chain|world/.test(t)) out.add("PUBLIC_CHAIN");
  if (/other users|other customers/.test(t)) out.add("OTHER_USERS");
  if (/\b(ai|agent|model|llm)\b/.test(t)) out.add("AI_AGENT");
  if (/kido|backend|server|platform|operator/.test(t)) out.add("NORMAL_KIDO_BACKEND");
  if (/cloud|host|aws/.test(t)) out.add("CLOUD_HOST");
  if (/adapter|protocol/.test(t)) out.add("PROTOCOL_ADAPTER");
  if (/(everyone|all) except|only (the )?(enclave|tee)/.test(t)) out.add("EVERYONE_EXCEPT_APPROVED_ENCLAVE");
  return out.size ? ok([...out]) : bad("no recognizable audience");
}

export function parsePlaintext(s: string): Parsed {
  const t = s.toLowerCase();
  if (/enclave|tee|secure hardware|attested/.test(t)) return ok("APPROVED_ENCLAVE");
  if (/\bdon\b|chainlink/.test(t)) return ok("DON");
  if (/my (device|machine|laptop|computer)|only me|locally/.test(t)) return ok("USER_DEVICE");
  if (/kido|secret store|server|backend/.test(t)) return ok("KIDO_SECRET_STORE");
  if (/nowhere|never|nobody/.test(t)) return ok("NONE");
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

export function parseByType(type: AnswerType, text: string, ctx: Ctx, choices?: { value: string; label: string }[]): Parsed {
  switch (type) {
    case "yesno": return parseYesNo(text);
    case "chains": return parseChains(text);
    case "amount": return parseAmount(text, ctx);
    case "actions": return parseActions(text);
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
    case "asset": return parseChoice(text, choices ?? [], { USDC: /\busdc\b/i, AMUSD: /\bamusd\b/i, AMSUI: /\bamsui\b/i });
    case "authority_mode": return parseChoice(text, choices ?? [], MODE_SYNONYMS);
    case "autonomy": return parseChoice(text, choices ?? [], { OWNER_APPROVAL: /approv|ask me/, VERIFIABLE_CONDITION: /condition|verif|prove|only when/, AUTOMATIC: /automatic|always|whenever/ });
    case "recovery": return parseChoice(text, choices ?? [{ value: "FAIL_CLOSED", label: "keep" }], { WAKE_RECOVERY_AGENT: /recover|try again|within (my )?limits/, HALT_AND_NOTIFY: /stop|halt|notify|tell me/, FAIL_CLOSED: /keep|yes|fine|ok/ });
    case "disclosure": return parseChoice(text, choices ?? [], { DECISION_ONLY: /decision|act or not|whether to act/, BOOLEAN_RESULT: /yes\/no|boolean|true|false/, BUCKETED_RESULT: /range|bucket|rough/, REDACTED_RESULT: /redact/, FULL_RESULT: /full|everything|all of it/, COMMITMENT_ONLY: /commit|hash/ });
  }
}
