import type { Action, ChainId, RequirementClass, Topic } from "@kido/blueprint";

export type AnswerType =
  | "authority_mode" | "yesno" | "chains" | "protocols" | "actions" | "autonomy" | "asset" | "amount"
  | "payees" | "threshold" | "identity_name" | "privacy_values" | "hidden_from" | "plaintext" | "disclosure"
  | "recovery" | "objective_kind";

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
const assetSymbol = (c: Ctx) => (c["assets.spend"] as string | undefined) ?? "tokens";

/** Which assets each protocol's actions can spend on testnet (from the registry's asset graph). */
export const PROTOCOL_ASSETS: Record<string, string[]> = {
  "aave-v3": ["USDC"],
  "uniswap-v3": ["AMUSD"],
  "cetus-clmm": ["AMUSD", "AMSUI"],
  amane: ["AMUSD"],
};

/** Semantic actions each protocol capability can be asked to perform. */
export const PROTOCOL_ACTIONS: Record<string, Action[]> = {
  "aave-v3": ["REPAY", "SUPPLY"],
  "uniswap-v3": ["SWAP"],
  "cetus-clmm": ["SWAP"],
  amane: ["PAY"],
};

export const PROTOCOL_CHAINS: Record<string, ChainId> = {
  "aave-v3": "ethereum-sepolia",
  "uniswap-v3": "ethereum-sepolia",
  "cetus-clmm": "sui-testnet",
};

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
    question: () => ({ text: "May it move funds between Ethereum and Sui through a bridge, or should each chain only use the funds already there?" }),
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
        { value: "ethereum-sepolia", label: "Ethereum" },
        { value: "sui-testnet", label: "Sui" },
        { value: "both", label: "Both Ethereum and Sui" },
      ],
    }),
    infer: (c) => {
      const p = (c["protocols"] as string[] | undefined) ?? [];
      const cs = [...new Set(p.map((x) => PROTOCOL_CHAINS[x]).filter(Boolean))] as ChainId[];
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
    question: (c) => {
      const lending = kind(c) === "LENDING_PROTECTION";
      const onSui = chains(c).includes("sui-testnet"), onEth = chains(c).includes("ethereum-sepolia") || chains(c).length === 0;
      const choices: Choice[] = [];
      if (lending && onEth) choices.push({ value: "aave-v3", label: "Aave (Ethereum)" });
      if (!lending && onEth) choices.push({ value: "uniswap-v3", label: "Uniswap (Ethereum)" });
      if (onSui) choices.push({ value: "cetus-clmm", label: "Cetus (Sui)" });
      return { text: lending ? "Which lending protocol is your position on?" : "Which exchange should it use?", choices };
    },
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
      const options = new Set<Action>(protos.flatMap((p) => PROTOCOL_ACTIONS[p] ?? []));
      if (kind(c) === "PAYMENTS" || options.size === 0) options.add("PAY");
      const label: Record<string, string> = { REPAY: "Repay your debt", SUPPLY: "Add collateral", SWAP: "Swap tokens", PAY: "Pay approved recipients", BRIDGE: "Move funds across chains" };
      return { text: "Which actions may it take?", choices: [...options].map((a) => ({ value: a, label: label[a] ?? a })) };
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
      const opts = [...new Set(((c["protocols"] as string[] | undefined) ?? ["amane"]).flatMap((p) => PROTOCOL_ASSETS[p] ?? []))];
      return { text: "Which token may it spend?", choices: opts.map((o) => ({ value: o, label: o })) };
    },
    infer: (c) => {
      const protos = (c["protocols"] as string[] | undefined) ?? (acts(c).includes("PAY") ? ["amane"] : []);
      const opts = [...new Set(protos.flatMap((p) => PROTOCOL_ASSETS[p] ?? []))];
      return opts.length === 1 ? { value: opts[0], rule: "the only spendable asset for the selected protocol on testnet", from: ["protocols"] } : undefined;
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
    question: (c) => ({ text: `If this agent were compromised for one hour, what is the most ${assetSymbol(c)} you would be comfortable letting it use?` }),
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
      const w = c["limits.window"] as string | undefined;
      return w ? (BigInt(w) / 2n > 0n ? (BigInt(w) / 2n).toString() : w) : undefined;
    },
  },
  {
    key: "authority.lease_lifetime",
    topic: "LIMITS",
    class: "SAFE_DEFAULT",
    critical: false,
    bucket: 9,
    answerType: "amount",
    appliesWhen: bounded,
    question: () => ({ text: "Its authority will expire after one hour and be renewed within your limits. Keep that?" }),
    safeDefault: () => 3600,
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
