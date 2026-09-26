import type { Action, ChainId, RequirementClass, Topic } from "@kido/blueprint";
import { interviewChains, interviewRegistry } from "./registry.js";
import { KIDO_DEFAULTS } from "./defaults.js";

const humanDuration = (secs: number) => (secs % 3600 === 0 ? (secs === 3600 ? "one hour" : `${secs / 3600} hours`) : secs % 60 === 0 ? `${secs / 60} minutes` : `${secs} seconds`);

export type AnswerType =
  | "authority_mode" | "yesno" | "chains" | "protocols" | "actions" | "autonomy" | "asset" | "amount"
  | "payees" | "threshold" | "identity_name" | "privacy_values" | "hidden_from" | "plaintext" | "disclosure"
  | "recovery" | "objective_kind" | "swap_floor" | "duration";

export type ObjectiveKind = "LENDING_PROTECTION" | "REBALANCE" | "PAYMENTS" | "LIQUIDITY" | "TREASURY" | "MONITORING" | "RESEARCH" | "OTHER";

/** Resolved values keyed by requirement key; the interview's view of the world. */
export type Ctx = Record<string, unknown>;

export interface Choice {
  value: string;
  label: string;
}

export interface RequirementDef {
  key: string;
  topic: Topic;
  class: RequirementClass;
  critical: boolean;
  /** Bible §9.5: 1 safety-critical authority … 10 cosmetic. */
  bucket: number;
  answerType: AnswerType;
  appliesWhen: (ctx: Ctx) => boolean;
  question: (ctx: Ctx) => { text: string; choices?: Choice[] };
  /** SAFE_DEFAULT only: the visible, revocable default. */
  safeDefault?: (ctx: Ctx) => unknown;
  /** INFERABLE only (or USER_REQUIRED with an unambiguous inference): value + rule, or undefined. */
  infer?: (ctx: Ctx) => { value: unknown; rule: string; from: string[] } | undefined;
  /** A resolved value that cannot be honoured by the platform makes the requirement UNSATISFIABLE. */
  unsatisfiable?: (value: unknown) => string | undefined;
}

const mode = (c: Ctx) => c["authority.mode"] as string | undefined;
const financial = (c: Ctx) => mode(c) === "BOUNDED_AUTONOMOUS_FINANCE" || mode(c) === "APPROVAL_REQUIRED";
const bounded = (c: Ctx) => mode(c) === "BOUNDED_AUTONOMOUS_FINANCE";
const acts = (c: Ctx) => (c["actions.allowed"] as Action[] | undefined) ?? [];
const chains = (c: Ctx) => (c["chains"] as ChainId[] | undefined) ?? [];
const kind = (c: Ctx) => c["objective.kind"] as ObjectiveKind | undefined;
const privateValues = (c: Ctx) => ((c["privacy.values"] as unknown[] | undefined) ?? []).length > 0;
const watches = (c: Ctx) => ["LENDING_PROTECTION", "REBALANCE", "MONITORING", "LIQUIDITY"].includes(kind(c) ?? "");
const spendList = (c: Ctx): string[] => (Array.isArray(c["assets.spend"]) ? (c["assets.spend"] as string[]) : typeof c["assets.spend"] === "string" ? [c["assets.spend"] as string] : []);
const assetSymbol = (c: Ctx) => (spendList(c).length > 1 ? `of each of ${spendList(c).join(" and ")}` : (spendList(c)[0] ?? "tokens"));

const reg = () => interviewRegistry();
/** Protocols (execution providers other than the authority layer) that serve this kind of objective. */
const protocolChoices = (c: Ctx): Choice[] => {
  const lending = kind(c) === "LENDING_PROTECTION";
  const cs = chains(c).length ? chains(c) : interviewChains().map((x) => x.chainId);
  return reg().providers
    .filter((p) => p.kind === "protocol" && (p.execution ?? []).length > 0 && p.chains.some((ch) => cs.includes(ch)))
    .filter((p) => (lending ? p.capabilities.some((x) => x.startsWith("LENDING_")) : p.capabilities.some((x) => x.startsWith("DEX_"))))
    .map((p) => ({ value: p.providerId, label: `${p.displayName} (${p.chains.map((ch) => interviewChains().find((x) => x.chainId === ch)?.label ?? ch).join(", ")})` }));
};
/** Providers that perform payments for the selected chains. */
const payProviders = (c: Ctx) => [...new Set(chains(c).flatMap((ch) => reg().executors("PAY", ch).map((p) => p.providerId)))];
const spendable = (c: Ctx, protos: string[]) => [...new Set(protos.flatMap((p) => reg().assetsFor(p).filter((a) => !chains(c).length || chains(c).includes(a.chain)).map((a) => a.symbol)))];
export const ACTION_LABEL: Record<string, string> = { REPAY: "Repay your debt", SUPPLY: "Add collateral", SWAP: "Swap tokens", PAY: "Pay approved recipients", BRIDGE: "Move funds across chains" };

export const CATALOG: RequirementDef[] = [
  {
    key: "objective.kind",
    topic: "OBJECTIVE",
    class: "INFERABLE",
    critical: false,
    bucket: 10,
    answerType: "objective_kind",
    appliesWhen: () => true,
    question: () => ({ text: "In one sentence, what should this agent achieve?" }),
    infer: () => undefined,
  },
  {
    key: "authority.mode",
    topic: "AUTHORITY",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 1,
    answerType: "authority_mode",
    appliesWhen: () => true,
    question: () => ({
      text: "What should this agent be allowed to do?",
      choices: [
        { value: "READ_ONLY", label: "Only watch and alert me" },
        { value: "PROPOSE_ONLY", label: "Suggest actions for me to carry out myself" },
        { value: "APPROVAL_REQUIRED", label: "Take actions, but only after I approve each one" },
        { value: "BOUNDED_AUTONOMOUS_FINANCE", label: "Act on its own, within limits I set" },
      ],
    }),
  },
  {
    key: "authority.withdraw",
    topic: "AUTHORITY",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 1,
    answerType: "yesno",
    appliesWhen: financial,
    question: () => ({ text: "Should the agent ever be allowed to withdraw collateral or move funds out of your position to itself?" }),
    unsatisfiable: (v) => (v === true ? "agents never receive withdrawal authority; only you can withdraw, to a destination pinned in advance" : undefined),
  },
  {
    key: "authority.arbitrary_recipients",
    topic: "AUTHORITY",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 1,
    answerType: "yesno",
    appliesWhen: (c) => financial(c) && acts(c).includes("PAY"),
    question: () => ({ text: "Should it be able to pay anyone it chooses, or only recipients you approve in advance? (answer yes for anyone)" }),
    unsatisfiable: (v) => (v === true ? "payments to arbitrary recipients are never authorized; approve recipients in advance instead" : undefined),
  },
  {
    key: "authority.bridge",
    topic: "AUTHORITY",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 1,
    answerType: "yesno",
    appliesWhen: (c) => financial(c) && chains(c).length > 1,
    question: (c) => ({ text: `May it move funds between ${chains(c).map((ch) => interviewChains().find((x) => x.chainId === ch)?.label ?? ch).join(" and ")} through a bridge, or should each chain only use the funds already there?` }),
  },
  {
    key: "chains",
    topic: "CHAIN",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 2,
    answerType: "chains",
    appliesWhen: () => true,
    question: () => ({
      text: "Which blockchain should it operate on?",
      choices: [
        ...interviewChains().map((x) => ({ value: x.chainId, label: x.label })),
        ...(interviewChains().length > 1 ? [{ value: "both", label: `All of ${interviewChains().map((x) => x.label).join(" and ")}` }] : []),
      ],
    }),
    infer: (c) => {
      const p = (c["protocols"] as string[] | undefined) ?? [];
      const cs = [...new Set(p.flatMap((x) => reg().chainsFor(x)))];
      return cs.length > 0 ? { value: cs, rule: "protocol exists only on these chains", from: ["protocols"] } : undefined;
    },
  },
  {
    key: "protocols",
    topic: "ACTIONS",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 3,
    answerType: "protocols",
    appliesWhen: (c) => ["LENDING_PROTECTION", "REBALANCE", "LIQUIDITY"].includes(kind(c) ?? "") || acts(c).some((a) => a === "SWAP" || a === "REPAY"),
    question: (c) => ({ text: kind(c) === "LENDING_PROTECTION" ? "Which lending protocol is your position on?" : "Which exchange should it use?", choices: protocolChoices(c) }),
  },
  {
    key: "actions.allowed",
    topic: "ACTIONS",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 3,
    answerType: "actions",
    appliesWhen: (c) => mode(c) !== undefined && mode(c) !== "READ_ONLY" && mode(c) !== "NONE",
    unsatisfiable: (v) => ((v as string[]).some((a) => a === "BORROW" || a === "WITHDRAW") ? "agents are never granted borrowing or withdrawal; remove those actions" : undefined),
    question: (c) => {
      const protos = (c["protocols"] as string[] | undefined) ?? [];
      const options = new Set<string>(protos.flatMap((p) => reg().actionsOf(p)));
      if ((kind(c) === "PAYMENTS" || options.size === 0) && payProviders(c).length) options.add("PAY");
      return { text: "Which actions may it take?", choices: [...options].map((a) => ({ value: a, label: ACTION_LABEL[a] ?? a })) };
    },
  },
  {
    key: "authority.autonomy",
    topic: "AUTHORITY",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 3,
    answerType: "autonomy",
    appliesWhen: bounded,
    question: () => ({
      text: "Should it act automatically, only when a verifiable condition occurs, or only after you approve it?",
      choices: [
        { value: "AUTOMATIC", label: "Automatically, whenever its plan calls for it" },
        { value: "VERIFIABLE_CONDITION", label: "Only when a condition it can prove on-chain occurs" },
        { value: "OWNER_APPROVAL", label: "Only after I approve" },
      ],
    }),
  },
  {
    key: "payees",
    topic: "AUTHORITY",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 3,
    answerType: "payees",
    appliesWhen: (c) => financial(c) && acts(c).includes("PAY"),
    question: () => ({ text: "Who may it pay? Give each recipient a name and its address on each chain." }),
  },
  {
    key: "beneficiary",
    topic: "AUTHORITY",
    class: "SAFE_DEFAULT",
    critical: true,
    bucket: 3,
    answerType: "yesno",
    appliesWhen: (c) => financial(c) && acts(c).includes("REPAY"),
    question: () => ({ text: "It will only ever repay your own position's debt. Is that right?" }),
    safeDefault: () => "SELF",
  },
  {
    key: "assets.spend",
    topic: "LIMITS",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 4,
    answerType: "asset",
    appliesWhen: financial,
    question: (c) => {
      const opts = spendable(c, (c["protocols"] as string[] | undefined) ?? payProviders(c));
      return { text: chains(c).length > 1 ? "Which tokens may it spend? (it can be one per chain)" : "Which token may it spend?", choices: opts.map((o) => ({ value: o, label: o })) };
    },
    infer: (c) => {
      // Per chain: when the providers used there accept exactly one asset, that asset is the only choice.
      const protos = (c["protocols"] as string[] | undefined) ?? (acts(c).includes("PAY") ? payProviders(c) : []);
      if (!chains(c).length || !protos.length) return undefined;
      const perChain = chains(c).map((ch) => [...new Set(protos.flatMap((p) => reg().assetsFor(p, ch).map((a) => a.symbol)))]);
      if (perChain.some((x) => x.length !== 1)) return undefined;
      const set = [...new Set(perChain.flat())];
      return { value: set.length === 1 ? set[0] : set, rule: "the only spendable asset for the selected protocols on each chain", from: ["protocols", "chains"] };
    },
  },
  {
    key: "limits.window",
    topic: "LIMITS",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 4,
    answerType: "amount",
    appliesWhen: bounded,
    question: (c) => ({ text: `If this agent were compromised for ${humanDuration(KIDO_DEFAULTS.limitWindowSeconds)}, what is the most ${assetSymbol(c)} you would be comfortable letting it use?` }),
  },
  {
    key: "limits.total",
    topic: "LIMITS",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 4,
    answerType: "amount",
    appliesWhen: bounded,
    question: (c) => ({ text: `What is the most ${assetSymbol(c)} it may use in total before you have to approve it again?` }),
  },
  {
    key: "limits.per_action",
    topic: "LIMITS",
    class: "SAFE_DEFAULT",
    critical: false,
    bucket: 4,
    answerType: "amount",
    appliesWhen: bounded,
    question: (c) => ({ text: `The largest single action will be half of the hourly limit. Is a smaller per-action cap needed for ${assetSymbol(c)}?` }),
    safeDefault: (c) => {
      const w = c["limits.window"] as string | Record<string, string> | undefined;
      const half = (x: string) => (BigInt(x) / 2n > 0n ? (BigInt(x) / 2n).toString() : x);
      if (w === undefined) return undefined;
      return typeof w === "string" ? half(w) : Object.fromEntries(Object.entries(w).map(([k, v]) => [k, half(v)]));
    },
  },
  {
    key: "limits.swap_floor",
    topic: "LIMITS",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 4,
    answerType: "swap_floor",
    appliesWhen: (c) => bounded(c) && acts(c).includes("SWAP"),
    question: (c) => {
      const spend = spendList(c)[0];
      const other = spendable(c, (c["protocols"] as string[] | undefined) ?? []).find((s) => s !== spend);
      const eg = spend && other ? ` For example: at least 0.95 ${other} for each ${spend}.` : " For example: at least 0.95 of the token you receive for each token you sell.";
      return { text: `What is the worst exchange rate you would accept for a swap?${eg}` };
    },
  },
  {
    key: "authority.lease_lifetime",
    topic: "LIMITS",
    class: "SAFE_DEFAULT",
    critical: false,
    bucket: 9,
    answerType: "duration",
    appliesWhen: bounded,
    question: () => ({ text: `Its authority will expire after ${humanDuration(KIDO_DEFAULTS.leaseLifetimeSeconds)} and be renewed within your limits. Keep that?` }),
    safeDefault: () => KIDO_DEFAULTS.leaseLifetimeSeconds,
  },
  {
    key: "monitor.condition",
    topic: "DATA",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 7,
    answerType: "threshold",
    appliesWhen: watches,
    question: (c) => ({
      text: kind(c) === "LENDING_PROTECTION" ? "At what health factor should it act?" : kind(c) === "REBALANCE" ? "How far may your allocation drift before it acts (in percent)?" : "What condition should it watch for?",
    }),
  },
  {
    key: "data.oracle_failure",
    topic: "DATA",
    class: "SAFE_DEFAULT",
    critical: false,
    bucket: 7,
    answerType: "recovery",
    appliesWhen: watches,
    question: () => ({ text: "If its price or position data becomes unavailable or stale, it will do nothing and alert you. Keep that?" }),
    safeDefault: () => "FAIL_CLOSED",
  },
  {
    key: "identity.public",
    topic: "IDENTITY",
    class: "USER_REQUIRED",
    critical: false,
    bucket: 5,
    answerType: "yesno",
    appliesWhen: () => true,
    question: () => ({ text: "Should this agent have a public identity others can look up, such as an ENS or SuiNS name?" }),
    safeDefault: () => false,
  },
  {
    key: "identity.name",
    topic: "IDENTITY",
    class: "USER_REQUIRED",
    critical: false,
    bucket: 5,
    answerType: "identity_name",
    appliesWhen: (c) => c["identity.public"] === true,
    question: () => ({ text: "What name should it be discoverable under? (for example your organization and the agent's role)" }),
  },
  {
    key: "privacy.required",
    topic: "PRIVACY",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 6,
    answerType: "yesno",
    appliesWhen: () => true,
    question: () => ({ text: "Does this agent use anything you do not want exposed publicly?" }),
  },
  {
    key: "privacy.values",
    topic: "PRIVACY",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 6,
    answerType: "privacy_values",
    appliesWhen: (c) => c["privacy.required"] === true,
    question: () => ({
      text: "What is sensitive?",
      choices: [
        { value: "PRIVATE_API_CREDENTIAL", label: "An API key or credential" },
        { value: "PRIVATE_POLICY", label: "A risk threshold or limit" },
        { value: "PRIVATE_STRATEGY", label: "A strategy parameter" },
        { value: "PRIVATE_API_RESPONSE", label: "Data an external API returns" },
        { value: "PRIVATE_INPUT", label: "Customer information or a private dataset" },
        { value: "PRIVATE_MODEL_CONTEXT", label: "What the AI model sees" },
        { value: "ENCRYPTED_STATE", label: "The agent's stored state" },
      ],
    }),
  },
  {
    key: "privacy.hidden_from",
    topic: "PRIVACY",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 6,
    answerType: "hidden_from",
    appliesWhen: privateValues,
    question: () => ({ text: "Who must it be hidden from? (the public, other users, the AI agent itself, Kido's own servers, the cloud host…)" }),
  },
  {
    key: "privacy.plaintext",
    topic: "PRIVACY",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 6,
    answerType: "plaintext",
    appliesWhen: privateValues,
    question: () => ({ text: "Where may it exist in readable form? (only your device, Kido's secret store, a verified secure enclave, or nowhere)" }),
  },
  {
    key: "privacy.disclosure",
    topic: "PRIVACY",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 6,
    answerType: "disclosure",
    appliesWhen: privateValues,
    question: () => ({
      text: "What is allowed to leave the private computation?",
      choices: [
        { value: "DECISION_ONLY", label: "Only the decision (act / don't act)" },
        { value: "BOOLEAN_RESULT", label: "A yes/no result" },
        { value: "BUCKETED_RESULT", label: "A rough range" },
        { value: "REDACTED_RESULT", label: "A redacted result" },
        { value: "FULL_RESULT", label: "The full result" },
      ],
    }),
  },
  {
    key: "recovery.partial",
    topic: "RECOVERY",
    class: "USER_REQUIRED",
    critical: true,
    bucket: 8,
    answerType: "recovery",
    appliesWhen: bounded,
    question: () => ({
      text: "If a multi-step action fails halfway, should it try to recover using only the actions you already allowed, or stop and notify you?",
      choices: [
        { value: "WAKE_RECOVERY_AGENT", label: "Recover within my limits" },
        { value: "HALT_AND_NOTIFY", label: "Stop and notify me" },
      ],
    }),
  },
];

export const byKey = (k: string) => CATALOG.find((d) => d.key === k);
